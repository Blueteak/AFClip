import path from 'node:path';
import {inspectMedia} from './probe.ts';
import {libraryCommand} from '../library/client.ts';
import {assert,fail,revisions,trackLocked,validateProject,sequenceProjects} from '../shared/project.ts';

export async function relinkMedia(state:any, library:any, command:any) {
  state.requireUnlocked();
  if(command.revision!==state.p.revision)
    fail('CONFLICT','Project changed. Inspect again before relinking.',{actual:state.p.revision});
  const old=state.p.media.find((m:any)=>m.id===command.id);
  assert(old&&old.kind!=='graphic','Select video, audio or an image to relink');
  assert(typeof command.path==='string'&&path.isAbsolute(command.path),'Relink requires an absolute file path');
  for(const view of sequenceProjects(state.p))for(const clip of view.clips.filter((c:any)=>c.mediaId===old.id))
    if(trackLocked(view,clip.trackId))fail('TRACK_LOCKED','Media is used by a locked track',{trackId:clip.trackId});
  let media:any=await inspectMedia(command.path);
  assert(media.kind===old.kind,'Replacement must have the same media kind');
  assert(old.kind!=='video'||!!media.metadata.hasAudio===!!old.metadata.hasAudio,
    'Replacement video must preserve the presence of audio');
  media={...media,id:old.id,revision:old.revision};
  // Check cuts, automation and transition handles before registering anything.
  validateProject({...state.p,media:state.p.media.map((m:any)=>m.id===old.id?media:m)});
  try {
    media=await library.register(media);
    const previous=old.metadata.library,next=media.metadata.library;
    if(previous&&next&&previous.libraryId===next.libraryId&&previous.assetId===next.assetId) {
      const asset=await libraryCommand({command:'inspect',id:next.assetId,sourceId:previous.sourceId,relationships:false});
      if(asset.sourceMatches)media.metadata.library={...previous,...next};
    }
    const pre=revisions(state.p);pre[`usage:${old.id}`]??=0;
    const result=state.batch({preconditions:pre,operations:[{op:'put',collection:'media',value:media}]});
    return {...result,media:result.project.media.find((m:any)=>m.id===old.id)};
  } finally { await library.sync(); }
}
