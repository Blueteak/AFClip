const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('reelet', Object.freeze({
  previewOpen: mode => ipcRenderer.invoke('reelet:preview-open', mode),
  previewClose: () => ipcRenderer.invoke('reelet:preview-close'),
  previewFrame: value => ipcRenderer.send('reelet:preview-frame', value),
  onPreview: listener => { const receive = (_event, value) => listener(value); ipcRenderer.on('reelet:preview', receive); return () => ipcRenderer.removeListener('reelet:preview', receive); },
  inspect: () => ipcRenderer.invoke('reelet:inspect'),
  command: payload => ipcRenderer.invoke('reelet:command', payload),
  importMedia: kind => ipcRenderer.invoke('reelet:import', kind),
  render: options => ipcRenderer.invoke('reelet:render', options),
  mediaUrl: file => ipcRenderer.invoke('reelet:media-url', file),
  showOutput: file => ipcRenderer.invoke('reelet:show-output', file),
  ready: () => ipcRenderer.invoke('reelet:ready'),
  onEvent: listener => { const receive = (_event, value) => listener(value); ipcRenderer.on('reelet:event', receive); return () => ipcRenderer.removeListener('reelet:event', receive); },
}));
