// Alternative renderer: explicit FFmpeg RGB conversion + original-resolution decoded-frame cache.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { performance } = require('node:perf_hooks');
const { createHash } = require('node:crypto');
const config = JSON.parse(fs.readFileSync(process.argv[2]));
const mode = process.argv[3];
const encoderName = config.encoder || (mode === 'gpu' ? 'h264_nvenc' : 'libx264');
const nvenc = encoderName === 'h264_nvenc';
if (mode === 'software') app.disableHardwareAcceleration();
app.commandLine.appendSwitch('force-device-scale-factor', '1');
app.commandLine.appendSwitch('force-color-profile', 'srgb');
app.setPath('userData', path.join(config.out, `frames-profile-${mode}`));
const result = { mode, encoder: encoderName, checks: [], sources: [] };
const save = () => fs.writeFileSync(path.join(config.out, `frames-${mode}.json`), JSON.stringify(result, null, 2));
function stats(xs) { const s = [...xs].sort((a, b) => a - b); return { n: s.length, median: s[Math.floor(s.length / 2)], p95: s[Math.min(s.length - 1, Math.ceil(s.length * .95) - 1)], max: s.at(-1) }; }
function check(name, pass, details) { result.checks.push({ name, pass, details }); save(); }
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
let win, encoder;
async function main() {
  await app.whenReady();
  win = new BrowserWindow({ width: 1920, height: 1080, show: false, webPreferences: { offscreen: true, backgroundThrottling: false, nodeIntegration: false, contextIsolation: true, sandbox: false, preload: path.join(__dirname, 'frame-preload.cjs'), additionalArguments: [`--frames-config=${process.argv[2]}`] } });
  win.webContents.setFrameRate(240);
  await win.loadFile(path.join(__dirname, 'frames.html'));
  await win.webContents.executeJavaScript('document.fonts.ready');
  let token = 0;
  async function render(t, options = {}) {
    const wanted = ++token;
    let timer, listener;
    const painted = new Promise((resolve, reject) => {
      listener = (_, dirty, image) => {
        const bytes = image.toBitmap();
        if (bytes.length !== 1920 * 1080 * 4) return;
        const p = ((1080 - 4) * 1920 + 1920 - 4) * 4;
        const seen = bytes[p + 2] | (bytes[p + 1] << 8) | (bytes[p] << 16);
        if (seen !== wanted) return;
        win.webContents.off('paint', listener); clearTimeout(timer);
        // The readiness token occupies an excluded 8x8 diagnostic patch.
        resolve({ bytes, image });
      };
      win.webContents.on('paint', listener);
      timer = setTimeout(() => { win.webContents.off('paint', listener); reject(new Error(`Paint timeout for token ${wanted}`)); }, 10000);
    });
    painted.catch(() => {});
    try {
      await win.webContents.executeJavaScript(`render(${t},${wanted},${JSON.stringify(options)})`);
      return await painted;
    } catch (e) { clearTimeout(timer); win.webContents.off('paint', listener); throw e; }
  }
  // Ignore the test-only token when comparing composition hashes.
  function contentHash(bytes) { const copy = Buffer.from(bytes); for (let y = 1072; y < 1080; y++) copy.fill(0, (y * 1920 + 1912) * 4, (y * 1920 + 1920) * 4); return hash(copy); }
  for (const id of (config.exportOnly ? [] : Object.keys(config.frames))) {
    const times = [], hashes = [];
    for (const t of (id === 'vfr' ? [.3, .333333333333, .366666666667, .4, 1, 2, 3] : [2.8, .1, 4.2, 1.3, 3.6, .5, 2.1, 4.8, .9, 3.1])) {
      const start = performance.now(), frame = await render(t, { source: id, single: true, noGraphics: id === 'vfr' }); times.push(performance.now() - start);
      if (id === 'vfr') {
        const expected = config.pts.findLastIndex(pts => pts <= t + 1e-6), value = frame.bytes[(200 * 1920 + 200) * 4];
        check(`VFR frame at ${t}`, Math.abs(value - (20 + expected * 2)) <= 1, { expected, value });
      }
      hashes.push(contentHash(frame.bytes));
    }
    result.sources.push({ id, seekAndPaintMs: stats(times), uniqueFrames: new Set(hashes).size });
    check(`${id}: distinct source frames`, new Set(hashes).size > 1, { uniqueFrames: new Set(hashes).size });
    const frame = await render(1, { source: id, single: true }); fs.writeFileSync(path.join(config.out, `${mode}-${id}.png`), frame.image.toPNG());
  }
  const repeated = [];
  if (!config.exportOnly) {
    for (const t of [1.25, 3.75, .2, 1.25, 2.5, 3.75]) repeated.push(contentHash((await render(t)).bytes));
    check('Arbitrary seeks reproduce exact composition', repeated[0] === repeated[3] && repeated[1] === repeated[5], repeated);
  }
  result.exports = [];
  for (const id of Object.keys(config.mixes)) {
    const prefix = id === 'fixture' ? mode : `${mode}-${id}`;
    const output = path.join(config.out, `composed-${prefix}.mp4`);
    const args = ['-hide_banner', '-y', '-f', 'rawvideo', '-pix_fmt', 'bgra', '-s', '1920x1080', '-r', '30', '-i', 'pipe:0', '-i', config.mixes[id].file, '-c:v', encoderName, '-preset', nvenc ? 'p4' : 'fast', ...(nvenc ? (config.encoder ? ['-rc', 'constqp', '-qp', '16', '-bf', '0'] : ['-cq', '18']) : ['-crf', '18']), '-vf', 'scale=in_range=full:out_range=tv:out_color_matrix=bt709,format=yuv420p', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709', '-c:a', 'aac', '-b:a', '192k', '-t', '5', output];
    encoder = spawn(config.ffmpeg, args, { windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] });
    encoder.stdin.on('error', () => {});
    const log = fs.createWriteStream(path.join(config.out, `encode-${prefix}.log`)); log.write(JSON.stringify(args) + '\n'); encoder.stderr.pipe(log);
    const done = new Promise((resolve, reject) => { encoder.on('error', reject); encoder.on('close', code => code === 0 ? resolve() : reject(new Error(`Encoder exit ${code}`))); }); done.catch(() => {});
    const times = [], pipe = [], images = [];
    const start = performance.now();
    for (let frame = 0; frame < 150; frame++) {
      const tick = performance.now(), rendered = await render(frame / 30, { source: id }); times.push(performance.now() - tick);
      const write = performance.now(); await new Promise((resolve, reject) => encoder.stdin.write(rendered.bytes, e => e ? reject(e) : resolve())); pipe.push(performance.now() - write);
      if ([0, 30, 75, 120].includes(frame)) images.push({ frame, image: rendered.image });
  }
  encoder.stdin.end(); await done;
  const wallMs = performance.now() - start;
  for (const { frame, image } of images) fs.writeFileSync(path.join(config.out, `${prefix}-frame-${frame}.png`), image.toPNG());
  result.exports.push({ id, prefix, wallMs, fps: 150000 / wallMs, realtime: 5000 / wallMs, renderAndReadbackMs: stats(times), pipeMs: stats(pipe), output });
  if (id === 'fixture') result.export = result.exports.at(-1);
  save();
  }
  result.gpuFeatures = app.getGPUFeatureStatus(); save();
  win.destroy(); app.exit(result.checks.some(x => !x.pass) ? 1 : 0);
}
main().catch(e => { encoder?.kill(); result.error = e.stack; save(); console.error(e); app.exit(1); });
