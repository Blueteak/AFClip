'use strict';
// The mixed audio's media clock is the only playback clock. Picture may skip
// frames, but seeking and pause always ask for the selected project frame.
class TimelinePlayback {
  constructor(api, callbacks) {
    this.api = api; this.callbacks = callbacks;
    this.audio = new Audio(); this.audio.preload = 'auto';
    this.epoch = 0; this.generation = 0; this.time = 0;
    this.playing = false; this.wantsPlay = false; this.busy = false;
    api.onPreview(event => this.receive(event));
    this.audio.addEventListener('ended', () => {
      this.pause(false); this.seek(Math.max(0, Math.ceil(this.duration * this.fps - 1e-8) - 1) / this.fps);
    });
    this.audio.addEventListener('error', () => { if (this.sessionId) this.fail(new Error(this.audio.error?.message || 'Preview audio could not load')); });
  }
  setProject(project, mode) {
    if (this.revision === project.revision && this.projectId === project.id && this.mode === mode) return;
    // Folder organization does not change the picture or audio. Keep playback
    // alive when collapsing, renaming, grouping, or changing locks.
    const folderById = new Map((project.folders || []).map(f => [f.id, f]));
    const renderKey = JSON.stringify({ ...project, folders: undefined,
      tracks: project.tracks.map(t => ({ id: t.id, disabled: t.disabled || !!folderById.get(t.folderId)?.disabled })),
    }, (key, value) => {
      if (key === 'revision' || key === 'relationshipRevisions') return undefined;
      return value && typeof value === 'object' && !Array.isArray(value)
        ? Object.fromEntries(Object.keys(value).sort().map(k => [k, value[k]])) : value;
    });
    const keepOrganizationSession = this.ready && this.sessionId && this.renderKey === renderKey && this.mode === mode;
    this.renderKey = renderKey;
    if (keepOrganizationSession) {
      this.revision = project.revision;
      if (this.native) this.native.setup.project = project;
      return;
    }
    // Text and parameter overrides only affect existing iframes. Keep their DOM,
    // decoded video frames and audio instead of starting another preview worker.
    const textBaseKey = JSON.stringify({ ...project, clips: project.clips.map(c => ({ ...c, text: undefined, params: undefined, effects: c.effects?.map(e => ({ ...e, params: undefined })) })),
      transitions: project.transitions.map(t => ({ ...t, params: undefined })) }, (key, value) => {
      if (key === 'revision' || key === 'relationshipRevisions') return undefined;
      return value && typeof value === 'object' && !Array.isArray(value)
        ? Object.fromEntries(Object.keys(value).sort().map(k => [k, value[k]])) : value;
    });
    const keepTextSession = this.ready && this.native && this.sessionId && this.textBaseKey === textBaseKey && this.mode === mode;
    this.textBaseKey = textBaseKey;
    // Audio-only placement and envelope edits do not change source pictures.
    // Detached audio clips reference video media but never draw it.
    const audioMedia = new Set(project.media.filter(m => m.kind === 'audio').map(m => m.id));
    const visualClips = project.clips.filter(c => !audioMedia.has(c.mediaId) && c.stream !== 'audio');
    const visualIds = new Set(visualClips.map(c => c.id));
    const visualTransitions = project.transitions.filter(t => visualIds.has(t.fromClipId) || visualIds.has(t.toClipId));
    // An audio clip bordering a visual transition can determine its cut time.
    const boundaryIds = new Set(visualTransitions.flatMap(t => [t.fromClipId, t.toClipId]));
    const pictureClips = project.clips.filter(c => visualIds.has(c.id) || boundaryIds.has(c.id));
    const pictureTracks = new Set(pictureClips.map(c => c.trackId));
    const pictureMedia = new Set(pictureClips.map(c => c.mediaId));
    for(const tr of visualTransitions)pictureMedia.add(tr.assetId);
    for(const c of pictureClips)for(const effect of c.effects||[])pictureMedia.add(effect.assetId);
    const videoKey = JSON.stringify({ ...project,
      markers: [], folders: undefined,
      media: project.media.filter(m => pictureMedia.has(m.id)),
      tracks: project.tracks.filter(t => pictureTracks.has(t.id)).map(t => ({ id: t.id, disabled: t.disabled || !!folderById.get(t.folderId)?.disabled })),
      transitions: visualTransitions,
      clips: pictureClips.map(c => ({ ...c, linkId: undefined, volume: 1, mute: false, volumePoints: [], fadeIn: 0, fadeOut: 0 })),
    }, (key, value) => {
      if (key === 'revision' || key === 'relationshipRevisions') return undefined;
      // Engine patches and undo can reorder keys without changing the picture.
      return value && typeof value === 'object' && !Array.isArray(value)
        ? Object.fromEntries(Object.keys(value).sort().map(k => [k, value[k]])) : value;
    });
    const plan = window.AFClipTimeline.compile(project);
    // Mirror the mixer inputs, including transition handles and total silence
    // padding. Picture transforms, titles and video-only clips cannot dirty it.
    const audioKey = JSON.stringify({ duration: plan.duration, clips: plan.clips
      .filter(c => c.stream !== 'video' && c.media.metadata.hasAudio && !c.mute && c.volume !== 0)
      .map(c => ({ id: c.id, media: c.media, start: c.start, duration: c.duration,
        sourceIn: c.sourceIn, speed: c.speed, visibleStart: c.visibleStart, visibleEnd: c.visibleEnd,
        volume: c.volume ?? 1, volumePoints: c.volumePoints || [], fadeIn: c.fadeIn, fadeOut: c.fadeOut,
        transitions: c.transitions.map(t => ({ audio: t.audio, side: t.side, start: t.start, end: t.end, duration: t.duration, cut: t.cut })),
      })).sort((a, b) => a.id.localeCompare(b.id)) }, (key, value) =>
      value && typeof value === 'object' && !Array.isArray(value)
        ? Object.fromEntries(Object.keys(value).sort().map(k => [k, value[k]])) : value);
    const keepNative = this.prepared && this.sessionId && this.mode === mode && this.native?.canUpdate(project);
    const keepVideo = this.prepared && this.sessionId && this.mode === mode && (this.videoKey === videoKey || keepNative);
    const keepAudio = keepVideo && this.ready && this.audioKey === audioKey;
    this.audioKey = audioKey;
    this.videoKey = videoKey;
    if (keepTextSession) {
      this.pause(false);
      this.revision = project.revision;
      this.native.setup.project = project;
      this.native.setup.plan = window.AFClipTimeline.compile(project);
      for (const clip of this.native.setup.plan.clips) {
        const entry = this.native.entries.get(clip.id);
        if (entry) entry.clip = clip;
      }
      this.request(this.time, true);
      return;
    }
    this.pause(false); this.generation++; this.epoch++;
    if (!keepVideo) { this.native?.close(); this.native = null; }
    this.rejectReady?.(new Error('Preview replaced')); this.rejectReady = null;
    if (!keepVideo) { this.prepared = false; this.api.previewClose(); this.sessionId = null; this.audio.removeAttribute('src'); this.audio.load(); }
    this.audioDirty = !!keepVideo && !keepAudio;
    if (keepVideo && this.native) {
      this.native.setup.project = project;
      this.native.setup.plan = window.AFClipTimeline.compile(project);
      for (const clip of this.native.setup.plan.clips) {
        const entry = this.native.entries.get(clip.id);
        if (entry) entry.clip = clip;
      }
    }
    this.ready = !!keepAudio; this.opening = null; this.inFlight = false; this.busy = false;
    this.revision = project.revision; this.projectId = project.id; this.mode = mode;
    this.fps = project.fps.num / project.fps.den;
    this.duration = Math.max(0, ...project.clips.map(c => c.start.num / c.start.den + c.duration.num / c.duration.den));
    this.notify();
  }
  notify() { this.callbacks.state?.(this); }
  async previewTransform(clipId, key, value, expected) {
    this.transformDrafts ||= new Map();
    const draft = this.transformDrafts.get(clipId) || {};
    if (expected !== undefined && draft[key] !== expected && draft[key] !== undefined) return;
    if (value === undefined) delete draft[key]; else draft[key] = value;
    if (Object.keys(draft).length) this.transformDrafts.set(clipId, draft);
    else this.transformDrafts.delete(clipId);
    const version = this.transformPreviewVersion = (this.transformPreviewVersion || 0) + 1;
    this.pause(false);
    try {
      await this.ensure();
      if (version !== this.transformPreviewVersion || !this.native) return;
      const project = this.native.setup.project;
      // Preview a draft through the normal compositor; only the final value is
      // sent to the engine, keeping each gesture a single undoable edit.
      this.native.setup.plan = window.AFClipTimeline.compile({ ...project,
        clips: project.clips.map(c => this.transformDrafts.has(c.id)
          ? { ...c, transform: { ...c.transform, ...this.transformDrafts.get(c.id) } } : c),
      });
      for (const clip of this.native.setup.plan.clips) {
        const entry = this.native.entries.get(clip.id);
        if (entry) entry.clip = clip;
      }
      this.picture = null;
      this.previewPicture();
    } catch (error) { if (version === this.transformPreviewVersion) this.fail(error); }
  }
  async ensure() {
    if (this.ready) return;
    if (this.opening) return this.opening;
    const generation = this.generation;
    this.busy = true; this.notify();
    const ready = new Promise((resolve, reject) => { this.resolveReady = resolve; this.rejectReady = reject; });
    // Attach rejection immediately: replacing a project can happen during IPC.
    ready.catch(() => {});
    let timer;
    // A long project's source scans can exceed two minutes in total. Only fail
    // when the worker stops making progress, not while it finishes each source.
    const refreshTimeout = () => {
      if (generation !== this.generation) return;
      clearTimeout(timer);
      timer = setTimeout(() => { if (generation === this.generation) this.rejectReady?.(new Error('Preview preparation timed out')); }, 120000);
    };
    this.refreshPreparationTimeout = refreshTimeout; refreshTimeout();
    this.opening = (async () => {
      if (this.audioDirty) {
        const result = await this.api.previewAudio({ sessionId: this.sessionId, revision: this.revision });
        if (generation !== this.generation) return;
        if (result.revision !== this.revision) throw new Error('Project changed while updating audio');
        this.receive({ type: 'ready', sessionId: this.sessionId, audioUrl: result.audioUrl });
        await ready;
        return;
      }
      const session = await this.api.previewOpen(this.mode);
      if (generation !== this.generation) return;
      if (session.revision !== this.revision) throw new Error('Project changed while opening preview. Seek again to retry.');
      this.sessionId = session.id;
      await ready;
    })().finally(() => {
      clearTimeout(timer);
      if (this.refreshPreparationTimeout === refreshTimeout) this.refreshPreparationTimeout = null;
      if (generation === this.generation) this.opening = null;
    });
    return this.opening;
  }
  async seek(time, resume = this.wantsPlay) {
    this.audio.pause(); this.playing = false; cancelAnimationFrame(this.tickId);
    const epoch = ++this.epoch, generation = this.generation;
    this.wantsPlay = resume;
    this.time = Math.max(0, Math.min(time, Math.max(0, Math.ceil(this.duration * this.fps - 1e-8) - 1) / this.fps));
    this.busy = true; this.notify();
    try {
      // Picture does not depend on the mixed audio. Keep scrubbing responsive
      // while edits rebuild it, but wait for the new mix before playback starts.
      if (this.native && !this.ready) this.previewPicture();
      await this.ensure();
      if (epoch !== this.epoch || generation !== this.generation) return;
      this.audio.currentTime = this.time;
      this.request(this.time, true);
    } catch (error) { if (generation === this.generation && epoch === this.epoch) this.fail(error); }
  }
  previewPicture() {
    const native = this.native, epoch = this.epoch, generation = this.generation, time = this.time;
    if (this.picture?.key === this.videoKey && this.picture.event.time === time && this.picture.sessionId === this.sessionId) return;
    this.picture = null;
    native.seek(time).then(current => {
      if (!current || native !== this.native || epoch !== this.epoch || generation !== this.generation) return;
      const event = { native: true, time, revision: this.revision };
      this.picture = { key: this.videoKey, sessionId: this.sessionId, event };
      this.callbacks.frame?.(event);
    }).catch(error => { if (native === this.native && epoch === this.epoch && generation === this.generation) this.fail(error); });
  }
  play(time) {
    if (!this.duration) return;
    if (time >= (Math.ceil(this.duration * this.fps - 1e-8) - 1) / this.fps) time = 0;
    return this.seek(time, true);
  }
  pause(render = true) {
    const wasRunning = this.playing;
    if (wasRunning) this.time = Math.floor(this.audio.currentTime * this.fps + 1e-7) / this.fps;
    this.audio.pause(); this.playing = false; this.wantsPlay = false; this.busy = false; this.epoch++;
    this.native?.pause();
    cancelAnimationFrame(this.tickId); this.notify();
    if (wasRunning) this.callbacks.time?.(this.time);
    if (render && this.duration) this.seek(this.time, false);
  }
  request(time, force = false) {
    if (!this.ready || (!force && this.inFlight)) return;
    this.inFlight = true;
    // Reusing a paused picture avoids seeking/repainting for audio-only edits.
    // Playback still needs native.seek(..., true) to prepare original decoders.
    if (!this.wantsPlay && this.picture?.key === this.videoKey && this.picture.sessionId === this.sessionId && this.picture.event.time === time) {
      this.receive({ ...this.picture.event, type: 'frame', epoch: this.epoch, sessionId: this.sessionId, revision: this.revision });
      return;
    }
    this.picture = null;
    if (this.native) {
      const epoch = this.epoch, sessionId = this.sessionId;
      this.native.seek(time, this.wantsPlay).then(current => { if (current) this.receive({ type: 'frame', native: true, time, epoch, sessionId, revision: this.revision }); }).catch(error => { if (sessionId === this.sessionId && epoch === this.epoch) this.fail(error); });
      return;
    }
    this.api.previewFrame({ sessionId: this.sessionId, epoch: this.epoch, time });
  }
  tick() {
    if (!this.playing) return;
    this.time = this.audio.currentTime;
    this.callbacks.time?.(this.time);
    if (this.native) {
      this.picture = null;
      this.native.update(this.time);
      this.callbacks.frame?.({ native: true, time: this.time, revision: this.revision });
      this.tickId = requestAnimationFrame(() => this.tick()); return;
    }
    const frame = Math.min(Math.floor(this.time * this.fps + 1e-7), Math.ceil(this.duration * this.fps - 1e-8) - 1);
    if (frame !== this.lastRequestedFrame) {
      if (!this.inFlight) { this.lastRequestedFrame = frame; this.request(frame / this.fps); }
    }
    this.tickId = requestAnimationFrame(() => this.tick());
  }
  async receive(event) {
    if (event.sessionId !== this.sessionId) return;
    if (event.type === 'progress') { this.refreshPreparationTimeout?.(); return; }
    if (event.type === 'seek-cache') {
      if (event.seekProxy && this.native?.setup.media[event.mediaId]) this.native.setup.media[event.mediaId].seekProxy = event.seekProxy;
      if (event.seekCache && this.native) this.native.setup.seekCache = event.seekCache;
      return;
    }
    if (event.type === 'error') { this.rejectReady?.(new Error(event.error.message)); this.fail(new Error(event.error.message)); return; }
    if (event.type === 'picture-ready') {
      this.native = new window.NativePreview(event.nativeSetup, document.getElementById('native-preview'), error => this.fail(error));
      this.previewPicture();
      this.refreshPreparationTimeout?.();
      return;
    }
    if (event.type === 'ready') {
      this.prepared = true;
      if (event.nativeSetup) this.native = new window.NativePreview(event.nativeSetup, document.getElementById('native-preview'), error => this.fail(error));
      const generation = this.generation;
      this.audio.onloadedmetadata = () => {
        if (generation !== this.generation) return;
        this.ready = true; this.audioDirty = false; this.resolveReady?.(); this.rejectReady = null;
      };
      if (event.audioUrl) this.audio.src = event.audioUrl;
      else { this.ready = true; this.audioDirty = false; this.resolveReady?.(); this.rejectReady = null; }
      return;
    }
    if (event.type !== 'frame' || event.epoch !== this.epoch) return;
    this.picture = { key: this.videoKey, sessionId: this.sessionId, event };
    this.inFlight = false; this.busy = false;
    if (!this.playing || this.audio.currentTime - event.time < .25) this.callbacks.frame?.(event);
    if (this.wantsPlay && !this.playing) {
      const epoch = this.epoch;
      try {
        await this.audio.play();
        if (epoch !== this.epoch) return;
        this.playing = true; this.lastRequestedFrame = -1; this.tick();
      } catch (error) { if (epoch === this.epoch) this.fail(error); }
    }
    this.notify();
  }
  fail(error) {
    this.generation++; this.rejectReady?.(error); this.rejectReady = null; this.opening = null;
    this.pause(false); this.busy = false; this.ready = false; this.inFlight = false;
    this.native?.close(); this.native = null;
    this.api.previewClose(); this.sessionId = null; this.audio.removeAttribute('src'); this.audio.load();
    this.notify(); this.callbacks.error?.(error);
  }
}
window.TimelinePlayback = TimelinePlayback;
