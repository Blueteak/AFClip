import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {Catalog,uid,now} from './store.ts';
import {Operations} from './operations.ts';
import {inspectMedia} from '../engine/probe.ts';
import {assert,seconds,parseTime} from '../shared/project.ts';
const require=createRequire(import.meta.url),ffmpeg=require('ffmpeg-static'),ffprobe=require('ffprobe-static').path;
const prepareSeekCache=require('../render/seek-cache.cjs');
const {getFrameIndex,decodeFrameTimestamps}=require('../render/frame-index.cjs');

export class Jobs {
  active:any=null; child:any=null; readers=new Map<string,number>();
  db:Catalog; ops:Operations; changed:()=>void;
  constructor(db:Catalog, ops:Operations, changed:()=>void) {
    Object.assign(this,{db,ops,changed});
    fs.mkdirSync(path.join(db.dir,'cache'),{recursive:true});
    for(const j of db.jobs())if(j.status==='running'){j.status='queued';db.job(j);}
    setTimeout(()=>this.pump(),100);
  }
  enqueue(kind:string,assetId:string) {
    const a=this.ops.asset(assetId);
    const pending=this.db.jobs().find(j=>j.kind===kind&&j.sourceId===a.sourceId&&['queued','running'].includes(j.status));if(pending)return pending;
    const j=this.db.job({id:uid('job'),kind,assetId:a.id,sourceId:a.sourceId,status:'queued',progress:0,createdAt:now()});this.changed();setTimeout(()=>this.pump(),0);return j;
  }
  cancel(id:string) {const j=this.db.jobs().find(j=>j.id===id);assert(j,'Unknown job');if(['queued','running'].includes(j.status)){j.status='cancelled';this.db.job(j);if(this.active?.id===id){this.active.status='cancelled';this.child?.kill();}}this.changed();return j;}
  update(j:any,phase:string,progress:number) {Object.assign(j,{phase,progress});this.db.job(j);this.changed();}
  run(j:any,program:string,args:string[],capture=true):Promise<Buffer> {
    assert(j.status!=='cancelled','Job cancelled');
    return new Promise((resolve,reject)=>{const child=spawn(program,args,{windowsHide:true,stdio:['ignore',capture?'pipe':'ignore','pipe']});this.child=child;const chunks:Buffer[]=[];let size=0,err='';child.stdout?.on('data',b=>{chunks.push(b);size+=b.length;if(size>128*1024**2)child.kill();});child.stderr.on('data',b=>err=(err+b).slice(-4000));child.on('error',reject);child.on('close',code=>{this.child=null;if(j.status==='cancelled')reject(Object.assign(new Error('Job cancelled'),{code:'CANCELLED'}));else if(code)reject(new Error(err||`Media process exited ${code}`));else resolve(Buffer.concat(chunks));});});
  }
  async pump() {
    if(this.active)return;
    const j=this.db.jobs().reverse().find(j=>j.status==='queued');if(!j)return;
    this.active=j;j.status='running';this.update(j,'Starting',0);
    try {
      if(j.kind==='verify')await this.verify(j);else await this.prepare(j);
      if(j.status!=='cancelled'){j.status='completed';j.progress=1;j.phase='Ready';}
    }catch(e:any){if(j.status!=='cancelled'){j.status='failed';j.error=e.message;}}
    finally {j.finishedAt=now();this.db.job(j);this.active=null;this.changed();setTimeout(()=>this.pump(),0);}
  }
  async verify(j:any) {
    let s=this.db.get(j.sourceId,'source');const file=this.ops.location(s);assert(file,'Source unavailable or changed');
    this.update(j,'Reading source metadata',.05);const media=await inspectMedia(file);assert(['audio','video'].includes(media.kind),'Only audio/video supported');
    this.update(j,'Verifying content identity',.15);const hash=createHash('sha256');let count=0,last=0;
    for await(const bytes of fs.createReadStream(file)){assert(j.status!=='cancelled','Job cancelled');hash.update(bytes);count+=bytes.length;if(Date.now()-last>350){this.update(j,'Verifying content identity',.15+.75*count/s.size);last=Date.now();}}
    assert(this.ops.location(s)===file,'Source changed during verification');const digest=hash.digest('hex');
    this.db.transaction('Verify source','agent',()=>{
      s=this.db.get(s.id);const duplicate=this.db.all('source').find(x=>x.id!==s.id&&x.hash===digest);
      this.db.put('source',{...s,status:'verified',hash:digest,duration:media.duration,metadata:media.metadata});
      let a=this.ops.asset(j.assetId);this.db.put('asset',{...a,kind:media.kind,duration:seconds(media.duration)});
      const target=duplicate&&this.db.all('asset').find(x=>x.sourceId===duplicate.id&&!x.purged);
      if(target&&target.id!==a.id){
        this.db.put('source',{...duplicate,locations:[...new Set([...duplicate.locations,...s.locations])],locationTimes:{...Object.fromEntries(duplicate.locations.map((p:string)=>[p,duplicate.mtimeMs])),...duplicate.locationTimes,...Object.fromEntries(s.locations.map((p:string)=>[p,s.mtimeMs]))}});
        // Aliases keep provisional project IDs resolvable. Merge context without overwriting it.
        this.db.put('asset',{...target,deleted:false,folder:target.folder==='inbox'?a.folder:target.folder,tags:[...new Set([...target.tags,...a.tags])],notes:[target.notes,a.notes].filter(Boolean).filter((x,i,all)=>all.indexOf(x)===i).join('\n\n')});
        for(const r of this.db.all('range').filter(r=>r.assetId===a.id))this.db.put('range',{...r,assetId:target.id});
        for(const r of this.db.all('reference').filter(r=>r.assetId===a.id)){this.db.remove(r.id);this.ops.mutate({command:'retain',id:target.id,projectId:r.projectId,projectPath:r.projectPath});}
        for(const col of this.db.all('collection').filter(c=>c.members.includes(a.id)))this.db.put('collection',{...col,members:[...new Set(col.members.map((id:string)=>id===a.id?target.id:id))]});
        this.db.put('alias',{id:a.id,target:target.id});
      }
    },false);
    // A cheap browse image is independent of heavier review preparation.
    const thumb=path.join(this.db.dir,'cache',`${s.id}.png`);
    this.update(j,'Building browse image',.95);
    if(media.kind==='video')await this.run(j,ffmpeg,['-v','error','-y','-i',file,'-frames:v','1','-vf','scale=480:-2',thumb],false);
    else await this.run(j,ffmpeg,['-v','error','-y','-i',file,'-filter_complex','aformat=channel_layouts=mono,showwavespic=s=960x160:colors=0x4fc58e','-frames:v','1',thumb],false);
    this.evict();
  }
  async prepare(j:any) {
    const a=this.ops.asset(j.assetId),s=this.ops.source(a),file=this.ops.location(s);assert(s.status==='verified','Verify source before review preparation');assert(file,'Source unavailable or changed');
    const cache=path.join(this.db.dir,'cache');
    if(a.kind==='video') {
      this.update(j,'Indexing source presentation timestamps',.1);
      let exact:any;
      const index=await getFrameIndex({file,cacheDir:path.join(cache,'indexes'),maxBytes:64*1024**2,probe:async()=>{
        const raw=JSON.parse((await this.run(j,ffprobe,['-v','error','-select_streams','v:0','-show_frames','-show_streams','-show_entries','frame=best_effort_timestamp:stream=time_base','-of','json',file])).toString());
        const [num,den]=raw.streams[0].time_base.split('/').map(Number);exact={timeBase:{num,den},ticks:raw.frames.map((f:any)=>Number(f.best_effort_timestamp))};return decodeFrameTimestamps(raw);
      }});
      const frameFile=path.join(cache,`${s.id}.frames.json`);
      if(!exact&&!fs.existsSync(frameFile)){const base=s.metadata.streams.find((x:any)=>x.codec_type==='video').time_base.split('/').map(Number);exact={timeBase:{num:base[0],den:base[1]},ticks:index.pts.map((t:number)=>Math.round(t*base[1]/base[0]))};}
      if(exact)fs.writeFileSync(frameFile,JSON.stringify(exact));
      const media:any={[a.id]:{kind:'video',file,pts:index.pts}};
      this.update(j,'Preparing shared fast-seek cache',.35);
      const seekDirectory=path.join(cache,s.id); // Separate source ownership prevents eviction of other assets by the shared helper.
      await prepareSeekCache({media,plan:{clips:[{mediaId:a.id,sourceIn:0,start:0,speed:1,visibleStart:0,visibleEnd:a.duration}]},directory:seekDirectory,budget:Math.min(this.db.meta('cacheBudget'),512*1024**2),ffmpeg,ffprobe,run:(_name:string,program:string,args:string[],capture:boolean)=>this.run(j,program,args,capture)});
      const seek=media[a.id].seekProxy;
      fs.writeFileSync(path.join(cache,`${s.id}.preview.json`),JSON.stringify({pts:index.pts,seekProxy:seek||null}));
      // Native video decoding uses original pixels. Container-only remux makes MKV accessible to Chromium.
      if(/\.(mkv|avi)$/i.test(file)) {this.update(j,'Preparing native playback container',.8);await this.run(j,ffmpeg,['-v','error','-y','-i',file,'-map','0:v:0','-an','-c:v','copy','-movflags','+faststart',path.join(cache,`${s.id}.mp4`)],false);}
    }
    if(s.metadata.hasAudio){this.update(j,'Preparing source audio',.9);await this.run(j,ffmpeg,['-v','error','-y','-i',file,'-vn','-c:a','pcm_s16le',path.join(cache,`${s.id}.wav`)],false);}
    this.evict();
  }
  files():any[] {
    const root=path.join(this.db.dir,'cache'),out:any[]=[];
    const walk=(dir:string)=>{for(const e of fs.readdirSync(dir,{withFileTypes:true})){const p=path.join(dir,e.name);if(e.isDirectory())walk(p);else if(e.isFile()){const s=fs.statSync(p);out.push({path:p,bytes:s.size,touched:s.mtimeMs});}}};walk(root);return out;
  }
  evict(clear=false) {let files=this.files(),total=files.reduce((n,f)=>n+f.bytes,0),removed=0;const budget=clear?0:this.db.meta('cacheBudget');for(const f of files.sort((a,b)=>a.touched-b.touched)){if(total<=budget)break;if(this.active||[...this.readers.values()].some(t=>Date.now()-t<60000))continue;fs.unlinkSync(f.path);total-=f.bytes;removed+=f.bytes;}return {bytes:total,budget:this.db.meta('cacheBudget'),removedBytes:removed,protected:this.active!==null||[...this.readers.values()].some(t=>Date.now()-t<60000)};}
  preview(id:string) {
    const a=this.ops.asset(id),s=this.ops.source(a),cache=path.join(this.db.dir,'cache');this.readers.set(s.id,Date.now());
    let prepared:any={};try{prepared=JSON.parse(fs.readFileSync(path.join(cache,`${s.id}.preview.json`),'utf8'));}catch{}
    const route=(type:string)=>`/v1/media/${s.id}/${type}`;
    if(prepared.seekProxy&&!fs.existsSync(prepared.seekProxy.file))prepared.seekProxy=null;
    if(prepared.seekProxy)prepared.seekProxy={...prepared.seekProxy,url:route('seek')};
    return {asset:a,source:s,pts:prepared.pts||[],seekProxy:prepared.seekProxy,url:route(fs.existsSync(path.join(cache,`${s.id}.mp4`))?'container':'original'),audioUrl:route(fs.existsSync(path.join(cache,`${s.id}.wav`))?'audio':'original'),imageUrl:route('image'),prepared:!!prepared.pts||a.kind==='audio',frameCount:prepared.pts?.length||0};
  }
}
