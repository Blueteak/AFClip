import fs from 'node:fs';
import path from 'node:path';
import {libraryCommand} from '../library/client.ts';
import {atomicJSON} from './state.ts';

// Project-owned outbox. Only the library service touches the library catalog.
export class LibraryLink {
  state:any; pendingFile:string; inFlight:Promise<any>|null=null; suspended=false;
  desired:string|null=null; lastError:string|null=null; lastSyncedAt:string|null=null;
  constructor(state:any){this.state=state;this.pendingFile=path.join(state.dir,'.afclip','library-outbox.json');}
  write(extra:any={},force=false){const p=this.state.p;const payload={command:'sync-project',projectId:p.id,projectPath:this.state.dir,assetIds:[...new Set(p.media.map((m:any)=>m.metadata?.library?.assetId).filter(Boolean))].sort(),...extra};
    const json=JSON.stringify(payload);if(force||json!==this.desired||!fs.existsSync(this.pendingFile)&&this.lastError){atomicJSON(this.pendingFile,payload);this.desired=json;}return payload;}
  status(){return {pending:fs.existsSync(this.pendingFile),syncing:!!this.inFlight,error:this.lastError,lastSyncedAt:this.lastSyncedAt};}
  // Persist intent before returning to the caller. Network work never holds up
  // an ordinary project edit; a later edit can replace the pending snapshot.
  sync(){this.write();this.suspended=false;void this.flush();return this.status();}
  flush():Promise<any>{
    if(this.inFlight)return this.inFlight;
    if(this.suspended||!fs.existsSync(this.pendingFile))return Promise.resolve(this.status());
    this.inFlight=(async()=>{
      try{while(!this.suspended&&fs.existsSync(this.pendingFile)){
        const raw=fs.readFileSync(this.pendingFile,'utf8'),payload=JSON.parse(raw);
        await libraryCommand(payload);this.lastError=null;this.lastSyncedAt=new Date().toISOString();
        if(fs.existsSync(this.pendingFile)&&fs.readFileSync(this.pendingFile,'utf8')===raw)fs.rmSync(this.pendingFile,{force:true});
      }}catch(e:any){this.lastError=e.message;}
      finally{this.inFlight=null;}
      return this.status();
    })();return this.inFlight;
  }
  async register(media:any){if(!['video','audio'].includes(media.kind))return media;
    // Do not let an older reference snapshot withdraw this tentative intake
    // between registration and project insertion. The caller finishes with sync.
    this.suspended=true;if(this.inFlight)await this.inFlight;
    this.write({},true);
    const result=await libraryCommand({command:'register',path:media.path,projectId:this.state.p.id,projectPath:this.state.dir});const a=result.items[0];
    return {...media,metadata:{...media.metadata,library:{libraryId:a.libraryId,assetId:a.id,sourceId:a.sourceId,sourceLocations:a.source.locations}}};
  }
  async recover(){
    await this.sync();
  }
  async migrate(){
    this.state.requireUnlocked();const next=structuredClone(this.state.p);let added=0,relocated=0,updated=0;
    const skipped:any[]=[];
    try{for(const m of next.media){
      if(!['video','audio'].includes(m.kind))continue;
      const link=m.metadata.library;
      if(!link){const linked=await this.register({...m,path:path.resolve(this.state.dir,m.path)});m.metadata=linked.metadata;m.revision++;added++;continue;}
      // The catalog owns location recovery. Never adopt a different source version,
      // even when its logical asset ID is unchanged after accepting a replacement.
      let asset:any;
      try{asset=await libraryCommand({command:'inspect',id:link.assetId,sourceId:link.sourceId,relationships:false});}
      catch(e:any){skipped.push({mediaId:m.id,reason:e.message});continue;}
      if(asset.libraryId!==link.libraryId||!asset.sourceMatches||asset.deleted||asset.purged||
        asset.availability!=='available'||asset.source?.status!=='verified'||!asset.source?.hash){
        skipped.push({mediaId:m.id,reason:'No verified available location for the saved source version'});continue;
      }
      const locations=[...new Set([...(link.sourceLocations||[]),...asset.source.locations])];
      // Keep portable project copies in place while their file still exists.
      const current=path.resolve(this.state.dir,m.path);
      const knownTime=asset.source.locationTimes?.[current]??asset.source.mtimeMs;
      let usable=false;
      try{const stat=fs.statSync(current);usable=stat.isFile()&&stat.size===asset.source.size&&
        (!asset.source.locations.includes(current)||stat.mtimeMs===knownTime);}catch{}
      const moved=!usable&&current!==path.resolve(asset.path);
      if(moved){m.path=asset.path;relocated++;}
      if(moved||JSON.stringify(locations)!==JSON.stringify(link.sourceLocations)){
        m.metadata.library={...link,sourceLocations:locations};m.revision++;updated++;
      }
    }
      if(added||updated){next.revision++;this.state.save(next,false);}return {registered:added,relocated,updated,skipped};
    }finally{await this.sync();}
  }
}
