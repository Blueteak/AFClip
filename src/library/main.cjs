const {app,BrowserWindow,Menu,ipcMain,dialog,shell,nativeImage}=require('electron');
const {execFile}=require('node:child_process');
const {promisify}=require('node:util');
const path=require('node:path');
const fs=require('node:fs');
const exec=promisify(execFile);
app.commandLine.appendSwitch('force-color-profile','srgb');
if(process.platform==='win32'){app.commandLine.appendSwitch('disable-direct-composition');app.commandLine.appendSwitch('disable-gpu-vsync');}
let window,endpoint;
const catalogIndex=process.argv.indexOf('--catalog');
const catalog=path.resolve(catalogIndex>=0?process.argv[catalogIndex+1]:process.env.AFCLIP_LIBRARY_HOME||path.join(process.env.LOCALAPPDATA||path.join(require('node:os').homedir(),'.local','share'),'AFClip','Library'));
const projectIndex=process.argv.indexOf('--project'),project=projectIndex>=0?path.resolve(process.argv[projectIndex+1]):null;
// Project browsers and the annotation editor have different permissions and insertion targets.
const identity=JSON.stringify([catalog,project]);
const instance=require('node:crypto').createHash('sha256').update(process.platform==='win32'?identity.toLowerCase():identity).digest('hex');
app.setPath('userData',path.join(app.getPath('appData'),'AFClip','library-windows',instance));
const primary=app.requestSingleInstanceLock();
let pendingOpen,loaded=false;
function reopen(argv){
  if(!loaded){pendingOpen=argv;return;}
  const supplied=argv.find(arg=>arg.startsWith('http:'));
  if(supplied){
    const requested=new URL(supplied),current=new URL(window.webContents.getURL());
    if(requested.origin===current.origin&&(requested.searchParams.has('asset')||requested.searchParams.has('folder'))){
      for(const key of ['asset','folder']){current.searchParams.delete(key);if(requested.searchParams.has(key))current.searchParams.set(key,requested.searchParams.get(key));}
      void window.loadURL(current.toString());
    }
  }
  if(window.isMinimized())window.restore();
  window.show();window.focus();
}
if(!primary)app.quit();
else app.on('second-instance',(_event,argv)=>reopen(argv));
async function command(command,fields={}){const response=await fetch(endpoint.url+'/command',{method:'POST',headers:{Authorization:`Bearer ${endpoint.token}`,'Content-Type':'application/json'},body:JSON.stringify({command,...fields})});const r=await response.json();if(!r.ok)throw new Error(r.error.message);return r.result;}
if(primary)app.whenReady().then(async()=>{
  const catalogIndex=process.argv.indexOf('--catalog');
  const info=await exec(process.env.AFCLIP_NODE_PATH||'node',[path.join(__dirname,'cli.ts'),'endpoint',...(catalogIndex>=0?['--catalog',process.argv[catalogIndex+1]]:[])],{windowsHide:true});endpoint=JSON.parse(info.stdout).result;
  const supplied=process.argv.find(arg=>arg.startsWith('http:')),url=new URL(supplied?.startsWith('http:')?supplied:endpoint.gui);
  if(url.origin!==new URL(endpoint.gui).origin)throw new Error('Library URL must belong to this catalog');
  if(project){url.searchParams.set('mode','project');url.searchParams.set('token',new URL(endpoint.gui).searchParams.get('token'));}
  const dev=process.argv.includes('--dev');if(dev)url.searchParams.set('dev','1');
  Menu.setApplicationMenu(null);
  window=new BrowserWindow({width:1500,height:980,minWidth:900,minHeight:680,title:'AFClip Content Library',backgroundColor:'#0e0f11',webPreferences:{preload:path.join(__dirname,'preload.cjs'),sandbox:true,contextIsolation:true,nodeIntegration:false,partition:'persist:library-writer'}});
  const check=e=>{if(e.sender!==window.webContents||e.senderFrame!==window.webContents.mainFrame)throw new Error('Unknown sender');};
  const handle=(name,fn)=>ipcMain.handle('library:'+name,(e,...args)=>{check(e);return fn(...args);});
  handle('pick',async()=>{const r=await dialog.showOpenDialog(window,{properties:['openFile','multiSelections'],filters:[{name:'Audio and video',extensions:['mp4','mov','mkv','webm','wav','mp3','flac','ogg','m4a']}]});return r.canceled?[]:r.filePaths;});
  handle('reveal',async id=>{const a=await command('inspect',{id});shell.showItemInFolder(a.path);});
  ipcMain.on('library:drag',async(e,id)=>{check(e);try{const item=await command('inspect',{id}),a=item.parent||item;if(a.availability!=='available')return;const iconPath=path.join(endpoint.catalogDir,'cache',a.sourceId+'.png');const icon=fs.existsSync(iconPath)?nativeImage.createFromPath(iconPath).resize({width:100}):nativeImage.createFromDataURL('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aK1sAAAAASUVORK5CYII=');e.sender.startDrag({file:a.path,icon});}catch(error){console.error(error);}});
  handle('insert',async selection=>{if(!project)throw new Error('Open this browser from a AFClip project');const r=await exec(process.env.AFCLIP_NODE_PATH||'node',[path.join(__dirname,'../cli.ts'),'library-import',project,selection.id,...(selection.selection?['--selection',JSON.stringify(selection.selection)]:[])],{windowsHide:true});return JSON.parse(r.stdout);});
  handle('edit',async id=>{await exec(process.env.AFCLIP_NODE_PATH||'node',[path.join(__dirname,'cli.ts'),'gui','--id',id],{windowsHide:true});});
  window.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  window.webContents.on('will-navigate',(e,next)=>{if(new URL(next).origin!==url.origin)e.preventDefault();});
  await window.loadURL(url.toString());loaded=true;window.show();window.focus();
  if(pendingOpen){reopen(pendingOpen);pendingOpen=null;}
  if(dev)require('../gui/dev-reload.cjs')(window,undefined,{files:[
    ...['index.html','app.js','review-tools.js','annotation-timeline.js','styles.css'].map(name=>path.join(__dirname,'gui',name)),
    path.join(__dirname,'../gui/styles.css'),path.join(__dirname,'../gui/native-preview.js'),path.join(__dirname,'../gui/audio-waveform.js'),path.join(__dirname,'../render/timeline.cjs'),
  ]});
}).catch(e=>{console.error(e);dialog.showErrorBox('Content Library',e.message);app.exit(1);});
app.on('window-all-closed',()=>app.quit());
