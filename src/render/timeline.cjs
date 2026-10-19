const seconds = value => typeof value === 'number' ? value : value ? value.num / value.den : 0;
const clamp = x => Math.max(0, Math.min(1, x));
const easeInOut = value => { const x = clamp(value); return x * x * (3 - 2 * x); };
// A lone point gets temporary unity-gain anchors at the clip boundaries. They
// are derived, never saved, so deleting/adding points needs no special cleanup.
function automationPoints(clip) {
  const points = clip.volumePoints || [];
  if (points.length !== 1) return points;
  const start = seconds(clip.sourceIn), end = start + seconds(clip.duration) * (clip.speed == null ? 1 : seconds(clip.speed));
  const at = seconds(points[0].time);
  const anchors = [];
  if (at !== start) anchors.push({ time: start, value: 1, implicit: true });
  if (at !== end) anchors.push({ time: end, value: 1, implicit: true });
  return [...points, ...anchors].sort((a, b) => seconds(a.time) - seconds(b.time));
}
// Explicit points live in source time. Hold the first/last effective value
// outside the envelope, including transition handles beyond the clip edges.
function automationGain(clip, local) {
  const points = automationPoints(clip);
  if (!points.length) return 1;
  const source = seconds(clip.sourceIn) + local * (clip.speed == null ? 1 : seconds(clip.speed));
  let lo = 0, hi = points.length - 1;
  if (source <= seconds(points[lo].time)) return points[lo].value;
  if (source >= seconds(points[hi].time)) return points[hi].value;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (source < seconds(points[mid].time)) hi = mid; else lo = mid; }
  const a = points[lo], b = points[hi];
  return a.value + (b.value - a.value) * easeInOut((source - seconds(a.time)) / (seconds(b.time) - seconds(a.time)));
}
function audioGain(clip, local) {
  if (clip.mute || clip.stream === 'video') return 0;
  const fi = seconds(clip.fadeIn), fo = seconds(clip.fadeOut);
  return (clip.volume ?? 1) * automationGain(clip, local)
    * (fi ? easeInOut(local / fi) : 1) * (fo ? easeInOut((seconds(clip.duration) - local) / fo) : 1);
}
// Balanced branches keep FFmpeg expression depth bounded for longer envelopes.
function automationExpression(points, source) {
  if (!points?.length) return '1';
  if (points.length === 1) return String(points[0].value);
  function segment(lo, hi) {
    if (hi - lo === 1) {
      const a = points[lo], b = points[hi], delta = b.value - a.value;
      const x = `max(0,min(1,(${source}-${seconds(a.time)})/${seconds(b.time) - seconds(a.time)}))`;
      return delta === 0 ? String(a.value) : `(${a.value}+(${delta})*(${x})*(${x})*(3-2*(${x})))`;
    }
    const mid = (lo + hi) >> 1;
    return `if(lt(${source},${seconds(points[mid].time)}),${segment(lo, mid)},${segment(mid, hi)})`;
  }
  return segment(0, points.length - 1);
}
function compile(project) {
  const media = new Map(project.media.map(m => [m.id, m]));
  const folders = new Map((project.folders || []).map(f => [f.id, f]));
  const tracks = new Map(project.tracks.map((t, index) => [t.id, { ...t, disabled: t.disabled || !!folders.get(t.folderId)?.disabled, index }]));
  const clips = project.clips.filter(c => !tracks.get(c.trackId)?.disabled).map(c => {
    const start = seconds(c.start), duration = seconds(c.duration);
    return { ...c, media: media.get(c.mediaId), track: tracks.get(c.trackId), start, duration, end: start + duration,
      sourceIn: seconds(c.sourceIn), speed: c.speed ? seconds(c.speed) : 1, visibleStart: start, visibleEnd: start + duration,
      fadeIn: seconds(c.fadeIn), fadeOut: seconds(c.fadeOut), transitions: [] };
  });
  const byId = new Map(clips.map(c => [c.id, c]));
  for (const t of project.transitions || []) {
    const a = byId.get(t.fromClipId), b = byId.get(t.toClipId); if (!a || !b) continue;
    const duration = seconds(t.duration), start = b.start - (t.alignment === 'start' ? 0 : t.alignment === 'end' ? duration : duration / 2);
    const tr = { ...t, asset:media.get(t.assetId)?.metadata.asset, cut:b.start, start, end: start + duration, duration };
    a.visibleEnd = Math.max(a.visibleEnd, tr.end); b.visibleStart = Math.min(b.visibleStart, tr.start);
    a.transitions.push({ ...tr, side: 'out' }); b.transitions.push({ ...tr, side: 'in' });
  }
  return { clips: clips.sort((a, b) => a.track.index - b.track.index || a.start - b.start), duration: Math.max(0, ...project.clips.map(c => seconds(c.start) + seconds(c.duration))) };
}
function at(plan, time) {
  return plan.clips.filter(c => time >= c.visibleStart - 1e-8 && time < c.visibleEnd - 1e-8).map(c => {
    const local = time - c.start;
    let visual = 1, audio = audioGain(c, local), transition;
    const rawTime=c.sourceIn+local*c.speed, sourceDuration=seconds(c.media.duration);
    if(rawTime<0||rawTime>=sourceDuration)audio=0;
    const fadeIn = c.fadeIn ? clamp(local / c.fadeIn) : 1;
    const fadeOut = c.fadeOut ? clamp((c.duration - local) / c.fadeOut) : 1;
    visual *= fadeIn * fadeOut;
    // Match the visibility tolerance so both sides of a cut agree at window edges.
    for (const tr of c.transitions) if (time >= tr.start - 1e-8 && time < tr.end - 1e-8) {
      const p = clamp((time - tr.start) / tr.duration);
      transition={...tr,progress:p,time:time-tr.start};
      if(tr.audio==='cut')audio*=tr.side==='in'?(time>=tr.cut?1:0):(time<tr.cut?1:0);
      else audio*=tr.side==='in'?p:1-p;
    }
    return { clipId: c.id, mediaId: c.mediaId, kind: c.stream === 'audio' ? 'audio' : c.media.kind, sourceTime: ['video','audio'].includes(c.media.kind)?Math.max(0,Math.min(rawTime,Math.max(0,sourceDuration-1e-7))):Math.max(0,rawTime),
      held:rawTime<0||rawTime>=sourceDuration, transition, effects:c.effects||[], params:c.params||{}, seed:c.seed||0, time:local, duration:c.duration, progress:clamp(local/c.duration),
      text: c.text || {}, opacity: visual * (c.transform?.opacity ?? 1), volume: audio, transform: c.transform || {}, track: c.track.index };
  });
}
if (typeof module !== 'undefined') module.exports = { seconds, compile, at, easeInOut, automationPoints, automationGain, audioGain, automationExpression };
else window.AFClipTimeline = { seconds, compile, at, easeInOut, automationPoints, automationGain, audioGain };
