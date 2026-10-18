// Opt-in cold preparation without the GUI's 120-second startup deadline.
// Keeps the production worker's caches in this disposable project for --reuse-cache.
const fs = require('node:fs');
const path = require('node:path');
const PreviewSession = require('../../src/gui/preview-session.cjs');
const dir = path.resolve(process.argv[2] || '.cache/macos/gameplay');
const output = path.resolve(process.argv[3] || '.cache/macos/preparation.json');
const start = performance.now(), events = [];
let finished = false;
const session = new PreviewSession(dir, event => {
  events.push({ ...event, nativeSetup:event.nativeSetup ? {seekCache:event.nativeSetup.seekCache} : undefined, ms:performance.now()-start });
  if (event.type === 'progress') console.log(event.message);
  if (event.type === 'ready') console.log('Preview ready in', performance.now()-start, 'ms');
  if (event.type === 'error') finish(event.error);
  if (event.seekCache?.complete || event.nativeSetup?.seekCache.complete) finish();
}, file => file, () => {});
function finish(error) {
  if (finished) return;
  finished = true; clearTimeout(timer);
  fs.mkdirSync(path.dirname(output), {recursive:true});
  fs.writeFileSync(output, JSON.stringify({ms:performance.now()-start,error,events},null,2));
  session.close();
  if (error) { console.error(error); process.exitCode = 1; }
  else console.log(output);
}
const timer = setTimeout(()=>finish({message:'Preparation exceeded ten minutes'}),600000);
session.open(JSON.parse(fs.readFileSync(path.join(dir,'project.json'),'utf8')),'gpu').catch(error=>finish({message:error.message}));
