// Same-machine transcode baseline with AFClip's production full verifier.
// node benchmarks/cli/reference.cjs <source-video> <new-output-directory>
const fs = require('node:fs');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const ffmpeg = require('ffmpeg-static');
const ffprobe = require('../../src/shared/ffprobe.cjs');
const {verifyOutput} = require('../../src/render/verify.cjs');
async function main() {
  const [source, directory] = process.argv.slice(2);
  if (!source || !directory) throw Error('Supply source video and a new output directory');
  fs.mkdirSync(directory);
  const samples = [];
  function run(name, binary, args) {
    const p = spawnSync(binary, args, {windowsHide:true, maxBuffer:64*1024**2, timeout:180000});
    if (p.error || p.status !== 0) throw Error(`${name}: ${p.error || p.stderr}`);
    return p.stdout;
  }
  for (let n=0;n<3;n++) for (const mode of ['software','gpu']) {
    const file = path.resolve(directory, `${mode}-${n}.mp4`);
    const start = performance.now();
    run('encode', ffmpeg, ['-hide_banner','-loglevel','error','-i',source,'-t','4','-vf','select=not(mod(n\\,2)),setpts=N/(30*TB),format=yuv420p','-r','30','-c:v',mode==='software'?'libx264':'h264_nvenc',...(mode==='software'?['-preset','fast','-crf','18','-bf','0']:['-preset','p4','-cq','18','-b:v','0','-bf','0']),'-color_primaries','bt709','-color_trc','bt709','-colorspace','bt709','-c:a','aac','-b:a','192k','-ac','2','-ar','48000','-movflags','+faststart',file]);
    const encodeMs = performance.now()-start;
    const verification = await verifyOutput({file,ffprobe,run,mode:'full',expected:{frames:120,width:1920,height:1080,fps:30,duration:4}});
    samples.push({mode,encodeMs,verification,totalMs:performance.now()-start});
  }
  fs.writeFileSync(path.join(directory,'results.json'),JSON.stringify({samples},null,2));
  console.log(JSON.stringify(samples));
}
main().catch(e=>{console.error(e);process.exitCode=1;});
