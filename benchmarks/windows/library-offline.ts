// A stalled catalog must not hold the project command queue or lose reference intent.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {createProject,ProjectState,atomicJSON} from '../../src/engine/state.ts';
import {inspectMedia} from '../../src/engine/probe.ts';
import {insertSource} from '../../src/engine/source.ts';
import {endpoint,request} from '../../src/engine/client.ts';

const require=createRequire(import.meta.url),dir=path.resolve('.temp/library-offline',String(Date.now()));
const project=path.join(dir,'project'),catalog=path.join(dir,'catalog');
fs.mkdirSync(catalog,{recursive:true});process.env.AFCLIP_LIBRARY_HOME=catalog;
const original=path.join(dir,'original.wav');
execFileSync(require('ffmpeg-static'),['-v','error','-f','lavfi','-i','sine=frequency=440:duration=1','-y',original]);
createProject(project,{width:320,height:180,fps:{num:24,den:1}});
const state=new ProjectState(project),media=await inspectMedia(original);
media.metadata.library={libraryId:'offline-catalog',assetId:'asset_offline',sourceId:'source_offline'};
state.p.media.push(media);state.save(state.p,false);
await insertSource(state,{id:media.id,at:{num:0,den:1},fps:state.p.fps,preconditions:state.inspect().revisions});
let stalled=true;const received:any[]=[],held:http.ServerResponse[]=[];
const reply=(res:http.ServerResponse)=>res.end(JSON.stringify({ok:true,result:{}}));
const server=http.createServer(async(req,res)=>{
  if(req.url==='/v1/health'){reply(res);return;}
  let raw='';for await(const chunk of req)raw+=chunk;
  received.push(JSON.parse(raw));if(stalled)held.push(res);else reply(res);
});
await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
atomicJSON(path.join(catalog,'endpoint.json'),{url:`http://127.0.0.1:${(server.address() as any).port}/v1`,readerGui:'http://localhost/?token=scratch-reader',token:'scratch',pid:process.pid});
let ep:any;
const waitFor=async(fn:()=>any)=>{for(let i=0;i<200;i++){if(await fn())return;await new Promise(r=>setTimeout(r,100));}throw Error('Timed out');};
try{
  ep=await endpoint(project);const cmd=(c:any)=>request(ep,'/command',c);
  await waitFor(()=>received.length);
  const sourceRead=cmd({command:'source-inspect',id:media.id}).catch(()=>null);
  await waitFor(()=>received.some(c=>c.command==='inspect'));
  const inspected=await request(ep,'/inspect'),started=performance.now();
  await cmd({command:'apply',batch:{preconditions:inspected.revisions,operations:[{op:'project',value:{name:'Edited offline'}}]}});
  const editMs=performance.now()-started;assert(editMs<2000);
  assert.equal((await cmd({command:'library-status'})).pending,true);
  const job=await cmd({command:'render',mode:'software',output:path.join(dir,'offline.mp4')});
  let rendered:any;await waitFor(async()=>{rendered=await cmd({command:'status',jobId:job.id});return !['running','cancelling'].includes(rendered.status);});
  assert.equal(rendered.status,'completed',JSON.stringify(rendered));
  // Kill only the engine created by this check, leaving its durable outbox behind.
  process.kill(ep.pid);await new Promise(r=>setTimeout(r,300));
  await sourceRead;
  assert(fs.existsSync(path.join(project,'.afclip','library-outbox.json')));
  stalled=false;for(const res of held)reply(res);
  ep=await endpoint(project);
  await waitFor(()=>!fs.existsSync(path.join(project,'.afclip','library-outbox.json')));
  assert.deepEqual(received.at(-1).assetIds,['asset_offline']);
  assert.equal((await request(ep,'/inspect')).project.name,'Edited offline');
  const result={editMs,export:rendered.status,recovered:true,dir};
  atomicJSON(path.join(dir,'result.json'),result);console.log(JSON.stringify(result));
}finally{
  if(ep)try{await request(ep,'/command',{command:'close'});}catch{}
  server.closeAllConnections();server.close();
}

