// Compare repeated and skipped source frames through the production CLI.
const fs=require('fs'),path=require('path'),{spawnSync}=require('child_process'),ff=require('ffmpeg-static');
const root=path.resolve(__dirname,'../..');
const [sourceArg,outputArg]=process.argv.slice(2);
if(!sourceArg||!outputArg)throw Error('Supply a project and a new output directory');
const sourceDir=path.resolve(sourceArg),output=path.resolve(outputArg),label='speeds',results=[];
fs.mkdirSync(output);
const source=JSON.parse(fs.readFileSync(path.join(sourceDir,'project.json')));
const video=structuredClone(source.media.find(m=>m.kind==='video'));
if(!video||video.duration.num/video.duration.den<11)throw Error('First video must contain at least 11 seconds');
video.path=path.resolve(sourceDir,video.path);
const png=path.join(output,'source.png');
if(!fs.existsSync(png)){const p=spawnSync(ff,['-v','error','-ss','3','-i',video.path,'-frames:v','1',png]);if(p.status)throw Error(p.stderr.toString());}
function run(name,args){const t=performance.now(),r=spawnSync(process.execPath,[path.join(root,'src/cli.ts'),...args],{cwd:root,encoding:'utf8',maxBuffer:32*1024**2,env:{...process.env,AFCLIP_LIBRARY_HOME:path.join(output,'library')}});const value=JSON.parse(r.stdout||r.stderr);if(r.status)throw Error(JSON.stringify(value));results.push({name,ms:performance.now()-t,result:value.result});fs.writeFileSync(path.join(output,label+'.json'),JSON.stringify(results,null,2));console.log(name,Math.round(results.at(-1).ms),value.result.stats?.renderFps||'');return value.result;}
for(const [name,speed] of [['slow',.25],['still',1],['fast',4]]){
 const dir=path.join(output,name);fs.mkdirSync(dir,{recursive:true});
 if(!fs.existsSync(path.join(dir,'project.json'))){
 const project=structuredClone(source);project.media=[structuredClone(video)];project.tracks=[{id:'footage',revision:0,name:'footage',disabled:false,locked:false}];project.transitions=[];project.markers=[];
 project.clips=[{revision:0,volume:1,id:'perf',trackId:'footage',mediaId:video.id,start:{num:0,den:1},duration:{num:2,den:1},sourceIn:{num:3,den:1},speed:{num:Math.round(speed*4),den:4},fadeIn:{num:0,den:1},fadeOut:{num:0,den:1},mute:true,transform:{x:13,y:-7,scale:1.1,rotation:3}}];
 if(name==='still'){project.media[0]={...video,kind:'image',path:png,duration:{num:0,den:1},metadata:{...video.metadata,hasAudio:false}};project.clips[0].sourceIn={num:0,den:1};}
 fs.writeFileSync(path.join(dir,'project.json'),JSON.stringify(project));
 }
 try{for(let i=0;i<3;i++)run(name,['export',dir,path.join(output,`${label}-${name}-${i}.mp4`),'--mode','software','--start','0','--end','2','--verify','full','--wait']);}finally{run('close',['close',dir]);}
}
