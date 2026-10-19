// Repeated AI editing tasks on a disposable copy of the scale fixture.
// node benchmarks/cli/edit-loop.mjs <scale-run-directory> <new-output-directory>
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {request} from '../../src/engine/client.ts';
const [fixture,output]=process.argv.slice(2);
if(!fixture||!output)throw Error('Supply scale fixture and new output directory');
fs.mkdirSync(output);
const project=path.resolve(output,'project'),catalog=path.resolve(output,'library');
fs.mkdirSync(project);fs.mkdirSync(catalog);
fs.copyFileSync(path.join(fixture,'project/project.json'),path.join(project,'project.json'));
fs.copyFileSync(path.join(fixture,'library/catalog.sqlite'),path.join(catalog,'catalog.sqlite'));
const env={...process.env,AFCLIP_LIBRARY_HOME:catalog},samples=[];
function cli(tool,args,label){
 const start=performance.now(),p=spawnSync(process.execPath,[tool==='af-clip'?'src/cli.ts':'src/library/cli.ts',...args,...(tool==='af-lib'?['--catalog',catalog]:[])],{env,windowsHide:true,encoding:'utf8',maxBuffer:32*1024**2,timeout:120000});
 assert.equal(p.status,0,p.stdout+p.stderr);const result=JSON.parse(p.stdout).result;
 samples.push({tool,label,ms:performance.now()-start,bytes:Buffer.byteLength(p.stdout)});return result;
}
try{
 const ep=cli('af-clip',['endpoint',project],'startup');cli('af-lib',['endpoint'],'startup');
 const asset=cli('af-lib',['search','--q','combat','--limit','1'],'setup search').items[0].id;
 for(let n=0;n<10;n++){
  const state=cli('af-clip',['inspect',project,'--id','clip0'],'inspect clip');
  const batch=path.resolve(output,'batch.json');
  fs.writeFileSync(batch,JSON.stringify({preconditions:state.revisions,operations:[{op:'put',collection:'clips',value:{id:'clip0',volume:0.5+n/100}}]}));
  const edit=cli('af-clip',['apply',project,batch],'apply clip edit');assert.equal(edit.revision,state.project.revision+1);
  cli('af-clip',['inspect',project,'--since',String(edit.revision)],'inspect unchanged');
  cli('af-clip',['marker-add',project,'--id',`beat${n}`,'--time',String(n),'--name','Beat'],'add marker');
  cli('af-lib',['search','--q','combat','--limit','20'],'library search');
  cli('af-lib',['inspect','--id',asset],'library inspect');
  const start=performance.now();await request(ep,'/command',{command:'inspect',id:'clip0'});
  samples.push({tool:'HTTP',label:'inspect clip',ms:performance.now()-start});
 }
 // Independent edits belonging to one user intent can share an atomic batch.
 const batchFile=path.resolve(output,'batch.json');
 let pre=cli('af-clip',['inspect',project,'--full'],'batch setup').revisions;
 let began=performance.now();
 for(let n=10;n<30;n++){
  fs.writeFileSync(batchFile,JSON.stringify({preconditions:pre,operations:[{op:'put',collection:'clips',value:{id:`clip${n}`,volume:0.5}}]}));
  const edit=cli('af-clip',['apply',project,batchFile],'individual volume edit');Object.assign(pre,edit.revisions);
 }
 samples.push({tool:'workflow',label:'20 individual edits',ms:performance.now()-began});
 fs.writeFileSync(batchFile,JSON.stringify({preconditions:pre,operations:Array.from({length:20},(_,n)=>({op:'put',collection:'clips',value:{id:`clip${n+10}`,volume:0.6}}))}));
 began=performance.now();const edit=cli('af-clip',['apply',project,batchFile],'20 edits in one batch');
 samples.push({tool:'workflow',label:'20 batched edits',ms:performance.now()-began});
 // Replaying stale input must fail once without changing the project.
 const stale=spawnSync(process.execPath,['src/cli.ts','apply',project,batchFile],{env,windowsHide:true,encoding:'utf8'});
 assert.equal(stale.status,1);assert.equal(JSON.parse(stale.stdout||stale.stderr).error.code,'CONFLICT');
 const current=cli('af-clip',['inspect',project,'--id','clip10'],'verify conflict');assert.equal(current.project.revision,edit.revision);
}finally{
 cli('af-clip',['close',project],'close');cli('af-lib',['close'],'close');
 fs.writeFileSync(path.join(output,'results.json'),JSON.stringify({note:'1000 clips, 10000 catalog records; serial warm commands; 10 repetitions. Startup excluded from editing comparisons.',samples},null,2));
}
for(const label of [...new Set(samples.map(s=>s.tool+' '+s.label))]){const a=samples.filter(s=>s.tool+' '+s.label===label).map(s=>s.ms).sort((a,b)=>a-b);console.log(label,Math.round(a[Math.floor(a.length/2)]));}
