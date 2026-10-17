const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { createHash } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const config = JSON.parse(fs.readFileSync(process.argv[2]));
const mode = process.argv[3];
if (mode === 'software') app.disableHardwareAcceleration();
app.commandLine.appendSwitch('force-device-scale-factor', '1');
app.commandLine.appendSwitch('force-color-profile', 'srgb');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.setPath('userData', path.join(config.out, `electron-profile-${mode}`));
const result = { mode, checks: [], sources: [] };
const save = () => fs.writeFileSync(path.join(config.out, `chromium-${mode}.json`), JSON.stringify(result, null, 2));
const hash = image => createHash('sha256').update(image.toBitmap()).digest('hex');
function stats(xs) { const s = [...xs].sort((a, b) => a - b); return { n: s.length, median: s[Math.floor(s.length / 2)], p95: s[Math.min(s.length - 1, Math.ceil(s.length * .95) - 1)], max: s.at(-1) }; }
function check(name, pass, details) { result.checks.push({ name, pass, details }); save(); }
let win;
let encoder;
async function main() {
  await app.whenReady();
  result.versions = process.versions;
  win = new BrowserWindow({ width: config.width, height: config.height, useContentSize: true, show: false, webPreferences: { offscreen: true, backgroundThrottling: false, nodeIntegration: false, contextIsolation: true, sandbox: true } });
  win.webContents.setFrameRate(120);
  await win.loadFile(path.join(__dirname, 'composition.html'));
  result.gpuFeatures = app.getGPUFeatureStatus();
  result.gpuInfo = await app.getGPUInfo('basic');
  save();
  result.mediaProperties = {};
  win.webContents.debugger.attach('1.3');
  win.webContents.debugger.on('message', (_, method, params) => {
    if (method === 'Media.playerPropertiesChanged') {
      const properties = result.mediaProperties[params.playerId] ||= {};
      for (const property of params.properties) properties[property.name] = property.value;
    }
  });
  await win.webContents.debugger.sendCommand('Media.enable');
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_, callback) => callback({ cancel: true }));
  const call = (fn, ...args) => win.webContents.executeJavaScript(`${fn}(...${JSON.stringify(args)})`);
  const capture = () => win.webContents.capturePage({ x: 0, y: 0, width: config.width, height: config.height }, { stayHidden: true, stayAwake: true });
  const load = file => call('load', pathToFileURL(file).href);
  for (const file of [config.fixture, ...config.sources]) {
    const entry = { file };
    try {
      await load(file);
      const seekTimes = [];
      for (const t of [2.8, .1, 4.2, 1.3, 3.6, .5, 2.1, 4.8, .9, 3.1]) {
        const start = performance.now(); await call('renderAt', t, { single: true }); await capture(); seekTimes.push(performance.now() - start);
      }
      entry.seekAndCaptureMs = stats(seekTimes); entry.seekSamplesMs = seekTimes;
      entry.preview = await call('preview', 3);
      entry.preview.rafMs = stats(entry.preview.rafIntervalsMs); delete entry.preview.rafIntervalsMs;
      entry.status = entry.preview.totalFrames > 0 ? 'measured' : 'failed';
      if (entry.preview.totalFrames === 0) entry.error = 'Playback clock advanced but no decoded video frames were counted. Do not treat this as successful software fallback.';
      await call('renderAt', 1, { single: true });
      fs.writeFileSync(path.join(config.out, `${mode}-source-${result.sources.length}.png`), (await capture()).toPNG());
    } catch (e) { entry.status = 'failed'; entry.error = e.message; }
    if (entry.status === 'failed' && mode === 'software') {
      // Explicitly restart through a CPU-decoded H.264 proxy. Never hide native decode failure.
      const proxy = path.join(config.out, `software-proxy-${result.sources.length}.mp4`);
      const started = performance.now();
      const argv = ['-hide_banner', '-y', '-hwaccel', 'none', '-i', file, '-t', '6', '-vf', 'scale=1920:-2', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-c:a', 'aac', proxy];
      const child = spawn(config.ffmpeg, argv, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
      const log = fs.createWriteStream(path.join(config.out, `software-proxy-${result.sources.length}.log`));
      log.write(JSON.stringify(argv) + '\n'); child.stderr.pipe(log);
      const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
      entry.fallback = { proxy, generationMs: performance.now() - started, exitCode: code };
      if (code === 0) {
        await load(proxy); await call('renderAt', 1, { single: true });
        fs.writeFileSync(path.join(config.out, `software-proxy-${result.sources.length}.png`), (await capture()).toPNG());
        entry.fallback.preview = await call('preview', 3);
        entry.fallback.preview.rafMs = stats(entry.fallback.preview.rafIntervalsMs); delete entry.fallback.preview.rafIntervalsMs;
      }
      check(`Software proxy fallback for source ${result.sources.length}`, entry.fallback.preview?.totalFrames > 0, entry.fallback);
    }
    result.sources.push(entry); save();
  }
  await load(config.vfr);
  const selections = [];
  for (const t of [.01, .32, .35, .39, .41, 1.08, 2.23, 3.1, .35]) {
    await call('renderAt', t, { single: true, noGraphics: true });
    const rgba = await call('pixel');
    const expected = config.pts.findLastIndex(pts => pts <= t + 1e-6);
    const observed = Math.round((rgba[0] - 20) / 2);
    selections.push({ time: t, expected, observed, rgba, pass: Math.abs(rgba[0] - (20 + expected * 2)) <= 1 });
  }
  check('VFR seek selects frame by actual presentation timestamp', selections.every(x => x.pass), selections);
  await load(config.fixture);
  const repeated = [];
  for (const t of [1.25, 3.75, .2, 1.25, 2.5, 3.75]) { await call('renderAt', t); repeated.push({ time: t, hash: hash(await capture()) }); }
  check('Arbitrary seek produces identical composition pixels', repeated[0].hash === repeated[3].hash && repeated[1].hash === repeated[5].hash, repeated);
  await call('renderAt', 0);
  const first = await capture();
  check('Capture has requested pixel dimensions', first.getSize().width === config.width && first.getSize().height === config.height, first.getSize());
  const output = path.join(config.out, `composed-${mode}.mp4`);
  const encodeArgs = ['-hide_banner', '-y', '-f', 'rawvideo', '-pix_fmt', 'bgra', '-s', `${config.width}x${config.height}`, '-r', String(config.fps), '-i', 'pipe:0', '-i', config.mix, '-c:v', mode === 'gpu' ? 'h264_nvenc' : 'libx264', '-preset', mode === 'gpu' ? 'p4' : 'fast', ...(mode === 'gpu' ? ['-cq', '18'] : ['-crf', '18']), '-vf', 'scale=in_range=full:out_range=tv:out_color_matrix=bt709,format=yuv420p', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709', '-c:a', 'aac', '-b:a', '192k', '-t', String(config.duration), output];
  encoder = spawn(config.ffmpeg, encodeArgs, { windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] });
  let encoderError;
  encoder.stdin.on('error', e => { encoderError = e; });
  const log = fs.createWriteStream(path.join(config.out, `encode-${mode}.log`));
  log.write(JSON.stringify(encodeArgs) + '\n'); encoder.stderr.pipe(log);
  const done = new Promise((resolve, reject) => { encoder.on('error', reject); encoder.on('close', code => code === 0 ? resolve() : reject(new Error(`Encoder exit ${code}`))); });
  done.catch(() => {});
  const timings = { renderMs: [], captureMs: [], bitmapMs: [], pipeMs: [] };
  const start = performance.now();
  for (let frame = 0; frame < config.fps * config.duration; frame++) {
    let tick = performance.now(); await call('renderAt', frame / config.fps); timings.renderMs.push(performance.now() - tick);
    tick = performance.now(); const image = await capture(); timings.captureMs.push(performance.now() - tick);
    tick = performance.now(); const bitmap = image.toBitmap(); timings.bitmapMs.push(performance.now() - tick);
    if (bitmap.length !== config.width * config.height * 4) throw new Error('Unexpected bitmap size');
    tick = performance.now();
    if (encoderError) throw encoderError;
    await new Promise((resolve, reject) => encoder.stdin.write(bitmap, e => e ? reject(e) : resolve()));
    timings.pipeMs.push(performance.now() - tick);
    if ([0, 30, 75, 120].includes(frame)) fs.writeFileSync(path.join(config.out, `${mode}-frame-${frame}.png`), image.toPNG());
  }
  encoder.stdin.end(); await done;
  const wallMs = performance.now() - start;
  // Initial feature status can precede GPU initialization; retain the post-render status.
  result.gpuFeatures = app.getGPUFeatureStatus();
  result.gpuInfo = await app.getGPUInfo('basic');
  result.export = { output, wallMs, fps: 150000 / wallMs, realtime: config.duration * 1000 / wallMs, bytesTransferred: config.width * config.height * 4 * 150, timings: Object.fromEntries(Object.entries(timings).map(([k, v]) => [k, stats(v)])), samples: timings };
  save();
  // An isolated renderer crash/reload is evidence for Electron recovery only, not project persistence.
  const gone = once(win.webContents, 'render-process-gone'); win.webContents.forcefullyCrashRenderer();
  const [, detail] = await gone;
  await win.loadFile(path.join(__dirname, 'composition.html')); await load(config.fixture); await call('renderAt', 1.25);
  check('Renderer crash leaves controller alive and reload recovers pixels', hash(await capture()) === repeated[0].hash, detail);
  save(); win.destroy(); app.exit(result.checks.some(x => !x.pass) ? 1 : 0);
}
main().catch(e => { encoder?.kill(); result.error = e.stack; save(); console.error(e); app.exit(1); });
