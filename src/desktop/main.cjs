const path = require('node:path');
const runtime = require('../shared/runtime.cjs');
const {app}=require('electron');
app.setName('AFClip');
app.setPath('userData',path.join(app.getPath('appData'),'AFClip'));
const supplied = process.argv.slice(1);
const flag = supplied.find(arg => arg.startsWith('--afclip-role='));
let role = flag ? flag.slice('--afclip-role='.length) : 'editor';
if (!runtime.roles[role]) throw new Error('Unknown AFClip process role');
let args=supplied.filter(arg=>arg!==flag);
// An update can reopen a standalone library without requiring an editor project.
if(!flag&&!args.some(arg=>!arg.startsWith('--'))){
  try{
    const first=JSON.parse(require('node:fs').readFileSync(path.join(require('../shared/lifecycle.cjs').directory,'workspace.json'),'utf8'))[0];
    if(first?.role==='editor'&&first.project){role='editor';args=[first.project];}
    else if(first?.role==='library'){role='library';args=['--catalog',first.catalog,...(first.project?['--project',first.project]:[])];}
  }catch{}
}
const setup=process.platform==='darwin'?require('./mac-setup.cjs'):null;
if(!(['editor','library'].includes(role)&&setup?.moveFromDiskImage())){
  const entry=path.join(runtime.root,runtime.roles[role]);
  process.argv=[process.execPath,entry,...args];
  require(entry);
  if(['editor','library'].includes(role)&&setup&&app.isInApplicationsFolder()){
    try{setup.installCommands();}catch(error){console.warn('Terminal commands:',error.message);}
  }
}
