// Electron keeps each texture alive until the native helper acknowledges GPU completion.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createInterface } = require('node:readline');
const { performance } = require('node:perf_hooks');
const config = JSON.parse(fs.readFileSync(process.argv[2]));
app.commandLine.appendSwitch('force-device-scale-factor', '1');
app.commandLine.appendSwitch('force-color-profile', 'srgb');
app.commandLine.appendSwitch('force_high_performance_gpu');
app.setPath('userData', path.join(config.out, 'shared-profile'));
const result = { mode: 'shared-texture', exports: [], checks: [] };
const save = () => fs.writeFileSync(path.join(config.out, 'shared.json'), JSON.stringify(result, null, 2));
function stats(xs) { const s = [...xs].sort((a, b) => a - b); return { median: s[Math.floor(s.length / 2)], p95: s[Math.ceil(s.length * .95) - 1], max: s.at(-1) }; }
let win, helper, waiting, pending, queuedTexture, busy = false, token = 0;
function fail(e) { if (waiting) { waiting.reject(e); waiting = null; } if (pending) { pending.reject(e); pending = null; } }
function reply() {
  if (waiting) throw new Error('Native helper commands must be serial');
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { waiting = null; reject(new Error('Native helper timed out')); }, 10000);
    waiting = { resolve: r => { clearTimeout(timer); resolve(r); }, reject: e => { clearTimeout(timer); reject(e); } };
  });
}
function command(line) { const response = reply(); helper.stdin.write(line + '\n'); return response; }
async function run(binary, args) {
  await new Promise((resolve, reject) => {
    const child = spawn(binary, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    const log = fs.createWriteStream(path.join(config.out, `mux-${result.exports.length}.log`)); child.stderr.pipe(log);
    child.on('error', reject); child.on('close', code => code === 0 ? resolve() : reject(new Error(`Mux exited ${code}`)));
  });
}
async function main() {
  await app.whenReady();
  const ready = reply();
  helper = spawn(config.nativeEncoder, [String(process.pid)], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  helper.stdin.on('error', fail);
  helper.stderr.pipe(fs.createWriteStream(path.join(config.out, 'native.log')));
  helper.on('error', fail); helper.on('exit', code => fail(new Error(`Native helper exited ${code}; inspect native.log`)));
  createInterface({ input: helper.stdout }).on('line', line => {
    try { const r = JSON.parse(line), request = waiting; waiting = null; if (!request) throw new Error('Unexpected native reply'); request.resolve(r); } catch (e) { fail(e); }
  });
  result.encoder = await ready;
  win = new BrowserWindow({ width: 1920, height: 1080, show: false, webPreferences: {
    offscreen: { useSharedTexture: true }, backgroundThrottling: false,
    nodeIntegration: false, contextIsolation: true, sandbox: false,
    preload: path.join(__dirname, 'frame-preload.cjs'), additionalArguments: [`--frames-config=${process.argv[2]}`]
  } });
  win.webContents.setFrameRate(240);
  async function consume(texture) {
    if (!pending) { texture.release(); return; }
    if (busy) { queuedTexture?.release(); queuedTexture = texture; return; }
    const request = pending; busy = true;
    try {
      const info = texture.textureInfo;
      result.textureFormat ||= { pixelFormat: info.pixelFormat, codedSize: info.codedSize, colorSpace: info.colorSpace };
      const handle = info.handle.ntHandle;
      if (!handle || handle.length !== 8) throw new Error('Expected Windows x64 shared texture handle');
      const ack = await command(`frame ${handle.readBigUInt64LE().toString(16)} ${request.token}`);
      if (ack.accepted) { pending = null; request.resolve(ack); }
      else result.rejectedPaints = (result.rejectedPaints || 0) + 1;
    } catch (e) { fail(e); }
    finally {
      texture.release(); busy = false;
      if (queuedTexture) { const next = queuedTexture; queuedTexture = null; consume(next); }
    }
  }
  win.webContents.on('paint', event => { if (event.texture) consume(event.texture); });
  await win.loadFile(path.join(__dirname, 'frames.html'));
  await win.webContents.executeJavaScript('document.fonts.ready');
  async function render(t, options) {
    const wanted = ++token;
    let timer;
    const painted = new Promise((resolve, reject) => {
      timer = setTimeout(() => { pending = null; reject(new Error(`Shared paint timeout ${wanted}`)); }, 10000);
      pending = { token: wanted, resolve, reject };
    });
    painted.catch(() => {});
    try { await win.webContents.executeJavaScript(`render(${t},${wanted},${JSON.stringify(options)})`); return await painted; }
    finally { clearTimeout(timer); }
  }
  for (const id of Object.keys(config.mixes)) {
    for (let repeat = 0; repeat < (config.repeats || 1); repeat++) {
      const prefix = `shared-${id}-${repeat}`, raw = path.join(config.out, `${prefix}.h264`), output = path.join(config.out, `${prefix}.mp4`);
      const init = performance.now(); await command(`start ${JSON.stringify(raw.replaceAll('\\', '/'))}`);
      const initializeMs = performance.now() - init, times = [], native = [], readiness = [], tokens = [];
      const start = performance.now();
      for (let frame = 0; frame < 150; frame++) {
        const tick = performance.now(), ack = await render(frame / 30, { source: id });
        times.push(performance.now() - tick); native.push(ack.nativeMs); readiness.push(ack.readinessMs); tokens.push(token);
        if (ack.frame !== frame) throw new Error(`Encoder frame order ${ack.frame} != ${frame}`);
      }
      const ended = await command('end'), encodeMs = performance.now() - start;
      const muxStart = performance.now();
      await run(config.ffmpeg, ['-hide_banner', '-y', '-r', '30', '-i', raw, '-i', config.mixes[id].file, '-map', '0:v', '-map', '1:a', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-t', '5', output]);
      const muxMs = performance.now() - muxStart, wallMs = initializeMs + encodeMs + muxMs;
      result.exports.push({ id, repeat, output, initializeMs, encodeMs, muxMs, wallMs, fps: 150000 / wallMs, encodeFps: 150000 / encodeMs,
        frameMs: stats(times), nativeMs: stats(native), readinessMs: stats(readiness), frames: ended.frames, tokens,
        fullFrameCpuReadbackBytes: 0, readinessReadbackBytes: 150 * 4 }); save();
    }
  }
  // Exercise the same arbitrary VFR project times as the bitmap renderer.
  const vfrTimes = [.3, .333333333333, .366666666667, .4, 1, 2, 3];
  const vfrOutput = path.join(config.out, 'shared-vfr.h264');
  await command(`start ${JSON.stringify(vfrOutput.replaceAll('\\', '/'))}`);
  for (const t of vfrTimes) await render(t, { source: 'vfr', single: true, noGraphics: true });
  await command('end'); result.vfr = { output: vfrOutput, times: vfrTimes };
  result.gpuFeatures = app.getGPUFeatureStatus(); save();
  helper.stdin.end(); win.destroy(); app.exit(0);
}
main().catch(e => { helper?.kill(); result.error = e.stack; save(); console.error(e); app.exit(1); });
