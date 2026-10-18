const { app, BrowserWindow, Menu, ipcMain, dialog, protocol, shell, clipboard } = require('electron');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const execFileAsync = promisify(execFile);

protocol.registerSchemesAsPrivileged([{ scheme: 'afclip-media', privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true, corsEnabled:true } },
  { scheme: 'afclip-graphic', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }]);
const args = process.argv.slice(2);
const projectDir = path.resolve(args[0] || '.');
const option = name => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; };
let window, endpoint, streamController, captureTimer, captured = false;
let previewSession, previewGeneration = 0;
let mediaLibraryEndpoint;
const previewFiles = new Map();
const previewGraphics = { graphics: {} };
const files = new Map();
const sourceFiles = new Map(), libraryResources = new Map();
const outputs = new Set();
function grantSourceFile(file) {
  const id = createHash('sha256').update(path.resolve(file)).digest('hex');
  sourceFiles.set(id, path.resolve(file));
  return `afclip-media://${id}/source`;
}
function grantLibraryResource(route, ep) {
  const url = new URL(route, ep.url), base = new URL(ep.url);
  if (url.origin !== base.origin || !/^\/v1\/(media|artifacts)\//.test(url.pathname)) throw new Error('Invalid library media resource');
  const token = new URL(ep.readerGui).searchParams.get('token');
  const id = createHash('sha256').update(url.href + token).digest('hex');
  libraryResources.set(id, { url: url.href, token });
  return `afclip-media://${id}/library`;
}
async function getMediaLibraryEndpoint() {
  if (!mediaLibraryEndpoint) {
    mediaLibraryEndpoint = execFileAsync(process.env.AFCLIP_NODE_PATH || 'node', [path.resolve(__dirname, '../library/cli.ts'), 'endpoint'], { windowsHide:true, timeout:15000 })
      .then(result => JSON.parse(result.stdout).result).catch(error => { mediaLibraryEndpoint = null; throw error; });
  }
  return mediaLibraryEndpoint;
}
app.commandLine.appendSwitch('force-color-profile', 'srgb');
// Chromium 152's DirectComposition VSync fallback sleeps for a rounded-up 17 ms
// on this Windows setup, delivering only ~56 fps. Use the GPU-backed EGL window
// compositor with Chromium's deadline scheduler instead of that hardware wait.
// This changes only the editor process; export workers retain their own settings.
const presentation = option('--presentation') || process.env.AFCLIP_PRESENTATION || (process.platform === 'win32' ? 'compatibility' : 'default');
if (!['default', 'compatibility', 'direct-composition'].includes(presentation)) throw new Error('Unknown presentation mode');
if (process.platform === 'win32' && presentation === 'compatibility') {
  app.commandLine.appendSwitch('disable-direct-composition');
  app.commandLine.appendSwitch('disable-gpu-vsync');
}

async function request(route, payload) {
  const response = await fetch(endpoint.url + route, {
    method: payload ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${endpoint.token}`, ...(payload ? { 'Content-Type': 'application/json' } : {}) },
    body: payload ? JSON.stringify(payload) : undefined,
    signal: AbortSignal.timeout(30000),
  });
  const reply = await response.json();
  if (!reply.ok) throw new Error(`${reply.error?.code || 'Command failed'}: ${reply.error?.message || response.statusText}`);
  allowOutputs(reply.result);
  return reply.result;
}

function allowOutputs(value) {
  if (!value || typeof value !== 'object') return;
  if (typeof value.output === 'string' && path.isAbsolute(value.output)) outputs.add(path.resolve(value.output));
  for (const item of Object.values(value)) if (item && typeof item === 'object') allowOutputs(item);
}

function checkSender(event) {
  if (event.sender !== window?.webContents || event.senderFrame !== window.webContents.mainFrame) throw new Error('Unknown window');
}

function handle(name, fn) {
  ipcMain.handle(`afclip:${name}`, async (event, ...values) => { checkSender(event); return fn(...values); });
}

async function watchEvents() {
  streamController = new AbortController();
  try {
    const response = await fetch(endpoint.url + '/events', { headers: { Authorization: `Bearer ${endpoint.token}` }, signal: streamController.signal });
    if (!response.ok) throw new Error(`Project connection returned ${response.status}`);
    const decoder = new TextDecoder();
    let pending = '';
    for await (const bytes of response.body) {
      pending += decoder.decode(bytes, { stream: true }).replace(/\r\n/g, '\n');
      let boundary;
      while ((boundary = pending.indexOf('\n\n')) >= 0) {
        const block = pending.slice(0, boundary); pending = pending.slice(boundary + 2);
        const name = block.match(/^event: ?(.+)$/m)?.[1] || 'message';
        const data = block.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
        if (!data) continue;
        const value = JSON.parse(data);
        allowOutputs(value);
        if (!window?.isDestroyed()) window.webContents.send('afclip:event', { type: name, value });
      }
    }
  } catch (error) {
    if (error.name !== 'AbortError' && !window?.isDestroyed()) window.webContents.send('afclip:event', { type: 'disconnected', value: { message: error.message } });
  }
}

async function capture() {
  if (captured || !option('--capture') || !window || window.isDestroyed()) return;
  captured = true;
  clearTimeout(captureTimer);
  const destination = path.resolve(option('--capture'));
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.writeFile(destination, (await window.webContents.capturePage()).toPNG());
  console.log(JSON.stringify({ capture: destination }));
  if (args.includes('--quit-after-capture')) { previewSession?.close(); streamController?.abort(); app.exit(0); }
}

app.whenReady().then(async () => {
  require('../render/graphic-protocol.cjs')(protocol, previewGraphics);
  const raster=require('../render/asset-raster.cjs')(()=>previewGraphics.graphics);
  handle('asset-raster',data=>raster.render(data));
  app.on('before-quit',()=>raster.close());
  const result = await execFileAsync(process.env.AFCLIP_NODE_PATH || 'node', [path.resolve(__dirname, '../cli.ts'), 'endpoint', projectDir], { windowsHide: true, timeout: 30000, maxBuffer: 4 * 1024 * 1024 });
  const reply = JSON.parse(result.stdout.trim());
  if (!reply.ok || !reply.result?.url || !reply.result?.token) throw new Error(reply.error?.message || 'Could not connect to project');
  endpoint = reply.result;
  const parsed = new URL(endpoint.url);
  if (parsed.hostname !== '127.0.0.1' || parsed.protocol !== 'http:') throw new Error('The project endpoint must be local');

  protocol.handle('afclip-media', async req => {
    const id = new URL(req.url).hostname;
    const remote = libraryResources.get(id);
    if (remote) {
      try {
        const headers = { Authorization: `Bearer ${remote.token}` };
        if (req.headers.has('range')) headers.Range = req.headers.get('range');
        const response = await fetch(remote.url, { method: req.method, headers, signal: req.signal });
        const forwarded = new Headers();
        for (const name of ['Content-Type', 'Content-Length', 'Content-Range', 'Accept-Ranges']) if (response.headers.has(name)) forwarded.set(name, response.headers.get(name));
        forwarded.set('Access-Control-Allow-Origin', 'file://');
        return new Response(response.body, { status: response.status, headers: forwarded });
      } catch { return new Response('Library media unavailable', { status: 502 }); }
    }
    const file = files.get(id) || previewFiles.get(id) || sourceFiles.get(id);
    if (!file) return new Response('Not found', { status: 404 });
    // Chromium needs real byte-range responses to seek a mixed WAV or export.
    let stat;
    try { stat = await fs.stat(file); } catch { return new Response('Not found', { status: 404 }); }
    const range = req.headers.get('range');
    let start = 0, end = stat.size - 1;
    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (!match || (!match[1] && !match[2])) return new Response(null, { status: 416 });
      if (!match[1]) start = Math.max(0, stat.size - Number(match[2]));
      else { start = Number(match[1]); if (match[2]) end = Math.min(end, Number(match[2])); }
      if (start > end || start >= stat.size) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${stat.size}` } });
    }
    const type = { '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.flac': 'audio/flac', '.ogg': 'audio/ogg', '.mp4': 'video/mp4', '.mov': 'video/mp4', '.webm': 'video/webm', '.mkv': 'video/x-matroska', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg' }[path.extname(file).toLowerCase()] || 'application/octet-stream';
    const headers = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Content-Length': String(end - start + 1), 'Access-Control-Allow-Origin':'file://',
      ...(range ? { 'Content-Range': `bytes ${start}-${end}/${stat.size}` } : {}) };
    const stream = req.method === 'HEAD' ? null : require('node:stream').Readable.toWeb(require('node:fs').createReadStream(file, { start, end }));
    return new Response(stream, { status: range ? 206 : 200, headers });
  });

  // The renderer owns every shortcut, so drop Electron's default menu accelerators (reload, devtools, close).
  Menu.setApplicationMenu(null);
  window = new BrowserWindow({ width: 1460, height: 940, minWidth: 1080, minHeight: 680, backgroundColor: '#0e0f11', title: 'AFClip', show: false,
    titleBarStyle: 'hidden', titleBarOverlay: { color: '#141518', symbolColor: '#9ba1aa', height: 36 },
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.on('console-message', details => { if (details.level === 'error' || details.level === 'warning') console.error('GUI:', details.message); });
  previewSession = new (require('./preview-session.cjs'))(projectDir,
    value => { if (!window.isDestroyed()) window.webContents.send('afclip:preview', value); },
    (file, id) => { previewFiles.set(id, file); return `afclip-media://${id}/asset`; },
    graphics => { raster.close(); previewGraphics.graphics = structuredClone(graphics); },
    id => previewFiles.delete(id));
  handle('preview-open', async mode => {
    if (!['gpu', 'software'].includes(mode)) throw new Error('Invalid preview mode');
    const generation = ++previewGeneration;
    raster.close(); previewFiles.clear(); previewGraphics.graphics = {};
    const state = await request('/inspect');
    if (generation !== previewGeneration) return { id: null, revision: state.project.revision };
    return previewSession.open(state.project, mode);
  });
  handle('preview-close', () => { previewGeneration++; raster.close(); previewFiles.clear(); previewGraphics.graphics = {}; previewSession.close(); });
  handle('preview-audio', async ({ sessionId, revision }) => {
    const state = await request('/inspect');
    if (state.project.revision !== revision) throw new Error('Project changed while preparing audio');
    return previewSession.audio(sessionId, state.project);
  });
  ipcMain.on('afclip:preview-frame', (event, value) => { checkSender(event); previewSession.frame(value); });
  handle('inspect', () => request('/inspect'));
  const sourceMedia = require('../shared/source-media.cjs')({
    projectDir, inspect: () => request('/inspect'), libraryEndpoint: getMediaLibraryEndpoint,
    grantFile: grantSourceFile, grantLibrary: grantLibraryResource,
    invalidateLibrary: () => { mediaLibraryEndpoint = null; },
  });
  handle('media-thumbnail', id => sourceMedia.thumbnail(id));
  handle('source-preview', id => sourceMedia.preview(id));
  handle('source-waveform', (id, options) => sourceMedia.waveform(id, options));
  handle('copy-text', text => {
    if (typeof text !== 'string' || text.length > 10000) throw new Error('Invalid clipboard text');
    clipboard.writeText(text);
  });
  handle('waveform', async id => {
    const { project } = await request('/inspect');
    const clip = project.clips.find(c => c.id === id);
    const media = clip && project.media.find(m => m.id === clip.mediaId);
    if (!media || !['audio', 'video'].includes(media.kind) || media.metadata?.hasAudio === false) throw new Error('Clip has no audio');
    const seconds = t => t.num / t.den;
    return require('../render/waveform.cjs').waveform(path.resolve(projectDir, media.path), seconds(clip.sourceIn), seconds(clip.duration) * seconds(clip.speed));
  });
  handle('library', async id => {
    await request('/command', {command:'library-sync'});
    const result = await execFileAsync(process.env.AFCLIP_NODE_PATH || 'node', [path.resolve(__dirname, '../library/cli.ts'), 'endpoint'], { windowsHide:true });
    const ep = JSON.parse(result.stdout).result;
    const env = {...process.env}; delete env.ELECTRON_RUN_AS_NODE;
    const child = require('node:child_process').spawn(process.execPath, [path.resolve(__dirname, '../library/main.cjs'), '--project', projectDir, ep.gui+(id?'&asset='+encodeURIComponent(id):'')], { windowsHide:true, detached:true, stdio:'ignore', env });
    child.unref(); return {opened:true};
  });
  handle('edit-library', async id => {
    const {project} = await request('/inspect');
    if (!project.media.some(m => m.metadata?.library?.assetId === id)) throw new Error('Asset is not in this project');
    await execFileAsync(process.env.AFCLIP_NODE_PATH || 'node', [path.resolve(__dirname, '../library/cli.ts'), 'gui', '--id', id], {windowsHide:true});
    return {opened:true};
  });
  handle('library-media', async () => {
    const { project } = await request('/inspect');
    if (!project.media.some(m => m.metadata?.library)) return {};
    try {
      return await require('./library-media.cjs')(project.media, await getMediaLibraryEndpoint());
    } catch (error) { mediaLibraryEndpoint = null; throw error; }
  });
  handle('command', payload => {
    if (!payload || !['asset-duplicate', 'asset-builtin', 'text-fields', 'text-set', 'apply', 'undo', 'redo', 'status', 'cancel', 'checkpoint', 'checkpoints', 'restore', 'library-import', 'library-sync', 'source-insert', 'source-prepare', 'source-jobs', 'source-cancel'].includes(payload.command)) throw new Error('Unsupported editor command');
    return request('/command', payload);
  });
  handle('import', async kind => {
    const graphic = kind === 'graphic';
    const selected = graphic
      ? await dialog.showOpenDialog(window, { title: 'Import graphic folder', properties: ['openDirectory'] })
      : await dialog.showOpenDialog(window, { title: 'Import media', properties: ['openFile', 'multiSelections'], filters: [{ name: 'Media', extensions: ['mp4', 'mov', 'mkv', 'webm', 'wav', 'mp3', 'm4a', 'flac', 'png', 'jpg', 'jpeg'] }] });
    if (selected.canceled) return null;
    const imported = [];
    for (const file of selected.filePaths) imported.push(await request('/command', { command: 'import', path: file, ...(graphic ? { kind: 'graphic' } : {}) }));
    return imported;
  });
  handle('render', async ({ kind, mode, frameTime, range, verification = 'quick' }) => {
    if (!['frame', 'export'].includes(kind) || !['gpu', 'software'].includes(mode || 'gpu')) throw new Error('Invalid render request');
    if (!['quick', 'full'].includes(verification)) throw new Error('Invalid verification mode');
    let output;
    if (kind === 'frame') {
      const cache = path.join(projectDir, 'cache', 'gui');
      await fs.mkdir(cache, { recursive: true });
      output = path.join(cache, 'preview.png');
    } else {
      const chosen = await dialog.showSaveDialog(window, { title: 'Export MP4', defaultPath: path.join(projectDir, 'exports', `edit-${new Date().toISOString().replace(/[:.]/g, '-')}.mp4`), filters: [{ name: 'MP4 video', extensions: ['mp4'] }] });
      if (chosen.canceled) return null;
      output = chosen.filePath;
      await fs.mkdir(path.dirname(output), { recursive: true });
    }
    outputs.add(path.resolve(output));
    return request('/command', { command: 'render', kind, mode: mode || 'gpu', verification, frameTime, range: kind === 'export' ? range : undefined, output });
  });
  handle('media-url', async file => {
    if (typeof file !== 'string' || !outputs.has(path.resolve(file))) throw new Error('This file is not a render result');
    const id = randomUUID(); files.set(id, path.resolve(file));
    if (files.size > 20) files.delete(files.keys().next().value);
    return `afclip-media://${id}/media`;
  });
  handle('show-output', file => { if (typeof file !== 'string' || !outputs.has(path.resolve(file))) throw new Error('This file is not a render result'); shell.showItemInFolder(path.resolve(file)); });
  handle('ready', async () => { if (option('--capture')) { clearTimeout(captureTimer); captureTimer = setTimeout(() => capture().catch(console.error), Number(option('--capture-delay') || 1200)); } });
  await window.loadFile(path.join(__dirname, 'index.html'));
  window.show();
  if (args.includes('--dev')) require('./dev-reload.cjs')(window, () => {
    previewGeneration++; previewSession.close(); raster.close(); previewFiles.clear(); previewGraphics.graphics = {};
  });
  watchEvents();
  if (option('--capture')) captureTimer = setTimeout(() => capture().catch(console.error), 45000);
}).catch(error => { console.error(error.stack || error.message); if (!args.includes('--quit-after-capture')) dialog.showErrorBox('AFClip could not open the project', error.message); app.exit(1); });

app.on('window-all-closed', () => { previewSession?.close(); streamController?.abort(); app.exit(0); });
app.on('before-quit', () => { previewSession?.close(); streamController?.abort(); clearTimeout(captureTimer); });
