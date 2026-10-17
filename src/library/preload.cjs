const {contextBridge,ipcRenderer,webUtils}=require('electron');
contextBridge.exposeInMainWorld('libraryNative',{
  pick:()=>ipcRenderer.invoke('library:pick'),
  filePath:file=>webUtils.getPathForFile(file),
  reveal:id=>ipcRenderer.invoke('library:reveal',id),
  drag:id=>ipcRenderer.send('library:drag',id),
  insert:selection=>ipcRenderer.invoke('library:insert',selection),
  edit:id=>ipcRenderer.invoke('library:edit',id),
});
