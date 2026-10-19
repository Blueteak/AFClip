const {at} = require('./timeline.cjs');
const {frameIndex} = require('./decoder.cjs');

// Only discard frames when every actual timeline request agrees on a stride.
// VFR, noninteger speed ratios, transition handles and held frames all use the
// same timestamp lookup as the compositor. A mixed cadence falls back to 1.
module.exports = function decodeStrides(plan, media, begin, end, fps) {
  const result = {};
  const gcd = (a, b) => { while (b) [a, b] = [b, a % b]; return a; };
  const count = Math.ceil((end - begin) * fps - 1e-8);
  for (const clip of plan.clips) {
    if (clip.media.kind !== 'video' || clip.stream === 'audio' || !media[clip.mediaId]?.pts) continue;
    let previous, stride = 0;
    // Bound work by the clip's visible interval, including transition handles.
    // Let at() decide the exact boundary, using its existing epsilon rules.
    const first = Math.max(0, Math.floor((clip.visibleStart - begin) * fps) - 1);
    const last = Math.min(count, Math.ceil((clip.visibleEnd - begin) * fps) + 1);
    for (let frame = first; frame < last; frame++) {
      const [item] = at({clips: [clip]}, begin + frame / fps);
      if (!item) continue;
      const index = frameIndex(media[item.mediaId].pts, item.sourceTime);
      if (previous !== undefined) {
        const delta = index - previous;
        stride = delta < 0 ? 1 : gcd(stride, delta);
        if (stride === 1) break;
      }
      previous = index;
    }
    if (previous !== undefined) result[clip.id] = stride || 1;
  }
  return result;
};
