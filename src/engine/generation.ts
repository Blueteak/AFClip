import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {atomicJSON} from './state.ts';
import {inspectMedia} from './probe.ts';
import {assert,fail,revisions,time,seconds,add,cmp,ZERO,ONE,rational,trackLocked,duration} from '../shared/project.ts';

const require=createRequire(import.meta.url),ffmpeg=require('ffmpeg-static');
const uid=(prefix:string)=>prefix+'_'+randomUUID().replaceAll('-','');
const codeRoot=fileURLToPath(new URL('../../',import.meta.url));

export class Generations {
  state:any; library:any; notify:any; enqueue:any; root:string;
  jobs=new Map<string,any>(); active=new Map<string,AbortController>();
  constructor(state:any,library:any,notify:any,enqueue:any) {
    Object.assign(this,{state,library,notify,enqueue});
    this.root=path.join(state.dir,'.afclip','generation');fs.mkdirSync(this.root,{recursive:true});
    for(const entry of fs.readdirSync(this.root,{withFileTypes:true}))if(entry.isDirectory()){
      try{const job=JSON.parse(fs.readFileSync(path.join(this.root,entry.name,'job.json'),'utf8'));
        if(job.status==='generating'){job.status='failed';job.error={code:'GENERATION_INTERRUPTED',message:'Generation interrupted. Retry explicitly; the previous request may have been billed.'};}
        this.jobs.set(job.id,job);this.persist(job);
      }catch{}
    }
    state.generationStatus=()=>this.list();
  }
  directory(id:string){assert(/^gen_[a-zA-Z0-9]+$/.test(id),'Invalid generation ID');return path.join(this.root,id);}
  persist(job:any){atomicJSON(path.join(this.directory(job.id),'job.json'),job);}
  list(){return this.state.p.clips.filter((c:any)=>c.generationId).map((c:any)=>this.jobs.get(c.generationId)).filter(Boolean).map((j:any)=>this.public(j));}
  public(job:any){const {media,...rest}=job;return structuredClone(rest);}
  clip(id:string){const clip=this.state.p.clips.find((c:any)=>c.id===id);assert(clip?.generationId,'Generation placeholder not found',{clipId:id});return clip;}
  job(clipId:string){return this.jobs.get(this.clip(clipId).generationId)||fail('NOT_FOUND','Generation state is missing');}
  emit(job:any){this.persist(job);this.notify(this.state.inspect());}
  commit(operations:any[],history=true){
    const pre=revisions(this.state.p);
    for(const op of operations){if(op.op==='put')pre[`${op.collection==='media'?'media':'clip'}:${op.value.id}`]??=0;if(op.collection==='media')pre[`usage:${op.value?.id||op.id}`]??=0;}
    const oldUndo=[...this.state.undo],oldRedo=[...this.state.redo];
    const result=this.state.batch({preconditions:pre,operations},true,true);
    if(!history){this.state.undo=oldUndo;this.state.redo=oldRedo;}
    return result;
  }
  async run(binary:string,args:string[],signal?:AbortSignal){
    return new Promise<string>((resolve,reject)=>{
      const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
      const child=spawn(binary,args,{cwd:codeRoot,windowsHide:true,env,stdio:['ignore','pipe','pipe']});
      let out='',err='';
      const abort=()=>{child.kill();reject(Object.assign(new Error('Generation cancelled locally'),{code:'GENERATION_CANCELLED'}));};
      if(signal?.aborted){abort();return;}signal?.addEventListener('abort',abort,{once:true});
      child.stdout.on('data',b=>{out+=b;if(out.length>4_000_000)child.kill();});child.stderr.on('data',b=>{err=(err+b).slice(-4000);});
      child.on('error',reject);child.on('close',code=>{signal?.removeEventListener('abort',abort);if(code===0)resolve(out);else{
        let error:any;try{error=JSON.parse(out.trim().split('\n').at(-1)!).error;}catch{}
        reject(Object.assign(new Error(error?.message||err||`Worker exited ${code}`),{code:error?.code||'GENERATION_WORKER'}));
      }});
    });
  }
  async api(config:any,signal?:AbortSignal){
    const file=path.join(this.root,uid('request')+'.json');atomicJSON(file,config);
    try{const output=await this.run(require('electron'),[fileURLToPath(new URL('./elevenlabs-worker.cjs',import.meta.url)),file],signal);
      const response=JSON.parse(output.trim().split('\n').at(-1)!);assert(response.ok,response.error?.message||'API worker failed');return response.result;
    }finally{fs.rmSync(file,{force:true});}
  }
  async voices(c:any){return this.api({action:'voices',nextPageToken:c.nextPageToken});}
  async configured(){return this.api({action:'configured'});}
  settings(c:any,previous:any={}){
    const s={...previous,...Object.fromEntries(['type','text','voiceId','addVideo'].filter(k=>c[k]!==undefined).map(k=>[k,c[k]]))};
    assert(['music','sfx','speech'].includes(s.type),'Choose music, sfx or speech');
    assert(typeof s.text==='string'&&s.text.trim().length>0&&s.text.length<=4100,'Text must contain 1 to 4100 characters');s.text=s.text.trim();s.addVideo=!!s.addVideo;
    if(s.type!=='music'&&c.addVideo===undefined)s.addVideo=false;
    assert(!s.addVideo||s.type==='music','Video context is supported only for Music');
    if(s.type==='speech')assert(typeof s.voiceId==='string'&&/^[a-zA-Z0-9_-]+$/.test(s.voiceId),'Select a voice');
    return s;
  }
  async start(c:any){
    this.state.requireUnlocked();
    let clip=c.clipId?this.clip(c.clipId):null,job=clip?this.job(c.clipId):null;
    assert(!job||!this.active.has(job.id),'A request is already generating for this slot');
    const settings=this.settings(c,job?.settings),len=clip?.duration||time(c.duration),start=clip?.start||time(c.start),trackId=clip?.trackId||c.trackId,n=seconds(len);
    assert(Number.isFinite(n)&&n>0,'Select a positive duration');
    if(settings.type==='sfx')assert(n>=0.5&&n<=30,'SFX requires 0.5 to 30 seconds');
    if(settings.type==='music'&&!settings.addVideo)assert(n>=3&&n<=600,'Music requires 3 to 600 seconds');
    assert(this.state.p.tracks.some((t:any)=>t.id===trackId)&&!trackLocked(this.state.p,trackId),'Choose an unlocked track');
    assert(cmp(start,ZERO)>=0,'Start must not be negative');
    for(const at of [start,len])assert((BigInt(at.num)*BigInt(this.state.p.fps.num))%(BigInt(at.den)*BigInt(this.state.p.fps.den))===0n,'Range must land on the project frame grid');
    assert(!this.state.p.clips.some((x:any)=>x.id!==clip?.id&&x.trackId===trackId&&cmp(x.start,add(start,len))<0&&cmp(add(x.start,x.duration),start)>0),'Range overlaps a clip');
    if(settings.addVideo&&(!job?.snapshot||!fs.existsSync(path.resolve(this.state.dir,job.snapshot.file))||c.refreshVideo)){
      assert(cmp(add(start,len),duration(this.state.p))<=0,'Video context must be inside the timeline');
      assert(this.state.p.clips.some((x:any)=>{const m=this.state.p.media.find((m:any)=>m.id===x.mediaId),track=this.state.p.tracks.find((t:any)=>t.id===x.trackId);return !track?.disabled&&!this.state.p.folders?.find((f:any)=>f.id===track?.folderId)?.disabled&&['video','image','graphic'].includes(m?.kind)&&x.stream!=='audio'&&cmp(x.start,add(start,len))<0&&cmp(add(x.start,x.duration),start)>0;}),'No video in the selected range');
    }
    const configured=await this.configured();assert(configured.elevenlabs.configured,'Save an ElevenLabs key in API settings first');
    if(!job){
      job={id:uid('gen'),clipId:uid('clip'),status:'generating',duration:len,settings,takes:[],media:[],createdAt:new Date().toISOString()};
      const folder=this.directory(job.id);fs.mkdirSync(folder,{recursive:true});
      // A real silent source keeps ordinary playback/export and gap occupancy working.
      const silence=path.join(folder,'silence.wav');await this.run(ffmpeg,['-v','error','-y','-f','lavfi','-i','anullsrc=r=8000:cl=mono','-t',String(n+.001),'-c:a','pcm_s16le',silence]);
      const media:any=await inspectMedia(silence,'audio');media.path=path.relative(this.state.dir,silence);media.metadata.generationId=job.id;job.media.push(media);
      this.jobs.set(job.id,job);this.persist(job);
      clip={id:job.clipId,trackId,mediaId:media.id,generationId:job.id,name:settings.text.slice(0,64),start,duration:len,sourceIn:ZERO,speed:ONE,volume:1,mute:false,fadeIn:ZERO,fadeOut:ZERO};
      try{this.commit([{op:'put',collection:'media',value:media},{op:'put',collection:'clips',value:clip}]);}catch(e){this.jobs.delete(job.id);throw e;}
    }
    job.settings=settings;job.status='generating';job.phase=settings.addVideo?'video':'request';delete job.error;
    let snapshot:any;
    if(settings.addVideo&&(!job.snapshot||!fs.existsSync(path.resolve(this.state.dir,job.snapshot.file))||c.refreshVideo)){
      snapshot=structuredClone(this.state.p);job.snapshot={revision:snapshot.revision,start:clip.start,duration:len,file:path.relative(this.state.dir,path.join(this.directory(job.id),uid('context')+'.mp4'))};
      // Preserve accepted graphic versions while normal edits prune their old snapshots.
      for(const m of snapshot.media.filter((m:any)=>m.kind==='graphic')){const dest=path.join(this.directory(job.id),'graphics',m.id,uid('snapshot'));fs.cpSync(path.resolve(this.state.dir,m.path),dest,{recursive:true});m.path=dest;}
    }
    const controller=new AbortController();this.active.set(job.id,controller);this.emit(job);
    void this.generate(job,structuredClone(settings),snapshot,controller).catch(()=>{});
    return this.state.inspect();
  }
  async video(job:any,project:any,signal:AbortSignal){
    const folder=path.join(this.directory(job.id),uid('render'));fs.mkdirSync(folder,{recursive:true});
    const raw=path.join(folder,'full.mp4'),cancelFile=path.join(folder,'cancel'),config=path.join(folder,'config.json');
    // Render the immutable project at its native size, preserving pixel-based graphics.
    for(const clip of project.clips)clip.mute=true;
    atomicJSON(config,{projectDir:this.state.dir,project,output:raw,mode:'software',verification:'quick',kind:'export',range:{start:job.snapshot.start,end:add(job.snapshot.start,job.duration)},jobId:job.id,cancelFile});
    const cancel=()=>fs.writeFileSync(cancelFile,'cancel');signal.addEventListener('abort',cancel,{once:true});
    try{
      await this.run(process.execPath,[fileURLToPath(new URL('../render/job.cjs',import.meta.url)),config]);
      await this.run(ffmpeg,['-v','error','-y','-i',raw,'-an','-vf',"scale=w='min(640,iw)':h='min(640,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2",'-c:v','libx264','-preset','fast','-crf','28','-movflags','+faststart',path.resolve(this.state.dir,job.snapshot.file)],signal);
    }finally{signal.removeEventListener('abort',cancel);if(!signal.aborted){const target=path.resolve(folder);assert(target.startsWith(path.resolve(this.directory(job.id))+path.sep),'Render cleanup escaped generation directory');fs.rmSync(target,{recursive:true,force:true});}}
  }
  async generate(job:any,settings:any,snapshot:any,controller:AbortController){
    const signal=controller.signal,folder=this.directory(job.id),id=uid('take'),output=path.join(folder,id+'.mp3');
    try{
      if(snapshot)await this.video(job,snapshot,signal);
      if(signal.aborted)throw new Error('Generation cancelled');job.phase='request';this.emit(job);
      const response=await this.api({action:'generate',settings,seconds:seconds(job.duration),output,video:job.snapshot?path.resolve(this.state.dir,job.snapshot.file):undefined},signal);
      const media:any=await inspectMedia(output,'audio');media.path=path.relative(this.state.dir,output);media.metadata.generationId=job.id;
      const previewFile=path.join(folder,id+'-preview.wav');
      await this.run(ffmpeg,['-v','error','-y','-i',output,'-af','apad','-t',String(seconds(job.duration)+.001),'-ar','48000','-ac','2','-c:a','pcm_s16le',previewFile],signal);
      const preview:any=await inspectMedia(previewFile,'audio');preview.path=path.relative(this.state.dir,previewFile);preview.metadata.generationId=job.id;
      if(signal.aborted)return;
      await this.enqueue(()=>{
        const clip=this.state.p.clips.find((c:any)=>c.generationId===job.id);
        if(!clip||signal.aborted)return;
        const first=job.takes.length===0;
        job.media.push(media,preview);job.takes.push({id,...settings,duration:media.duration,mediaId:media.id,previewMediaId:preview.id,requestId:response.requestId});
        job.status='ready';job.phase='ready';delete job.error;this.persist(job);
        if(first&&!this.state.locked&&!trackLocked(this.state.p,clip.trackId))this.commit([{op:'put',collection:'media',value:media},{op:'put',collection:'media',value:preview},{op:'put',collection:'clips',value:{id:clip.id,mediaId:preview.id}}],false);
        else if(first)job.pendingSelection=id;
        this.emit(job);
      });
    }catch(error:any){
      job.status='failed';job.phase='failed';job.error={code:error.code||'GENERATION_FAILED',message:error.message};this.emit(job);
    }finally{this.active.delete(job.id);}
  }
  select(c:any){
    const clip=this.clip(c.clipId),job=this.job(c.clipId),take=job.takes.find((t:any)=>t.id===c.takeId);assert(take,'Take not found');
    const media=job.media.find((m:any)=>m.id===take.previewMediaId);assert(media&&fs.existsSync(path.resolve(this.state.dir,media.path)),'Take audio is missing');
    const ops:any[]=[];if(!this.state.p.media.some((m:any)=>m.id===media.id))ops.push({op:'put',collection:'media',value:media});
    ops.push({op:'put',collection:'clips',value:{id:clip.id,mediaId:media.id}});this.commit(ops);delete job.pendingSelection;this.emit(job);return this.state.inspect();
  }
  async accept(c:any){
    this.state.requireUnlocked();const clip=this.clip(c.clipId),job=this.job(c.clipId),take=job.takes.find((t:any)=>t.previewMediaId===clip.mediaId);assert(take,'Select a completed take first');
    assert(!trackLocked(this.state.p,clip.trackId),'Unlock the track before accepting a take');
    const fps=this.state.p.fps,frames=Math.ceil(seconds(take.duration)*seconds(fps)-1e-7),actual=rational(BigInt(Math.max(1,frames))*BigInt(fps.den),fps.num);
    let length=cmp(actual,clip.duration)<0?actual:clip.duration;
    if(take.type==='speech'&&cmp(take.duration,clip.duration)>0){assert(c.extend,'Speech exceeds the slot. Extend into empty space or move/regenerate before accepting');length=actual;}
    assert(!this.state.p.clips.some((x:any)=>x.id!==clip.id&&x.trackId===clip.trackId&&cmp(x.start,add(clip.start,length))<0&&cmp(add(x.start,x.duration),clip.start)>0),'Speech extension overlaps another clip. Move the placeholder or regenerate shorter dialogue');
    const original=job.media.find((m:any)=>m.id===take.mediaId),file=path.join(this.state.dir,'media','generated',take.id+'.wav');fs.mkdirSync(path.dirname(file),{recursive:true});await this.run(ffmpeg,['-v','error','-y','-i',path.resolve(this.state.dir,original.path),'-af','apad','-t',String(seconds(actual)+.001),'-ar','48000','-ac','2','-c:a','pcm_s16le',file]);
    let media:any=await inspectMedia(file,'audio');media=await this.library.register(media);media.path=path.relative(this.state.dir,file);
    const operations:any[]=[{op:'put',collection:'media',value:media},{op:'put',collection:'clips',value:{id:clip.id,generationId:null,mediaId:media.id,duration:length,name:take.text.slice(0,64)}}];
    for(const m of this.state.p.media.filter((m:any)=>m.metadata.generationId===job.id))if(!this.state.p.clips.some((x:any)=>x.id!==clip.id&&x.mediaId===m.id))operations.push({op:'remove',collection:'media',id:m.id});
    this.commit(operations);this.reconcile();await this.library.sync();this.notify(this.state.inspect());return this.state.inspect();
  }
  reconcile(){
    for(const [id,controller]of this.active)if(!this.state.p.clips.some((c:any)=>c.generationId===id)){
      controller.abort();const job=this.jobs.get(id);job.status='failed';job.error={code:'GENERATION_CANCELLED',message:'Cancelled locally. Retry explicitly to generate again.'};this.persist(job);
    }
    for(const job of this.jobs.values()){const clip=this.state.p.clips.find((c:any)=>c.generationId===job.id);if(clip&&job.takes.length&&!job.takes.some((t:any)=>t.previewMediaId===clip.mediaId))job.pendingSelection=job.takes[0].id;}
    for(const job of this.jobs.values())if(job.pendingSelection&&!this.state.locked){const clip=this.state.p.clips.find((c:any)=>c.generationId===job.id);if(clip&&!trackLocked(this.state.p,clip.trackId))this.select({clipId:clip.id,takeId:job.pendingSelection});}
    // Undo retains files. After the last recoverable reference disappears, remove only
    // this manager's own directory; accepted audio lives in media/generated instead.
    const projects=[this.state.p,...this.state.undo,...this.state.redo];
    for(const [id,job] of this.jobs)if(!this.active.has(id)&&!projects.some(p=>p.clips.some((c:any)=>c.generationId===id)||p.media.some((m:any)=>m.metadata.generationId===id))){
      const target=path.resolve(this.directory(id));assert(target.startsWith(path.resolve(this.root)+path.sep),'Generation cleanup escaped its directory');fs.rmSync(target,{recursive:true,force:true});this.jobs.delete(id);
    }
  }
  async command(c:any){
    switch(c.command){
      case 'generation-start':return this.start(c);
      case 'generation-status':{if(c.clipId)return this.public(this.job(c.clipId));const items=this.list(),offset=Number(c.offset||0),limit=Math.min(100,Number(c.limit||30));assert(Number.isInteger(offset)&&offset>=0&&Number.isInteger(limit)&&limit>0,'Invalid pagination');return {items:items.slice(offset,offset+limit),...(offset+limit<items.length?{nextOffset:offset+limit}:{})};}
      case 'generation-voices':return this.voices(c);
      case 'generation-select':return this.select(c);
      case 'generation-accept':return this.accept(c);
    }
  }
}
