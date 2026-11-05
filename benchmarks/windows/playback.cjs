// Opt-in, visible playback measurement. Uses a disposable 60 fps project copy.
// Also runs on macOS. --reuse-cache copies only the source project's disposable
// timestamp/seek caches; omit it to measure cold preparation.
// Run: node benchmarks/windows/playback.cjs [project-directory] [seconds] [1080|1440|2160] [--seek] [--reuse-cache]
const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '../..');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

if (!process.versions.electron) {
  if (!process.argv[2]) throw new Error('Supply an external project directory');
  const source = path.resolve(process.argv[2]);
  const height = Number(process.argv[4] || 1080), width = height * 16 / 9;
  if (![1080, 1440, 2160].includes(height)) throw new Error('Measurement height must be 1080, 1440 or 2160');
  const output = path.join(root, '.cache/playback', new Date().toISOString().replace(/[:.]/g, '-'));
  const projectDir = path.join(output, 'project'); fs.mkdirSync(projectDir, { recursive: true });
  const project = JSON.parse(fs.readFileSync(path.join(source, 'project.json'), 'utf8'));
  project.id = require('node:crypto').randomUUID(); project.name = height + 'p60 playback measurement';
  project.fps = { num: 60, den: 1 }; project.resolution = { width, height };
  for (const media of project.media) {media.path = path.resolve(source, media.path);delete media.metadata.authoringPath;}
  if(process.argv.includes('--effect-stack')){const clip=project.clips.find(c=>c.id==='shot_5');const effect=clip?.effects?.[0];if(!effect)throw new Error('Effect-stack diagnostic needs an effect on shot_5');clip.effects=[0,1,2].map(n=>({...effect,id:'stack_'+n}));}
  fs.writeFileSync(path.join(projectDir, 'project.json'), JSON.stringify(project, null, 2));
  if (process.argv.includes('--reuse-cache')) for (const name of ['frame-index', 'seek-preview']) {
    const cache = path.join(source, 'cache', name);
    if (fs.existsSync(cache)) fs.cpSync(cache, path.join(projectDir, 'cache', name), { recursive:true });
  }
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  console.log(`Playback artifacts: ${output}`);
  const child = spawn(require('electron'), [__filename, '--measure', output, process.argv[3] || '64', ...(process.argv.includes('--seek') ? ['--seek'] : [])], { env, windowsHide: true, stdio: 'inherit' });
  const finish=require('./diagnostic-process.cjs')(child,output,process.argv.includes('--seek')?'seeks.json':'results.json');
  child.on('error', error => { console.error(error); process.exitCode = 1; });
  child.on('exit', code => {
    try { execFileSync(process.execPath, [path.join(root, 'src/cli.ts'), 'close', projectDir], { windowsHide: true, stdio: 'ignore', timeout: 10000 }); } catch {}
    process.exit(finish(code));
  });
} else {
  const { app, BrowserWindow, screen } = require('electron');
  // Exercise the real audio clock without sending diagnostic audio to speakers.
  app.on('browser-window-created', (_event, window) => window.webContents.setAudioMuted(true));
  const output = path.resolve(process.argv[3]), seconds = Number(process.argv[4]);
  app.setPath('userData', path.join(output, 'profile'));
  const measureSeeking = process.argv.includes('--seek');
  const { width, height } = JSON.parse(fs.readFileSync(path.join(output, 'project/project.json'))).resolution;
  if (!(seconds > 0 && seconds <= 600)) throw new Error('Measurement length must be between 0 and 600 seconds');
  app.commandLine.appendSwitch('force-device-scale-factor', '1');
  process.argv = [process.argv[0], path.join(root, 'src/gui/main.cjs'), path.join(output, 'project')];
  require('../../src/gui/main.cjs');
  // Some Windows Electron builds emit quit but leave the diagnostic process
  // alive in native teardown. Measurements and preview cleanup finish first.
  app.once('quit', (_event, code) => process.exit(code));
  (async () => {
    const openedAt = performance.now();
    await app.whenReady(); let win;
    for (let i = 0; i < 100; i++) { win = BrowserWindow.getAllWindows()[0]; if (win && !win.webContents.isLoading()) break; await sleep(100); }
    if (!win) throw new Error('Editor did not open');
    // Chromium's Media inspector can leave Electron alive after shutdown on
    // Windows. Measure presentation through video callbacks and quality counters.
    let ready = false;
    const prepareSeconds = Number(process.env.AFCLIP_PREPARE_TIMEOUT_SECONDS || 120);
    if (!(prepareSeconds > 0 && prepareSeconds <= 600)) throw new Error('Preparation deadline must be between 0 and 600 seconds');
    for (let i = 0; i < prepareSeconds * 2; i++) {
      try { ready = await win.webContents.executeJavaScript('typeof playback !== "undefined" && playback.ready && !!playback.native'); } catch {}
      if (ready) break; await sleep(500);
    }
    if (!ready) throw new Error(`Native preview did not become ready within ${prepareSeconds} seconds`);
    const previewReadyMs = performance.now() - openedAt;
    const display = screen.getAllDisplays().find(d => d.workArea.width >= width && d.workArea.height >= height + 40);
    if (!display) throw new Error('No display can fit the requested viewport at device-pixel ratio 1');
    win.setContentSize(Math.min(width + 240, display.workArea.width), Math.min(height + 220, display.workArea.height - 40));
    win.setPosition(display.workArea.x, display.workArea.y);
    await win.webContents.executeJavaScript(`
      Object.assign(document.getElementById('stage').style, { position:'fixed', left:'0', top:'0', width:'${width}px', height:'${height}px', margin:'0', zIndex:'999' });
      playback.native.fit();
      void 0;
    `);
    if (measureSeeking) {
      // Prepared-cache interaction numbers stay separate from usable-preview
      // readiness and background generation. Playback measurements never wait.
      for (let i = 0; i < 1200; i++) {
        if (await win.webContents.executeJavaScript('playback.native.setup.seekCache?.complete')) break;
        if (i === 1199) throw new Error('Background seek cache did not finish');
        await sleep(100);
      }
      const result = await win.webContents.executeJavaScript(fs.readFileSync(path.join(__dirname, 'seek.js'), 'utf8'));
      result.previewReadyMs = previewReadyMs;
      result.versions = process.versions; result.gpu = await app.getGPUInfo('complete');
      fs.writeFileSync(path.join(output, 'seeks.json'), JSON.stringify(result, null, 2));
      console.log(JSON.stringify(result.summary, null, 2));
      await win.webContents.executeJavaScript('playback.pause(false); playback.native?.close(); void afclip.previewClose(); void 0');
      await sleep(300); app.quit(); return;
    }
    await win.webContents.executeJavaScript(`
      window.playbackSamples = []; window.qualitySamples = [];
      const observeVideo = entry => {
        const video = entry.content; if (!video || video.benchmarkObserved) return;
        video.benchmarkObserved = true;
        const record = (now, metadata) => {
          if (entry.content !== video) return;
          if (playback.playing && playback.audio.currentTime >= entry.clip.visibleStart && playback.audio.currentTime < entry.clip.visibleEnd) playbackSamples.push({ clip:entry.clip.id, wall:now, audio:playback.audio.currentTime, source:metadata.mediaTime, presented:metadata.presentedFrames, expected:metadata.expectedDisplayTime, decodeSeconds:metadata.processingDuration, rate:video.playbackRate, clockError:playback.native.sourceTime(entry, playback.audio.currentTime) - video.currentTime });
          video.requestVideoFrameCallback(record);
        };
        video.requestVideoFrameCallback(record);
      };
      const ensureVideo = playback.native.ensureVideo.bind(playback.native);
      playback.native.ensureVideo = entry => { const ready = ensureVideo(entry); observeVideo(entry); return ready; };
      for (const entry of playback.native.entries.values()) if (entry.media.kind === 'video') observeVideo(entry);
      const quality = (entry, time, boundary) => {
        const q = entry.content.getVideoPlaybackQuality();
        qualitySamples.push({ clip:entry.clip.id, time, total:q.totalVideoFrames, dropped:q.droppedVideoFrames, boundary });
      };
      const update = playback.native.update.bind(playback.native);
      playback.native.update = time => {
        for (const entry of playback.native.entries.values()) if (entry.media.kind === 'video' && entry.content) {
          const visible = time >= entry.clip.visibleStart && time < entry.clip.visibleEnd;
          if (visible !== !!entry.benchmarkVisible) quality(entry, time, visible ? 'start' : 'end');
          entry.benchmarkVisible = visible;
        }
        update(time);
      };
      window.qualityTimer = setInterval(() => {
        for (const entry of playback.native?.entries.values()||[]) if (entry.media.kind === 'video' && entry.content && playback.audio.currentTime >= entry.clip.visibleStart && playback.audio.currentTime < entry.clip.visibleEnd) {
          quality(entry, playback.audio.currentTime);
        }
      }, 250);
      void 0;
    `);
    await win.webContents.executeJavaScript('playback.play(0)');
    for(let attempt=0;attempt<100;attempt++){const state=await win.webContents.executeJavaScript('({playing:playback.playing,ready:playback.ready,busy:playback.busy,error:document.getElementById("status").textContent})');if(state.playing)break;if(!state.ready||attempt===99)throw new Error('Playback did not start: '+JSON.stringify(state));await sleep(100);}
    const before = Date.now();
    while (Date.now() - before < (seconds + 1) * 1000) {
      await sleep(1000);
      const state = await win.webContents.executeJavaScript('({ time:playback.time, playing:playback.playing, ready:playback.ready })');
      if (!state.ready) throw new Error('Preview failed during measurement');
      if (!state.playing || state.time >= seconds) break;
    }
    const result = await win.webContents.executeJavaScript(`(() => {
      clearInterval(qualityTimer);
      for (const entry of playback.native.entries.values()) if (entry.benchmarkVisible && entry.content) {
        const q = entry.content.getVideoPlaybackQuality();
        qualitySamples.push({ clip:entry.clip.id, time:playback.audio.currentTime, total:q.totalVideoFrames, dropped:q.droppedVideoFrames, boundary:'stop' });
      }
      return { time:playback.time, playing:playback.playing, stats:playback.native.stats, assets:playback.native.assets?.stats, samples:playbackSamples, quality:qualitySamples,
        stage:document.getElementById('native-preview').getBoundingClientRect().toJSON(), devicePixelRatio, fps:playback.fps };
    })()`);
    result.gpu = await app.getGPUInfo('complete');
    result.previewReadyMs = previewReadyMs;
    result.seekCache = await win.webContents.executeJavaScript('playback.native.setup.seekCache');
    result.displays = screen.getAllDisplays().map(d => ({ bounds:d.bounds, frequency:d.displayFrequency }));
    result.versions = process.versions;
    result.presentation = {
      disableDirectComposition: app.commandLine.hasSwitch('disable-direct-composition'),
      disableGpuVsync: app.commandLine.hasSwitch('disable-gpu-vsync'),
      disableFrameRateLimit: app.commandLine.hasSwitch('disable-frame-rate-limit'),
    };
    result.byClip = [...new Set(result.samples.map(s => s.clip))].map(clip => {
      const values = result.samples.filter(s => s.clip === clip), first = values[0], last = values.at(-1);
      const gaps = values.slice(1).map((s, i) => s.wall - values[i].wall).sort((a, b) => a - b);
      const quality = result.quality.filter(s => s.clip === clip);
      const errors = values.map(s => Math.abs(s.clockError) * 1000).sort((a, b) => a - b);
      const steady = values.filter(s => s.audio >= first.audio + .6), steadyFirst = steady[0], steadyLast = steady.at(-1);
      return { clip, callbacks:values.length, seconds:(last.wall - first.wall) / 1000,
        callbackFps:(values.length - 1) * 1000 / (last.wall - first.wall),
        presentedFps:(last.presented - first.presented) * 1000 / (last.wall - first.wall),
        steadyPresentedFps:steady.length > 1 ? (steadyLast.presented-steadyFirst.presented)*1000/(steadyLast.wall-steadyFirst.wall) : null,
        p95GapMs:gaps[Math.floor(gaps.length * .95)], maxGapMs:gaps.at(-1),
        droppedWhileVisible:quality.length ? quality.at(-1).dropped - quality[0].dropped : null,
        p95ClockErrorMs:errors[Math.floor(errors.length * .95)], maxClockErrorMs:errors.at(-1) };
    });
    fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify({ time:result.time, stats:result.stats, byClip:result.byClip }, null, 2));
    await win.webContents.executeJavaScript('playback.pause(false); playback.native?.close(); void afclip.previewClose(); void 0');
    await sleep(300);win.close();
  })().catch(async error => {
    fs.writeFileSync(path.join(output, 'error.json'), JSON.stringify({error:error.message,versions:process.versions},null,2));
    console.error(error);
    for (const window of BrowserWindow.getAllWindows()) await Promise.race([window.webContents.executeJavaScript('void afclip.previewClose(); void 0').catch(()=>{}),sleep(1000)]);
    await sleep(300); app.exit(1);
  });
}
