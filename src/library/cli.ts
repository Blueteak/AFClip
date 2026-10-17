import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {libraryEndpoint,request} from './client.ts';
const help=`Content Library. GUI and CLI use the same local catalog and operation contract.

  npm run library -- gui [--id ASSET] [--dev]
  npm run library -- endpoint
  npm run library -- import "D:\\Audio Effects" --folder FOLDER_ID --limit 25
  npm run library -- search [--q TEXT] [--folder ID] [--kind audio|video] [--tag ID] [--limit 60 --offset 0]
  npm run library -- inspect --id ID
  npm run library -- annotate --id ID --revision N --name NAME --notes TEXT --tags TAG_ID,TAG_ID
  npm run library -- folder-create --name SFX [--parent root]
  npm run library -- move|promote --id ID --revision N --folder ID
  npm run library -- tag-create --name NAME
  npm run library -- tag-rename|tag-delete|tag-merge --id ID --revision N [--name NAME] [--target ID --targetRevision N] [--confirm clear-assignments]
  npm run library -- range-save --assetId ID --revision N --name NAME --startFrame 0 --endFrame 120
  npm run library -- range-save --assetId ID --revision N --name NAME --startSample 0 --endSample 48000
  npm run library -- prepare [--ids ID,ID | --folder ID] [--wait]
  npm run library -- source-folder-save --path PATH --folder ID [--watched --hierarchy]
  npm run library -- source-folders
  npm run library -- rescan [--id SOURCE_FOLDER_ID | PATH] [--hierarchy] [--wait]
  npm run library -- artifact --id ID --type frame|contact-sheet|excerpt [--time SEC --start SEC --end SEC] [--wait]
  npm run library -- jobs|history|overview|references|cache|cache-clear|checkpoints
  npm run library -- cancel --id JOB
  npm run library -- undo|redo
  npm run library -- checkpoint --name NAME
  npm run library -- call request.json

Every /v1 operation is available as a CLI command with --field value options,
or call <file.json|-> for exact structured input, including atomic apply batches.
Use --catalog PATH to select a catalog; default is %LOCALAPPDATA%/Reelet/Library.
Author defaults to agent; --author human is supported. Outputs are structured JSON.
Mutations of existing items require their current revision from inspect/overview.
Ranges use exclusive end frames/samples. No command deletes original media.
`;
async function main(){const args=process.argv.slice(2),command=args.shift();if(!command||['help','--help','-h'].includes(command)){console.log(help);return;}
  const c:any={command},positionals:string[]=[];let catalog:string|undefined,wait=false;
  const numbers=new Set(['revision','targetRevision','limit','offset','bytes','startFrame','endFrame','startSample','endSample','minDuration','maxDuration','width','count','columns','frame','rangeOffset']);
  for(let i=0;i<args.length;i++){if(!args[i].startsWith('--')){positionals.push(args[i]);continue;}const key=args[i].slice(2);if(key==='wait'){wait=true;continue;}if(key==='dev'){c.dev=true;continue;}if(['deleted','assetsOnly','inbox','hierarchy','watched'].includes(key)){c[key]=args[i+1]==='false'?false:true;if(['true','false'].includes(args[i+1]))i++;continue;}const value=args[++i];if(value===undefined)throw new Error(`Missing --${key} value`);if(key==='catalog')catalog=value;else c[key]=numbers.has(key)?Number(value):['tags','ids','members'].includes(key)?value.split(',').filter(Boolean):value;}
  const ep=await libraryEndpoint(catalog);let result:any;
  if(command==='endpoint')result=ep;
  else if(command==='gui'){const child=spawn(process.execPath,[fileURLToPath(new URL('./launch.cjs',import.meta.url)),'--catalog',ep.catalogDir,...(c.dev?['--dev']:[]),ep.gui+(c.id?'&asset='+encodeURIComponent(c.id):'')],{detached:true,windowsHide:true,stdio:'ignore'});child.unref();result={opened:true,dev:!!c.dev,url:ep.gui};}
  else {if(['import','register','rescan'].includes(command)&&positionals[0])c.path=path.resolve(positionals[0]);
    const payload=command==='call'?JSON.parse(fs.readFileSync(positionals[0]==='-'?0:positionals[0],'utf8')):c;
    result=await request(ep,'/command',payload);
    if(wait&&result.jobs?.length){const ids=result.jobs.map((j:any)=>j.id);let pending=true;while(pending){const selected=await request(ep,'/command',{command:'jobs',ids});pending=selected.some((j:any)=>['queued','running'].includes(j.status));if(!pending){result={...result,jobs:selected};if(selected.some((j:any)=>['failed','cancelled'].includes(j.status)))process.exitCode=1;}else await new Promise(r=>setTimeout(r,250));}}
  }
  console.log(JSON.stringify({ok:true,result},null,2));
}
main().catch(e=>{console.error(JSON.stringify({ok:false,error:{code:e.code||'CLI',message:e.message,details:e.details||{}}},null,2));process.exitCode=1;});
