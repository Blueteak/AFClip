import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {EngineError, assert, fail, validateProject, revisions, time, ZERO, ONE, trackLocked} from '../shared/project.ts';
import type {Project} from '../shared/project.ts';
import {restoreGraphicAuthors,pruneGraphicSnapshots,importBuiltin} from './probe.ts';
import {rippleOperations} from './ripple.ts';
import {audioOperations,linkedOperations} from './linked-audio.ts';

export function atomicJSON(file:string,value:any){fs.mkdirSync(path.dirname(file),{recursive:true});const temp=`${file}.${randomUUID()}.tmp`;const fd=fs.openSync(temp,'wx');try{fs.writeFileSync(fd,JSON.stringify(value,null,2)+'\n');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}try{fs.renameSync(temp,file);}catch(e){fs.rmSync(temp,{force:true});throw e;}}
export function createProject(dir:string,options:any={}):Project {fs.mkdirSync(dir,{recursive:true});assert(!fs.existsSync(path.join(dir,'project.json')),'Project already exists');const p:Project={version:1,id:randomUUID(),name:options.name||path.basename(dir),revision:0,resolution:{width:options.width||1920,height:options.height||1080},fps:options.fps||{num:30,den:1},media:[],tracks:[],clips:[],transitions:[],markers:[],relationshipRevisions:{'order:tracks':0,'collection:media':0}};p.media=['dissolve','wipe','blur-transition','spin','blur'].map(name=>importBuiltin(dir,name));validateProject(p);atomicJSON(path.join(dir,'project.json'),p);return p;}
const singular:Record<string,string>={media:'media',tracks:'track',clips:'clip',transitions:'transition',markers:'marker',folders:'folder'};
export class ProjectState {
 dir:string;p:Project;undo:Project[]=[];redo:Project[]=[];locked:string|null=null;
 constructor(dir:string){this.dir=dir;this.p=JSON.parse(fs.readFileSync(path.join(dir,'project.json'),'utf8'));this.p.relationshipRevisions||={};validateProject(this.p);}
 inspect(){return {project:this.p,revisions:revisions(this.p),history:{undo:this.undo.length,redo:this.redo.length},renderLock:this.locked};}
 requireUnlocked(){if(this.locked)fail('RENDER_LOCKED','Project edits are locked while rendering',{jobId:this.locked});}
 save(next:Project,history=true){validateProject(next);atomicJSON(path.join(this.dir,'project.json'),next);if(history){this.undo.push(structuredClone(this.p));if(this.undo.length>100)this.undo.shift();this.redo=[];}this.p=next;return this.inspect();}
 batch(batch:any,derivedTimes=false){this.requireUnlocked();assert(batch&&Array.isArray(batch.operations)&&batch.operations.length>0&&(derivedTimes||batch.operations.length<=1000),'Batch requires 1 to 1000 operations');
  if(batch.operations.some((op:any)=>['detach-audio','unlink'].includes(op?.op))){
   assert(batch.operations.length===1,'Audio operation must be the only operation in its batch');
   if(batch.preconditions?.project!==this.p.revision)fail('CONFLICT','Project changed. Reread before editing linked audio.');
   const operations=audioOperations(this.p,batch.operations[0]),pre=revisions(this.p);
   for(const t of this.p.tracks)pre[`occupancy:${t.id}`]??=0;
   for(const op of operations){if(op.op!=='put')continue;const key=`${singular[op.collection]}:${op.value.id}`;pre[key]??=0;if(op.collection==='tracks')pre[`occupancy:${op.value.id}`]??=0;}
   return this.batch({preconditions:pre,operations},true);
  }
  if(batch.operations.some((op:any)=>op?.op==='ripple-delete')){
   assert(batch.operations.length===1,'Ripple delete must be the only operation in its batch');
   if(batch.preconditions?.project!==this.p.revision)fail('CONFLICT','Project changed. Reread before ripple deleting.',{expected:batch.preconditions?.project??null,actual:this.p.revision});
   const {start,end}=batch.operations[0],plan=rippleOperations(this.p,start,end);
   if(!plan.operations.length)return this.inspect();
   const pre=revisions(this.p);for(const track of this.p.tracks)pre[`occupancy:${track.id}`]??=0;for(const id of plan.newIds)pre[`clip:${id}`]=0;
   return this.batch({preconditions:pre,operations:plan.operations},true);
  }
  if(!derivedTimes)batch={...batch,operations:linkedOperations(this.p,batch.operations)};
  const pre=batch.preconditions||{},current=revisions(this.p),next=structuredClone(this.p),needed=new Set<string>(),touched=new Set<string>();const created=new Set<string>();
  const requireFolder=(trackId:string)=>{for(const p of [this.p,next]){const folderId=p.tracks.find((t:any)=>t.id===trackId)?.folderId;if(folderId&&!created.has(`folder:${folderId}`))needed.add(`folder:${folderId}`);}};
  for(let op of batch.operations){assert(op&&typeof op.op==='string','Invalid operation');if(op.op==='project'){needed.add('project');assert(op.value&&Object.keys(op.value).every(k=>['name','resolution','fps'].includes(k)),'Project operation accepts name, resolution and fps only');Object.assign(next,op.value);continue;}
   if(op.op==='reorder-tracks'){
    needed.add('project');needed.add('order:tracks');touched.add('order:tracks');
    assert(Array.isArray(op.trackIds)&&op.trackIds.length===next.tracks.length&&new Set(op.trackIds).size===next.tracks.length&&op.trackIds.every((id:any)=>next.tracks.some((t:any)=>t.id===id)),'Reorder requires every track ID exactly once');
    for(const [index,t] of next.tracks.entries()){requireFolder(t.id);needed.add(`track:${t.id}`);if(trackLocked(next,t.id)&&op.trackIds[index]!==t.id)fail('TRACK_LOCKED','Unlock tracks and folders before reordering them',{trackId:t.id});}
    next.tracks=op.trackIds.map((id:string)=>next.tracks.find((t:any)=>t.id===id));continue;
   }
   assert(['put','remove'].includes(op.op)&&singular[op.collection],'Expected put or remove and supported collection');const coll=op.collection,key=singular[coll],id=op.op==='put'?op.value?.id:op.id;assert(typeof id==='string'&&/^[a-zA-Z0-9_-]+$/.test(id),'Object requires stable alphanumeric ID');const arr=next[coll]as any[],index=arr.findIndex(o=>o.id===id),old=index>=0?arr[index]:null,base=this.p[coll].find((o:any)=>o.id===id);const objectKey=`${key}:${id}`;if(base)needed.add(objectKey);else if(!created.has(objectKey)){assert(!(objectKey in current),'ID already exists');needed.add(objectKey);created.add(objectKey);}touched.add(objectKey);
   if(coll==='transitions'&&op.op==='put'&&!old)op={...op,value:{assetId:next.media.find((m:any)=>m.metadata.builtin==='dissolve')?.id,...op.value}};
   if(coll==='markers'){
    touched.add('collection:markers');
    if(op.op==='put'&&op.value.time!==undefined&&JSON.stringify(op.value.time)!==JSON.stringify(old?.time)&&!derivedTimes){
     needed.add('project');const t=time(op.value.time,'Marker time');
     assert((BigInt(t.num)*BigInt(next.fps.num))%(BigInt(t.den)*BigInt(next.fps.den))===0n,'Marker time must land on the project frame grid');
    }
   }
   if(coll==='folders'){
    if(!old||op.op==='remove'){needed.add('order:tracks');touched.add('order:tracks');}
    if(old?.locked&&!(op.op==='put'&&Object.keys(op.value).every(k=>['id','revision','collapsed'].includes(k)))&&!(op.op==='put'&&op.value.locked===false&&Object.keys(op.value).every(k=>['id','revision','locked'].includes(k))))fail('TRACK_LOCKED','Unlock a folder before modifying it',{folderId:id});
   }
   if(coll==='tracks'){
    requireFolder(id);
    const folderId=op.value?.folderId;
    if(folderId&&!created.has(`folder:${folderId}`))needed.add(`folder:${folderId}`);
    if(folderId&&next.folders?.find(f=>f.id===folderId)?.locked)fail('TRACK_LOCKED','Cannot add a track to a locked folder',{folderId});
    if(!old||op.op==='remove'||op.value?.folderId!==undefined){needed.add('order:tracks');touched.add('order:tracks');}
    const parentLocked=old?.folderId&&next.folders?.find(f=>f.id===old.folderId)?.locked;
    if(parentLocked||(old?.locked&&!(op.op==='put'&&op.value.locked===false&&Object.keys(op.value).every(k=>['id','locked','revision'].includes(k)))))fail('TRACK_LOCKED','Unlock a track and its folder before modifying it',{trackId:id});
    if(op.op==='remove'){needed.add(`occupancy:${id}`);assert(!next.clips.some((c:any)=>c.trackId===id),'Remove clips before removing their track');}
   }
   if(coll==='media'){touched.add('collection:media');if(op.op==='remove'||base){needed.add(`usage:${id}`);for(const c of [...this.p.clips.filter(c=>c.mediaId===id||c.effects?.some(e=>e.assetId===id)),...this.p.transitions.filter(t=>t.assetId===id)]){needed.add(`track:${c.trackId}`);requireFolder(c.trackId);if(trackLocked(next,c.trackId))fail('TRACK_LOCKED','Media is used by a locked track',{trackId:c.trackId});}}}
   if(coll==='clips'||coll==='transitions'){for(const trackId of new Set([old?.trackId,op.value?.trackId].filter(Boolean))){if(!created.has(`track:${trackId}`))needed.add(`track:${trackId}`);needed.add(`occupancy:${trackId}`);touched.add(`occupancy:${trackId}`);requireFolder(trackId);if(trackLocked(next,trackId))fail('TRACK_LOCKED','Cannot modify a locked track',{trackId});}if(coll==='clips'){if(old?.linkId||op.value?.linkId!==undefined)needed.add('project');for(const mediaId of new Set([old?.mediaId,op.value?.mediaId].filter(Boolean))){if(!created.has(`media:${mediaId}`))needed.add(`media:${mediaId}`);touched.add(`usage:${mediaId}`);} // Explicit clip time edits must land on current project grid; fps edits preserve existing times.
     if(op.op==='put'&&!derivedTimes)for(const k of ['start','duration','sourceIn','fadeIn','fadeOut'])if(op.value[k]!==undefined&&JSON.stringify(op.value[k])!==JSON.stringify(old?.[k])){const t=time(op.value[k],k);const n=BigInt(t.num)*BigInt(next.fps.num),d=BigInt(t.den)*BigInt(next.fps.den);assert(n%d===0n,'Edited clip times must land on the project frame grid',{clipId:id,field:k,fps:next.fps});}
   }else for(const clipId of [op.value?.fromClipId??old?.fromClipId,op.value?.toClipId??old?.toClipId])if(clipId&&!created.has(`clip:${clipId}`))needed.add(`clip:${clipId}`);}
   if(coll==='clips'||coll==='transitions'){
    const refs=(o:any)=>!o?[]:coll==='transitions'?[o.assetId]:(o.effects||[]).map((e:any)=>e.assetId);
    for(const assetId of new Set([...refs(old),...refs({...old,...op.value})].filter(Boolean))){if(!created.has(`media:${assetId}`))needed.add(`media:${assetId}`);touched.add(`usage:${assetId}`);}
   }
   if(op.op==='remove'){assert(old,'Cannot remove missing object',{id});arr.splice(index,1);}else {assert(op.value&&typeof op.value==='object','Missing value');const allowed:Record<string,string[]>={markers:['id','revision','name','time','color'],tracks:['id','revision','name','disabled','locked','folderId'],folders:['id','revision','name','disabled','locked','collapsed'],media:['id','revision','path','kind','duration','metadata'],clips:['id','revision','name','trackId','mediaId','start','duration','sourceIn','speed','stream','linkId','volume','volumePoints','mute','fadeIn','fadeOut','transform','text','params','seed','effects'],transitions:['id','revision','trackId','fromClipId','toClipId','duration','alignment','assetId','params','seed','audio']};assert(Object.keys(op.value).every(k=>allowed[coll].includes(k)),'Unsupported object field',{collection:coll,fields:Object.keys(op.value).filter(k=>!allowed[coll].includes(k))});let value={...(old||{}),...op.value,revision:(current[objectKey]??0)+1};if(coll==='folders')value={name:'Folder',disabled:false,locked:false,collapsed:false,...value};if(coll==='tracks')value={name:'Track',disabled:false,locked:false,...value};if(coll==='clips')value={sourceIn:ZERO,speed:ONE,volume:1,mute:false,fadeIn:ZERO,fadeOut:ZERO,...value};if(coll==='transitions')value={alignment:'center',audio:'crossfade',params:{},seed:Math.floor(Math.random()*0x100000000),assetId:next.media.find((m:any)=>m.metadata.builtin==='dissolve')?.id,...value};if(index>=0)arr[index]=value;else arr.push(value);}
  }
  const conflicts=[];for(const key of needed){const actual=current[key]??0;if(!Object.hasOwn(pre,key)||pre[key]!==actual)conflicts.push({key,expected:pre[key]??null,actual,reason:Object.hasOwn(pre,key)?'changed':'missing_precondition'});}if(conflicts.length)fail('CONFLICT','Batch rejected. Reread these revisions and retry the complete batch.',{conflicts});
  next.revision=this.p.revision+1;for(const key of touched)next.relationshipRevisions[key]=(current[key]??0)+1;const result=this.save(next);pruneGraphicSnapshots(this.dir,[this.p,...this.undo,...this.redo]);return result;
 }
 history(direction:'undo'|'redo'){this.requireUnlocked();const from=this[direction],to=this[direction==='undo'?'redo':'undo'];assert(from.length,`Nothing to ${direction}`);const current=structuredClone(this.p),previous=from[from.length-1],next=structuredClone(previous);next.revision=this.p.revision+1;const rev=revisions(this.p);for(const coll of Object.keys(singular))for(const o of next[coll]||[])o.revision=(rev[`${singular[coll]}:${o.id}`]??0)+1;const keys=new Set([...Object.keys(rev),...Object.keys(revisions(next))]);for(const key of keys)if(key!=='project')next.relationshipRevisions[key]=(rev[key]??0)+1;this.save(next,false);from.pop();to.push(current);
  restoreGraphicAuthors(this.dir,this.p,current);return this.inspect();
 }
}
