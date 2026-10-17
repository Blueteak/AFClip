// Opt-in renderer diagnostic, run by playback.cjs --seek. No test runner.
(async () => {
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const rows = [], native = playback.native;
  let work = [];
  for (const method of ['ensureVideo', 'position', 'graphic']) {
    const original = native[method].bind(native);
    native[method] = async (...args) => {
      const start = performance.now(), log = work;
      const result = await original(...args);
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
      const poll = () => {
        if (performance.now() - start > 10000) return reject(new Error('Seek did not present the requested frame: ' + time));
        if (!playback.ready) return reject(new Error('Preview failed'));
        if (!playback.busy && readyMs == null) readyMs = performance.now() - start;
        if (!playback.busy && frames.every(f => Math.abs(f.entry.presentedTime - f.pts) < .0001)) {
          requestAnimationFrame(resolve); return;
        }
        requestAnimationFrame(poll);
      };
      poll();
    });
    const presentedMs = performance.now() - start;
    rows.push({ category, time, resident, readyMs, presentedMs, work:[...work], frames:frames.map(f => ({clip:f.entry.clip.id,expected:f.pts,presented:f.entry.presentedTime})) });
    await sleep(80);
  };
  await measure('initial', 2);
  for (let i = 1; i <= 12; i++) await measure('frame-forward', 2 + i / 60);
  for (let i = 11; i >= 0; i--) await measure('frame-backward', 2 + i / 60);
  for (const t of [3,3.25,3.5,3.75,4,3.75,3.5,3.25,3,4,3,4]) await measure('nearby', t);
  for (const t of [60,16,40,8,56,2,60,16,40,8,56,2]) await measure('distant', t);
  const summary = [...new Set(rows.map(r => r.category))].map(category => {
    const group = rows.filter(r => r.category === category), values = group.map(r => r.presentedMs).sort((a,b)=>a-b);
    return { category, count:values.length, minMs:values[0], medianMs:values[Math.floor(values.length/2)], p95Ms:values[Math.min(values.length-1,Math.ceil(values.length*.95)-1)], maxMs:values.at(-1), within25ms:values.filter(v=>v<=25).length, within50ms:values.filter(v=>v<=50).length };
  });
  return { summary, rows, stage:document.getElementById('native-preview').getBoundingClientRect().toJSON(), devicePixelRatio,
    definition:'Request to exact source-frame callback for every visible video plus one animation frame after preview/graphics readiness. Excludes session preparation; not physical scanout. readyMs is sampled at animation cadence.' };
})()
