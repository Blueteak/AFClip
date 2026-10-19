import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import http from 'node:http';
import {EngineError,fail} from '../shared/project.ts';
export type Endpoint={url:string;token:string;pid:number;projectDir:string};
// The local services use plain HTTP. Avoid initializing fetch/Undici for every
// short-lived CLI invocation; preserve the deadline and never retry mutations.
export function request(endpoint:Endpoint,route:string,body?:any):Promise<any>{
 return new Promise((resolve,reject)=>{
  const data=body?JSON.stringify(body):undefined;
  const req=http.request(endpoint.url+route,{method:body?'POST':'GET',headers:{Authorization:`Bearer ${endpoint.token}`,...(data?{'Content-Type':'application/json','Content-Length':Buffer.byteLength(data)}:{})},signal:body?.command==='collect'?undefined:AbortSignal.timeout(30000)},res=>{
   res.setEncoding('utf8');let text='';
   res.on('data',chunk=>{text+=chunk;});res.on('error',reject);
   res.on('end',()=>{try{const result=JSON.parse(text);if(!result.ok)throw new EngineError(result.error.code,result.error.message,result.error.details);resolve(result.result);}catch(e){reject(e);}});
  });
  req.on('error',reject);req.end(data);
 });
}
export async function endpoint(projectDir:string):Promise<Endpoint>{projectDir=fs.realpathSync(projectDir);const stateDir=path.join(projectDir,'.afclip');fs.mkdirSync(stateDir,{recursive:true});const endpointPath=path.join(stateDir,'endpoint.json');async function existing(){try{const ep=JSON.parse(fs.readFileSync(endpointPath,'utf8'));await request(ep,'/health');return ep;}catch{return null;}}const ready=await existing();if(ready)return ready;
 const log=fs.openSync(path.join(stateDir,'engine.log'),'a');const child=spawn(process.execPath,[fileURLToPath(new URL('./server.ts',import.meta.url)),projectDir],{cwd:path.resolve(fileURLToPath(new URL('../../',import.meta.url))),detached:true,windowsHide:true,stdio:['ignore',log,log],env:{...process.env}});child.unref();fs.closeSync(log);let startError:Error|undefined;child.on('error',e=>{startError=e;});child.once('exit',(code,signal)=>{if(code!==0)startError=new EngineError('ENGINE_START',`Project engine exited before becoming ready (${code??signal})`,{log:path.join(stateDir,'engine.log')});});for(let i=0;i<150;i++){if(startError)throw startError;await new Promise(r=>setTimeout(r,100));const ep=await existing();if(ep)return ep;}fail('ENGINE_START','Project engine did not become ready',{log:path.join(stateDir,'engine.log')});
}
