// Capture comparable old/new output from disposable fixtures.
// node benchmarks/cli/tokens.mjs <output.json>
// Count strings with your model's tokenizer; character counts are not token counts.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {formatResponse,projectChanges} from '../../src/shared/cli-output.ts';
import {revisions} from '../../src/shared/project.ts';
const root=fileURLToPath(new URL('../../',import.meta.url));
const output=process.argv[2];
assert(output,'Supply output JSON path');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'afclip-tokens-'));
const project=path.join(dir,'project'),catalog=path.join(dir,'library'),samples=[];
function run(cli,args,input){
 const child=spawnSync(process.execPath,[path.join(root,cli==='clip'?'src/cli.ts':'src/library/cli.ts'),...args,...(cli==='lib'?['--catalog',catalog]:[])],
  {encoding:'utf8',input,env:{...process.env,AFCLIP_LIBRARY_HOME:catalog},maxBuffer:32*1024**2});
 assert.equal(child.status,0,child.stdout+child.stderr);
 return JSON.parse(child.stdout);
}
function sample(command,response,optimized=response){
 const before=JSON.stringify(response,null,2),firstPass=formatResponse(response),after=formatResponse(optimized);
 samples.push({command,before,firstPass,after,beforeChars:before.length,afterChars:after.length});
}
function edit(command,args){
 const before=run('clip',['inspect',project,'--full']).result;
 const actual=run('clip',args);
 const after=run('clip',['inspect',project,'--full']).result;
 assert.deepEqual(actual,JSON.parse(formatResponse({ok:true,result:projectChanges(before,after)})));
 sample(command,{ok:true,result:after},actual);
 return actual.result;
}
try{
 sample('af-clip create',run('clip',['create',project,'--full']));
 sample('af-clip inspect empty',run('clip',['inspect',project,'--full']));
 const added=edit('af-clip marker-add',['marker-add',project,'--time','1','--name','Cut']);
 assert.equal(added.changes.markers[0].name,'Cut');assert.equal(added.project,undefined);
 const undone=edit('af-clip undo',['undo',project]);
 assert.deepEqual(undone.removed.markers,[added.changes.markers[0].id]);
 edit('af-clip redo',['redo',project]);
 edit('af-clip marker-remove',['marker-remove',project,added.changes.markers[0].id]);
 const fullEdit=run('clip',['marker-add',project,'--time','2','--name','Full response','--full']);
 assert.equal(fullEdit.result.project.markers[0].name,'Full response');assert.equal(fullEdit.result.changes,undefined);
 const fixture=JSON.parse(fs.readFileSync(path.join(root,'examples/vellum-first-edit/project.json'),'utf8'));
 sample('af-clip inspect example edit',{ok:true,result:{project:fixture,revisions:revisions(fixture),history:{undo:0,redo:0},renderLock:null}});
 const beforeEdit={project:fixture,revisions:revisions(fixture),history:{undo:0,redo:0},renderLock:null};
 const edited=structuredClone(fixture);edited.revision++;edited.markers.push({id:'marker_benchmark',revision:1,name:'Cut',time:{num:1,den:1}});
 const afterEdit={project:edited,revisions:revisions(edited),history:{undo:1,redo:0},renderLock:null};
 sample('af-clip marker-add example edit',{ok:true,result:afterEdit},{ok:true,result:projectChanges(beforeEdit,afterEdit)});
 // One second of silent PCM, enough to exercise real library inspection and jobs.
 const wav=Buffer.alloc(44+96000);wav.write('RIFF');wav.writeUInt32LE(wav.length-8,4);wav.write('WAVEfmt ',8);
 wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(48000,24);
 wav.writeUInt32LE(96000,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(96000,40);
 const source=path.join(dir,'silence.wav');fs.writeFileSync(source,wav);
 sample('af-lib import --wait',run('lib',['import',source,'--wait','--full']));
 // call preserves API fields and lets us capture the OLD compact-search payload.
 const search=run('lib',['call','-'],JSON.stringify({command:'search',compact:true,inbox:true}));
 sample('af-lib search',search);
 const id=search.result.items[0].id;
 sample('af-lib inspect',run('lib',['inspect','--id',id,'--full']));
 sample('af-lib overview',run('lib',['call','-'],JSON.stringify({command:'overview',compact:true})));
 sample('af-lib jobs',run('lib',['jobs','--full']));
 const normal=run('lib',['search','--include-inbox']);
 assert.equal(normal.status,undefined);assert.equal(normal.result.items[0].availability,undefined);
 assert.equal(normal.result.items[0].id,id);
 const projected=run('lib',['search','--include-inbox','--fields','id,notes,availability']);
 assert.equal(projected.result.items[0].availability,'available');
 const inspected=run('clip',['inspect',project]);assert.deepEqual(inspected.result.revisions,run('clip',['inspect',project,'--full']).result.revisions);
 fs.writeFileSync(output,JSON.stringify({samples},null,2));
 console.log(`Captured ${samples.length} samples to ${output}`);
}finally{
 run('clip',['close',project]);run('lib',['close']);
 // Keep disposable fixtures for inspection; do not touch user projects/catalogs.
 console.log(`Fixtures: ${dir}`);
}
