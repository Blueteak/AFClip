import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {randomUUID,randomBytes} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {root,location,readJSON,writeJSON,settings,cliPath,defaultAccess} from './local.mjs';
import {chatContext} from './context.mjs';
import {Codex,Claude,discover} from './providers.mjs';
const exec=promisify(execFile);
const loc=location(process.argv[2]);fs.mkdirSync(loc.dir,{recursive:true});
const lockFile=path.join(loc.dir,'controller.lock');
// Atomic process ownership: simultaneous CLI/GUI launches share one controller.
try { fs.writeFileSync(lockFile,String(process.pid),{flag:'wx',mode:0o600}); }
catch(e) {
  if(e.code!=='EEXIST')throw e;
  const pid=Number(fs.readFileSync(lockFile,'utf8'));let alive=false;
  try{process.kill(pid,0);alive=true;}catch{}
  if(alive)process.exit(0);
  fs.unlinkSync(lockFile);fs.writeFileSync(lockFile,String(process.pid),{flag:'wx',mode:0o600});
}
const stateFile=path.join(loc.dir,'conversations.json');
let conversations=readJSON(stateFile,[]).filter(c=>c.status!=='settled');
let uiContext=readJSON(path.join(loc.dir,'context.json'),null);
for(const c of conversations){c.pending=[];if(['running','waiting'].includes(c.status)){c.status='interrupted';c.error='Agent controller stopped. Send a message to resume.';}}
const runtime=new Map();let lastActivity=Date.now(),saveTimer;let providerCache,providerCacheAt=0;
function persist(){clearTimeout(saveTimer);saveTimer=null;writeJSON(stateFile,conversations);}
function changed(c){if(c)c.updatedAt=new Date().toISOString();if(!saveTimer)saveTimer=setTimeout(persist,150);}
function find(id){const c=conversations.find(c=>c.id===id);if(!c)throw new Error('Conversation not found');return c;}
function publicConversation(c){const {queue,...view}=c;return view;}
function message(c,id,role,text,delta=false){let m=c.messages.find(m=>m.id===id);if(!m){m={id,role,text:''};c.messages.push(m);}m.text=delta?m.text+text:text;changed(c);}
async function cli(args){const r=await exec(process.env.AFCLIP_NODE_PATH||process.execPath,[cliPath,...args],{windowsHide:true,cwd:loc.project,maxBuffer:16*1024*1024,timeout:30000});const v=JSON.parse(r.stdout);if(!v.ok)throw new Error(v.error?.message||'CLI failed');return v.result;}
function activeSummary(except){return conversations.filter(c=>c.id!==except).map(c=>({id:c.id,provider:c.provider,status:c.status,anchor:c.anchor,request:c.messages.findLast(m=>m.role==='user')?.text?.slice(0,400)}));}
function instructions(c){return `You are working in AFClip on project ${JSON.stringify(loc.project)}. Perform project inspection and edits through the existing af-clip CLI, not direct project.json writes or a separate editing API. Invoke Node CLI with executable ${JSON.stringify(process.env.AFCLIP_NODE_PATH||process.execPath)} and script ${JSON.stringify(cliPath)}; arguments are COMMAND PROJECT_DIR. Run help COMMAND for focused help. af-lib is available through ${JSON.stringify(path.resolve(path.dirname(cliPath),'library/cli.ts'))}. Use coherent atomic apply batches and preserve revisions; on conflict reread/replan rather than overwrite. Manual edits and other agents can run concurrently. The controller creates a project checkpoint before each submitted turn; do not duplicate it. Ordinary undo is project-wide, not conversation-specific. Selection is context ONLY, never a restriction on the user's requested scope. Native provider rules, tools, permissions and project instructions still apply. Keep responses concise. Your AFClip conversation ID is ${c.id}. Read live GUI context and other discussions through: agent PROJECT_DIR context and agent PROJECT_DIR list. GUI context may be stale when the window is closed; captured context in the message remains authoritative for 'this'/'here'. Editing via CLI works while GUI is closed. Do not change AFClip agent settings or settle other conversations unless asked.`;}
function prompt(c,m){const others=activeSummary(c.id);return `<afclip-instructions>\n${chatContext(c.anchor,m.context)}\n</afclip-instructions>\n\n${m.text}\n\n<afclip-context>\n${JSON.stringify({conversationId:c.id,anchor:c.anchor,captured:m.context,otherDiscussions:others.slice(0,20),...(others.length>20?{moreDiscussions:others.length-20}:{})})}\n</afclip-context>`;}
async function keepEngine(rt){
  const ep=await cli(['endpoint',loc.project]);rt.subscription=new AbortController();
  const subscription=rt.subscription;
  const response=await fetch(ep.url+'/events',{headers:{Authorization:`Bearer ${ep.token}`},signal:subscription.signal});
  if(!response.ok)throw new Error('Could not subscribe to project engine');
  (async()=>{try{for await(const _ of response.body){}}catch(e){if(!subscription.signal.aborted)console.error('Engine subscription:',e.message);}})();
}
function releaseEngine(rt){rt.subscription?.abort();rt.subscription=null;}
function fail(c,rt,e){if(runtime.get(c.id)!==rt)return;rt.active=false;c.status='error';c.error=e.message;c.pending=[];for(const waiter of rt.requests.values())waiter.reject(e);rt.requests.clear();rt.adapter?.close();rt.adapter=null;releaseEngine(rt);changed(c);}
function requestUser(c,rt,details,signal){
  return new Promise((resolve,reject)=>{
    const id=randomUUID();c.pending.push({id,...details});c.status='waiting';changed(c);
    const cancel=()=>{rt.requests.delete(id);c.pending=c.pending.filter(p=>p.id!==id);if(!c.pending.length&&rt.active)c.status='running';changed(c);reject(new Error('Provider cancelled request'));};
    rt.requests.set(id,{resolve:value=>{signal?.removeEventListener('abort',cancel);resolve(value);},reject:error=>{signal?.removeEventListener('abort',cancel);reject(error);}});
    if(signal?.aborted)cancel();else signal?.addEventListener('abort',cancel,{once:true});
  });
}
async function ensureRuntime(c){
  let rt=runtime.get(c.id);if(rt?.adapter)return rt;
  c.settings.access ||= defaultAccess(c.provider);
  rt={active:false,requests:new Map(),serial:Promise.resolve()};runtime.set(c.id,rt);
  const valid=()=>runtime.get(c.id)===rt;
  const hooks={
    session:id=>{if(valid()&&c.sessionId!==id){c.sessionId=id;changed(c);}},
    config:value=>{if(valid()){
      c.effectiveSettings=value;
      // Freeze inherited model/effort/access as soon as the provider resolves them.
      if(!c.settings.model&&value.model)c.settings.model=value.model;
      if(!c.settings.effort&&value.effort)c.settings.effort=value.effort;
      if(c.provider==='claude'&&!c.settings.access&&value.access)c.settings.access=value.access;
      changed(c);
    }},
    message:(...args)=>{if(valid())message(c,...args);},
    ask:(details,signal)=>requestUser(c,rt,details,signal),
    error:e=>fail(c,rt,e),
    done:(error,interrupted)=>{
      if(!valid())return;rt.active=false;c.status=error?'error':interrupted?'interrupted':'idle';c.error=error||undefined;
      for(const p of rt.requests.values())p.reject(new Error('Turn ended'));rt.requests.clear();c.pending=[];changed(c);
      if(!error&&!interrupted)setTimeout(()=>pump(c,rt).catch(e=>fail(c,rt,e)),0);else releaseEngine(rt);
    }
  };
  rt.adapter=c.provider==='codex'?new Codex(c.settings,hooks):new Claude(c.settings,hooks);
  rt.ready=rt.adapter.start(c,instructions(c),loc.project);
  // Callers await this same promise; attach a handler immediately for startup failures.
  rt.ready.catch(e=>fail(c,rt,e));return rt;
}
async function deliver(c,rt,m,steer){
  await rt.ready;if(runtime.get(c.id)!==rt||!rt.adapter)throw new Error('Conversation stopped');
  if(!rt.subscription)await keepEngine(rt);
  c.checkpoint=await cli(['checkpoint',loc.project,'--task',`Agent ${c.id}: ${m.text.slice(0,200)}`]);
  m.queued=false;rt.active=true;c.status='running';c.error=undefined;changed(c);persist();
  await rt.adapter.send(prompt(c,m),m.images||[],steer);
}
async function pump(c,rt){
  if(runtime.get(c.id)!==rt||rt.active||rt.dispatching)return;
  const next=c.queue?.shift();if(!next){releaseEngine(rt);return;}
  const m=c.messages.find(m=>m.id===next);if(!m)return;
  rt.dispatching=true;c.status='running';changed(c);
  try{await deliver(c,rt,m,false);}finally{rt.dispatching=false;}
  if(!rt.active&&c.queue?.length)setTimeout(()=>pump(c,rt).catch(e=>fail(c,rt,e)),0);
}
function saveImages(id,images){
  if(!Array.isArray(images)||images.length>12)throw new Error('At most 12 images per message');
  return images.map(image=>{
    const match=/^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/=\r\n]+)$/.exec(image.dataUrl||'');
    if(!match)throw new Error('Paste a PNG, JPEG, GIF or WebP image');
    const bytes=Buffer.from(match[2],'base64');if(bytes.length>20*1024*1024)throw new Error('Image exceeds 20 MB');
    const imageId=randomUUID(),dir=path.join(loc.dir,'images',id);fs.mkdirSync(dir,{recursive:true});
    const file=path.join(dir,imageId+'.'+match[1].split('/')[1]);fs.writeFileSync(file,bytes,{mode:0o600});
    return {id:imageId,name:String(image.name||'Pasted image'),mime:match[1],path:file};
  });
}
function validateSettings(p){
  for(const id of Object.keys(p.providers||{})){
    if(!['codex','claude'].includes(id))throw new Error('Unknown provider');
    const cfg=p.providers[id];
    for(const k of Object.keys(cfg))if(!['executable','model','effort','access','delivery','serviceTier'].includes(k)||typeof cfg[k]!=='string')throw new Error('Invalid provider setting');
    if(cfg.serviceTier!==undefined&&(id!=='codex'||!['','default','priority','ultrafast'].includes(cfg.serviceTier)))throw new Error('Invalid service tier');
    if(cfg.delivery&&!['steer','queue'].includes(cfg.delivery))throw new Error('Invalid delivery mode');
    const modes=id==='codex'?['','readOnly','workspace','full']:['','default','acceptEdits','plan','dontAsk','auto','bypassPermissions'];
    if(cfg.access!==undefined&&!modes.includes(cfg.access))throw new Error('Invalid access mode');
  }
  if(p.lastProvider&&!['codex','claude'].includes(p.lastProvider))throw new Error('Unknown provider');
}
async function act(action,p={}){
  lastActivity=Date.now();
  if(action==='health')return {pid:process.pid};
  if(action==='state')return {conversations:conversations.map(publicConversation),settings:settings()};
  if(action==='settings'){
    validateSettings(p);const s=settings();
    const codex=p.providers?.codex;
    if(codex && (codex.serviceTier!==undefined || codex.model!==undefined || codex.executable!==undefined)){
      const next={...s.providers.codex,...codex};
      if(next.serviceTier && next.serviceTier!=='default'){
        const info=await discover('codex',next,loc.project);
        const model=info.models.find(m=>m.id===(next.model||info.defaultModel));
        if(info.error||!info.authenticated||!model?.serviceTiers?.some(t=>t.id===next.serviceTier))throw new Error('This Codex speed is not available for your account and selected model.');
      }
    }
    for(const id of Object.keys(p.providers||{}))s.providers[id]={...s.providers[id],...p.providers[id]};if(p.lastProvider)s.lastProvider=p.lastProvider;writeJSON(path.join(root,'settings.json'),s);providerCache=null;return s;
  }
  if(action==='providers'){
    if(p.refresh||Date.now()-providerCacheAt>30000){providerCache=null;providerCacheAt=Date.now();}
    if(!providerCache)providerCache=Promise.all(['codex','claude'].map(id=>discover(id,settings().providers[id],loc.project))).catch(e=>{providerCache=null;throw e;});
    return providerCache;
  }
  if(action==='context'){
    if(p.context){uiContext={...p.context,receivedAt:new Date().toISOString()};writeJSON(path.join(loc.dir,'context.json'),uiContext);return {};}
    const all=activeSummary();return {context:uiContext,conversations:p.full?all:all.slice(0,20),...(!p.full&&all.length>20?{moreDiscussions:all.length-20}:{})};
  }
  if(action==='list'){
    if(p.full)return conversations.map(publicConversation);
    const all=activeSummary(),offset=Math.max(0,Number(p.offset)||0),limit=Math.min(100,Math.max(1,Number(p.limit)||50));
    return {items:all.slice(offset,offset+limit),...(offset+limit<all.length?{nextOffset:offset+limit}:{})};
  }
  if(action==='read'){
    const c=find(p.id),offset=Math.max(0,Number(p.offset)||0),limit=Math.min(100,Math.max(1,Number(p.limit)||20));
    return {...publicConversation(c),messages:p.full?c.messages:c.messages.slice(offset,offset+limit),...(!p.full&&offset+limit<c.messages.length?{nextOffset:offset+limit}:{})};
  }
  if(action==='image'){
    const c=find(p.id),image=c.messages.flatMap(m=>m.images||[]).find(i=>i.id===p.imageId);if(!image)throw new Error('Image not found');return {dataUrl:`data:${image.mime};base64,${fs.readFileSync(image.path).toString('base64')}`};
  }
  if(action==='create'){
    if(!['codex','claude'].includes(p.provider))throw new Error('Select Codex or Claude');
    const anchor=p.anchor;if(!anchor||!Array.isArray(anchor.items)||typeof anchor.kind!=='string')throw new Error('Conversation anchor required');
    if(anchor.items.length>1000||anchor.items.some(i=>!i||typeof i.kind!=='string'||typeof i.id!=='string'||!i.id))throw new Error('Invalid anchor items');
    const keys=anchor.items.map(i=>`${i.kind}:${i.id}`);if(anchor.kind==='project')keys.push('project');
    const occupied=conversations.filter(c=>{const existing=c.anchor.items.map(i=>`${i.kind}:${i.id}`);if(c.anchor.kind==='project')existing.push('project');return keys.some(k=>existing.includes(k));});
    if(occupied.length)throw new Error('Selection already has a conversation: '+occupied.map(c=>c.id).join(', '));
    const s=settings(),cfg={...s.providers[p.provider]};delete cfg.delivery;
    const c={id:randomUUID(),provider:p.provider,anchor,context:p.context||{},settings:cfg,status:'idle',messages:[],pending:[],queue:[],createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};
    conversations.push(c);s.lastProvider=p.provider;writeJSON(path.join(root,'settings.json'),s);persist();return publicConversation(c);
  }
  const c=find(p.id);
  if(action==='send'){
    if(typeof p.text!=='string'||p.text.length>200000)throw new Error('Message must be text, at most 200000 characters');
    if(!p.text.trim()&&!p.images?.length)throw new Error('Message is empty');
    const m={id:randomUUID(),role:'user',text:p.text,context:p.context||c.context,images:saveImages(c.id,p.images||[]),queued:true};
    c.messages.push(m);c.context=m.context;changed(c);persist();
    const rt=await ensureRuntime(c);
    if(rt.active&&settings().providers[c.provider].delivery!=='queue'){
      rt.serial=rt.serial.then(()=>deliver(c,rt,m,true)).catch(e=>fail(c,rt,e));
    }else{c.queue.push(m.id);pump(c,rt).catch(e=>fail(c,rt,e));}
    return publicConversation(c);
  }
  if(action==='respond'){
    const rt=runtime.get(c.id),request=rt?.requests.get(p.requestId);if(!request)throw new Error('Request expired');
    rt.requests.delete(p.requestId);c.pending=c.pending.filter(x=>x.id!==p.requestId);c.status=c.pending.length?'waiting':'running';request.resolve(p.answer);changed(c);return publicConversation(c);
  }
  if(action==='stop'){
    const rt=runtime.get(c.id);runtime.delete(c.id);
    if(rt){try{await rt.adapter?.stop();}catch(e){console.error('Interrupt:',e.message);}finally{rt.adapter?.close();releaseEngine(rt);for(const r of rt.requests.values())r.reject(new Error('User stopped conversation'));}}
    for(const m of c.messages)if(m.queued){m.queued=false;m.cancelled=true;}c.queue=[];c.pending=[];c.status='interrupted';c.error=undefined;persist();return publicConversation(c);
  }
  if(action==='settle'){
    const rt=runtime.get(c.id);if(['running','waiting'].includes(c.status)||rt?.dispatching||c.queue?.length)throw new Error('Stop or finish work before settling');
    runtime.delete(c.id);rt?.adapter?.close();if(rt)releaseEngine(rt);
    // This directory is exclusively AFClip's attachment copy, never user source files.
    const imageDir=path.resolve(loc.dir,'images',c.id);if(!imageDir.startsWith(path.resolve(loc.dir,'images')+path.sep))throw new Error('Invalid attachment directory');
    fs.rmSync(imageDir,{recursive:true,force:true});conversations=conversations.filter(v=>v!==c);persist();return {};
  }
  throw new Error('Unknown agent action: '+action);
}
const token=randomBytes(32).toString('hex');
const server=http.createServer(async(req,res)=>{
  const reply=(status,value)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(value));};
  if(req.headers.authorization!==`Bearer ${token}`){reply(401,{ok:false,error:'Unauthorized'});return;}
  if(req.method!=='POST'||req.url!=='/request'){reply(404,{ok:false,error:'Not found'});return;}
  try{let bytes=0,parts=[];for await(const part of req){bytes+=part.length;if(bytes>48*1024*1024)throw new Error('Request exceeds 48 MB');parts.push(part);}const {action,payload}=JSON.parse(Buffer.concat(parts).toString());reply(200,{ok:true,result:await act(action,payload)});}
  catch(e){reply(400,{ok:false,error:e.message});}
});
server.listen(0,'127.0.0.1',()=>{writeJSON(path.join(loc.dir,'endpoint.json'),{url:`http://127.0.0.1:${server.address().port}`,token,pid:process.pid});persist();});
function cleanup(){persist();for(const rt of runtime.values()){rt.adapter?.close();releaseEngine(rt);}try{if(fs.readFileSync(lockFile,'utf8')===String(process.pid))fs.unlinkSync(lockFile);}catch{}}
process.on('exit',cleanup);process.on('SIGTERM',()=>process.exit(0));process.on('SIGINT',()=>process.exit(0));
setInterval(()=>{if(Date.now()-lastActivity>15*60*1000&&!conversations.some(c=>['running','waiting'].includes(c.status)))process.exit(0);},60000).unref();
