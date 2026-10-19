// A disposable Node worker owns media subprocesses. The project engine remains independent.
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { performance } = require('node:perf_hooks');
const ffmpeg = require('ffmpeg-static'), ffprobe = require('../shared/ffprobe.cjs');
const { compile, seconds, automationPoints, automationExpression } = require('./timeline.cjs');
const { getFrameIndex, decodeFrameTimestamps } = require('./frame-index.cjs');
const { verifyOutput } = require('./verify.cjs');
const config = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const work = path.join(path.dirname(process.argv[2]), 'render');
const children = new Set(); let cancelled = false, partial;
const emit = data => process.stdout.write(JSON.stringify(data) + '\n');
function cancelCheck() { if (cancelled || fs.existsSync(config.cancelFile)) { cancelled = true; throw Object.assign(new Error('Render cancelled'), { code: 'CANCELLED' }); } }
function kill(child) { if (!child.pid) return; if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); else child.kill('SIGTERM'); }
const cancellation = setInterval(() => { if (fs.existsSync(config.cancelFile)) { cancelled = true; for (const child of children) kill(child); } }, 150);
async function run(name, binary, args, capture = false, forward = false) {
  cancelCheck();
  return new Promise((resolve, reject) => {
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(binary, args, { windowsHide: true, env, stdio: ['ignore', 'pipe', 'pipe'] }); children.add(child);
    const log = fs.createWriteStream(path.join(work, `${name}.log`)); const chunks = []; let bytes = 0;
    child.stderr.pipe(log); if (forward) child.stdout.pipe(process.stdout, { end: false });
    else child.stdout.on('data', b => { if (capture) { bytes += b.length; if (bytes > 128 * 1024 * 1024) { kill(child); reject(new Error('Media index exceeds the worker metadata limit')); } else chunks.push(b); } });
    child.on('error', e => { children.delete(child); log.end(); reject(e); });
    child.on('close', code => { children.delete(child); log.end(); if (cancelled) reject(Object.assign(new Error('Render cancelled'), { code: 'CANCELLED' })); else if (code !== 0) reject(new Error(`${name} exited ${code}. See ${path.join(work, `${name}.log`)}`)); else resolve(Buffer.concat(chunks)); });
  });
}
async function audioMix(plan, begin, end) {
  const args = ['-hide_banner', '-y'], filters = [], names = []; let n = 0;
  for (const c of plan.clips) {
    if (c.stream === 'video' || !c.media.metadata.hasAudio || c.mute || c.volume === 0 || c.visibleEnd <= begin || c.visibleStart >= end) continue;
    const start = Math.max(begin,c.visibleStart,c.start-c.sourceIn/c.speed), finish = Math.min(end,c.visibleEnd,c.start+(seconds(c.media.duration)-c.sourceIn)/c.speed), length = finish-start;
    if(length<=0)continue;
    const source = c.sourceIn + (start - c.start) * c.speed;
    args.push('-ss', String(Math.max(0, source)), '-t', String(length * c.speed), '-i', path.resolve(config.projectDir, c.media.path));
    const terms = [String(c.volume ?? 1)], local = `(t+${start - c.start})`;
    if (c.volumePoints?.length) terms.push(automationExpression(automationPoints(c), `(${c.sourceIn}+${local}*${c.speed})`));
    const ease = value => { const x = `max(0,min(1,${value}))`; return `(${x})*(${x})*(3-2*(${x}))`; };
    if (c.fadeIn) terms.push(ease(`${local}/${c.fadeIn}`));
    if (c.fadeOut) terms.push(ease(`(${c.duration}-${local})/${c.fadeOut}`));
    for (const tr of c.transitions) if(tr.audio==='cut')terms.push(tr.side==='in'?`gte(t+${start},${tr.cut})`:`lt(t+${start},${tr.cut})`);else terms.push(tr.side === 'in' ? `max(0,min(1,(t+${start - tr.start})/${tr.duration}))` : `max(0,min(1,(${tr.end - start}-t)/${tr.duration}))`);
    const label = `a${n}`;
    // Normalize layout before aeval; the bundled FFmpeg can crash on mono c=same.
    const gain = c.volumePoints?.length ? `aformat=channel_layouts=stereo,aeval='val(ch)*(${terms.join('*')})':c=same` : `volume='${terms.join('*')}':eval=frame`;
    filters.push(`[${n}:a:0]aresample=48000,asetrate=${Math.round(48000 * c.speed)},aresample=48000,atrim=duration=${length},asetpts=PTS-STARTPTS,${gain},adelay=${Math.round((start - begin) * 48000)}S:all=1[${label}]`);
    names.push(`[${label}]`); n++;
  }
  const output = path.join(work, 'audio.wav');
  if (!n) await run('audio', ffmpeg, ['-hide_banner', '-y', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo', '-t', String(end - begin), '-c:a', 'pcm_s16le', output]);
  else {
    filters.push(`${names.join('')}amix=inputs=${n}:normalize=0:duration=longest,apad,atrim=duration=${end - begin},alimiter=limit=0.95:level=0:latency=1[mix]`);
    const filterFile = path.join(work, 'audio-filter.txt'); fs.writeFileSync(filterFile, filters.join(';'));
    await run('audio', ffmpeg, [...args, '-filter_complex_script', filterFile, '-map', '[mix]', '-ar', '48000', '-ac', '2', '-c:a', 'pcm_s16le', output]);
  }
  return { output, clips: n };
}
async function main() {
  fs.mkdirSync(work, { recursive: true }); cancelCheck();
  const started = performance.now(), project = config.project, plan = compile(project);
  if (config.kind === 'preview-audio') {
    const audio = await audioMix(plan, 0, plan.duration);
    cancelCheck();
    fs.renameSync(audio.output, config.output);
    emit({ type: 'complete', output: config.output });
    return;
  }
  const width = project.resolution.width, height = project.resolution.height;
  if (width > 4096 || height > 4096) throw new Error('This renderer supports even dimensions up to 4096 pixels per side');
  const begin = config.kind === 'frame' ? seconds(config.frameTime) : config.range ? seconds(config.range.start) : 0;
  const end = config.kind === 'frame' ? begin : config.range ? seconds(config.range.end) : plan.duration;
  const used = new Set(plan.clips.filter(c => config.kind === 'frame' ? begin >= c.visibleStart && begin < c.visibleEnd : c.visibleEnd > begin && c.visibleStart < end).map(c => c.mediaId));
  for(const c of plan.clips)if(used.has(c.mediaId)){for(const e of c.effects||[])used.add(e.assetId);for(const tr of c.transitions)used.add(tr.assetId);}
  const media = {}, graphics = {}, indexing = []; let prepared = 0, indexCacheHits = 0;
  emit({ type: 'progress', phase: 'prepare', progress: 0, message: 'Inspecting source timestamps and graphics' });
  for (const m of project.media) {
    if (!used.has(m.id)) { media[m.id] = { kind: m.kind }; continue; }
    if(m.metadata.assetError)throw new Error(`${m.metadata.asset?.name||m.id}: ${m.metadata.assetError}`);
    cancelCheck(); const file = path.resolve(config.projectDir, m.path);
    if (!fs.existsSync(file)) throw new Error(`Missing source: ${file}`);
    media[m.id] = { kind: m.kind, file };
    if (m.kind === 'graphic') {
      const snapshot = path.join(work, 'graphics', m.id); fs.mkdirSync(snapshot, { recursive: true });
      const root = fs.realpathSync(file); let assetBytes = 0;
      function copy(dir, dest) { for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isSymbolicLink()) throw new Error('Graphic symlinks are unsupported');
        const src = path.join(dir, entry.name), dst = path.join(dest, entry.name);
        if (entry.isDirectory()) { fs.mkdirSync(dst); copy(src, dst); }
        else { assetBytes += fs.statSync(src).size; if (assetBytes > 128 * 1024 * 1024) throw new Error('Graphic snapshot exceeds 128 MiB'); fs.copyFileSync(src, dst); }
      } }
      copy(root, snapshot);
      graphics[m.id] = { asset:m.metadata.asset, root: snapshot, url: `afclip-graphic://${m.id}/index.html`, width: m.metadata.asset ? width : m.metadata.logicalWidth || 1920, height: m.metadata.asset ? height : m.metadata.logicalHeight || 1080 };
    } else if (m.kind === 'video' || m.kind === 'image') {
      if (m.kind === 'video' && (m.metadata.colorSpace !== 'bt709' || m.metadata.colorTransfer !== 'bt709' || m.metadata.colorRange === 'pc')) throw new Error(`This SDR renderer needs tagged limited-range BT.709 video: ${file}`);
      const indexStarted = performance.now();
      const indexed = m.kind === 'image' ? { pts: [0], cacheHit: false, method: 'image' } : await getFrameIndex({
        file, cacheDir: path.join(config.projectDir, 'cache', 'frame-index'),
        packetProbe: async () => JSON.parse((await run(`packets-${m.id}`, ffprobe, ['-v', 'error', '-select_streams', 'v:0', '-show_packets', '-show_entries', 'packet=pts,dts,flags:stream=id,codec_name,codec_tag_string,time_base,nb_frames,field_order,start_pts:format=format_name', '-of', 'json', file], true)).toString()),
        // The Apple Silicon probe defaults to one decode thread. Keep exact
        // decoded timestamps, but let it use the available cores on macOS.
        probe: async () => decodeFrameTimestamps(JSON.parse((await run(`index-${m.id}`, ffprobe, ['-v', 'error', ...(process.platform === 'darwin' ? ['-threads', '0'] : []), '-select_streams', 'v:0', '-show_frames', '-show_entries', 'frame=best_effort_timestamp:stream=time_base', '-of', 'json', file], true)).toString()))
      });
      indexing.push({ mediaId: m.id, method: indexed.method, cacheHit: indexed.cacheHit, frames: indexed.pts.length, ms: performance.now() - indexStarted });
      const index = indexed.pts; if (indexed.cacheHit) indexCacheHits++;
      if (!index.length || index.some(x => !Number.isFinite(x))) throw new Error(`Missing presentation timestamps: ${file}`);
      const stream = m.metadata.streams?.find(s => s.codec_type === 'video');
      const base = String(stream?.time_base || '').split('/').map(Number);
      const startTime = Number.isSafeInteger(stream?.start_pts) && base.length === 2 && base[1] ? stream.start_pts * base[0] / base[1] : Number(stream?.start_time || 0);
      Object.assign(media[m.id], { pts: index.map(t => t - startTime), width: m.metadata.width, height: m.metadata.height });
    }
    emit({ type: 'progress', phase: 'prepare', progress: ++prepared / used.size * .1, message: `Prepared ${prepared}/${used.size} sources` });
  }
  const audio = config.kind === 'frame' || end <= begin ? null : await audioMix(plan, begin, end);
  const nativeEncoder = config.mode === 'gpu' && !['frame', 'preview'].includes(config.kind) ? await require('./native/build.cjs')() : null;
  cancelCheck();
  fs.mkdirSync(path.dirname(config.output), { recursive: true });
  partial = path.join(path.dirname(config.output), `.${path.basename(config.output)}.${config.jobId}.partial${path.extname(config.output)}`);
  const renderConfig = { ...config, project, width, height, begin, end, plan, media, graphics, ffmpeg, nativeEncoder, work, audio: audio?.output,
    decodedBudgetBytes: Math.min(project.cacheLimitBytes || 256 * 1024 * 1024, 512 * 1024 * 1024), partial };
  const renderFile = path.join(work, 'renderer.json');
  if (config.kind === 'preview' && config.nativePreview) {
    const prepareSeekCache = require('./seek-cache.cjs');
    const seekOptions = { media, plan, directory:path.join(config.projectDir,'cache','seek-preview'),
      budget:Math.min(project.cacheLimitBytes || 256*1024*1024,512*1024*1024), ffmpeg, ffprobe, run };
    const seekCache = await prepareSeekCache({ ...seekOptions, reuseOnly:true });
    seekCache.complete = seekCache.hits === seekCache.sources;
    emit({ type: 'ready', audio: audio?.output, nativeSetup: {
      project, plan, media, graphics, width, height, seekCache,
    } });
    // Preview is usable immediately with originals. Publish each completed range
    // without replacing the session, changing the playhead, or interrupting play.
    const background = seekCache.complete ? Promise.resolve() : prepareSeekCache({ ...seekOptions,
      onProxy:(mediaId,seekProxy) => emit({type:'seek-cache',mediaId,seekProxy}),
    }).then(stats => emit({type:'seek-cache',seekCache:{...stats,complete:true}})).catch(error => {
      if (error.code !== 'CANCELLED') emit({type:'seek-cache',seekCache:{complete:true,error:error.message}});
    });
    // Keep accepted graphics and mixed audio alive until the editor closes this snapshot.
    await new Promise(resolve => {
      const reader = require('node:readline').createInterface({ input: process.stdin });
      reader.on('line', line => { try { if (JSON.parse(line).type === 'close') { reader.close(); resolve(); } } catch {} });
      reader.on('close', resolve);
    });
    cancelled = true;
    for (const child of children) kill(child);
    await background;
    return;
  }
  if (config.kind === 'preview') {
    // Electron on Windows closes stdin. Relay Node's control pipe over loopback.
    const token = require('node:crypto').randomUUID();
    let socket;
    const server = require('node:net').createServer(client => {
      client.setTimeout(5000, () => client.destroy());
      const reader = require('node:readline').createInterface({ input: client });
      reader.once('line', line => {
        reader.close();
        if (line !== token || socket) { client.destroy(); return; }
        socket = client; client.setTimeout(0);
        process.stdin.pipe(client);
      });
      client.on('error', () => {});
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    renderConfig.control = { port: server.address().port, token };
    fs.writeFileSync(renderFile, JSON.stringify(renderConfig));
    try { await run('renderer', require('electron'), [path.join(__dirname, 'preview-worker.cjs'), renderFile], false, true); }
    finally { socket?.destroy(); server.close(); }
    return;
  }
  fs.writeFileSync(renderFile, JSON.stringify(renderConfig));
  await run('renderer', require('electron'), [path.join(__dirname, 'worker.cjs'), renderFile], false, true);
  cancelCheck();
  const stats = JSON.parse(fs.readFileSync(path.join(work, 'stats.json'), 'utf8'));
  let verification = null;
  if (config.kind !== 'frame') {
    emit({ type: 'progress', phase: 'mux', progress: .97, message: 'Combining picture and audio' });
    await run('mux', ffmpeg, ['-hide_banner', '-y', '-r', `${project.fps.num}/${project.fps.den}`, '-i', path.join(work, 'video.h264'), '-i', audio.output, '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-t', String(end - begin), '-movflags', '+faststart', partial]);
    const mode = config.verification || 'quick';
    emit({ type: 'progress', phase: 'verify', progress: .99, message: mode === 'full' ? 'Checking container and decoding every output frame' : 'Checking output streams and timestamps' });
    verification = await verifyOutput({ file: partial, ffprobe, run, mode, expected: { frames: stats.frames, width, height, fps: project.fps.num / project.fps.den, duration: end - begin } });
  }
  let imageDimensions = {};
  if (config.kind === 'frame') {
    const { reviewSize, reviewFilter } = require('../shared/review-image.cjs');
    const imageSize = reviewSize(config.imageSize);
    if (imageSize !== 'full') {
      // Compose at project resolution so pixel-based graphics keep their layout.
      const original = path.join(work, 'review-original.png');
      fs.renameSync(partial, original);
      try { await run('review-image', ffmpeg, ['-v', 'error', '-y', '-i', original, '-vf', reviewFilter(imageSize), '-frames:v', '1', partial]); }
      finally { fs.rmSync(original, { force: true }); }
    }
    const png = fs.readFileSync(partial);
    imageDimensions = { width: png.readUInt32BE(16), height: png.readUInt32BE(20), imageSize };
  }
  cancelCheck(); fs.renameSync(partial, config.output); partial = null;
  const wallMs = performance.now() - started;
  emit({ type: 'complete', output: config.output, kind: config.kind, width, height, ...imageDimensions, frameTime: config.frameTime, duration: end - begin, frames: stats.frames,
    stats: { ...stats, wallMs, verification, indexCacheHits, indexMs: indexing.reduce((sum, entry) => sum + entry.ms, 0), indexing, audioClips: audio?.clips || 0, sourceDecode: 'software', composition: config.mode, encoder: config.kind === 'frame' ? 'png' : config.mode === 'gpu' ? 'NVENC D3D11' : 'libx264', rawFrameCacheBytes: 0 } });
}
function cleanIntermediates() {
  // All targets are fixed children of this job's resolved render directory.
  const root = path.resolve(work);
  for (const name of ['audio.wav', 'video.h264', 'graphics', 'profile']) {
    const target = path.resolve(root, name);
    if (!target.startsWith(root + path.sep)) continue;
    try { fs.rmSync(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); }
    catch (e) { console.error(`Temporary cleanup: ${e.message}`); }
  }
}
main().catch(e => {
  for (const child of children) kill(child);
  if (partial) fs.rmSync(partial, { force: true });
  emit(e.code === 'CANCELLED' || cancelled ? { type: 'cancelled', output: config.output } : { type: 'error', error: { code: e.code || 'RENDER_FAILED', message: e.message, log: path.join(work, 'renderer.log'), fallback: config.mode === 'gpu' ? 'Restart from the beginning with --mode software' : undefined } });
  console.error(e.stack); process.exitCode = cancelled ? 0 : 1;
}).finally(() => { clearInterval(cancellation); cleanIntermediates(); });
