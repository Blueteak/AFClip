import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {createProject} from './engine/state.ts';
import {endpoint,request} from './engine/client.ts';
import {assert,parseTime,cmp} from './shared/project.ts';

const HELP=`AFClip first editing slice. Every command prints JSON except help.

  node src/cli.ts create <project-dir> [--name NAME] [--width 1920 --height 1080 --fps 30]
  node src/cli.ts inspect <project-dir>
  node src/cli.ts endpoint <project-dir>
  node src/cli.ts import <project-dir> <source-file> [--kind video|audio|image|graphic]
  node src/cli.ts library-import <project-dir> <asset-or-range-id>
  node src/cli.ts library-sync|library-status <project-dir>
  node src/cli.ts source-inspect <project-dir> <media-id>
  node src/cli.ts source-prepare <project-dir> <media-id> [--wait]
  node src/cli.ts source-jobs <project-dir> <media-id>
  node src/cli.ts source-cancel <project-dir> <media-id> <job-id>
  node src/cli.ts source-waveform <project-dir> <media-id> [--start SEC --duration SEC --bins N]
  node src/cli.ts source-insert <project-dir> <media-id> --at SEC [--track ID --selection JSON --preconditions FILE]
  node src/cli.ts apply <project-dir> <batch.json>
  node src/cli.ts text-fields <project-dir> <clip-id>
  node src/cli.ts text-set <project-dir> <clip-id> <field-id> --text VALUE [--revision N --media-revision N]
  node src/cli.ts text-set <project-dir> <clip-id> <field-id> --file text.txt
  node src/cli.ts text-reset <project-dir> <clip-id> <field-id>
  node src/cli.ts markers <project-dir>
  node src/cli.ts marker-add <project-dir> --time SEC --name NAME [--id ID]
  node src/cli.ts marker-set <project-dir> <marker-id> [--time SEC] [--name NAME]
  node src/cli.ts marker-remove <project-dir> <marker-id>
  node src/cli.ts marker-next|marker-previous <project-dir> --time SEC
  node src/cli.ts ripple-delete <project-dir> --start SEC --end SEC [--revision N]
  node src/cli.ts detach-audio|unlink <project-dir> <clip-id> [--revision N]
  node src/cli.ts undo|redo <project-dir>
  node src/cli.ts export <project-dir> <output.mp4> [--mode gpu|software] [--start SEC --end SEC] [--verify quick|full] [--wait]
  node src/cli.ts frame <project-dir> <output.png> --time SEC [--mode gpu|software] [--wait]
  node src/cli.ts status <project-dir> [job-id]
  node src/cli.ts cancel <project-dir> [job-id]
  node src/cli.ts close <project-dir>
  node src/cli.ts checkpoint <project-dir> --task DESCRIPTION
  node src/cli.ts checkpoints <project-dir>
  node src/cli.ts restore <project-dir> [checkpoint-id|latest] --confirm discard-later-edits

Times accept decimal seconds or exact fractions, e.g. 1001/30000.
Find reusable clips: node src/library/cli.ts search --q TEXT --kind video
Import a result with one command: node src/cli.ts library-import <project-dir> <result.items[].id>
Asset IDs import the whole source; range IDs import the saved source selection into the project bin.
The response includes result.media.id for subsequent timeline edits. Import preserves library provenance.
source-inspect returns source monitor data, annotations, source PTS, sample rate and selectionContext.
source-insert adds the saved selection on a new track, or --track ID without overwriting overlaps.
For temporary In/Out, pass --selection with selectionContext.revision/sourceId and integer
startSample/endSample for audio or startFrame/endFrame for prepared video. End is exclusive.
Exact boundaries remain in media provenance. Placement and cuts fit the project frame grid.
Agent passes can supply --preconditions FILE containing inspect.result.revisions and --fps from that inspection.
Without explicit preconditions, source-insert reads project revisions immediately before insertion.
Graphics import copies a folder containing index.html into project assets.
Batch: {preconditions:{"clip:ID":1,"track:ID":1,"occupancy:ID":1,"media:ID":1},
 operations:[{op:"put",collection:"clips",value:{id:"ID",volume:0.5}}]}.
Clip volumePoints accepts [{time:{num,den},value:0.25}] in absolute source seconds.
Points use Ease In/Out between gains and multiply clip volume and fades. One point gets implicit
gain-1 anchors at clip edges; two or more hold endpoint values outside their span.
Use [] to clear automation. Inspect returns revision keys. New IDs and missing relationship keys have revision 0.
Put updates supplied fields. Remove uses {op:"remove",collection:"clips",id:"ID"}.
Ripple delete removes [start,end) across all tracks in one undoable edit.
Its apply equivalent is {op:"ripple-delete",start:{num,den},end:{num,den}}
as the only operation, with preconditions.project set to the inspected revision.
Project changes use {op:"project",value:{name?,fps?,resolution?}} and project revision.
The engine keeps session undo for five idle minutes; close ends that session.
Export verification defaults to quick container/timestamp checks. --verify full also decodes every output frame.
Render progress is available through status and /v1/events. --wait exits nonzero on failure.
`;
async function markerCommand(ep:any,command:string,id:string|undefined,options:Record<string,string|boolean>){
 const state=await request(ep,'/inspect'),markers=[...(state.project.markers||[])].sort((a:any,b:any)=>cmp(a.time,b.time)||a.id.localeCompare(b.id));
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
async function main(){const args=process.argv.slice(2);const command=args.shift();if(!command||['help','--help','-h'].includes(command)){console.log(HELP);return;}const dirArg=args.shift();assert(dirArg,'Project directory required');const dir=path.resolve(dirArg),positionals:string[]=[],options:Record<string,string|boolean>={};for(let i=0;i<args.length;i++){if(args[i].startsWith('--')){const key=args[i].slice(2);if(key==='wait')options[key]=true;else{assert(args[i+1]!==undefined&&(!args[i+1].startsWith('--')||key==='text'),`Missing --${key} value`);options[key]=args[++i];}}else positionals.push(args[i]);}let r:any;if(command==='create')r=createProject(dir,{name:options.name,width:options.width?Number(options.width):undefined,height:options.height?Number(options.height):undefined,fps:options.fps?parseTime(String(options.fps)):undefined});else{const ep=await endpoint(dir);switch(command){case 'text-fields':r=await request(ep,'/command',{command:'text-fields',clipId:positionals[0]});break;
case 'text-set':case 'text-reset':{const info=await request(ep,'/command',{command:'text-fields',clipId:positionals[0]});assert(command==='text-reset'||(options.text!==undefined)!==(options.file!==undefined),'Supply exactly one of --text or --file');r=await request(ep,'/command',{command:'text-set',clipId:positionals[0],field:positionals[1],reset:command==='text-reset',value:options.file!==undefined?fs.readFileSync(path.resolve(String(options.file)),'utf8'):options.text,revision:options.revision===undefined?info.revision:Number(options.revision),mediaRevision:options['media-revision']===undefined?info.mediaRevision:Number(options['media-revision'])});break;}
case 'detach-audio':case 'unlink':{assert(positionals[0],'Clip ID required');const revision=options.revision===undefined?(await request(ep,'/inspect')).project.revision:Number(options.revision);assert(Number.isSafeInteger(revision)&&revision>=0,'Revision must be a non-negative integer');r=await request(ep,'/command',{command:'apply',batch:{preconditions:{project:revision},operations:[{op:command,clipId:positionals[0]}]}});break;}case 'markers':case 'marker-add':case 'marker-set':case 'marker-remove':case 'marker-next':case 'marker-previous':r=await markerCommand(ep,command,positionals[0],options);break;case 'endpoint':r=ep;break;case 'inspect':r=await request(ep,'/inspect');break;case 'apply':assert(positionals[0],'Batch JSON path required');r=await request(ep,'/command',{command:'apply',batch:JSON.parse(fs.readFileSync(path.resolve(positionals[0]),'utf8'))});break;case 'ripple-delete':{assert(options.start!==undefined&&options.end!==undefined,'Ripple delete requires --start and --end');const revision=options.revision===undefined?(await request(ep,'/inspect')).project.revision:Number(options.revision);assert(Number.isSafeInteger(revision)&&revision>=0,'Revision must be a non-negative integer');r=await request(ep,'/command',{command:'apply',batch:{preconditions:{project:revision},operations:[{op:'ripple-delete',start:parseTime(String(options.start)),end:parseTime(String(options.end))}]}});break;}case 'import':assert(positionals[0],'Source path required');r=await request(ep,'/command',{command:'import',path:path.resolve(positionals[0]),kind:options.kind});break;case 'source-prepare':case 'source-jobs':case 'source-cancel':{assert(positionals[0],'Project media ID required');if(command==='source-cancel')assert(positionals[1],'Source job ID required');r=await request(ep,'/command',{command,id:positionals[0],jobId:positionals[1]});if(command==='source-prepare'&&options.wait){const ids=r.jobs.map((j:any)=>j.id);while(r.jobs.some((j:any)=>['queued','running'].includes(j.status))){await new Promise(resolve=>setTimeout(resolve,250));const jobs=await request(ep,'/command',{command:'source-jobs',id:positionals[0]});r={...r,jobs:ids.map((id:string)=>{const job=jobs.find((j:any)=>j.id===id);assert(job,'Source job disappeared',{jobId:id});return job;})};}if(r.jobs.some((j:any)=>j.status!=='completed'))process.exitCode=1;}break;}case 'source-inspect':case 'source-waveform':assert(positionals[0],'Project media ID required');r=await request(ep,'/command',{command,id:positionals[0],...Object.fromEntries(['start','duration','bins'].filter(k=>options[k]!==undefined).map(k=>[k,Number(options[k])]))});break;case 'source-insert':{assert(positionals[0]&&options.at!==undefined,'Source insertion requires media ID and --at');const inspected=await request(ep,'/inspect');const preconditions=options.preconditions?JSON.parse(fs.readFileSync(path.resolve(String(options.preconditions)),'utf8')):inspected.revisions;r=await request(ep,'/command',{command,id:positionals[0],at:parseTime(String(options.at)),trackId:options.track,selection:options.selection?JSON.parse(String(options.selection)):undefined,preconditions,fps:options.fps?parseTime(String(options.fps)):inspected.project.fps});break;}case 'library-import':assert(positionals[0],'Library asset or range ID required');r=await request(ep,'/command',{command:'library-import',id:positionals[0],selection:options.selection?JSON.parse(String(options.selection)):undefined});break;case 'checkpoint':r=await request(ep,'/command',{command,task:options.task});break;case 'restore':r=await request(ep,'/command',{command,checkpointId:positionals[0]||'latest',confirmation:options.confirm});break;case 'library-sync':case 'library-status':case 'checkpoints':case 'undo':case 'redo':case 'close':r=await request(ep,'/command',{command});break;case 'status':case 'cancel':r=await request(ep,'/command',{command,jobId:positionals[0]});break;case 'export':case 'frame':{assert(positionals[0],'Output path required');const kind=command==='frame'?'frame':'export';assert(kind!=='frame'||options.time!==undefined,'Frame requires --time');assert((options.start===undefined)===(options.end===undefined),'Range requires both --start and --end');r=await request(ep,'/command',{command:'render',kind,output:path.resolve(positionals[0]),mode:options.mode||'gpu',verification:options.verify||'quick',frameTime:kind==='frame'?parseTime(String(options.time)):undefined,range:options.start!==undefined?{start:parseTime(String(options.start)),end:parseTime(String(options.end))}:undefined});if(options.wait){while(['running','cancelling'].includes(r.status)){await new Promise(resolve=>setTimeout(resolve,500));r=await request(ep,'/command',{command:'status',jobId:r.id});}if(r.status!=='completed')process.exitCode=1;}break;}default:throw new Error(`Unknown command ${command}. Run --help.`);}}console.log(JSON.stringify({ok:true,result:r},null,2));}
main().catch((e:any)=>{console.error(JSON.stringify({ok:false,error:{code:e.code||'CLI_ERROR',message:e.message,details:e.details||{}}},null,2));process.exitCode=1;});
