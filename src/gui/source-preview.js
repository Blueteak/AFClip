'use strict';
// Read-only source monitor. It owns its picture, audio and clock, so browsing
// project media never touches the timeline preview session or the project.
(() => {
  const SVG = 'http://www.w3.org/2000/svg';
  const el = (tag, cls) => { const e = document.createElement(tag); if (cls) e.className = cls; return e; };
  const icon = name => {
    const s = document.createElementNS(SVG, 'svg'), u = document.createElementNS(SVG, 'use');
    s.setAttribute('class', 'icon'); u.setAttribute('href', `#i-${name}`); s.append(u); return s;
  };
  const num = v => Number.isFinite(Number(v)) ? Number(v) : 0;
  const clip = (text, n = 180) => { const s = String(text || '').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };

  window.AFClipSourcePreview = class AFClipSourcePreview {
    constructor({ api, stage, strip, format = t => t.toFixed(2), frameDuration = () => 1 / 30, onTime, onState, onSelect, onError, onDragStart, onDragEnd }) {
      this.api = api; this.stage = stage; this.strip = strip; this.format = format; this.frameDuration = frameDuration;
      this.callbacks = {};
      this.generation = 0; this.playEpoch = 0; this.version = 0; this.status = 'idle';
      this.media = null; this.key = null; this.data = null; this.error = null; this.notice = null; this.selected = null;
      this.blocks = []; this.blockByKey = new Map(); this.blockEls = new Map();
      this.time = 0; this.playing = false; this.wantsPlay = false; this.native = null; this.audio = null;
      this.host = el('div', 'source-host');
      this.still = el('img', 'source-still'); this.still.alt = '';
      this.waveHost = el('div', 'source-wave'); this.wave = null;
      this.message = el('div', 'stage-empty source-message');
      this.still.onerror = () => { if (this.status === 'ready' && this.still.getAttribute('src')) { this.still.hidden = true; this.showMessage('alert', 'Image could not load'); } };
      stage.replaceChildren(this.host, this.still, this.waveHost, this.message);
      this.lanes = el('div', 'source-lanes');
      strip.replaceChildren(this.lanes);
      this.lanes.addEventListener('pointerdown', e => this.pointerDown(e));
      this.lanes.addEventListener('pointermove', e => {
        if (this.kind === 'video' && !e.buttons && this.timed) {
          const r = this.lanes.getBoundingClientRect();
          void this.seek((e.clientX - r.left) / Math.max(1, r.width) * this.duration);
        }
      });
      this.loop = this.loop.bind(this);
      this.render();
      // Callbacks start after construction, once the owner holds a reference.
      this.callbacks = { onTime, onState, onSelect, onError, onDragStart, onDragEnd };
    }
    get mediaId() { return this.media?.id ?? null; }
    get kind() { return this.data?.kind || this.media?.kind || null; }
    get duration() { return Math.max(0, num(this.data?.duration)); }
    get timed() { return this.status === 'ready' && (this.kind === 'video' || this.kind === 'audio') && this.duration > 0 && !!(this.native || this.audio); }
    get running() { return this.playing || this.wantsPlay; }
    get lastTime() {
      if (this.kind === 'audio') return this.duration;
      const pts = this.kind === 'video' ? this.data?.pts : null;
      return pts?.length ? Math.min(pts[pts.length - 1], this.duration) : Math.max(0, this.duration - this.frameDuration());
    }

    // ------------------------------------------------------------ Loading
    async open(media, key = media.id) {
      if (this.media && this.key === key && this.status !== 'error') { this.pause(); return; }
      const generation = ++this.generation;
      this.teardown();
      Object.assign(this, { media, key, data: null, draft: null, marksCleared: false, error: null, notice: null, selected: null, time: 0, status: 'loading' });
      this.version++; this.render(); this.emit();
      try {
        if (!this.api.sourcePreview) throw new Error('Source preview is not available in this build');
        const data = await this.api.sourcePreview(media.id);
        if (generation !== this.generation) return;
        if (!data) throw new Error('Source preview unavailable');
        this.data = data;
        const kind = data.kind;
        if (kind === 'video' && data.url) {
          const id = data.mediaId || media.id, duration = Math.max(num(data.duration), .001);
          const project = { cacheLimitBytes: 128 * 1024 ** 2, media: [{ id, kind: 'video', name: data.name, duration }], tracks: [{ id: 'source' }],
            clips: [{ id: 'source', mediaId: id, trackId: 'source', start: 0, duration, sourceIn: 0, speed: 1 }], transitions: [] };
          this.native = new window.NativePreview({ project, width: data.width || 1920, height: data.height || 1080, plan: window.AFClipTimeline.compile(project),
            media: { [id]: { kind: 'video', url: data.url, pts: data.pts || [], seekProxy: data.seekProxy || null } }, graphics: {} },
          this.host, error => { if (generation === this.generation) this.fail(error); });
        }
        if ((kind === 'video' || kind === 'audio') && data.audioUrl) {
          const audio = new Audio(data.audioUrl); audio.preload = 'auto';
          audio.onerror = () => {
            if (generation !== this.generation || this.audio !== audio) return;
            this.releaseAudio();
            if (kind === 'audio') this.fail(new Error('Source audio could not load'));
            else { this.notice = 'Audio unavailable'; this.emit(); }
          };
          this.audio = audio;
        }
        this.status = 'ready'; this.version++;
        this.render();
        const start = data.selection ? Math.max(0, num(data.selection.start)) : 0;
        if (this.timed) await this.seek(start); else this.paintTime();
        if (generation === this.generation) this.emit();
      } catch (error) { if (generation === this.generation) this.fail(error); }
    }
    // Library annotations change independently of the picture. Swap them in place.
    async refreshAnnotations() {
      if (!this.media || this.status !== 'ready' || this.refreshing || !this.api.sourcePreview) return;
      const generation = this.generation; this.refreshing = true;
      try {
        const data = await this.api.sourcePreview(this.media.id);
        if (generation !== this.generation || !data || !this.data) return;
        Object.assign(this.data, { name: data.name, annotations: data.annotations, warning: data.warning, selection: data.selection });
        // A draft retains the revision it was marked against until cleared.
        if (!this.draft) this.data.selectionContext = data.selectionContext;
        // Preparation completes independently of annotations. Adopt its index and
        // disposable seek cache without interrupting the current playback clock.
        if (data.selectionContext && data.pts?.length) {
          this.data.pts = data.pts; this.data.seekProxy = data.seekProxy; this.data.prepared = data.prepared;
          for (const entry of this.native?.entries.values() || []) {
            entry.media.pts = data.pts; entry.media.seekProxy = data.seekProxy;
          }
        }
        this.version++;
        this.renderLanes();
        this.selected = this.selected ? this.blockByKey.get(this.selected.key) || null : null;
        this.paintSelection(); this.paintTime(); this.emit(); this.callbacks.onSelect?.(this.selected);
      } catch { /* Keep the annotations already shown. */ }
      finally { this.refreshing = false; }
    }
    clear() {
      this.generation++; this.teardown();
      Object.assign(this, { media: null, key: null, data: null, error: null, notice: null, selected: null, draft: null, time: 0, status: 'idle' });
      this.version++; this.render(); this.emit();
    }
    async prepare() {
      if (!this.media?.metadata?.library || this.preparing) return;
      const generation=this.generation, id=this.mediaId;
      this.preparing=true; this.preparation=[]; this.notice=null; this.version++; this.emit();
      try {
        const result=await this.api.command({command:'source-prepare',id});
        if(generation!==this.generation)return;
        this.preparation=result.jobs; this.version++; this.emit();
        while(generation===this.generation && this.preparation.some(j=>['queued','running'].includes(j.status))) {
          await new Promise(resolve=>setTimeout(resolve,500));
          const jobs=await this.api.command({command:'source-jobs',id});
          if(generation!==this.generation)return;
          this.preparation=this.preparation.map(old=>{const job=jobs.find(j=>j.id===old.id);if(!job)throw new Error('Preparation job is no longer available. Inspect source jobs before retrying.');return job;});
          this.version++; this.emit();
        }
        if(generation!==this.generation)return;
        const failed=this.preparation.find(j=>j.status==='failed'||j.status==='cancelled');
        this.notice=failed ? failed.error || 'Preparation cancelled' : null;
        if (!failed) {
          // Remuxed containers and decoded audio may have new URLs. Reopen at
          // the same source time, keeping the user's temporary marks.
          const media=this.media,key=this.key,at=this.time,draft=this.draft,resume=this.running;
          this.key=null;
          await this.open(media,key);
          if(this.media===media&&this.status==='ready') {
            this.draft=draft;this.selectionChanged();await this.seek(at);if(resume)await this.play();
          }
        } else await this.refreshAnnotations();
      } catch(error) {if(generation===this.generation)this.notice=error.message;}
      finally {if(generation===this.generation){this.preparing=false;this.version++;this.emit();}}
    }
    async cancelPreparation() {
      const id=this.mediaId,generation=this.generation,jobs=[...(this.preparation||[])];
      try {for(const job of jobs)if(['queued','running'].includes(job.status))
        await this.api.command({command:'source-cancel',id,jobId:job.id});
      } catch(error) {if(generation===this.generation){this.notice=error.message;this.version++;this.emit();}}
    }
    fail(error) {
      this.generation++; this.teardown();
      this.status = 'error'; this.error = String(error?.message || error || 'Source preview failed').replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
      this.version++; this.render(); this.emit(); this.callbacks.onError?.(new Error(this.error));
    }
    releaseAudio() {
      const audio = this.audio; if (!audio) return;
      audio.onerror = null; audio.pause(); audio.removeAttribute('src'); audio.load(); this.audio = null;
    }
    teardown() {
      this.stop();
      this.preparing=false; this.preparation=[];
      this.native?.close(); this.native = null;
      this.releaseAudio();
      this.host.replaceChildren();
      this.wave?.destroy(); this.wave = null;
      this.still.removeAttribute('src');
    }

    // ------------------------------------------------------------ Transport
    async seek(time) {
      if (!this.timed) return;
      this.stop();
      this.time = Math.max(0, Math.min(num(time), this.lastTime));
      this.paintTime();
      if (this.audio) try { this.audio.currentTime = this.time; } catch { /* Not seekable before metadata. */ }
      if (!this.native) return;
      const generation = this.generation;
      try { await this.native.seek(this.time); }
      catch (error) { if (generation === this.generation) this.fail(error); }
    }
    async play() {
      if (!this.timed || this.running) return;
      if (this.time >= this.lastTime - 1e-3) this.time = 0;
      const epoch = ++this.playEpoch, generation = this.generation, current = () => epoch === this.playEpoch && generation === this.generation;
      this.wantsPlay = true; this.emit();
      try {
        if (this.native) await this.native.seek(this.time, true);
        if (!current()) return;
        if (this.audio) {
          this.audio.currentTime = this.time;
          try { await this.audio.play(); }
          catch (error) { if (!current()) return; if (error.name === 'AbortError') return; if (!this.native) throw error; this.notice = 'Audio unavailable'; }
        }
        if (!current()) { this.audio?.pause(); return; }
        this.baseTime = this.time; this.baseClock = performance.now(); this.playing = true; this.wave?.setPlaying(true); this.emit();
        this.loop();
      } catch (error) { if (current()) this.fail(error); }
    }
    loop() {
      if (!this.playing) return;
      const audio = this.audio;
      this.time = audio && !audio.paused ? audio.currentTime : this.baseTime + (performance.now() - this.baseClock) / 1000;
      if (this.time >= this.duration || (audio && audio.ended && !this.native)) {
        this.time = this.lastTime; this.stop(); this.paintTime(); this.emit();
        if (this.native) this.native.seek(this.time).catch(() => {});
        return;
      }
      this.native?.update(this.time);
      this.paintTime();
      this.tick = requestAnimationFrame(this.loop);
    }
    stop() {
      const was = this.running;
      this.playEpoch++; this.playing = false; this.wantsPlay = false; this.wave?.setPlaying(false);
      cancelAnimationFrame(this.tick);
      this.native?.pause(); this.audio?.pause();
      return was;
    }
    pause() { if (this.stop()) { this.paintTime(); this.emit(); } }
    togglePlay() { if (this.running) this.pause(); else this.play(); }
    step(frames) {
      if (!this.timed) return;
      const pts = this.kind === 'video' ? this.data.pts : null;
      if (pts?.length) {
        let low = 0, high = pts.length;
        while (low < high) { const mid = (low + high) >>> 1; if (pts[mid] <= this.time + 1e-7) low = mid + 1; else high = mid; }
        const index = Math.max(0, low - 1), target = Math.max(0, Math.min(pts.length - 1, index + frames));
        return this.seek(pts[target]);
      }
      return this.seek(this.time + frames * this.frameDuration());
    }
    toStart() { return this.seek(0); }
    toEnd() { return this.seek(this.lastTime); }
    // Step through annotations in time order, landing on each start.
    jump(direction) {
      const list = this.blocks; if (!this.timed || !list.length) return false;
      const i = this.selected ? list.findIndex(b => b.key === this.selected.key) : -1;
      const target = i >= 0 && Math.abs(this.time - Math.min(list[i].start, this.lastTime)) < 1e-3 ? list[i + direction]
        : direction < 0 ? [...list].reverse().find(b => b.start < this.time - 1e-3) : list.find(b => b.start > this.time + 1e-3);
      if (!target) return false;
      this.select(target); return true;
    }
    select(block, seek = true) {
      this.selected = block || null;
      this.paintSelection(); this.callbacks.onSelect?.(this.selected);
      if (block && seek) this.seek(block.start);
    }

    get exactMarks() { return !this.draft?.seconds && !!this.data?.selectionContext && (this.kind === 'audio' ? !!this.data.sampleRate : !!this.data.pts?.length); }
    get canMark() { return this.timed; }
    boundary(t, out = false) {
      if (!this.exactMarks) return Math.max(0, Math.min(t, this.duration));
      if (this.kind === 'audio') return Math.min(Math.floor(this.duration * this.data.sampleRate), Math.round(t * this.data.sampleRate));
      const pts = this.data.pts;
      let i = pts.findIndex(p => p > t + 1e-7);
      if (i < 0) i = pts.length;
      return out ? i : Math.max(0, i - 1);
    }
    boundaryTime(i) { if (!this.exactMarks) return i; return this.kind === 'audio' ? i / this.data.sampleRate : this.data.pts[i] ?? this.duration; }
    mark(out = false) {
      if (!this.canMark) return;
      const total = !this.exactMarks ? this.duration : this.kind === 'audio' ? Math.floor(this.duration * this.data.sampleRate) : this.data.pts.length;
      const draft = this.draft || { first: 0, last: total, ...this.data.selectionContext, seconds: !this.exactMarks };
      const i = this.boundary(this.time, out);
      if (out) { draft.last = i; if (draft.last <= draft.first) draft.first = Math.max(0, i - 1); }
      else { draft.first = i; if (draft.first >= draft.last) draft.last = Math.min(total, i + 1); }
      this.draft = draft; this.selectionChanged();
    }
    useSelected() {
      if (!this.canMark || !this.selected) return;
      const b = this.selected, bounds = b.item.boundaries;
      this.draft = { ...this.data.selectionContext, seconds: !this.exactMarks,
        first: !this.exactMarks ? b.start : bounds?.startSample ?? bounds?.startFrame ?? this.boundary(b.start),
        last: !this.exactMarks ? b.end : bounds?.endSample ?? bounds?.endFrame ?? (this.kind === 'audio' ? this.boundary(b.end) : this.boundary(b.end - 1e-6, true)) };
      this.selectionChanged();
    }
    clearMarks() { this.draft = null; this.marksCleared = true; this.selected = null; this.selectionChanged(); }
    selectionChanged() { this.version++; this.paintRange(); this.paintSelection(); this.paintTime(); this.emit(); }
    get markedRange() { return this.draft ? { start:this.boundaryTime(this.draft.first), end:this.boundaryTime(this.draft.last) } : this.marksCleared ? null : this.data?.selection; }
    selectionRequest() {
      if (!this.draft || !this.exactMarks) return undefined;
      const {first,last,revision,sourceId} = this.draft;
      return {revision,sourceId,...(this.kind === 'audio' ? {startSample:first,endSample:last} : {startFrame:first,endFrame:last})};
    }

    selectRange(start, end, phase = 'end') {
      if (!this.timed) return;
      const lo = Math.max(0, Math.min(start, end)), hi = Math.min(this.duration, Math.max(start, end));
      if (hi <= lo) return;
      this.draft = { ...this.data.selectionContext, seconds: !this.exactMarks, first: this.boundary(lo), last: this.boundary(hi, true) };
      if (phase === 'move') { this.paintRange(); this.paintWaveRegions(); }
      else this.selectionChanged();
    }
    startRangeDrag(e) {
      const range = this.markedRange;
      if (!range || !this.timed) { e.preventDefault(); return; }
      this.pause();
      e.dataTransfer.setData('application/x-afclip-media', this.mediaId);
      e.dataTransfer.effectAllowed = 'copy';
      if (this.kind === 'audio' && this.rangeHandle) e.dataTransfer.setDragImage(this.rangeHandle, 12, 12);
      this.callbacks.onDragStart?.({ media: this.media, selection: this.selectionRequest(), range: { ...range }, revision: this.data.revision });
    }
    // ------------------------------------------------------------ Drawing
    showMessage(name, text) { this.message.hidden = false; this.message.replaceChildren(icon(name), el('div')); this.message.lastChild.textContent = text; }
    render() {
      const d = this.data, kind = this.kind, ready = this.status === 'ready';
      this.message.hidden = true;
      this.still.hidden = !(ready && kind === 'image');
      this.waveHost.hidden = !(ready && kind === 'audio');
      if (this.status === 'error') this.showMessage('alert', this.error);
      else if (ready && kind === 'image') { if (d.imageUrl || d.url) this.still.src = d.imageUrl || d.url; else this.showMessage('image', d.warning || 'No preview'); }
      else if (ready && kind === 'audio') this.openWave();
      else if (ready && kind === 'graphic') {
        if (d.url && /^afclip-graphic:/.test(d.url)) {
          const frame = el('iframe', 'source-graphic'); frame.sandbox = 'allow-scripts'; frame.src = d.url; this.host.replaceChildren(frame);
        } else this.showMessage('graphic', d.warning || 'No preview');
      } else if (ready && kind === 'video' && !d.url) this.showMessage('video', d.warning || 'No preview');
      this.renderLanes(); this.paintTime();
    }
    renderLanes() {
      this.lanes.replaceChildren(); this.blockEls = new Map(); this.blockByKey = new Map(); this.blocks = [];
      this.strip.hidden = !this.timed;
      if (!this.timed) return;
      const d = this.data, a = d.annotations, duration = this.duration;
      const place = (node, start, end) => {
        const s = Math.max(0, Math.min(start, duration)), e = Math.max(s, Math.min(end, duration));
        node.style.left = `${100 * s / duration}%`; node.style.width = `${100 * (e - s) / duration}%`;
      };
      const overview = el('div', 'source-lane source-overview');
      overview.tip = { title: 'Source', meta: `${this.format(0)} → ${this.format(duration)}`, hint: [{ keys: '#Click', text: 'jump' }, { keys: '#Drag', text: 'select range' }, { keys: '#Drag selection', text: 'insert into timeline' }, { keys: 'Shift', text: 'start a new selection' }] };
      overview.textContent = `${this.format(0)} · Drag to select · ${this.format(duration)}`;
      this.lanes.append(overview);
      const ranges = (a?.ranges || []).map(r => ({ type: 'range', key: `r:${r.id}`, start: num(r.start), end: num(r.end), name: r.name || 'Range', item: r, trackId: r.trackId ?? null }));
      const takes = (a?.takes || []).map((t, i) => ({ type: 'take', key: `t:${i}`, start: num(t.start), end: num(t.end), name: `Take ${i + 1}`, item: t }));
      const tracks = a?.tracks || [], known = new Set(tracks.map(t => t.id));
      const lanes = [];
      const loose = ranges.filter(r => !known.has(r.trackId));
      if (loose.length) lanes.push({ name: 'Ranges', blocks: loose });
      for (const t of tracks) { const list = ranges.filter(r => r.trackId === t.id); if (list.length) lanes.push({ name: t.name || 'Track', blocks: list.map(b => Object.assign(b, { track: t.name })) }); }
      if (takes.length) lanes.push({ name: 'Takes', blocks: takes });
      for (const lane of lanes) {
        const row = el('div', 'source-lane'); row.tip = { title: lane.name, follow: true };
        for (const b of lane.blocks) {
          const node = el('div', `source-block ${b.type}`); node.dataset.key = b.key;
          const label = el('span'); label.textContent = b.name; node.append(label);
          const tags = b.item.tags?.length ? b.item.tags.join(' · ') : null;
          node.tip = { title: b.name, desc: clip(b.type === 'take' ? b.item.text : b.item.notes) || null,
            meta: [`${this.format(b.start)} → ${this.format(b.end)}`, b.track ? `Track ${b.track}` : null, tags].filter(Boolean).join('\n') };
          place(node, b.start, b.end); row.append(node);
          this.blockEls.set(b.key, node); this.blockByKey.set(b.key, b);
        }
        this.lanes.append(row);
      }
      this.blocks = [...this.blockByKey.values()].sort((x, y) => x.start - y.start || x.end - y.end || x.key.localeCompare(y.key));
      this.rangeBand = el('div', 'source-sel');
      this.rangeHandle = el('div', 'source-range-drag');
      this.rangeHandle.draggable = true; this.rangeHandle.textContent = 'Drag selection';
      this.rangeHandle.ondragstart = e => this.startRangeDrag(e);
      this.rangeHandle.ondragend = () => this.callbacks.onDragEnd?.();
      overview.append(this.rangeHandle); this.lanes.append(this.rangeBand);
      this.head = el('div', 'source-head'); this.lanes.append(this.head);
      this.paintRange(); this.paintSelection();
    }
    paintRange() {
      const range = this.markedRange;
      for (const node of [this.rangeBand, this.rangeHandle]) {
        if (!node) continue;
        node.hidden = !range;
        if (range) {
          node.style.left = `${100 * range.start / this.duration}%`;
          node.style.width = `${100 * (range.end - range.start) / this.duration}%`;
        }
      }
      if (range && this.rangeHandle) this.rangeHandle.title = `${this.format(range.start)} → ${this.format(range.end)} · Drag into timeline. Shift+drag to select again.`;
    }
    // Waveform draws in parallel with playback; a failed decode only affects the picture.
    openWave() {
      if (this.wave) return;
      const id = this.media.id, api = this.api;
      this.wave = new window.AFClipAudioWaveform({
        container: this.waveHost, duration: this.duration, format: this.format, tips: 'tip',
        load: opts => api.sourceWaveform ? api.sourceWaveform(id, opts) : Promise.reject(new Error('Waveform is not available in this build')),
        onSeek: (t, phase) => this.waveSeek(t, phase),
        onSelectRange: (a, b, phase) => this.selectRange(a, b, phase),
        onClearRange: () => this.clearMarks(),
        getDragRange: () => this.markedRange,
        onDragStart: e => this.startRangeDrag(e), onDragEnd: () => this.callbacks.onDragEnd?.(),
      });
      this.wave.setTime(this.time); this.paintWaveRegions();
    }
    waveSeek(t, phase) {
      if (!this.timed) return;
      if (phase === 'start') { this.scrubResume = this.running; this.pause(); }
      if (phase === 'move') { this.time = t; this.paintTime(); return; }
      if (phase !== 'end') { void this.seek(t); return; }
      const resume = this.scrubResume, generation = this.generation; this.scrubResume = false;
      this.seek(t).then(() => { if (resume && generation === this.generation) this.play(); });
    }
    zoomWave(factor) { if (!this.wave) return false; if (factor) this.wave.zoomBy(factor); else this.wave.fit(); return true; }
    paintWaveRegions() {
      if (!this.wave) return;
      const sel = this.markedRange, b = this.selected;
      this.wave.setRegions([sel && { start: num(sel.start), end: num(sel.end), kind: 'selection' }, ...this.blocks.map(x => ({ start: x.start, end: x.end, kind: x.type }))].filter(Boolean)
        .concat(b ? [{ start: b.start, end: b.end, kind: 'selection' }] : []));
    }
    paintSelection() { for (const [key, node] of this.blockEls) node.classList.toggle('selected', key === this.selected?.key); this.paintWaveRegions(); }
    paintTime() {
      const p = this.duration ? Math.max(0, Math.min(1, this.time / this.duration)) : 0;
      if (this.head?.isConnected) this.head.style.left = `${100 * p}%`;
      this.wave?.setTime(this.time);
      this.callbacks.onTime?.(this.time);
    }
    emit() { this.callbacks.onState?.(this); }

    pointerDown(e) {
      if (e.button !== 0 || !this.timed) return;
      const node = e.target.closest('.source-block');
      if (node) { const b = this.blockByKey.get(node.dataset.key); if (b) this.select(b); return; }
      if (e.target.closest('.source-range-drag') && !e.shiftKey) return;
      e.preventDefault();
      this.pause();
      const generation = this.generation, origin = e.clientX;
      const at = x => { const r = this.lanes.getBoundingClientRect(); return Math.max(0, Math.min(1, (x - r.left) / Math.max(1, r.width))) * this.duration; };
      const start = at(origin);
      this.clearMarks();
      this.lanes.setPointerCapture(e.pointerId);
      void this.seek(start);
      const move = ev => {
        if (generation !== this.generation) return;
        if (Math.abs(ev.clientX - origin) >= 3) this.selectRange(start, at(ev.clientX), ev.type === 'pointermove' ? 'move' : 'end');
        void this.seek(at(ev.clientX));
      };
      const end = ev => {
        this.lanes.removeEventListener('pointermove', move);
        this.lanes.removeEventListener('pointerup', end);
        this.lanes.removeEventListener('pointercancel', end);
        if (ev.type === 'pointerup') move(ev);
        if (this.lanes.hasPointerCapture(e.pointerId)) this.lanes.releasePointerCapture(e.pointerId);
      };
      this.lanes.addEventListener('pointermove', move);
      this.lanes.addEventListener('pointerup', end);
      this.lanes.addEventListener('pointercancel', end);
    }
  };
})();
