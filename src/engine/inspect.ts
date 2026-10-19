import {assert,fail,revisions} from '../shared/project.ts';
import {projectChanges} from '../shared/cli-output.ts';

export function inspectProject(state:any,c:any={}) {
 const current=state.inspect();
 const collections=['media','tracks','clips','transitions','markers','folders'];
 if(c.since!==undefined){
  assert(!c.id&&!c.collection,'Use --since separately from --id/--collection');
  assert(Number.isSafeInteger(c.since)&&c.since>=0,'--since requires a nonnegative revision');
  const previous=[state.p,...state.undo,...state.redo].find(p=>p.revision===c.since);
  if(!previous)fail('HISTORY_UNAVAILABLE','Revision is no longer in session history. Run inspect for a fresh snapshot.',{revision:c.since});
  return projectChanges({project:previous,revisions:revisions(previous)},current);
 }
 if(!c.id&&!c.collection)return current;
 assert(!c.collection||collections.includes(c.collection),'Unknown collection',{collections});
 const selected=c.collection?[c.collection]:collections;
 const items=selected.flatMap(key=>(state.p[key]||[]).filter((o:any)=>!c.id||o.id===c.id));
 if(c.id)assert(items.length,'Object not found',{id:c.id});
 const ids=new Set(items.flatMap((o:any)=>[o.id,o.trackId,o.mediaId,o.folderId,o.assetId,o.fromClipId,o.toClipId,...(o.effects||[]).map((e:any)=>e.assetId)]).filter(Boolean));
 const keys=Object.fromEntries(Object.entries(current.revisions).filter(([key])=>key==='project'||key==='order:tracks'||key.startsWith('collection:')||ids.has(key.slice(key.indexOf(':')+1))));
 return {project:{id:state.p.id,revision:state.p.revision,fps:state.p.fps,resolution:state.p.resolution},items,revisions:keys};
}
