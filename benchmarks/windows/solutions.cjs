const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { performance } = require('node:perf_hooks');
const ffmpeg = require('ffmpeg-static'), ffprobe = require('ffprobe-static').path;
const baseRoot = path.resolve('.cache/windows-benchmark');
const latest = fs.existsSync(baseRoot) ? fs.readdirSync(baseRoot).filter(name => fs.existsSync(path.join(baseRoot, name, 'config.json'))).sort().at(-1) : null;
if (!process.argv[2] && !latest) throw new Error('Run npm run bench:windows first, then pass its results directory.');
const baseline = path.resolve(process.argv[2] || path.join(baseRoot, latest));
const prior = JSON.parse(fs.readFileSync(path.join(baseline, 'config.json')));
const out = path.resolve('.cache/windows-solutions', new Date().toISOString().replace(/[:.]/g, '-'));
fs.mkdirSync(out, { recursive: true });
const report = { startedAt: new Date().toISOString(), baseline, out, checks: [], preparation: [], qsv: [], rendering: [] };
const save = () => fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify(report, null, 2));
async function run(name, binary, args) {
  const start = performance.now(), env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  return new Promise((resolve, reject) => {
    const log = fs.createWriteStream(path.join(out, `${name}.log`)); log.write(JSON.stringify({ binary, args }) + '\n');
    const child = spawn(binary, args, { windowsHide: true, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout = []; child.stdout.on('data', b => stdout.push(b)); child.stderr.on('data', b => log.write(b));
    const timer = setTimeout(() => child.kill(), 180000);
    child.on('error', e => { clearTimeout(timer); reject(e); });
    child.on('close', code => { clearTimeout(timer); log.end(() => resolve({ code, wallMs: performance.now() - start, stdout: Buffer.concat(stdout) })); });
  });
}
async function ff(name, args) { const r = await run(name, ffmpeg, ['-hide_banner', '-y', ...args]); if (r.code !== 0) throw new Error(`${name}: FFmpeg exit ${r.code}; inspect ${name}.log`); return r; }
function check(name, pass, details) { report.checks.push({ name, pass, details }); save(); }
function probe(file) { return JSON.parse(execFileSync(ffprobe, ['-v', 'error', '-count_frames', '-show_streams', '-of', 'json', file], { windowsHide: true })); }
async function main() {
  console.log(`Results: ${out}`);
  report.versions = { ffmpeg: execFileSync(ffmpeg, ['-version'], { encoding: 'utf8', windowsHide: true }).split('\n')[0], electron: require('electron/package.json').version };
  // Keep QSV's supported system-memory input path separate from explicit hardware frame pools.
  for (let i = 0; i < 3; i++) {
    const output = path.join(out, 'qsv.mp4');
    const r = await run(`qsv-${i}`, ffmpeg, ['-hide_banner', '-loglevel', 'verbose', '-y', '-i', prior.fixture, '-t', '6', '-an', '-vf', 'format=nv12', '-c:v', 'h264_qsv', '-global_quality', '20', output]);
    const hardware = fs.readFileSync(path.join(out, `qsv-${i}.log`), 'utf8').includes('using hardware accelerated implementation');
    report.qsv.push({ code: r.code, wallMs: r.wallMs, hardware });
    check(`QSV system-memory encode ${i + 1}`, r.code === 0 && hardware && Number(probe(output).streams[0].nb_read_frames) === 360, { code: r.code, wallMs: r.wallMs, hardware });
  }
  const frames = {}, mixes = {};
  for (const [id, source] of [['fixture', prior.fixture], ['vfr', prior.vfr], ...prior.sources.map((file, i) => [`source${i}`, file])]) {
    console.log(`Preparing explicit RGB frames: ${id}`);
    const metadata = probe(source).streams.find(s => s.codec_type === 'video');
    if (id !== 'vfr' && (metadata.color_space !== 'bt709' || metadata.color_transfer !== 'bt709' || metadata.color_range === 'pc')) throw new Error(`${source}: this experiment requires tagged limited-range BT.709 SDR input`);
    const file = path.join(out, `${id}.rgba`);
    // This experiment accepts the known BT.709 SDR inputs. VFR grayscale has no chroma.
    const filter = 'fps=30:round=up,scale=in_color_matrix=bt709:in_range=tv:out_range=full,format=rgba';
    const r = await ff(`prepare-${id}`, ['-hwaccel', 'none', '-i', source, '-t', '6', '-an', '-vf', filter, '-pix_fmt', 'rgba', '-f', 'rawvideo', file]);
    frames[id] = { file, width: metadata.width, height: metadata.height, count: fs.statSync(file).size / (metadata.width * metadata.height * 4) };
    report.preparation.push({ id, source, wallMs: r.wallMs, bytes: fs.statSync(file).size, ...frames[id] }); save();
    if (id !== 'vfr') {
      const mix = path.join(out, `mix-${id}.wav`);
      const audio = await ff(`mix-${id}`, ['-i', source, '-filter_complex', '[0:a]asplit=2[a][b];[a]atrim=0:3,asetpts=PTS-STARTPTS[a0];[b]atrim=3:6,asetpts=PTS-STARTPTS[b0];[a0][b0]acrossfade=d=1:c1=tri:c2=tri[m]', '-map', '[m]', '-c:a', 'pcm_s16le', mix]);
      mixes[id] = { file: mix, wallMs: audio.wallMs };
    }
  }
  report.audioPreparation = mixes;
  const config = { out, ffmpeg, frames, mixes, pts: prior.pts };
  fs.writeFileSync(path.join(out, 'config.json'), JSON.stringify(config));
  for (const mode of ['gpu', 'software']) {
    console.log(`Rendering explicit RGB / paint-event path: ${mode}`);
    const r = await run(`renderer-${mode}`, require('electron'), [path.join(__dirname, 'frames.cjs'), path.join(out, 'config.json'), mode]);
    const result = JSON.parse(fs.readFileSync(path.join(out, `frames-${mode}.json`)));
    report.rendering.push(result);
    check(`${mode}: renderer completed`, r.code === 0 && !result.error && result.checks.every(x => x.pass), { code: r.code, error: result.error });
    if (!result.export) continue;
    const video = probe(result.export.output);
    check(`${mode}: complete video and audio export`, Number(video.streams.find(s => s.codec_type === 'video').nb_read_frames) === 150 && video.streams.some(s => s.codec_type === 'audio'), video.streams.map(s => ({ codec: s.codec_name, frames: s.nb_read_frames, duration: s.duration })));
    const colors = await ff(`colors-${mode}`, ['-i', path.join(out, `${mode}-frame-30.png`), '-frames:v', '1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1']);
    result.colors = [160, 480, 800, 1120, 1440, 1760].map(x => [...colors.stdout.subarray((200 * 1920 + x) * 3, (200 * 1920 + x) * 3 + 3)]);
    for (const frame of [0, 30, 75, 120]) {
      await ff(`ssim-${mode}-${frame}`, ['-i', result.export.output, '-i', path.join(out, `${mode}-frame-${frame}.png`), '-filter_complex', `[0:v]select=eq(n\\,${frame}),setpts=PTS-STARTPTS,format=yuv420p[a];[1:v]scale=out_color_matrix=bt709:out_range=tv,format=yuv420p[b];[a][b]ssim`, '-frames:v', '1', '-an', '-f', 'null', '-']);
      const ssim = Number(fs.readFileSync(path.join(out, `ssim-${mode}-${frame}.log`), 'utf8').match(/All:([0-9.]+)/)?.[1]);
      check(`${mode}: exported frame ${frame} matches capture`, ssim > .98, { ssim });
    }
    // Preserve independent audio/flash onset verification from the baseline.
    const audio = (await ff(`audio-${mode}`, ['-i', result.export.output, '-vn', '-ac', '1', '-ar', '48000', '-f', 'f32le', 'pipe:1'])).stdout;
    const flashes = (await ff(`flash-${mode}`, ['-i', result.export.output, '-vf', 'crop=50:50:20:20,scale=1:1', '-pix_fmt', 'gray', '-f', 'rawvideo', 'pipe:1'])).stdout;
    const sync = [1, 2, 3, 4].map(t => {
      let sample = Math.floor((t - .1) * 48000), frame = Math.floor((t - .1) * 30);
      while (sample < (t + .1) * 48000 && Math.abs(audio.readFloatLE(sample * 4)) < .15) sample++;
      while (frame < (t + .1) * 30 && flashes[frame] < 240) frame++;
      return { time: t, offsetMs: (sample / 48000 - frame / 30) * 1000, found: sample < (t + .1) * 48000 && frame < (t + .1) * 30 };
    });
    check(`${mode}: audio/flash synchronization`, sync.every(x => x.found && Math.abs(x.offsetMs) <= 1000 / 30), sync);
    for (const exported of result.exports) {
      exported.preparationAndExportMs = report.preparation.find(x => x.id === exported.id).wallMs + mixes[exported.id].wallMs + exported.wallMs;
      exported.preparationAndExportRealtime = 5000 / exported.preparationAndExportMs;
      if (exported.id === 'fixture') continue;
      const streams = probe(exported.output).streams;
      check(`${mode}/${exported.id}: 150 frames and source audio`, Number(streams.find(s => s.codec_type === 'video').nb_read_frames) === 150 && streams.some(s => s.codec_type === 'audio'), streams.map(s => ({ codec: s.codec_name, duration: s.duration, frames: s.nb_read_frames })));
      for (const frame of [0, 30, 75, 120]) {
        const name = `ssim-${exported.prefix}-${frame}`;
        await ff(name, ['-i', exported.output, '-i', path.join(out, `${exported.prefix}-frame-${frame}.png`), '-filter_complex', `[0:v]select=eq(n\\,${frame}),setpts=PTS-STARTPTS,format=yuv420p[a];[1:v]scale=out_color_matrix=bt709:out_range=tv,format=yuv420p[b];[a][b]ssim`, '-frames:v', '1', '-an', '-f', 'null', '-']);
        const ssim = Number(fs.readFileSync(path.join(out, `${name}.log`), 'utf8').match(/All:([0-9.]+)/)?.[1]);
        check(`${mode}/${exported.id}: exported frame ${frame} matches capture`, ssim > .98, { ssim });
      }
    }
    result.export = result.exports.find(x => x.id === 'fixture');
    save();
  }
  if (report.rendering.every(r => r.colors)) {
    const errors = report.rendering[0].colors.flatMap((rgb, i) => rgb.map((v, c) => Math.abs(v - report.rendering[1].colors[i][c])));
    check('GPU/software RGB color agrees', Math.max(...errors) <= 5, { maxError: Math.max(...errors), gpu: report.rendering[0].colors, software: report.rendering[1].colors });
  }
  report.finishedAt = new Date().toISOString(); save();
  console.log(JSON.stringify({ out, checks: report.checks, exports: report.rendering.map(x => ({ mode: x.mode, export: x.export })) }, null, 2));
  // Decoded frames are disposable cache data; retain captures, logs and encoded outputs.
  if (!process.env.REELET_KEEP_FRAMES) for (const f of Object.values(frames)) fs.unlinkSync(f.file);
  if (report.checks.some(x => !x.pass) || report.rendering.some(r => r.checks.some(x => !x.pass))) process.exitCode = 1;
}
main().catch(e => { report.error = e.stack; save(); console.error(e); process.exitCode = 1; });
