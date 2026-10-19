// Exact-pixel guard for discarding unused source frames before RGBA conversion.
// node benchmarks/cli/verify-strides.cjs <video.mp4> <new-output-directory>
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),{spawnSync}=require('node:child_process');
const {Decoder,frameIndex}=require('../../src/render/decoder.cjs'),strides=require('../../src/render/decode-strides.cjs'),{at}=require('../../src/render/timeline.cjs');
const ffmpeg=require('ffmpeg-static'),ffprobe=require('../../src/shared/ffprobe.cjs');
const [sourceArg,outArg]=process.argv.slice(2);if(!sourceArg||!outArg)throw Error('Supply a source and new output directory');
const source=path.resolve(sourceArg),out=path.resolve(outArg);fs.mkdirSync(out);
const checks=[];
function run(binary,args){const p=spawnSync(binary,args,{encoding:'utf8',maxBuffer:32*1024**2,windowsHide:true});assert.equal(p.status,0,p.stderr);return p.stdout;}
function media(file){const p=JSON.parse(run(ffprobe,['-v','error','-select_streams','v:0','-show_frames','-show_streams','-show_entries','frame=best_effort_timestamp:stream=width,height,time_base,start_pts','-of','json',file]));const s=p.streams[0],[n,d]=s.time_base.split('/').map(Number);return {file,kind:'video',width:s.width,height:s.height,pts:p.frames.map(f=>(f.best_effort_timestamp-s.start_pts)*n/d)};}
async function compare(m,start,stride,offsets){
  const plain=new Decoder(m,ffmpeg,start,path.join(out,'decode.log')),sampled=new Decoder(m,ffmpeg,start,path.join(out,'decode.log'),stride);
  try{for(const offset of offsets){const index=start+stride*offset;const expected=await plain.read(index),actual=await sampled.read(index);assert.ok(expected.equals(actual),`Frame ${index}, stride ${stride}`);}checks.push({file:path.basename(m.file),start,stride,requests:offsets.length,transported:sampled.framesRead,baselineTransported:plain.framesRead});}
  finally{plain.close();sampled.close();}
}
function plan(m,speed,sourceIn=0){return {clips:[{id:'clip',mediaId:'video',media:{kind:'video',duration:{num:8,den:1}},start:0,end:4,duration:4,sourceIn,speed,visibleStart:0,visibleEnd:4,fadeIn:0,fadeOut:0,transitions:[],track:{index:0},volume:1}]};}
async function main(){
  const m=media(source);
  for(const [start,stride] of [[0,2],[37,2],[83,8]])await compare(m,start,stride,[0,1,2,5,10,20]);
  for(const speed of [.25,1,4,1.1]){
    const p=plan(m,speed),selected=strides(p,{video:m},0,4,30).clip;
    const indices=Array.from({length:120},(_,f)=>frameIndex(m.pts,at(p,f/30)[0].sourceTime));
    assert.ok(indices.every(i=>(i-indices[0])%selected===0));
    if(speed===1)assert.equal(selected,2);if(speed===1.1)assert.equal(selected,1);
    checks.push({speed,plannedStride:selected,requests:indices.length});
  }
  assert.equal(strides(plan(m,4),{video:m},0,2,30).clip,8);checks.push({fastMotionStride:8});
  const vfr=path.join(out,'vfr.mp4');run(ffmpeg,['-v','error','-y','-i',source,'-an','-vf',"select='if(lt(n,120),not(mod(n,2)),not(mod(n,3)))'",'-fps_mode','vfr','-c:v','libx264','-preset','veryfast','-crf','20','-colorspace','bt709','-color_trc','bt709','-color_primaries','bt709',vfr]);
  const variable=media(vfr);assert.equal(strides(plan(variable,1),{video:variable},0,4,30).clip,1);
  for (const source of [m, variable]) for (const speed of [.25, 1, 1.1, 4]) for (const begin of [0, .137, 1.03]) {
    const p=plan(source,speed,.3);Object.assign(p.clips[0],{start:1,visibleStart:.75,visibleEnd:3.25});
    const stride=strides(p,{video:source},begin,4,30000/1001).clip;
    const requests=[];for(let f=0;f<Math.ceil((4-begin)*30000/1001-1e-8);f++){const item=at(p,begin+f/(30000/1001))[0];if(item)requests.push(frameIndex(source.pts,item.sourceTime));}
    assert.ok(requests.every(i=>(i-requests[0])%stride===0),'Fractional rate / transition handle selection');
  }
  checks.push({fractionalRateAndHandleCases:24});
  await compare(variable,17,3,[0,1,2,5,10,20]);
  checks.push({vfrFallback:true});fs.writeFileSync(path.join(out,'results.json'),JSON.stringify(checks,null,2));console.log(checks);
}
main().catch(e=>{console.error(e);process.exitCode=1;});
