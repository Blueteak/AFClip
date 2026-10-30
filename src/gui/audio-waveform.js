'use strict';
// Shared audio waveform viewer for the AFClip source monitor and the content library.
// Draws true per-bin peak extrema and RMS at device pixels. Visual gain only changes
// the drawing; audio playback is never touched.
//
//   const view = new AFClipAudioWaveform({ container, load, duration, format, onSeek, onSelectRange, onClearRange, getDragRange, tips });
//
//   container   Element the view fills. It must be positioned; the view is inset 0.
//   load(opts)  => Promise<WaveformData>. opts is undefined for the whole source, or
//               { start, duration, bins } for a detail window while zoomed in.
//               WaveformData v1: { start, duration, sampleRate, channels, bins, peak,
//               lanes: [{ label: 'Mono'|'Left'|'Right', min[], max[], rms[] }] }.
//   duration    Source seconds. The ruler and seeking work before data arrives or after it fails.
//   format(t)   Playback cursor label.
//   onSeek(t, phase)  Click and drag seeking. phase is 'start', 'move' or 'end'.
//   tips        'tip' sets AFClip's element.tip spec; 'title' sets a native title.
//
//   setTime(t)        Move the playback cursor. Cheap; safe to call every frame.
//   setPlaying(bool)  While playing and zoomed, the view pages to keep the cursor visible.
//   setDuration(s)    Source length when it changes after construction.
//   setRegions([{ start, end, kind: 'selection'|'range'|'take' }])
//   zoomBy(factor), fit(), reload(), destroy()
(() => {
  const BINS = 16384, BINS_HI = 32768, MIN_SPAN = .02, MAX_GAIN = 1000;
  const RULER = 22, OVERVIEW = 18, LANE_GAP = 1, PAD = .06;
  const C = {
    bg: '#1e1e1e', lane: '#262626', rulerBg: '#383838', line: '#1a1a1a', tick: '#6a6a6a', label: '#8b8b8b', text: '#bdbdbd',
    center: 'rgba(255,255,255,.08)', guide: 'rgba(255,255,255,.05)', guideLabel: 'rgba(189,189,189,.55)',
    peak: 'rgba(122,80,26,.8)', peakEdge: '#a8701f', rms: '#d48a28',
    peakPlayed: 'rgba(176,112,32,.85)', peakEdgePlayed: '#f0a43c', rmsPlayed: '#ffc36e',
    accent: '#ececec', hover: 'rgba(210,210,210,.35)', range: '#4c8ae0', take: '#f09a2c',
    selection: 'rgba(58,121,187,.12)', selectionEdge: 'rgba(58,121,187,.8)',
  };
  const TICKS = [[.001, .0002], [.002, .0005], [.005, .001], [.01, .002], [.02, .005], [.05, .01], [.1, .02], [.2, .05], [.5, .1],
    [1, .2], [2, .5], [5, 1], [10, 2], [15, 5], [30, 5], [60, 10], [120, 30], [300, 60], [600, 120], [900, 300], [1800, 300],
    [3600, 600], [7200, 1800], [18000, 3600], [36000, 7200]];
  const DB = [0, -3, -6, -9, -12, -18, -24, -30, -36, -42, -48, -54, -60, -72, -84, -96];
  const num = v => Number.isFinite(Number(v)) ? Number(v) : 0;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const el = (tag, cls) => { const e = document.createElement(tag); if (cls) e.className = cls; return e; };
  const dbText = db => (db < 0 ? '−' : db > 0 ? '+' : '') + Math.abs(db).toFixed(Math.abs(db) < 10 ? 1 : 0);
  const cleanError = e => String(e?.message || e || 'Waveform unavailable').replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
  function rulerLabel(t, step, long) {
    const s = Math.max(0, t + 1e-9), h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, sec = s % 60;
    const digits = step < .01 ? 3 : step < .1 ? 2 : step < 1 ? 1 : 0;
    const ss = digits ? sec.toFixed(digits).padStart(3 + digits, '0') : String(Math.floor(sec)).padStart(2, '0');
    return long || h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
  }
  // Waveform data with typed lanes, so per-frame aggregation stays allocation free.
  function prepare(data) {
    const bins = Math.max(0, Math.floor(num(data?.bins)));
    const lanes = (data?.lanes || []).map(l => ({ label: l.label || 'Mono', min: Float32Array.from(l.min || []), max: Float32Array.from(l.max || []), rms: Float32Array.from(l.rms || []) }))
      .filter(l => l.min.length >= bins && l.max.length >= bins);
    if (!bins || !lanes.length || !(num(data.duration) > 0)) return null;
    let peak = num(data.peak);
    if (!(peak > 0)) for (const l of lanes) for (let i = 0; i < bins; i++) peak = Math.max(peak, Math.abs(l.min[i]), Math.abs(l.max[i]));
    return { start: num(data.start), duration: num(data.duration), bins, lanes, peak, binDur: num(data.duration) / bins };
  }
  // One column per device pixel. Wide columns aggregate true extrema; narrow ones interpolate.
  function columns(src, lane, t0, t1, n, out) {
    const { bins, binDur, start } = src, { min, max, rms } = lane, span = (t1 - t0) / n;
    for (let c = 0; c < n; c++) {
      const fa = (t0 + c * span - start) / binDur, fb = fa + span / binDur;
      let mn = 0, mx = 0, r = 0, has = 1;
      if (fb <= 0 || fa >= bins) has = 0;
      else if (fb - fa >= 1) {
        const i0 = clamp(Math.floor(fa), 0, bins - 1), i1 = clamp(Math.ceil(fb), i0 + 1, bins);
        mn = Infinity; mx = -Infinity; let sq = 0;
        for (let i = i0; i < i1; i++) { if (min[i] < mn) mn = min[i]; if (max[i] > mx) mx = max[i]; sq += rms[i] * rms[i]; }
        r = Math.sqrt(sq / (i1 - i0));
      } else {
        const f = clamp((fa + fb) / 2 - .5, 0, bins - 1), i = Math.floor(f), j = Math.min(bins - 1, i + 1), k = f - i;
        mn = min[i] + (min[j] - min[i]) * k; mx = max[i] + (max[j] - max[i]) * k; r = (rms[i] || 0) + ((rms[j] || 0) - (rms[i] || 0)) * k;
      }
      out.min[c] = mn; out.max[c] = mx; out.rms[c] = r; out.has[c] = has;
    }
  }

  window.AFClipAudioWaveform = class AFClipAudioWaveform {
    constructor({ container, load, duration = 0, format = t => t.toFixed(3), onSeek, onSelectRange, onClearRange, getDragRange, onDragStart, onDragEnd, tips = 'tip' }) {
      Object.assign(this, { container, loader: load, format, onSeek, onSelectRange, onClearRange, getDragRange, tips });
      this.duration = Math.max(0, num(duration));
      this.time = 0; this.playing = false; this.regions = [];
      this.full = null; this.detail = null; this.status = 'loading'; this.error = null;
      this.normalize = true; this.viewStart = 0; this.viewSpan = this.duration;
      this.token = 0; this.detailToken = 0; this.destroyed = false;
      this.w = 0; this.h = 0; this.dpr = 1; this.hover = null; this.drag = null; this.dirty = true; this.raf = 0;

      this.root = el('div', 'wf');
      this.canvas = el('canvas', 'wf-canvas');
      this.badges = el('div', 'wf-badges');
      this.gainBadge = el('button', 'wf-badge'); this.gainBadge.type = 'button';
      this.zoomBadge = el('button', 'wf-badge'); this.zoomBadge.type = 'button';
      this.badges.append(this.zoomBadge, this.gainBadge);
      this.statusEl = el('div', 'wf-status');
      this.root.append(this.canvas, this.badges, this.statusEl);
      container.append(this.root);
      this.ctx = this.canvas.getContext('2d');
      this.base = document.createElement('canvas'); this.played = document.createElement('canvas');

      this.gainBadge.addEventListener('click', () => { this.normalize = !this.normalize; this.invalidate(); this.paintChrome(); });
      this.zoomBadge.addEventListener('click', () => this.fit());
      for (const b of [this.gainBadge, this.zoomBadge]) b.addEventListener('pointerdown', e => e.stopPropagation());
      this.on = {
        down: e => this.pointerDown(e), move: e => this.pointerMove(e), leave: () => { if (!this.drag) { this.hover = null; this.queue(); } },
        wheel: e => this.wheel(e), dbl: e => { if (e.target === this.canvas && this.zoomed) this.fit(); },
      };
      this.canvas.addEventListener('pointerdown', this.on.down);
      this.canvas.addEventListener('dragstart', e => onDragStart?.(e));
      this.canvas.addEventListener('dragend', () => onDragEnd?.());
      this.canvas.addEventListener('pointermove', this.on.move);
      this.canvas.addEventListener('pointerleave', this.on.leave);
      this.canvas.addEventListener('dblclick', this.on.dbl);
      this.canvas.addEventListener('wheel', this.on.wheel, { passive: false });
      this.resizer = new ResizeObserver(entries => this.resize(entries[entries.length - 1]));
      try { this.resizer.observe(this.root, { box: 'device-pixel-content-box' }); } catch { this.resizer.observe(this.root); }
      this.frame = this.frame.bind(this);
      this.setTips(); this.paintChrome();
      this.reload();
    }

    // ------------------------------------------------------------ Public API
    get zoomed() { return this.duration > 0 && this.viewSpan < this.duration * .999; }
    get gain() {
      const peak = this.full?.peak || 0;
      return this.normalize && peak > 0 && peak < .5 ? Math.min(MAX_GAIN, .89 / peak) : 1;
    }
    setTime(t) {
      const time = clamp(num(t), 0, this.duration || 0);
      if (time === this.time) return;
      this.time = time;
      if (this.playing && this.zoomed && !this.drag && (time < this.viewStart || time > this.viewStart + this.viewSpan)) {
        this.setView(time - this.viewSpan * .05, this.viewSpan);
      }
      this.queue();
    }
    setPlaying(playing) { this.playing = !!playing; }
    setDuration(seconds) {
      const d = Math.max(0, num(seconds)); if (d === this.duration) return;
      const fitted = !this.zoomed; this.duration = d;
      if (fitted) this.viewSpan = d;
      this.setView(this.viewStart, this.viewSpan); this.paintChrome(); this.invalidate();
    }
    setRegions(list) {
      const next = (list || []).filter(r => r && num(r.end) > num(r.start)).map(r => ({ start: num(r.start), end: num(r.end), kind: r.kind || 'selection' }));
      if (JSON.stringify(next) === JSON.stringify(this.regions)) return;
      this.regions = next; this.queue();
    }
    zoomBy(factor, anchor = this.zoomAnchor()) {
      if (!(this.duration > 0)) return;
      const span = clamp(this.viewSpan / factor, Math.min(this.minSpan(), this.duration), this.duration);
      const k = this.viewSpan ? (anchor - this.viewStart) / this.viewSpan : .5;
      this.setView(anchor - k * span, span);
    }
    fit() { this.setView(0, this.duration); }
    async reload() {
      const token = ++this.token; this.detailToken++;
      this.full = null; this.detail = null; this.status = 'loading'; this.error = null;
      this.paintChrome(); this.invalidate();
      const opts = { bins: this.wantedBins() };
      try {
        if (!this.loader) throw new Error('Waveform unavailable in this build');
        const data = await this.loader(opts);
        if (token !== this.token || this.destroyed) return;
        const full = prepare(data);
        this.full = full;
        if (full && !(this.duration > 0)) { this.duration = full.start + full.duration; this.viewSpan = this.duration; }
        this.status = full ? 'ready' : 'empty';
      } catch (error) {
        if (token !== this.token || this.destroyed) return;
        this.status = 'error'; this.error = cleanError(error);
      }
      this.paintChrome(); this.invalidate(); this.requestDetail();
    }
    destroy() {
      if (this.destroyed) return;
      this.destroyed = true; this.token++; this.detailToken++;
      cancelAnimationFrame(this.raf); clearTimeout(this.detailTimer);
      this.resizer.disconnect();
      this.canvas.removeEventListener('pointerdown', this.on.down);
      this.canvas.removeEventListener('pointermove', this.on.move);
      this.canvas.removeEventListener('pointerleave', this.on.leave);
      this.canvas.removeEventListener('dblclick', this.on.dbl);
      this.canvas.removeEventListener('wheel', this.on.wheel);
      this.endDrag?.();
      this.root.remove();
      this.base.width = this.base.height = this.played.width = this.played.height = 0;
      this.full = this.detail = null;
    }

    // ------------------------------------------------------------ View state
    minSpan() { return Math.max(MIN_SPAN, 64 / 48000); }
    zoomAnchor() { return this.time >= this.viewStart && this.time <= this.viewStart + this.viewSpan ? this.time : this.viewStart + this.viewSpan / 2; }
    wantedBins() {
      const px = Math.max(this.w, (screen?.width || 1920) * (devicePixelRatio || 1));
      const bins = px > 3000 ? BINS_HI : BINS;
      return this.duration > 0 ? Math.max(1, Math.min(bins, Math.floor(this.duration * 48000))) : bins;
    }
    setView(start, span) {
      const d = this.duration;
      span = d > 0 ? clamp(num(span) || d, Math.min(this.minSpan(), d), d) : 0;
      start = clamp(num(start), 0, Math.max(0, d - span));
      if (start === this.viewStart && span === this.viewSpan) return;
      this.viewStart = start; this.viewSpan = span;
      if (!this.zoomed) { this.detail = null; this.detailToken++; }
      this.paintChrome(); this.invalidate(); this.requestDetail();
    }
    // Fetch finer bins when the whole-source data is coarser than the screen.
    requestDetail() {
      clearTimeout(this.detailTimer);
      const full = this.full; if (!full || !this.zoomed || !this.loader || !this.plotW) return;
      const span = this.viewSpan, need = this.plotW;
      if (span / full.binDur >= need) return;
      const d = this.detail;
      if (d && d.start <= this.viewStart + 1e-9 && d.start + d.duration >= this.viewStart + span - 1e-9 && span / d.binDur >= need * .9) return;
      this.detailTimer = setTimeout(async () => {
        const token = ++this.detailToken;
        const start = Math.max(0, this.viewStart - span), end = Math.min(this.duration, this.viewStart + 2 * span), duration = end - start;
        const bins = Math.max(1, Math.min(BINS_HI, Math.ceil(need * duration / span), Math.floor(duration * 48000)));
        try {
          const data = prepare(await this.loader({ start, duration, bins }));
          if (token !== this.detailToken || this.destroyed || !data) return;
          this.detail = data; this.invalidate();
        } catch { /* The whole-source envelope stays on screen. */ }
      }, 140);
    }

    // ------------------------------------------------------------ Layout and drawing
    get rulerH() { return Math.round(RULER * this.dpr); }
    get overviewH() { return this.zoomed ? Math.round(OVERVIEW * this.dpr) : 0; }
    get plotW() { return this.w; }
    resize(entry) {
      const box = entry?.devicePixelContentBoxSize?.[0], css = entry?.contentRect;
      const dpr = devicePixelRatio || 1;
      const w = box ? box.inlineSize : Math.round((css?.width || 0) * dpr), h = box ? box.blockSize : Math.round((css?.height || 0) * dpr);
      if (w === this.w && h === this.h && dpr === this.dpr) return;
      Object.assign(this, { w, h, dpr });
      for (const c of [this.canvas, this.base, this.played]) { c.width = w; c.height = h; }
      this.invalidate(); this.requestDetail();
    }
    invalidate() { this.dirty = true; this.queue(); }
    queue() { if (!this.raf && !this.destroyed) this.raf = requestAnimationFrame(this.frame); }
    frame() {
      this.raf = 0;
      if (this.destroyed || !this.w || !this.h) return;
      if (this.dirty) { this.dirty = false; this.drawBase(); }
      this.compose();
    }
    xOf(t) { return this.viewSpan > 0 ? (t - this.viewStart) / this.viewSpan * this.w : 0; }
    tOf(x) { return this.viewStart + clamp(x / Math.max(1, this.w), 0, 1) * this.viewSpan; }
    laneRects() {
      const top = this.rulerH, bottom = this.h - this.overviewH, n = Math.max(1, this.full?.lanes.length || 1), gap = Math.round(LANE_GAP * this.dpr);
      const each = (bottom - top - gap * (n - 1)) / n;
      return Array.from({ length: n }, (_, i) => ({ y: top + i * (each + gap), h: each }));
    }
    font(size, weight = 500) {
      if (!this.mono) this.mono = getComputedStyle(this.root).getPropertyValue('--mono').trim() || 'Consolas, monospace';
      return `${weight} ${Math.round(size * this.dpr)}px ${this.mono}`;
    }
    drawBase() {
      const g = this.base.getContext('2d'), p = this.played.getContext('2d'), { w, h, dpr } = this;
      g.setTransform(1, 0, 0, 1, 0, 0); p.setTransform(1, 0, 0, 1, 0, 0);
      g.fillStyle = C.bg; g.fillRect(0, 0, w, h); p.clearRect(0, 0, w, h);
      const lanes = this.laneRects(), src = this.sourceFor(), gain = this.gain;
      for (const r of lanes) { g.fillStyle = C.lane; g.fillRect(0, r.y, w, r.h); }
      for (let i = 0; i < lanes.length; i++) {
        const r = lanes[i], cy = r.y + r.h / 2, half = r.h / 2 * (1 - PAD);
        if (src) this.drawGuides(g, r, cy, half, gain);
        g.fillStyle = C.center; g.fillRect(0, Math.round(cy), w, Math.max(1, Math.round(dpr * .75)));
        if (src) this.drawLane(g, p, src, src.lanes[i], cy, half, gain);
        const label = this.full?.lanes[i]?.label;
        if (label && label !== 'Mono') {
          g.font = this.font(10, 600); g.fillStyle = C.label; g.textBaseline = 'top'; g.textAlign = 'left';
          g.fillText(label[0], Math.round(6 * dpr), r.y + Math.round(5 * dpr));
        }
      }
      for (let i = 1; i < lanes.length; i++) { g.fillStyle = C.line; g.fillRect(0, Math.round(lanes[i].y - LANE_GAP * dpr), w, Math.round(LANE_GAP * dpr)); }
      this.drawRuler(g);
      if (this.overviewH) this.drawOverview(g);
    }
    sourceFor() {
      const d = this.detail, f = this.full;
      if (d && f && d.lanes.length === f.lanes.length && d.start <= this.viewStart + 1e-9 && d.start + d.duration >= this.viewStart + this.viewSpan - 1e-9 && d.binDur < f.binDur) return d;
      return f;
    }
    drawLane(g, p, src, lane, cy, half, gain) {
      const n = this.w, buf = this.buf?.min.length === n ? this.buf
        : (this.buf = { min: new Float32Array(n), max: new Float32Array(n), rms: new Float32Array(n), has: new Uint8Array(n) });
      if (!lane || !n) return;
      columns(src, lane, this.viewStart, this.viewStart + this.viewSpan, n, buf);
      const y = v => cy - clamp(v * gain, -1, 1) * half, thin = .5 * this.dpr;
      const peak = new Path2D(), rms = new Path2D();
      // Envelopes are closed per contiguous run, so gaps without data stay empty.
      for (let c = 0; c < n;) {
        if (!buf.has[c]) { c++; continue; }
        let e = c; while (e < n && buf.has[e]) e++;
        const top = i => { const a = y(buf.max[i]), b = y(buf.min[i]); return a > b - thin * 2 ? (a + b) / 2 - thin : a; };
        const bot = i => { const a = y(buf.max[i]), b = y(buf.min[i]); return a > b - thin * 2 ? (a + b) / 2 + thin : b; };
        peak.moveTo(c, top(c)); for (let i = c; i < e; i++) peak.lineTo(i + .5, top(i)); peak.lineTo(e, top(e - 1));
        peak.lineTo(e, bot(e - 1)); for (let i = e - 1; i >= c; i--) peak.lineTo(i + .5, bot(i)); peak.lineTo(c, bot(c)); peak.closePath();
        const rt = i => y(Math.min(buf.rms[i], Math.max(buf.max[i], 0))), rb = i => y(Math.max(-buf.rms[i], Math.min(buf.min[i], 0)));
        rms.moveTo(c, rt(c)); for (let i = c; i < e; i++) rms.lineTo(i + .5, rt(i)); rms.lineTo(e, rt(e - 1));
        rms.lineTo(e, rb(e - 1)); for (let i = e - 1; i >= c; i--) rms.lineTo(i + .5, rb(i)); rms.lineTo(c, rb(c)); rms.closePath();
        c = e;
      }
      const edge = Math.max(1, this.dpr * .75);
      for (const [ctx, fill, stroke, core] of [[g, C.peak, C.peakEdge, C.rms], [p, C.peakPlayed, C.peakEdgePlayed, C.rmsPlayed]]) {
        ctx.fillStyle = fill; ctx.fill(peak);
        ctx.lineWidth = edge; ctx.lineJoin = 'round'; ctx.strokeStyle = stroke; ctx.stroke(peak);
        ctx.fillStyle = core; ctx.fill(rms);
      }
    }
    drawGuides(g, r, cy, half, gain) {
      const { w, dpr } = this, minGap = 15 * dpr;
      let last = Infinity;
      g.font = this.font(9); g.textAlign = 'right';
      for (const db of DB) {
        const a = Math.pow(10, db / 20) * gain; if (a > 1.0001) continue;
        const off = a * half; if (off < 9 * dpr) break;
        if (last - off < minGap) continue;
        last = off;
        g.fillStyle = C.guide;
        for (const yy of [cy - off, cy + off]) g.fillRect(0, Math.round(yy), w, Math.max(1, Math.round(dpr * .75)));
        if (r.h > 60 * dpr) {
          g.fillStyle = C.guideLabel; g.textBaseline = 'top';
          g.fillText(db ? `−${-db}` : '0 dB', w - 6 * dpr, Math.round(cy - off) + 2 * dpr);
        }
      }
    }
    drawRegions(g, lanes) {
      if (!this.regions.length) return;
      const top = lanes[0].y, bottom = lanes[lanes.length - 1].y + lanes[lanes.length - 1].h, dpr = this.dpr;
      for (const r of this.regions) {
        const a = this.xOf(r.start), b = this.xOf(r.end); if (b < 0 || a > this.w) continue;
        if (r.kind === 'selection') {
          g.fillStyle = C.selection; g.fillRect(a, top, b - a, bottom - top);
          g.fillStyle = C.selectionEdge; g.fillRect(Math.round(a), top, Math.max(1, dpr), bottom - top); g.fillRect(Math.round(b) - Math.max(1, dpr), top, Math.max(1, dpr), bottom - top);
        } else {
          g.fillStyle = r.kind === 'take' ? 'rgba(240,154,44,.08)' : 'rgba(76,138,224,.09)'; g.fillRect(a, top, b - a, bottom - top);
        }
      }
    }
    drawRuler(g) {
      const { w, dpr } = this, rh = this.rulerH;
      g.fillStyle = C.rulerBg; g.fillRect(0, 0, w, rh);
      g.fillStyle = C.line; g.fillRect(0, rh - Math.max(1, Math.round(dpr)), w, Math.max(1, Math.round(dpr)));
      if (!(this.viewSpan > 0)) return;
      const pps = w / this.viewSpan, long = this.duration >= 3600;
      const [step, minor] = TICKS.find(([s]) => s * pps >= (long ? 86 : 72) * dpr) || TICKS[TICKS.length - 1];
      const t0 = this.viewStart, t1 = t0 + this.viewSpan;
      g.fillStyle = C.tick;
      if (minor * pps >= 5 * dpr) for (let i = Math.ceil(t0 / minor - 1e-6); i * minor <= t1; i++) g.fillRect(Math.round(this.xOf(i * minor)), rh - 4 * dpr, Math.max(1, Math.round(dpr * .75)), 3 * dpr);
      g.font = this.font(10); g.textBaseline = 'middle'; g.textAlign = 'left';
      for (let i = Math.ceil(t0 / step - 1e-6); i * step <= t1 + 1e-9; i++) {
        const t = i * step, x = Math.round(this.xOf(t));
        g.fillStyle = C.tick; g.fillRect(x, rh - 9 * dpr, Math.max(1, Math.round(dpr * .75)), 8 * dpr);
        g.fillStyle = C.label; g.fillText(rulerLabel(t, step, long), x + 4 * dpr, rh / 2 - 2 * dpr);
      }
      for (const r of this.regions) {
        if (r.kind === 'selection') continue;
        const a = this.xOf(r.start), b = this.xOf(r.end); if (b < 0 || a > w) continue;
        g.fillStyle = r.kind === 'take' ? C.take : C.range; g.fillRect(a, rh - 3 * dpr, Math.max(dpr, b - a), 2 * dpr);
      }
    }
    // Whole-source strip with the visible window; only shown while zoomed.
    drawOverview(g) {
      const { w, h, dpr } = this, oh = this.overviewH, y0 = h - oh, full = this.full;
      g.fillStyle = C.rulerBg; g.fillRect(0, y0, w, oh);
      g.fillStyle = C.line; g.fillRect(0, y0, w, Math.max(1, Math.round(dpr)));
      if (full && this.duration > 0) {
        const n = Math.max(1, Math.floor(w / Math.max(1, Math.round(dpr)))), step = w / n, cy = y0 + oh / 2, half = oh / 2 - 3 * dpr, gain = this.gain;
        g.fillStyle = 'rgba(240,154,44,.55)';
        for (let c = 0; c < n; c++) {
          const a = c / n * this.duration, b = (c + 1) / n * this.duration;
          const i0 = clamp(Math.floor((a - full.start) / full.binDur), 0, full.bins - 1), i1 = clamp(Math.ceil((b - full.start) / full.binDur), i0 + 1, full.bins);
          let m = 0; for (const l of full.lanes) for (let i = i0; i < i1; i++) m = Math.max(m, Math.abs(l.max[i]), Math.abs(l.min[i]));
          const v = Math.max(.5 * dpr, Math.min(1, m * gain) * half); g.fillRect(c * step, cy - v, Math.max(1, step - .25), v * 2);
        }
      }
      const a = this.viewStart / this.duration * w, b = (this.viewStart + this.viewSpan) / this.duration * w;
      g.fillStyle = 'rgba(58,121,187,.2)'; g.fillRect(a, y0 + dpr, b - a, oh - dpr);
      g.strokeStyle = 'rgba(123,176,240,.85)'; g.lineWidth = Math.max(1, dpr); g.strokeRect(a + g.lineWidth / 2, y0 + dpr + g.lineWidth / 2, Math.max(1, b - a - g.lineWidth), oh - dpr - g.lineWidth);
      const p = this.time / this.duration * w; g.fillStyle = C.accent; g.fillRect(Math.round(p), y0, Math.max(1, Math.round(dpr)), oh);
    }
    compose() {
      const g = this.ctx, { w, h, dpr } = this, rh = this.rulerH, bottom = h - this.overviewH;
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.drawImage(this.base, 0, 0);
      const x = this.xOf(this.time);
      if (x > 0) { g.save(); g.beginPath(); g.rect(0, rh, Math.min(w, x), bottom - rh); g.clip(); g.drawImage(this.played, 0, 0); g.restore(); }
      if (this.overviewH) { const p = this.time / this.duration * w; g.fillStyle = C.accent; g.fillRect(Math.round(p), bottom, Math.max(1, Math.round(dpr)), h - bottom); }
      this.drawRegions(g, this.laneRects());
      let pill = null;
      if (x >= 0 && x <= w) {
        g.fillStyle = C.accent; g.fillRect(Math.round(x - dpr * .5), rh, Math.max(1, Math.round(dpr * 1.25)), bottom - rh);
        pill = this.pill(g, x, this.format(this.time), C.accent, '#191919');
      }
      const hv = this.hover;
      if (hv != null && !this.drag && hv.y < bottom) {
        const hx = Math.round(this.xOf(hv.t));
        g.fillStyle = C.hover; g.fillRect(hx, rh, Math.max(1, Math.round(dpr * .75)), bottom - rh);
        const label = this.format(hv.t), lw = this.pillWidth(g, label);
        if (!pill || hx + lw / 2 < pill.a - 4 * dpr || hx - lw / 2 > pill.b + 4 * dpr) this.pill(g, hx, label, '#585858', '#eeeeee');
      }
    }
    pillWidth(g, text) { g.font = this.font(10, 600); return g.measureText(text).width + 12 * this.dpr; }
    pill(g, x, text, bg, fg) {
      const { dpr, w } = this, rh = this.rulerH, pw = this.pillWidth(g, text), ph = 16 * dpr;
      const a = clamp(x - pw / 2, 1, Math.max(1, w - pw - 1)), y = (rh - ph) / 2 - .5 * dpr;
      g.fillStyle = bg; g.beginPath(); g.roundRect ? g.roundRect(a, y, pw, ph, 3 * dpr) : g.rect(a, y, pw, ph); g.fill();
      g.fillStyle = fg; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(text, a + pw / 2, y + ph / 2 + .5 * dpr);
      return { a, b: a + pw };
    }

    // ------------------------------------------------------------ DOM chrome
    paintChrome() {
      if (this.destroyed) return;
      const full = this.full, gain = this.gain, s = this.statusEl;
      s.hidden = this.status === 'ready';
      s.classList.toggle('busy', this.status === 'loading');
      s.textContent = this.status === 'loading' ? 'Analyzing audio' : this.status === 'error' ? 'Waveform unavailable' : this.status === 'empty' ? 'No audio' : '';
      const peakDb = full?.peak > 0 ? 20 * Math.log10(full.peak) : null;
      const quiet = full && full.peak > 0 && full.peak < .5, silent = full && !(full.peak > 1e-6);
      this.gainBadge.hidden = !(quiet || silent);
      this.gainBadge.disabled = !!silent;
      this.gainBadge.classList.toggle('on', gain > 1);
      this.gainBadge.textContent = silent ? 'Silent' : gain > 1 ? `${dbText(20 * Math.log10(gain))} dB` : '1:1';
      this.gainBadge.dataset.tipTitle = silent ? 'Silent source' : gain > 1 ? 'Display gain' : 'True scale';
      this.gainBadge.dataset.tipDesc = silent ? 'No signal above −120 dBFS.' : `Peak ${dbText(peakDb)} dBFS. ${gain > 1 ? 'Quiet audio is enlarged for viewing only.' : 'Drawn at true amplitude.'} Playback is unchanged.`;
      this.gainBadge.dataset.tipHint = silent ? '' : gain > 1 ? 'Click for true scale' : 'Click to enlarge';
      this.zoomBadge.hidden = !this.zoomed;
      if (this.zoomed) this.zoomBadge.textContent = `${Math.round(this.duration / this.viewSpan) >= 10 ? Math.round(this.duration / this.viewSpan) : (this.duration / this.viewSpan).toFixed(1)}×`;
      this.statusEl.dataset.error = this.error || '';
      this.setTips();
    }
    setTips() {
      const wave = () => ({
        title: this.status === 'error' ? 'Waveform unavailable' : 'Waveform',
        desc: this.status === 'error' ? `${this.error} Playback still works.` : null,
        meta: this.full ? `${this.full.lanes.length > 1 ? 'Stereo' : 'Mono'} · peak ${this.full.peak > 0 ? dbText(20 * Math.log10(this.full.peak)) : '−∞'} dBFS` : null,
        hint: [{ keys: '#Click', text: 'seek' }, ...(this.onSelectRange ? [{ keys: '#Drag', text: 'select range' }, { keys: '#Drag selection', text: 'insert into timeline' }, { keys: 'Shift', text: 'select again' }] : []), { keys: '#Wheel', text: 'zoom' }, { keys: ['Shift', '#Wheel'], text: 'pan' }, { keys: '#Double-click', text: 'fit' }],
        follow: true,
      });
      const badge = b => () => ({ title: b.dataset.tipTitle, desc: b.dataset.tipDesc || null, hint: b.dataset.tipHint ? [{ keys: '#Click', text: b.dataset.tipHint.replace(/^Click /, '') }] : null });
      const zoom = () => ({ title: 'Zoomed', desc: 'Click to fit the whole source.', hint: [{ keys: '#Click', text: 'fit' }] });
      if (this.tips === 'title') {
        const w = wave();
        this.canvas.title = [w.title, w.desc, w.meta, 'Click or drag to seek · Wheel or = − to zoom · Shift+Wheel to pan · Double-click to fit'].filter(Boolean).join('\n');
        const b = badge(this.gainBadge)(); this.gainBadge.title = [b.title, b.desc, this.gainBadge.dataset.tipHint].filter(Boolean).join('\n');
        this.zoomBadge.title = 'Fit whole source';
      } else {
        this.canvas.tip = wave; this.gainBadge.tip = badge(this.gainBadge); this.zoomBadge.tip = zoom;
      }
    }

    // ------------------------------------------------------------ Input
    point(e) {
      const r = this.canvas.getBoundingClientRect(), sx = this.w / Math.max(1, r.width), sy = this.h / Math.max(1, r.height);
      return { x: (e.clientX - r.left) * sx, y: (e.clientY - r.top) * sy };
    }
    pointerMove(e) {
      if (this.drag) return;
      const { x, y } = this.point(e);
      const over = y >= this.h - this.overviewH && this.overviewH;
      const range = this.getDragRange?.(), t = this.tOf(x);
      const draggable = !over && range && t >= range.start && t <= range.end && !e.shiftKey;
      this.canvas.draggable = !!draggable;
      this.canvas.style.cursor = over || draggable ? 'grab' : this.onSelectRange ? 'crosshair' : '';
      this.hover = over || !(this.duration > 0) ? null : { t: this.tOf(x), y };
      this.queue();
    }
    pointerDown(e) {
      if (!(this.duration > 0) || (e.button !== 0 && e.button !== 1)) return;
      const hit = this.point(e), range = this.getDragRange?.(), t = this.tOf(hit.x);
      const over = this.overviewH && hit.y >= this.h - this.overviewH;
      if (e.button === 0 && !e.altKey && !e.shiftKey && !over && range && t >= range.start && t <= range.end) {
        this.canvas.draggable = true; return;
      }
      this.canvas.draggable = false;
      e.preventDefault();
      const start = this.point(e), mode = this.overviewH && start.y >= this.h - this.overviewH ? 'overview' : e.button === 1 || e.altKey ? 'pan' : 'seek';
      const origin = { start: this.viewStart, x: start.x };
      this.canvas.setPointerCapture(e.pointerId);
      this.drag = mode; this.hover = null;
      let pending = null, raf = 0;
      const selectionStart = this.tOf(start.x);
      const seekAt = (x, phase) => {
        if (this.onSelectRange && phase !== 'start' && Math.abs(x - start.x) >= 3 * this.dpr) this.onSelectRange(selectionStart, this.tOf(x), phase);
        const t = clamp(this.tOf(x), 0, this.duration); this.time = t; this.queue(); this.onSeek?.(t, phase); };
      const apply = x => {
        if (mode === 'seek') seekAt(x, 'move');
        else if (mode === 'pan') this.setView(origin.start - (x - origin.x) / this.w * this.viewSpan, this.viewSpan);
        else this.setView((x / this.w) * this.duration - this.viewSpan / 2, this.viewSpan);
      };
      if (mode === 'seek') { this.onClearRange?.(); seekAt(start.x, 'start'); }
      else if (mode === 'overview') { this.canvas.style.cursor = 'grabbing'; apply(start.x); }
      else this.canvas.style.cursor = 'grabbing';
      const move = ev => { pending = this.point(ev).x; if (!raf) raf = requestAnimationFrame(() => { raf = 0; if (pending != null) apply(pending); }); };
      const end = ev => {
        cancelAnimationFrame(raf); raf = 0;
        this.canvas.removeEventListener('pointermove', move);
        this.canvas.removeEventListener('pointerup', end);
        this.canvas.removeEventListener('pointercancel', end);
        this.endDrag = null; this.drag = null; this.canvas.style.cursor = '';
        if (this.destroyed || !ev) return;
        const x = ev.type === 'pointerup' ? this.point(ev).x : pending ?? start.x;
        if (mode === 'seek') seekAt(x, 'end'); else if (pending != null) apply(x);
      };
      this.endDrag = () => end(null);
      this.canvas.addEventListener('pointermove', move);
      this.canvas.addEventListener('pointerup', end);
      this.canvas.addEventListener('pointercancel', end);
    }
    wheel(e) {
      if (!(this.duration > 0)) return;
      e.preventDefault();
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
      const dx = e.deltaX * unit, dy = e.deltaY * unit;
      if (e.shiftKey || Math.abs(dx) > Math.abs(dy)) {
        const d = e.shiftKey && !dx ? dy : dx;
        this.setView(this.viewStart + d * this.dpr / this.w * this.viewSpan, this.viewSpan);
        return;
      }
      const { x } = this.point(e);
      this.zoomBy(Math.exp(-dy * .0022), this.tOf(x));
    }
  };
})();
