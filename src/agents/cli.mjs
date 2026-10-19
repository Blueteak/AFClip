import fs from 'node:fs';
import {agents} from './local.mjs';

export async function agentCommand(project,positionals,options) {
  const action=positionals[0]||'list';
  const allowed=['list','context','read','providers','settings','create','send','stop','settle','respond'];
  if(!allowed.includes(action))throw new Error('Unknown agent action. Run af-clip help agent.');
  const payload=options.file?JSON.parse(fs.readFileSync(String(options.file),'utf8')):{};
  if(positionals[1])payload.id=positionals[1];
  if(options.text!==undefined)payload.text=String(options.text);
  if(options.offset!==undefined)payload.offset=Number(options.offset);
  if(options.limit!==undefined)payload.limit=Number(options.limit);
  if(options.full)payload.full=true;
  const result=await agents(project,action,payload);
  if(!options.full&&action==='read')return {id:result.id,provider:result.provider,status:result.status,anchor:result.anchor,
    messages:result.messages.map(m=>({id:m.id,role:m.role,text:m.role==='tool'?m.text.split('\n')[0]:m.text,
      ...(m.role==='tool'&&m.text.includes('\n')?{outputAvailable:true}:{}),...(m.images?.length?{images:m.images.map(i=>({id:i.id,name:i.name}))}:{}),...(m.queued?{queued:true}:{}),...(m.cancelled?{cancelled:true}:{})})),
    ...(result.nextOffset!==undefined?{nextOffset:result.nextOffset}:{}),...(result.pending?.length?{pending:result.pending}:{}),...(result.error?{error:result.error}:{})};
  if(!options.full&&['create','send','respond','stop'].includes(action))return {id:result.id,provider:result.provider,status:result.status,...(result.error?{error:result.error}:{}),...(result.pending?.length?{pending:result.pending}:{})};
  return result;
}
