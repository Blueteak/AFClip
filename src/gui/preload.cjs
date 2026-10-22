const { contextBridge, ipcRenderer, webUtils } = require('electron');
let startupFinished = false;
// Install before page scripts execute so syntax/load errors cannot leave the
// static "Connecting" placeholder looking like an engine connection problem.
window.addEventListener('error', event => {
  if (startupFinished) return;
  const script = event.target?.tagName === 'SCRIPT' ? event.target.src : null;
  if (!event.message && !script) return;
  const message = event.message || `Could not load ${script}`;
  const show = () => {
    document.documentElement.dataset.afclipStartupError = 'true';
    const status = document.getElementById('status');
    if (status) status.textContent = `Editor startup failed: ${message}`;
    const dot = document.getElementById('connection-dot');
    if (dot) dot.className = 'dot error';
  };
  if (document.readyState === 'loading') window.addEventListener('DOMContentLoaded', show, { once: true });
  else show();
}, true);
contextBridge.exposeInMainWorld('afclip', Object.freeze({
  rasterAsset: data => ipcRenderer.invoke('afclip:asset-raster',data),
  previewOpen: mode => ipcRenderer.invoke('afclip:preview-open', mode),
  previewClose: () => ipcRenderer.invoke('afclip:preview-close'),
  previewAudio: value => ipcRenderer.invoke('afclip:preview-audio', value),
  previewFrame: value => ipcRenderer.send('afclip:preview-frame', value),
  onPreview: listener => { const receive = (_event, value) => listener(value); ipcRenderer.on('afclip:preview', receive); return () => ipcRenderer.removeListener('afclip:preview', receive); },
  inspect: () => ipcRenderer.invoke('afclip:inspect'),
  waveform: id => ipcRenderer.invoke('afclip:waveform', id),
  command: payload => ipcRenderer.invoke('afclip:command', payload),
  collectProject: revision => ipcRenderer.invoke('afclip:collect', revision),
  newProject: () => ipcRenderer.invoke('afclip:new-project'),
  openProject: () => ipcRenderer.invoke('afclip:open-project'),
  relinkMedia: (id, revision) => ipcRenderer.invoke('afclip:relink', id, revision),
  importMedia: kind => ipcRenderer.invoke('afclip:import', kind),
  importImages: files => ipcRenderer.invoke('afclip:import-images', files.map(file => webUtils.getPathForFile(file))),
  library: (id, folder) => ipcRenderer.invoke('afclip:library', id, folder),
  editLibrary: id => ipcRenderer.invoke('afclip:edit-library', id),
  libraryMedia: () => ipcRenderer.invoke('afclip:library-media'),
  mediaThumbnail: id => ipcRenderer.invoke('afclip:media-thumbnail', id),
  sourcePreview: id => ipcRenderer.invoke('afclip:source-preview', id),
  sourceWaveform: (id, options) => ipcRenderer.invoke('afclip:source-waveform', id, options),
  copyText: text => ipcRenderer.invoke('afclip:copy-text', text),
  render: options => ipcRenderer.invoke('afclip:render', options),
  mediaUrl: file => ipcRenderer.invoke('afclip:media-url', file),
  showOutput: file => ipcRenderer.invoke('afclip:show-output', file),
  ready: () => { startupFinished = true; return ipcRenderer.invoke('afclip:ready'); },
  agents: (action, payload = {}) => ipcRenderer.invoke('afclip:agents', action, payload),
  apiKeys: (action, payload = {}) => ipcRenderer.invoke('afclip:api-keys', action, payload),
  onEvent: listener => { const receive = (_event, value) => listener(value); ipcRenderer.on('afclip:event', receive); return () => ipcRenderer.removeListener('afclip:event', receive); },
}));
