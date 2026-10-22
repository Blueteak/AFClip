import {createRequire} from 'node:module';
import {assert,fail,trackLocked,rational,parseTime,add,sub,mul,cmp,seconds,ZERO} from '../shared/project.ts';
import type {Time} from '../shared/project.ts';
const schema=createRequire(import.meta.url)('../shared/asset.cjs');

// Agents address curve points in visible seconds or percent. Clip and effect points
// are stored in source time, so trims hide them and stretches scale them.
// Transition points are stored as transition progress.
function resolve(p:any,c:any){
 const clip=p.clips.find((v:any)=>v.id===c.id),transition=!clip&&p.transitions.find((v:any)=>v.id===c.id);
 assert(clip||transition,'Clip or transition not found',{id:c.id});
 if(transition){assert(!c.effect,'Transitions have no effects');const media=p.media.find((m:any)=>m.id===transition.assetId);return {owner:transition,instance:transition,media,kind:'transition',duration:transition.duration,
  toX:(local:Time)=>mul(local,{num:transition.duration.den,den:transition.duration.num}),toLocal:(x:Time)=>mul(x,transition.duration),percentX:(pct:Time)=>mul(pct,{num:1,den:100})};}
 const instance=c.effect?(clip.effects||[]).find((e:any)=>e.id===c.effect):clip;
 assert(instance,'Effect not found',{clipId:clip.id,effect:c.effect});
 const media=p.media.find((m:any)=>m.id===(c.effect?instance.assetId:clip.mediaId));
 assert(media?.kind==='graphic','Parameters require an HTML graphic clip, effect or transition',{id:c.id});
 const toX=(local:Time)=>add(clip.sourceIn,mul(local,clip.speed));
 return {owner:clip,instance,media,kind:c.effect?'effect':'clip',duration:clip.duration,toX,toLocal:(x:Time)=>mul(sub(x,clip.sourceIn),{num:clip.speed.den,den:clip.speed.num}),percentX:(pct:Time)=>toX(mul(clip.duration,mul(pct,{num:1,den:100})))};
}
// Declared parameters first, then undeclared data-text fields in HTML order.
function bindDefault(r:any,curve:any[]){
 const span=r.kind==='transition'?null:r.instance.paramSpan||{start:r.owner.sourceIn,end:add(r.owner.sourceIn,mul(r.owner.duration,r.owner.speed))};
 return curve.map((p:any)=>{const pct=mul(parseTime(p.at.slice(0,-1)),{num:1,den:100}),x=span?add(span.start,mul(sub(span.end,span.start),pct)):pct;return {t:x,v:p.v,...(p.ease?{ease:schema.ease(p.ease)}:{})};});
}
function fields(media:any){
 const declared=media.metadata.asset?.parameters||{},text=media.metadata.textFields||[],out:[string,any][]=[];
 for(const [id,field] of Object.entries<any>(declared)){const html=text.find((f:any)=>f.id===id);out.push([id,field.type==='text'&&field.default===undefined?{...field,default:html?.default??''}:field]);}
 for(const f of text)if(!Object.hasOwn(declared,f.id))out.push([f.id,{type:'text',default:f.default}]);
 return out;
}
const round=(v:number)=>Math.round(v*1e4)/1e4;
function parseAt(r:any,at:any):Time{
 if(typeof at==='string'&&at.endsWith('%')){assert(/^-?\d+(\.\d+)?%$/.test(at),'Percent must look like 50%');return r.percentX(parseTime(at.slice(0,-1)));}
 if(typeof at==='number'){assert(Number.isFinite(at),'Point time must be finite');return r.toX(parseTime(String(Number(at.toFixed(6)))));}
 assert(typeof at==='string','Point time requires seconds, a/b fraction or N%');return r.toX(parseTime(at));
}
function point(r:any,field:any,input:any){
 const p=Array.isArray(input)?{at:input[0],v:input[1],ease:input[2]}:input;
 assert(p&&typeof p==='object'&&p.at!==undefined&&p.v!==undefined,'Curve point requires at and v');
 const out:any={t:parseAt(r,p.at),v:p.v};
 try{const ease=schema.ease(p.ease);if(ease!==undefined)out.ease=ease;}catch(e:any){fail('VALIDATION',e.message);}
 return out;
}
function summarize(r:any,field:any,v:any){
 const at=(t:Time)=>round(seconds(r.toLocal(t)));
 const value=(v:any)=>typeof v==='number'?Math.round(v*1e6)/1e6:v;
 return v.curve.map((p:any)=>{const ease=schema.easeName(p.ease);return ease==='linear'?[at(p.t),value(p.v)]:[at(p.t),value(p.v),ease];});
}
function describe(r:any,id:string,field:any,value:any,full:boolean){
 const out:any={id,type:field.type};
 if(full){Object.assign(out,field);if(value!==undefined)out.override=value;return out;}
 for(const key of ['label','unit','min','max','softMin','softMax','step','integer','slider','choices'])if(field[key]!==undefined)out[key]=field[key];
 const def=schema.isCurve(field.default)?{curve:field.default.curve.map((p:any)=>[p.at,p.v,...(p.ease?[p.ease]:[])])}:field.default;
 if(value===undefined){if(schema.isCurve(field.default))out.curve=summarize(r,field,{curve:bindDefault(r,field.default.curve)});else out.value=field.default;return out;}
 if(schema.isCurve(value)){
  if(Object.hasOwn(value,'value')){out.value=value.value;out.inactiveCurve=summarize(r,field,value);}else out.curve=summarize(r,field,value);
 }else out.value=value;
 out.default=def;return out;
}
function target(state:any,c:any){
 assert(typeof c.id==='string','Target clip or transition ID required');
 const r=resolve(state.p,c);
 return {r,list:fields(r.media)};
}
export function inspectParams(state:any,c:any){
 const {r,list}=target(state,c),params=r.instance.params||{};
 const result:any={id:c.id,...(c.effect?{effect:c.effect}:{}),revision:r.owner.revision,mediaRevision:r.media.revision,duration:seconds(r.duration),
  params:list.map(([id,field])=>describe(r,id,field,params[id],!!c.full))};
 if(c.full&&r.instance.paramSpan)result.paramSpan=r.instance.paramSpan;
 if(c.at!==undefined){
  const times=(Array.isArray(c.at)?c.at:[c.at]);assert(times.length<=100,'Evaluate at most 100 times');
  const span=r.kind==='transition'?[0,1]:schema.span(r.instance,[seconds(r.owner.sourceIn),seconds(add(r.owner.sourceIn,mul(r.owner.duration,r.owner.speed)))]);
  const xs=times.map((t:any)=>seconds(parseAt(r,t)));
  result.evaluated={at:times,values:Object.fromEntries(list.filter(([id,f])=>schema.animatable(f)&&(c.full||schema.curve(f,params[id]))).map(([id,f])=>[id,xs.map(x=>{const v=schema.evaluate(f,params[id],x,span);return typeof v==='number'&&!c.full?round(v):v;})]))};
 }
 return result;
}
// Applies every operation to one copy and commits a single revision-checked batch.
export function editParams(state:any,c:any){
 const {r,list}=target(state,c);
 if(c.revision!==r.owner.revision||(c.mediaRevision!==undefined&&c.mediaRevision!==r.media.revision))fail('CONFLICT','Parameters changed. Reread before editing.',{id:c.id,revision:r.owner.revision,mediaRevision:r.media.revision});
 assert(Array.isArray(c.ops)&&c.ops.length>0&&c.ops.length<=200,'Supply 1 to 200 parameter operations');
 state.requireUnlocked();if(trackLocked(state.p,r.owner.trackId))fail('TRACK_LOCKED','Cannot modify a locked track',{trackId:r.owner.trackId});
 const params:any=structuredClone(r.instance.params||{}),fieldMap=new Map(list),edited=new Set<string>();
 const span=r.kind==='transition'?null:r.instance.paramSpan||{start:r.owner.sourceIn,end:add(r.owner.sourceIn,mul(r.owner.duration,r.owner.speed))};
 // A default curve becomes explicit, bound to the instance span, when first edited.
 const points=(id:string,field:any)=>{
  const v=params[id];if(schema.isCurve(v))return v.curve;
  if(v===undefined&&schema.isCurve(field.default))return bindDefault(r,field.default.curve);
  return [];
 };
 const select=(curve:any[],sel:any)=>{
  if(sel&&typeof sel==='object'&&!Array.isArray(sel)){assert(Number.isInteger(sel.index)&&sel.index>=0&&sel.index<curve.length,'Point index out of range');return sel.index;}
  const x=seconds(parseAt(r,sel)),tolerance=r.kind==='transition'?1e-4:1e-3*seconds(r.owner.speed);
  const i=curve.findIndex(p=>Math.abs(seconds(p.t)-x)<=tolerance);assert(i>=0,'No curve point at that time',{at:sel});return i;
 };
 const insert=(curve:any[],p:any)=>{const i=curve.findIndex(q=>cmp(q.t,p.t)>=0);if(i<0)curve.push(p);else if(cmp(curve[i].t,p.t)===0)curve[i]=p;else curve.splice(i,0,p);};
 for(const op of c.ops){
  assert(op&&typeof op.param==='string','Each operation requires param');
  const field=fieldMap.get(op.param);assert(field,'Unknown parameter',{param:op.param});
  const keys=Object.keys(op).filter(k=>k!=='param'),id=op.param;edited.add(id);
  const animated=()=>{assert(schema.animatable(field),'Only number and color parameters can be animated',{param:id});};
  if(keys.length===1&&keys[0]==='value'){params[id]=op.value;}
  // CLI shorthand name=value arrives as raw text and converts by declared type.
  else if(keys.length===1&&keys[0]==='set'){const raw=String(op.set);params[id]=field.type==='number'?(raw.trim()===''?NaN:Number(raw)):field.type==='boolean'?(raw==='true'?true:raw==='false'?false:raw):raw;}
  else if(keys.length===1&&keys[0]==='reset'){assert(op.reset===true,'reset must be true');delete params[id];}
  else if(keys.length===1&&keys[0]==='curve'){animated();assert(Array.isArray(op.curve)&&op.curve.length,'curve requires points');const curve:any[]=[];for(const p of op.curve)insert(curve,point(r,field,p));assert(curve.length===op.curve.length,'Curve points need unique times');params[id]={curve};}
  else if(keys.length===1&&keys[0]==='add'){animated();const curve=[...points(id,field)];for(const p of Array.isArray(op.add)&&(Array.isArray(op.add[0])||typeof op.add[0]==='object')?op.add:[op.add])insert(curve,point(r,field,p));params[id]=schema.isCurve(params[id])&&Object.hasOwn(params[id],'value')?{curve,value:params[id].value}:{curve};}
  else if(keys.length===1&&keys[0]==='delete'){animated();const curve=[...points(id,field)],sels=Array.isArray(op.delete)?op.delete:[op.delete];const drop=new Set(sels.map((s:any)=>select(curve,s)));const next=curve.filter((_,i)=>!drop.has(i));
   if(!next.length){delete params[id];}else params[id]=schema.isCurve(params[id])&&Object.hasOwn(params[id],'value')?{curve:next,value:params[id].value}:{curve:next};}
  else if(keys.length===2&&keys.includes('move')&&keys.includes('to')){animated();const curve=[...points(id,field)],i=select(curve,op.move),old=curve[i];curve.splice(i,1);
   const to=op.to||{};assert(typeof to==='object'&&Object.keys(to).every(k=>['at','v','ease'].includes(k)),'to accepts at, v and ease');
   const moved:any={t:to.at!==undefined?parseAt(r,to.at):old.t,v:to.v!==undefined?to.v:old.v};const ease=to.ease!==undefined?schema.ease(to.ease):old.ease;if(ease!==undefined)moved.ease=ease;
   assert(!curve.some(q=>cmp(q.t,moved.t)===0),'Another point already uses that time');insert(curve,moved);params[id]=schema.isCurve(params[id])&&Object.hasOwn(params[id],'value')?{curve,value:params[id].value}:{curve};}
  else if(keys.every(k=>k==='animate'||k==='at')&&keys.includes('animate')){animated();
   const x=op.at===undefined?(r.kind==='transition'?ZERO:r.toX(ZERO)):parseAt(r,op.at),spanSec=span?[seconds(span.start),seconds(span.end)]:[0,1];
   const current=schema.evaluate(field,params[id],seconds(x),spanSec);
   if(op.animate===false){const curve=points(id,field);if(!curve.length)continue;
    // The constant starts at the evaluated value; the inactive curve stays for toggling back.
    params[id]={curve,value:current};}
   else{assert(op.animate===true,'animate must be true or false');const v=params[id];
    if(schema.isCurve(v))params[id]={curve:v.curve};else if(v===undefined&&schema.isCurve(field.default))continue;
    else params[id]={curve:[{t:x,v:current}]};}}
  else fail('VALIDATION','Operation needs value, set, reset, curve, add, delete, move+to, or animate',{param:id});
 }
 for(const id of edited)if(params[id]!==undefined){try{schema.override(id,fieldMap.get(id),params[id]);}catch(e:any){fail('VALIDATION',e.message,{param:id});}}
 const owner=r.owner;
 const value=r.kind==='effect'?{id:owner.id,effects:owner.effects.map((e:any)=>e.id===c.effect?{...e,params}:e)}:{id:owner.id,params};
 const collection=r.kind==='transition'?'transitions':'clips';
 if(JSON.stringify(params)===JSON.stringify(r.instance.params||{}))return {...state.inspect(),params:[...edited].map(id=>describe(r,id,fieldMap.get(id),params[id],false))};
 const result=state.batch({preconditions:state.inspect().revisions,operations:[{op:'put',collection,value}]});
 const after=resolve(result.project,c);
 return {...result,params:[...edited].map(id=>describe(after,id,fieldMap.get(id),(after.instance.params||{})[id],false))};
}
