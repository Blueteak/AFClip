const {app, dialog} = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const {execFile} = require('node:child_process');
const exec = require('node:util').promisify(execFile);
const runtime = require('../shared/runtime.cjs');
const show = (method, window, options) => window ? dialog[method](window,options) : dialog[method](options);
async function create(window, parent) {
  const directory = parent || path.join(app.getPath('videos'), 'AFClip Projects');
  await fs.mkdir(directory,{recursive:true});
  let defaultPath=path.join(directory,'Untitled'),index=2;
  while(await fs.stat(defaultPath).then(()=>true,()=>false))defaultPath=path.join(directory,'Untitled '+index++);
  const selected = await show('showSaveDialog',window,{title:'New project',buttonLabel:'Create',defaultPath});
  if (selected.canceled || !selected.filePath) return null;
  const destination = path.resolve(selected.filePath);
  const existing = await fs.stat(destination).catch(error => {if (error.code !== 'ENOENT') throw error; return null;});
  if (existing && (!existing.isDirectory() || (await fs.readdir(destination)).length)) {
    throw new Error('Choose a new or empty folder. Use Open project for an existing project.');
  }
  let result;
  try { result = await exec(runtime.node,[path.join(runtime.root,'src/cli.ts'),'create',destination,'--fps','60'],{windowsHide:true,timeout:30000}); }
  catch (error) { throw new Error(commandError(error)); }
  const reply = JSON.parse(result.stdout);
  if (!reply.ok) throw new Error(reply.error?.message || 'Could not create project');
  return destination;
}
async function open(window, parent) {
  const selected = await show('showOpenDialog',window,{title:'Open project',buttonLabel:'Open',defaultPath:parent,properties:['openDirectory']});
  if (selected.canceled || !selected.filePaths[0]) return null;
  const destination = selected.filePaths[0];
  await fs.access(path.join(destination,'project.json')).catch(() => {throw new Error('This folder does not contain an AFClip project.');});
  return destination;
}
async function firstLaunch() {
  while (true) {
    const {response} = await dialog.showMessageBox({title:'AFClip',message:'Open a project',buttons:['New project','Open project','Content Library','Quit'],defaultId:0,cancelId:3,noLink:true});
    if (response === 3) return null;
    if (response === 2) {require('./mac-setup.cjs').openLibrary();return null;}
    try {const result = await (response === 0 ? create() : open()); if (result) return result;}
    catch (e) {await dialog.showMessageBox({type:'error',message:e.message,buttons:['OK']});}
  }
}
function commandError(error) {
  for (const output of [error.stdout, error.stderr]) {
    try { const reply = JSON.parse(output); if (reply.error?.message) return reply.error.message; } catch {}
  }
  return error.message;
}
module.exports = {create,open,firstLaunch,commandError};
