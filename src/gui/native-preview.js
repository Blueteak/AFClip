'use strict';
// Chromium decodes and presents source video directly. No RGBA pipe, screenshot,
// JPEG, or main-process round trip is involved in a playback frame.
window.NativePreview = class NativePreview {
  constructor(setup, host, onError) {
    this.setup = setup; this.host = host; this.onError = error => { if (!this.closed) onError(error); };
    this.entries = new Map(); this.generation = 0; this.running = false; this.closed = false;
    this.pending = new Map(); this.requestId = 0;
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
    entry.content = video; entry.layer.append(video);
    entry.loaded = new Promise((resolve, reject) => {
      video.addEventListener('loadeddata', resolve, { once: true });
      video.addEventListener('error', () => reject(new Error(`Cannot preview ${entry.clip.media.name || entry.clip.mediaId}: ${video.error?.message || 'unsupported video'}. Use software rendering for this source.`)), { once: true });
    });
    entry.loaded.catch(error => { if (!this.closed && entry.content === video) this.onError(error); });
    video.src = entry.media.url;
    const presented = (_now, metadata) => {
      if (this.closed || entry.content !== video) return;
      entry.presentedTime = metadata.mediaTime; this.stats.sourceFrames++;
      entry.videoCallback = video.requestVideoFrameCallback(presented);
    };
    entry.videoCallback = video.requestVideoFrameCallback(presented);
    return entry.loaded;
  }
  sourceTime(entry, time) { return entry.clip.sourceIn + (time - entry.clip.start) * entry.clip.speed; }
  async position(entry, time) {
    await this.ensureVideo(entry);
    if (this.closed || !entry.content) return;
    const video = entry.content, pts = entry.media.pts;
    let low = 0, high = pts.length;
    while (low < high) { const mid = (low + high) >>> 1; if (pts[mid] <= time + 1e-7) low = mid + 1; else high = mid; }
    const index = Math.max(0, low - 1);
    // Seek inside the selected presentation interval, avoiding timestamp rounding at its edge.
    const target = pts[index] + Math.min(.001, ((pts[index + 1] ?? pts[index] + .02) - pts[index]) / 2);
    video.pause(); video.playbackRate = entry.clip.speed;
    if (Math.abs(video.currentTime - target) < .0001 && video.readyState >= 2) return;
    await new Promise((resolve, reject) => {
      const finish = error => { clearTimeout(timer); video.removeEventListener('seeked', done); error ? reject(error) : resolve(); };
      const done = () => finish();
      const timer = setTimeout(() => finish(new Error('Video seek timed out')), 10000);
      video.addEventListener('seeked', done, { once: true }); video.currentTime = Math.max(0, target);
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
    for (const [id, entry] of this.entries) entry.layer.hidden = !active.has(id);
    for (let i = 0; i < items.length; i++) {
      const item = items[i], entry = this.entries.get(item.clipId); if (!entry) continue;
      const tr = item.transform;
      entry.layer.style.zIndex = String(item.track * 10000 + i); entry.layer.style.opacity = String(item.opacity);
      entry.layer.style.transform = `translate(${tr.x || 0}px,${tr.y || 0}px) rotate(${tr.rotation || 0}deg) scale(${tr.scale || 1})`;
      if (entry.content && item.kind !== 'graphic') entry.content.style.objectFit = tr.fit === 'fill' ? 'cover' : 'contain';
    }
    return items;
  }
  async seek(time) {
    const generation = ++this.generation; this.pause();
    await this.seekWork?.catch(() => {});
    if (generation !== this.generation || this.closed) return false;
    const items = this.layout(time);
    this.seekWork = Promise.all(items.map(async item => {
      const entry = this.entries.get(item.clipId); if (!entry) return;
      if (item.kind === 'video') return this.position(entry, item.sourceTime);
      if (item.kind === 'graphic') { await entry.graphicBusy; entry.graphicNext = null; return this.graphic(entry, item.sourceTime); }
      return entry.loaded;
    }));
    await this.seekWork;
    if (generation !== this.generation || this.closed) return false;
    this.prepare(time); return true;
  }
  prepare(time) {
    for (const entry of this.entries.values()) {
      if (entry.media.kind !== 'video') continue;
      const c = entry.clip;
      if (c.visibleStart > time && c.visibleStart <= time + 1 && !entry.content) {
        entry.warming = this.position(entry, Math.max(0, this.sourceTime(entry, c.visibleStart - .5))).catch(this.onError).finally(() => { entry.warming = null; });
      } else if (entry.content && (c.visibleEnd < time - 1 || c.visibleStart > time + 2)) {
        entry.content.pause(); entry.content.cancelVideoFrameCallback(entry.videoCallback);
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
  pause() { this.running = false; this.lastTick = null; for (const e of this.entries.values()) { e.graphicNext = null; if (e.media.kind === 'video') e.content?.pause(); } }
  close() {
    this.closed = true; this.generation++; this.pause(); this.resize.disconnect();
    window.removeEventListener('message', this.message);
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.resolve(); } this.pending.clear();
    for (const e of this.entries.values()) if (e.media.kind === 'video' && e.content) { e.content.cancelVideoFrameCallback(e.videoCallback); e.content.removeAttribute('src'); e.content.load(); }
    this.host.replaceChildren();
  }
};
