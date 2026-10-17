// Opt-in renderer diagnostic, run by playback.cjs --seek. No test runner.
(async () => {
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const rows = [], scrubs = [], native = playback.native;
  let work = [];
  let wake;
  const onFrame = playback.callbacks.frame;
  playback.callbacks.frame = event => { onFrame(event); wake?.(); };
  const observe = entry => {
    const video = entry.content; if (!video || video.seekObserved) return;
    video.seekObserved = true;
    const presented = () => { wake?.(); if (entry.content === video) video.requestVideoFrameCallback(presented); };
    video.requestVideoFrameCallback(presented);
  };
  for (const entry of native.entries.values()) if (entry.media.kind === 'video') observe(entry);
  for (const method of ['ensureVideo', 'position', 'graphic']) {
    const original = native[method].bind(native);
    native[method] = async (...args) => {
      const start = performance.now(), log = work;
      const result = await original(...args);
      if (method === 'ensureVideo') observe(args[0]);
      log.push({ method, clip:args[0].clip.id, ms:performance.now() - start });
      return result;
    };
  }
  const expected = time => window.ReeletTimeline.at(native.setup.plan, time).filter(i => i.kind === 'video').map(item => {
    const e = native.entries.get(item.clipId), pts = e.media.pts;
    let lo = 0, hi = pts.length;
    while (lo < hi) { const mid = (lo + hi) >>> 1; if (pts[mid] <= item.sourceTime + 1e-7) lo = mid + 1; else hi = mid; }
    return { entry:e, pts:pts[Math.max(0, lo - 1)] };
  });
  const measure = async (category, time) => {
    work = [];
    const frames = expected(time), resident = frames.every(f => !!f.entry.content);
    let readyMs;
    const start = performance.now();
    await playback.seek(time, false);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { wake = null; reject(new Error('Seek did not present the requested frame: ' + time)); }, 10000);
      const poll = () => {
        if (!playback.ready) { clearTimeout(timer); wake = null; return reject(new Error('Preview failed')); }
        if (!playback.busy && readyMs == null) readyMs = performance.now() - start;
        if (!playback.busy && frames.every(f => Math.abs(f.entry.presentedTime - f.pts) < .0001)) {
          clearTimeout(timer); wake = null; requestAnimationFrame(resolve); return;
        }
      };
      wake = poll;
      poll();
    });
    const presentedMs = performance.now() - start;
    rows.push({ category, time, resident, readyMs, presentedMs, work:[...work], frames:frames.map(f => ({clip:f.entry.clip.id,expected:f.pts,presented:f.entry.presentedTime})) });
    await sleep(80);
  };
  await measure('initial', 2);
  for (let i = 1; i <= 12; i++) await measure('frame-forward', 2 + i / 60);
  for (let i = 11; i >= 0; i--) await measure('frame-backward', 2 + i / 60);
  const scrub = async (category, targets) => {
    const samples = []; let previous, start, end;
    await new Promise(resolve => {
      let index = 0;
      const tick = now => {
        start ??= now; end = now;
        if (previous) {
          const exact = !playback.busy && expected(previous.time).every(f => Math.abs(f.entry.presentedTime - f.pts) < .0001);
          samples.push({ time:previous.time, ms:performance.now() - previous.start, exact });
        }
        if (index === targets.length) return resolve();
        const time = targets[index++]; previous = { time, start:performance.now() };
        // Exercise the same GUI entry point as ruler dragging, including UI work.
        seek(Math.round(time * playback.fps));
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    scrubs.push({category,requests:targets.length,seconds:(end-start)/1000,correctUpdates:samples.filter(s=>s.exact).length,
      correctUpdatesPerSecond:samples.filter(s=>s.exact).length*1000/(end-start), samples});
    await measure(category + '-release', targets.at(-1));
  };
  await scrub('cached-reversals', Array.from({length:120},(_,i)=>2+(i%24<12 ? i%24 : 24-i%24)/60));
  for (const t of [3,3.25,3.5,3.75,4,3.75,3.5,3.25,3,4,3,4]) await measure('nearby', t);
  for (const t of [60,16,40,8,56,2,60,16,40,8,56,2]) await measure('distant', t);
  await scrub('uncached-sweep', Array.from({length:60},(_,i)=>20+i/30));
  const summary = [...new Set(rows.map(r => r.category))].map(category => {
    const group = rows.filter(r => r.category === category), values = group.map(r => r.presentedMs).sort((a,b)=>a-b);
    return { category, count:values.length, minMs:values[0], medianMs:values[Math.floor(values.length/2)], p95Ms:values[Math.min(values.length-1,Math.ceil(values.length*.95)-1)], maxMs:values.at(-1), within25ms:values.filter(v=>v<=25).length, within50ms:values.filter(v=>v<=50).length };
  });
  return { summary, rows, scrubs, seekCache:native.setup.seekCache, cache:{bytes:native.frameBytes, budget:native.frameBudget, frames:native.frames?.size}, stage:document.getElementById('native-preview').getBoundingClientRect().toJSON(), devicePixelRatio,
    definition:'Request to the next animation frame after exact visible source-frame and preview/graphic readiness. Event-driven readiness avoids the old diagnostic polling an extra animation frame. Excludes session preparation; not physical scanout.' };
})()
