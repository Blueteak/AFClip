const {app, dialog, shell} = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const {spawn} = require('node:child_process');
const runtime = require('../shared/runtime.cjs');
const lifecycle = require('../shared/lifecycle.cjs');
const downloads = 'https://github.com/Blueteak/AFClip/releases';
const settingsFile = path.join(lifecycle.directory,'updates.json');
const workspaceFile = path.join(lifecycle.directory,'workspace.json');
function read(file, fallback) {try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch(e){if(e.code==='ENOENT')return fallback;throw e;}}
function write(file, value) {fs.mkdirSync(path.dirname(file),{recursive:true});const tmp=file+'.'+process.pid+'.tmp';fs.writeFileSync(tmp,JSON.stringify(value));fs.renameSync(tmp,file);}
const pause = ms => new Promise(resolve => setTimeout(resolve,ms));
module.exports = function updates(window, project) {
  if (!runtime.packaged) return {show:()=>dialog.showMessageBox(window,{message:'Source checkout',detail:'Update this checkout with Git. Installed releases update separately.',buttons:['OK']})};
  const ownerFile=path.join(lifecycle.directory,'update-owner.json');
  const owner=read(ownerFile,null);
  if(owner&&!lifecycle.alive(owner.pid))fs.rmSync(ownerFile,{force:true});
  try{fs.mkdirSync(lifecycle.directory,{recursive:true});fs.writeFileSync(ownerFile,JSON.stringify({pid:process.pid}),{flag:'wx'});}
  catch(e){
    if(e.code!=='EEXIST')throw e;
    let delegate;
    const acquire=()=>{if(!lifecycle.alive(read(ownerFile,{pid:0}).pid)){clearInterval(timer);delegate=updates(window,project);}};
    const timer=setInterval(()=>{if(window.isDestroyed())clearInterval(timer);else acquire();},5000);timer.unref();
    return {show:()=>{acquire();return delegate?delegate.show():dialog.showMessageBox(window,{message:'Updates are managed by another AFClip window',buttons:['OK']});}};
  }
  process.on('exit',()=>{try{if(read(ownerFile,null)?.pid===process.pid)fs.rmSync(ownerFile,{force:true});}catch{}});
  const {autoUpdater} = require('electron-updater');
  let settings=read(settingsFile,{channel:'stable'}), downloaded=null, error=null, waiting=false, installing=false;
  let state='No update downloaded';
  if(settings.lastVersion && autoUpdater.currentVersion.compare(settings.lastVersion)<0)settings.pinned=true;
  if(settings.expected && settings.expected!==app.getVersion())error='The previous update was not installed. Retry or download the installer.';
  delete settings.expected;settings.lastVersion=app.getVersion();write(settingsFile,settings);
  autoUpdater.autoDownload=true;
  autoUpdater.autoInstallOnAppQuit=false;
  autoUpdater.disableWebInstaller=true;
  autoUpdater.allowDowngrade=false;
  autoUpdater.channel=settings.channel==='nightly'?'nightly':'latest';
  autoUpdater.allowPrerelease=settings.channel==='nightly';
  if(process.env.AFCLIP_UPDATE_FEED){
    const feed=new URL(process.env.AFCLIP_UPDATE_FEED);
    if(feed.protocol!=='https:'&&!(feed.protocol==='http:'&&['127.0.0.1','localhost'].includes(feed.hostname)))throw new Error('Update feed must use HTTPS or localhost');
    autoUpdater.setFeedURL({provider:'generic',url:feed.href,channel:autoUpdater.channel});
  }
  const enabled=runtime.release.updatesEnabled||!!process.env.AFCLIP_UPDATE_FEED;
  autoUpdater.on('error',e=>{error=e.message;state='Update failed';if(installing){installing=false;lifecycle.unlock();}});
  autoUpdater.on('checking-for-update',()=>{state='Checking for updates';error=null;});
  autoUpdater.on('update-not-available',()=>{state='Up to date';});
  autoUpdater.on('download-progress',p=>{state=`Downloading update: ${Math.round(p.percent)}%`;});
  autoUpdater.on('update-downloaded',async info=>{
    downloaded=info;state='Update ready';
    const result=await dialog.showMessageBox(window,{message:`AFClip ${info.version} is ready`,buttons:['Restart to update','Later'],defaultId:1,cancelId:1,noLink:true});
    if(result.response===0)void install();
  });
  async function check(){
    if(!enabled){state='Updates become available with published releases';return;}
    try{await autoUpdater.checkForUpdates();}catch(e){error=e.message;}
  }
  async function install(){
    if(waiting||installing||!downloaded)return;
    waiting=true;
    try{
      // Authorization to restart is explicit above. Let active work finish first.
      while(waiting){
        const records=await lifecycle.processes();
        const busy=records.filter(r=>r.busy);
        if(busy.length){state='Waiting for active work. Open Updates to cancel.';await pause(1500);continue;}
        lifecycle.lock();
        const frozen=await lifecycle.processes();
        if(frozen.some(r=>r.busy)){lifecycle.unlock();await pause(500);continue;}
        installing=true;
        write(workspaceFile,frozen.map(r=>r.workspace).filter(w=>w&&(w.role!=='editor'||w.project)));
        settings.expected=downloaded.version;write(settingsFile,settings);
        // Close windows first so their previews stop before services are replaced.
        const others=frozen.filter(r=>r.pid!==process.pid);
        for(const record of others.sort((a,b)=>Number(!a.workspace)-Number(!b.workspace)))await lifecycle.call(record,'close');
        const deadline=Date.now()+20000;
        while(others.some(r=>lifecycle.alive(r.pid))){if(Date.now()>deadline)throw new Error('A background process did not stop. Retry after closing it.');await pause(100);}
        // Quit listeners close this editor's own previews. All other work is idle.
        autoUpdater.quitAndInstall(false,true);
        return;
      }
    }catch(e){error=e.message;state='Update could not be installed';installing=false;lifecycle.unlock();}
    finally{waiting=false;}
  }
  async function show(){
    const options=waiting?['Cancel restart','Close']:downloaded?['Restart to update','Close']:['Check for updates','Close'];
    options.push(settings.pinned?'Resume automatic updates':settings.channel==='nightly'?'Use stable releases':'Use nightly releases','Download installer');
    const result=await dialog.showMessageBox(window,{message:`AFClip ${app.getVersion()}`,detail:error||state,buttons:options,defaultId:1,cancelId:1,noLink:true});
    if(result.response===0){if(waiting){waiting=false;state='Update ready';}else if(downloaded)void install();else await check();}
    if(result.response===2){
      if(settings.pinned)settings.pinned=false;
      else settings.channel=settings.channel==='nightly'?'stable':'nightly';
      waiting=false;
      autoUpdater.channel=settings.channel==='nightly'?'nightly':'latest';autoUpdater.allowPrerelease=settings.channel==='nightly';
      downloaded=null;write(settingsFile,settings);await check();
    }
    if(result.response===3)await shell.openExternal(downloads);
  }
  if(enabled){const automatic=()=>{if(!settings.pinned&&!waiting&&!installing)void check();};const first=setTimeout(automatic,15000);const timer=setInterval(automatic,4*60*60*1000);first.unref();timer.unref();}
  // Restore additional windows once, with fresh endpoints from this release.
  const workspace=read(workspaceFile,[]);
  if(workspace.length&&!error){
    fs.rmSync(workspaceFile,{force:true});
    let skippedEditor=false;
    for(const item of workspace){
      if(item.role==='editor'&&item.project===project&&!skippedEditor){skippedEditor=true;continue;}
      const args=item.role==='editor'?[item.project]:['--catalog',item.catalog,...(item.project?['--project',item.project]:[])];
      const launch=runtime.electron(item.role,args);const child=spawn(launch.binary,launch.args,{detached:true,stdio:'ignore',windowsHide:true});child.on('error',e=>{error=e.message;});child.unref();
    }
  }
  return {show};
};
