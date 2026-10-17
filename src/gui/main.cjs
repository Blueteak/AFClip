const { app, BrowserWindow, Menu, ipcMain, dialog, protocol, net, shell } = require('electron');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { randomUUID } = require('node:crypto');
const execFileAsync = promisify(execFile);

protocol.registerSchemesAsPrivileged([{ scheme: 'reelet-media', privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true } }]);
const args = process.argv.slice(2);
const projectDir = path.resolve(args[0] || '.');
const option = name => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; };
let window, endpoint, streamController, captureTimer, captured = false;
const files = new Map();
const outputs = new Set();

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
  ipcMain.handle(`reelet:${name}`, async (event, ...values) => { checkSender(event); return fn(...values); });
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
        if (!window?.isDestroyed()) window.webContents.send('reelet:event', { type: name, value });
      }
    }
  } catch (error) {
    if (error.name !== 'AbortError' && !window?.isDestroyed()) window.webContents.send('reelet:event', { type: 'disconnected', value: { message: error.message } });
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
  if (args.includes('--quit-after-capture')) { streamController?.abort(); app.exit(0); }
}

app.whenReady().then(async () => {
  const result = await execFileAsync(process.env.REELET_NODE_PATH || 'node', [path.resolve(__dirname, '../cli.ts'), 'endpoint', projectDir], { windowsHide: true, timeout: 30000, maxBuffer: 4 * 1024 * 1024 });
  const reply = JSON.parse(result.stdout.trim());
  if (!reply.ok || !reply.result?.url || !reply.result?.token) throw new Error(reply.error?.message || 'Could not connect to project');
  endpoint = reply.result;
  const parsed = new URL(endpoint.url);
  if (parsed.hostname !== '127.0.0.1' || parsed.protocol !== 'http:') throw new Error('The project endpoint must be local');

  protocol.handle('reelet-media', req => {
    const id = new URL(req.url).hostname;
    const file = files.get(id);
    if (!file) return new Response('Not found', { status: 404 });
    return net.fetch(pathToFileURL(file).href, { headers: req.headers });
  });

  // The renderer owns every shortcut, so drop Electron's default menu accelerators (reload, devtools, close).
  Menu.setApplicationMenu(null);
  window = new BrowserWindow({ width: 1460, height: 940, minWidth: 1080, minHeight: 680, backgroundColor: '#0e0f11', title: 'Reelet', show: false,
    titleBarStyle: 'hidden', titleBarOverlay: { color: '#141518', symbolColor: '#9ba1aa', height: 36 },
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.on('console-message', (_event, details) => { if (details.level === 'error' || details.level === 3) console.error('GUI:', details.message); });
  handle('inspect', () => request('/inspect'));
  handle('command', payload => {
    if (!payload || !['apply', 'undo', 'redo', 'status', 'cancel', 'checkpoint', 'checkpoints', 'restore'].includes(payload.command)) throw new Error('Unsupported editor command');
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
    return `reelet-media://${id}/media`;
  });
  handle('show-output', file => { if (typeof file !== 'string' || !outputs.has(path.resolve(file))) throw new Error('This file is not a render result'); shell.showItemInFolder(path.resolve(file)); });
  handle('ready', async () => { if (option('--capture')) { clearTimeout(captureTimer); captureTimer = setTimeout(() => capture().catch(console.error), Number(option('--capture-delay') || 1200)); } });
  await window.loadFile(path.join(__dirname, 'index.html'));
  window.show();
  watchEvents();
  if (option('--capture')) captureTimer = setTimeout(() => capture().catch(console.error), 45000);
}).catch(error => { console.error(error.stack || error.message); if (!args.includes('--quit-after-capture')) dialog.showErrorBox('Reelet could not open the project', error.message); app.exit(1); });

app.on('window-all-closed', () => { streamController?.abort(); app.exit(0); });
app.on('before-quit', () => { streamController?.abort(); clearTimeout(captureTimer); });
