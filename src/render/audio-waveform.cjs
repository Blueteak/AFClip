// Shared source waveform data. Keep channel extrema rather than averaging audio
// down to an image, so transients and opposite-phase stereo remain visible.
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const ffmpeg = require('ffmpeg-static');
const memory = new Map(), waiting = [];
let active = 0;
async function limited(work) {
  if (active >= 2) await new Promise(resolve => waiting.push(resolve)); else active++;
  try { return await work(); }
  finally { const next = waiting.shift(); if (next) next(); else active--; }
}

async function audioWaveform(file, options) {
  const start = Number(options.start ?? 0), duration = Number(options.duration);
  const requestedBins = Number(options.bins ?? 16384), sampleRate = 48000;
  if (!Number.isFinite(start) || start < 0 || !Number.isFinite(duration) || duration <= 0) throw new Error('Invalid waveform time range');
  if (!Number.isSafeInteger(requestedBins) || requestedBins < 1 || requestedBins > 32768) throw new Error('Waveform bins must be an integer from 1 to 32768');
  const channels = Number(options.channels) === 1 ? 1 : 2;
  const bins = Math.max(1, Math.min(requestedBins, Math.ceil(duration * sampleRate)));
  const stat = await fs.stat(file);
  const key = createHash('sha256').update(JSON.stringify([path.resolve(file), stat.size, stat.mtimeMs, start, duration, bins, channels, 1])).digest('hex');
  if (memory.has(key)) return memory.get(key);
  const prefix = options.sourceId && /^source_[a-f0-9]+$/.test(options.sourceId) ? options.sourceId + '.' : '';
  const cacheFile = options.cacheDir ? path.join(options.cacheDir, `${prefix}waveform-v1-${key}.json`) : null;
  const task = limited(async () => {
    if (cacheFile) {
      try {
        const cached = JSON.parse(await fs.readFile(cacheFile, 'utf8'));
        if (cached.version === 1 && cached.bins === bins && cached.channels === channels && cached.lanes?.length === channels && cached.lanes.every(l => l.min.length === bins && l.max.length === bins && l.rms.length === bins)) return cached;
      } catch {}
    }
    const result = await decode(file, { start, duration, bins, channels, sampleRate });
    if (cacheFile) {
      const temp = cacheFile + '.' + randomUUID() + '.tmp';
      try { await fs.mkdir(path.dirname(cacheFile), { recursive: true }); await fs.writeFile(temp, JSON.stringify(result)); await fs.rename(temp, cacheFile); }
      catch { /* A full cache disk must not prevent source playback or inspection. */ }
      finally { await fs.rm(temp, { force: true }).catch(() => {}); }
    }
    return result;
  });
  memory.set(key, task);
  while (memory.size > 8) memory.delete(memory.keys().next().value);
  task.catch(() => { if (memory.get(key) === task) memory.delete(key); });
  return task;
}

function decode(file, { start, duration, bins, channels, sampleRate }) {
  return new Promise((resolve, reject) => {
    const lanes = Array.from({ length: channels }, () => ({ min: new Float32Array(bins).fill(Infinity), max: new Float32Array(bins).fill(-Infinity), sum: new Float64Array(bins) }));
    const counts = new Uint32Array(bins), frameBytes = channels * 4;
    let pending = Buffer.alloc(0), frame = 0, peak = 0, error = '', timedOut = false;
    const child = spawn(ffmpeg, ['-v', 'error', '-nostdin', '-ss', String(start), '-i', file, '-t', String(duration),
      '-map', '0:a:0', '-vn', '-ac', String(channels), '-ar', String(sampleRate), '-f', 'f32le', 'pipe:1'], { windowsHide: true });
    const timer = setTimeout(() => { timedOut = true; child.kill(); reject(new Error('Audio waveform preparation timed out')); }, 120000);
    child.stdout.on('data', chunk => {
      const bytes = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      const end = bytes.length - bytes.length % frameBytes;
      for (let i = 0; i < end; i += frameBytes) {
        const bin = Math.floor(frame++ * bins / (duration * sampleRate));
        if (bin >= bins) continue;
        counts[bin]++;
        for (let c = 0; c < channels; c++) {
          const value = bytes.readFloatLE(i + c * 4);
          if (!Number.isFinite(value)) continue;
          const lane = lanes[c];
          lane.min[bin] = Math.min(lane.min[bin], value); lane.max[bin] = Math.max(lane.max[bin], value);
          lane.sum[bin] += value * value; peak = Math.max(peak, Math.abs(value));
        }
      }
      pending = bytes.subarray(end);
    });
    child.stderr.on('data', bytes => { error = (error + bytes).slice(-2000); });
    child.on('error', err => { clearTimeout(timer); reject(err); });
    child.on('close', code => {
      clearTimeout(timer);
      if (timedOut) return;
      if (code || !frame) { reject(new Error(error || 'No audio samples could be decoded')); return; }
      const round = value => Number(value.toPrecision(7));
      resolve({ version: 1, start, duration, sampleRate, channels, bins, peak: round(peak),
        lanes: lanes.map((lane, c) => ({ label: channels === 1 ? 'Mono' : c === 0 ? 'Left' : 'Right',
          min: Array.from(lane.min, (v, i) => counts[i] ? round(v) : 0),
          max: Array.from(lane.max, (v, i) => counts[i] ? round(v) : 0),
          rms: Array.from(lane.sum, (v, i) => counts[i] ? round(Math.sqrt(v / counts[i])) : 0),
        })),
      });
    });
  });
}
module.exports = { audioWaveform };
