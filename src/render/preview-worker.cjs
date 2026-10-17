// Persistent, disposable compositor. Only the latest waiting frame is retained.
const { app, BrowserWindow, protocol } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { createInterface } = require('node:readline');
const { at } = require('./timeline.cjs');
const file = process.argv[2];
const config = JSON.parse(fs.readFileSync(file, 'utf8'));
const scale = Math.min(1, 960 / config.width, 540 / config.height);
config.width = Math.max(2, Math.round(config.width * scale));
config.height = Math.max(2, Math.round(config.height * scale));
for (const media of Object.values(config.media)) if (media.width) {
  const ratio = Math.min(1, 960 / media.width, 540 / media.height);
  media.width = Math.max(2, Math.round(media.width * ratio));
  media.height = Math.max(2, Math.round(media.height * ratio));
  media.previewSize = true; media.hwaccel = config.mode === 'gpu' && media.kind === 'video';
}
const previewFile = path.join(config.work, 'preview.json');
fs.writeFileSync(previewFile, JSON.stringify(config));
app.commandLine.appendSwitch('force-device-scale-factor', '1');
app.commandLine.appendSwitch('force-color-profile', 'srgb');
if (config.mode === 'software') app.disableHardwareAcceleration();
app.setPath('userData', path.join(config.work, 'profile'));
protocol.registerSchemesAsPrivileged([{ scheme: 'reelet-graphic', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }]);
const emit = data => process.stdout.write(JSON.stringify(data) + '\n');
let win, latest, busy = false, ready = false, token = 0, pending, previousEpoch, previousTime;
function fail(error) { emit({ type: 'error', error: { message: error.message } }); shutdown(1); }
async function shutdown(code = 0) {
  ready = false; latest = null;
  if (win && !win.isDestroyed()) {
    await win.webContents.executeJavaScript('window.reeletFrames.close()').catch(() => {});
    win.destroy();
  }
  app.exit(code);
}
async function pump() {
  if (busy || !ready || !latest) return;
  busy = true;
  const request = latest; latest = null;
  const wanted = ++token;
  let timer;
  try {
    if (previousEpoch !== request.epoch && (previousTime == null || request.time < previousTime || request.time - previousTime > .25)) await win.webContents.executeJavaScript('window.reeletFrames.close()');
    previousEpoch = request.epoch; previousTime = request.time;
    const painted = new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Preview frame timed out')), 15000);
      pending = { token: wanted, resolve, reject };
    });
    painted.catch(() => {});
    const stats = await win.webContents.executeJavaScript(`window.renderFrame(${JSON.stringify(at(config.plan, request.time))},${wanted})`);
    const image = await painted;
    if (!latest || latest.epoch === request.epoch) emit({ type: 'frame', ...request, image: 'data:image/jpeg;base64,' + image.toJPEG(88).toString('base64'), stats });
  } catch (error) { fail(error); }
  finally { clearTimeout(timer); pending = null; busy = false; pump(); }
}
const control = require('node:net').connect(config.control.port, '127.0.0.1', () => control.write(config.control.token + '\n'));
control.on('error', fail);
createInterface({ input: control }).on('line', line => {
  try {
    const request = JSON.parse(line);
    if (request.type === 'close') { shutdown(); return; }
    if (request.type === 'plan') { config.plan = request.plan; return; }
    if (Number.isFinite(request.time) && request.time >= 0 && request.time <= config.plan.duration && Number.isSafeInteger(request.epoch)) {
      latest = request; pump();
    }
  } catch (error) { fail(error); }
}).on('close', () => shutdown());
app.whenReady().then(async () => {
  require('./graphic-protocol.cjs')(protocol, config);
  const { width, height } = config;
  win = new BrowserWindow({ width, height: height + 8, useContentSize: true, show: false, webPreferences: {
    offscreen: true, backgroundThrottling: false, sandbox: false, nodeIntegration: false, contextIsolation: true,
    preload: path.join(__dirname, 'preload.cjs'), additionalArguments: [`--reelet-render=${previewFile}`],
  } });
  win.webContents.setFrameRate(120);
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', event => event.preventDefault());
  win.webContents.on('will-frame-navigate', (event, details) => { if (details?.url && !details.url.startsWith('reelet-graphic:')) event.preventDefault(); });
  win.webContents.on('render-process-gone', (_, details) => fail(new Error(`Preview compositor failed: ${details.reason}`)));
  win.webContents.session.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !(
    details.url.startsWith('reelet-graphic:') || details.url.startsWith('data:') ||
    details.url === require('node:url').pathToFileURL(path.join(__dirname, 'compositor.html')).href
  ) }));
  win.webContents.on('paint', (_event, _dirty, image) => {
    if (!pending) return;
    const bytes = image.toBitmap(), p = ((height + 4) * width + width - 4) * 4;
    if (bytes.length !== width * (height + 8) * 4 || (bytes[p + 2] | bytes[p + 1] << 8 | bytes[p] << 16) !== pending.token) return;
    pending.resolve(image.crop({ x: 0, y: 0, width, height }));
  });
  await win.loadFile(path.join(__dirname, 'compositor.html'));
  await win.webContents.executeJavaScript('window.ready');
  ready = true;
  emit({ type: 'ready', audio: config.audio, duration: config.plan.duration, width, height });
  pump();
}).catch(fail);
