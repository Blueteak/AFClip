import {randomUUID} from 'node:crypto';
import {assert, cmp} from '../shared/project.ts';
import type {Project} from '../shared/project.ts';

const uid=(kind:string)=>`${kind}_${randomUUID().replaceAll('-','')}`;
const timing=['start','duration','sourceIn','speed'];
const put=(collection:string,value:any)=>({op:'put',collection,value});

export function audioOperations(project:Project, op:any) {
 const clip=project.clips.find(c=>c.id===op.clipId);
 assert(clip,'Clip not found',{clipId:op.clipId});
 if(op.op==='unlink') {
  assert(clip.linkId,'Clip is not linked');
  return project.clips.filter(c=>c.linkId===clip.linkId).map(c=>put('clips',{id:c.id,linkId:null}));
 }
 const media=project.media.find(m=>m.id===clip.mediaId)!;
 assert(media.kind==='video'&&media.metadata.hasAudio===true,'Detach Audio requires video with audio');
 assert(!clip.stream&&!clip.linkId,'Audio is already detached');
 assert(!project.transitions.some(t=>t.fromClipId===clip.id||t.toClipId===clip.id),'Remove the clip’s dissolves before detaching audio');
 const trackId=uid('track'), id=uid('clip'), linkId=uid('link');
 const {transform,...audio}=clip;
 return [put('tracks',{id:trackId,name:`${clip.name||'Clip'} audio`,disabled:project.tracks.find(t=>t.id===clip.trackId)!.disabled,locked:false}),
  put('clips',{id:clip.id,stream:'video',linkId}),
  put('clips',{...audio,id,trackId,name:`${clip.name||'Clip'} audio`,stream:'audio',linkId})];
}

// Timing edits act on the pair even through the CLI. Explicit edits to both
// halves must agree; appearance and audio settings remain independent.
export function linkedOperations(project:Project, operations:any[]) {
 const result=operations.map(op=>op.op==='put'?{...op,value:{...op.value}}:{...op});
 const updates=new Map<string,Record<string,any>>();
 for(const op of result) {
  if(op.op!=='put'||op.collection!=='clips')continue;
  const clip=project.clips.find(c=>c.id===op.value?.id);
  if(!clip?.linkId)continue;
  for(const key of timing)if(op.value[key]!==undefined) {
   const patch=updates.get(clip.linkId)||{};
   assert(patch[key]===undefined||cmp(patch[key],op.value[key])===0,'Linked clips require matching timing edits',{linkId:clip.linkId,field:key});
   patch[key]=op.value[key];updates.set(clip.linkId,patch);
  }
 }
 for(const [linkId,patch] of updates)for(const clip of project.clips.filter(c=>c.linkId===linkId)) {
  if(result.some(op=>op.collection==='clips'&&op.op==='remove'&&op.id===clip.id))continue;
  const edits=result.filter(op=>op.collection==='clips'&&op.op==='put'&&op.value.id===clip.id);
  const missing=Object.fromEntries(Object.entries(patch).filter(([key])=>!edits.some(op=>op.value[key]!==undefined)));
  if(Object.keys(missing).length)result.push(put('clips',{id:clip.id,...missing}));
 }
 // Removing one half or splitting a pair must not leave a one-item link.
 const links=new Map(project.clips.map(c=>[c.id,c.linkId]));
 for(const op of result)if(op.collection==='clips') {
  if(op.op==='remove')links.delete(op.id);
  else if(op.value.linkId!==undefined)links.set(op.value.id,op.value.linkId);
 }
 for(const [id,linkId] of links)if(linkId&&[...links.values()].filter(v=>v===linkId).length===1)result.push(put('clips',{id,linkId:null}));
 return result;
}
