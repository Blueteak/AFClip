import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {randomUUID} from 'node:crypto';

// Use the installed executables and their own credentials/configuration. Never copy credentials.
export function executable(provider, config={}) {
  if(config.executable) return config.executable;
  const name=provider==='codex'?'codex':'claude';
  const names=process.platform==='win32'?[name+'.exe',name+'.cmd']: [name];
  for(const dir of (process.env.PATH||'').split(path.delimiter)) for(const n of names) { const p=path.join(dir,n); if(fs.existsSync(p)) return p; }
  throw new Error(`${name} is not installed or is not on PATH. Set its executable in Agent settings.`);
}
function launch(file,args,options={}) {
  // npm shims are scripts, not native executables. Resolve their package CLI instead of shell interpolation.
  if(process.platform==='win32' && /\.(cmd|ps1)$/i.test(file)) {
    const text=fs.readFileSync(file,'utf8');
    const match=text.match(/(?:%dp0%|\$basedir)[\\/]([^"\r\n]+\.(?:js|mjs|cjs))/i);
    if(!match) throw new Error('Use a native executable or a supported npm CLI shim: '+file);
    return spawn(process.env.AFCLIP_NODE_PATH||'node',[path.resolve(path.dirname(file),match[1]),...args],{...options,windowsHide:true});
  }
  return spawn(file,args,{...options,windowsHide:true});
}
async function version(file) {
  return new Promise((resolve,reject)=>{
    const child=launch(file,['--version'],{stdio:['ignore','pipe','pipe']});let output='';
    const timer=setTimeout(()=>{child.kill();reject(new Error('Provider version check timed out'));},10000);
    child.stdout.on('data',b=>{output+=b;});child.on('error',e=>{clearTimeout(timer);reject(e);});
    child.on('exit',code=>{clearTimeout(timer);code===0?resolve(output.trim()):reject(new Error('Provider version check failed'));});
  });
}
export class Codex {
  constructor(config, hooks={}) { this.config=config; this.hooks=hooks; this.pending=new Map(); this.next=1; this.closed=false; }
  async open(cwd) {
    this.child=launch(executable('codex',this.config),['app-server','--stdio'],{cwd,stdio:['pipe','pipe','pipe'],env:process.env});
    this.diagnostic=''; this.child.stderr.on('data',b=>{this.diagnostic=(this.diagnostic+b).slice(-8000);});
    this.child.on('error',e=>this.failed(e));
    this.child.on('exit',(code)=>{if(!this.closed)this.failed(new Error(`Codex exited (${code}). ${this.diagnostic}`));});
    this.child.stdin.on('error',e=>{if(!this.closed)this.failed(e);});
    createInterface({input:this.child.stdout}).on('line',line=>{
      let m; try {m=JSON.parse(line);} catch {return;}
      if(m.method) {
        if(m.id!==undefined) this.requestFromAgent(m).catch(e=>this.reply(m.id,null,{code:-32603,message:e.message}));
        else this.notification(m.method,m.params||{});
      } else { const p=this.pending.get(m.id); if(p) {this.pending.delete(m.id);clearTimeout(p.timer);m.error?p.reject(new Error(m.error.message)):p.resolve(m.result);} }
    });
    await this.rpc('initialize',{clientInfo:{name:'afclip',title:'AFClip',version:'0.1.0'},capabilities:{experimentalApi:true}});
    this.write({method:'initialized'});
  }
  write(value) { if(!this.child?.stdin.writable) throw new Error('Codex connection closed'); this.child.stdin.write(JSON.stringify(value)+'\n'); }
  rpc(method,params={}) { return new Promise((resolve,reject)=>{ const id=this.next++; const timer=setTimeout(()=>{this.pending.delete(id);reject(new Error(`Codex ${method} timed out`));},60000);this.pending.set(id,{resolve,reject,timer});try{this.write({id,method,params});}catch(e){clearTimeout(timer);this.pending.delete(id);reject(e);} }); }
  reply(id,result,error) {try{this.write({id,...(error?{error}:{result})});}catch{} }
  failed(e) {for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(e);}this.pending.clear();this.hooks.error?.(e);}
  async start(conversation,instructions,cwd) {
    await this.open(cwd);
    const access={readOnly:{sandbox:'read-only',approvalPolicy:'on-request'},workspace:{sandbox:'workspace-write',approvalPolicy:'on-request'},full:{sandbox:'danger-full-access',approvalPolicy:'never'}}[this.config.access];
    const params={cwd,...(this.config.model?{model:this.config.model}:{}),...(this.config.serviceTier?{serviceTier:this.config.serviceTier}:{}),...(access||{}),developerInstructions:instructions,...(this.config.effort?{config:{model_reasoning_effort:this.config.effort}}:{})};
    const r=await this.rpc(conversation.sessionId?'thread/resume':'thread/start',{...params,...(conversation.sessionId?{threadId:conversation.sessionId,excludeTurns:true}:{})});
    this.threadId=r.thread.id; this.hooks.session?.(this.threadId);
    this.hooks.config?.({model:r.model,effort:r.reasoningEffort,serviceTier:r.serviceTier, sandbox:r.sandbox,approvalPolicy:r.approvalPolicy});
  }
  input(text,images) { return [{type:'text',text},...images.map(i=>({type:'image',url:`data:${i.mime};base64,${fs.readFileSync(i.path).toString('base64')}`}))]; }
  async send(text,images=[],steer=false) {
    const input=this.input(text,images);
    if(steer&&this.turnId) {
      try { await this.rpc('turn/steer',{threadId:this.threadId,expectedTurnId:this.turnId,input});return; }
      catch(e) { if(this.turnId && !/no active turn|not active|completed|turn.*mismatch/i.test(e.message))throw e; }
    }
    const r=await this.rpc('turn/start',{threadId:this.threadId,input,...(this.config.effort?{effort:this.config.effort}:{})});
    this.turnId=r.turn.id;
  }
  notification(method,p) {
    if(p.threadId && this.threadId && p.threadId!==this.threadId) return;
    if(method==='turn/started') this.turnId=p.turn.id;
    if(method==='item/agentMessage/delta') this.hooks.message?.(p.itemId,'assistant',p.delta,true);
    if(method==='item/completed') {
      const i=p.item;
      if(i.type==='agentMessage') this.hooks.message?.(i.id,'assistant',i.text||'',false);
      else if(i.type==='commandExecution') this.hooks.message?.(i.id,'tool',`${i.command}\n${i.aggregatedOutput||''}${i.exitCode!=null?'\nExit '+i.exitCode:''}`,false);
      else if(i.type==='fileChange') this.hooks.message?.(i.id,'tool',JSON.stringify(i.changes),false);
    }
    if(method==='item/started'&&p.item?.type==='commandExecution')this.hooks.message?.(p.item.id,'tool',p.item.command,false);
    if(method==='turn/completed') {this.turnId=null;this.hooks.done?.(p.turn.error?.message || (p.turn.status==='failed'?'Codex turn failed':null),p.turn.status==='interrupted');}
    if(method==='error' && !p.willRetry) this.hooks.message?.(randomUUID(),'system',p.error?.message||JSON.stringify(p),false);
  }
  async requestFromAgent(m) {
    const p=m.params||{};
    if(m.method==='item/tool/requestUserInput') {
      const answer=await this.hooks.ask({kind:'question',title:'Codex needs input',questions:p.questions});
      const answers={};for(const q of p.questions||[]) {const v=typeof answer==='object'?answer[q.id]??answer[q.question]:answer;answers[q.id]={answers:Array.isArray(v)?v:[String(v??'')]};}
      this.reply(m.id,{answers});return;
    }
    if(m.method==='item/permissions/requestApproval') {
      const decision=await this.hooks.ask({kind:'approval',title:'Codex requests access',detail:JSON.stringify(p.permissions),options:[{id:'accept',label:'Allow this turn'},{id:'session',label:'Allow for session'},{id:'decline',label:'Deny'}]});
      this.reply(m.id,{permissions:decision==='decline'?{}:p.permissions,scope:decision==='session'?'session':'turn'});return;
    }
    if(m.method.endsWith('/requestApproval')) {
      const defaults=['accept','acceptForSession','decline','cancel'];
      const choices=p.availableDecisions||defaults;
      const options=choices.map((v,i)=>({id:typeof v==='string'?v:String(i),label:typeof v==='string'?({accept:'Allow once',acceptForSession:'Allow for session',decline:'Deny',cancel:'Stop'}[v]||v):JSON.stringify(v)}));
      const answer=await this.hooks.ask({kind:'approval',title:p.command||p.reason||'Codex requests approval',detail:JSON.stringify(p),options});
      const at=options.findIndex(o=>o.id===answer); if(at<0)throw new Error('Invalid approval answer');
      this.reply(m.id,{decision:choices[at]});return;
    }
    this.reply(m.id,null,{code:-32601,message:`AFClip does not support ${m.method}; update AFClip or use the provider CLI.`});
  }
  async stop() {if(this.turnId) await this.rpc('turn/interrupt',{threadId:this.threadId,turnId:this.turnId});}
  close() {this.closed=true;this.child?.stdin.end();this.child?.kill();for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(new Error('Codex session closed'));}this.pending.clear();}
}

class InputStream {
  values=[]; waiting=[]; ended=false;
  push(v){const w=this.waiting.shift();w?w({value:v,done:false}):this.values.push(v);}
  next(){if(this.values.length)return Promise.resolve({value:this.values.shift(),done:false});if(this.ended)return Promise.resolve({done:true});return new Promise(r=>this.waiting.push(r));}
  end(){this.ended=true;for(const r of this.waiting.splice(0))r({done:true});}
  [Symbol.asyncIterator](){return this;}
}
export class Claude {
  constructor(config,hooks={}) {this.config=config;this.hooks=hooks;this.closed=false;}
  async open(cwd,instructions='',sessionId) {
    const {query}=await import('@anthropic-ai/claude-agent-sdk');
    this.input=new InputStream();
    const env={...process.env};delete env.CLAUDECODE;
    this.query=query({prompt:this.input,options:{cwd,pathToClaudeCodeExecutable:executable('claude',this.config),env,settingSources:['user','project','local'],
      ...(instructions?{systemPrompt:{type:'preset',preset:'claude_code',append:instructions}}:{}),
      ...(sessionId?{resume:sessionId}:{}),...(this.config.model?{model:this.config.model}:{}),...(this.config.effort?{effort:this.config.effort}:{}),
      ...(this.config.access?{permissionMode:this.config.access,allowDangerouslySkipPermissions:this.config.access==='bypassPermissions'}:{}),
      canUseTool:async(name,input,options)=>{
        if(name==='AskUserQuestion') { const answer=await this.hooks.ask({kind:'question',title:'Claude needs input',questions:input.questions},options.signal); const answers={}; for(const q of input.questions||[]) {const v=typeof answer==='object'?answer[q.id]??answer[q.question]??answer[q.header]??'':String(answer);answers[q.question]=Array.isArray(v)?v.join(', '):v;}return {behavior:'allow',updatedInput:{...input,answers}}; }
        if(this.config.access==='bypassPermissions')return {behavior:'allow',updatedInput:input};
        const choices=[{id:'allow',label:'Allow once'},...(options.suggestions?.length?[{id:'session',label:'Allow with suggested permissions'}]:[]),{id:'deny',label:'Deny'}];
        const a=await this.hooks.ask({kind:'approval',title:name,detail:JSON.stringify(input),options:choices},options.signal);
        return a==='allow'||a==='session'?{behavior:'allow',updatedInput:input,...(a==='session'?{updatedPermissions:options.suggestions}:{})}:{behavior:'deny',message:'User denied this action'};
      },stderr:s=>{this.diagnostic=(this.diagnostic||'').slice(-6000)+s;}}});
  }
  async start(c,instructions,cwd) {
    await this.open(cwd,instructions,c.sessionId);
    this.consume().catch(e=>{if(!this.closed)this.hooks.error?.(e);});
  }
  async consume(){
    for await(const m of this.query) {
      if(m.session_id)this.hooks.session?.(m.session_id);
      if(m.type==='system'&&m.subtype==='init')this.hooks.config?.({model:m.model,effort:m.effort,access:m.permissionMode});
      if(m.type==='assistant')for(const b of m.message.content||[]) {
        if(b.type==='text')this.hooks.message?.(m.uuid+':'+m.message.content.indexOf(b),'assistant',b.text,false);
        if(b.type==='tool_use')this.hooks.message?.(b.id,'tool',b.name+' '+JSON.stringify(b.input),false);
      }
      if(m.type==='user' && Array.isArray(m.message.content))for(const b of m.message.content)if(b.type==='tool_result')this.hooks.message?.(b.tool_use_id+':result','tool',typeof b.content==='string'?b.content:JSON.stringify(b.content),false);
      if(m.type==='result') this.hooks.done?.(m.is_error?(m.errors?.join('\n')||m.result||m.subtype):null,false);
    }
    if(!this.closed)this.hooks.error?.(new Error('Claude session disconnected. Send a message to resume.'));
  }
  async send(text,images=[],steer=false) {
    this.input.push({type:'user',message:{role:'user',content:[{type:'text',text},...images.map(i=>({type:'image',source:{type:'base64',media_type:i.mime,data:fs.readFileSync(i.path).toString('base64')}}))]},parent_tool_use_id:null,session_id:'',uuid:randomUUID(),priority:steer?'now':'next'});
  }
  async stop(){await this.query?.interrupt();}
  close(){this.closed=true;this.input?.end();this.query?.close();}
}

export async function discover(provider,config,cwd) {
  const result={id:provider,name:provider==='codex'?'Codex':'Claude Code',installed:false,authenticated:null,models:[],accessModes:provider==='codex'?[{id:'readOnly',label:'Read only'},{id:'workspace',label:'Workspace + approvals'},{id:'full',label:'Full access'}]:['default','acceptEdits','plan','dontAsk','auto','bypassPermissions'].map(id=>({id,label:{default:'Default approvals',acceptEdits:'Accept edits',plan:'Plan',dontAsk:'Deny unapproved',auto:'Auto',bypassPermissions:'Bypass permissions'}[id]})),setup:provider==='codex'?'Install Codex CLI, then run codex login.':'Install Claude Code, then run claude auth login.'};
  let adapter;
  try {
    const file=executable(provider,config);result.installed=true;result.version=await version(file);
    if(provider==='codex') {
      adapter=new Codex(config);await adapter.open(cwd);
      const account=await adapter.rpc('account/read',{refreshToken:false}); result.authenticated=!!account.account;
      const models=await adapter.rpc('model/list',{limit:100});
      result.models=models.data.map(m=>({id:m.id,label:m.displayName||m.model,efforts:m.supportedReasoningEfforts?.map(e=>e.reasoningEffort),
        serviceTiers:m.serviceTiers || (m.additionalSpeedTiers || []).map(id=>({id:id==='fast'?'priority':id,name:id==='fast'?'Fast':id,description:''}))}));
      const resolved=await adapter.rpc('config/read',{cwd,includeLayers:false});
      result.defaultModel=resolved.config?.model || models.data.find(m=>m.isDefault)?.id;
    }else{
      adapter=new Claude(config);await adapter.open(cwd);
      const [models,account]=await Promise.all([adapter.query.supportedModels(),adapter.query.accountInfo()]);
      result.models=models.map(m=>({id:m.value,label:m.displayName,efforts:m.supportedEffortLevels||[]}));result.authenticated=!!(account.email||account.tokenSource||account.apiKeySource);
    }
  } catch(e){result.error=e.message;} finally {adapter?.close();}
  return result;
}
