// Regenerable, bounded seek-only JPEG packets. Playback/export use originals.
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');

module.exports = async function prepareSeekCache({ media, plan, directory, budget, ffmpeg, ffprobe, run, progress }) {
  const started = performance.now(); let hits = 0, built = 0;
  await fs.mkdir(directory, { recursive:true });
  const wanted = [], cached = new Set();
  for (const [id, m] of Object.entries(media)) {
    if (m.kind !== 'video' || !m.file || !m.pts?.length) continue;
    const clips = plan.clips.filter(c => c.mediaId === id);
    if (!clips.length) continue;
    const begin = Math.max(0, Math.min(...clips.map(c => c.sourceIn + (c.visibleStart - c.start) * c.speed)));
    const end = Math.max(...clips.map(c => c.sourceIn + (c.visibleEnd - c.start) * c.speed));
    let first = 0; while (first + 1 < m.pts.length && m.pts[first + 1] <= begin + 1e-7) first++;
    let last = first; while (last + 1 < m.pts.length && m.pts[last + 1] < end + 1e-7) last++;
    const stat = await fs.stat(m.file);
    const key = createHash('sha256').update(JSON.stringify([2,path.resolve(m.file),stat.size,stat.mtimeMs,first,last,960,540,5])).digest('hex');
    wanted.push({ id, m, first, last, key }); cached.add(key);
  }
  // Only cache-owned names are eligible for eviction, never source files.
  const names = (await fs.readdir(directory)).filter(n => /^[a-f0-9]{64}\.(mjpg|json)$/.test(n));
  let bytes = 0;
  for (const name of names) {
    const file = path.join(directory, name);
    if (!cached.has(name.slice(0,64))) await fs.unlink(file);
    else bytes += (await fs.stat(file)).size;
  }
  for (const item of wanted) {
    const { id, m, first, last, key } = item;
    const file = path.join(directory, key + '.mjpg'), manifest = path.join(directory, key + '.json');
    try {
      const index = JSON.parse(await fs.readFile(manifest, 'utf8')), stat = await fs.stat(file);
      if (index.bytes === stat.size && index.first === first && index.frames.length === last-first+1 && bytes <= budget) {
        m.seekProxy = { file, first, frames:index.frames, width:index.width, height:index.height }; hits++; continue;
      }
    } catch { /* Absent/incomplete cache is rebuilt. */ }
    for (const old of [file,manifest]) { try { bytes -= (await fs.stat(old)).size; await fs.unlink(old); } catch {} }
    const remaining = budget - bytes;
    if (remaining < 1024 * 1024) continue;
    const temporary = path.join(directory, key + '.' + randomUUID() + '.tmp.mjpg');
    progress?.(id);
    try {
      await run('seek-' + id, ffmpeg, ['-hide_banner','-y','-i',m.file,'-map','0:v:0','-an',
        '-vf',`trim=start_frame=${first}:end_frame=${last+1},scale=w='min(960,iw)':h='min(540,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2:in_color_matrix=bt709:out_color_matrix=bt601:out_range=pc`,
        '-frames:v',String(last-first+1),'-c:v','mjpeg','-q:v','5','-fps_mode','passthrough','-fs',String(Math.max(0,remaining-1024*1024)),'-f','mjpeg',temporary]);
      const probe = JSON.parse((await run('seek-index-' + id, ffprobe, ['-v','error','-f','mjpeg','-show_packets','-show_streams','-show_entries','packet=pos,size:stream=width,height','-of','json',temporary], true)).toString());
      const frames = probe.packets.map(p => [Number(p.pos),Number(p.size)]), stat = await fs.stat(temporary);
      const index = { first, frames, bytes:stat.size, width:probe.streams[0].width, height:probe.streams[0].height };
      const json = JSON.stringify(index);
      if (frames.length !== last-first+1 || stat.size+Buffer.byteLength(json)>remaining || frames.some(([p,s])=>!Number.isSafeInteger(p)||!Number.isSafeInteger(s)||p<0||s<=0||p+s>stat.size)) continue;
      await fs.rename(temporary,file); await fs.writeFile(manifest,json);
      bytes += stat.size + Buffer.byteLength(json);
      m.seekProxy = { file, first, frames, width:index.width, height:index.height };
      built++;
    } catch (error) {
      if (error.code === 'CANCELLED') throw error;
      // Seek acceleration is optional. The original decoder remains available.
      process.stderr.write(`Seek cache unavailable for ${id}: ${error.message}\n`);
    } finally { await fs.rm(temporary,{force:true}).catch(()=>{}); }
  }
  return { bytes, budget, sources:wanted.length, hits, built, ms:performance.now()-started };
};
