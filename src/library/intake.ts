import fs from 'node:fs';
import path from 'node:path';
import {uid,now} from './store.ts';
import {supported} from './operations.ts';
import {assert} from '../shared/project.ts';

// Directory enumeration yields to catalog queries. A missing drive changes
// availability, never the annotations or membership of its existing assets.
export class Intake {
  db:any; ops:any; jobs:any;
  constructor(db:any,ops:any,jobs:any){Object.assign(this,{db,ops,jobs});}
  folder(parent:string,name:string){
    const existing=this.db.all('folder').find((f:any)=>f.parent===parent&&f.name===name);
    return existing?.id||this.db.put('folder',{id:uid('folder'),parent,name}).id;
  }
  configure(c:any){
    const old=c.id?this.db.get(c.id,'source-folder'):null;if(old)this.db.check(old,c.revision);
    const source=path.resolve(c.path||old?.path||'');assert(c.path||old?.path,'Source path required');
    for(const key of ['watched','hierarchy'])assert(c[key]===undefined||typeof c[key]==='boolean',`${key} must be a boolean`);
    if(fs.existsSync(source))assert(fs.statSync(source).isDirectory(),'Source mapping requires a directory');
    this.ops.folder(c.folder||old?.folder||'root');
    const same=this.db.all('source-folder').find((s:any)=>s.id!==old?.id&&s.path.toLowerCase()===source.toLowerCase());assert(!same,'This source folder is already configured');
    return this.db.put('source-folder',{...old,id:old?.id||uid('sourcefolder'),path:source,folder:c.folder||old?.folder||'root',watched:c.watched??old?.watched??false,hierarchy:c.hierarchy??old?.hierarchy??false});
  }
  queue(c:any){
    const roots=c.id?[this.db.get(c.id,'source-folder')]:c.paths||c.path?(c.paths||[c.path]).map((p:string)=>({path:path.resolve(p),folder:c.folder||'root',hierarchy:!!c.hierarchy,seedRoot:!!c.hierarchy})):this.db.all('source-folder');
    return {jobs:[this.jobs.enqueueTask('scan',{roots,limit:c.limit,author:c.author||'agent',availability:c.command==='rescan'})],identityVerification:'background'};
  }
  async scan(j:any){
    let visited=0,imported=0,reused=0,unavailable=0,limited=false;const errors:any[]=[];
    const limit=j.options.limit===undefined?Infinity:Number(j.options.limit);assert(limit>0,'Scan limit must be positive');
    const inspect=async(file:string,home:string)=>{
      if(j.status==='cancelled')throw new Error('Scan cancelled');
      if(visited>=limit){limited=true;return;}
      visited++;
      try{
        const a=this.db.transaction('Discover media',j.options.author,()=>this.ops.register(file,home));
        if(this.ops.source(a).status==='pending'){this.jobs.enqueue('verify',a.id);imported++;}else reused++;
      }catch(e:any){if(errors.length<50)errors.push({path:file,message:e.message});}
      if(visited%25===0){this.jobs.update(j,`Scanned ${visited} files`,0);await new Promise(r=>setTimeout(r,0));}
    };
    const walk=async(file:string,home:string,hierarchy:boolean)=>{
      if(j.status==='cancelled')throw new Error('Scan cancelled');
      const stat=await fs.promises.stat(file);
      if(!stat.isDirectory()){if(supported.test(file))await inspect(file,home);return;}
      const directory=await fs.promises.opendir(file);
      for await(const entry of directory){
        if(visited>=limit){limited=true;break;}if(entry.isSymbolicLink())continue;
        const child=path.join(file,entry.name);
        if(entry.isDirectory()){
          const folder=hierarchy?this.db.transaction('Import folder',j.options.author,()=>this.folder(home,entry.name)):home;
          await walk(child,folder,hierarchy);
        }else if(entry.isFile()&&supported.test(child))await inspect(child,home);
      }
    };
    for(const root of j.options.roots){
      try{
        let home=root.folder;
        if(root.seedRoot&&(await fs.promises.stat(root.path)).isDirectory())home=this.db.transaction('Import folder',j.options.author,()=>this.folder(home,path.basename(root.path)));
        await walk(root.path,home,root.hierarchy);
      }catch(e:any){if(j.status==='cancelled')throw e;unavailable++;errors.push({path:root.path,message:e.message});}
    }
    if(j.options.availability){
      const query=this.db.db.prepare("SELECT id FROM records WHERE kind='source' ORDER BY id LIMIT 100 OFFSET ?");let offset=0;
      for(;;){const rows=query.all(offset);if(!rows.length)break;
        for(const row of rows){if(j.status==='cancelled')throw new Error('Scan cancelled');const s=this.db.get(row.id),availability=this.ops.location(s)?'available':'unavailable';if(s.availability!==availability)this.db.transaction('Source availability','agent',()=>this.db.put('source',{...s,availability}),false);}
        offset+=rows.length;await new Promise(r=>setTimeout(r,0));
      }
    }
    j.result={visited,imported,reused,unavailable,complete:!limited,errors,finishedAt:now()};
    if(errors.length)throw new Error(`Scan preserved existing data; ${errors.length} paths could not be read. See job.result.errors.`);
  }
  watch(){
    for(const root of this.db.all('source-folder').filter((s:any)=>s.watched)){
      const active=this.db.db.prepare("SELECT 1 FROM jobs WHERE json_extract(data,'$.kind')='scan' AND json_extract(data,'$.status') IN ('queued','running') AND data LIKE ?").get('%'+root.id+'%');
      if(!active)this.queue({command:'rescan',id:root.id});
    }
  }
}
