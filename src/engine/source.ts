import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {libraryCommand} from '../library/client.ts';
import {assert, fail, time, cmp, sub, rational, ZERO, ONE} from '../shared/project.ts';

const id = (kind:string) => `${kind}_${randomUUID().replaceAll('-', '')}`;

export async function sourceJobs(state:any,c:any) {
  const media=state.p.media.find((m:any)=>m.id===c.id),link=media?.metadata?.library;
  assert(link,'Select registered audio or video from the project bin');
  const asset=await libraryCommand({command:'inspect',id:link.assetId,sourceId:link.sourceId,relationships:false});
  assert(asset.libraryId===link.libraryId&&asset.sourceMatches&&!asset.deleted&&!asset.purged,
    'The library source changed or was removed. Existing project media remains unchanged.');
  if(c.command==='source-prepare')return libraryCommand({command:'prepare',ids:[asset.id]});
  const matches=(job:any)=>[asset.sourceId,link.sourceId].includes(job.sourceId);
  if(c.command==='source-cancel') {
    const job=await libraryCommand({command:'jobs',id:c.jobId});
    assert(matches(job),'Job does not belong to this source');
    return libraryCommand({command:'cancel',id:job.id});
  }
  return (await libraryCommand({command:'jobs'})).filter(matches);
}

// Both callers submit the revisions they inspected. Selection never edits the library.
export async function insertSource(state:any, c:any) {
  state.requireUnlocked();
  const original = state.p.media.find((m:any) => m.id === c.id);
  assert(original, 'Source media is no longer in the project bin');
  const pre = {...c.preconditions};
  if (pre[`media:${original.id}`] !== original.revision)
    fail('CONFLICT', 'Source changed. Inspect it again before inserting.', {mediaId:original.id, actual:original.revision});
  // FPS is a dependency, but unrelated project edits need not reject insertion.
  assert(c.fps && cmp(time(c.fps), state.p.fps) === 0, 'Project frame rate changed. Inspect again before inserting.');
  let media = original;
  const operations:any[] = [];
  if (c.selection) {
    const link = original.metadata.library;
    assert(link, 'Register this source with library-sync before selecting a range');
    const selection = c.selection;
    assert(selection.sourceId === link.sourceId, 'Selection must use the saved source version');
    const item = await libraryCommand({command:'selection', id:link.assetId,
      revision:selection.revision, sourceId:selection.sourceId,
      startFrame:selection.startFrame, endFrame:selection.endFrame,
      startSample:selection.startSample, endSample:selection.endSample});
    assert(item.libraryId === link.libraryId && (item.matchedSourceId || item.sourceId) === link.sourceId && !item.deleted,
      'Library source changed. Reimport it explicitly to use the replacement.');
    media = {...original, id:id('media'), revision:0, metadata:{...original.metadata,
      library:{...link, rangeId:undefined, rangeRevision:undefined, temporary:true,
        start:item.start, end:item.end, boundaries:item.boundaries, name:c.name || item.name}}};
    pre[`media:${media.id}`] = 0;
    operations.push({op:'put', collection:'media', value:media});
  }
  const fps = state.p.fps;
  const grid = (t:any, up=false) => {
    const n = BigInt(t.num) * BigInt(fps.num), d = BigInt(t.den) * BigInt(fps.den);
    return rational((n + (up ? d - 1n : 0n)) / d * BigInt(fps.den), fps.num);
  };
  const at = time(c.at, 'Insertion time');
  assert(cmp(at,ZERO)>=0 && cmp(at,grid(at))===0, 'Insertion time must lie on the project frame grid');
  const link = media.metadata.library;
  let rangeStart, rangeEnd;
  if (c.range) {
    assert(!c.selection && ['audio','video'].includes(media.kind), 'Invalid source range');
    assert(Number.isFinite(c.range.start) && Number.isFinite(c.range.end), 'Invalid source range');
    assert(c.range.start >= 0 && c.range.end <= media.duration.num / media.duration.den, 'Range is outside the source');
    rangeStart = rational(Math.round(c.range.start * 1e9), 1e9);
    rangeEnd = c.range.end === media.duration.num / media.duration.den ? media.duration : rational(Math.round(c.range.end * 1e9), 1e9);
    assert(cmp(rangeStart,ZERO)>=0 && cmp(rangeEnd,rangeStart)>0 && cmp(rangeEnd,media.duration)<=0, 'Range is outside the source');
  }
  const start = grid(rangeStart || link?.start || ZERO, true);
  const end = grid(rangeEnd || link?.end || (['audio','video'].includes(media.kind) ? media.duration : {num:5,den:1}));
  assert(cmp(end,start)>0, 'Selection contains no complete project frame. Widen the selection.');
  let trackId = c.trackId;
  if (!trackId) {
    trackId = id('track'); pre[`track:${trackId}`] = 0; pre[`occupancy:${trackId}`] = 0;
    operations.push({op:'put',collection:'tracks',value:{id:trackId,name:c.name || link?.name || path.basename(media.path),disabled:false,locked:false}});
  }
  const clipId = id('clip'); pre[`clip:${clipId}`] = 0;
  operations.push({op:'put',collection:'clips',value:{id:clipId,trackId,mediaId:media.id,
    name:c.name || link?.name || path.basename(media.path),start:at,duration:sub(end,start),sourceIn:start,
    speed:ONE,volume:1,mute:false,fadeIn:ZERO,fadeOut:ZERO}});
  const result = state.batch({preconditions:pre,operations});
  return {...result, media:result.project.media.find((m:any)=>m.id===media.id),
    clip:result.project.clips.find((clip:any)=>clip.id===clipId)};
}
