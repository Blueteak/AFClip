const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const {spawn}=require('node:child_process');
const {app,dialog,Menu,shell}=require('electron');
const runtime=require('../shared/runtime.cjs');

function moveFromDiskImage(){
  if(process.platform!=='darwin'||!runtime.packaged||app.isInApplicationsFolder())return false;
  if(!runtime.root.startsWith('/Volumes/')&&!runtime.root.includes('/AppTranslocation/'))return false;
  // Cocoa dialogs need a ready application. Do not start any editor/services
  // in the mounted or translocated copy while this prompt is pending.
  app.whenReady().then(()=>{
    const choice=dialog.showMessageBoxSync({message:'Install AFClip in Applications?',buttons:['Install','Quit'],defaultId:0,cancelId:1,noLink:true});
    if(choice===0)try{
      app.moveToApplicationsFolder({conflictHandler:()=>{
        dialog.showMessageBoxSync({message:'AFClip is already installed',detail:'Open the installed app and use Help > Updates.',buttons:['OK']});
        void shell.openPath('/Applications/AFClip.app');return false;
      }});
    }catch(error){dialog.showErrorBox('Could not install AFClip',error.message);}
    app.quit();
  });
  return true;
}

function installCommands(){
  const directory=path.join(os.homedir(),'.local/bin');
  fs.mkdirSync(directory,{recursive:true});const conflicts=[];
  for(const name of ['af-clip','af-lib']){
    const target=path.join(runtime.resources,'bin',name),link=path.join(directory,name);
    try{
      const stat=fs.lstatSync(link);
      if(stat.isSymbolicLink()&&path.resolve(path.dirname(link),fs.readlinkSync(link))===target)continue;
      conflicts.push(link);continue;
    }catch(error){if(error.code!=='ENOENT')throw error;}
    fs.symlinkSync(target,link);
  }
  return {directory,conflicts};
}

function openLibrary(){
  const launch=runtime.electron('library');
  const child=spawn(launch.binary,launch.args,{detached:true,stdio:'ignore'});
  child.on('error',error=>dialog.showErrorBox('Content Library',error.message));child.unref();
}

function menu(window,updates){
  if(process.platform!=='darwin'||!runtime.packaged)return;
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {role:'appMenu'},
    {role:'editMenu'},
    {label:'Window',submenu:[{role:'minimize'},{role:'zoom'},{label:'Content Library',click:openLibrary},{type:'separator'},{role:'front'}]},
    {label:'Help',submenu:[
      {label:'Updates…',click:()=>updates.show()},
      {label:'Install terminal commands…',click:async()=>{
        try{
          const result=installCommands();
          await dialog.showMessageBox(window,{message:result.conflicts.length?'Existing commands kept':'Terminal commands installed',
            detail:result.conflicts.length?result.conflicts.join('\n'):`Commands are in ${result.directory}. Add that directory to your shell PATH if needed.`,buttons:['OK']});
        }catch(error){dialog.showErrorBox('Terminal commands',error.message);}
      }},
    ]},
  ]));
}
module.exports={moveFromDiskImage,installCommands,openLibrary,menu};
