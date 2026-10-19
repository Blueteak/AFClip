const { spawn } = require('node:child_process');
const fs = require('node:fs');
// One reusable decoded frame per live clip. Stream backpressure bounds everything ahead of it.
class Decoder {
  constructor(media, ffmpeg, targetIndex, logFile, stride = 1) {
    if (!Number.isSafeInteger(stride) || stride < 1) throw new Error('Invalid decode stride');
    this.stride = stride; this.nextIndex = targetIndex; this.framesRead = 0;
    this.media = media; this.index = targetIndex - 1; this.pending = null; this.offset = 0;
    this.buffer = Buffer.allocUnsafe(media.width * media.height * 4);
    const seek = Math.max(0, media.pts[targetIndex] - .00001);
    const size = media.previewSize ? `w=${media.width}:h=${media.height}:` : '';
    const filter = (stride > 1 ? `select=not(mod(n\\,${stride})),` : '') + (media.kind === 'image' ? (size ? `scale=${media.width}:${media.height},format=rgba` : 'format=rgba') : `scale=${size}in_color_matrix=bt709:in_range=tv:out_range=full,format=rgba`);
    // Full-resolution exports benefit from frame threading on Windows and macOS.
    // Preview keeps its bounded pool to avoid competing with interactive work.
    const threads = media.previewSize ? '4' : ['darwin', 'win32'].includes(process.platform) ? '0' : '2';
    const args = ['-hide_banner', '-v', 'error', ...(media.hwaccel ? ['-hwaccel', 'd3d11va'] : []), '-threads', threads, '-ss', String(seek), '-i', media.file,
      '-map', '0:v:0', '-an', '-sn', '-dn', '-vsync', '0', '-filter_threads', '1', '-vf', filter, '-pix_fmt', 'rgba', '-f', 'rawvideo', 'pipe:1'];
    this.child = spawn(ffmpeg, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    this.log = fs.createWriteStream(logFile, { flags: 'a' }); this.child.stderr.pipe(this.log);
    this.child.on('error', e => { this.error = e; this.child.stdout.destroy(e); });
    this.child.on('close', code => { if (code && !this.closed) this.error = new Error(`Decoder exited ${code}: ${media.file}`); this.log.end(); });
    this.reader = this.child.stdout[Symbol.asyncIterator]();
  }
  async read(index) {
    if (index < this.index) throw new Error('Decoder cannot read backward');
    while (this.index < index) {
      if (this.nextIndex > index) throw new Error('Requested frame is outside the planned decode stride');
      let filled = 0;
      while (filled < this.buffer.length) {
        if (!this.pending || this.offset === this.pending.length) {
          const r = await this.reader.next();
          if (r.done) throw this.error || new Error(`Source ended before frame ${index}: ${this.media.file}`);
          this.pending = r.value; this.offset = 0;
        }
        const size = Math.min(this.pending.length - this.offset, this.buffer.length - filled);
        // Consume skipped frames for exact decoder positioning, but only copy
        // the requested picture into the reusable RGBA buffer.
        if (this.nextIndex === index) this.pending.copy(this.buffer, filled, this.offset, this.offset + size);
        filled += size; this.offset += size;
      }
      this.index = this.nextIndex; this.nextIndex += this.stride; this.framesRead++;
    }
    return this.buffer;
  }
  close() { this.closed = true; this.child.stdout.destroy(); this.child.kill(); this.buffer = null; this.pending = null; }
}
function frameIndex(pts, time) {
  let low = 0, high = pts.length;
  while (low < high) { const mid = (low + high) >>> 1; if (pts[mid] <= time + 1e-7) low = mid + 1; else high = mid; }
  return Math.max(0, low - 1);
}
module.exports = { Decoder, frameIndex };
