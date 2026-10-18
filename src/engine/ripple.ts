import {randomUUID} from 'node:crypto';
import {add, sub, mul, cmp, time, assert, ZERO} from '../shared/project.ts';
import type {Project, Clip, Time} from '../shared/project.ts';

// The caller commits this complete plan as one edit. Derived source times need
// not land on the video-frame grid when a clip has a fractional playback speed.
export function rippleOperations(project:Project, start:Time, end:Time) {
 start=time(start,'Ripple start');end=time(end,'Ripple end');
 assert(cmp(start,ZERO)>=0&&cmp(end,start)>0,'Ripple range must have 0 <= start < end');
 for(const t of [start,end])assert((BigInt(t.num)*BigInt(project.fps.num))%(BigInt(t.den)*BigInt(project.fps.den))===0n,'Ripple boundaries must land on the project frame grid');
 const delta=sub(end,start), operations:any[]=[], newIds:string[]=[];
 const pieces=new Map<string,{first:Clip;last:Clip}>();
 const put=(collection:string,value:any)=>operations.push({op:'put',collection,value});
 const remove=(collection:string,id:string)=>operations.push({op:'remove',collection,id});
 const min=(a:Time,b:Time)=>cmp(a,b)<0?a:b;
 for(const clip of project.clips){
  const finish=add(clip.start,clip.duration);
  if(cmp(finish,start)<=0){pieces.set(clip.id,{first:clip,last:clip});continue;}
  if(cmp(clip.start,end)>=0){
   const moved={...clip,start:sub(clip.start,delta)};
   put('clips',{id:clip.id,start:moved.start});pieces.set(clip.id,{first:moved,last:moved});continue;
  }
  const left=cmp(clip.start,start)<0, right=cmp(finish,end)>0;
  if(!left&&!right){remove('clips',clip.id);continue;}
  let first:Clip|undefined,last:Clip|undefined;
  if(left){
   const duration=sub(start,clip.start);
   first={...clip,duration,fadeIn:min(clip.fadeIn,duration),fadeOut:ZERO};
   put('clips',{id:clip.id,duration,fadeIn:first.fadeIn,fadeOut:ZERO});last=first;
  }
  if(right){
   const duration=sub(finish,end), id=left?`clip_${randomUUID().replaceAll('-','')}`:clip.id;
   last={...clip,id,start,sourceIn:add(clip.sourceIn,mul(sub(end,clip.start),clip.speed)),duration,fadeIn:ZERO,fadeOut:min(clip.fadeOut,duration)};
   if(left)newIds.push(id);
   put('clips',last);first||=last;
  }
  pieces.set(clip.id,{first:first!,last:last!});
 }
 for(const tr of project.transitions){
  const outgoing=pieces.get(tr.fromClipId)?.last, incoming=pieces.get(tr.toClipId)?.first;
  const cut=project.clips.find(c=>c.id===tr.toClipId)!.start;
  const before=tr.alignment==='start'?ZERO:tr.alignment==='end'?tr.duration:mul(tr.duration,{num:1,den:2});
  const trStart=sub(cut,before),trEnd=add(trStart,tr.duration);
  if(!outgoing||!incoming||(cmp(trStart,end)<0&&cmp(trEnd,start)>0)){
   remove('transitions',tr.id);continue;
  }
  if(outgoing.id!==tr.fromClipId||incoming.id!==tr.toClipId)put('transitions',{id:tr.id,fromClipId:outgoing.id,toClipId:incoming.id});
 }
 for(const marker of project.markers || []){
  if(cmp(marker.time,start)<0)continue;
  if(cmp(marker.time,end)<0)remove('markers',marker.id);
  else put('markers',{id:marker.id,time:sub(marker.time,delta)});
 }
 return {operations,newIds};
}
