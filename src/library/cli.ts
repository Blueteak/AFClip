#!/usr/bin/env node
import fs from 'node:fs';
import {formatResponse} from '../shared/cli-output.ts';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {libraryEndpoint,request} from './client.ts';
import {commandSchema,globals,schema} from './command-schema.ts';
const help=`Content Library. GUI and CLI use the same local catalog and operation contract.

  af-lib gui [--id ASSET] [--dev]
  af-lib endpoint
  af-lib import "D:\\Audio Effects" --folder FOLDER_ID --limit 25
  af-lib search [--q TEXT] [--folder ID] [--kind audio|video] [--tag ID] [--limit 60 --offset 0]
  af-lib inspect --id ID
  af-lib waveform --id ID [--start SEC --duration SEC --bins 16384]
  af-lib annotate --id ID --revision N --name NAME --notes TEXT --tags TAG_ID,TAG_ID
  af-lib folder-create --name SFX [--parent root]
  af-lib move|promote --id ID --revision N --folder ID
  af-lib tag-create --name NAME
  af-lib tag-rename|tag-delete|tag-merge --id ID --revision N [--name NAME] [--target ID --targetRevision N] [--confirm clear-assignments]
  af-lib range-save --assetId ID --revision N --name NAME --startFrame 0 --endFrame 120
  af-lib range-save --assetId ID --revision N --name NAME --startSample 0 --endSample 48000
  af-lib prepare [--ids ID,ID | --folder ID] [--level index|preview] [--wait]
  af-lib source-folder-save --path PATH --folder ID [--watched --hierarchy]
  af-lib source-folders
  af-lib rescan [--id SOURCE_FOLDER_ID | PATH] [--hierarchy] [--wait]
  af-lib artifact --id ID --type frame|contact-sheet|excerpt [--time SEC --start SEC --end SEC] [--wait]
  af-lib jobs|history|overview|references|cache|cache-clear|checkpoints
  af-lib cancel --id JOB
  af-lib undo|redo
  af-lib checkpoint --name NAME
  af-lib call request.json

Every /v1 operation is available as a CLI command with --field value options,
or call <file.json|-> for exact structured input, including atomic apply batches.
Use --catalog PATH to select a catalog; default is %LOCALAPPDATA%/AFClip/Library.
Author defaults to agent; --author human is supported. Outputs are structured JSON.
Mutations of existing items require their current revision from inspect/overview.
Ranges use exclusive end frames/samples. No command deletes original media.
Search result.items[].id is the stable direct-access asset or range ID. Pass it directly to AFClip:
  af-clip library-import <project-dir> <id>
This adds the source or selected range to the project bin and returns result.media.id.
Follow nextOffset until complete when searching across multiple pages.
Search and overview default to compact results; --full restores complete metadata.
Search --folder inbox selects only Inbox; --include-inbox includes it with the library.
waveform --summary returns timing/level summaries without sample arrays.
Use help COMMAND or COMMAND --help for fields; schema [COMMAND] returns JSON discovery.
--fields id,name,revision projects search items or overview fields.
--full includes default-valued fields; --pretty indents JSON.
--wait returns the final result; --progress emits changes on stderr. --timeout SECONDS defaults to 300.
`;
async function main(){
  const args=process.argv.slice(2),command=args.shift();
  if(!command||['--help','-h'].includes(command)){console.log(help);return;}
  if(command==='schema'||command==='help'||args.includes('--help')||args.includes('-h')){
    const target=['schema','help'].includes(command)?args[0]:command;
    console.log(command==='help'&&!target?help:formatResponse({ok:true,result:schema(target)}));return;
  }
  const definition=commandSchema[command];if(!definition)throw new Error(`Unknown command: ${command}. Use schema to list commands.`);
  const c:any={command},positionals:string[]=[];let catalog:string|undefined,wait=false,timeout=300,full=false,pretty=false,progress=false;
  const allowed={...globals,...definition.fields};
  for(let i=0;i<args.length;i++){
    if(!args[i].startsWith('--')){positionals.push(args[i]);continue;}
    const key=args[i].slice(2),type=allowed[key];
    if(!type)throw new Error(key==='inbox'?'Use --folder inbox for Inbox only, or --include-inbox to include it with the library.':`Unknown --${key} for ${command}. Use ${command} --help.`);
    let value:any;
    if(type==='boolean'){value=args[i+1]!=='false';if(['true','false'].includes(args[i+1]))i++;}
    else {value=args[++i];if(value===undefined||value.startsWith('--'))throw new Error(`Missing --${key} value`);
      if(type==='number'){value=Number(value);if(!Number.isFinite(value))throw new Error(`--${key} requires a finite number`);}
      else if(type==='list')value=value.split(',').filter(Boolean);
      else if(type==='json')value=JSON.parse(value);
      else if(type.includes('|')&&!type.split('|').includes(value))throw new Error(`--${key} must be ${type}`);
    }
    if(key==='catalog')catalog=value;else if(key==='wait')wait=value;else if(key==='timeout')timeout=value;else if(key==='full')full=value;else if(key==='pretty')pretty=value;else if(key==='progress')progress=value;else c[key==='include-inbox'?'inbox':key]=value;
  }
  if(timeout<=0)throw new Error('--timeout must be positive seconds');
  if(positionals.length>(['import','register','rescan','call'].includes(command)?1:0))throw new Error(`Unexpected positional argument for ${command}`);
  if(['import','register','rescan'].includes(command)&&positionals[0])c.path=path.resolve(positionals[0]);
  let payload=c;
  if(command==='call'){
    if(!positionals[0])throw new Error('call requires a JSON file or - for stdin');
    payload=JSON.parse(fs.readFileSync(positionals[0]==='-'?0:positionals[0],'utf8'));if(c.author)payload.author=c.author;
  }
  if(['search','overview'].includes(command)){c.compact=!full;}
  const fields=c.fields;delete c.fields;
  const ep=await libraryEndpoint(catalog);let result:any;
  if(command==='endpoint')result=ep;
  else if(command==='gui'){
    const child=spawn(process.execPath,[fileURLToPath(new URL('./launch.cjs',import.meta.url)),'--catalog',ep.catalogDir,...(c.dev?['--dev']:[]),ep.gui+(c.id?'&asset='+encodeURIComponent(c.id):'')],{detached:true,windowsHide:true,stdio:'ignore'});child.unref();result={opened:true,dev:!!c.dev,url:ep.gui};
  }else result=await request(ep,'/command',payload);
  let status='complete',error:any;
  if(result.jobs?.length){
    const ids=result.jobs.map((j:any)=>j.id),deadline=Date.now()+timeout*1000;let last='',pollMs=25;
    for(;;){
      const selected=await request(ep,'/command',{command:'jobs',ids});result={...result,jobs:selected};
      const failed=selected.filter((j:any)=>['failed','cancelled'].includes(j.status));
      const pending=selected.some((j:any)=>['queued','running'].includes(j.status));
      status=pending?'accepted':'complete';
      if(wait&&progress){const progress=selected.map((j:any)=>({id:j.id,status:j.status,phase:j.phase,queuePosition:j.queuePosition,elapsedMs:j.elapsedMs,runningMs:j.runningMs}));
        const signature=JSON.stringify(progress.map(({elapsedMs,runningMs,...j}:any)=>j));
        if(signature!==last){console.error(JSON.stringify({progress}));last=signature;}}
      if(failed.length){status='failed';error={code:'JOB_FAILED',message:'Background work failed or was cancelled',details:{jobs:failed}};break;}
      if(!pending||!wait)break;
      if(Date.now()>=deadline){status='accepted';error={code:'WAIT_TIMEOUT',message:'Wait timed out; jobs remain active. Inspect jobs or cancel explicitly.',details:{ids}};break;}
      // Cached index jobs can finish in 1 ms; don't add half a second to them.
      // Keep completion detection within 100 ms, even for longer jobs.
      await new Promise(r=>setTimeout(r,Math.min(pollMs,Math.max(1,deadline-Date.now()))));
      pollMs=Math.min(100,pollMs*2);
    }
    const artifactJob=result.jobs.find((j:any)=>j.kind==='artifact'&&j.status==='completed');
    if(result.artifact&&artifactJob?.result)result.artifact={...result.artifact,...artifactJob.result};
  }
  if(fields){const project=(o:any)=>Object.fromEntries(fields.map((key:string)=>{if(!(key in o))throw new Error(`Unknown result field: ${key}`);return [key,o[key]];}));result=command==='search'?{...result,items:result.items.map(project)}:project(result);}
  if(error)process.exitCode=1;
  console.log(formatResponse({ok:!error,status,result,...(error?{error}:{})},{full:full||!!fields||command==='call',pretty}));
}
main().catch(e=>{console.log(formatResponse({ok:false,error:{code:e.code||'CLI',message:e.message,...(e.details?{details:e.details}:{})}}));process.exitCode=1;});
