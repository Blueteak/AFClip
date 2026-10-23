import {randomUUID} from 'node:crypto';
import {assert,fail,revisions,timelineCollections} from '../shared/project.ts';
import type {Project,Sequence,Timeline} from '../shared/project.ts';
import type {ProjectState} from './state.ts';

const uid=(kind:string)=>`${kind}_${randomUUID().replaceAll('-','')}`;
function timeline(p:Project):Timeline {
 return structuredClone(Object.fromEntries(timelineCollections.map(key=>[key,p[key]||[]]))) as Timeline;
}
function select(p:Project,id:string){
 const current=p.sequences.find((s:Sequence)=>s.id===p.activeSequenceId);
 const target=p.sequences.find((s:Sequence)=>s.id===id);
 assert(target,'Sequence not found',{id});
 if(current.id===id)return;
 current.timeline=timeline(p);
 Object.assign(p,target.timeline);delete target.timeline;p.activeSequenceId=id;
}
function copyTimeline(p:Project):Timeline {
 assert(!p.clips.some(c=>c.generationId),'Accept generated clips before copying this sequence');
 const copy=timeline(p),ids=new Map<string,string>(),links=new Map<string,string>();
 for(const key of timelineCollections)for(const item of copy[key]){ids.set(`${key}:${item.id}`,uid(key==='clips'?'clip':key==='tracks'?'track':key==='folders'?'folder':key==='markers'?'marker':'transition'));}
 for(const key of timelineCollections)for(const item of copy[key] as any[]){
  item.id=ids.get(`${key}:${item.id}`);item.revision=1;
  for(const [field,collection] of [['trackId','tracks'],['folderId','folders'],['fromClipId','clips'],['toClipId','clips']])if(item[field])item[field]=ids.get(`${collection}:${item[field]}`);
  if(item.linkId){if(!links.has(item.linkId))links.set(item.linkId,uid('link'));item.linkId=links.get(item.linkId);}
  for(const effect of item.effects||[])effect.id=uid('effect');
 }
 return copy;
}
export function sequenceBatch(state:ProjectState,batch:any){
 assert(batch.operations.length===1,'Sequence operations must be the only operation in a batch');
 if(batch.preconditions?.project!==state.p.revision)fail('CONFLICT','Project changed. Reread before changing sequences.',{expected:batch.preconditions?.project??null,actual:state.p.revision});
 const op=batch.operations[0],next=structuredClone(state.p),before=revisions(state.p);
 const active=next.sequences.find((s:Sequence)=>s.id===next.activeSequenceId);
 if(op.op==='sequence-select'){
  assert(typeof op.id==='string','Sequence ID required');
  if(op.id===next.activeSequenceId)return state.inspect();
  select(next,op.id);
 }else if(op.op==='sequence-copy'){
  if(op.sourceId!==undefined&&op.sourceId!==next.activeSequenceId)fail('CONFLICT','Active sequence changed. Reopen the copy dialog.',{expected:op.sourceId,actual:next.activeSequenceId});
  const base=`${active.name.slice(0,240)} copy`;let name=base,n=2;
  while(next.sequences.some((s:Sequence)=>s.name.toLowerCase()===name.toLowerCase()))name=`${base} ${n++}`;
  const copy={id:uid('sequence'),name:op.name===undefined?name:op.name,revision:1,timeline:copyTimeline(next)};
  next.sequences.push(copy);select(next,copy.id);
 }else if(op.op==='sequence-rename'){
  const target=next.sequences.find((s:Sequence)=>s.id===op.id);assert(target,'Sequence not found',{id:op.id});
  assert(typeof op.name==='string','Sequence name required');
  if(target.name===op.name.trim())return state.inspect();
  target.name=op.name.trim();target.revision++;
 }else fail('VALIDATION','Unknown sequence operation',{op:op.op});
 for(const sequence of next.sequences){assert(typeof sequence.name==='string','Sequence name required');sequence.name=sequence.name.trim();}
 next.revision++;
 next.relationshipRevisions['collection:sequences']=(before['collection:sequences']||0)+1;
 if(next.activeSequenceId!==state.p.activeSequenceId){
  for(const key of ['active:sequence','order:tracks','collection:markers'])next.relationshipRevisions[key]=(before[key]||0)+1;
 }
 return state.save(next);
}
