import fs from 'node:fs';
import {clipHelp} from './cli-help.ts';
import {frameWindow} from './shared/cli-frames.ts';
import {formatResponse,projectChanges} from './shared/cli-output.ts';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {endpoint,request as engineRequest} from './engine/client.ts';
import {assert,parseTime,cmp} from './shared/project.ts';

let fullOutput=false;
const editCommands=new Set(['apply','undo','redo','restore','import','library-import','source-insert','text-set','relink','asset-builtin','asset-duplicate']);
function request(ep:any,route:string,body?:any){
 return engineRequest(ep,route,body&&!fullOutput&&editCommands.has(body.command)?{...body,response:'changes'}:body);
}

async function folderCommand(ep:any,command:string,id:string|undefined,options:Record<string,string|boolean>){
 const state=await request(ep,'/inspect'),p=state.project,pre={...state.revisions},operations:any[]=[];
 if(command==='folders')return (p.folders||[]).map((f:any)=>({...f,trackIds:p.tracks.filter((t:any)=>t.folderId===f.id).map((t:any)=>t.id)}));
 const put=(collection:string,value:any)=>operations.push({op:'put',collection,value});
 const ids=()=>{assert(typeof options.tracks==='string','Supply --tracks with comma-separated track IDs');const ids=options.tracks.split(',').map(v=>v.trim());assert(ids.length&&ids.every(Boolean)&&new Set(ids).size===ids.length,'Supply unique track IDs');assert(ids.every(id=>p.tracks.some((t:any)=>t.id===id)),'Track not found');return ids;};
 if(command==='folder-create'){
  const tracks=ids();id=String(options.id||`folder_${randomUUID().replaceAll('-','')}`);
  assert(!p.folders.some((f:any)=>f.id===id),'Folder ID already exists');
  assert(options.name!==undefined,'Supply --name');pre[`folder:${id}`]=0;
  put('folders',{id,name:String(options.name)});
  for(const trackId of tracks){assert(!p.tracks.find((t:any)=>t.id===trackId).folderId,'Track already belongs to a folder');put('tracks',{id:trackId,folderId:id});}
 }else{
  const folder=p.folders.find((f:any)=>f.id===id);assert(folder,'Folder not found',{id});
  if(command==='folder-set'){
   const value:any={id};if(options.name!==undefined)value.name=String(options.name);
   for(const key of ['disabled','locked','collapsed'])if(options[key]!==undefined){assert(['true','false'].includes(String(options[key])),`--${key} must be true or false`);value[key]=options[key]==='true';}
   assert(Object.keys(value).length>1,'Supply at least one folder setting');put('folders',value);
  }else if(command==='folder-members'){
   const tracks=ids();
   for(const track of p.tracks){if(tracks.includes(track.id)){assert(!track.folderId||track.folderId===id,'Track already belongs to another folder');if(track.folderId!==id)put('tracks',{id:track.id,folderId:id});}else if(track.folderId===id)put('tracks',{id:track.id,folderId:null});}
  }else if(command==='folder-remove'){
   for(const track of p.tracks.filter((t:any)=>t.folderId===id))put('tracks',{id:track.id,folderId:null});
   operations.push({op:'remove',collection:'folders',id});
  }else if(command==='folder-move'){
   const members=p.tracks.filter((t:any)=>t.folderId===id),rest=p.tracks.filter((t:any)=>t.folderId!==id);
   const at=options.before===undefined?rest.length:rest.findIndex((t:any)=>t.id===options.before);
   assert(at>=0,'--before must name a track outside the folder');rest.splice(at,0,...members);
   operations.push({op:'reorder-tracks',trackIds:rest.map((t:any)=>t.id)});
  }
 }
 if(!operations.length)return fullOutput?state:projectChanges(state,state);
 return request(ep,'/command',{command:'apply',batch:{preconditions:pre,operations}});
}
async function markerCommand(ep:any,command:string,id:string|undefined,options:Record<string,string|boolean>){
 const state=await request(ep,'/command',{command:'inspect',collection:'markers'}),markers=[...state.items].sort((a:any,b:any)=>cmp(a.time,b.time)||a.id.localeCompare(b.id));
 if(command==='markers')return markers;
 if(command==='marker-next'||command==='marker-previous'){
  assert(options.time!==undefined,'Marker navigation requires --time');const at=parseTime(String(options.time));
  return command==='marker-next'?markers.find((m:any)=>cmp(m.time,at)>0)||null:markers.findLast((m:any)=>cmp(m.time,at)<0)||null;
 }
 const pre={...state.revisions};let operation:any;
 if(command==='marker-add'){
  assert(options.time!==undefined&&options.name!==undefined,'Marker add requires --time and --name');
  id=options.id===undefined?`marker_${randomUUID().replaceAll('-','')}`:String(options.id);
  pre[`marker:${id}`]=0;operation={op:'put',collection:'markers',value:{id,name:String(options.name),time:parseTime(String(options.time))}};
 }else{
  assert(id&&markers.some((m:any)=>m.id===id),'Marker not found',{id});
  if(command==='marker-remove')operation={op:'remove',collection:'markers',id};
  else{
   assert(options.time!==undefined||options.name!==undefined,'Marker set requires --time or --name');
   operation={op:'put',collection:'markers',value:{id,...(options.name!==undefined?{name:String(options.name)}:{}),...(options.time!==undefined?{time:parseTime(String(options.time))}:{})}};
  }
 }
 return request(ep,'/command',{command:'apply',batch:{preconditions:pre,operations:[operation]}});
}
async function main(){const args=process.argv.slice(2);const command=args.shift();if(!command||['help','--help','-h'].includes(command)){console.log(clipHelp(args[0]));return;}if(args.includes('--help')||args.includes('-h')){console.log(clipHelp(command));return;}const dirArg=args.shift();assert(dirArg,'Project directory required');const dir=path.resolve(dirArg),positionals:string[]=[],options:Record<string,string|boolean>={};for(let i=0;i<args.length;i++){if(args[i].startsWith('--')){const key=args[i].slice(2);if(['wait','full','pretty'].includes(key))options[key]=true;else{assert(args[i+1]!==undefined&&(!args[i+1].startsWith('--')||key==='text'),`Missing --${key} value`);options[key]=args[++i];}}else positionals.push(args[i]);}fullOutput=!!options.full;let r:any;if(command==='create')r=(await import('./engine/state.ts')).createProject(dir,{name:options.name,width:options.width?Number(options.width):undefined,height:options.height?Number(options.height):undefined,fps:options.fps?parseTime(String(options.fps)):undefined});else{const ep=await endpoint(dir);switch(command){case 'folders':case 'folder-create':case 'folder-set':case 'folder-members':case 'folder-move':case 'folder-remove':r=await folderCommand(ep,command,positionals[0],options);break;case 'asset-builtin':case 'asset-duplicate':r=await request(ep,'/command',{command,name:positionals[0],assetId:positionals[0]});break;case 'text-fields':r=await request(ep,'/command',{command:'text-fields',clipId:positionals[0]});break;
case 'text-set':case 'text-reset':{const info=options.revision===undefined||options['media-revision']===undefined?await request(ep,'/command',{command:'text-fields',clipId:positionals[0]}):{};assert(command==='text-reset'||(options.text!==undefined)!==(options.file!==undefined),'Supply exactly one of --text or --file');r=await request(ep,'/command',{command:'text-set',clipId:positionals[0],field:positionals[1],reset:command==='text-reset',value:options.file!==undefined?fs.readFileSync(path.resolve(String(options.file)),'utf8'):options.text,revision:options.revision===undefined?info.revision:Number(options.revision),mediaRevision:options['media-revision']===undefined?info.mediaRevision:Number(options['media-revision'])});break;}
case 'detach-audio':case 'unlink':{assert(positionals[0],'Clip ID required');const revision=options.revision===undefined?(await request(ep,'/inspect')).project.revision:Number(options.revision);assert(Number.isSafeInteger(revision)&&revision>=0,'Revision must be a non-negative integer');r=await request(ep,'/command',{command:'apply',batch:{preconditions:{project:revision},operations:[{op:command,clipId:positionals[0]}]}});break;}case 'markers':case 'marker-add':case 'marker-set':case 'marker-remove':case 'marker-next':case 'marker-previous':r=await markerCommand(ep,command,positionals[0],options);break;case 'endpoint':r=ep;break;case 'inspect':r=await request(ep,'/command',{command:'inspect',id:options.id,collection:options.collection,since:options.since===undefined?undefined:Number(options.since)});break;case 'apply':assert(positionals[0],'Batch JSON path required');r=await request(ep,'/command',{command:'apply',batch:JSON.parse(fs.readFileSync(path.resolve(positionals[0]),'utf8'))});break;case 'ripple-delete':{assert(options.start!==undefined&&options.end!==undefined,'Ripple delete requires --start and --end');const revision=options.revision===undefined?(await request(ep,'/inspect')).project.revision:Number(options.revision);assert(Number.isSafeInteger(revision)&&revision>=0,'Revision must be a non-negative integer');r=await request(ep,'/command',{command:'apply',batch:{preconditions:{project:revision},operations:[{op:'ripple-delete',start:parseTime(String(options.start)),end:parseTime(String(options.end))}]}});break;}case 'collect':{assert(positionals[0],'Destination folder required');const revision=options.revision===undefined?(await request(ep,'/inspect')).project.revision:Number(options.revision);assert(Number.isSafeInteger(revision)&&revision>=0,'Revision must be a non-negative integer');r=await request(ep,'/command',{command:'collect',output:path.resolve(positionals[0]),revision});break;}case 'relink':{assert(positionals[0]&&positionals[1],'Media ID and replacement file required');const revision=options.revision===undefined?(await request(ep,'/inspect')).project.revision:Number(options.revision);assert(Number.isSafeInteger(revision)&&revision>=0,'Revision must be a non-negative integer');r=await request(ep,'/command',{command:'relink',id:positionals[0],path:path.resolve(positionals[1]),revision});break;}case 'import':assert(positionals[0],'Source path required');r=await request(ep,'/command',{command:'import',path:path.resolve(positionals[0]),kind:options.kind});break;case 'source-prepare':case 'source-jobs':case 'source-cancel':{assert(positionals[0],'Project media ID required');if(command==='source-cancel')assert(positionals[1],'Source job ID required');r=await request(ep,'/command',{command,id:positionals[0],jobId:positionals[1]});if(command==='source-prepare'&&options.wait){const ids=r.jobs.map((j:any)=>j.id);while(r.jobs.some((j:any)=>['queued','running'].includes(j.status))){await new Promise(resolve=>setTimeout(resolve,100));const jobs=await request(ep,'/command',{command:'source-jobs',id:positionals[0]});r={...r,jobs:ids.map((id:string)=>{const job=jobs.find((j:any)=>j.id===id);assert(job,'Source job disappeared',{jobId:id});return job;})};}if(r.jobs.some((j:any)=>j.status!=='completed'))process.exitCode=1;}break;}case 'source-frames':assert(positionals[0],'Project media ID required');r=await request(ep,'/command',{command,id:positionals[0]});if(!options.full||options['start-frame']!==undefined||options['frame-count']!==undefined)r=frameWindow(r,options['start-frame'],options['frame-count']);break;case 'source-inspect':case 'source-waveform':assert(positionals[0],'Project media ID required');r=await request(ep,'/command',{command,id:positionals[0],...Object.fromEntries(['start','duration','bins'].filter(k=>options[k]!==undefined).map(k=>[k,Number(options[k])]))});break;case 'source-insert':{assert(positionals[0]&&options.at!==undefined,'Source insertion requires media ID and --at');const inspected=await request(ep,'/inspect');const preconditions=options.preconditions?JSON.parse(fs.readFileSync(path.resolve(String(options.preconditions)),'utf8')):inspected.revisions;r=await request(ep,'/command',{command,id:positionals[0],at:parseTime(String(options.at)),trackId:options.track,selection:options.selection?JSON.parse(String(options.selection)):undefined,preconditions,fps:options.fps?parseTime(String(options.fps)):inspected.project.fps});break;}case 'library-import':assert(positionals[0],'Library asset or range ID required');r=await request(ep,'/command',{command:'library-import',id:positionals[0],selection:options.selection?JSON.parse(String(options.selection)):undefined});break;case 'checkpoint':r=await request(ep,'/command',{command,task:options.task});break;case 'restore':r=await request(ep,'/command',{command,checkpointId:positionals[0]||'latest',confirmation:options.confirm});break;case 'library-sync':case 'library-status':case 'checkpoints':case 'undo':case 'redo':case 'close':r=await request(ep,'/command',{command});break;case 'status':case 'cancel':r=await request(ep,'/command',{command,jobId:positionals[0]});break;case 'export':case 'frame':{assert(positionals[0],'Output path required');const kind=command==='frame'?'frame':'export';assert(kind!=='frame'||options.time!==undefined,'Frame requires --time');assert((options.start===undefined)===(options.end===undefined),'Range requires both --start and --end');r=await request(ep,'/command',{command:'render',kind,output:path.resolve(positionals[0]),mode:options.mode||'gpu',verification:options.verify||'quick',imageSize:kind==='frame'?(options['image-size']||'review'):undefined,frameTime:kind==='frame'?parseTime(String(options.time)):undefined,range:options.start!==undefined?{start:parseTime(String(options.start)),end:parseTime(String(options.end))}:undefined});if(options.wait){while(['running','cancelling'].includes(r.status)){await new Promise(resolve=>setTimeout(resolve,100));r=await request(ep,'/command',{command:'status',jobId:r.id});}if(r.status!=='completed')process.exitCode=1;}break;}default:throw new Error(`Unknown command ${command}. Run --help.`);}}if(command==='source-inspect'&&(options['start-frame']!==undefined||options['frame-count']!==undefined))r=frameWindow(r,options['start-frame'],options['frame-count']);console.log(formatResponse({ok:true,result:r},{full:!!options.full,pretty:!!options.pretty}));}
main().catch((e:any)=>{console.error(formatResponse({ok:false,error:{code:e.code||'CLI_ERROR',message:e.message,...(e.details?{details:e.details}:{})}}));process.exitCode=1;});
