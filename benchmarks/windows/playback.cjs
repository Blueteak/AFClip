// Opt-in, visible playback measurement. Uses a disposable 1080p60 project copy.
// Run: node benchmarks/windows/playback.cjs [project-directory] [seconds]
const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '../..');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

if (!process.versions.electron) {
  const source = path.resolve(process.argv[2] || path.join(root, 'examples/vellum-first-edit'));
  const output = path.join(root, '.cache/playback', new Date().toISOString().replace(/[:.]/g, '-'));
  const projectDir = path.join(output, 'project'); fs.mkdirSync(projectDir, { recursive: true });
  const project = JSON.parse(fs.readFileSync(path.join(source, 'project.json'), 'utf8'));
  project.id = require('node:crypto').randomUUID(); project.name = '1080p60 playback measurement';
  project.fps = { num: 60, den: 1 }; project.resolution = { width: 1920, height: 1080 };
  for (const media of project.media) media.path = path.resolve(source, media.path);
  fs.writeFileSync(path.join(projectDir, 'project.json'), JSON.stringify(project, null, 2));
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  console.log(`Playback artifacts: ${output}`);
  const child = spawn(require('electron'), [__filename, '--measure', output, process.argv[3] || '64'], { env, windowsHide: true, stdio: 'inherit' });
  child.on('error', error => { console.error(error); process.exitCode = 1; });
  child.on('exit', code => {
    try { execFileSync(process.execPath, [path.join(root, 'src/cli.ts'), 'close', projectDir], { windowsHide: true, stdio: 'ignore', timeout: 10000 }); } catch {}
    process.exit(code || 0);
  });
} else {
  const { app, BrowserWindow, screen } = require('electron');
  const output = path.resolve(process.argv[3]), seconds = Number(process.argv[4]);
  if (!(seconds > 0 && seconds <= 600)) throw new Error('Measurement length must be between 0 and 600 seconds');
  app.commandLine.appendSwitch('force-device-scale-factor', '1');
  process.argv = [process.argv[0], path.join(root, 'src/gui/main.cjs'), path.join(output, 'project')];
  require('../../src/gui/main.cjs');
  (async () => {
    await app.whenReady(); let win;
    for (let i = 0; i < 100; i++) { win = BrowserWindow.getAllWindows()[0]; if (win && !win.webContents.isLoading()) break; await sleep(100); }
    if (!win) throw new Error('Editor did not open');
    const mediaEvents = [];
    win.webContents.debugger.attach('1.3');
    win.webContents.debugger.on('message', (_event, method, params) => { if (method === 'Media.playerPropertiesChanged') mediaEvents.push(params); });
    await win.webContents.debugger.sendCommand('Media.enable');
    let ready = false;
    for (let i = 0; i < 180; i++) {
      try { ready = await win.webContents.executeJavaScript('typeof playback !== "undefined" && playback.ready && !!playback.native'); } catch {}
      if (ready) break; await sleep(500);
    }
    if (!ready) throw new Error('Native preview did not become ready');
    win.setContentSize(2160, 1300); win.setPosition(0, 0);
    await win.webContents.executeJavaScript(`
      Object.assign(document.getElementById('stage').style, { position:'fixed', left:'0', top:'0', width:'1920px', height:'1080px', margin:'0', zIndex:'999' });
      playback.native.fit();
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
        for (const entry of playback.native.entries.values()) if (entry.media.kind === 'video' && entry.content && playback.audio.currentTime >= entry.clip.visibleStart && playback.audio.currentTime < entry.clip.visibleEnd) {
          quality(entry, playback.audio.currentTime);
        }
      }, 250);
      void 0;
    `);
    await win.webContents.executeJavaScript('playback.play(0)');
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
      return { time:playback.time, playing:playback.playing, stats:playback.native.stats, samples:playbackSamples, quality:qualitySamples,
        stage:document.getElementById('native-preview').getBoundingClientRect().toJSON(), devicePixelRatio, fps:playback.fps };
    })()`);
    result.mediaEvents = mediaEvents; result.gpu = await app.getGPUInfo('complete');
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
      return { clip, callbacks:values.length, seconds:(last.wall - first.wall) / 1000,
        callbackFps:(values.length - 1) * 1000 / (last.wall - first.wall),
        presentedFps:(last.presented - first.presented) * 1000 / (last.wall - first.wall),
        p95GapMs:gaps[Math.floor(gaps.length * .95)], maxGapMs:gaps.at(-1),
        droppedWhileVisible:quality.length ? quality.at(-1).dropped - quality[0].dropped : null,
        p95ClockErrorMs:errors[Math.floor(errors.length * .95)], maxClockErrorMs:errors.at(-1) };
    });
    fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify({ time:result.time, stats:result.stats, byClip:result.byClip }, null, 2));
    await win.webContents.executeJavaScript('playback.pause(false); reelet.previewClose()');
    await sleep(300); app.exit(0);
  })().catch(error => { console.error(error); app.exit(1); });
}
