// Physical output sizing is independent of a vision API's detail parameter.
function reviewSize(value = 'review') {
  if (!['low', 'review', 'high', 'full'].includes(value)) throw new Error('Image size must be low, review, high or full');
  return value;
}
function reviewFilter(size, columns = 1, rows = 1, sheet = false) {
  const edge = { low: 512, review: 768, high: 1024, full: null }[reviewSize(size)];
  if (!edge) return 'null';
  const width = Math.floor((edge - (sheet ? 4 * (columns + 1) : 0)) / columns);
  const height = Math.floor((edge - (sheet ? 4 * (rows + 1) : 0)) / rows);
  return `scale=w='min(iw,${width})':h='min(ih,${height})':force_original_aspect_ratio=decrease:flags=lanczos`;
}
module.exports = { reviewSize, reviewFilter };
