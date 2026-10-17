import fs from 'node:fs';
import path from 'node:path';
import {libraryCommand} from '../library/client.ts';
import {atomicJSON} from './state.ts';

// Project-owned outbox. Only the library service touches the library catalog.
export class LibraryLink {
  state:any; pendingFile:string;
  constructor(state:any){this.state=state;this.pendingFile=path.join(state.dir,'.reelet','library-outbox.json');}
  write(extra:any={}){const p=this.state.p;const payload={command:'sync-project',projectId:p.id,projectPath:this.state.dir,assetIds:p.media.map((m:any)=>m.metadata?.library?.assetId).filter(Boolean),...extra};atomicJSON(this.pendingFile,payload);return payload;}
  async sync(){const payload=this.write();try{await libraryCommand(payload);if(JSON.stringify(JSON.parse(fs.readFileSync(this.pendingFile,'utf8')))===JSON.stringify(payload))fs.rmSync(this.pendingFile,{force:true});}catch(e:any){return {pending:true,message:e.message};}return {pending:false};}
  async register(media:any){if(!['video','audio'].includes(media.kind))return media;
    this.write();
    const result=await libraryCommand({command:'register',path:media.path,projectId:this.state.p.id,projectPath:this.state.dir});const a=result.items[0];
    return {...media,metadata:{...media.metadata,library:{libraryId:a.libraryId,assetId:a.id,sourceId:a.sourceId,sourceLocations:a.source.locations}}};
  }
  async recover(){
    await this.sync();
  }
  async migrate(){
    this.state.requireUnlocked();const next=structuredClone(this.state.p);let added=0;
    try{for(const m of next.media){if(!['video','audio'].includes(m.kind)||m.metadata.library)continue;const linked=await this.register({...m,path:path.resolve(this.state.dir,m.path)});m.metadata=linked.metadata;m.revision++;added++;}
      if(added){next.revision++;this.state.save(next,false);}return {registered:added};
    }finally{await this.sync();}
  }
}
