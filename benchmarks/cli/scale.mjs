// Scale metadata without duplicating source media. Run after commands.mjs.
// node benchmarks/cli/scale.mjs <completed-command-run> <new-output-directory>
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {Catalog} from '../../src/library/store.ts';
const [fixtureArg,outputArg]=process.argv.slice(2);
if(!fixtureArg||!outputArg)throw Error('Supply a command run and a new output directory');
const fixture=path.resolve(fixtureArg),output=path.resolve(outputArg);fs.mkdirSync(output);
const catalog=path.join(output,'library'),project=path.join(output,'project');
const original=new Catalog(path.join(fixture,'library')),db=new Catalog(catalog);
const a=original.all('asset').find(a=>!a.deleted&&!a.purged&&a.kind==='video'),s=original.get(a.sourceId);original.db.close();
db.put('source',s);
const start=performance.now();
db.transaction('Seed 10000 metadata records','agent',()=>{for(let n=0;n<10000;n++)db.put('asset',{...a,id:'asset_bench_'+n,name:`shot ${String(n).padStart(5,'0')} ${n%2?'combat':'dialogue'}`,tags:[],notes:'Benchmark metadata',sourceId:s.id});},false);
const seedMs=performance.now()-start;db.db.close();
const p=JSON.parse(fs.readFileSync(path.join(fixture,'project/project.json'))),video=p.media.find(m=>m.kind==='video');delete video.metadata.library;
p.media=[video];p.tracks=[{id:'track',revision:0,name:'Footage',disabled:false,locked:false}];p.folders=[];p.transitions=[];p.markers=[];p.relationshipRevisions={};p.clips=Array.from({length:1000},(_,i)=>({id:'clip'+i,revision:0,trackId:'track',mediaId:video.id,start:{num:i*4,den:1},duration:{num:4,den:1},sourceIn:{num:0,den:1},fadeIn:{num:0,den:1},fadeOut:{num:0,den:1},speed:{num:1,den:1},volume:1,mute:false,transform:{}}));
fs.mkdirSync(project);fs.writeFileSync(path.join(project,'project.json'),JSON.stringify(p));
const samples=[];
function run(tool,args,label){const began=performance.now(),child=spawnSync(process.execPath,[tool==='af-lib'?'src/library/cli.ts':'src/cli.ts',...args,...(tool==='af-lib'?['--catalog',catalog]:[])],{windowsHide:true,encoding:'utf8',maxBuffer:32*1024**2,env:{...process.env,AFCLIP_LIBRARY_HOME:catalog}});assert.equal(child.status,0,child.stdout+child.stderr);const result=JSON.parse(child.stdout).result;samples.push({tool,label,ms:performance.now()-began,bytes:Buffer.byteLength(child.stdout),serviceMs:result.elapsedMs});console.log(tool,label,Math.round(samples.at(-1).ms));return result;}
try{
  run('af-lib',['endpoint'],'cold endpoint');run('af-clip',['endpoint',project],'cold endpoint');
  for(let n=0;n<3;n++){
    run('af-lib',['search','--q','combat','--limit','60'],'FTS 10000 assets');
    run('af-lib',['search','--limit','200','--offset','9800'],'last page 10000 assets');
    run('af-lib',['overview'],'overview 10000 assets');
    run('af-clip',['inspect',project],'inspect 1000 clips');
    run('af-clip',['marker-add',project,'--id','marker'+n,'--time','2','--name','Beat'],'edit 1000 clips');
    run('af-clip',['undo',project],'undo 1000 clips');
  }
  run('af-lib',['checkpoint','--name','scale'],'checkpoint 10000 assets');
}finally{try{run('af-clip',['close',project],'close');}finally{run('af-lib',['close'],'close');}fs.writeFileSync(path.join(output,'results.json'),JSON.stringify({seedMs,assets:10000,clips:1000,note:'Catalog records share one verified source; measures metadata scale, not filesystem discovery or source hashing.',samples},null,2));}
