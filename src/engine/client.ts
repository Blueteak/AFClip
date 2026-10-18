import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {EngineError,fail} from '../shared/project.ts';
export type Endpoint={url:string;token:string;pid:number;projectDir:string};
export async function request(endpoint:Endpoint,route:string,body?:any){const response=await fetch(endpoint.url+route,{method:body?'POST':'GET',headers:{Authorization:`Bearer ${endpoint.token}`,...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(30000)});const result=await response.json() as any;if(!result.ok)throw new EngineError(result.error.code,result.error.message,result.error.details);return result.result;}
export async function endpoint(projectDir:string):Promise<Endpoint>{projectDir=fs.realpathSync(projectDir);const stateDir=path.join(projectDir,'.afclip');fs.mkdirSync(stateDir,{recursive:true});const endpointPath=path.join(stateDir,'endpoint.json');async function existing(){try{const ep=JSON.parse(fs.readFileSync(endpointPath,'utf8'));await request(ep,'/health');return ep;}catch{return null;}}const ready=await existing();if(ready)return ready;
 const log=fs.openSync(path.join(stateDir,'engine.log'),'a');const child=spawn(process.execPath,[fileURLToPath(new URL('./server.ts',import.meta.url)),projectDir],{cwd:path.resolve(fileURLToPath(new URL('../../',import.meta.url))),detached:true,windowsHide:true,stdio:['ignore',log,log],env:{...process.env}});child.unref();fs.closeSync(log);let startError:Error|undefined;child.on('error',e=>{startError=e;});for(let i=0;i<150;i++){if(startError)throw startError;await new Promise(r=>setTimeout(r,100));const ep=await existing();if(ep)return ep;}fail('ENGINE_START','Project engine did not become ready',{log:path.join(stateDir,'engine.log')});
}
