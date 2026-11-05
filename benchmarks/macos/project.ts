// Opt-in local fixture. Eight gameplay shots, seven dissolves and both Sample titles.
// node benchmarks/macos/project.ts <output-directory> <source1> [source2 ...]
import fs from 'node:fs';
import path from 'node:path';
import { createProject } from '../../src/engine/state.ts';
import { inspectMedia, importGraphic } from '../../src/engine/probe.ts';
import { validateProject } from '../../src/shared/project.ts';
const [destination, ...inputs] = process.argv.slice(2);
if (!destination || !inputs.length) throw new Error('Supply a new output directory and gameplay sources at least 19 seconds long');
const dir = path.resolve(destination);
if (fs.existsSync(path.join(dir, 'project.json'))) throw new Error('Project already exists');
createProject(dir, { name:'Mac gameplay performance', width:1920, height:1080, fps:{num:60,den:1} });
const project = JSON.parse(fs.readFileSync(path.join(dir,'project.json'),'utf8'));
const sources = await Promise.all(inputs.map(file => inspectMedia(file)));
for (const m of sources) if (m.kind !== 'video' || m.duration.num/m.duration.den < 19) throw new Error('Sources must contain at least 19 seconds of video');
if (!process.env.AFCLIP_BENCH_GRAPHICS) throw new Error('Set AFCLIP_BENCH_GRAPHICS to a directory containing opening and closing graphic packages');
const titles = ['opening','closing'].map(name=>importGraphic(dir,path.join(process.env.AFCLIP_BENCH_GRAPHICS,name)));
project.media = [...project.media,...sources,...titles];
project.tracks = ['footage','titles'].map(id=>({id,revision:0,name:id,disabled:false,locked:false}));
const t = (seconds:number) => ({num:Math.round(seconds*60),den:60});
function clip(id:string, trackId:string, mediaId:string, start:number, duration:number, sourceIn:number) {
  return {id,revision:0,trackId,mediaId,start:t(start),duration:t(duration),sourceIn:t(sourceIn),speed:t(1),volume:1,mute:false,fadeIn:t(0),fadeOut:t(0)};
}
project.clips = Array.from({length:8},(_,i)=>clip('shot_'+(i+1),'footage',sources[i%sources.length].id,i*8,8,i<sources.length?1:10));
project.clips[0].fadeIn=t(.6); project.clips[7].fadeOut=t(1.2);
project.clips.push(clip('opening_title','titles',titles[0].id,0,8,0),clip('closing_title','titles',titles[1].id,58,6,0));
const dissolve = project.media.find((m:any)=>m.metadata.builtin==='dissolve');
project.transitions=Array.from({length:7},(_,i)=>({id:'dissolve_'+(i+1),revision:0,trackId:'footage',fromClipId:'shot_'+(i+1),toClipId:'shot_'+(i+2),duration:t(1),alignment:'center',assetId:dissolve.id,params:{},seed:i,audio:'crossfade'}));
validateProject(project);
fs.writeFileSync(path.join(dir,'project.json'),JSON.stringify(project,null,2));
console.log(dir);
