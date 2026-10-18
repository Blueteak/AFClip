// Explicitly replace this example's legacy transitions. This is not a project migration.
// Close the editor/engine before running. All other timeline edits are retained.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {importBuiltin,snapshotGraphic} from '../../src/engine/probe.ts';
import {atomicJSON} from '../../src/engine/state.ts';
import {validateProject} from '../../src/shared/project.ts';
const dir=path.dirname(fileURLToPath(import.meta.url)),file=path.join(dir,'project.json');
const lock=path.join(dir,'.afclip/engine.lock');
if(fs.existsSync(lock)){const {pid}=JSON.parse(fs.readFileSync(lock));let alive=false;try{process.kill(pid,0);alive=true;}catch{}if(alive)throw new Error('Close the Vellum editor and project engine before updating the example');}
const project=JSON.parse(fs.readFileSync(file,'utf8'));
fs.mkdirSync(path.join(dir,'.afclip'),{recursive:true});
fs.copyFileSync(file,path.join(dir,'.afclip',`before-html-transitions-${Date.now()}.json`));
for(const media of project.media.filter(m=>m.kind==='graphic'&&!m.metadata.asset)){
  const author=path.resolve(dir,media.metadata.authoringPath||media.path),html=path.join(author,'index.html');
  const previous=fs.readFileSync(html,'utf8'),next=previous.replaceAll('reelet-','afclip-');
  if(previous!==next){fs.writeFileSync(html,next);const accepted=snapshotGraphic(dir,media.id,author);media.path=accepted.path;media.metadata.assetSignature=accepted.signature;media.revision++;}
}
const assets={};
for(const name of ['dissolve','wipe','blur-transition','spin','blur']){
  let media=project.media.find(m=>m.metadata.builtin===name);
  if(!media){media=importBuiltin(dir,name);project.media.push(media);}
  assets[name]=media.id;
}
project.transitions.forEach((transition,index)=>{
  const name=['dissolve','wipe','blur-transition','spin'][index]||'dissolve';
  Object.assign(transition,{assetId:assets[name],params:name==='wipe'?{pixelBand:0,glow:8}:name==='blur-transition'?{radius:14}:{},seed:100+index,audio:'crossfade',revision:transition.revision+1});
});
const shot=project.clips.find(c=>c.id==='shot_5');
if(shot&&!shot.effects?.some(e=>e.id==='vellum_soften'))shot.effects=[...(shot.effects||[]),{id:'vellum_soften',assetId:assets.blur,params:{radius:.6},seed:205}];
project.revision++;validateProject(project);atomicJSON(file,project);
console.log(JSON.stringify({revision:project.revision,transitions:project.transitions.map(t=>({id:t.id,asset:project.media.find(m=>m.id===t.assetId).metadata.asset.name,cut:project.clips.find(c=>c.id===t.toClipId).start}))},null,2));
