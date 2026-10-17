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
    this.pause(false); this.generation++; this.epoch++;
    this.native?.close(); this.native = null;
    this.rejectReady?.(new Error('Preview replaced')); this.rejectReady = null;
    this.api.previewClose();
    this.sessionId = null; this.ready = false; this.opening = null; this.inFlight = false; this.busy = false;
    this.audio.removeAttribute('src'); this.audio.load();
    this.revision = project.revision; this.projectId = project.id; this.mode = mode;
    this.fps = project.fps.num / project.fps.den;
    this.duration = Math.max(0, ...project.clips.map(c => c.start.num / c.start.den + c.duration.num / c.duration.den));
    this.notify();
  }
  notify() { this.callbacks.state?.(this); }
  async ensure() {
    if (this.ready) return;
    if (this.opening) return this.opening;
    const generation = this.generation;
    this.busy = true; this.notify();
    const ready = new Promise((resolve, reject) => { this.resolveReady = resolve; this.rejectReady = reject; });
    // Attach rejection immediately: replacing a project can happen during IPC.
    ready.catch(() => {});
    const timer = setTimeout(() => this.rejectReady?.(new Error('Preview preparation timed out')), 120000);
    this.opening = (async () => {
      const session = await this.api.previewOpen(this.mode);
      if (generation !== this.generation) return;
      if (session.revision !== this.revision) throw new Error('Project changed while opening preview. Seek again to retry.');
      this.sessionId = session.id;
      await ready;
    })().finally(() => { clearTimeout(timer); if (generation === this.generation) this.opening = null; });
    return this.opening;
  }
  async seek(time, resume = this.wantsPlay) {
    this.audio.pause(); this.playing = false; cancelAnimationFrame(this.tickId);
    this.native?.pause();
    const epoch = ++this.epoch, generation = this.generation;
    this.wantsPlay = resume;
    this.time = Math.max(0, Math.min(time, Math.max(0, Math.ceil(this.duration * this.fps - 1e-8) - 1) / this.fps));
    this.busy = true; this.notify();
    try {
      await this.ensure();
      if (epoch !== this.epoch || generation !== this.generation) return;
      this.audio.currentTime = this.time;
      this.request(this.time, true);
    } catch (error) { if (generation === this.generation && epoch === this.epoch) this.fail(error); }
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
    if (this.native) {
      const epoch = this.epoch, sessionId = this.sessionId;
      this.native.seek(time).then(current => { if (current) this.receive({ type: 'frame', native: true, time, epoch, sessionId, revision: this.revision }); }).catch(error => { if (sessionId === this.sessionId && epoch === this.epoch) this.fail(error); });
      return;
    }
    this.api.previewFrame({ sessionId: this.sessionId, epoch: this.epoch, time });
  }
  tick() {
    if (!this.playing) return;
    this.time = this.audio.currentTime;
    this.callbacks.time?.(this.time);
    if (this.native) {
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
    if (event.type === 'error') { this.rejectReady?.(new Error(event.error.message)); this.fail(new Error(event.error.message)); return; }
    if (event.type === 'ready') {
      if (event.nativeSetup) this.native = new window.NativePreview(event.nativeSetup, document.getElementById('native-preview'), error => this.fail(error));
      const generation = this.generation;
      this.audio.onloadedmetadata = () => {
        if (generation !== this.generation) return;
        this.ready = true; this.resolveReady?.(); this.rejectReady = null;
      };
      if (event.audioUrl) this.audio.src = event.audioUrl;
      else { this.ready = true; this.resolveReady?.(); this.rejectReady = null; }
      return;
    }
    if (event.type !== 'frame' || event.epoch !== this.epoch) return;
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
