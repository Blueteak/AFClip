// Windows experiments only. No project-engine or editor implementation is implied.
const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { performance, monitorEventLoopDelay } = require('node:perf_hooks');
const ffmpeg = require('ffmpeg-static');
const ffprobe = require('ffprobe-static').path;

const args = process.argv.slice(2);
const resumeIndex = args.indexOf('--resume');
if (resumeIndex >= 0 && !args[resumeIndex + 1]) throw new Error('--resume requires a previous run directory.');
const resume = resumeIndex >= 0 ? path.resolve(args[resumeIndex + 1]) : null;
const sources = args.filter((x, i) => args[i - 1] === '--source').map(x => path.resolve(x));
if (process.platform !== 'win32') throw new Error('Run this benchmark on Windows.');
for (const source of sources) if (!fs.existsSync(source)) throw new Error(`Missing source: ${source}`);
const out = resume || path.resolve('.cache/windows-benchmark', new Date().toISOString().replace(/[:.]/g, '-'));
fs.mkdirSync(out, { recursive: true });
const report = resume ? JSON.parse(fs.readFileSync(path.join(out, 'results.json'))) : { startedAt: new Date().toISOString(), out, experiments: [], checks: [], sources: [] };
if (resume) {
  report.checks = report.checks.filter(x => x.name === 'VFR fixture has nonuniform timestamps');
  report.renderRerunAt = new Date().toISOString();
  delete report.error;
}
const save = () => fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify(report, null, 2));
function stats(values) {
  const s = [...values].sort((a, b) => a - b);
  return { n: s.length, median: s[Math.floor(s.length / 2)], p95: s[Math.min(s.length - 1, Math.ceil(s.length * .95) - 1)], max: s.at(-1) };
}
let counter = resume ? Math.max(0, ...fs.readdirSync(out).map(name => Number(name.match(/^(\d+)-/)?.[1]) || 0)) : 0;
async function run(name, binary, argv, input) {
  const started = performance.now();
  const logPath = path.join(out, `${String(++counter).padStart(3, '0')}-${name}.log`);
  const log = fs.createWriteStream(logPath);
  log.write(JSON.stringify({ binary, argv }) + '\n');
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    if (binary === require('electron')) delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(binary, argv, { windowsHide: true, env, stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks = [];
    child.stdout.on('data', b => { chunks.push(b); log.write(b); });
    child.stderr.on('data', b => log.write(b));
    child.stdin.on('error', () => {});
    child.stdin.end(input);
    const timeout = setTimeout(() => child.kill(), 240000);
    child.on('error', e => { clearTimeout(timeout); log.end(); reject(e); });
    child.on('close', code => {
      clearTimeout(timeout);
      log.end(() => resolve({ code, wallMs: performance.now() - started, stdout: Buffer.concat(chunks), log: path.basename(logPath) }));
    });
  });
}
async function ff(name, argv, input) {
  const r = await run(name, ffmpeg, ['-hide_banner', '-y', ...argv], input);
  if (r.code !== 0) throw new Error(`${name} failed: ${fs.readFileSync(path.join(out, r.log), 'utf8').slice(-2500)}`);
  return r;
}
function probe(file, frames = false) {
  return JSON.parse(execFileSync(ffprobe, ['-v', 'error', ...(frames ? ['-select_streams', 'v:0', '-show_frames', '-show_entries', 'frame=best_effort_timestamp_time'] : ['-show_streams', '-show_format']), '-of', 'json', file], { windowsHide: true, maxBuffer: 32 * 1024 * 1024 }));
}
async function measure(name, argv, duration = 6) {
  console.log(`Measuring ${name}`);
  const samples = [];
  for (let i = 0; i < 3; i++) {
    const r = await run(name, ffmpeg, ['-hide_banner', '-y', '-benchmark', ...argv]);
    samples.push({ code: r.code, wallMs: r.wallMs, realtime: duration * 1000 / r.wallMs, log: r.log });
    if (r.code !== 0) break;
  }
  const result = { name, status: samples.every(x => x.code === 0) ? 'measured' : 'unavailable-or-failed', samples, wallMs: stats(samples.map(x => x.wallMs)) };
  report.experiments.push(result); save();
}
function check(name, pass, details) { report.checks.push({ name, status: pass ? 'pass' : 'fail', details }); save(); }

