// Opt-in native Source monitor integration check. Generates disposable media/catalog/project.
// Run: node benchmarks/windows/source-monitor.cjs [--mkv]
const fs = require('node:fs');
const path = require('node:path');
const {spawn, execFileSync} = require('node:child_process');
const root = path.resolve(__dirname, '../..');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
if (!process.versions.electron) {
  const out = path.join(root, '.temp', 'source-monitor', String(Date.now()));
  fs.mkdirSync(out, {recursive:true});
  const project = path.join(out, 'project'), env = {...process.env, AFCLIP_LIBRARY_HOME:path.join(out,'catalog')};
  delete env.ELECTRON_RUN_AS_NODE;
  const cli = (...args) => JSON.parse(execFileSync(process.execPath,[path.join(root,'src/cli.ts'),...args],{env,encoding:'utf8',windowsHide:true})).result;
  const file = path.join(out,process.argv.includes('--mkv')?'source.mkv':'source.mp4');
  execFileSync(require('ffmpeg-static'),['-v','error','-f','lavfi','-i','testsrc2=s=640x360:r=60:d=4','-f','lavfi','-i','sine=frequency=440:sample_rate=48000:duration=4','-c:v','libx264','-color_range','tv','-colorspace','bt709','-color_trc','bt709','-color_primaries','bt709','-c:a','aac','-shortest','-y',file],{windowsHide:true});
  cli('create',project,'--fps','24');
  const media = cli('import',project,file).media;
  fs.writeFileSync(path.join(out,'input.json'),JSON.stringify({project,mediaId:media.id,mkv:process.argv.includes('--mkv')}));
  console.log(`Source monitor artifacts: ${out}`);
  const child=spawn(require('electron'),[__filename,'--native',out],{env,stdio:'inherit',windowsHide:true});
  child.on('exit',code=>{
    try {cli('close',project);} catch {}
    try {execFileSync(process.execPath,[path.join(root,'src/library/cli.ts'),'close'],{env,windowsHide:true,stdio:'ignore'});} catch {}
    process.exitCode=code||0;
  });
  child.on('error',e=>{console.error(e);process.exitCode=1;});
} else {
  const {app,BrowserWindow}=require('electron');
  const out=path.resolve(process.argv[3]), input=JSON.parse(fs.readFileSync(path.join(out,'input.json')));
  app.setPath('userData',path.join(out,'profile'));
  app.on('browser-window-created',(_,win)=>win.webContents.setAudioMuted(true));
  process.argv=[process.argv[0],path.join(root,'src/gui/main.cjs'),input.project];
  require('../../src/gui/main.cjs');
  (async()=>{
    await app.whenReady();let win;
    for(let i=0;i<150;i++){win=BrowserWindow.getAllWindows()[0];if(win&&!win.webContents.isLoading()){
      try{if(await win.webContents.executeJavaScript('typeof snapshot !== "undefined" && !!snapshot?.project'))break;}catch{}
    }await sleep(100);}
    if(!win)throw Error('Editor did not open');
    const run=js=>win.webContents.executeJavaScript(js);
    const initialMedia=await run('project().media.length');
    await run(`prefs.autoRender=false;document.querySelectorAll('button').forEach(b=>{if(b.textContent==='Got it')b.click()});void 0;`);
    const errors=[];win.webContents.on('console-message',(_e,_level,message)=>{if(/Error|failed/i.test(message))errors.push(message);});
    await run(`setMonitorView('source');source.open(mediaById(${JSON.stringify(input.mediaId)}),sourceKey(mediaById(${JSON.stringify(input.mediaId)})))`);
    const cold=await run(`({status:source.status,canMark:source.canMark,pts:source.data.pts.length,library:source.data.library})`);
    if((!input.mkv&&cold.status!=='ready')||cold.pts!==0)throw Error('Expected an unprepared playable source: '+JSON.stringify(cold));
    await run('source.prepare()');
    const prepared=await run(`({status:source.status,canMark:source.canMark,pts:source.data.pts.length,notice:source.notice,preparing:source.preparing})`);
    if(!prepared.canMark||prepared.pts!==240||prepared.notice)throw Error('Preparation did not update the open monitor: '+JSON.stringify(prepared));
    const scrub=await run(`(async()=>{const n=source.native,frame=n.seekFrame.bind(n);let completed=0;n.seekFrame=async(...args)=>{const ok=await frame(...args);if(ok)completed++;return ok;};try{const pending=[];for(let i=0;i<60;i++){pending.push(source.seek(.5+i/30));await new Promise(r=>setTimeout(r,16));}const during=completed;await Promise.all(pending);await source.seek(1);await new Promise(r=>setTimeout(r,150));const e=n.entries.get('source');return {during,time:source.time,videoTime:e.content.currentTime};}finally{n.seekFrame=frame;}})()`);
    if(scrub.during<2||Math.abs(scrub.videoTime-1)>.04)throw Error('Source scrubbing stalled or settled on the wrong frame: '+JSON.stringify(scrub));
    const playback=await run(`(async()=>{await source.seek(.5);const before=playF;await source.play();await new Promise(r=>setTimeout(r,900));source.pause();const video=source.native.entries.get('source').content;return {time:source.time,timelineBefore:before,timelineAfter:playF,videoTime:video.currentTime,audioTime:source.audio.currentTime,quality:{total:video.getVideoPlaybackQuality().totalVideoFrames,dropped:video.getVideoPlaybackQuality().droppedVideoFrames}};})()`);
    if(playback.time<1||playback.timelineBefore!==playback.timelineAfter||Math.abs(playback.videoTime-playback.audioTime)>.15)throw Error('Source playback clock failed: '+JSON.stringify(playback));
    const selection=await run(`(async()=>{await source.seek(.5);source.mark();await source.seek(1.5);source.mark(true);return source.selectionRequest();})()`);
    if(selection.startFrame!==30||selection.endFrame!==91)throw Error('Wrong video marks: '+JSON.stringify(selection));
    fs.writeFileSync(path.join(out,'source.png'),(await win.webContents.capturePage()).toPNG());
    await run(`document.querySelector('#source-buttons [data-source="insert"]').click();void 0`);
    for(let i=0;i<100;i++){if(await run('project().clips.length===1'))break;await sleep(100);}
    const inserted=await run(`({media:project().media.at(-1),clip:project().clips[0],view:monitorView})`);
    if(!inserted.clip||inserted.view!=='frame'||inserted.media.metadata.library.boundaries.startFrame!==30)throw Error('Native insertion failed');
    const timeline=await run(`(async()=>{await playback.seek(.1,false);await playback.ensure();for(let i=0;i<30;i++){await playback.seek(.1+i/60,false);await new Promise(r=>setTimeout(r,16));}await playback.seek(.2,true);const deadline=performance.now()+5000;while(!playback.playing&&performance.now()<deadline)await new Promise(r=>setTimeout(r,20));await new Promise(r=>setTimeout(r,250));const playing=playback.playing,at=playback.time;playback.pause();await new Promise(r=>setTimeout(r,200));return {playing,at,paused:!playback.playing,busy:playback.busy,native:!!playback.native};})()`);
    if(!timeline.native||!timeline.playing||timeline.at<.35||!timeline.paused||timeline.busy)throw Error('Timeline scrub/resume/pause failed: '+JSON.stringify(timeline));
    const library=(...args)=>JSON.parse(execFileSync(process.env.AFCLIP_NODE_PATH||'node',[path.join(root,'src/library/cli.ts'),...args],{encoding:'utf8',windowsHide:true})).result;
    let asset=library('inspect','--id',cold.library.assetId);
    asset=library('promote','--id',asset.id,'--revision',String(asset.revision),'--folder','root');
    asset=library('inspect','--id',cold.library.assetId);
    library('annotate','--id',asset.id,'--revision',String(asset.revision),'--notes','Native CLI annotation reflected in the monitor');
    await run(`setMonitorView('source');source.open(mediaById(${JSON.stringify(input.mediaId)}),sourceKey(mediaById(${JSON.stringify(input.mediaId)})))`);
    asset=library('inspect','--id',cold.library.assetId);
    library('annotate','--id',asset.id,'--revision',String(asset.revision),'--notes','Updated while Source monitor is open');
    let live=false;
    for(let i=0;i<80;i++){live=await run(`source.data?.annotations?.notes==='Updated while Source monitor is open'`);if(live)break;await sleep(100);}
    if(!live)throw Error('CLI annotations did not reach the open monitor');
    const stillPinned=await run(`JSON.stringify(project().clips[0])===${JSON.stringify(JSON.stringify(inserted.clip))}`);
    if(!stillPinned)throw Error('Library metadata changed an existing cut');
    await run(`(async()=>{await api.command({command:'undo'});await refresh();})()`);
    const undo=await run(`({media:project().media.length,clips:project().clips.length})`);
    if(undo.media!==initialMedia||undo.clips!==0)throw Error('Insertion was not one undo step: '+JSON.stringify(undo));
    const result={cold,prepared,scrub,timeline,playback,selection,inserted,live,stillPinned,undo,errors,versions:process.versions};
    fs.writeFileSync(path.join(out,'result.json'),JSON.stringify(result,null,2));
    console.log(JSON.stringify({prepared,scrub,timeline,playback,selection,live,stillPinned,undo,errors},null,2));
    app.exit(0);
  })().catch(error=>{fs.writeFileSync(path.join(out,'error.txt'),error.stack||String(error));console.error(error);app.exit(1);});
}
