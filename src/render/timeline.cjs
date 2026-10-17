const seconds = value => typeof value === 'number' ? value : value ? value.num / value.den : 0;
const clamp = x => Math.max(0, Math.min(1, x));
function compile(project) {
  const media = new Map(project.media.map(m => [m.id, m]));
  const tracks = new Map(project.tracks.map((t, index) => [t.id, { ...t, index }]));
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
    const tr = { ...t, start, end: start + duration, duration };
    a.visibleEnd = Math.max(a.visibleEnd, tr.end); b.visibleStart = Math.min(b.visibleStart, tr.start);
    a.transitions.push({ ...tr, side: 'out' }); b.transitions.push({ ...tr, side: 'in' });
  }
  return { clips: clips.sort((a, b) => a.track.index - b.track.index || a.start - b.start), duration: Math.max(0, ...project.clips.map(c => seconds(c.start) + seconds(c.duration))) };
}
function at(plan, time) {
  return plan.clips.filter(c => time >= c.visibleStart - 1e-8 && time < c.visibleEnd - 1e-8).map(c => {
    let visual = 1, audio = c.mute ? 0 : (c.volume ?? 1);
    const local = time - c.start;
    const fade = (c.fadeIn ? clamp(local / c.fadeIn) : 1) * (c.fadeOut ? clamp((c.duration - local) / c.fadeOut) : 1);
    visual *= fade; audio *= fade;
    for (const tr of c.transitions) if (time >= tr.start && time < tr.end) {
      const p = clamp((time - tr.start) / tr.duration);
      if (tr.side === 'in') { visual *= p; audio *= p; } else audio *= 1 - p;
    }
    return { clipId: c.id, mediaId: c.mediaId, kind: c.media.kind, sourceTime: c.sourceIn + local * c.speed,
      opacity: visual * (c.transform?.opacity ?? 1), volume: audio, transform: c.transform || {}, track: c.track.index };
  });
}
if (typeof module !== 'undefined') module.exports = { seconds, compile, at };
else window.ReeletTimeline = { seconds, compile, at };
