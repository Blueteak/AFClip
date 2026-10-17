const {app,BrowserWindow,Menu,ipcMain,dialog,shell,nativeImage}=require('electron');
const {execFile}=require('node:child_process');
const {promisify}=require('node:util');
const path=require('node:path');
const fs=require('node:fs');
const exec=promisify(execFile);
app.commandLine.appendSwitch('force-color-profile','srgb');
if(process.platform==='win32'){app.commandLine.appendSwitch('disable-direct-composition');app.commandLine.appendSwitch('disable-gpu-vsync');}
let window,endpoint;
async function command(command,fields={}){const response=await fetch(endpoint.url+'/command',{method:'POST',headers:{Authorization:`Bearer ${endpoint.token}`,'Content-Type':'application/json'},body:JSON.stringify({command,...fields})});const r=await response.json();if(!r.ok)throw new Error(r.error.message);return r.result;}
app.whenReady().then(async()=>{
  const catalogIndex=process.argv.indexOf('--catalog');
  const info=await exec(process.env.REELET_NODE_PATH||'node',[path.join(__dirname,'cli.ts'),'endpoint',...(catalogIndex>=0?['--catalog',process.argv[catalogIndex+1]]:[])],{windowsHide:true});endpoint=JSON.parse(info.stdout).result;
  const projectIndex=process.argv.indexOf('--project'),project=projectIndex>=0?process.argv[projectIndex+1]:null;
  const supplied=process.argv.find(arg=>arg.startsWith('http:')),url=new URL(supplied?.startsWith('http:')?supplied:endpoint.gui);
  if(url.origin!==new URL(endpoint.gui).origin)throw new Error('Library URL must belong to this catalog');
  if(project){url.searchParams.set('mode','reelet');url.searchParams.set('token',new URL(endpoint.readerGui).searchParams.get('token'));}
  const dev=process.argv.includes('--dev');if(dev)url.searchParams.set('dev','1');
  Menu.setApplicationMenu(null);
  window=new BrowserWindow({width:1500,height:980,minWidth:900,minHeight:680,title:'Reelet Content Library',backgroundColor:'#0e0f11',webPreferences:{preload:path.join(__dirname,'preload.cjs'),sandbox:true,contextIsolation:true,nodeIntegration:false,partition:project?'persist:library-reader':'persist:library-writer'}});
  const check=e=>{if(e.sender!==window.webContents||e.senderFrame!==window.webContents.mainFrame)throw new Error('Unknown sender');};
  const handle=(name,fn)=>ipcMain.handle('library:'+name,(e,...args)=>{check(e);return fn(...args);});
  handle('pick',async()=>{const r=await dialog.showOpenDialog(window,{properties:['openFile','multiSelections'],filters:[{name:'Audio and video',extensions:['mp4','mov','mkv','webm','wav','mp3','flac','ogg','m4a']}]});return r.canceled?[]:r.filePaths;});
  handle('reveal',async id=>{const a=await command('inspect',{id});shell.showItemInFolder(a.path);});
  ipcMain.on('library:drag',async(e,id)=>{check(e);try{const item=await command('inspect',{id}),a=item.parent||item;if(a.availability!=='available')return;const iconPath=path.join(endpoint.catalogDir,'cache',a.sourceId+'.png');const icon=fs.existsSync(iconPath)?nativeImage.createFromPath(iconPath).resize({width:100}):nativeImage.createFromDataURL('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aK1sAAAAASUVORK5CYII=');e.sender.startDrag({file:a.path,icon});}catch(error){console.error(error);}});
  handle('insert',async selection=>{if(!project)throw new Error('Open this browser from a Reelet project');const r=await exec(process.env.REELET_NODE_PATH||'node',[path.join(__dirname,'../cli.ts'),'library-import',project,selection.id,...(selection.selection?['--selection',JSON.stringify(selection.selection)]:[])],{windowsHide:true});return JSON.parse(r.stdout);});
  handle('edit',async id=>{await exec(process.env.REELET_NODE_PATH||'node',[path.join(__dirname,'cli.ts'),'gui','--id',id],{windowsHide:true});});
  window.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  window.webContents.on('will-navigate',(e,next)=>{if(new URL(next).origin!==url.origin)e.preventDefault();});
  await window.loadURL(url.toString());window.show();window.focus();
  if(dev)require('../gui/dev-reload.cjs')(window,undefined,{files:[
    ...['index.html','app.js','review-tools.js','styles.css'].map(name=>path.join(__dirname,'gui',name)),
    path.join(__dirname,'../gui/styles.css'),path.join(__dirname,'../gui/native-preview.js'),path.join(__dirname,'../render/timeline.cjs'),
  ]});
}).catch(e=>{console.error(e);dialog.showErrorBox('Content Library',e.message);app.exit(1);});
app.on('window-all-closed',()=>app.quit());
