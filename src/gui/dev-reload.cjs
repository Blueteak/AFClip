// Development-only renderer reload. The project engine keeps owning edits/history.
const { watch } = require('node:fs');
const path = require('node:path');

module.exports = function watchRenderer(window, beforeReload = () => {}, options = {}) {
  let timer, dirty = 0, closed = false;
  const schedule = () => { clearTimeout(timer); timer = setTimeout(reload, 350); };
  const changed = () => { dirty++; schedule(); };
  async function reload() {
    if (closed || !dirty) return;
    if (!window.isEnabled() || window.webContents.isLoading()) return schedule();
    const version = dirty;
    try {
      if (!await window.webContents.executeJavaScript('window.afclipPrepareReload?.() === true')) return schedule();
      if (closed) return;
      beforeReload();
      dirty = dirty === version ? 0 : dirty;
      window.webContents.reloadIgnoringCache();
      if (dirty) schedule();
    } catch (error) {
      if (!closed) { console.warn('GUI reload deferred:', error.message); schedule(); }
    }
  }
  const files = options.files || [
    ...['app.js','playback.js','native-preview.js','source-preview.js','audio-waveform.js','agents.js','generation.js','styles.css','index.html'].map(name => path.join(__dirname,name)),
    path.join(__dirname,'../render/timeline.cjs'),path.join(__dirname,'../render/asset-runtime.js'),path.join(__dirname,'../shared/asset.cjs'),
  ];
  const directories = new Map();
  for (const file of files) {
    const directory = path.dirname(file);
    if (!directories.has(directory)) directories.set(directory,new Set());
    directories.get(directory).add(path.basename(file));
  }
  const watchers = [...directories].map(([directory,names]) =>
    watch(directory, (_event, name) => { if (names.has(String(name))) changed(); }));
  for (const watcher of watchers) watcher.on('error', error => console.warn('GUI watcher:', error.message));
  window.once('closed', () => { closed = true; clearTimeout(timer); for (const watcher of watchers) watcher.close(); });
};
