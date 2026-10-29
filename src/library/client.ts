import runtime from '../shared/runtime.cjs';
import lifecycle from '../shared/lifecycle.cjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {request} from '../engine/client.ts';
export {request};
export const catalogDir=()=>path.resolve(process.env.AFCLIP_LIBRARY_HOME||path.join(process.env.LOCALAPPDATA||path.join(os.homedir(),'.local','share'),'AFClip','Library'));
export async function libraryEndpoint(dir=catalogDir()) {
  lifecycle.assertAvailable();
  dir=path.resolve(dir);fs.mkdirSync(dir,{recursive:true});const file=path.join(dir,'endpoint.json');
  const existing=async()=>{try{const ep=JSON.parse(fs.readFileSync(file,'utf8'));runtime.compatible((await request(ep,'/health')).release);return ep;}catch(e){if(e?.code==='RELEASE_MISMATCH')throw e;return null;}};
  const ep=await existing();if(ep)return ep;
  const log=fs.openSync(path.join(dir,'service.log'),'a');
  const child=spawn(runtime.node,[fileURLToPath(new URL('./server.ts',import.meta.url)),dir],{detached:true,windowsHide:true,stdio:['ignore',log,log]});child.unref();fs.closeSync(log);let error:any;child.on('error',e=>error=e);child.once('exit',(code,signal)=>{if(code!==0)error=new Error(`Library service exited before becoming ready (${code??signal}). See ${path.join(dir,'service.log')}`);});
  for(let i=0;i<150;i++){if(error)throw error;await new Promise(r=>setTimeout(r,100));const ready=await existing();if(ready)return ready;}
  throw new Error(`Library service did not start. See ${path.join(dir,'service.log')}`);
}
export async function libraryCommand(command:any) {return request(await libraryEndpoint(),'/command',command);}
