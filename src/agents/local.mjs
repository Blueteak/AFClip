import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';

export const root = process.env.AFCLIP_AGENT_HOME || path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), '.local', 'share'), 'AFClip', 'agents');
export const cliPath = fileURLToPath(new URL('../cli.ts', import.meta.url));
export function location(project) {
  const canonical = fs.realpathSync(project);
  const key = createHash('sha256').update(process.platform === 'win32' ? canonical.toLowerCase() : canonical).digest('hex').slice(0, 24);
  return {project:canonical, dir:path.join(root, 'projects', key)};
}
export function readJSON(file, fallback) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { if(e.code === 'ENOENT') return fallback; throw e; } }
export function writeJSON(file, value) {
  fs.mkdirSync(path.dirname(file), {recursive:true});
  const temp = file + '.' + randomUUID() + '.tmp';
  fs.writeFileSync(temp, JSON.stringify(value), {mode:0o600});
  fs.renameSync(temp, file);
}
export const defaultAccess = provider => provider === 'claude' ? 'bypassPermissions' : 'full';
export function settings() {
  const saved = readJSON(path.join(root, 'settings.json'), {lastProvider:'codex'});
  return {...saved, providers:Object.fromEntries(['codex','claude'].map(id => {
    const config = saved.providers?.[id] || {};
    return [id, {delivery:'steer', ...config, access:config.access || defaultAccess(id)}];
  }))};
}
export async function callEndpoint(ep, action, payload = {}) {
  const url = new URL(ep.url);
  if(url.hostname !== '127.0.0.1' || url.protocol !== 'http:') throw new Error('Invalid local agent endpoint');
  const response = await fetch(ep.url + '/request', {method:'POST', headers:{Authorization:`Bearer ${ep.token}`, 'Content-Type':'application/json'}, body:JSON.stringify({action,payload}), signal:AbortSignal.timeout(action === 'providers' ? 60000 : 30000)});
  const body = await response.json();
  if(!body.ok) throw new Error(body.error);
  return body.result;
}
const starting = new Map();
export async function agentEndpoint(project) {
  const loc = location(project);
  if(starting.has(loc.dir)) return starting.get(loc.dir);
  const start = (async () => {
    const file = path.join(loc.dir, 'endpoint.json');
    async function existing() { try { const ep = readJSON(file, null); if(ep) { await callEndpoint(ep, 'health'); return ep; } } catch {} return null; }
    const ready = await existing(); if(ready) return ready;
    fs.mkdirSync(loc.dir, {recursive:true});
    const log = fs.openSync(path.join(loc.dir, 'controller.log'), 'a');
    const child = spawn(process.env.AFCLIP_NODE_PATH || (process.versions.electron ? 'node' : process.execPath), [fileURLToPath(new URL('./server.mjs', import.meta.url)), loc.project], {detached:true, windowsHide:true, stdio:['ignore',log,log], env:{...process.env, ELECTRON_RUN_AS_NODE:undefined}});
    child.unref(); fs.closeSync(log);
    let error; child.on('error', e => { error = e; });
    for(let i=0;i<150;i++) { if(error) throw error; await new Promise(r=>setTimeout(r,100)); const ep=await existing(); if(ep) return ep; }
    throw new Error('Agent controller did not start. See ' + path.join(loc.dir,'controller.log'));
  })();
  starting.set(loc.dir,start);
  try { return await start; } finally { starting.delete(loc.dir); }
}
export async function agents(project, action, payload) { return callEndpoint(await agentEndpoint(project), action, payload); }
