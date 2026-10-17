'use strict';
// Chromium decodes and presents source video directly. No RGBA pipe, screenshot,
// JPEG, or main-process round trip is involved in a playback frame.
window.NativePreview = class NativePreview {
  constructor(setup, host, onError) {
    this.setup = setup; this.host = host; this.onError = error => { if (!this.closed) onError(error); };
    this.entries = new Map(); this.generation = 0; this.running = false; this.closed = false;
    this.pending = new Map(); this.requestId = 0;
    this.frames = new Map(); this.frameBytes = 0;
    this.frameBudget = Math.min(setup.project.cacheLimitBytes || 256 * 1024 * 1024, 512 * 1024 * 1024);
    this.stats = { ticks: 0, sourceFrames: 0, maxTickMs: 0, resyncs: 0 };
    this.stage = document.createElement('div'); this.stage.className = 'native-composition';
    this.stage.style.width = setup.width + 'px'; this.stage.style.height = setup.height + 'px';
    host.replaceChildren(this.stage);
    this.resize = new ResizeObserver(() => this.fit()); this.resize.observe(host.parentElement); this.fit();
    this.message = e => {
      const p = this.pending.get(e.data?.requestId);
      if (!p || p.source !== e.source) return;
      if (e.data.type === 'reelet-ready' || e.data.type === 'reelet-error') {
        this.pending.delete(e.data.requestId); clearTimeout(p.timer);
        e.data.type === 'reelet-ready' ? p.resolve() : p.reject(new Error(e.data.error || 'Graphic failed'));
      }
    };
    window.addEventListener('message', this.message);
    for (const clip of setup.plan.clips) {
      const media = setup.media[clip.mediaId];
      if (!media || media.kind === 'audio') continue;
      const layer = document.createElement('div'); layer.className = 'native-layer'; layer.hidden = true;
      this.stage.append(layer);
      const entry = { clip, media, layer }; this.entries.set(clip.id, entry);
      if (media.kind === 'graphic') {
        const graphic = setup.graphics[clip.mediaId], iframe = document.createElement('iframe');
        iframe.sandbox = 'allow-scripts'; iframe.style.width = graphic.width + 'px'; iframe.style.height = graphic.height + 'px';
        iframe.style.transform = `translate(-50%,-50%) scale(${Math.min(setup.width / graphic.width, setup.height / graphic.height)})`;
        entry.loaded = new Promise((resolve, reject) => { iframe.onload = resolve; iframe.onerror = () => reject(new Error('Graphic could not load')); });
        entry.loaded.catch(this.onError); iframe.src = graphic.url; entry.content = iframe; layer.append(iframe);
      } else if (media.kind === 'image') {
        const img = new Image(); img.src = media.url; entry.content = img; layer.append(img);
        entry.loaded = img.decode(); entry.loaded.catch(this.onError);
      }
    }
  }
  fit() {
    const box = this.host.parentElement.getBoundingClientRect();
    this.stage.style.transform = `translate(-50%,-50%) scale(${Math.min(box.width / this.setup.width, box.height / this.setup.height)})`;
  }
  ensureVideo(entry) {
    if (entry.content) return entry.loaded;
    const video = document.createElement('video');
    video.muted = true; video.preload = 'auto'; video.playsInline = true;
    video.style.visibility = entry.still && !entry.still.hidden ? 'hidden' : '';
    video.style.objectFit = entry.clip.transform?.fit === 'fill' ? 'cover' : 'contain';
    entry.content = video; entry.layer.append(video);
    entry.loaded = new Promise((resolve, reject) => {
      entry.releaseVideo = resolve;
      video.addEventListener('loadeddata', resolve, { once: true });
      video.addEventListener('error', () => reject(new Error(`Cannot preview ${entry.clip.media.name || entry.clip.mediaId}: ${video.error?.message || 'unsupported video'}. Use software rendering for this source.`)), { once: true });
    });
    entry.loaded.catch(error => { if (!this.closed && entry.content === video && !entry.refining) this.onError(error); });
    video.src = entry.media.url;
    const presented = (_now, metadata) => {
      if (this.closed || entry.content !== video) return;
      entry.videoTime = metadata.mediaTime;
      if (!entry.still || entry.still.hidden) entry.presentedTime = metadata.mediaTime;
      if (!this.running && !entry.media.seekProxy) this.cacheFrame(entry, metadata.mediaTime);
      if (entry.prefetch && !this.running && metadata.mediaTime >= entry.prefetch.end - 1e-6) {
        video.pause(); entry.prefetch = null;
      }
      if (entry.prefetchRequest && Math.abs(metadata.mediaTime - entry.prefetchRequest.time) < 1e-6) this.prefetch(entry, entry.prefetchRequest.time);
      this.stats.sourceFrames++;
      entry.videoCallback = video.requestVideoFrameCallback(presented);
    };
    entry.videoCallback = video.requestVideoFrameCallback(presented);
    return entry.loaded;
  }
  sourceTime(entry, time) { return entry.clip.sourceIn + (time - entry.clip.start) * entry.clip.speed; }
  frameIndex(entry, time) {
    const pts = entry.media.pts;
    let low = 0, high = pts.length;
    while (low < high) { const mid = (low + high) >>> 1; if (pts[mid] <= time + 1e-7) low = mid + 1; else high = mid; }
    return Math.max(0, low - 1);
  }
  frameTime(entry, time) { return entry.media.pts[this.frameIndex(entry,time)]; }
  frameKey(entry, time) { return entry.clip.mediaId + ':' + Math.round(time * 1e6); }
  storeFrame(key, bitmap, demand) {
    const bytes = bitmap.width * bitmap.height * 4;
    if (bytes > this.frameBudget || (!demand && this.frameBytes + bytes > this.frameBudget && ![...this.frames.values()].some(f => !f.demand))) { bitmap.close(); return false; }
    const previous = this.frames.get(key);
    if (previous) { previous.bitmap.close(); this.frameBytes -= previous.bytes; this.frames.delete(key); }
    while (this.frameBytes + bytes > this.frameBudget && this.frames.size) {
      const [oldKey, old] = [...this.frames.entries()].find(([,frame]) => !frame.demand) || this.frames.entries().next().value;
      old.bitmap.close(); this.frames.delete(oldKey); this.frameBytes -= old.bytes;
    }
    this.frames.set(key, { bitmap, bytes, demand }); this.frameBytes += bytes; return true;
  }
  proxyFrame(entry, time) {
    const proxy = entry.media.seekProxy;
    if (!proxy) return null;
    const index = this.frameIndex(entry, time) - proxy.first;
    return proxy.frames[index];
  }
  async loadProxy(entry, time, signal) {
    const packet = this.proxyFrame(entry, time); if (!packet) return false;
    const [offset, size] = packet;
    const response = await fetch(entry.media.seekProxy.url, { headers:{Range:`bytes=${offset}-${offset+size-1}`}, signal });
    if (response.status !== 206) throw new Error('Seek cache range request failed');
    const bitmap = await createImageBitmap(await response.blob());
    if (signal.aborted || this.closed) { bitmap.close(); return false; }
    return this.storeFrame(this.frameKey(entry, this.frameTime(entry,time)), bitmap, true);
  }
  cacheFrame(entry, time) {
    const key = this.frameKey(entry, time); if (this.frames.has(key)) return;
    const video = entry.content;
    const scale = Math.min(1, this.setup.width / video.videoWidth, this.setup.height / video.videoHeight);
    const width = Math.max(1, Math.round(video.videoWidth * scale)), height = Math.max(1, Math.round(video.videoHeight * scale));
    const bytes = width * height * 4; if (!video.videoWidth || bytes > this.frameBudget) return;
    const demand = Math.abs(entry.requestedFrame - time) < 1e-6;
    if (!demand && this.frameBytes + bytes > this.frameBudget && ![...this.frames.values()].some(f => !f.demand)) return;
    // Copy into our own GPU bitmap. Retaining decoder-owned VideoFrames can
    // exhaust its surface pool and stall playback. Never read pixels back to JS.
    if (!this.frameCanvas) this.frameCanvas = new OffscreenCanvas(width, height);
    if (this.frameCanvas.width !== width) this.frameCanvas.width = width;
    if (this.frameCanvas.height !== height) this.frameCanvas.height = height;
    this.frameCanvas.getContext('2d', { alpha:false }).drawImage(video, 0, 0, width, height);
    const bitmap = this.frameCanvas.transferToImageBitmap();
    this.storeFrame(key, bitmap, demand);
  }
  cachedFrame(entry, time, display = false) {
    const pts = this.frameTime(entry, time), key = this.frameKey(entry, pts), cached = this.frames.get(key);
    if (!cached || !display) return !!cached;
    cached.demand = true;
    this.frames.delete(key); this.frames.set(key, cached);
    if (!entry.still) { entry.still = document.createElement('canvas'); entry.layer.append(entry.still); }
    if (entry.still.width !== cached.bitmap.width) entry.still.width = cached.bitmap.width;
    if (entry.still.height !== cached.bitmap.height) entry.still.height = cached.bitmap.height;
    entry.still.getContext('2d', { alpha:false }).drawImage(cached.bitmap, 0, 0);
    entry.still.style.objectFit = entry.clip.transform?.fit === 'fill' ? 'cover' : 'contain';
    entry.still.hidden = false;
    if (entry.content) entry.content.style.visibility = 'hidden';
    entry.presentedTime = pts;
    return true;
  }
  hideStill(entry) {
    if (entry.still && !entry.still.hidden) { entry.still.hidden = true; entry.still.width = entry.still.height = 0; }
    if (entry.content) entry.content.style.visibility = '';
  }
  refinePaused(time, generation) {
    const epoch = this.refinementEpoch;
    const current = () => !this.closed && !this.running && generation === this.generation && epoch === this.refinementEpoch;
    // Leave the fast scrub picture visible while originals decode. Waiting for
    // idle avoids starting long-GOP decodes on every pointer movement.
    this.refinementTimer = setTimeout(() => {
      const prior = this.seekWork;
      const work = (async () => {
        await prior?.catch(() => {});
        if (!current()) return;
        await Promise.all(window.ReeletTimeline.at(this.setup.plan, time).filter(i => i.kind === 'video').map(async item => {
          const entry = this.entries.get(item.clipId);
          if (!entry.still || entry.still.hidden) return;
          entry.prefetch = null; entry.prefetchRequest = null; cancelAnimationFrame(entry.prefetchTick);
          entry.refining = true;
          try { await this.position(entry, item.sourceTime); }
          finally { entry.refining = false; }
          if (!current()) return;
          this.hideStill(entry);
          entry.presentedTime = entry.videoTime;
        }));
      })();
      this.seekWork = work;
      work.catch(error => { if (current()) console.warn('Paused original preview unavailable:', error.message); });
    }, 150);
  }
  prefetch(entry, time) {
    entry.prefetchRequest = null;
    if (this.closed || this.running || !entry.content || !this.cachedFrame(entry, time)) return;
    const video = entry.content, pts = entry.media.pts, selected = this.frameTime(entry, time);
    const index = this.frameIndex(entry, selected);
    const end = pts[Math.min(pts.length - 1, index + 8)];
    if (entry.prefetch) { entry.prefetch.end = Math.max(entry.prefetch.end, end); return; }
    if (video.seeking || entry.videoTime < selected - 1e-6 || entry.videoTime >= end - 1e-6) return;
    this.cachedFrame(entry, time, true);
    entry.prefetch = { end };
    video.playbackRate = 1;
    video.play().catch(() => { entry.prefetch = null; });
    const pump = () => {
      if (!entry.prefetch || this.closed || this.running) return;
      // Consume hidden video at display cadence, as for playback pre-roll.
      if (video.readyState >= 2) {
        if (!this.prerollSink) { const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1; this.prerollSink = canvas.getContext('2d'); }
        this.prerollSink.drawImage(video, 0, 0, 1, 1);
      }
      entry.prefetchTick = requestAnimationFrame(pump);
    };
    cancelAnimationFrame(entry.prefetchTick); entry.prefetchTick = requestAnimationFrame(pump);
  }
  async position(entry, time) {
    const pts = entry.media.pts;
    let low = 0, high = pts.length;
    while (low < high) { const mid = (low + high) >>> 1; if (pts[mid] <= time + 1e-7) low = mid + 1; else high = mid; }
    const index = Math.max(0, low - 1);
    // Seek inside the selected presentation interval, avoiding timestamp rounding at its edge.
    const target = pts[index] + Math.min(.001, ((pts[index + 1] ?? pts[index] + .02) - pts[index]) / 2);
    const fresh = !entry.content, loaded = this.ensureVideo(entry), video = entry.content;
    // Set the startup position before metadata/data arrive, avoiding a decode
    // of frame zero followed by a second decode of the requested GOP.
    if (fresh) video.currentTime = Math.max(0, target);
    await loaded;
    if (this.closed || entry.content !== video) return;
    video.pause(); video.playbackRate = entry.clip.speed;
    if (Math.abs(video.currentTime - target) < .0001 && video.readyState >= 2 && !video.seeking) return;
    await new Promise((resolve, reject) => {
      const finish = error => { clearTimeout(timer); video.removeEventListener('seeked', done); video.removeEventListener('emptied', done); error ? reject(error) : resolve(); };
      const done = () => finish();
      const timer = setTimeout(() => finish(new Error('Video seek timed out')), 10000);
      video.addEventListener('seeked', done, { once: true });
      video.addEventListener('emptied', done, { once: true });
      if (!video.seeking || Math.abs(video.currentTime - target) >= .0001) video.currentTime = Math.max(0, target);
    });
  }
  graphic(entry, time) {
    if (entry.graphicBusy) { entry.graphicNext = time; return entry.graphicBusy; }
    entry.graphicBusy = entry.loaded.then(() => new Promise((resolve, reject) => {
      if (this.closed) return resolve();
      const id = ++this.requestId;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('Graphic did not acknowledge playback time')); }, 10000);
      this.pending.set(id, { source: entry.content.contentWindow, resolve, reject, timer });
      entry.content.contentWindow.postMessage({ type: 'reelet-render', requestId: id, time }, '*');
    })).finally(() => {
      entry.graphicBusy = null;
      if (entry.graphicNext != null && !this.closed) { const next = entry.graphicNext; entry.graphicNext = null; this.graphic(entry, next).catch(this.onError); }
    });
    return entry.graphicBusy;
  }
  layout(time) {
    const items = window.ReeletTimeline.at(this.setup.plan, time), active = new Set(items.map(i => i.clipId));
    for (const [id, entry] of this.entries) {
      entry.layer.hidden = !active.has(id);
      if (entry.layer.hidden) this.hideStill(entry);
    }
    for (let i = 0; i < items.length; i++) {
      const item = items[i], entry = this.entries.get(item.clipId); if (!entry) continue;
      const tr = item.transform;
      entry.layer.style.zIndex = String(item.track * 10000 + i); entry.layer.style.opacity = String(item.opacity);
      entry.layer.style.transform = `translate(${tr.x || 0}px,${tr.y || 0}px) rotate(${tr.rotation || 0}deg) scale(${tr.scale || 1})`;
      if (entry.content && item.kind !== 'graphic') entry.content.style.objectFit = tr.fit === 'fill' ? 'cover' : 'contain';
    }
    return items;
  }
  async seek(time, forPlayback = false) {
    const generation = ++this.generation;
    this.proxyAbort?.abort(); this.proxyAbort = new AbortController();
    const signal = this.proxyAbort.signal;
    const selection = window.ReeletTimeline.at(this.setup.plan, time);
    const cached = !forPlayback && selection.filter(i => i.kind === 'video').every(i => {
      const entry = this.entries.get(i.clipId); return this.cachedFrame(entry, i.sourceTime) || this.proxyFrame(entry,i.sourceTime);
    });
    this.pause(cached);
    // A cached request need not wait behind an obsolete long-GOP decode.
    if (!cached) await this.seekWork?.catch(() => {});
    if (generation !== this.generation || this.closed) return false;
    const items = this.layout(time);
    const priorWork = this.seekWork;
    const work = Promise.all(items.map(async item => {
      const entry = this.entries.get(item.clipId); if (!entry) return;
      if (item.kind === 'video') {
        entry.requestedFrame = this.frameTime(entry, item.sourceTime);
        // Pausing an already-presented original must not downgrade it to JPEG.
        if (!forPlayback && entry.content?.paused && !entry.content.seeking && entry.content.readyState >= 2 &&
            Math.abs(entry.videoTime - entry.requestedFrame) < 1e-6) {
          this.hideStill(entry); entry.presentedTime = entry.videoTime; return;
        }
        if (!forPlayback && this.cachedFrame(entry, item.sourceTime, true)) return;
        if (!forPlayback && this.proxyFrame(entry, item.sourceTime)) {
          try {
            const loaded = await this.loadProxy(entry,item.sourceTime,signal);
            if (generation !== this.generation || this.closed) return;
            if (loaded && this.cachedFrame(entry,item.sourceTime,true)) return;
          } catch (error) {
            if (signal.aborted || this.closed) return;
            entry.media.seekProxy = null; // Corrupt/unavailable cache falls back to the source.
            console.warn('Seek cache fallback:', error.message);
          }
          await priorWork?.catch(()=>{});
          if (generation !== this.generation || this.closed) return;
        }
        await this.position(entry, item.sourceTime);
        if (generation !== this.generation || this.closed) return;
        this.hideStill(entry);
        entry.presentedTime = entry.videoTime;
        return;
      }
      if (item.kind === 'graphic') { await entry.graphicBusy; entry.graphicNext = null; return this.graphic(entry, item.sourceTime); }
      return entry.loaded;
    }));
    if (!cached) this.seekWork = work;
    await work;
    if (generation !== this.generation || this.closed) return false;
    if (!forPlayback) for (const item of items) if (item.kind === 'video' && !this.entries.get(item.clipId).media.seekProxy) {
      const entry = this.entries.get(item.clipId), frame = this.frameTime(entry, item.sourceTime);
      if (this.cachedFrame(entry, frame)) this.prefetch(entry, frame);
      else entry.prefetchRequest = { time:frame };
    }
    this.prepare(time, forPlayback);
    if (!forPlayback) this.refinePaused(time, generation);
    return true;
  }
  prepare(time, warm = true) {
    for (const entry of this.entries.values()) {
      if (entry.media.kind !== 'video') continue;
      const c = entry.clip;
      if (warm && c.visibleStart > time && c.visibleStart <= time + 1 && !entry.content) {
        entry.warming = this.position(entry, Math.max(0, this.sourceTime(entry, c.visibleStart - .5))).catch(this.onError).finally(() => { entry.warming = null; });
      } else if (entry.content && (c.visibleEnd < time - 1 || c.visibleStart > time + 2)) {
        entry.prefetch = null; entry.prefetchRequest = null; cancelAnimationFrame(entry.prefetchTick);
        entry.content.pause(); entry.content.cancelVideoFrameCallback(entry.videoCallback);
        entry.releaseVideo?.();
        entry.content.removeAttribute('src'); entry.content.load(); entry.content.remove(); entry.content = null;
      }
    }
  }
  update(time) {
    if (this.closed) return;
    this.running = true;
    const now = performance.now();
    if (this.lastTick != null) this.stats.maxTickMs = Math.max(this.stats.maxTickMs, now - this.lastTick);
    this.lastTick = now; this.stats.ticks++;
    const items = this.layout(time), active = new Set(items.map(i => i.clipId));
    for (const item of items) {
      const entry = this.entries.get(item.clipId); if (!entry) continue;
      if (item.kind === 'graphic') this.graphic(entry, item.sourceTime).catch(this.onError);
    }
    for (const [id, entry] of this.entries) {
      if (entry.media.kind !== 'video') continue;
      const sourceTime = this.sourceTime(entry, time), visible = active.has(id);
      // Let decoder startup and clock correction finish before a cut/dissolve.
      const preroll = time >= entry.clip.visibleStart - .5 && time < entry.clip.visibleStart && sourceTime >= 0;
      if (!visible && !preroll) { entry.content?.pause(); continue; }
      if (!entry.content) { this.ensureVideo(entry); entry.content.currentTime = Math.max(0, sourceTime); }
      const video = entry.content;
      if (entry.warming || video.readyState < 2 || video.seeking) continue;
      this.hideStill(entry);
      const error = sourceTime - video.currentTime, speed = entry.clip.speed;
      if (Math.abs(error) > .2) { video.currentTime = Math.max(0, sourceTime); this.stats.resyncs++; }
      else {
        const correction = preroll ? (Math.abs(error) > .01 ? Math.sign(error) * .2 : 0) : (Math.abs(error) > .025 ? Math.sign(error) * .02 : 0);
        const rate = Math.max(.0625, Math.min(16, speed * (1 + correction)));
        if (video.playbackRate !== rate) video.playbackRate = rate;
      }
      if (video.paused) video.play().catch(error => { if (!this.closed && this.running && error.name !== 'AbortError') this.onError(error); });
      if (preroll) {
        // Chromium otherwise consumes hidden video on a 250 ms background
        // timer. Pull a tiny frame to keep its decoder/presentation queue warm.
        // The visible picture still comes directly from the video element.
        if (!this.prerollSink) {
          const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
          this.prerollSink = canvas.getContext('2d');
        }
        this.prerollSink.drawImage(video, 0, 0, 1, 1);
      }
    }
    this.prepare(time);
  }
  pause(preservePrefetch = false) {
    clearTimeout(this.refinementTimer); this.refinementEpoch = (this.refinementEpoch || 0) + 1;
    this.running = false; this.lastTick = null;
    for (const e of this.entries.values()) {
      e.graphicNext = null;
      if (preservePrefetch && e.prefetch) continue;
      e.prefetch = null; e.prefetchRequest = null; cancelAnimationFrame(e.prefetchTick);
      if (e.media.kind === 'video') e.content?.pause();
    }
  }
  close() {
    this.closed = true; this.generation++; this.pause(); this.resize.disconnect();
    this.proxyAbort?.abort();
    window.removeEventListener('message', this.message);
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.resolve(); } this.pending.clear();
    for (const e of this.entries.values()) if (e.media.kind === 'video' && e.content) { e.releaseVideo?.(); e.content.cancelVideoFrameCallback(e.videoCallback); e.content.removeAttribute('src'); e.content.load(); }
    for (const frame of this.frames.values()) frame.bitmap.close(); this.frames.clear(); this.frameBytes = 0;
    if (this.frameCanvas) this.frameCanvas.width = this.frameCanvas.height = 0;
    this.host.replaceChildren();
  }
};
