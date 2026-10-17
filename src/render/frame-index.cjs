const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');

const VERSION = 2;
const DEFAULT_LIMIT = 64 * 1024 * 1024;
const cacheName = /^[a-f0-9]{64}(?:\.json|\.\d+\.[a-f0-9-]{36}\.tmp)$/;

function valid(pts) {
  return Array.isArray(pts) && pts.length > 0 && pts.every((value, i) =>
    Number.isFinite(value) && (i === 0 || value >= pts[i - 1]));
}

function decodeFrameTimestamps(probe) {
  const [num, den] = String(probe.streams?.[0]?.time_base || '').split('/').map(Number);
  if (!Number.isSafeInteger(num) || !Number.isSafeInteger(den) || num <= 0 || den <= 0) {
    throw new Error('Decoded frame index is missing a valid video time base');
  }
  // FFprobe's *_timestamp_time strings round to six decimals. At 30 fps this can
  // move a frame's boundary past its exact project time and select the prior frame.
  const pts = (probe.frames || []).map(frame => {
    const ticks = Number(frame.best_effort_timestamp);
    if (!Number.isSafeInteger(ticks)) throw new Error('Decoded frame index contains invalid timestamp ticks');
    return ticks * num / den;
  });
  if (!valid(pts)) throw new Error('Decoded frame index contains missing or unordered timestamps');
  return pts;
}

async function identity(file) {
  const resolved = await fs.realpath(file);
  const stat = await fs.stat(resolved);
  if (!stat.isFile()) throw new Error(`Video source is not a file: ${file}`);
  return { path: resolved, size: stat.size, mtimeMs: stat.mtimeMs, version: VERSION };
}

async function prune(cacheDir, limit) {
  const entries = [];
  for (const entry of await fs.readdir(cacheDir, { withFileTypes: true })) {
    if (!entry.isFile() || !cacheName.test(entry.name)) continue;
    const file = path.join(cacheDir, entry.name);
    try { const stat = await fs.stat(file); entries.push({ file, size: stat.size, touched: stat.mtimeMs }); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  let total = entries.reduce((sum, entry) => sum + entry.size, 0);
  entries.sort((a, b) => a.touched - b.touched);
  for (const entry of entries) {
    if (total <= limit) break;
    await fs.rm(entry.file, { force: true });
    total -= entry.size;
  }
}

// probe() belongs to the worker so its existing subprocess cancellation still applies.
// It must return decoded presentation timestamps, not packet DTS or assumed CFR times.
async function getFrameIndex({ file, cacheDir, probe, maxBytes = DEFAULT_LIMIT }) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new Error('Invalid frame-index cache limit');
  const before = await identity(file), fingerprint = JSON.stringify(before);
  const key = createHash('sha256').update(fingerprint).digest('hex');
  const cacheFile = path.join(cacheDir, `${key}.json`);
  if (maxBytes) {
    try {
      const stat = await fs.stat(cacheFile);
      if (stat.size <= maxBytes) {
        const cached = JSON.parse(await fs.readFile(cacheFile, 'utf8'));
        if (cached.fingerprint === fingerprint && valid(cached.pts)) {
          const now = new Date();
          await fs.utimes(cacheFile, now, now).catch(() => {});
          await prune(cacheDir, maxBytes).catch(() => {});
          return { pts: cached.pts, cacheHit: true, key };
        }
      }
    } catch { /* Missing, corrupt, or unavailable cache is regenerated from the source. */ }
  }
  // Honor a reduced or disabled cache budget even when the next index is too large
  // to cache. The directory need not exist on a project's first render.
  await prune(cacheDir, maxBytes).catch(() => {});

  const pts = await probe();
  if (!valid(pts)) throw new Error(`Missing or unordered decoded presentation timestamps: ${file}`);
  if (JSON.stringify(await identity(file)) !== fingerprint) {
    throw Object.assign(new Error(`Source changed while indexing: ${file}`), { code: 'SOURCE_CHANGED' });
  }

  if (maxBytes) {
    const contents = JSON.stringify({ fingerprint, pts });
    const bytes = Buffer.byteLength(contents);
    if (bytes <= maxBytes) {
      let temporary;
      try {
        await fs.mkdir(cacheDir, { recursive: true });
        // Reserve space before writing, so the temporary copy also fits the budget.
        await prune(cacheDir, maxBytes - bytes);
        temporary = path.join(cacheDir, `${key}.${process.pid}.${randomUUID()}.tmp`);
        await fs.writeFile(temporary, contents, { flag: 'wx' });
        await fs.rename(temporary, cacheFile);
        temporary = null;
        await prune(cacheDir, maxBytes);
      } catch { /* A disposable cache failure must not prevent an otherwise valid render. */ }
      finally { if (temporary) await fs.rm(temporary, { force: true }).catch(() => {}); }
    }
  }
  return { pts, cacheHit: false, key };
}

module.exports = { getFrameIndex, decodeFrameTimestamps };
