// Every installed long-lived process and CLI participates in the update barrier.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const {randomBytes, createHash} = require('node:crypto');
const runtime = require('./runtime.cjs');
const directory = path.join(runtime.dataRoot, 'installations', createHash('sha256').update(runtime.root).digest('hex').slice(0, 20));
const lockFile = path.join(directory, 'updating.json');
function alive(pid) { if(!Number.isSafeInteger(pid)||pid<=0)return false; try { process.kill(pid, 0); return true; } catch (e) { return e.code !== 'ESRCH'; } }
function read(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } }
function assertAvailable() {
  if (!runtime.packaged) return;
  const lock = read(lockFile);
  if (lock && alive(lock.pid)) throw Object.assign(new Error('AFClip is installing an update. Retry after it reopens.'), {code: 'UPDATING'});
  if (lock) fs.rmSync(lockFile, {force:true});
}
let registered;
function register(role, {busy = () => false, close = () => process.exit(0), workspace = () => null} = {}) {
  if (!runtime.packaged || registered) return Promise.resolve();
  assertAvailable();
  fs.mkdirSync(directory, {recursive:true});
  const token = randomBytes(32).toString('hex'), file = path.join(directory, process.pid + '.json');
  const server = http.createServer(async (req, res) => {
    if (req.headers.authorization !== 'Bearer ' + token || req.method !== 'POST') {res.writeHead(403); res.end(); return;}
    try {
      const state = {role, busy: !!(await busy()), workspace: workspace(), release:runtime.identity};
      if (req.url === '/close') {
        const lock = read(lockFile);
        if (!lock || !alive(lock.pid)) throw new Error('No update is in progress');
        if (state.busy) throw new Error(role + ' is still working');
        res.end(JSON.stringify(state)); setTimeout(close, 30); return;
      }
      if (req.url !== '/status') throw new Error('Unknown process action');
      res.end(JSON.stringify(state));
    } catch (e) {res.writeHead(409); res.end(JSON.stringify({error:e.message}));}
  });
  registered = server;
  process.on('exit', () => { try { fs.rmSync(file, {force:true}); } catch {} });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      try {
        fs.writeFileSync(file, JSON.stringify({pid:process.pid, url:'http://127.0.0.1:' + server.address().port, token, role}), {mode:0o600});
        assertAvailable(); server.unref(); resolve();
      } catch (e) {fs.rmSync(file, {force:true}); server.close(); reject(e);}
    });
  });
}
async function call(record, action) {
  const url = new URL(record.url);
  if (url.hostname !== '127.0.0.1' || url.protocol !== 'http:') throw new Error('Invalid process endpoint');
  const response = await fetch(record.url + '/' + action, {method:'POST', headers:{Authorization:'Bearer ' + record.token}, signal:AbortSignal.timeout(3000)});
  const result = await response.json(); if (!response.ok) throw new Error(result.error || 'Process is unavailable'); return result;
}
async function processes() {
  fs.mkdirSync(directory, {recursive:true});
  const records = [];
  for (const name of fs.readdirSync(directory).filter(name => /^\d+\.json$/.test(name))) {
    const file = path.join(directory,name), record = read(file);
    if (!record) continue;
    if (!alive(record.pid)) {fs.rmSync(file,{force:true}); continue;}
    // An unresponsive live process blocks replacement rather than being killed.
    records.push({...record, ...await call(record, 'status')});
  }
  return records;
}
function lock() {
  assertAvailable(); fs.mkdirSync(directory, {recursive:true});
  fs.writeFileSync(lockFile, JSON.stringify({pid:process.pid}), {flag:'wx',mode:0o600});
}
function unlock() { if (read(lockFile)?.pid === process.pid) fs.rmSync(lockFile,{force:true}); }
module.exports = {register, assertAvailable, processes, call, lock, unlock, directory, alive};
