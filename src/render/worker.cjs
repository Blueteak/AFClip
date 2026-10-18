const { app, BrowserWindow, ipcMain, protocol } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createInterface } = require('node:readline');
const { performance } = require('node:perf_hooks');
const { at } = require('./timeline.cjs');
const config = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const { width, height } = config, captureHeight = height + 8;
const shared = config.mode === 'gpu' && config.kind !== 'frame';
if (config.mode === 'software') app.disableHardwareAcceleration();
app.commandLine.appendSwitch('force-device-scale-factor', '1');
app.commandLine.appendSwitch('force-color-profile', 'srgb');
app.commandLine.appendSwitch('force_high_performance_gpu');
app.setPath('userData', path.join(config.work, 'profile'));
protocol.registerSchemesAsPrivileged([{ scheme: 'afclip-graphic', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }]);
const emit = data => process.stdout.write(JSON.stringify(data) + '\n');
const stats = { frames: 0, peakDecodedBytes: 0, peakDecoders: 0, peakChromiumWorkingSetBytes: 0, fullFrameReadback: !shared, rejectedPaints: 0 };
let win, encoder, waiting, pending, queuedTexture, busy = false, token = 0, shuttingDown = false;
function fail(e) { if (waiting) { waiting.reject(e); waiting = null; } if (pending) { pending.reject(e); pending = null; } }
function reply() {
  if (waiting) throw new Error('Encoder commands must be serial');
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { waiting = null; reject(new Error('GPU encoder timed out')); }, 15000);
    waiting = { resolve: r => { clearTimeout(timer); resolve(r); }, reject: e => { clearTimeout(timer); reject(e); } };
  });
}
function command(line) { const done = reply(); encoder.stdin.write(line + '\n'); return done; }
function bounded(promise, time, label) { let timer; return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out`)), time); })]).finally(() => clearTimeout(timer)); }
async function main() {
  await app.whenReady();
  require('./graphic-protocol.cjs')(protocol, config);
  const raster=require('./asset-raster.cjs')(()=>config.graphics);
  ipcMain.handle('afclip:asset-raster',(_event,data)=>raster.render(data));
  let encoded;
  if (shared) {
    const ready = reply();
    encoder = spawn(config.nativeEncoder, [String(process.pid), String(width), String(height), String(config.project.fps.num), String(config.project.fps.den), '8'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    encoder.stderr.pipe(fs.createWriteStream(path.join(config.work, 'native.log')));
    encoder.stdin.on('error', fail); encoder.on('error', fail); encoder.on('exit', code => { if (!shuttingDown) fail(new Error(`NVENC helper exited ${code}; inspect native.log`)); });
    createInterface({ input: encoder.stdout }).on('line', line => { try { const r = JSON.parse(line), request = waiting; waiting = null; if (!request) throw new Error('Unexpected encoder reply'); request.resolve(r); } catch (e) { fail(e); } });
    await ready; await command(`start ${JSON.stringify(path.join(config.work, 'video.h264').replaceAll('\\', '/'))}`);
  } else if (config.kind !== 'frame') {
    // The raw H.264 mux path assigns frame timestamps. Disable reordering so
    // presentation and decode order agree, including the first/last range frames.
    encoder = spawn(config.ffmpeg, ['-hide_banner', '-y', '-f', 'rawvideo', '-pix_fmt', 'bgra', '-s', `${width}x${height}`, '-r', `${config.project.fps.num}/${config.project.fps.den}`, '-i', 'pipe:0', '-an', '-vf', 'scale=in_range=full:out_range=tv:out_color_matrix=bt709,format=yuv420p', '-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-bf', '0', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709', '-f', 'h264', path.join(config.work, 'video.h264')], { windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] });
    encoder.stderr.pipe(fs.createWriteStream(path.join(config.work, 'encode.log'))); encoder.stdin.on('error', fail);
    encoded = new Promise((resolve, reject) => { encoder.on('error', reject); encoder.on('close', code => code === 0 ? resolve() : reject(new Error(`Software encoder exited ${code}`))); }); encoded.catch(fail);
  }
  win = new BrowserWindow({ width, height: captureHeight, useContentSize: true, show: false, webPreferences: {
    offscreen: shared ? { useSharedTexture: true } : true, backgroundThrottling: false, sandbox: false, nodeIntegration: false, contextIsolation: true,
    preload: path.join(__dirname, 'preload.cjs'), additionalArguments: [`--afclip-render=${process.argv[2]}`]
  } });
  win.webContents.setFrameRate(240);
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', event => event.preventDefault());
  win.webContents.on('will-frame-navigate', (event, details) => { if (details?.url && !details.url.startsWith('afclip-graphic:')) event.preventDefault(); });
  win.webContents.on('render-process-gone', (_, details) => fail(new Error(`Compositor failed: ${details.reason}`)));
  win.webContents.on('console-message', (_, details) => console.error(`Graphic/compositor: ${details.message}`));
  win.webContents.session.webRequest.onBeforeRequest((details, callback) => {
    const allowed = details.url.startsWith('afclip-graphic:') || details.url === require('node:url').pathToFileURL(path.join(__dirname, 'compositor.html')).href || details.url.startsWith('data:') || ['asset-runtime.js','../shared/asset.cjs'].some(name=>details.url===require('node:url').pathToFileURL(path.join(__dirname,name)).href);
    callback({ cancel: !allowed });
  });
  async function consume(texture) {
    if (!pending) { texture.release(); return; }
    if (busy) { queuedTexture?.release(); queuedTexture = texture; return; }
    busy = true; const request = pending;
    try {
      const info = texture.textureInfo, handle = info.handle.ntHandle;
      if (!handle || handle.length !== 8) throw new Error('Windows shared texture unavailable');
      const ack = await command(`frame ${handle.readBigUInt64LE().toString(16)} ${request.token}`);
      if (ack.accepted) { pending = null; request.resolve(ack); } else stats.rejectedPaints++;
    } catch (e) { fail(e); }
    finally { texture.release(); busy = false; if (queuedTexture) { const next = queuedTexture; queuedTexture = null; consume(next); } }
  }
  win.webContents.on('paint', (event, dirty, image) => {
    if (shared) { if (event.texture) consume(event.texture); return; }
    if (!pending) return;
    try {
      const bytes = image.toBitmap(); if (bytes.length !== width * captureHeight * 4) return;
      const p = ((captureHeight - 4) * width + width - 4) * 4;
      if ((bytes[p + 2] | (bytes[p + 1] << 8) | (bytes[p] << 16)) !== pending.token) { stats.rejectedPaints++; return; }
      const request = pending; pending = null; request.resolve({ bytes: bytes.subarray(0, width * height * 4), image });
    } catch (e) { fail(e); }
  });
  await win.loadFile(path.join(__dirname, 'compositor.html'));
  await bounded(win.webContents.executeJavaScript('window.ready'), 20000, 'Graphic assets');
  const fps = config.project.fps.num / config.project.fps.den;
  const total = config.kind === 'frame' ? 1 : Math.ceil((config.end - config.begin) * fps - 1e-8), start = performance.now();
  for (let frame = 0; frame < total; frame++) {
    const time = config.begin + frame / fps, wanted = ++token;
    let timer;
    const painted = new Promise((resolve, reject) => { timer = setTimeout(() => { pending = null; reject(new Error(`Frame ${frame} timed out`)); }, 30000); pending = { token: wanted, resolve, reject }; }); painted.catch(() => {});
    let result;
    try {
      const decoderStats = await win.webContents.executeJavaScript(`window.renderFrame(${JSON.stringify(at(config.plan, time))},${wanted})`);
      Object.assign(stats, decoderStats); result = await painted;
    } finally { clearTimeout(timer); }
    if (shared && result.frame !== frame) throw new Error(`Encoded frame order mismatch at ${frame}`);
    if (config.kind === 'frame') fs.writeFileSync(config.partial, result.image.crop({ x: 0, y: 0, width, height }).toPNG());
    else if (!shared) await new Promise((resolve, reject) => encoder.stdin.write(result.bytes, e => e ? reject(e) : resolve()));
    stats.frames++;
    if (frame % 15 === 0 || frame === total - 1) {
      stats.peakChromiumWorkingSetBytes = Math.max(stats.peakChromiumWorkingSetBytes, app.getAppMetrics().reduce((sum, p) => sum + (p.memory?.workingSetSize || 0) * 1024, 0));
      emit({ type: 'progress', phase: 'render', progress: .1 + .85 * (frame + 1) / total, frame: frame + 1, totalFrames: total, fps: (frame + 1) * 1000 / (performance.now() - start), message: `Rendering ${frame + 1}/${total}` });
    }
  }
  await win.webContents.executeJavaScript('window.afclipFrames.close()');
  if (shared) { const ended = await command('end'); if (ended.frames !== total) throw new Error('NVENC frame count mismatch'); shuttingDown = true; encoder.stdin.end(); }
  else if (encoded) { encoder.stdin.end(); await encoded; }
  stats.renderMs = performance.now() - start; stats.renderFps = total * 1000 / stats.renderMs;
  fs.writeFileSync(path.join(config.work, 'stats.json'), JSON.stringify(stats, null, 2));
  win.destroy(); app.exit(0);
}
main().catch(e => { shuttingDown = true; encoder?.kill(); queuedTexture?.release(); if (win && !win.isDestroyed()) win.destroy(); console.error(e.stack); app.exit(1); });
