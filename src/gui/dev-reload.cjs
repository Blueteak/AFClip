// Development-only renderer reload. The project engine keeps owning edits/history.
const { watch } = require('node:fs');
const path = require('node:path');

module.exports = function watchRenderer(window, beforeReload) {
  let timer, dirty = 0, closed = false;
  const schedule = () => { clearTimeout(timer); timer = setTimeout(reload, 350); };
  const changed = () => { dirty++; schedule(); };
  async function reload() {
    if (closed || !dirty) return;
    if (!window.isEnabled() || window.webContents.isLoading()) return schedule();
    const version = dirty;
    try {
      if (!await window.webContents.executeJavaScript('window.reeletPrepareReload?.() === true')) return schedule();
      if (closed) return;
      beforeReload();
      dirty = dirty === version ? 0 : dirty;
      window.webContents.reloadIgnoringCache();
      if (dirty) schedule();
    } catch (error) {
      if (!closed) { console.warn('GUI reload deferred:', error.message); schedule(); }
    }
  }
  const frontend = new Set(['app.js','playback.js','native-preview.js','styles.css','index.html']);
  const watchers = [
    watch(__dirname, (_event, name) => { if (frontend.has(String(name))) changed(); }),
    watch(path.join(__dirname,'../render'), (_event, name) => { if (String(name) === 'timeline.cjs') changed(); }),
  ];
  for (const watcher of watchers) watcher.on('error', error => console.warn('GUI watcher:', error.message));
  window.once('closed', () => { closed = true; clearTimeout(timer); for (const watcher of watchers) watcher.close(); });
};
