'use strict';
// Sound generation on the timeline. Hold G and drag on an empty track to mark a range, then describe it.
// The engine owns jobs, takes and placeholder clips; this module draws the range, the popup and the take picker.
window.AFClipGeneration = host => {
  const { api, h, icon, kbd } = host;
  const TYPES = { music: { label: 'Music', min: 3, max: 600 }, sfx: { label: 'SFX', min: .5, max: 30 }, speech: { label: 'Speech', min: 0, max: Infinity } };
  const TYPE_TIPS = { music: 'Music for the range. 3 s to 10 min.', sfx: 'A sound effect. 0.5 to 30 s.', speech: 'Spoken dialogue in the chosen voice. The range is the intended window.' };
  const store = (() => {
    const base = { type: 'sfx', voiceId: '' };
    try { return { ...base, ...JSON.parse(localStorage.getItem('afclip.generation') || '{}') }; } catch { return base; }
  })();
  const saveStore = () => localStorage.setItem('afclip.generation', JSON.stringify(store));

  let armed = false, pop = null, voices = null, voicesLoading = null, voicesError = null, frame = 0, sample = null;
  const PHASES = { request: 'Generating', video: 'Preparing video' };
  const phaseLabel = job => PHASES[job?.phase] || 'Generating';
  const statuses = new Map();
  const jobs = () => host.snapshot()?.generations || [];
  const jobOf = c => c && jobs().find(j => j.clipId === c.id || (c.generationId && j.id === c.generationId)) || null;
  const jobFor = clipId => jobOf(host.clipById(clipId));
  const fpsNow = () => host.fps();
  const minF = type => type === 'speech' ? 1 : Math.ceil(TYPES[type].min * fpsNow() - 1e-6);
  const maxF = type => Number.isFinite(TYPES[type].max) ? Math.floor(TYPES[type].max * fpsNow() + 1e-6) : Infinity;
  const sameF = (a, b) => a.num * b.den === b.num * a.den;
  // The empty stretch around frame `f` on a track, ignoring `skip` (a clip id).
  function room(trackId, f, skip) {
    const list = host.clipsOn(trackId).filter(c => c.id !== skip);
    const inside = list.find(c => host.startF(c) <= f && f < host.endF(c));
    if (inside) return null;
    return { lo: Math.max(0, ...list.map(host.endF).filter(x => x <= f)), hi: Math.min(Infinity, ...list.map(host.startF).filter(x => x > f)) };
  }

  // ------------------------------------------------------------ G key
  const typing = el => el?.closest?.('input, textarea, select, [contenteditable]');
  function setArmed(on) {
    if (armed === on) return;
    armed = on;
    document.body.classList.toggle('gen-armed', on);
    if (on) host.flashHint([{ keys: ['G', '#Drag'], text: 'generate sound on an empty track' }], 2500);
  }
  document.addEventListener('keydown', e => {
    // The held key keeps repeating after the popup takes focus; swallow it until keyup.
    if (e.code === 'KeyG' && armed) { e.preventDefault(); e.stopImmediatePropagation(); return; }
    if (e.code === 'KeyG' && !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey && !typing(e.target) && !host.blocked()) { setArmed(true); e.preventDefault(); }
  }, true);
  document.addEventListener('keyup', e => { if (e.code === 'KeyG') setArmed(false); }, true);
  addEventListener('blur', () => setArmed(false));

  // ------------------------------------------------------------ Range drag
  // Called from the lane pointerdown. Returns true when the gesture is ours.
  function begin(e, lane) {
    const handle = e.target.closest('.gen-ghost.held .handle');
    if (handle && pop?.draft) { beginResize(e, handle.classList.contains('l') ? 'l' : 'r'); return true; }
    if (!armed || !lane?.dataset.track) return false;
    const trackId = lane.dataset.track;
    e.preventDefault();
    if (!host.editable()) return true;
    const why = host.blockReason(trackId); if (why) { host.say(why, 'warn'); return true; }
    let f = Math.max(0, host.laneFrame(e.clientX));
    const gap = room(trackId, f); if (!gap) return true;
    const targets = host.snapTargets();
    f += host.snapFrame([f], targets, e);
    f = Math.max(gap.lo, Math.min(gap.hi, f));
    const ghost = h('div', { class: 'gen-ghost' });
    lane.append(ghost);
    const d = { type: 'generate', trackId, f0: f, s: f, e: f, gap, targets, line: ghost, moved: false };
    host.startDrag(d);
    paintGhost(ghost, f, f);
    host.hintItems([{ keys: 'Alt', text: 'bypass snapping' }, { keys: 'Escape', text: 'cancel' }]);
    return true;
  }
  // Draft edges move within the gap on their own track. The popup stays open; Escape restores the range.
  function beginResize(e, edge) {
    e.preventDefault();
    if (!host.editable()) return;
    const dr = pop.draft, gap = room(dr.trackId, dr.s) || dr.gap;
    const d = { type: 'generate', resize: edge, s0: dr.s, e0: dr.e, gap, targets: host.snapTargets() };
    pop.resize = d;
    host.startDrag(d);
    host.hintItems([{ keys: 'Alt', text: 'bypass snapping' }, { keys: 'Escape', text: 'cancel' }]);
  }
  function resizeMove(e, d) {
    if (!pop?.draft || pop.resize !== d) return;
    const dr = pop.draft;
    let f = host.laneFrame(e.clientX);
    f += host.snapFrame([f], d.targets, e);
    if (d.resize === 'l') dr.s = f = Math.max(d.gap.lo, Math.min(dr.e - 1, f));
    else dr.e = f = Math.min(d.gap.hi, Math.max(dr.s + 1, f));
    dr.gap = d.gap;
    if (pop.ghost) paintGhost(pop.ghost, dr.s, dr.e);
    render();
    host.readout(`${host.tc(dr.s)}   ${host.shortTc(dr.e - dr.s)}`, f === d.gap.hi || f === d.gap.lo && d.gap.lo > 0 ? 'Limited by neighbouring clip' : '');
  }
  function dragCancel(d) {
    if (!d.resize || !pop?.draft || pop.resize !== d) return;
    pop.resize = null; pop.draft.s = d.s0; pop.draft.e = d.e0;
    render();
  }
  function dragMove(e, d) {
    if (d.resize) { resizeMove(e, d); return; }
    let f = host.laneFrame(e.clientX);
    f += host.snapFrame([f], d.targets, e);
    f = Math.max(d.gap.lo, Math.min(d.gap.hi, f));
    d.s = Math.min(d.f0, f); d.e = Math.max(d.f0, f);
    if (d.e > d.s) d.moved = true;
    paintGhost(d.line, d.s, d.e);
    host.readout(`${host.tc(d.s)}   ${host.shortTc(d.e - d.s)}`, f === d.gap.hi || f === d.gap.lo && d.gap.lo > 0 ? 'Limited by neighbouring clip' : '');
  }
  async function dragEnd(d) {
    if (d.resize) { if (pop?.resize === d) { pop.resize = null; render(); } return; }
    let { s, e } = d;
    // A click without a drag asks for a default length that fits the gap.
    if (e <= s) e = Math.min(d.gap.hi, s + Math.round(5 * fpsNow()));
    if (e <= s) return;
    let configured = false;
    try { configured = !!(await api.apiKeys('get'))?.elevenlabs?.configured; } catch {}
    if (!configured) {
      host.say('ElevenLabs API key needed', 'warn');
      host.flashHint([{ text: 'ElevenLabs API key needed' }, { text: 'Edit › AI settings…' }]);
      return;
    }
    openDraft({ trackId: d.trackId, s, e, gap: d.gap });
  }
  function paintGhost(el, s, e) { el.style.left = `${host.frameX(s)}px`; el.style.width = `${Math.max(2, host.frameX(e - s))}px`; }

  // ------------------------------------------------------------ Popup
  function openDraft(draft) {
    build({ draft, type: store.type in TYPES ? store.type : 'sfx', text: '', voiceId: store.voiceId, addVideo: false, refreshVideo: false });
    render(); host.redraw();
    setTimeout(() => pop?.textarea.focus(), 0);
  }
  function open(clipId, { focus = true } = {}) {
    const c = host.clipById(clipId), job = jobOf(c); if (!c || !job) return false;
    if (pop?.clipId === clipId) { if (focus) pop.textarea.focus(); return true; }
    const s = job.settings || {};
    build({ clipId, type: s.type in TYPES ? s.type : 'sfx', text: s.text || '', voiceId: s.voiceId || store.voiceId, addVideo: !!s.addVideo, refreshVideo: false });
    render(); host.redraw();
    if (focus) setTimeout(() => (job.takes?.length ? pop?.takes : pop?.textarea)?.focus(), 0);
    return true;
  }
  function close() {
    if (!pop) return;
    const wasDraft = !!pop.draft;
    stopSample();
    pop.el.remove(); pop = null;
    if (wasDraft) host.redraw();
  }
  function build(state) {
    if (pop) pop.el.remove();
    stopSample();
    host.hideTip();
    const head = h('div', { class: 'popover-heading agent-head gen-head' });
    const note = h('div', { class: 'agent-error', hidden: true });
    const options = h('div', { class: 'gen-options' });
    const takes = h('div', { class: 'gen-takes', tabindex: '0', role: 'listbox', 'aria-label': 'Takes', hidden: true });
    const textarea = h('textarea', { class: 'agent-input', rows: 3, spellcheck: 'true' });
    const send = h('button', { class: 'icon-button agent-send', onclick: () => generate() }, icon('send'));
    const label = h('div', { class: 'gen-label' });
    const composer = h('div', { class: 'agent-composer' }, label, h('div', { class: 'agent-input-row' }, textarea, send));
    const actions = h('div', { class: 'popover-actions gen-actions', hidden: true });
    const el = h('div', { class: 'marker-popover agent-popover gen-popover', role: 'dialog', 'aria-label': 'Generate sound' }, head, note, options, takes, composer, actions);
    pop = { ...state, el, head, note, options, takes, textarea, label, send, actions, sig: {}, keyConfigured: null };
    voicesError = null;
    textarea.value = state.text;
    textarea.oninput = () => { pop.text = textarea.value; grow(); canSend(); };
    textarea.onkeydown = e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); generate(); } };
    takes.onkeydown = e => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); stepTake(e.key === 'ArrowDown' ? 1 : -1); }
      else if (e.key === 'Enter') { e.preventDefault(); accept(); }
      else if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); remove(); }
    };
    el.addEventListener('keydown', e => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); return; }
      if ((e.ctrlKey || e.metaKey) && e.code === 'Space') { e.preventDefault(); e.stopPropagation(); host.togglePlay(); return; }
      e.stopPropagation();
    });
    el.style.left = `${Math.max(10, innerWidth / 2 - 180)}px`; el.style.top = `${Math.max(10, innerHeight / 2 - 160)}px`;
    document.body.append(el);
    grow();
    api.apiKeys('get').then(all => { if (pop?.el === el) { pop.keyConfigured = !!all?.elevenlabs?.configured; render(); } }, () => {});
  }
  function grow() {
    const t = pop.textarea;
    t.style.height = 'auto';
    const full = t.scrollHeight + 2;
    t.style.height = `${Math.min(140, full)}px`; t.style.overflowY = full > 140 ? 'auto' : 'hidden';
  }
  const once = (key, sig, paint) => { const s = JSON.stringify(sig); if (pop.sig[key] === s) return; pop.sig[key] = s; paint(); };

  // Current view of the popup's job, clip and range in frames.
  function view() {
    if (pop.draft) { const d = pop.draft; return { trackId: d.trackId, s: d.s, e: d.e, job: null, clip: null }; }
    const c = host.clipById(pop.clipId), job = jobOf(c);
    return c && job ? { trackId: c.trackId, s: host.startF(c), e: host.endF(c), job, clip: c } : null;
  }
  const selectedTake = v => v.job?.takes?.find(t => t.previewMediaId === v.clip?.mediaId) || null;
  // Add Video needs picture for the whole range.
  function videoCovered(s, e) {
    const visual = host.clips().filter(c => host.clipVisual(c) && !host.disabledTrack(c.trackId));
    if (!visual.length) return false;
    return s >= Math.min(...visual.map(host.startF)) && e <= Math.max(...visual.map(host.endF));
  }
  function problem(v) {
    if (pop.keyConfigured === false) return 'ElevenLabs API key needed';
    if (!pop.text.trim()) return pop.type === 'speech' ? 'Type the dialogue' : 'Describe the sound';
    if (pop.type === 'speech' && !pop.voiceId) return 'Choose a voice';
    if (v.job?.status === 'generating') return 'Already generating';
    const len = v.e - v.s;
    if (pop.type !== 'speech' && (len < minF(pop.type) || len > maxF(pop.type))) return `${TYPES[pop.type].label} needs ${TYPES[pop.type].min} to ${TYPES[pop.type].max} s`;
    if (pop.addVideo && pop.type === 'music' && (!v.job?.snapshot || pop.refreshVideo) && !videoCovered(v.s, v.e)) return 'No video under the whole range';
    return null;
  }
  function canSend() {
    const v = pop && view(); if (!v) return;
    const why = problem(v), label = !v.job ? 'Generate' : v.job.status === 'failed' ? 'Retry' : 'Generate another';
    pop.send.disabled = !!why || pop.busy;
    pop.send.tip = { title: label, keys: 'Enter', desc: why || 'Shift+Enter adds a line.' };
  }

  function render() {
    if (!pop) return;
    const v = view();
    if (!v) { close(); return; }
    renderHead(v); renderNote(v); renderOptions(v); renderTakes(v); renderActions(v);
    pop.label.textContent = pop.type === 'speech' ? 'Dialogue' : 'Description';
    pop.textarea.setAttribute('aria-label', pop.label.textContent);
    pop.textarea.placeholder = pop.type === 'speech' ? 'What is said' : pop.type === 'music' ? 'Style, mood, instruments' : 'What it sounds like';
    canSend(); position();
  }
  function renderHead(v) {
    const st = v.job?.status || 'draft';
    const len = v.e - v.s;
    once('head', [pop.type, st, v.job?.phase, v.job?.takes?.length, len], () => {
      const seg = h('select', { class: 'gen-type', 'aria-label': 'Type', onchange: e => setType(e.target.value) }, Object.entries(TYPES).map(([id, t]) => h('option', { value: id }, t.label)));
      seg.value = pop.type;
      seg.tip = { title: TYPES[pop.type].label, desc: TYPE_TIPS[pop.type] };
      const status = st === 'generating' ? h('span', { class: 'agent-status running' }, phaseLabel(v.job))
        : st === 'failed' ? h('span', { class: 'agent-status error' }, 'Failed')
        : st === 'ready' ? h('span', { class: 'agent-status' }, `${v.job.takes?.length || 0} take${v.job.takes?.length === 1 ? '' : 's'}`) : null;
      // Draft length changes by dragging the range edges; a submitted job keeps its length.
      const dur = h('span', { class: 'field-static gen-len' }, host.shortTc(len));
      dur.tip = { title: pop.type === 'speech' ? 'Window' : 'Duration', desc: v.job ? 'Fixed for every take of this generation.' : 'Drag the range edges to change.' };
      pop.head.replaceChildren(...[h('span', { class: 'gen-types' }, seg), h('span', { class: 'grow' }), status, dur,
        h('button', { class: 'icon-button small', onclick: () => close(), tip: { title: 'Close', keys: 'Escape', desc: v.job ? 'Generation keeps running.' : 'Discards the range.' } }, icon('x'))].filter(Boolean));
    });
  }
  function renderNote(v) {
    const err = v.job?.status === 'failed' ? v.job.error?.message || 'Generation failed' : '';
    once('note', [pop.keyConfigured, err], () => {
      const n = pop.note;
      if (pop.keyConfigured === false) {
        n.hidden = false; n.className = 'agent-error gen-hint';
        n.replaceChildren(icon('alert', 'sm'), h('span', {}, 'ElevenLabs API key needed. ', h('button', { class: 'link-button', onclick: () => host.openSettings('keys') }, 'AI settings')));
      } else if (err) { n.hidden = false; n.className = 'agent-error'; n.replaceChildren(icon('alert', 'sm'), h('span', {}, err)); }
      else n.hidden = true;
    });
  }
  function renderOptions(v) {
    const covered = videoCovered(v.s, v.e), snap = !!v.job?.snapshot;
    once('options', [pop.type, pop.voiceId, pop.addVideo, pop.refreshVideo, covered, snap, !!voices, voicesError, !!voicesLoading], () => {
      if (pop.options.contains(document.activeElement) && document.activeElement.matches('input, select')) { pop.sig.options = ''; return; }
      // A saved snapshot stays usable after the clip moves; new captures need video under the range.
      const music = pop.type === 'music', ok = music && (covered || snap);
      const video = h('label', { class: `gen-check ${ok ? '' : 'disabled'}` }, h('input', { type: 'checkbox', checked: ok && pop.addVideo, disabled: !ok, onchange: e => { pop.addVideo = e.target.checked; render(); } }), 'Add video');
      video.tip = { title: 'Add video', desc: !music ? 'Music only.' : !ok ? 'Needs video under the whole range.' : 'Sends a silent low-resolution snapshot of the timeline under the range as a reference.' };
      const refresh = snap && ok && pop.addVideo ? h('label', { class: `gen-check ${covered ? '' : 'disabled'}` }, h('input', { type: 'checkbox', checked: covered && pop.refreshVideo, disabled: !covered, onchange: e => { pop.refreshVideo = e.target.checked; render(); } }), 'Refresh snapshot') : null;
      if (refresh) refresh.tip = { title: 'Refresh snapshot', desc: covered ? 'Capture the timeline again. Off reuses the earlier snapshot.' : 'Needs video under the whole range. The earlier snapshot is reused.' };
      let voice = null;
      if (pop.type === 'speech') voice = voicePicker();
      pop.options.replaceChildren(h('div', { class: 'gen-checks' }, video, refresh, voice));
    });
  }
  function voicePicker() {
    const s = h('select', { onchange: () => { pop.voiceId = s.value; store.voiceId = s.value; saveStore(); stopSample(); paintSample(); render(); } });
    s.tip = { title: 'Voice', desc: 'ElevenLabs voice. Remembered for the next generation.' };
    if (!voices) {
      s.append(h('option', { value: '' }, voicesError ? 'Voices unavailable' : 'Loading voices…'));
      s.disabled = true;
      if (!voicesError) { loadVoices(); return s; }
      const retry = h('button', { class: 'icon-button small', onclick: () => { voicesError = null; pop.sig.options = ''; render(); }, tip: { title: 'Retry', desc: voicesError } }, icon('restore', 'sm'));
      return h('span', { class: 'gen-voice' }, s, retry);
    }
    s.append(h('option', { value: '', disabled: true }, 'Choose a voice'), ...voices.map(x => h('option', { value: x.id }, x.name)));
    if (pop.voiceId && !voices.some(x => x.id === pop.voiceId)) s.append(h('option', { value: pop.voiceId }, 'Saved voice'));
    if (!pop.voiceId && voices[0]) { pop.voiceId = voices[0].id; }
    s.value = pop.voiceId || '';
    pop.sampleButton = h('button', { class: 'icon-button small', onclick: toggleSample });
    paintSample();
    return h('span', { class: 'gen-voice' }, s, pop.sampleButton);
  }
  // Plays the voice's stored ElevenLabs sample. Never synthesizes speech.
  const sampleUrl = () => voices?.find(x => x.id === pop?.voiceId)?.previewUrl || '';
  function paintSample() {
    const b = pop?.sampleButton; if (!b) return;
    const on = !!sample, url = sampleUrl();
    b.disabled = !on && !url;
    b.replaceChildren(icon(on ? 'stop' : 'volume', 'sm'));
    b.setAttribute('aria-label', on ? 'Stop sample' : 'Play sample');
    b.tip = { title: on ? 'Stop sample' : 'Play sample', desc: url ? 'Stored ElevenLabs sample. No credits used.' : 'No sample for this voice.' };
  }
  function stopSample() {
    const a = sample; if (!a) return;
    sample = null;
    a.onended = a.onerror = null; a.pause(); a.removeAttribute('src'); a.load();
    paintSample();
  }
  function toggleSample() {
    if (sample) { stopSample(); return; }
    const url = sampleUrl(); if (!url) return;
    const a = sample = new Audio(url);
    const fail = () => { if (sample !== a) return; stopSample(); host.say('Voice sample unavailable', 'error'); };
    a.onended = () => { if (sample === a) stopSample(); };
    a.onerror = fail;
    a.play().catch(error => { if (error?.name !== 'AbortError') fail(); });
    paintSample();
  }
  // Loads every page once. A failure stays shown until Retry or the popup reopens.
  function loadVoices() {
    if (voicesLoading || voicesError || pop?.keyConfigured === false) return;
    voicesLoading = (async () => {
      const all = [];
      let token;
      for (let page = 0; page < 50; page++) {
        const res = await api.command({ command: 'generation-voices', ...(token ? { nextPageToken: token } : {}) });
        all.push(...(res?.voices || []));
        token = res?.nextPageToken;
        if (!token) break;
      }
      voices = all;
    })().catch(error => { voicesError = host.explain(error); host.say(voicesError, 'error'); })
      .finally(() => { voicesLoading = null; if (pop) { pop.sig.options = ''; render(); } });
  }
  function renderTakes(v) {
    const list = v.job?.takes || [], cur = selectedTake(v), busy = v.job?.status === 'generating';
    once('takes', [list.map(t => t.id), cur?.id, busy, v.job?.phase], () => {
      pop.takes.hidden = !list.length && !busy;
      const rows = list.map((t, i) => {
        const on = t === cur, over = t.duration && v.clip && host.secs(t.duration) > host.secs(v.clip.duration) + 1e-6;
        const b = h('button', { class: `annotation-item gen-take ${on ? 'selected' : ''}`, role: 'option', 'aria-selected': String(on), tabindex: '-1', onclick: () => { pickTake(t); pop.takes.focus(); } },
          h('span', { class: `swatch ${t.type}` }), h('span', { class: 'label' }, `${i + 1} · ${(t.text || '').replace(/\s+/g, ' ')}`),
          h('span', { class: `when ${over ? 'over' : ''}` }, t.duration ? host.shortTc(host.toF(t.duration)) : ''));
        b.tip = { title: `Take ${i + 1} · ${TYPES[t.type]?.label || t.type}`, desc: t.text, meta: over ? 'Longer than the clip' : null, hint: [{ keys: ['Up', 'Down'], text: 'select and hear' }, { keys: 'Enter', text: 'accept' }] };
        return b;
      });
      if (busy) rows.push(h('div', { class: 'annotation-item gen-take pending' }, h('span', { class: 'swatch' }), h('span', { class: 'label' }, phaseLabel(v.job)), h('span', { class: 'agent-working' }, h('i'), h('i'), h('i'))));
      pop.takes.replaceChildren(...rows);
      pop.takes.querySelector('.selected')?.scrollIntoView({ block: 'nearest' });
    });
  }
  // Speech longer than its slot extends into free room after it, or must move or regenerate.
  function acceptPlan(v) {
    const t = selectedTake(v);
    if (!t) return { why: 'Select a take' };
    if (v.job.status === 'generating') return { why: 'Wait for the generation to finish' };
    // Exact seconds decide overflow; the extension rounds up to whole frames so no word is cut.
    if (t.type !== 'speech' || !t.duration || host.secs(t.duration) <= host.secs(v.clip.duration) + 1e-9) return { extend: false };
    const need = Math.ceil(host.secs(t.duration) * fpsNow() - 1e-9);
    const gap = room(v.trackId, v.s, v.clip.id);
    if (gap && gap.hi - v.s >= need) return { extend: true };
    return { why: 'The line runs past the slot and the next clip blocks extending. Move the clip or regenerate.' };
  }
  function renderActions(v) {
    if (!v.job) { pop.actions.hidden = true; return; }
    const plan = acceptPlan(v);
    once('actions', [plan, v.job.takes?.length], () => {
      pop.actions.hidden = false;
      const ok = !plan.why;
      const b = h('button', { class: 'btn primary', disabled: !ok, onclick: () => accept() }, icon('check', 'sm'), plan.extend ? 'Accept and extend' : 'Accept', kbd('Enter'));
      b.tip = { title: 'Accept take', desc: plan.why || (plan.extend ? 'Extends the clip to fit the line. Other takes are discarded.' : 'Becomes a normal clip. Other takes are discarded.') };
      pop.actions.replaceChildren(h('button', { class: 'popover-delete', onclick: () => remove(), tip: { title: 'Delete clip', desc: 'Undo restores it.', keys: 'Delete' } }, 'Delete', kbd('Delete')), h('span', { class: 'grow' }), b);
    });
  }
  function setType(type) {
    if (pop.type === type) return;
    stopSample();
    pop.type = type; store.type = type; saveStore();
    if (type !== 'music') pop.addVideo = false;
    render();
    pop.textarea.focus();
  }

  // ------------------------------------------------------------ Commands
  async function generate() {
    if (!pop || pop.busy) return;
    const v = view(); if (!v || problem(v)) { canSend(); return; }
    const target = pop, type = pop.type;
    const settings = { type, text: pop.text.trim(), ...(type === 'speech' ? { voiceId: pop.voiceId } : {}), ...(type === 'music' ? { addVideo: !!pop.addVideo } : {}) };
    const before = new Set(jobs().map(j => j.id));
    const payload = { command: 'generation-start', trackId: v.trackId, start: host.fromF(v.s), duration: host.fromF(v.e - v.s), ...settings,
      ...(v.clip ? { clipId: v.clip.id, ...(settings.addVideo && v.job.snapshot && pop.refreshVideo ? { refreshVideo: true } : {}) } : {}) };
    target.busy = true; canSend();
    const result = await host.perform(() => api.command(payload), v.clip ? `Generating another ${TYPES[type].label.toLowerCase()} take` : `Generating ${TYPES[type].label.toLowerCase()}`);
    target.busy = false;
    if (pop !== target) return;
    if (!result) { canSend(); return; }
    if (target.draft) {
      const list = result?.generations || jobs();
      const job = list.find(j => !before.has(j.id)) || list.find(j => { const c = host.clipById(j.clipId); return c && c.trackId === v.trackId && host.startF(c) === v.s; });
      if (!job) { close(); return; }
      target.draft = null; target.ghost = null; target.clipId = job.clipId; target.sig = {};
      host.select([job.clipId]);
    }
    target.refreshVideo = false; target.sig.options = '';
    render();
  }
  function pickTake(t) {
    const v = view(); if (!v?.clip || t.previewMediaId === v.clip.mediaId) return;
    host.perform(() => api.command({ command: 'generation-select', clipId: v.clip.id, takeId: t.id }), 'Take selected');
  }
  function stepTake(dir) {
    const v = view(), list = v?.job?.takes || []; if (!list.length) return;
    const i = list.indexOf(selectedTake(v));
    pickTake(list[Math.max(0, Math.min(list.length - 1, i < 0 ? (dir > 0 ? 0 : list.length - 1) : i + dir))]);
  }
  async function accept() {
    const v = pop && view(); if (!v?.job) return;
    const plan = acceptPlan(v);
    if (plan.why) { host.say(plan.why, 'warn'); return; }
    const id = v.clip.id;
    const ok = await host.perform(() => api.command({ command: 'generation-accept', clipId: id, ...(plan.extend ? { extend: true } : {}) }), plan.extend ? 'Accepted take and extended clip' : 'Accepted take');
    if (ok && pop?.clipId === id) close();
  }
  function remove() {
    const id = pop?.clipId; if (!id) return;
    close(); host.deleteClip(id);
  }

  // ------------------------------------------------------------ Placement and redraws
  function position() {
    if (!pop) return;
    const box = pop.el;
    const anchor = pop.draft ? pop.ghost : document.querySelector(`.clip[data-id="${CSS.escape(pop.clipId)}"]`);
    const view = document.getElementById('tl-scroll').getBoundingClientRect();
    let r = anchor?.isConnected ? anchor.getBoundingClientRect() : null;
    if (r && (r.right < view.left + 176 || r.left > view.right || r.bottom < view.top || r.top > view.bottom)) r = null;
    if (!r || !r.height) { box.classList.add('no-tip'); return; }
    box.classList.remove('no-tip');
    const above = r.top - 18, below = innerHeight - r.bottom - 18, down = above < 320 && below > above;
    box.style.maxHeight = `${Math.max(200, Math.min(520, down ? below : above))}px`;
    const left0 = Math.max(r.left, view.left + 176), cx = (left0 + Math.min(r.right, view.right)) / 2;
    const w = box.offsetWidth, ht = box.offsetHeight, left = Math.max(10, Math.min(innerWidth - w - 10, cx - w / 2));
    box.classList.toggle('below', down);
    box.style.left = `${left}px`;
    box.style.top = `${down ? r.bottom + 10 : Math.max(10, r.top - ht - 10)}px`;
    box.style.setProperty('--popover-tip', `${Math.max(14, Math.min(w - 14, cx - left))}px`);
  }
  // After each timeline rebuild: put the draft range back and follow the anchor.
  function redrawn() {
    if (pop?.draft) {
      const lane = document.querySelector(`.lane[data-track="${CSS.escape(pop.draft.trackId)}"]`);
      if (!lane || !host.trackById(pop.draft.trackId)) { close(); return; }
      pop.ghost ||= h('div', { class: 'gen-ghost held' }, h('div', { class: 'handle l' }), h('div', { class: 'handle r' }));
      lane.append(pop.ghost);
      paintGhost(pop.ghost, pop.draft.s, pop.draft.e);
    }
    position();
  }
  // Escape from the timeline closes the popup unless it would clear a selection first.
  document.addEventListener('keydown', e => {
    if (pop?.resize && e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); host.cancelDrag(); host.say('Drag cancelled'); return; }
    if (!pop || e.key !== 'Escape' || host.blocked() || pop.el.contains(document.activeElement)) return;
    if (host.hasSelection()) return;
    e.preventDefault(); e.stopImmediatePropagation(); close();
  }, true);
  const schedule = () => { if (!frame) frame = requestAnimationFrame(() => { frame = 0; position(); }); };
  addEventListener('resize', schedule);
  document.getElementById('tl-scroll')?.addEventListener('scroll', schedule, { passive: true });

  // Project state changed: refresh the popup and announce finished jobs.
  function changed() {
    const live = new Set();
    for (const j of jobs()) {
      live.add(j.id);
      const prev = statuses.get(j.id), key = `${j.status}:${j.takes?.length || 0}`;
      statuses.set(j.id, key);
      if (!prev || prev === key) continue;
      const c = host.clipById(j.clipId), name = c ? host.clipName(c) : 'Generation';
      if (j.status === 'ready') host.say(`${name}: take ${j.takes?.length || 1} ready`, 'ok');
      else if (j.status === 'failed') host.say(`${name}: ${j.error?.message || 'generation failed'}`, 'error');
    }
    for (const id of [...statuses.keys()]) if (!live.has(id)) statuses.delete(id);
    if (pop) render();
  }

  // ------------------------------------------------------------ Clip decoration
  function decorate(el, c) {
    const job = jobOf(c); if (!c.generationId && !job) return;
    const st = job?.status || 'generating';
    el.classList.add('generated', `gen-${st}`);
    const takes = job?.takes?.length || 0;
    const badge = h('span', { class: `gen-badge ${st}` }, st === 'failed' ? icon('alert', 'sm') : st === 'generating' ? h('i', { class: 'gen-spin' }) : null,
      st === 'failed' ? 'Failed' : st === 'generating' ? phaseLabel(job) : `${takes} take${takes === 1 ? '' : 's'}`);
    el.append(badge);
  }
  const tip = c => { const job = jobOf(c); return job && { status: job.status, takes: job.takes?.length || 0, error: job.error?.message }; };

  return {
    armed: () => armed, begin, dragMove, dragEnd, dragCancel, open, close, redrawn, changed, decorate, tip,
    pending: c => !!c?.generationId,
    holdsReload: () => !!pop,
    isOpen: () => !!pop,
  };
};
