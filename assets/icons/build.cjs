// Run with node assets/icons/build.cjs after changing afclip.svg.
const fs = require('node:fs');
const path = require('node:path');

if (!process.versions.electron) {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const result = require('node:child_process').spawnSync(require('electron'), [__filename], { env, windowsHide: true, stdio: 'inherit' });
  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
}

const { app, BrowserWindow } = require('electron');
const buildProfile = path.join(require('node:os').tmpdir(), 'afclip-icon-build');
fs.mkdirSync(buildProfile, { recursive: true });
app.setPath('userData', buildProfile);
app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  await window.loadURL('data:text/html,<html></html>');
  const svg = fs.readFileSync(path.join(__dirname, 'afclip.svg'), 'utf8');
  const sizes = [16, 20, 24, 32, 40, 48, 64, 256];
  const images = await window.webContents.executeJavaScript(`(async () => {
    const image = new Image();
    image.src = 'data:image/svg+xml;base64,' + ${JSON.stringify(Buffer.from(svg).toString('base64'))};
    await image.decode();
    return ${JSON.stringify(sizes)}.map(size => {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = size;
      canvas.getContext('2d').drawImage(image, 0, 0, size, size);
      return canvas.toDataURL('image/png').split(',')[1];
    });
  })()`);
  const pngs = images.map(image => Buffer.from(image, 'base64'));
  fs.writeFileSync(path.join(__dirname, 'afclip.png'), pngs.at(-1));
  const header = Buffer.alloc(6 + sizes.length * 16);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(sizes.length, 4);
  let offset = header.length;
  sizes.forEach((size, index) => {
    const entry = 6 + index * 16;
    header[entry] = header[entry + 1] = size === 256 ? 0 : size;
    header.writeUInt16LE(1, entry + 4);
    header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(pngs[index].length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += pngs[index].length;
  });
  fs.writeFileSync(path.join(__dirname, 'afclip.ico'), Buffer.concat([header, ...pngs]));
  app.quit();
}).catch(error => { console.error(error); app.exit(1); });