async function main() {
  if (!resume) {
    report.machine = JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-Command', '$ErrorActionPreference="Stop"; @{cpu=(Get-CimInstance Win32_Processor | Select-Object Name,NumberOfCores,NumberOfLogicalProcessors); gpu=@(Get-CimInstance Win32_VideoController | Select-Object Name,DriverVersion); os=(Get-CimInstance Win32_OperatingSystem | Select-Object Caption,Version,TotalVisibleMemorySize)} | ConvertTo-Json -Depth 5'], { encoding: 'utf8', windowsHide: true }));
    report.versions = { node: process.version, electron: require('electron/package.json').version, ffmpeg: execFileSync(ffmpeg, ['-version'], { encoding: 'utf8', windowsHide: true }).split('\n')[0], ffprobe: execFileSync(ffprobe, ['-version'], { encoding: 'utf8', windowsHide: true }).split('\n')[0] };
    report.notes = ['Three serial samples per FFmpeg case; process startup and disk I/O included; no cache flushing.', 'Generated fixtures establish timing correctness. Gameplay sources are local and never uploaded.', 'No agreed performance targets exist. Measurements do not constitute prototype acceptance.', 'Electron capture uses CPU BGRA readback and pipe transfer, not shared GPU textures.'];
    save();
    console.log(`Results: ${out}`);
    const fixture = path.join(out, 'timing-1080p60.mp4');
    await ff('fixture', ['-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=60:duration=6', '-f', 'lavfi', '-i', "aevalsrc='if(lt(mod(t,1),0.04),0.6*sin(2*PI*1000*t),0)':s=48000:d=6", '-vf', "scale=in_color_matrix=bt601:out_color_matrix=bt709,drawbox=x=0:y=0:w=100:h=100:color=white:t=fill:enable='lt(mod(t,1),0.04)'", '-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-g', '60', '-pix_fmt', 'yuv420p', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709', '-c:a', 'aac', '-b:a', '192k', fixture]);
    const vfr = path.join(out, 'vfr.mp4');
    const pixels = Buffer.alloc(320 * 180 * 3 * 90);
    for (let n = 0; n < 90; n++) pixels.fill(20 + n * 2, n * 320 * 180 * 3, (n + 1) * 320 * 180 * 3);
    await ff('vfr-fixture', ['-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', '320x180', '-r', '30', '-i', 'pipe:0', '-vf', 'setpts=(N+floor(N/10)*2)/(30*TB)', '-fps_mode', 'vfr', '-c:v', 'libx264', '-crf', '0', '-pix_fmt', 'yuv420p', vfr], pixels);
    const pts = probe(vfr, true).frames.map(x => Number(x.best_effort_timestamp_time));
    const intervals = [...new Set(pts.slice(1).map((t, i) => Math.round((t - pts[i]) * 1000)))];
    check('VFR fixture has nonuniform timestamps', intervals.length > 1, { frames: pts.length, intervalsMs: intervals });
    for (const [index, file] of [fixture, ...sources].entries()) {
      const metadata = probe(file);
      report.sources.push({ index, file, bytes: fs.statSync(file).size, metadata }); save();
      await measure(`source${index}-decode-software`, ['-hwaccel', 'none', '-i', file, '-t', '6', '-an', '-f', 'null', '-']);
      await measure(`source${index}-decode-d3d11va-download`, ['-hwaccel', 'd3d11va', '-i', file, '-t', '6', '-an', '-f', 'null', '-']);
      await measure(`source${index}-x264`, ['-i', file, '-t', '6', '-an', '-c:v', 'libx264', '-preset', 'fast', '-crf', '20', path.join(out, `source${index}-x264.mp4`)]);
      await measure(`source${index}-nvenc`, ['-hwaccel', 'cuda', '-hwaccel_output_format', 'cuda', '-i', file, '-t', '6', '-an', '-c:v', 'h264_nvenc', '-preset', 'p4', '-cq', '20', path.join(out, `source${index}-nvenc.mp4`)]);
  }
  await measure('intel-qsv', ['-init_hw_device', 'qsv=hw', '-filter_hw_device', 'hw', '-i', fixture, '-t', '6', '-an', '-vf', 'format=nv12,hwupload=extra_hw_frames=64', '-c:v', 'h264_qsv', '-global_quality', '20', path.join(out, 'intel-qsv.mp4')]);
  if (report.experiments.at(-1).status !== 'measured') {
    await measure('intel-qsv-explicit-adapter', ['-init_hw_device', 'd3d11va=dx:,vendor_id=0x8086', '-init_hw_device', 'qsv=hw@dx', '-filter_hw_device', 'hw', '-i', fixture, '-t', '6', '-an', '-vf', 'format=nv12,hwupload=extra_hw_frames=64', '-c:v', 'h264_qsv', '-global_quality', '20', path.join(out, 'intel-qsv-explicit.mp4')]);
  }
  // Offline audio for the same two 3-second clips and 1-second dissolve used in HTML.
  const mix = path.join(out, 'mix.wav');
  await ff('audio-mix', ['-i', fixture, '-filter_complex', '[0:a]asplit=2[a][b];[a]atrim=0:3,asetpts=PTS-STARTPTS[a0];[b]atrim=3:6,asetpts=PTS-STARTPTS[b0];[a0][b0]acrossfade=d=1:c1=tri:c2=tri[m]', '-map', '[m]', '-c:a', 'pcm_s16le', mix]);
  const config = { out, fixture, vfr, pts, mix, sources, ffmpeg, width: 1920, height: 1080, fps: 30, duration: 5 };
  fs.writeFileSync(path.join(out, 'config.json'), JSON.stringify(config));
  }
  const config = JSON.parse(fs.readFileSync(path.join(out, 'config.json')));
  if (path.resolve(config.out) !== out) throw new Error('Resume directory must match the original run location.');
  report.chromium = [];
  for (const mode of ['gpu', 'software']) {
    console.log(`Running Chromium ${mode} composition, seeks, preview and export`);
    const delay = monitorEventLoopDelay({ resolution: 10 }); delay.enable();
    const r = await run(`electron-${mode}`, require('electron'), [path.join(__dirname, 'render.cjs'), path.join(out, 'config.json'), mode]);
    delay.disable();
    const file = path.join(out, `chromium-${mode}.json`);
    report.chromium.push({ mode, exitCode: r.code, wallMs: r.wallMs, log: r.log, controllerEventLoopDelayMs: { mean: delay.mean / 1e6, p95: delay.percentile(95) / 1e6, max: delay.max / 1e6 }, result: fs.existsSync(file) ? JSON.parse(fs.readFileSync(file)) : null });
    check(`Chromium ${mode} experiment completed`, r.code === 0, { log: r.log });
    const output = path.join(out, `composed-${mode}.mp4`);
    if (!fs.existsSync(output)) continue;
    const metadata = probe(output); const vf = probe(output, true).frames;
    check(`${mode}: export frame count and audio track`, vf.length === 150 && metadata.streams.some(x => x.codec_type === 'audio'), { frames: vf.length, metadata });
    // Compare encoded composition to exact pre-encode captures, including dissolve midpoint.
    for (const frame of [0, 30, 75, 120]) {
      const r = await ff(`ssim-${mode}-${frame}`, ['-i', output, '-i', path.join(out, `${mode}-frame-${frame}.png`), '-filter_complex', `[0:v]select=eq(n\\,${frame}),setpts=PTS-STARTPTS,format=yuv420p[a];[1:v]scale=out_color_matrix=bt709:out_range=tv,format=yuv420p[b];[a][b]ssim`, '-frames:v', '1', '-an', '-f', 'null', '-']);
      const log = fs.readFileSync(path.join(out, r.log), 'utf8');
      const ssim = Number(log.match(/All:([0-9.]+)/)?.[1]);
      check(`${mode}: exported frame ${frame} matches capture`, ssim > .98, { ssim, threshold: .98, log: r.log });
    }
    const reference = await ff(`color-reference-${mode}`, ['-i', path.join(out, `${mode}-frame-30.png`), '-frames:v', '1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1']);
    const decoded = await ff(`color-export-${mode}`, ['-i', output, '-vf', 'select=eq(n\\,30)', '-frames:v', '1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1']);
    const patches = [160, 480, 800, 1120, 1440, 1760].map(x => {
      const offset = (200 * config.width + x) * 3;
      const before = [...reference.stdout.subarray(offset, offset + 3)];
      const after = [...decoded.stdout.subarray(offset, offset + 3)];
      return { x, y: 200, before, after, maxError: Math.max(...before.map((v, i) => Math.abs(v - after[i]))) };
    });
    check(`${mode}: SDR color patches survive capture and encode`, patches.every(x => x.maxError <= 5), { tolerance8bit: 5, patches });
    // Independently detect the white video flash and AAC pulse onset near each second.
    const audioFile = path.join(out, `${mode}-audio.f32`);
    await ff(`audio-decode-${mode}`, ['-i', output, '-vn', '-ac', '1', '-ar', '48000', '-f', 'f32le', audioFile]);
    const audio = fs.readFileSync(audioFile);
    const flashFile = path.join(out, `${mode}-flashes.gray`);
    await ff(`flash-decode-${mode}`, ['-i', output, '-vf', 'crop=50:50:20:20,scale=1:1', '-pix_fmt', 'gray', '-f', 'rawvideo', flashFile]);
    const flash = fs.readFileSync(flashFile); const sync = [];
    for (const second of [1, 2, 3, 4]) {
      let sample = Math.floor((second - .1) * 48000);
      while (sample < (second + .1) * 48000 && Math.abs(audio.readFloatLE(sample * 4)) < .15) sample++;
      let frame = Math.floor((second - .1) * 30);
      while (frame < (second + .1) * 30 && flash[frame] < 240) frame++;
      sync.push({ second, audioTime: sample / 48000, videoTime: frame / 30, offsetMs: (sample / 48000 - frame / 30) * 1000, pulseFound: sample < (second + .1) * 48000, flashFound: frame < (second + .1) * 30 });
    }
    check(`${mode}: composed flash and audio sync`, sync.every(x => x.pulseFound && x.flashFound && Math.abs(x.offsetMs) <= 1000 / 30), { toleranceMs: 1000 / 30, sync });
  }
  const gpuPatches = report.checks.find(x => x.name === 'gpu: SDR color patches survive capture and encode')?.details.patches;
  const softwarePatches = report.checks.find(x => x.name === 'software: SDR color patches survive capture and encode')?.details.patches;
  if (gpuPatches && softwarePatches) {
    const comparisons = gpuPatches.map((patch, i) => ({ x: patch.x, y: patch.y, gpu: patch.before, software: softwarePatches[i].before, maxError: Math.max(...patch.before.map((v, c) => Math.abs(v - softwarePatches[i].before[c]))) }));
    check('Hardware/software SDR preview patches agree', comparisons.every(x => x.maxError <= 5), { tolerance8bit: 5, comparisons });
  }
  report.finishedAt = new Date().toISOString();
  save();
  console.log(JSON.stringify({ out, checks: report.checks.map(x => ({ name: x.name, status: x.status })), experiments: report.experiments.map(x => ({ name: x.name, status: x.status, medianMs: x.wallMs.median })) }, null, 2));
  if (report.checks.some(x => x.status === 'fail') || report.chromium.some(x => x.result?.checks?.some(c => !c.pass))) process.exitCode = 1;
}
main().catch(e => { report.error = e.stack; save(); console.error(e); process.exitCode = 1; });
