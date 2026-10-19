// Disposable command coverage and same-machine FFmpeg baselines.
// node benchmarks/cli/commands.mjs <new-output-directory>
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {commandSchema} from '../../src/library/command-schema.ts';
const require=createRequire(import.meta.url), ffmpeg=require('ffmpeg-static'),ffprobe=require('../../src/shared/ffprobe.cjs');
const root=fileURLToPath(new URL('../../',import.meta.url));
if(!process.argv[2])throw Error('Supply a new output directory');
const output=path.resolve(process.argv[2]);fs.mkdirSync(output);
const project=path.join(output,'project'),catalog=path.join(output,'library'),sources=path.join(output,'sources');fs.mkdirSync(sources);
const env={...process.env,AFCLIP_LIBRARY_HOME:catalog};
const report={hardware:{cpu:os.cpus()[0].model,cores:os.cpus().length,ram:os.totalmem(),node:process.version,platform:process.platform},samples:[],coverage:{},notes:[]};
const save=()=>fs.writeFileSync(path.join(output,'results.json'),JSON.stringify(report,null,2));
function processRun(binary,args){const start=performance.now();const p=spawnSync(binary,args,{cwd:root,env,windowsHide:true,encoding:'utf8',maxBuffer:64*1024**2,timeout:180000});return {...p,ms:performance.now()-start};}
function cli(tool,args,label=args[0],expect=true){
  const p=processRun(process.execPath,[path.join(root,tool==='af-clip'?'src/cli.ts':'src/library/cli.ts'),...args,...(tool==='af-lib'&&!['schema','help','--help'].includes(args[0])?['--catalog',catalog]:[])]);
  let response;try{response=JSON.parse(p.stdout);}catch{response={ok:p.status===0,result:p.stdout};}
  const result=response.result;
  report.samples.push({tool,command:args[0],label,ms:p.ms,exitCode:p.status,ok:p.status===0,bytes:Buffer.byteLength(p.stdout||''),stats:result?.stats,jobs:result?.jobs?.map(j=>({kind:j.kind,status:j.status,runningMs:j.runningMs})),error:response.error||result?.error});save();
  console.log(tool,label,Math.round(p.ms),p.status===0?'ok':'FAILED');
  if(expect&&(p.status!==0||response.ok===false))throw Error(JSON.stringify(response)+p.stderr);
  return result;
}
const lib=(command,options={},label=command)=>cli('af-lib',[command,...Object.entries(options).flatMap(([k,v])=>['--'+k,typeof v==='object'?JSON.stringify(v):String(v)])],label);
const clip=(command,args=[],label=command)=>cli('af-clip',[command,project,...args],label);
const inspect=()=>clip('inspect',['--full'],'setup inspect');
const asset=id=>lib('inspect',{id},'setup inspect');
const json=(name,value)=>{const file=path.join(output,name+'.json');fs.writeFileSync(file,JSON.stringify(value));return file;};
const t=n=>({num:n,den:1});
function ff(label,args){const p=processRun(ffmpeg,['-hide_banner','-v','error','-y',...args]);report.samples.push({tool:'ffmpeg',command:label,label,ms:p.ms,ok:p.status===0,exitCode:p.status,args});save();if(p.status)throw Error(p.stderr);return p;}
const video=path.join(sources,'video.mp4'),audio=path.join(sources,'audio.wav');
ff('fixture video',['-f','lavfi','-i','testsrc2=size=1920x1080:rate=60','-f','lavfi','-i','sine=frequency=440:sample_rate=48000','-t','8','-c:v','libx264','-preset','veryfast','-crf','20','-pix_fmt','yuv420p','-color_primaries','bt709','-color_trc','bt709','-colorspace','bt709','-color_range','tv','-c:a','aac',video]);
ff('fixture audio',['-f','lavfi','-i','sine=frequency=880:sample_rate=48000','-t','8','-c:a','pcm_s16le',audio]);
let videoAsset, projectOpen=false,libraryOpen=false;
try{
  cli('af-clip',['--help']);cli('af-clip',['help','frame']);cli('af-lib',['--help']);cli('af-lib',['schema']);cli('af-lib',['help','artifact']);
  lib('endpoint');libraryOpen=true;
  videoAsset=lib('import',{path:video,wait:true}).items[0];
  const audioAsset=lib('import',{path:audio,wait:true},'import audio').items[0];
  lib('register',{path:video});
  for(let n=0;n<3;n++){lib('search',{q:'video'});lib('overview');lib('inspect',{id:videoAsset.id});}
  lib('original',{id:videoAsset.id});
  for(const label of ['cold','warm'])lib('prepare',{ids:videoAsset.id,level:'index',wait:true},'index '+label);
  lib('frames',{id:videoAsset.id});
  let a=asset(videoAsset.id);lib('selection',{id:a.id,revision:a.revision,sourceId:a.sourceId,startFrame:0,endFrame:60});
  for(const label of ['cold','warm'])lib('waveform',{id:a.id,start:0,duration:8,bins:2048,summary:true},'waveform '+label);
  for(const label of ['cold','warm'])lib('prepare',{ids:a.id,level:'preview',wait:true},'preview '+label);
  lib('preview',{id:a.id});
  for(const type of ['frame','contact-sheet','excerpt'])for(const cache of ['cold','warm'])lib('artifact',{id:a.id,type,time:4,start:0,end:4,width:640,count:8,columns:4,wait:true},type+' '+cache);
  lib('artifact',{id:a.id,type:'frame',frame:420,width:640,wait:true},'exact frame 420');
  const job=lib('prepare',{ids:a.id,level:'index'}).jobs[0];lib('jobs',{id:job.id});lib('cancel',{id:job.id});
  let f=lib('folder-create',{name:'shots'});f=lib('folder-update',{id:f.id,revision:f.revision,name:'takes'});
  a=asset(a.id);lib('move',{id:a.id,revision:a.revision,folder:f.id});a=asset(a.id);lib('promote',{id:a.id,revision:a.revision,folder:'root'});
  lib('folder-delete',{id:f.id,revision:f.revision});
  let tag=lib('tag-create',{name:'good'});tag=lib('tag-rename',{id:tag.id,revision:tag.revision,name:'best'});
  a=asset(a.id);lib('annotate',{id:a.id,revision:a.revision,name:'video annotated',tags:tag.id,notes:'Benchmark annotation'});
  const target=lib('tag-create',{name:'keeper'});const ov=lib('overview');tag=ov.tags.find(x=>x.id===tag.id);
  lib('tag-merge',{id:tag.id,revision:tag.revision,target:target.id,targetRevision:target.revision});
  const updated=lib('overview').tags.find(x=>x.id===target.id);lib('tag-delete',{id:updated.id,revision:updated.revision,confirm:'clear-assignments'});
  a=asset(a.id);let range=lib('range-save',{assetId:a.id,revision:a.revision,name:'first second',startFrame:0,endFrame:60});
  let collection=lib('collection-create',{name:'selects'});collection=lib('collection-update',{id:collection.id,revision:collection.revision,members:range.id});
  lib('collection-delete',{id:collection.id,revision:collection.revision});lib('range-delete',{id:range.id,revision:range.revision});
  lib('retain',{id:a.id,projectId:'benchmark'});lib('references');lib('withdraw',{id:a.id,projectId:'benchmark'});lib('sync-project',{projectId:'benchmark',assetIds:[a.id]});
  let mapping=lib('source-folder-save',{path:sources,watched:false});lib('source-folders');lib('rescan',{id:mapping.id,wait:true});lib('source-folder-remove',{id:mapping.id,revision:mapping.revision});
  lib('apply',{operations:[{command:'folder-create',name:'batched'}]});lib('undo');lib('redo');lib('history');
  cli('af-lib',['call',json('call',{command:'search',q:'video'})]);
  const cp=lib('checkpoint',{name:'benchmark'});lib('checkpoints');lib('checkpoint-restore',{id:cp.id,confirm:'discard-later-edits'});
  let aud=asset(audioAsset.id);lib('replace',{id:aud.id,revision:aud.revision,path:audio,confirm:'reset-annotations'});
  // Wait for replacement verification before exercising destructive catalog operations.
  lib('prepare',{ids:aud.id,level:'index',wait:true});
  aud=asset(aud.id);lib('remove',{id:aud.id,revision:aud.revision});aud=asset(aud.id);lib('restore',{id:aud.id,revision:aud.revision});aud=asset(aud.id);lib('remove',{id:aud.id,revision:aud.revision});aud=asset(aud.id);lib('purge',{id:aud.id,revision:aud.revision,confirm:'purge-catalog-record'});
  clip('create',['--width','1920','--height','1080','--fps','30']);projectOpen=true;clip('endpoint');
  const imported=clip('import',[video,'--full']).media;
  clip('relink',[imported.id,video]);clip('library-sync');clip('library-status');clip('library-import',[a.id]);
  let state=inspect(),media=state.project.media.find(m=>m.kind==='video');
  clip('source-inspect',[media.id]);clip('source-prepare',[media.id,'--wait']);clip('source-frames',[media.id]);clip('source-jobs',[media.id]);
  const sourceJob=clip('source-prepare',[media.id]).jobs[0];clip('source-cancel',[media.id,sourceJob.id]);
  clip('source-waveform',[media.id,'--start','0','--duration','4','--bins','2048']);clip('source-insert',[media.id,'--at','0']);
  state=inspect();const mainClip=state.project.clips[0];
  clip('detach-audio',[mainClip.id]);clip('unlink',[mainClip.id]);
  const graphic=path.join(output,'graphic');fs.mkdirSync(graphic);fs.writeFileSync(path.join(graphic,'index.html'),`<!doctype html><html><body style="background:transparent;color:white"><div data-afclip-text="title">Title</div><script>addEventListener('message',e=>{if(e.data.type==='afclip-render')e.source.postMessage({type:'afclip-ready',requestId:e.data.requestId},'*')})</script></body></html>`);
  const gm=clip('import',[graphic,'--kind','graphic','--full']).media;
  state=inspect();clip('apply',[json('batch',{preconditions:{...state.revisions,'track:title-track':0,'clip:title-clip':0,'occupancy:title-track':0},operations:[{op:'put',collection:'tracks',value:{id:'title-track',name:'Title'}},{op:'put',collection:'clips',value:{id:'title-clip',trackId:'title-track',mediaId:gm.id,start:t(6),duration:t(1),sourceIn:t(0)}}]})]);
  clip('text-fields',['title-clip']);clip('text-set',['title-clip','title','--text','New title']);clip('text-reset',['title-clip','title']);
  const built=clip('asset-builtin',['blur','--full']);
  const builtin=inspect().project.media.find(m=>m.metadata?.asset?.role==='effect');assert(builtin);clip('asset-duplicate',[builtin.id]);
  clip('folder-create',['--id','folder-bench','--name','Footage','--tracks',mainClip.trackId]);clip('folders');clip('folder-set',['folder-bench','--collapsed','true']);clip('folder-members',['folder-bench','--tracks',inspect().project.tracks.map(x=>x.id).join(',')]);clip('folder-move',['folder-bench']);clip('folder-remove',['folder-bench']);
  clip('marker-add',['--id','mark','--time','1','--name','Beat']);clip('markers');clip('marker-set',['mark','--time','2']);clip('marker-next',['--time','0']);clip('marker-previous',['--time','3']);clip('marker-remove',['mark']);
  clip('ripple-delete',['--start','7','--end','8']);clip('undo');clip('redo');clip('undo');
  const checkpoint=clip('checkpoint',['--task','benchmark']);clip('checkpoints');clip('restore',[checkpoint.id||'latest','--confirm','discard-later-edits']);
  clip('collect',[path.join(output,'collected')]);
  // Plain four-second section, with audio; no graphic is active in this range.
  for(let n=0;n<3;n++)for(const mode of ['software','gpu'])clip('export',[path.join(output,`export-${mode}-${n}.mp4`),'--start','0','--end','4','--mode',mode,'--verify','full','--wait'],'export '+mode);
  for(let n=0;n<3;n++)clip('frame',[path.join(output,`frame-${n}.png`),'--time','2','--mode','software','--image-size','full','--wait']);
  const render=clip('export',[path.join(output,'cancelled.mp4'),'--mode','software']);clip('status',[render.id]);clip('cancel',[render.id]);
  for(let n=0;n<100;n++){const job=clip('status',[render.id],'cancel completion');if(!['running','cancelling'].includes(job.status))break;await new Promise(r=>setTimeout(r,100));}
  lib('cache');lib('cache-budget',{bytes:512*1024**2});lib('cache-clear');
  for(let n=0;n<3;n++){
    const probe=processRun(ffprobe,['-v','error','-show_format','-show_streams','-of','json',video]);assert.equal(probe.status,0);report.samples.push({tool:'ffprobe',command:'inspect',label:'inspect',ms:probe.ms,ok:true});
    ff('frame 640',['-ss','4','-i',video,'-an','-vf','scale=640:-2','-frames:v','1',path.join(output,`ff-frame-${n}.png`)]);
    ff('frame 1080',['-ss','2','-i',video,'-an','-frames:v','1',path.join(output,`ff-full-frame-${n}.png`)]);
    ff('contact-sheet',['-ss','0','-t','4','-i',video,'-an','-vf',"select='gte(t,selected_n*0.5)',scale=640:-2,showinfo,tile=4x2:nb_frames=8:padding=4:margin=4:color=0x16171a",'-frames:v','1',path.join(output,`ff-sheet-${n}.png`)]);
    ff('excerpt',['-ss','0','-i',video,'-t','4','-vf','scale=640:-2','-c:v','libx264','-preset','veryfast','-crf','20','-pix_fmt','yuv420p','-c:a','aac','-movflags','+faststart',path.join(output,`ff-excerpt-${n}.mp4`)]);
    for(const mode of ['software','gpu'])ff('export '+mode,['-i',video,'-t','4','-vf','select=not(mod(n\\,2)),setpts=N/(30*TB),format=yuv420p','-r','30','-c:v',mode==='software'?'libx264':'h264_nvenc',...(mode==='software'?['-preset','fast','-crf','18','-bf','0']:['-preset','p4','-cq','18','-b:v','0','-bf','0']),'-color_primaries','bt709','-color_trc','bt709','-colorspace','bt709','-c:a','aac','-b:a','192k','-movflags','+faststart',path.join(output,`ff-${mode}-${n}.mp4`)]);
  }
}finally{
  if(projectOpen)clip('close');if(libraryOpen)lib('close');
  const helpSource=['src/cli.ts','src/cli-help.ts'].filter(p=>fs.existsSync(path.join(root,p))).map(p=>fs.readFileSync(path.join(root,p),'utf8')).join('\n');
  const editor=[...helpSource.matchAll(/^  af-clip ([a-z][a-z|-]*)/gm)].flatMap(m=>m[1].split('|'));
  for(const [tool,expected] of [['af-clip',[...new Set(editor)]],['af-lib',Object.keys(commandSchema)]])report.coverage[tool]=expected.map(command=>({command,samples:report.samples.filter(s=>s.tool===tool&&s.command===command).length,status:report.samples.some(s=>s.tool===tool&&s.command===command&&s.ok)?'measured':'not measured'}));
  report.notes.push('GUI opens an interactive window and is reviewed separately, not timed by this noninteractive suite.','FFmpeg export is a processing baseline, not pixel-equivalent HTML composition or identical NVENC rate control. AFClip includes indexing, muxing, full verification and application startup.');save();
}
