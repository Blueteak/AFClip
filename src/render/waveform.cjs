// Disposable, bounded peak data. Decode only the requested source section.
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const ffmpeg = require('ffmpeg-static');
const cache = new Map();
let queue = Promise.resolve();

async function waveform(file, start, duration) {
  if (!Number.isFinite(start) || start < 0 || !Number.isFinite(duration) || duration <= 0) throw new Error('Invalid waveform range');
  const stat = await fs.stat(file);
  const key = JSON.stringify([file, stat.size, stat.mtimeMs, start, duration]);
  if (cache.has(key)) return cache.get(key);
  const result = queue.then(() => decode(file, start, duration));
  queue = result.catch(() => {});
  cache.set(key, result);
  while (cache.size > 64) cache.delete(cache.keys().next().value);
  result.catch(() => cache.delete(key));
  return result;
}

function decode(file, start, duration) {
  return new Promise((resolve, reject) => {
    const count = 2048, sampleRate = 48000, peaks = new Float32Array(count);
    const child = spawn(ffmpeg, ['-v', 'error', '-ss', String(start), '-i', file, '-t', String(duration),
      '-map', '0:a:0', '-vn', '-ac', '2', '-ar', String(sampleRate), '-f', 'f32le', 'pipe:1'], { windowsHide: true });
    let pending = Buffer.alloc(0), sample = 0, error = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('Waveform preparation timed out')); }, 120000);
    child.stdout.on('data', chunk => {
      const bytes = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      const end = bytes.length - bytes.length % 4;
      for (let i = 0; i < end; i += 4) {
        const bin = Math.floor(sample++ / (duration * sampleRate * 2) * count);
        if (bin < count) peaks[bin] = Math.max(peaks[bin], Math.abs(bytes.readFloatLE(i)));
      }
      pending = bytes.subarray(end);
    });
    child.stderr.on('data', bytes => { error = (error + bytes).slice(-2000); });
    child.on('error', err => { clearTimeout(timer); reject(err); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code) reject(new Error(error || 'Waveform decode failed'));
      else resolve(Array.from(peaks));
    });
  });
}
module.exports = { waveform };
