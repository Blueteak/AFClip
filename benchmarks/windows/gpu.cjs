// Run the existing correctness suite, then compare shared textures with both bitmap paths.
const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const ffmpeg = require('ffmpeg-static'), ffprobe = require('ffprobe-static').path;
const out = path.resolve('.cache/windows-gpu', new Date().toISOString().replace(/[:.]/g, '-'));
fs.mkdirSync(out, { recursive: true });
const report = { out, startedAt: new Date().toISOString(), checks: [], runs: [] };
const save = () => fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify(report, null, 2));
function check(name, pass, details) { report.checks.push({ name, pass, details }); save(); if (!pass) console.error(`FAIL: ${name}`); }
function run(name, binary, args, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, ...extraEnv }; delete env.ELECTRON_RUN_AS_NODE;
    const log = fs.createWriteStream(path.join(out, `${name}.log`));
    const child = spawn(binary, args, { windowsHide: true, env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.pipe(log, { end: false }); child.stderr.pipe(log, { end: false });
    const timer = setTimeout(() => child.kill(), 300000);
    child.on('error', e => { clearTimeout(timer); log.end(); reject(e); });
    child.on('close', code => { clearTimeout(timer); log.end(); code === 0 ? resolve() : reject(new Error(`${name} exited ${code}; inspect ${out}/${name}.log`)); });
  });
}
function ff(args) { return execFileSync(ffmpeg, ['-hide_banner', '-v', 'error', ...args], { windowsHide: true, maxBuffer: 32 * 1024 * 1024 }); }
function probe(file) { return JSON.parse(execFileSync(ffprobe, ['-v', 'error', '-count_frames', '-show_streams', '-of', 'json', file], { windowsHide: true })); }
async function main() {
  console.log(`GPU benchmark: ${out}`);
  const nativeEncoder = await require('./native/build.cjs')();
  let baseline = process.argv[2];
  if (!baseline) {
    console.log('Preparing sources and running the original correctness checks...');
    await run('baseline', process.execPath, [path.join(__dirname, 'solutions.cjs')], { REELET_KEEP_FRAMES: '1' });
    const root = path.resolve('.cache/windows-solutions');
    baseline = path.join(root, fs.readdirSync(root).filter(x => fs.existsSync(path.join(root, x, 'config.json'))).sort().at(-1));
  }
  baseline = path.resolve(baseline); report.baseline = baseline;
  const config = JSON.parse(fs.readFileSync(path.join(baseline, 'config.json')));
  for (const f of Object.values(config.frames)) if (!fs.existsSync(f.file)) throw new Error('The baseline raw-frame cache was removed. Run without a directory argument to prepare it again.');
  const original = JSON.parse(fs.readFileSync(path.join(baseline, 'results.json')));
  check('Original RGB, VFR, export and sync checks pass', !original.error && !!original.finishedAt && original.checks.every(c => c.pass) && original.rendering.every(r => !r.error && r.checks.every(c => c.pass)), { report: path.join(baseline, 'results.json') });
  const repeats = Number(process.env.REELET_GPU_REPEATS || 3);
  if (!Number.isInteger(repeats) || repeats < 1 || repeats > 10) throw new Error('REELET_GPU_REPEATS must be 1..10');
  // Re-run every control with matching NVENC P4/QP16/no-B-frame settings.
  for (let repeat = 0; repeat < repeats; repeat++) {
    for (const [label, mode, encoder] of [['gpu-bitmap', 'gpu', 'h264_nvenc'], ['cpu-bitmap', 'software', 'libx264'], ['cpu-nvenc', 'software', 'h264_nvenc']]) {
      console.log(`${label}: repetition ${repeat + 1}/${repeats}`);
      const dir = path.join(out, `${label}-${repeat}`); fs.mkdirSync(dir);
      const file = path.join(dir, 'config.json'); fs.writeFileSync(file, JSON.stringify({ ...config, out: dir, exportOnly: true, encoder }));
      await run(`${label}-${repeat}`, require('electron'), [path.join(__dirname, 'frames.cjs'), file, mode]);
      const r = JSON.parse(fs.readFileSync(path.join(dir, `frames-${mode}.json`))); if (r.error) throw new Error(r.error);
      report.runs.push({ label, repeat, ...r }); save();
    }
  }
  console.log(`Shared D3D11 textures: ${repeats} repetitions per source`);
  const sharedConfig = path.join(out, 'config.json'); fs.writeFileSync(sharedConfig, JSON.stringify({ ...config, out, nativeEncoder, repeats }));
  await run('shared-renderer', require('electron'), [path.join(__dirname, 'shared-frames.cjs'), sharedConfig]);
  const shared = JSON.parse(fs.readFileSync(path.join(out, 'shared.json'))); if (shared.error) throw new Error(shared.error);
  report.shared = shared; save();
  console.log('Checking encoded frames, colors, audio sync and VFR selection...');
  for (const r of [...report.runs, { label: 'shared-texture', exports: shared.exports }]) {
    for (const exp of r.exports) {
      const repeat = exp.repeat ?? r.repeat, name = `${r.label}/${exp.id}/${repeat}`;
      const streams = probe(exp.output).streams, video = streams.find(s => s.codec_type === 'video'), audioStream = streams.find(s => s.codec_type === 'audio');
      check(`${name}: complete 1080p30 SDR video and audio`, Number(video?.nb_read_frames) === 150 && video.width === 1920 && video.height === 1080 && video.avg_frame_rate === '30/1' && video.color_space === 'bt709' && video.color_range === 'tv' && !!audioStream && Math.abs(Number(audioStream.duration) - 5) < .05,
        streams.map(s => ({ codec: s.codec_name, frames: s.nb_read_frames, duration: s.duration, color_space: s.color_space })));
      if (repeat !== 0) continue;
      for (const frame of [0, 30, 75, 120]) {
        const prefix = exp.id === 'fixture' ? 'gpu' : `gpu-${exp.id}`;
        const reference = path.join(baseline, `${prefix}-frame-${frame}.png`), logName = `ssim-${r.label}-${exp.id}-${frame}`;
        await run(logName, ffmpeg, ['-hide_banner', '-i', exp.output, '-i', reference, '-filter_complex', `[0:v]select=eq(n\\,${frame}),setpts=PTS-STARTPTS,format=yuv420p[a];[1:v]scale=out_color_matrix=bt709:out_range=tv,format=yuv420p[b];[a][b]ssim`, '-frames:v', '1', '-an', '-f', 'null', '-']);
        const ssim = Number(fs.readFileSync(path.join(out, `${logName}.log`), 'utf8').match(/All:([0-9.]+)/)?.[1]);
        check(`${name}: frame ${frame} matches bitmap reference`, ssim > .98, { ssim });
      }
      if (exp.id !== 'fixture') continue;
      const rgb = ff(['-i', exp.output, '-vf', 'select=eq(n\\,30)', '-frames:v', '1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1']);
      const patches = [160, 480, 800, 1120, 1440, 1760].map(x => [...rgb.subarray((200 * 1920 + x) * 3, (200 * 1920 + x) * 3 + 3)]);
      const reference = original.rendering.find(x => x.mode === 'gpu').colors;
      const maxError = Math.max(...patches.flatMap((p, i) => p.map((v, c) => Math.abs(v - reference[i][c]))));
      check(`${name}: encoded SDR patches match RGB reference`, maxError <= 5, { maxError, patches, reference });
      const audio = ff(['-i', exp.output, '-vn', '-ac', '1', '-ar', '48000', '-f', 'f32le', 'pipe:1']);
      const flashes = ff(['-i', exp.output, '-vf', 'crop=50:50:20:20,scale=1:1', '-pix_fmt', 'gray', '-f', 'rawvideo', 'pipe:1']);
      const sync = [1, 2, 3, 4].map(t => {
        let sample = Math.floor((t - .1) * 48000), frame = Math.floor((t - .1) * 30);
        while (sample < (t + .1) * 48000 && Math.abs(audio.readFloatLE(sample * 4)) < .15) sample++;
        while (frame < (t + .1) * 30 && flashes[frame] < 240) frame++;
        return { time: t, offsetMs: (sample / 48000 - frame / 30) * 1000, found: sample < (t + .1) * 48000 && frame < (t + .1) * 30 };
      });
      check(`${name}: flash/audio synchronization`, sync.every(x => x.found && Math.abs(x.offsetMs) <= 1000 / 30), sync);
    }
  }
  const gray = ff(['-i', shared.vfr.output, '-vf', 'crop=16:16:200:200,scale=1:1', '-pix_fmt', 'gray', '-f', 'rawvideo', 'pipe:1']);
  const vfr = shared.vfr.times.map((t, i) => ({ t, expected: 20 + config.pts.findLastIndex(p => p <= t + 1e-6) * 2, actual: gray[i] }));
  check('Shared texture VFR frame identity', gray.length === vfr.length && vfr.every(x => Math.abs(x.expected - x.actual) <= 2), vfr);
  const median = xs => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
  report.summary = Object.keys(config.mixes).map(id => {
    const rates = Object.fromEntries(['gpu-bitmap', 'cpu-bitmap', 'cpu-nvenc'].map(label => [label, median(report.runs.filter(r => r.label === label).map(r => r.exports.find(e => e.id === id).fps))]));
    rates['shared-texture'] = median(shared.exports.filter(e => e.id === id).map(e => e.fps));
    return { id, medianFps: rates, speedupOverGpuBitmap: rates['shared-texture'] / rates['gpu-bitmap'], speedupOverCpuBitmap: rates['shared-texture'] / rates['cpu-bitmap'] };
  });
  report.finishedAt = new Date().toISOString(); save();
  console.log(JSON.stringify({ out, checks: report.checks.length, failed: report.checks.filter(c => !c.pass), summary: report.summary }, null, 2));
  // Only delete our generated caches after all tests pass. Never touch source media.
  if (report.checks.some(c => !c.pass)) process.exitCode = 1;
  else if (!process.env.REELET_KEEP_FRAMES) for (const f of Object.values(config.frames)) fs.unlinkSync(f.file);
}
main().catch(e => { report.error = e.stack; save(); console.error(e); process.exitCode = 1; });
