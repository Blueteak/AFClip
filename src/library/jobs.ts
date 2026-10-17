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
  active:any=null; child:any=null; readers=new Map<string,number>(); streams=new Map<string,number>();
  db:Catalog; ops:Operations; changed:()=>void;
  scan:((j:any)=>Promise<void>)|undefined;
  constructor(db:Catalog, ops:Operations, changed:()=>void) {
    Object.assign(this,{db,ops,changed});
    fs.mkdirSync(path.join(db.dir,'cache'),{recursive:true});
    for(const r of db.db.prepare("SELECT id FROM jobs WHERE json_extract(data,'$.status')='running'").all() as any[]){const j=db.getJob(r.id);j.status='queued';db.job(j);}
    setTimeout(()=>this.pump(),100);
  }
  enqueue(kind:string,assetId:string) {
    const a=this.ops.asset(assetId);
    const row:any=this.db.db.prepare("SELECT data FROM jobs WHERE json_extract(data,'$.kind')=? AND json_extract(data,'$.sourceId')=? AND json_extract(data,'$.status') IN ('queued','running') LIMIT 1").get(kind,a.sourceId);if(row)return JSON.parse(row.data);
    const j=this.db.job({id:uid('job'),kind,assetId:a.id,sourceId:a.sourceId,status:'queued',progress:0,createdAt:now()});this.changed();setTimeout(()=>this.pump(),0);return j;
  }
  enqueueTask(kind:string,options:any){const j=this.db.job({id:uid('job'),kind,options,status:'queued',progress:0,createdAt:now()});this.changed();setTimeout(()=>this.pump(),0);return j;}
  cancel(id:string) {const j=this.db.getJob(id);if(['queued','running'].includes(j.status)){j.status='cancelled';this.db.job(j);if(this.active?.id===id){this.active.status='cancelled';this.child?.kill();}}this.changed();return j;}
  update(j:any,phase:string,progress:number) {Object.assign(j,{phase,progress});this.db.job(j);this.changed();}
  run(j:any,program:string,args:string[],capture=true):Promise<Buffer> {
    assert(j.status!=='cancelled','Job cancelled');
    return new Promise((resolve,reject)=>{const child=spawn(program,args,{windowsHide:true,stdio:['ignore',capture?'pipe':'ignore','pipe']});this.child=child;const chunks:Buffer[]=[];let size=0,err='';child.stdout?.on('data',b=>{chunks.push(b);size+=b.length;if(size>128*1024**2)child.kill();});child.stderr.on('data',b=>err=(err+b).slice(-4000));child.on('error',reject);child.on('close',code=>{this.child=null;if(j.status==='cancelled')reject(Object.assign(new Error('Job cancelled'),{code:'CANCELLED'}));else if(code)reject(new Error(err||`Media process exited ${code}`));else resolve(Buffer.concat(chunks));});});
  }
  async pump() {
    if(this.active)return;
    const j=this.db.nextJob();if(!j)return;
    this.active=j;j.status='running';this.update(j,'Starting',0);
    try {
      if(j.kind==='scan')await this.scan!(j);else if(j.kind==='verify')await this.verify(j);else if(j.kind==='artifact')await this.artifact(j);else if(j.kind==='thumbnail')await this.thumbnail(j);else await this.prepare(j);
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
      s=this.db.get(s.id);const duplicateRow:any=this.db.db.prepare("SELECT id FROM records WHERE kind='source' AND json_extract(data,'$.hash')=? AND id!=? LIMIT 1").get(digest,s.id);const duplicate=duplicateRow?this.db.get(duplicateRow.id):null;
      this.db.put('source',{...s,status:'verified',hash:digest,duration:media.duration,metadata:media.metadata});
      let a=this.ops.asset(j.assetId);if(a.sourceId!==s.id)return;this.db.put('asset',{...a,kind:media.kind,duration:seconds(media.duration)});
      const target=duplicate&&this.db.related('asset','sourceId',duplicate.id).find(x=>!x.purged);
      if(target&&target.id!==a.id){
        this.db.put('source',{...duplicate,locations:[...new Set([...duplicate.locations,...s.locations])],locationTimes:{...Object.fromEntries(duplicate.locations.map((p:string)=>[p,duplicate.mtimeMs])),...duplicate.locationTimes,...Object.fromEntries(s.locations.map((p:string)=>[p,s.mtimeMs]))}});
        // Aliases keep provisional project IDs resolvable. Merge context without overwriting it.
        this.db.put('asset',{...target,deleted:false,folder:target.folder==='inbox'?a.folder:target.folder,tags:[...new Set([...target.tags,...a.tags])],notes:[target.notes,a.notes].filter(Boolean).filter((x,i,all)=>all.indexOf(x)===i).join('\n\n')});
        for(const r of this.db.related('range','assetId',a.id))this.db.put('range',{...r,assetId:target.id});
        for(const r of this.db.related('reference','assetId',a.id)){this.db.remove(r.id);this.ops.mutate({command:'retain',id:target.id,projectId:r.projectId,projectPath:r.projectPath});}
        for(const col of (this.db.db.prepare('SELECT collection FROM search_members WHERE id=?').all(a.id) as any[]).map(r=>this.db.get(r.collection)))this.db.put('collection',{...col,members:[...new Set(col.members.map((id:string)=>id===a.id?target.id:id))]});
        this.db.put('alias',{id:a.id,target:target.id});
      }
    },false);
    await this.thumbnail(j);
  }
  async thumbnail(j:any){
    const a=this.ops.asset(j.assetId),s=this.db.get(j.sourceId,'source'),file=this.ops.location(s);assert(file,'Source unavailable or changed');
    const thumb=path.join(this.db.dir,'cache',`${s.id}.png`),temporary=thumb+'.partial.png';
    this.update(j,'Building browse image',.95);
    try{if(a.kind==='video')await this.run(j,ffmpeg,['-v','error','-y','-i',file,'-frames:v','1','-vf','scale=480:-2',temporary],false);
    else await this.run(j,ffmpeg,['-v','error','-y','-i',file,'-filter_complex','aformat=channel_layouts=mono,showwavespic=s=960x160:colors=0x4fc58e','-frames:v','1',temporary],false);
    fs.renameSync(temporary,thumb);}finally{fs.rmSync(temporary,{force:true});}
  }
  async prepare(j:any) {
    const a=this.ops.asset(j.assetId),s=this.db.get(j.sourceId,'source'),file=this.ops.location(s);assert(a.sourceId===s.id,'Source version changed; request preparation again');assert(s.status==='verified','Verify source before review preparation');assert(file,'Source unavailable or changed');
    const cache=path.join(this.db.dir,'cache');
    if(!fs.existsSync(path.join(cache,`${s.id}.png`)))await this.thumbnail(j);
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
  requestArtifact(c:any){
    const item=this.db.resolve(c.id),a=item.recordType==='range'?this.ops.asset(item.assetId):this.ops.asset(c.id),s=this.ops.source(a);
    assert(s.status==='verified','Wait for source verification before requesting an artifact');
    assert(['frame','contact-sheet','excerpt'].includes(c.type),'Artifact type must be frame, contact-sheet or excerpt');
    assert(a.kind==='video'||c.type==='excerpt','Frames and contact sheets require video');
    const toSeconds=(v:any,fallback:number)=>v===undefined?fallback:typeof v==='object'?seconds(v):seconds(parseTime(String(v)));
    const start=toSeconds(c.start,item.start?seconds(item.start):0),end=toSeconds(c.end,item.end?seconds(item.end):Math.min(a.duration,start+10));
    const time=toSeconds(c.time,start),width=Number(c.width)||640,count=Number(c.count)||12,columns=Number(c.columns)||4;
    assert(start>=0&&end>start&&end<=a.duration,'Artifact range must be inside the source');
    assert(c.type!=='excerpt'||end-start<=60,'Analysis excerpts are limited to 60 seconds');
    assert(time>=0&&time<a.duration,'Frame time must lie inside the source');
    assert(Number.isInteger(width)&&width>=64&&width<=1920&&Number.isInteger(count)&&count>=1&&count<=48&&Number.isInteger(columns)&&columns>=1&&columns<=8,'Invalid artifact dimensions');
    const options={assetId:a.id,sourceId:s.id,sourceHash:s.hash,type:c.type,start,end,time,width,count,columns,frame:c.frame===undefined?null:Number(c.frame),generation:1};
    if(options.frame!==null)assert(Number.isSafeInteger(options.frame)&&options.frame>=0,'Frame index must be a nonnegative integer');
    const key=createHash('sha256').update(JSON.stringify(options)).digest('hex'),extension=c.type==='excerpt'?(a.kind==='audio'?'wav':'mp4'):'png';
    const output=path.join(this.db.dir,'cache','artifacts',`${s.id}.${key}.${extension}`),url=`/v1/artifacts/${s.id}/${key}.${extension}`;
    if(fs.existsSync(output)){this.readers.set(s.id,Date.now());return {artifact:{key,type:c.type,path:output,url,sourceId:s.id},cacheHit:true,jobs:[]};}
    const pending=this.db.db.prepare("SELECT data FROM jobs WHERE json_extract(data,'$.kind')='artifact' AND json_extract(data,'$.options.key')=? AND json_extract(data,'$.status') IN ('queued','running')").get(key) as any;
    const job=pending?JSON.parse(pending.data):this.enqueueTask('artifact',{...options,key,output,url});
    return {artifact:{key,type:c.type,path:output,url,sourceId:s.id},cacheHit:false,jobs:[job]};
  }
  async artifact(j:any){
    const o=j.options,s=this.db.get(o.sourceId,'source'),file=this.ops.location(s);assert(file&&s.hash===o.sourceHash,'Artifact source changed or is unavailable');
    fs.mkdirSync(path.dirname(o.output),{recursive:true});const temporary=o.output+'.partial'+path.extname(o.output);
    this.update(j,`Generating ${o.type}`,0.1);
    try{
      const args=['-v','error','-y'];
      if(o.type==='frame'){
        if(o.frame===null)args.push('-ss',String(o.time));
        args.push('-i',file,'-an','-vf',`${o.frame===null?'':`select=eq(n\\,${o.frame}),`}scale=${o.width}:-2`,'-frames:v','1',temporary);
      }else if(o.type==='contact-sheet'){
        args.push('-ss',String(o.start),'-t',String(o.end-o.start),'-i',file,'-an','-vf',`fps=${o.count/(o.end-o.start)},scale=${o.width}:-2,tile=${o.columns}x${Math.ceil(o.count/o.columns)}:nb_frames=${o.count}:padding=4:margin=4:color=0x16171a`,'-frames:v','1',temporary);
      }else{
        args.push('-ss',String(o.start),'-i',file,'-t',String(o.end-o.start));
        if(path.extname(o.output)==='.wav')args.push('-vn','-c:a','pcm_s16le');
        else args.push('-vf',`scale=${o.width}:-2`,'-c:v','libx264','-preset','veryfast','-crf','20','-pix_fmt','yuv420p','-c:a','aac','-movflags','+faststart');
        args.push(temporary);
      }
      await this.run(j,ffmpeg,args,false);assert(fs.existsSync(temporary)&&fs.statSync(temporary).size>0,'Requested source frame was not found');fs.renameSync(temporary,o.output);
      j.result={key:o.key,type:o.type,sourceId:o.sourceId,path:o.output,url:o.url};
    }finally{fs.rmSync(temporary,{force:true});}
  }
  files():any[] {
    const root=path.join(this.db.dir,'cache'),out:any[]=[];
    const walk=(dir:string)=>{for(const e of fs.readdirSync(dir,{withFileTypes:true})){const p=path.join(dir,e.name);if(e.isDirectory())walk(p);else if(e.isFile()){const s=fs.statSync(p);out.push({path:p,bytes:s.size,touched:s.mtimeMs});}}};walk(root);return out;
  }
  hold(sourceId:string){this.streams.set(sourceId,(this.streams.get(sourceId)||0)+1);return ()=>{const n=(this.streams.get(sourceId)||1)-1;if(n)this.streams.set(sourceId,n);else this.streams.delete(sourceId);};}
  evict(clear=false) {
    const files=this.files();let total=files.reduce((n,f)=>n+f.bytes,0),removed=0,protectedBytes=0;const budget=clear?0:this.db.meta('cacheBudget');
    const protectedSources=new Set([...this.readers].filter(([,t])=>Date.now()-t<60000).map(([id])=>id));
    for(const id of this.streams.keys())protectedSources.add(id);
    const activeSource=this.active?.sourceId||this.active?.options?.sourceId;if(activeSource)protectedSources.add(activeSource);
    for(const f of files.sort((a,b)=>a.touched-b.touched)){
      const owner=path.relative(path.join(this.db.dir,'cache'),f.path).match(/source_[a-f0-9]+/)?.[0];
      const held=owner?protectedSources.has(owner):!!this.active||protectedSources.size>0;
      if(held){protectedBytes+=f.bytes;continue;}if(total<=budget)continue;
      try{fs.unlinkSync(f.path);total-=f.bytes;removed+=f.bytes;}catch{/* A decoder may still have the file open on Windows. */}
    }
    return {bytes:total,budget:this.db.meta('cacheBudget'),removedBytes:removed,protectedBytes,protected:protectedBytes>0};
  }
  preview(id:string) {
    const a=this.ops.asset(id),s=this.ops.source(a),cache=path.join(this.db.dir,'cache');this.readers.set(s.id,Date.now());
    if(s.status==='verified'&&this.ops.location(s)&&!fs.existsSync(path.join(cache,`${s.id}.png`)))this.enqueue('thumbnail',a.id);
    let prepared:any={};try{prepared=JSON.parse(fs.readFileSync(path.join(cache,`${s.id}.preview.json`),'utf8'));}catch{}
    const route=(type:string)=>`/v1/media/${s.id}/${type}`;
    if(prepared.seekProxy&&!fs.existsSync(prepared.seekProxy.file))prepared.seekProxy=null;
    if(prepared.seekProxy)prepared.seekProxy={...prepared.seekProxy,url:route('seek')};
    return {asset:a,source:s,pts:prepared.pts||[],seekProxy:prepared.seekProxy,url:route(fs.existsSync(path.join(cache,`${s.id}.mp4`))?'container':'original'),audioUrl:route(fs.existsSync(path.join(cache,`${s.id}.wav`))?'audio':'original'),imageUrl:route('image'),prepared:!!prepared.pts||a.kind==='audio',frameCount:prepared.pts?.length||0};
  }
}
