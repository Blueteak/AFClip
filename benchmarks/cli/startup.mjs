// Check failed startup latency and simultaneous clients sharing one service.
// node benchmarks/cli/startup.mjs <new-output-directory>
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import assert from 'node:assert/strict';
import {createProject} from '../../src/engine/state.ts';
const output=path.resolve(process.argv[2]);fs.mkdirSync(output);
const project=path.join(output,'project'),library=path.join(output,'library'),badProject=path.join(output,'bad-project'),badLibrary=path.join(output,'bad-library');
createProject(project);fs.mkdirSync(badProject);fs.writeFileSync(path.join(badProject,'project.json'),'{}');fs.mkdirSync(badLibrary);fs.writeFileSync(path.join(badLibrary,'catalog.sqlite'),'not sqlite');
const results=[];
async function run(label,args){
  const start=performance.now(),p=spawn(process.execPath,args,{windowsHide:true,env:{...process.env,AFCLIP_LIBRARY_HOME:library},stdio:['ignore','pipe','pipe']});let out='',err='';p.stdout.on('data',b=>out+=b);p.stderr.on('data',b=>err+=b);
  const exit=await new Promise((resolve,reject)=>{p.on('error',reject);p.on('close',resolve);});
  const response=JSON.parse(out||err),sample={label,ms:performance.now()-start,exit};results.push(sample);console.log(sample);return {...sample,response};
}
try{
  for(const [label,args] of [['invalid project',['src/cli.ts','endpoint',badProject]],['invalid catalog',['src/library/cli.ts','endpoint','--catalog',badLibrary]]]){const r=await run(label,args);assert.notEqual(r.exit,0);assert.ok(r.ms<2000,JSON.stringify(r));}
  for(const [label,args] of [['project race',['src/cli.ts','endpoint',project]],['library race',['src/library/cli.ts','endpoint','--catalog',library]]]){const rs=await Promise.all([run(label,args),run(label,args)]);assert.ok(rs.every(r=>r.exit===0));assert.equal(rs[0].response.result.pid,rs[1].response.result.pid);}
}finally{
  await run('close project',['src/cli.ts','close',project]);await run('close library',['src/library/cli.ts','close','--catalog',library]);
  fs.writeFileSync(path.join(output,'results.json'),JSON.stringify(results,null,2));
}
