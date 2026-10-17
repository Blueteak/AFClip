'use strict';
const $ = id => document.getElementById(id);
const api = window.reelet;
const SVG = 'http://www.w3.org/2000/svg';

// ---------------------------------------------------------------- Exact time
const gcd = (a, b) => { a = Math.abs(a); b = Math.abs(b); while (b) [a, b] = [b, a % b]; return a || 1; };
const frac = (num, den = 1) => { if (den < 0) { num = -num; den = -den; } const g = gcd(num, den); return { num: num / g, den: den / g }; };
const fadd = (a, b) => frac(a.num * b.den + b.num * a.den, a.den * b.den);
const fsub = (a, b) => frac(a.num * b.den - b.num * a.den, a.den * b.den);
const fmul = (a, b) => frac(a.num * b.num, a.den * b.den);
const secs = t => typeof t === 'number' ? t : t ? t.num / t.den : 0;
const fmin = (a, b) => secs(a) <= secs(b) ? a : b;
const ZERO = { num: 0, den: 1 }, ONE = { num: 1, den: 1 };

let snapshot = null;
const project = () => snapshot?.project;
const clips = () => project()?.clips || [];
const tracks = () => project()?.tracks || [];
const transitions = () => project()?.transitions || [];
const displayTracks = () => [...tracks()].reverse();
const rate = () => project()?.fps || { num: 30, den: 1 };
const fps = () => secs(rate());
const nominal = () => Math.max(1, Math.round(fps()));
const toF = t => Math.round(secs(t) * fps());
const fromF = n => frac(n * rate().den, rate().num);
const endOf = c => fadd(c.start, c.duration);
const startF = c => toF(c.start);
const endF = c => toF(endOf(c));
const timelineEndF = () => Math.max(0, ...clips().map(c => Math.ceil(secs(endOf(c)) * fps() - 1e-8)));
const lastFrame = () => Math.max(0, timelineEndF() - 1);
const tc = f => {
  const n = nominal(), a = Math.abs(Math.round(f)), s = Math.floor(a / n);
  return (f < 0 ? '-' : '') + [Math.floor(s / 3600), Math.floor(s / 60) % 60, s % 60, a % n].map(x => String(x).padStart(2, '0')).join(':');
};
const shortTc = f => tc(f).replace(/^(-?)(00:){1,2}/, '$1');
const fpsLabel = () => fps().toFixed(3).replace(/\.?0+$/, '');
// Accepts timecode (00:00:02:15), seconds (2.5), frames (75f) or relative frames (+12 / -12).
function parseTime(text, base) {
  const s = String(text).trim().toLowerCase();
  let m;
  if (!s) return null;
  if ((m = s.match(/^([+-])(\d+)$/)) && base != null) return base + (m[1] === '-' ? -1 : 1) * Number(m[2]);
  if ((m = s.match(/^(\d+)f$/))) return Number(m[1]);
  if (/[:;]/.test(s)) {
    const raw = s.split(/[:;]/);
    if (raw.length > 4 || raw.some(x => !/^\d*$/.test(x))) return null;
    const parts = raw.map(x => Number(x || 0));
    const [ff = 0, ss = 0, mm = 0, hh = 0] = parts.reverse();
    return ((hh * 60 + mm) * 60 + ss) * nominal() + ff;
  }
  const v = Number(s.replace(/s$/, ''));
  return Number.isFinite(v) ? Math.round(v * fps()) : null;
}

// ---------------------------------------------------------------- Model helpers
const byId = (list, id) => list.find(item => item.id === id);
const clipById = id => byId(clips(), id);
const trackById = id => byId(tracks(), id);
const mediaById = id => byId(project()?.media || [], id);
const transitionById = id => byId(transitions(), id);
const clipsOn = trackId => clips().filter(c => c.trackId === trackId);
const strip = ({ revision, ...rest }) => rest;
const uid = prefix => `${prefix}_${crypto.randomUUID().replaceAll('-', '')}`;
const basename = value => String(value || '').split(/[\\/]/).filter(Boolean).pop() || '';
const stem = value => basename(value).replace(/\.[^.]+$/, '');
const mediaName = m => {
  if (!m) return 'Missing media';
  // Imported graphic folders are renamed to stable IDs, so borrow the name of a clip that uses them.
  if (m.kind === 'graphic') return clips().find(c => c.mediaId === m.id && c.name)?.name || `Graphic ${m.id.slice(-6)}`;
  return basename(m.path);
};
const clipName = c => c.name || stem(mediaName(mediaById(c.mediaId)));
const sourceBound = m => m?.kind === 'video' || m?.kind === 'audio';
const hasAudio = m => m?.kind === 'audio' || (m?.kind === 'video' && m.metadata?.hasAudio !== false);
const isVisual = m => m && m.kind !== 'audio';
const kindIcon = kind => ({ video: 'video', audio: 'audio', image: 'image', graphic: 'graphic' })[kind] || 'video';
const kindLabel = kind => ({ video: 'Video', audio: 'Audio', image: 'Image', graphic: 'HTML graphic' })[kind] || 'Clip';
const pct = v => `${Math.round(v * 1000) / 10}%`;
const toDb = v => v <= 0 ? '-∞' : (Math.round(20 * Math.log10(v) * 10) / 10).toFixed(1);
const trackLabel = t => String(tracks().indexOf(t) + 1);

// ---------------------------------------------------------------- Preferences
const prefs = (() => {
  const defaults = { leftW: 250, rightW: 290, tlH: 330, trackH: 50, snap: true, autoRender: true, renderMode: 'gpu', verification: 'quick', welcomed: false, tips: {}, marks: {} };
  try { return { ...defaults, ...JSON.parse(localStorage.getItem('reelet.ui') || '{}') }; } catch { return defaults; }
})();
const savePrefs = () => localStorage.setItem('reelet.ui', JSON.stringify(prefs));
function applyLayout() {
  const root = document.documentElement.style;
  root.setProperty('--left-w', `${prefs.leftW}px`); root.setProperty('--right-w', `${prefs.rightW}px`);
  root.setProperty('--tl-h', `${prefs.tlH}px`); root.setProperty('--track-h', `${prefs.trackH}px`);
}

// ---------------------------------------------------------------- UI state
let playF = 0, inF = null, outF = null, tool = 'select', pps = 40, fitZoom = true;
let selection = new Set(), selTransition = null, binSelection = null, clipboard = null;
let drag = null, deferredDraw = false, editingTrack = null, firstLoad = true, connected = false;
let shown = null, frameJobId = null, frameQueued = false, frameTimer = null, exportJobId = null, exportProgress = 0, exportMessage = '', finishedExport = null, monitorView = 'frame';
const frameFor = new Map(), seenJobs = new Set(), jobModes = new Map();
const HEAD_W = 176;
const playback = new window.TimelinePlayback(api, {
  time: time => {
    playF = Math.min(lastFrame(), Math.floor(time * fps() + 1e-7));
    drawPlayhead();
    const scroll = $('tl-scroll'), x = frameX(playF);
    if (x < scroll.scrollLeft || x > scroll.scrollLeft + scroll.clientWidth - HEAD_W - 24) scroll.scrollLeft = Math.max(0, x - 40);
  },
  frame: event => {
    if (monitorView !== 'frame') return;
    const firstPreview = !shown;
    const sameNativeView = shown?.native && event.native && playback.playing;
    if (event.image) $('preview').src = event.image;
    shown = { f: Math.floor(event.time * fps() + 1e-7), revision: event.revision, live: true, native: !!event.native };
    if (!sameNativeView) drawMonitor();
    if (firstPreview) api.ready();
  },
  state: () => { drawMonitor(); syncPlayButton(); },
  error: error => report(error, 'Preview stopped'),
});
function syncPlayButton() {
  const running = monitorView === 'export' ? !$('export-video').paused : playback.wantsPlay;
  const button = document.querySelector('#transport-buttons [data-action="play"]');
  const label = running ? 'Pause' : 'Play';
  if (button && button.getAttribute('aria-label') !== label) { button.replaceChildren(icon(running ? 'pause' : 'play')); button.setAttribute('aria-label', label); }
}


// ---------------------------------------------------------------- DOM helpers
function h(tag, props = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'style') Object.assign(e.style, v);
    else if (k === 'tip' || k.startsWith('on') || k === 'value' || k === 'disabled' || k === 'checked') e[k] = v;
    else if (k === 'dataset') Object.assign(e.dataset, v);
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const child of children.flat()) if (child != null && child !== false) e.append(child);
  return e;
}
function icon(name, cls = '') {
  const s = document.createElementNS(SVG, 'svg'), u = document.createElementNS(SVG, 'use');
  s.setAttribute('class', `icon ${cls}`.trim()); u.setAttribute('href', `#i-${name}`); s.append(u);
  return s;
}
const KEY_NAMES = { Left: '←', Right: '→', Up: '↑', Down: '↓', Delete: 'Del', Backspace: '⌫', Escape: 'Esc' };
function kbd(combo) {
  if (!combo) return null;
  const parts = combo === '+' ? ['+'] : combo.split('+').map((p, i, all) => p === '' && i === all.length - 1 ? '+' : p).filter(Boolean);
  return h('span', { class: 'kbd-group' }, parts.map(p => h('kbd', {}, KEY_NAMES[p] || p)));
}
const keysOf = id => actions[id]?.keys || [];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// ---------------------------------------------------------------- Status, hints, toasts
function say(message, kind = '') { const s = $('status'); s.textContent = message; s.className = `status ${kind}`; }
function explain(error) {
  const raw = String(error?.message || error || 'Something went wrong').replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
  const [, code, rest] = raw.match(/^([A-Z_]+): ([\s\S]*)$/) || [null, null, raw];
  if (code === 'CONFLICT') return 'The project changed before this edit landed (another client or agent edited it). Nothing was applied. Try again.';
  if (code === 'RENDER_LOCKED') return 'Edits are paused while a render holds the project. Try again when it finishes.';
  if (code === 'TRACK_LOCKED') return 'That track is locked. Unlock it in the track header to edit it.';
  return rest;
}
function report(error, title = 'Edit not applied') { const message = explain(error); say(message, 'error'); toast({ title, body: message, kind: 'error' }); }

let hintTimer = null, hoverHint = null;
function hintItems(items) {
  const el = $('hint'); el.replaceChildren();
  for (const [i, item] of items.entries()) {
    if (i) el.append(h('span', { style: { margin: '0 4px', color: '#3d4148' } }, '·'));
    if (item.keys) for (const k of [].concat(item.keys)) el.append(k.startsWith('#') ? h('span', {}, k.slice(1)) : kbd(k));
    el.append(h('span', {}, ` ${item.text}`));
  }
}
function idleHint() {
  if (drag) return;
  if (hoverHint) return hintItems(hoverHint);
  if (tool === 'razor') return hintItems([{ text: 'Razor: click a clip to split it' }, { keys: 'V', text: 'back to selection' }]);
  hintItems([{ keys: '?', text: 'Shortcuts' }, { keys: 'Ctrl+Shift+P', text: 'Search commands' }]);
}
function flashHint(items, ms = 4500) { clearTimeout(hintTimer); hintItems(items); hintTimer = setTimeout(() => { hintTimer = null; idleHint(); }, ms); }
// Mouse users get a gentle nudge toward the shortcut, a few times per action.
function teach(a) {
  if (!a.keys?.length) return;
  const n = prefs.tips[a.id] || 0; if (n >= 3) return;
  prefs.tips[a.id] = n + 1; savePrefs();
  flashHint([{ keys: ['#Tip:', a.keys[0]], text: a.label.replace(/…$/, '') }]);
}

function toast({ title, body, kind = 'info', actions: buttons = [], timeout = 6000, cls = '' }) {
  const close = () => { item.remove(); };
  const item = h('div', { class: `toast ${kind} ${cls}` },
    icon(kind === 'error' ? 'alert' : kind === 'ok' ? 'check' : 'help'),
    h('div', { class: 'grow' }, h('div', { class: 't-title' }, title), body ? h('div', { class: 't-body' }, body) : null,
      buttons.length ? h('div', { class: 't-actions' }, buttons.map(b => h('button', { class: `btn ${b.primary ? 'primary' : ''}`, onclick: () => { close(); b.run(); } }, b.label))) : null),
    h('button', { class: 'icon-button', onclick: close, tip: { title: 'Dismiss' } }, icon('x')));
  $('toasts').append(item);
  while ($('toasts').children.length > 4) $('toasts').firstChild.remove();
  if (timeout) setTimeout(close, timeout);
  return close;
}

// ---------------------------------------------------------------- Tooltips
const tipEl = $('tooltip');
let tipTimer = null, tipTarget = null, tipWarm = 0, pointer = { x: 0, y: 0 };
function findTip(node) { for (let n = node; n && n !== document; n = n.parentNode) if (n.tip) return n; return null; }
function resolveTip(target) {
  const spec = typeof target.tip === 'function' ? target.tip() : target.tip;
  if (!spec) return null;
  const a = spec.action ? actions[spec.action] : null;
  return { title: spec.title || a?.label?.replace(/…$/, ''), desc: spec.desc ?? a?.desc, keys: spec.keys ?? a?.keys?.[0], meta: spec.meta, hint: spec.hint, follow: spec.follow };
}
function showTip(target) {
  const spec = resolveTip(target); if (!spec || !target.isConnected) return;
  tipEl.replaceChildren(...[h('div', { class: 'tip-title' }, h('span', {}, spec.title), kbd(spec.keys)), spec.desc && h('div', { class: 'tip-desc' }, spec.desc), spec.meta && h('div', { class: 'tip-meta' }, spec.meta)].filter(Boolean));
  tipEl.hidden = false;
  const r = target.getBoundingClientRect(), w = tipEl.offsetWidth, ht = tipEl.offsetHeight;
  const cx = spec.follow || r.width > 240 ? pointer.x : r.left + r.width / 2;
  let top = r.bottom + 6;
  if (spec.follow) top = Math.min(r.bottom, pointer.y + 18) + 4;
  if (top + ht > innerHeight - 8) top = r.top - ht - 6;
  tipEl.style.left = `${Math.max(6, Math.min(innerWidth - w - 6, cx - w / 2))}px`;
  tipEl.style.top = `${Math.max(6, top)}px`;
}
function hideTip() { clearTimeout(tipTimer); if (!tipEl.hidden) tipWarm = Date.now() + 500; tipEl.hidden = true; tipTarget = null; }
document.addEventListener('pointermove', e => { pointer = { x: e.clientX, y: e.clientY }; }, true);
document.addEventListener('pointerover', e => {
  if (e.buttons || drag) return;
  const target = findTip(e.target);
  if (target === tipTarget) return;
  hideTip();
  hoverHint = target ? resolveTip(target)?.hint || null : null; if (!hintTimer) idleHint();
  if (!target) return;
  tipTarget = target;
  tipTimer = setTimeout(() => showTip(target), Date.now() < tipWarm ? 80 : 550);
});
document.addEventListener('pointerdown', hideTip, true);
document.addEventListener('wheel', hideTip, { passive: true, capture: true });

// ---------------------------------------------------------------- Actions
const actions = {};
const MENUS = ['File', 'Edit', 'Clip', 'Timeline', 'View', 'Help'];
function action(id, spec) { actions[id] = { id, keys: [], ...spec }; }
const can = id => { const a = actions[id]; return !!a && (!a.enabled || a.enabled()); };
function run(id, via = 'mouse') {
  const a = actions[id]; if (!a) return false;
  if (!can(id)) { if (a.why) say(a.why(), 'warn'); return false; }
  if (via !== 'key') teach(a);
  a.run();
  return true;
}
const editable = () => !!project() && !exportJobId;
const hasSelection = () => selection.size > 0 || !!selTransition;

action('import', { menu: 'File', group: 1, label: 'Import media…', icon: 'import', keys: ['Ctrl+I'], desc: 'Add footage, music, sound effects or images. Originals stay where they are.', enabled: editable, run: () => importMedia() });
action('library', { menu: 'File', group: 1, label: 'Browse content library…', icon: 'folder', keys: ['Ctrl+L'], desc: 'Browse and preview reusable assets and ranges. Edit annotations in the standalone library.', run: () => api.library() });
action('importGraphic', { menu: 'File', group: 1, label: 'Import graphic folder…', icon: 'graphic', keys: ['Ctrl+Shift+I'], desc: 'Add an HTML/CSS/JS graphic. The folder needs an index.html.', enabled: editable, run: () => importMedia('graphic') });
action('export', { menu: 'File', group: 2, label: 'Export…', icon: 'export', keys: ['Ctrl+M'], desc: 'Render an H.264/AAC MP4 of the sequence or the In/Out range.', enabled: () => editable() && clips().length > 0, run: () => openExport() });
action('checkpoint', { menu: 'File', group: 3, label: 'New checkpoint…', icon: 'flag', keys: ['Ctrl+Shift+S'], desc: 'Save a restorable snapshot of the whole project. The latest five are kept.', enabled: editable, run: () => newCheckpoint() });
action('showHistory', { menu: 'File', group: 3, label: 'Checkpoints', icon: 'history', desc: 'Show checkpoints and shared undo history.', run: () => showTab('history') });
action('save', { label: 'Save', keys: ['Ctrl+S'], run: () => flashHint([{ text: 'Every committed edit saves automatically.' }, { keys: 'Ctrl+Shift+S', text: 'checkpoint' }]) });

action('undo', { menu: 'Edit', group: 1, label: 'Undo', icon: 'undo', keys: ['Ctrl+Z'], desc: 'Undo the latest edit or agent batch. History is shared with the CLI.', enabled: () => editable() && !!snapshot?.history?.undo, run: () => history('undo') });
action('redo', { menu: 'Edit', group: 1, label: 'Redo', icon: 'redo', keys: ['Ctrl+Shift+Z', 'Ctrl+Y'], enabled: () => editable() && !!snapshot?.history?.redo, run: () => history('redo') });
action('copy', { menu: 'Edit', group: 2, label: 'Copy', icon: 'copy', keys: ['Ctrl+C'], enabled: () => selection.size > 0, run: copySelection });
action('paste', { menu: 'Edit', group: 2, label: 'Paste at playhead', icon: 'paste', keys: ['Ctrl+V'], enabled: () => editable() && !!clipboard, run: paste });
action('delete', { menu: 'Edit', group: 2, label: 'Delete', icon: 'trash', keys: ['Delete', 'Backspace'], desc: 'Remove the selection and leave a gap.', enabled: () => editable() && hasSelection(), run: deleteSelection });
action('selectAll', { menu: 'Edit', group: 3, label: 'Select all clips', keys: ['Ctrl+A'], enabled: () => clips().length > 0, run: () => select(clips().map(c => c.id)) });
action('deselect', { menu: 'Edit', group: 3, label: 'Deselect all', keys: ['Ctrl+Shift+A'], enabled: hasSelection, run: () => select([]) });

action('split', { menu: 'Clip', group: 1, label: 'Split at playhead', icon: 'scissors', keys: ['Ctrl+K'], desc: 'Cut the selected clips (or every unlocked clip) under the playhead.', enabled: editable, run: splitAtPlayhead });
action('dissolve', { menu: 'Clip', group: 1, label: 'Add dissolve', icon: 'dissolve', keys: ['Ctrl+D'], desc: 'Cross-dissolve at the cut nearest the playhead, centered, 1 second or as long as the footage allows.', enabled: editable, run: addDissolve });
action('mute', { menu: 'Clip', group: 2, label: 'Mute audio', icon: 'mute', keys: ['Shift+M'], desc: 'Toggle mute on the selected clips.', enabled: () => editable() && selectedClips().some(c => hasAudio(mediaById(c.mediaId))), checked: () => selectedClips().length > 0 && selectedClips().every(c => c.mute), run: toggleMute });
action('fill', { menu: 'Clip', group: 2, label: 'Fill frame', desc: 'Scale to cover the frame, cropping the excess. Off means Fit.', keys: ['Shift+F'], enabled: () => editable() && selectedClips().some(c => isVisual(mediaById(c.mediaId))), checked: () => selectedClips().length > 0 && selectedClips().every(c => c.transform?.fit === 'fill'), run: toggleFill });
action('nudgeLeft', { menu: 'Clip', group: 3, label: 'Nudge left 1 frame', keys: ['Alt+Left'], enabled: () => editable() && selection.size > 0, run: () => nudge(-1) });
action('nudgeRight', { menu: 'Clip', group: 3, label: 'Nudge right 1 frame', keys: ['Alt+Right'], enabled: () => editable() && selection.size > 0, run: () => nudge(1) });
action('nudgeLeft5', { label: 'Nudge left 5 frames', keys: ['Alt+Shift+Left'], enabled: () => editable() && selection.size > 0, run: () => nudge(-5) });
action('nudgeRight5', { label: 'Nudge right 5 frames', keys: ['Alt+Shift+Right'], enabled: () => editable() && selection.size > 0, run: () => nudge(5) });

action('renderFrame', { menu: 'Timeline', group: 1, label: 'Render frame', icon: 'render', keys: ['Enter'], desc: 'Render the exact frame at the playhead from original media.', enabled: () => clips().length > 0 && !exportJobId, run: () => renderFrame(true) });
action('play', { menu: 'Timeline', group: 1, label: 'Play / pause', icon: 'play', keys: ['Space'], desc: 'Play the timeline with synchronized audio. Pause to inspect the current frame.', enabled: () => clips().length > 0 && connected, run: togglePlay });
action('markIn', { menu: 'Timeline', group: 2, label: 'Mark In', icon: 'in', keys: ['I'], desc: 'Start the export range at the playhead.', enabled: () => !!project(), run: () => setMarks(playF, outF != null && outF < playF ? null : outF) });
action('markOut', { menu: 'Timeline', group: 2, label: 'Mark Out', icon: 'out', keys: ['O'], desc: 'End the export range on the playhead frame.', enabled: () => !!project(), run: () => setMarks(inF != null && inF > playF ? null : inF, Math.min(playF, lastFrame())) });
action('goIn', { menu: 'Timeline', group: 2, label: 'Go to In', keys: ['Shift+I'], enabled: () => inF != null, run: () => seek(inF, true) });
action('goOut', { menu: 'Timeline', group: 2, label: 'Go to Out', keys: ['Shift+O'], enabled: () => outF != null, run: () => seek(outF, true) });
action('clearMarks', { menu: 'Timeline', group: 2, label: 'Clear In and Out', keys: ['Ctrl+Shift+X'], enabled: () => inF != null || outF != null, run: () => setMarks(null, null) });
action('addTrack', { menu: 'Timeline', group: 3, label: 'Add track', icon: 'add-track', keys: ['Ctrl+Shift+T'], desc: 'Add an empty track on top. Any media can go on any track.', enabled: editable, run: () => addTrack() });
action('snap', { menu: 'Timeline', group: 3, label: 'Snapping', icon: 'magnet', keys: ['S'], desc: 'Snap moves and trims to clip edges, the playhead and In/Out. Hold Alt while dragging to bypass.', checked: () => prefs.snap, run: () => { prefs.snap = !prefs.snap; savePrefs(); say(`Snapping ${prefs.snap ? 'on' : 'off'}`); syncChrome(); } });
action('selectTool', { menu: 'Timeline', group: 4, label: 'Selection tool', icon: 'pointer', keys: ['V'], desc: 'Select, move and trim clips.', checked: () => tool === 'select', run: () => setTool('select') });
action('razorTool', { menu: 'Timeline', group: 4, label: 'Razor tool', icon: 'scissors', keys: ['C'], desc: 'Click a clip to split it at that frame.', checked: () => tool === 'razor', run: () => setTool('razor') });
action('prevEdit', { menu: 'Timeline', group: 5, label: 'Previous edit point', icon: 'prev-edit', keys: ['Up'], run: () => seekEdit(-1) });
action('nextEdit', { menu: 'Timeline', group: 5, label: 'Next edit point', icon: 'next-edit', keys: ['Down'], run: () => seekEdit(1) });
action('stepBack', { menu: 'Timeline', group: 5, label: 'Back 1 frame', icon: 'step-back', keys: ['Left'], run: () => seek(playF - 1, true) });
action('stepForward', { menu: 'Timeline', group: 5, label: 'Forward 1 frame', icon: 'step-forward', keys: ['Right'], run: () => seek(playF + 1, true) });
action('back5', { label: 'Back 5 frames', keys: ['Shift+Left'], run: () => seek(playF - 5, true) });
action('forward5', { label: 'Forward 5 frames', keys: ['Shift+Right'], run: () => seek(playF + 5, true) });
action('toStart', { menu: 'Timeline', group: 5, label: 'Go to start', icon: 'to-start', keys: ['Home'], run: () => seek(0, true) });
action('toEnd', { menu: 'Timeline', group: 5, label: 'Go to end', icon: 'to-end', keys: ['End'], run: () => seek(timelineEndF(), true) });

action('zoomIn', { menu: 'View', group: 1, label: 'Zoom in', icon: 'zoom-in', keys: ['='], run: () => zoom(1.5) });
action('zoomOut', { menu: 'View', group: 1, label: 'Zoom out', icon: 'zoom-out', keys: ['-'], run: () => zoom(1 / 1.5) });
action('zoomFit', { menu: 'View', group: 1, label: 'Zoom to fit', icon: 'fit', keys: ['\\'], desc: 'Show the whole sequence.', run: () => { fitZoom = true; drawTimeline(); } });
action('taller', { menu: 'View', group: 2, label: 'Taller tracks', keys: ['Ctrl+='], run: () => trackHeight(10) });
action('shorter', { menu: 'View', group: 2, label: 'Shorter tracks', keys: ['Ctrl+-'], run: () => trackHeight(-10) });
action('autoRender', { menu: 'View', group: 3, label: 'Update preview after edits', desc: 'Refresh the program monitor when GUI or CLI edits change the project.', checked: () => prefs.autoRender, run: () => { prefs.autoRender = !prefs.autoRender; savePrefs(); syncChrome(); if (prefs.autoRender) requestFrame(0); } });
action('softwareRender', { menu: 'View', group: 3, label: 'Use software rendering', icon: 'chip', desc: 'Software preview decoding and CPU exports. Use it when the GPU path is unavailable.', checked: () => prefs.renderMode === 'software', run: () => setRenderMode(prefs.renderMode === 'gpu' ? 'software' : 'gpu') });
action('resetLayout', { menu: 'View', group: 4, label: 'Reset panel layout', run: () => { Object.assign(prefs, { leftW: 250, rightW: 290, tlH: 330, trackH: 50 }); savePrefs(); applyLayout(); fitZoom = true; drawTimeline(); } });
action('palette', { menu: 'Help', group: 1, label: 'Search commands…', icon: 'command', keys: ['Ctrl+Shift+P'], desc: 'Find any action by name and see its shortcut.', run: () => openPalette() });
action('shortcuts', { menu: 'Help', group: 1, label: 'Keyboard shortcuts', icon: 'keyboard', keys: ['?', 'Ctrl+/'], run: () => openShortcuts() });
action('welcome', { menu: 'Help', group: 2, label: 'Getting started', icon: 'help', run: () => welcome(true) });

const keymap = new Map();
for (const a of Object.values(actions)) for (const k of a.keys) keymap.set(k, a.id);

// ---------------------------------------------------------------- Menus
let openMenuState = null;
function closeMenu() { if (!openMenuState) return; openMenuState.el.remove(); openMenuState.anchor?.classList.remove('open'); openMenuState = null; }
function menuItems(name) {
  const list = Object.values(actions).filter(a => a.menu === name);
  const out = [];
  for (const [i, a] of list.entries()) { if (i && a.group !== list[i - 1].group) out.push('-'); out.push({ action: a.id }); }
  return out;
}
function openMenu(items, x, y, anchor) {
  closeMenu();
  const el = h('div', { class: 'menu', role: 'menu' });
  const buttons = [];
  for (const item of items) {
    if (item === '-') { el.append(h('div', { class: 'menu-sep' })); continue; }
    const a = item.action ? actions[item.action] : item;
    const checked = a.checked ? a.checked() : undefined;
    const disabled = item.action ? !can(item.action) : !!item.disabled;
    const b = h('button', { class: 'menu-item', role: 'menuitem', disabled, onclick: () => { closeMenu(); item.action ? run(item.action, 'menu') : item.run(); } },
      checked !== undefined ? h('span', { class: 'check' }, checked ? icon('check', 'sm') : null) : a.icon ? icon(a.icon) : h('span', { class: 'check' }),
      h('span', { class: 'label' }, a.label), kbd(a.keys?.[0]));
    if (a.desc) b.tip = { title: a.label.replace(/…$/, ''), desc: a.desc, keys: a.keys?.[0] };
    b.onpointerenter = () => { buttons.forEach(x => x.classList.remove('active')); b.classList.add('active'); };
    buttons.push(b); el.append(b);
  }
  $('layer').append(el);
  const w = el.offsetWidth, ht = el.offsetHeight;
  el.style.left = `${Math.max(4, Math.min(innerWidth - w - 4, x))}px`;
  el.style.top = `${Math.max(4, y + ht > innerHeight - 4 ? y - ht : y)}px`;
  anchor?.classList.add('open');
  openMenuState = { el, anchor, buttons };
}
function menuKey(e) {
  const { buttons, anchor } = openMenuState, live = buttons.filter(b => !b.disabled);
  const cur = live.findIndex(b => b.classList.contains('active'));
  const move = d => { buttons.forEach(x => x.classList.remove('active')); live[(cur + d + live.length) % live.length]?.classList.add('active'); };
  if (e.key === 'Escape') closeMenu();
  else if (e.key === 'ArrowDown') move(cur < 0 ? 0 : 1);
  else if (e.key === 'ArrowUp') move(cur < 0 ? 0 : -1);
  else if (e.key === 'Enter' || e.key === ' ') live[cur]?.click();
  else if (anchor && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
    const bar = [...$('menubar').children], i = bar.indexOf(anchor);
    bar[(i + (e.key === 'ArrowRight' ? 1 : -1) + bar.length) % bar.length].dispatchEvent(new Event('open'));
    openMenuState?.buttons.find(b => !b.disabled)?.classList.add('active');
  } else return;
  e.preventDefault();
}
document.addEventListener('pointerdown', e => { if (openMenuState && !openMenuState.el.contains(e.target) && !$('menubar').contains(e.target)) closeMenu(); }, true);
window.addEventListener('blur', closeMenu);
function buildMenubar() {
  for (const name of MENUS) {
    const b = h('button', {}, name);
    const open = () => { const r = b.getBoundingClientRect(); openMenu(menuItems(name), r.left, r.bottom + 2, b); };
    b.addEventListener('open', open);
    b.onclick = () => openMenuState?.anchor === b ? closeMenu() : open();
    b.onpointerenter = () => { if (openMenuState?.anchor && openMenuState.anchor !== b) open(); };
    $('menubar').append(b);
  }
}
function contextMenu(e, items) { e.preventDefault(); hideTip(); openMenu(items, e.clientX, e.clientY); }

// ---------------------------------------------------------------- Dialogs, palette, shortcuts
let modal = null;
function closeModal() { modal?.scrim.remove(); modal = null; }
function dialog({ title, iconName, body, buttons = [], wide = false, cls = '', foot, onKey }) {
  closeModal(); closeMenu(); hideTip();
  const box = h('div', { class: `dialog ${wide ? 'wide' : ''} ${cls}`, role: 'dialog', 'aria-label': title || 'Dialog' });
  if (title) box.append(h('div', { class: 'dialog-head' }, iconName ? icon(iconName) : null, h('span', { class: 'grow' }, title), h('button', { class: 'icon-button small', onclick: closeModal, tip: { title: 'Close', keys: 'Escape' } }, icon('x'))));
  if (body) box.append(body);
  if (buttons.length || foot) box.append(h('div', { class: 'dialog-foot' }, h('span', { class: 'grow' }, foot || null),
    buttons.map(b => h('button', { class: `btn ${b.kind || ''}`, disabled: b.disabled, onclick: async () => { if ((await b.run?.()) !== false) closeModal(); } }, b.label, b.keys ? kbd(b.keys) : null))));
  const scrim = h('div', { class: 'scrim', onpointerdown: e => { if (e.target === scrim) closeModal(); } }, box);
  scrim.addEventListener('keydown', e => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeModal(); return; }
    if (onKey?.(e)) return;
    const primary = buttons.find(b => b.kind === 'primary' || b.kind === 'danger');
    if (e.key === 'Enter' && primary && !e.target.matches('button, select') && !primary.disabled) { e.preventDefault(); e.stopPropagation(); box.querySelector('.dialog-foot .btn.primary, .dialog-foot .btn.danger').click(); }
    e.stopPropagation();
  });
  document.body.append(scrim);
  modal = { scrim, box };
  setTimeout(() => (box.querySelector('input, select') || box.querySelector('.dialog-foot .btn.primary, .dialog-foot .btn.danger') || box).focus?.(), 0);
  box.tabIndex = -1;
  return modal;
}

function openPalette() {
  const input = h('input', { placeholder: 'Type a command, or a timecode to jump to', spellcheck: 'false' });
  const list = h('div', { class: 'palette-list' });
  let items = [], active = 0;
  const pool = Object.values(actions).filter(a => a.label && a.id !== 'save');
  const refreshList = () => {
    const q = input.value.trim().toLowerCase();
    const frame = /^[+-]?[\d:;.]+f?$/.test(q) ? parseTime(q, playF) : null;
    items = [];
    if (frame != null) items.push({ label: `Go to ${tc(Math.max(0, frame))}`, icon: 'step-forward', where: 'Timeline', run: () => seek(frame, true) });
    const words = q.split(/\s+/).filter(Boolean);
    const scored = pool.map(a => {
      const hay = `${a.label} ${a.menu || ''} ${a.desc || ''} ${a.keys.join(' ')}`.toLowerCase();
      if (!words.every(w => hay.includes(w))) return null;
      const label = a.label.toLowerCase();
      return { a, score: !q ? 0 : label.startsWith(q) ? 0 : label.includes(q) ? 1 : 2 };
    }).filter(Boolean);
    if (q) scored.sort((x, y) => x.score - y.score);
    for (const { a } of scored) items.push({ label: a.label, icon: a.icon, where: a.menu, keys: a.keys[0], id: a.id, disabled: !can(a.id), checked: a.checked?.() });
    active = Math.min(active, Math.max(0, items.length - 1));
    list.replaceChildren(...items.map((item, i) => h('button', { class: `palette-item ${i === active ? 'active' : ''} ${item.disabled ? 'disabled' : ''}`, onpointerenter: () => { active = i; mark(); }, onclick: () => choose(i) },
      item.checked !== undefined ? h('span', { class: 'check' }, item.checked ? icon('check', 'sm') : icon(item.icon || 'command')) : icon(item.icon || 'command'),
      h('span', { class: 'label' }, item.label), item.where ? h('span', { class: 'where' }, item.where) : null, kbd(item.keys))));
    if (!items.length) list.append(h('div', { class: 'empty-note' }, 'No matching command'));
  };
  const mark = () => [...list.children].forEach((c, i) => c.classList.toggle('active', i === active));
  const choose = i => { const item = items[i]; if (!item || item.disabled) return; closeModal(); item.id ? run(item.id, 'palette') : item.run(); };
  input.oninput = () => { active = 0; refreshList(); };
  const body = h('div', {}, h('div', { class: 'palette-input' }, icon('search'), input), list,
    h('div', { class: 'palette-foot' }, h('span', {}, kbd('↑'), kbd('↓'), 'navigate'), h('span', {}, kbd('Enter'), 'run'), h('span', {}, kbd('Escape'), 'close')));
  dialog({ body, cls: 'palette', onKey: e => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { active = (active + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % Math.max(1, items.length); mark(); list.children[active]?.scrollIntoView({ block: 'nearest' }); e.preventDefault(); return true; }
    if (e.key === 'Enter') { e.preventDefault(); choose(active); return true; }
    return false;
  } });
  refreshList();
}

function openShortcuts() {
  const groups = MENUS.map(name => ({ name, rows: Object.values(actions).filter(a => a.menu === name && a.keys.length).map(a => [a.label.replace(/…$/, ''), a.keys]) }));
  groups.find(g => g.name === 'Timeline').rows.push(['Back / forward 5 frames', ['Shift+Left', 'Shift+Right']], ['Nudge 5 frames', ['Alt+Shift+Left', 'Alt+Shift+Right']]);
  groups.push({ name: 'Mouse', rows: [
    ['Move clips', ['#Drag']], ['Trim', ['#Drag edge']], ['Change speed (stretch)', ['Shift', '#Drag edge']], ['Bypass snapping', ['Alt', '#Drag']],
    ['Add to selection', ['Ctrl', '#Click']], ['Box select', ['#Drag empty track']], ['Zoom timeline', ['Ctrl', '#Wheel']], ['Rename track', ['#Double-click name']], ['More actions', ['#Right-click']],
  ], joined: true });
  const grid = h('div', { class: 'shortcut-grid' }, groups.filter(g => g.rows.length).map(g => h('div', { class: 'shortcut-group' }, h('h3', {}, g.name),
    g.rows.map(([label, keys]) => h('div', { class: 'shortcut-row' }, h('span', {}, label),
      h('span', { class: 'kbd-group' }, keys.flatMap((k, i) => [i ? h('span', { class: 'alt' }, g.joined ? '+' : 'or') : null, k.startsWith('#') ? h('span', { class: 'alt' }, k.slice(1)) : kbd(k)])))))));
  dialog({ title: 'Keyboard shortcuts', iconName: 'keyboard', wide: true, body: h('div', { class: 'dialog-body' }, grid), foot: [kbd('Ctrl+Shift+P'), ' searches every command'] });
}

function welcome(force) {
  if (prefs.welcomed && !force) return;
  toast({ cls: 'welcome', title: 'Welcome to Reelet', timeout: 0,
    body: h('div', {}, 'Hover any control to see what it does and its shortcut. Most editing is one key away.', h('br'),
      kbd('?'), ' all shortcuts  ·  ', kbd('Ctrl+Shift+P'), ' search commands', h('br'), 'Drag media from the bin onto the timeline to start.'),
    actions: [{ label: 'Got it', primary: true, run: () => { prefs.welcomed = true; savePrefs(); } }] });
}

// ---------------------------------------------------------------- Engine I/O
let queue = Promise.resolve();
function setConnected(on, message) {
  connected = on;
  $('connection-dot').className = `dot ${on ? 'connected' : 'error'}`;
  $('connection-dot').tip = { title: on ? 'Connected to project engine' : 'Disconnected', desc: on ? 'GUI and CLI share this engine. CLI and agent edits appear here live.' : message };
}
async function refresh() { snapshot = await api.inspect(); setConnected(true); draw(); return snapshot; }
// A preview render holds the editing lock. Our own preview is about to go stale, so cancel it rather than make the edit wait.
async function whenEditable() {
  playback.pause(false);
  if (exportJobId) throw new Error('Edits are locked while exporting. Cancel the export to keep editing.');
  for (let i = 0; frameJobId === 'pending' && i < 100; i++) await sleep(30);
  frameQueued = false;
  if (frameFor.has(frameJobId)) await api.command({ command: 'cancel', jobId: frameJobId }).catch(() => {});
  snapshot = await api.inspect();
  for (let i = 0; snapshot.renderLock && i < 300; i++) {
    if (exportJobId) throw new Error('Edits are locked while exporting. Cancel the export to keep editing.');
    await sleep(60); snapshot = await api.inspect();
  }
}
const SKIP = Symbol('skip');
let editsInFlight = 0;
function perform(task, success) {
  const step = async () => {
    editsInFlight++;
    try {
      await whenEditable();
      const result = await task();
      if (result === SKIP) return null;
      if (success) say(typeof success === 'function' ? success(result) : success);
      await refresh();
      if (prefs.autoRender) requestFrame(900);
      return result ?? true;
    } catch (error) { report(error); try { await refresh(); } catch {} return null; }
    finally { editsInFlight--; }
  };
  return (queue = queue.then(step, step));
}
// Batches are built when their turn in the queue comes, from the same snapshot whose revisions they assert.
// A concurrent CLI or agent change therefore rejects the batch instead of being overwritten.
// `build` is an operation list or a function returning { ops, pre, message } (null to skip).
function edit(build, message, extra = {}) {
  let note = message;
  return perform(async () => {
    let ops = build, pre = extra;
    if (typeof build === 'function') {
      const plan = build();
      if (!plan) return SKIP;
      ({ ops, pre = {}, message: note = message } = Array.isArray(plan) ? { ops: plan } : plan);
    }
    if (!ops?.length) return SKIP;
    await api.command({ command: 'apply', batch: { preconditions: { ...snapshot.revisions, ...pre }, operations: ops } });
    return true;
  }, () => note);
}
const put = (collection, value) => ({ op: 'put', collection, value });
const remove = (collection, id) => ({ op: 'remove', collection, id });
const history = direction => perform(() => api.command({ command: direction }), direction === 'undo' ? 'Undid the last edit' : 'Redid the edit');
const importMedia = kind => perform(() => api.importMedia(kind), result => result ? `Imported ${result.length} item${result.length === 1 ? '' : 's'}` : 'Import cancelled');

// ---------------------------------------------------------------- Selection and navigation
const selectedClips = () => [...selection].map(clipById).filter(Boolean);
function select(ids, mode = 'replace') {
  if (mode === 'replace') selection = new Set(ids);
  else for (const id of ids) mode === 'toggle' && selection.has(id) ? selection.delete(id) : selection.add(id);
  selTransition = null;
  drawTimeline(); drawInspector(); syncChrome();
}
function selectTransition(id) { selection = new Set(); selTransition = id; drawTimeline(); drawInspector(); syncChrome(); }
function setTool(next) { tool = next; syncChrome(); drawTimeline(); idleHint(); }
function seek(f, render = false) {
  playF = Math.max(0, Math.min(Math.round(f), Math.max(timelineEndF(), 0)));
  rememberMarks();
  // seek() notifies synchronously and redraws the monitor/playhead. Avoid
  // rebuilding them and the monitor tabs several times for each drag sample.
  if (clips().length) {
    if (monitorView !== 'frame') setMonitorView('frame');
    playback.seek(secs(fromF(Math.min(playF, lastFrame()))));
  } else drawMonitor();
}
function seekEdit(direction) {
  const points = [...new Set(clips().flatMap(c => [startF(c), endF(c)]))].sort((a, b) => a - b);
  const target = direction < 0 ? points.filter(p => p < playF).pop() : points.find(p => p > playF);
  if (target != null) seek(target, true);
}
function setMarks(i, o) { inF = i; outF = o; rememberMarks(); drawPlayhead(); syncChrome(); say(i == null && o == null ? 'In and Out cleared' : `Range ${i == null ? 'start' : tc(i)} → ${o == null ? 'end' : tc(o)}`); }
function rememberMarks() { const id = project()?.id; if (!id) return; prefs.marks[id] = { in: inF, out: outF, play: playF }; clearTimeout(rememberMarks.t); rememberMarks.t = setTimeout(savePrefs, 400); }
function setRenderMode(mode) { prefs.renderMode = mode; savePrefs(); if (project()) playback.setProject(project(), mode); requestFrame(0); syncChrome(); say(mode === 'gpu' ? 'GPU rendering (D3D11 + NVENC)' : 'Software rendering (CPU + x264)'); }
function zoom(factor, anchorX) {
  const scroll = $('tl-scroll'), anchor = anchorX ?? (frameX(playF) - scroll.scrollLeft);
  const atSec = (scroll.scrollLeft + anchor) / pps;
  pps = Math.max(2, Math.min(1500, pps * factor)); fitZoom = false;
  drawTimeline();
  scroll.scrollLeft = atSec * pps - anchor;
}
function trackHeight(delta) { prefs.trackH = Math.max(30, Math.min(110, prefs.trackH + delta)); savePrefs(); applyLayout(); drawTimeline(); }
function showTab(name) {
  for (const t of document.querySelectorAll('.bin .tab')) t.classList.toggle('active', t.dataset.tab === name);
  for (const p of document.querySelectorAll('.bin .tab-page')) p.hidden = p.dataset.page !== name;
  if (name === 'history') drawHistory();
}

// ---------------------------------------------------------------- Edit commands
function transitionsTouching(ids) { return transitions().filter(t => ids.has(t.fromClipId) || ids.has(t.toClipId)); }
function lockedIn(list) { return list.find(c => trackById(c.trackId)?.locked); }
function fadeClamp(c, duration) {
  const out = {};
  if (secs(c.fadeIn) > secs(duration)) out.fadeIn = duration;
  if (secs(c.fadeOut) > secs(duration)) out.fadeOut = duration;
  return out;
}

function splitOps(c, f) {
  const id = uid('clip'), cut = fromF(f), head = fsub(cut, c.start), tail = fsub(endOf(c), cut);
  const right = { ...strip(c), id, name: c.name, start: cut, duration: tail, sourceIn: fadd(c.sourceIn, fmul(head, c.speed)), fadeIn: ZERO, fadeOut: fmin(c.fadeOut, tail) };
  const ops = [put('clips', { id: c.id, duration: head, fadeOut: ZERO, fadeIn: fmin(c.fadeIn, head) }), put('clips', right)];
  for (const t of transitions().filter(t => t.fromClipId === c.id)) ops.push(put('transitions', { id: t.id, fromClipId: id }));
  return { ops, pre: { [`clip:${id}`]: 0 }, id };
}
const refuse = (message, kind = 'warn') => { say(message, kind); return null; };
const lockedRefusal = list => { const c = lockedIn(list); return c ? refuse(`“${trackById(c.trackId).name}” is locked`) : false; };
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

function splitAt(ids, f, fallback) {
  return edit(() => {
    let targets = ids.map(clipById).filter(c => c && startF(c) < f && f < endF(c));
    if (!targets.length && fallback) targets = clips().filter(c => startF(c) < f && f < endF(c) && !trackById(c.trackId)?.locked);
    if (!targets.length) return refuse('No clip under the playhead to split');
    if (lockedRefusal(targets) !== false) return null;
    const ops = [], pre = {};
    for (const c of targets) { const part = splitOps(c, f); ops.push(...part.ops); Object.assign(pre, part.pre); }
    return { ops, pre, message: `Split ${plural(targets.length, 'clip')} at ${tc(f)}` };
  });
}
function splitAtPlayhead() { splitAt([...selection], playF, true); }

function deleteSelection() {
  const tid = selTransition, ids = [...selection];
  selection = new Set(); selTransition = null;
  if (tid) return edit(() => transitionById(tid) ? { ops: [remove('transitions', tid)], message: 'Dissolve removed' } : null);
  edit(() => {
    const list = ids.map(clipById).filter(Boolean); if (!list.length) return null;
    if (lockedRefusal(list) !== false) return null;
    const set = new Set(list.map(c => c.id));
    return { ops: [...transitionsTouching(set).map(t => remove('transitions', t.id)), ...list.map(c => remove('clips', c.id))], message: `Deleted ${plural(list.length, 'clip')}` };
  });
}

function copySelection() {
  const list = selectedClips(); if (!list.length) return;
  clipboard = { base: Math.min(...list.map(startF)), clips: list.map(c => ({ ...strip(c), offset: startF(c) })) };
  say(`Copied ${plural(list.length, 'clip')}`); syncChrome();
}
function free(trackId, s, e, ignore = new Set()) { return clipsOn(trackId).every(o => ignore.has(o.id) || e <= startF(o) || s >= endF(o)); }
function paste() {
  if (!clipboard) return;
  const at = playF, board = clipboard, ids = [];
  edit(() => {
    const ops = [], pre = {}, newTracks = new Map();
    const placed = board.clips.map(c => ({ c, s: at + c.offset - board.base, e: at + c.offset - board.base + toF(c.duration) }));
    const fits = placed.every(p => trackById(p.c.trackId) && !trackById(p.c.trackId).locked && free(p.c.trackId, p.s, p.e));
    for (const { c, s } of placed) {
      let trackId = c.trackId;
      if (!fits) {
        if (!newTracks.has(c.trackId)) { const t = { id: uid('track'), name: `${trackById(c.trackId)?.name || 'Pasted'} copy`, disabled: false, locked: false }; newTracks.set(c.trackId, t.id); ops.push(put('tracks', t)); Object.assign(pre, { [`track:${t.id}`]: 0, [`occupancy:${t.id}`]: 0 }); }
        trackId = newTracks.get(c.trackId);
      }
      const id = uid('clip'); ids.push(id); pre[`clip:${id}`] = 0;
      const { offset, ...value } = c;
      ops.push(put('clips', { ...value, id, trackId, start: fromF(s) }));
    }
    return { ops, pre, message: `Pasted ${plural(placed.length, 'clip')}${fits ? '' : ' on a new track'}` };
  }).then(ok => { if (ok) select(ids); });
}

function moveOps(list, dF, dTrack) {
  const disp = displayTracks(), ids = new Set(list.map(c => c.id)), dest = new Map();
  for (const c of list) {
    const t = disp[disp.findIndex(x => x.id === c.trackId) + dTrack];
    if (!t) return { error: 'No track there' };
    if (t.locked || trackById(c.trackId)?.locked) return { error: `“${(t.locked ? t : trackById(c.trackId)).name}” is locked` };
    dest.set(c.id, t.id);
  }
  for (const c of list) {
    const s = startF(c) + dF, e = endF(c) + dF;
    if (s < 0) return { error: 'Clips cannot start before zero' };
    const clash = clipsOn(dest.get(c.id)).find(o => !ids.has(o.id) && s < endF(o) && e > startF(o));
    if (clash) return { error: `Would overlap “${clipName(clash)}”` };
  }
  const ops = [];
  let dropped = 0;
  for (const t of transitionsTouching(ids)) {
    const both = ids.has(t.fromClipId) && ids.has(t.toClipId) && dest.get(t.fromClipId) === dest.get(t.toClipId);
    if (both) { if (t.trackId !== dest.get(t.fromClipId)) ops.push(put('transitions', { id: t.id, trackId: dest.get(t.fromClipId) })); }
    else if (dF || dTrack) { ops.push(remove('transitions', t.id)); dropped++; }
  }
  for (const c of list) ops.push(put('clips', { id: c.id, start: fromF(startF(c) + dF), trackId: dest.get(c.id) }));
  return { ops, dropped };
}
function commitMove(ids, dF, dTrack) {
  edit(() => {
    const list = ids.map(clipById).filter(Boolean); if (!list.length) return null;
    const res = moveOps(list, dF, dTrack);
    if (res.error) return refuse(res.error);
    const what = `Moved ${plural(list.length, 'clip')}${dF ? ` ${dF > 0 ? '+' : '−'}${shortTc(Math.abs(dF))}` : ''}`;
    return { ops: res.ops, message: res.dropped ? `${what} · removed ${plural(res.dropped, 'dissolve')}` : what };
  });
}
const nudge = n => commitMove([...selection], n, 0);

function toggleMute() {
  const ids = [...selection];
  edit(() => {
    const list = ids.map(clipById).filter(c => c && hasAudio(mediaById(c.mediaId))); if (!list.length) return null;
    const mute = !list.every(c => c.mute);
    return { ops: list.map(c => put('clips', { id: c.id, mute })), message: mute ? 'Muted' : 'Unmuted' };
  });
}
function toggleFill() {
  const ids = [...selection];
  edit(() => {
    const list = ids.map(clipById).filter(c => c && isVisual(mediaById(c.mediaId))); if (!list.length) return null;
    const fit = list.every(c => c.transform?.fit === 'fill') ? 'fit' : 'fill';
    return { ops: list.map(c => put('clips', { id: c.id, transform: { ...(c.transform || {}), fit } })), message: fit === 'fill' ? 'Fill frame' : 'Fit frame' };
  });
}

// Longest dissolve (in frames) the footage around a cut allows.
function dissolveRoom(a, b, alignment = 'center', ignoreId) {
  const ma = mediaById(a.mediaId), mb = mediaById(b.mediaId);
  const outRoom = sourceBound(ma) ? (secs(ma.duration) - secs(a.sourceIn) - secs(a.duration) * secs(a.speed)) / secs(a.speed) : Infinity;
  const inRoom = sourceBound(mb) ? secs(b.sourceIn) / secs(b.speed) : Infinity;
  const occupied = (t, side) => !t || t.id === ignoreId ? 0 : t.alignment === 'center' ? secs(t.duration) / 2 : t.alignment === side ? secs(t.duration) : 0;
  const aRoom = secs(a.duration) - occupied(transitions().find(t => t.toClipId === a.id), 'start');
  const bRoom = secs(b.duration) - occupied(transitions().find(t => t.fromClipId === b.id), 'end');
  const before = Math.min(inRoom, aRoom), after = Math.min(outRoom, bRoom);
  const room = alignment === 'center' ? 2 * Math.min(before, after) : alignment === 'start' ? after : before;
  return Math.max(0, Math.floor(room * fps() + 1e-6));
}
function addDissolve() {
  const scope = selection.size ? new Set(selection) : null, at = playF, id = uid('transition');
  edit(() => {
    const cuts = [];
    for (const a of clips()) for (const b of clipsOn(a.trackId)) {
      if (a.id === b.id || secs(endOf(a)) !== secs(b.start)) continue;
      if (scope && !scope.has(a.id) && !scope.has(b.id)) continue;
      if (transitions().some(t => t.fromClipId === a.id && t.toClipId === b.id) || trackById(a.trackId)?.locked) continue;
      cuts.push({ a, b, f: startF(b) });
    }
    if (!cuts.length) return refuse(scope ? 'The selected clips have no open cut to dissolve' : 'No open cut between adjacent clips');
    const { a, b, f } = cuts.sort((x, y) => Math.abs(x.f - at) - Math.abs(y.f - at))[0];
    const room = dissolveRoom(a, b), wanted = nominal();
    if (room < 2) { toast({ kind: 'error', title: 'No room for a dissolve', body: `There is no spare footage beyond the cut at ${tc(f)}. Trim the clips to create handles.` }); return null; }
    let frames = Math.min(wanted, room); if (frames % 2 && frames > 2) frames--;
    return { ops: [put('transitions', { id, trackId: a.trackId, fromClipId: a.id, toClipId: b.id, duration: fromF(frames), alignment: 'center' })], pre: { [`transition:${id}`]: 0 },
      message: frames < wanted ? `Dissolve at ${tc(f)} limited to ${shortTc(frames)} by available footage` : `Dissolve added at ${tc(f)}` };
  }).then(ok => { if (ok) selectTransition(id); });
}

function addTrack(name) {
  return edit(() => {
    const t = { id: uid('track'), name: name || `Track ${tracks().length + 1}`, disabled: false, locked: false };
    return { ops: [put('tracks', t)], pre: { [`track:${t.id}`]: 0, [`occupancy:${t.id}`]: 0 }, message: `Added “${t.name}”` };
  });
}
function mediaLength(m) { const range=m.metadata?.library; return m.kind === 'graphic' || m.kind === 'image' ? 5 * nominal() : range?.end ? Math.max(1, Math.floor(secs(range.end)*fps()+1e-6)-Math.ceil(secs(range.start)*fps()-1e-6)) : Math.max(1, Math.floor(secs(m.duration) * fps() + 1e-6)); }
function addMediaAt(m, trackId, f) {
  const id = uid('clip');
  edit(() => {
    const len = mediaLength(m), ops = [], pre = { [`clip:${id}`]: 0 };
    let target = trackId && trackById(trackId);
    if (target && (target.locked || !free(target.id, f, f + len))) target = null;
    if (!target) { target = { id: uid('track'), name: stem(mediaName(m)), disabled: false, locked: false }; ops.push(put('tracks', target)); Object.assign(pre, { [`track:${target.id}`]: 0, [`occupancy:${target.id}`]: 0 }); }
    const sourceIn=m.metadata?.library?.start?fromF(Math.ceil(secs(m.metadata.library.start)*fps()-1e-6)):ZERO;
    ops.push(put('clips', { id, trackId: target.id, mediaId: m.id, name: m.metadata?.library?.name||stem(mediaName(m)), start: fromF(Math.max(0, f)), duration: fromF(len), sourceIn, speed: ONE, volume: 1, mute: false, fadeIn: ZERO, fadeOut: ZERO }));
    return { ops, pre, message: `Added “${stem(mediaName(m))}” at ${tc(f)}${trackId && target.id !== trackId ? ' on a new track' : ''}` };
  }).then(ok => { if (ok) select([id]); });
}
// Toggles read the track when the edit runs, so quick repeated clicks alternate correctly.
function toggleTrack(t, key) {
  edit(() => {
    const fresh = trackById(t.id); if (!fresh) return null;
    const on = !fresh[key];
    return { ops: [put('tracks', { id: fresh.id, [key]: on })], message: `${key === 'locked' ? on ? 'Locked' : 'Unlocked' : on ? 'Disabled' : 'Enabled'} “${fresh.name}”` };
  });
}
function changeTrack(t, changes, message) { edit(() => trackById(t.id) ? { ops: [put('tracks', { id: t.id, ...changes })], message } : null); }
function deleteTrack(t) { edit(() => clipsOn(t.id).length ? refuse('Remove the track’s clips first') : { ops: [remove('tracks', t.id)], message: `Deleted “${t.name}”` }); }

// ---------------------------------------------------------------- Rendering jobs
const isDone = s => ['complete', 'completed', 'succeeded'].includes(s);
const isFailed = s => ['failed', 'cancelled', 'canceled'].includes(s);
const jobKind = job => job.kind || job.config?.kind || job.result?.kind || (frameFor.has(job.id) ? 'frame' : 'export');
const jobOutput = job => job.output || job.result?.output || job.config?.output;
function jobFraction(job) {
  const d = job.result || (typeof job.progress === 'object' ? job.progress : job);
  const p = typeof job.progress === 'number' ? job.progress : d.fraction ?? d.progress ?? (d.frame && d.totalFrames ? d.frame / d.totalFrames : 0);
  return Math.max(0, Math.min(1, Number(p) || 0));
}
function requestFrame(delay = 100) { clearTimeout(frameTimer); frameTimer = setTimeout(() => { if (clips().length && !playback.wantsPlay && monitorView === 'frame') playback.seek(secs(fromF(Math.min(playF, lastFrame()))), false); }, delay); }
async function renderFrame(force) {
  playback.pause(false); setMonitorView('frame');
  clearTimeout(frameTimer);
  if (!project() || !clips().length || exportJobId) return;
  if (editsInFlight) { requestFrame(300); return; }
  if (frameJobId) { frameQueued = true; return; }
  const f = Math.min(playF, lastFrame()), revision = project().revision;
  if (!force && shown && shown.f === f && shown.revision === revision) return;
  frameJobId = 'pending'; drawMonitor();
  try {
    const job = await api.render({ kind: 'frame', mode: prefs.renderMode, frameTime: fromF(f) });
    if (!job?.id) { frameJobId = null; drawMonitor(); return; }
    frameJobId = job.id; frameFor.set(job.id, { f, revision });
    await onJob(job);
  } catch (error) { frameJobId = null; drawMonitor(); report(error, 'Frame not rendered'); }
}
async function showFrame(output, info) {
  const img = $('preview');
  img.onload = () => api.ready();
  img.src = await api.mediaUrl(output);
  img.hidden = monitorView !== 'frame';
  shown = info;
  drawMonitor();
}
async function onJob(job, { silent = false } = {}) {
  if (!job?.id) return;
  const kind = jobKind(job), done = isDone(job.status), failed = isFailed(job.status);
  if (job.mode || job.config?.mode) jobModes.set(job.id, job.mode || job.config.mode);
  if (kind === 'frame') {
    if (!done && !failed) { if (!frameJobId || frameJobId === 'pending') frameJobId = job.id; drawMonitor(); return; }
    if (seenJobs.has(job.id)) return; seenJobs.add(job.id);
    if (frameJobId === job.id) frameJobId = null;
    const info = frameFor.get(job.id) || { f: toF(job.frameTime || job.config?.frameTime || job.result?.frameTime), revision: job.projectRevision };
    if (done && jobOutput(job) && !playback.wantsPlay && info.f === Math.min(playF, lastFrame()) && info.revision === project().revision) await showFrame(jobOutput(job), info);
    else if (failed && !silent && job.status === 'failed') report(job.error?.message || job.error || 'Frame render failed', 'Frame not rendered');
    drawMonitor(); syncChrome();
    if (frameQueued) { frameQueued = false; requestFrame(0); }
    return;
  }
  if (!done && !failed) { exportJobId = job.id; exportProgress = jobFraction(job); exportMessage = job.message || ''; syncChrome(); return; }
  if (seenJobs.has(job.id)) return; seenJobs.add(job.id);
  if (exportJobId === job.id) exportJobId = null;
  if (done && jobOutput(job)) {
    finishedExport = jobOutput(job); $('export-tab').hidden = false;
    if (!silent) toast({ kind: 'ok', title: 'Export complete', body: basename(finishedExport), timeout: 12000, actions: [{ label: 'Play', primary: true, run: playExport }, { label: 'Show in folder', run: () => api.showOutput(finishedExport) }] });
  } else if (!silent) {
    const gpu = (jobModes.get(job.id) || prefs.renderMode) === 'gpu' && job.status === 'failed';
    toast({ kind: job.status === 'failed' ? 'error' : 'info', title: job.status === 'failed' ? 'Export failed' : 'Export cancelled', timeout: gpu ? 0 : 8000,
      body: job.status === 'failed' ? `${explain(job.error?.message || job.error || 'Unknown error')} No incomplete file was kept.` : 'No incomplete file was kept. Any earlier export is unchanged.',
      actions: gpu ? [{ label: 'Restart with software', primary: true, run: () => { setRenderMode('software'); openExport(); } }] : [] });
  }
  syncChrome();
  await refresh();
}
async function pollJobs() {
  for (const id of [frameJobId, exportJobId]) {
    if (!id || id === 'pending') continue;
    try { const result = await api.command({ command: 'status', jobId: id }); await onJob(result.job || result); } catch (error) { say(explain(error), 'error'); }
  }
}
setInterval(pollJobs, 700);

function openExport() {
  const hasRange = inF != null || outF != null;
  const state = { range: hasRange ? 'range' : 'all', mode: prefs.renderMode, verification: prefs.verification };
  const rangeFrames = () => state.range === 'range' ? [inF ?? 0, (outF ?? lastFrame()) + 1] : [0, timelineEndF()];
  const summary = h('div', { class: 'dialog-summary' });
  const update = () => { const [s, e] = rangeFrames(); const p = project(); summary.textContent = `${p.resolution.width}×${p.resolution.height} · ${fpsLabel()} fps · H.264 + AAC 48 kHz · ${tc(s)} → ${tc(e)} (${shortTc(e - s)})`; };
  const seg = (key, options) => {
    const box = h('div', { class: 'segmented' });
    const paint = () => [...box.children].forEach((b, i) => b.classList.toggle('on', options[i][0] === state[key]));
    for (const [value, label, tip, disabled] of options) box.append(h('button', { disabled, tip: tip ? { title: label, desc: tip } : null, onclick: () => { state[key] = value; paint(); update(); } }, label));
    paint(); return box;
  };
  const body = h('div', { class: 'dialog-body' },
    h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Range'), seg('range', [['all', 'Entire sequence', 'Everything from 00:00:00:00 to the last clip.'], ['range', 'In to Out', 'Only the range marked with I and O.', !hasRange]])),
    h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Renderer'), seg('mode', [['gpu', 'GPU', 'D3D11 composition and NVENC encoding. Needs a compatible NVIDIA GPU.'], ['software', 'Software', 'CPU composition and x264. Slower, works everywhere.']])),
    h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Verification'), seg('verification', [['quick', 'Quick', 'Check streams, timestamps and durations without decoding. Fast.'], ['full', 'Thorough', 'Also decode and count every frame. Takes longer.']])),
    summary);
  update();
  dialog({ title: 'Export', iconName: 'export', body, foot: ['Choose where to save next'],
    buttons: [{ label: 'Cancel' }, { label: 'Export', kind: 'primary', keys: 'Enter', run: async () => {
      prefs.renderMode = state.mode; prefs.verification = state.verification; savePrefs(); syncChrome();
      const [s, e] = rangeFrames();
      try {
        const job = await api.render({ kind: 'export', mode: state.mode, verification: state.verification, range: state.range === 'range' ? { start: fromF(s), end: fromF(e) } : undefined });
        if (job?.id) { jobModes.set(job.id, state.mode); say('Export started. You can keep reviewing while it renders.'); await onJob(job); }
      } catch (error) { report(error, 'Export not started'); }
    } }] });
}
function cancelExport() { if (exportJobId) perform(() => api.command({ command: 'cancel', jobId: exportJobId }), 'Cancelling export'); }
async function playExport() {
  if (!finishedExport) return;
  const video = $('export-video');
  video.src = await api.mediaUrl(finishedExport);
  setMonitorView('export');
  video.play().catch(error => say(error.message, 'error'));
}
function togglePlay() {
  if (monitorView === 'export' && finishedExport) { const v = $('export-video'); v.paused ? v.play() : v.pause(); return; }
  clearTimeout(frameTimer);
  if (playback.wantsPlay) { playback.pause(); rememberMarks(); }
  else playback.play(secs(fromF(playF)));
}
function setMonitorView(view) {
  if (view !== 'frame') playback.pause(false);
  monitorView = view;
  for (const t of document.querySelectorAll('.monitor .tab')) t.classList.toggle('active', t.dataset.view === view);
  const video = $('export-video');
  if (view !== 'export') video.pause();
  video.hidden = view !== 'export'; video.controls = view === 'export'; syncPlayButton();
  drawMonitor();
}

// ---------------------------------------------------------------- Drawing
function draw() {
  const p = project(); if (!p) return;
  playback.setProject(p, prefs.renderMode);
  if (!p.clips.length) { shown = null; $('preview').removeAttribute('src'); }
  if (firstLoad) {
    const saved = prefs.marks[p.id];
    if (saved) { inF = saved.in ?? null; outF = saved.out ?? null; playF = saved.play ?? 0; } else if (p.clips.length) playF = Math.min(2 * nominal(), lastFrame());
  }
  for (const id of [...selection]) if (!clipById(id)) selection.delete(id);
  if (selTransition && !transitionById(selTransition)) selTransition = null;
  if (firstLoad && !selection.size && p.clips.length) selection.add([...p.clips].sort((a, b) => secs(a.start) - secs(b.start))[0].id);
  playF = Math.min(playF, timelineEndF());
  $('project-name').textContent = p.name;
  document.title = `${p.name} · Reelet`;
  drawMedia(); drawInspector(); drawMonitor(); syncChrome();
  if (drag || editingTrack) deferredDraw = true; else drawTimeline();
  if (!$('history-panel').closest('.tab-page').hidden) drawHistory();
  if (firstLoad) { firstLoad = false; api.ready(); }
}

function syncChrome() {
  for (const el of document.querySelectorAll('[data-action]')) {
    const a = actions[el.dataset.action]; if (!a) continue;
    el.disabled = !can(a.id);
    el.classList.toggle('on', !!a.checked?.());
  }
  $('lock-banner').hidden = !exportJobId;
  const chip = $('job-chip');
  chip.hidden = !exportJobId;
  chip.tip = { title: 'Export in progress', desc: exportMessage || 'Preparing sources', meta: 'You can close the window; the export keeps running.' };
  if (exportJobId) chip.replaceChildren(icon('export', 'sm'), h('span', {}, `Exporting ${Math.round(exportProgress * 100)}%`), h('span', { class: 'bar' }, h('i', { style: { width: `${exportProgress * 100}%` } })),
    h('button', { class: 'icon-button', onclick: cancelExport, tip: { title: 'Cancel export', desc: 'Stops rendering and deletes the incomplete file. A previous export at the same path is kept.' } }, icon('x')));
  const mode = $('mode-chip');
  mode.replaceChildren(icon('chip'), prefs.renderMode === 'gpu' ? 'GPU' : 'CPU');
  mode.tip = { title: prefs.renderMode === 'gpu' ? 'GPU rendering' : 'Software rendering', desc: prefs.renderMode === 'gpu' ? 'Preview uses D3D11 video decoding with software fallback. Exports use NVENC. Click to switch to software.' : 'Preview uses software decoding. Exports use CPU composition and x264. Click to switch to GPU.' };
  const save = $('save-status');
  save.replaceChildren(...(exportJobId ? [icon('lock'), 'Locked for export'] : connected ? [icon('check'), 'Saved'] : ['Offline']));
  save.tip = { title: exportJobId ? 'Edits locked' : 'All edits saved', desc: exportJobId ? 'GUI and CLI edits wait until the export finishes or is cancelled.' : 'Every committed edit is written to project.json immediately. Undo history is shared with the CLI.' };
  drawPlayhead();
}

function drawMedia() {
  const list = $('media-list'), media = project().media, query = $('search').value.trim().toLowerCase();
  const usage = new Map(); for (const c of clips()) usage.set(c.mediaId, (usage.get(c.mediaId) || 0) + 1);
  $('media-count').textContent = media.length || '';
  list.replaceChildren();
  for (const m of media.filter(m => mediaName(m).toLowerCase().includes(query))) {
    const used = usage.get(m.id) || 0, d = secs(m.duration);
    const meta = m.kind === 'image' ? 'still' : d ? shortTc(Math.round(d * fps())) : '—';
    const row = h('div', { class: `media-row ${m.kind} ${used ? '' : 'unused'} ${binSelection === m.id ? 'selected' : ''}`, draggable: 'true', dataset: { id: m.id } },
      icon(kindIcon(m.kind)), h('span', { class: 'name' }, mediaName(m)), h('span', { class: 'meta' }, meta));
    row.tip = () => ({ title: mediaName(m), desc: kindLabel(m.kind) + (used ? ` · used in ${used} clip${used > 1 ? 's' : ''}` : ' · not used yet'),
      meta: [m.metadata?.width ? `${m.metadata.width}×${m.metadata.height}${m.metadata.fps ? ` · ${Math.round(secs(frac(...m.metadata.fps.split('/').map(Number))) * 100) / 100} fps` : ''}` : null, d ? `Duration ${tc(Math.round(d * fps()))}` : null, m.metadata?.authoringPath || m.path].filter(Boolean).join('\n'),
      hint: [{ keys: '#Drag', text: 'to timeline' }, { keys: '#Double-click', text: 'add at playhead' }] });
    row.onclick = () => { binSelection = m.id; list.focus(); drawMedia(); };
    row.ondblclick = () => editable() && addMediaAt(m, null, playF);
    row.oncontextmenu = e => { binSelection = m.id; drawMedia(); contextMenu(e, [{ label: 'Add at playhead on a new track', icon: 'plus', keys: ['Enter'], disabled: !editable(), run: () => addMediaAt(m, null, playF) }, ...(m.metadata?.library ? [{label:'Open in content library',icon:'folder',run:()=>api.library(m.metadata.library.assetId)}]:[]), {label:'Remove from project bin',icon:'x',disabled:!!used||!editable(),run:()=>edit(()=>({ops:[{op:'remove',collection:'media',id:m.id}],pre:{['usage:'+m.id]:snapshot.revisions['usage:'+m.id]||0},message:'Removed from bin'}))}]); };
    row.ondragstart = e => { hideTip(); e.dataTransfer.setData('application/x-reelet-media', m.id); e.dataTransfer.effectAllowed = 'copy'; dragMedia = m; };
    row.ondragend = () => { dragMedia = null; clearDropGhost(); };
    list.append(row);
  }
  if (!media.length) list.append(h('div', { class: 'empty-note' }, 'No media yet.', h('br'), h('button', { class: 'link-button', onclick: () => run('import') }, 'Import media'), ' ', kbd('Ctrl+I')));
  else if (!list.children.length) list.append(h('div', { class: 'empty-note' }, 'Nothing matches that search.'));
}
$('media-list').addEventListener('keydown', e => {
  const media = project()?.media || [], i = media.findIndex(m => m.id === binSelection);
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { binSelection = media[Math.max(0, Math.min(media.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))]?.id; drawMedia(); e.preventDefault(); e.stopPropagation(); }
  else if (e.key === 'Enter' && binSelection && editable()) { addMediaAt(mediaById(binSelection), null, playF); e.preventDefault(); e.stopPropagation(); }
});

async function drawHistory() {
  const panel = $('history-panel');
  let points = [];
  try { points = await api.command({ command: 'checkpoints' }); } catch (error) { say(explain(error), 'error'); }
  const undo = snapshot?.history?.undo || 0, redo = snapshot?.history?.redo || 0;
  const relative = iso => { const s = (Date.now() - new Date(iso)) / 1000; return s < 60 ? 'just now' : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : new Date(iso).toLocaleDateString(); };
  panel.replaceChildren(
    h('div', { class: 'section-title' }, 'Session history'),
    h('div', { class: 'history-counts' },
      h('button', { disabled: !can('undo'), onclick: () => run('undo'), tip: { action: 'undo' } }, icon('undo'), h('b', {}, undo), 'undo'),
      h('button', { disabled: !can('redo'), onclick: () => run('redo'), tip: { action: 'redo' } }, icon('redo'), h('b', {}, redo), 'redo')),
    h('div', { class: 'section-title' }, 'Checkpoints', h('span', { class: 'tab-spacer' }), h('button', { class: 'icon-button small', disabled: !can('checkpoint'), onclick: () => run('checkpoint'), tip: { action: 'checkpoint' } }, icon('plus'))),
    ...(points.length ? [...points].reverse().map(p => h('div', { class: 'history-row' }, icon('flag'),
      h('div', { class: 'grow', tip: { title: p.task, meta: `${new Date(p.createdAt).toLocaleString()}\nProject revision ${p.projectRevision}` } }, h('div', { class: 'task' }, p.task), h('div', { class: 'when' }, relative(p.createdAt))),
      h('button', { class: 'icon-button small', disabled: !editable(), onclick: () => confirmRestore(p), tip: { title: 'Restore this checkpoint', desc: 'Replaces the whole project. Later edits and newer checkpoints are discarded.' } }, icon('restore')))) :
      [h('div', { class: 'empty-note' }, 'No checkpoints yet. Agents create one at the start of each pass.', h('br'), kbd('Ctrl+Shift+S'), ' creates one now.')]));
}
function newCheckpoint() {
  const input = h('input', { placeholder: 'e.g. Before music pass', maxlength: 160 });
  dialog({ title: 'New checkpoint', iconName: 'flag', body: h('div', { class: 'dialog-body' }, h('p', {}, 'Captures the project and graphic code without copying source media. The latest five checkpoints are kept.'), input),
    buttons: [{ label: 'Cancel' }, { label: 'Create', kind: 'primary', keys: 'Enter', run: () => {
      const task = input.value.trim(); if (!task) { input.focus(); return false; }
      perform(() => api.command({ command: 'checkpoint', task }), `Checkpoint “${task}” created`).then(() => drawHistory());
    } }] });
}
function confirmRestore(p) {
  dialog({ title: 'Restore checkpoint?', iconName: 'alert', body: h('div', { class: 'dialog-body' },
    h('p', {}, h('b', { style: { color: 'var(--text)' } }, p.task), ` · ${new Date(p.createdAt).toLocaleString()}`),
    h('p', {}, 'The whole project returns to this point. Every later edit, including manual edits, and every newer checkpoint is discarded. Undo history is cleared. The current state is not saved first.'),
    h('p', {}, 'Source media files are not touched.')),
    buttons: [{ label: 'Cancel' }, { label: 'Restore and discard later edits', kind: 'danger', run: () => {
      perform(() => api.command({ command: 'restore', checkpointId: p.id, confirmation: 'discard-later-edits' }), `Restored “${p.task}”`).then(() => drawHistory());
    } }] });
}

function drawMonitor() {
  const p = project(); if (!p) return;
  const busy = !!frameJobId || playback.busy, cur = Math.min(playF, lastFrame());
  const stale = !!shown && !playback.wantsPlay && (shown.f !== cur || shown.revision !== p.revision);
  const state = $('frame-state');
  state.className = `frame-state ${busy ? 'busy' : stale ? 'stale' : ''}`;
  state.replaceChildren();
  if (monitorView === 'export') state.append(icon('export'), basename(finishedExport));
  else if (busy) state.append(icon('render'), playback.busy ? (playback.ready ? 'Seeking' : playback.audioDirty ? 'Updating audio' : 'Preparing preview') : `Rendering ${tc(cur)}`);
  else if (playback.wantsPlay) state.append(icon('play'), 'Playing');
  else if (stale) state.append(icon('alert'), shown.f !== cur ? 'Not at playhead' : 'Edited since render', kbd('Enter'));
  else if (shown) state.append(h('span', {}, `Frame ${tc(shown.f)}`));
  state.tip = monitorView === 'export' ? null : busy ? { title: 'Rendering exact frame', desc: frameJobId ? 'Full-resolution frame from original media.' : 'Preview uses the same composition and timing as export.' } : stale ? { action: 'renderFrame', desc: 'The image shows an earlier frame or project state. Render to update it.' } : null;
  $('stage').classList.toggle('stale', stale && monitorView === 'frame');
  $('stage-busy').hidden = !busy;
  $('preview').hidden = monitorView !== 'frame' || !shown || shown.native;
  $('native-preview').hidden = monitorView !== 'frame' || !shown?.native;
  const empty = $('stage-empty');
  empty.hidden = monitorView !== 'frame' || !!shown;
  if (!empty.hidden) empty.replaceChildren(icon(clips().length ? 'render' : 'layers'), h('div', {}, clips().length ? h('span', {}, 'Press ', kbd('Space'), ' to play the timeline') : 'Drag media onto the timeline to start your edit'));
  $('duration').textContent = tc(timelineEndF());
  $('duration').tip = { title: 'Sequence duration', meta: `${p.resolution.width}×${p.resolution.height} · ${fpsLabel()} fps` };
  drawPlayhead();
}

function drawPlayhead() {
  if (!project()) return;
  const tcInput = $('timecode');
  if (document.activeElement !== tcInput) tcInput.value = tc(playF);
  $('tl-timecode').textContent = tc(playF);
  const total = Math.max(1, timelineEndF());
  $('mini-playhead').style.left = `${100 * Math.min(playF, total) / total}%`;
  const range = $('mini-range'), hasRange = inF != null || outF != null;
  range.hidden = !hasRange;
  if (hasRange) { const s = inF ?? 0, e = (outF ?? lastFrame()) + 1; range.style.left = `${100 * s / total}%`; range.style.width = `${100 * Math.max(0, e - s) / total}%`; }
  const x = frameX(playF);
  $('playhead').style.left = `${x}px`;
  const head = document.querySelector('.ruler-head'); if (head) head.style.left = `${x}px`;
  const rr = document.querySelector('.ruler-range'), tr = $('tl-range');
  if (rr) rr.hidden = !hasRange;
  tr.hidden = !hasRange;
  if (hasRange) { const s = frameX(inF ?? 0), e = frameX((outF ?? lastFrame()) + 1); for (const el of [rr, tr]) if (el) { el.style.left = `${s}px`; el.style.width = `${Math.max(1, e - s)}px`; } }
}

// ---------------------------------------------------------------- Inspector
let inspectorKey = '';
function numberInput({ value, format, parse, step = 1, big = 10, min = -Infinity, max = Infinity, onCommit, disabled, tip }) {
  let current = value;
  const input = h('input', { class: 'numeric', value: format(value), disabled, spellcheck: 'false', tip });
  const set = v => { current = Math.max(min, Math.min(max, v)); input.value = format(current); };
  const commit = () => {
    const parsed = parse(input.value, value);
    if (parsed == null || !Number.isFinite(parsed)) { input.classList.add('invalid'); setTimeout(() => input.classList.remove('invalid'), 900); input.value = format(value); current = value; return; }
    const v = Math.max(min, Math.min(max, parsed));
    input.value = format(v);
    if (v !== value) { value = v; onCommit(v); }
  };
  input.onfocus = () => setTimeout(() => input.select(), 0);
  input.onkeydown = e => {
    if (e.key === 'Enter') { e.preventDefault(); commit(); input.blur(); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); input.value = format(value); current = value; input.blur(); }
    else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { e.preventDefault(); const base = parse(input.value, value) ?? current; set(base + (e.key === 'ArrowUp' ? 1 : -1) * (e.shiftKey ? big : step)); }
  };
  input.onblur = commit;
  input.scrub = (dx, mods, start) => set(start + Math.round(dx / (mods.alt ? 8 : 2)) * (mods.shift ? big : step));
  input.scrubStart = () => parse(input.value, value) ?? value;
  input.scrubEnd = commit;
  return input;
}
function field(label, control, { tip, unit } = {}) {
  const lab = h('span', { class: `field-label ${control?.scrub ? 'scrub' : ''}` }, label);
  if (control?.scrub && !control.disabled) {
    lab.tip = { title: label, desc: tip, hint: [{ keys: '#Drag', text: 'to scrub' }, { keys: 'Shift', text: 'faster' }, { keys: 'Alt', text: 'finer' }, { keys: ['Up', 'Down'], text: 'step' }] };
    lab.onpointerdown = e => {
      e.preventDefault(); const x0 = e.clientX, start = control.scrubStart(); let moved = false;
      lab.setPointerCapture(e.pointerId);
      lab.onpointermove = ev => { if (Math.abs(ev.clientX - x0) > 2) moved = true; if (moved) control.scrub(ev.clientX - x0, { shift: ev.shiftKey, alt: ev.altKey }, start); };
      lab.onpointerup = () => { lab.onpointermove = lab.onpointerup = null; if (moved) control.scrubEnd(); else control.focus(); };
    };
  } else if (tip) lab.tip = { title: label, desc: tip };
  return h('div', { class: 'field' }, lab, h('div', { class: 'field-value' }, control, unit ? h('span', { class: 'unit' }, unit) : null));
}
const timeInput = (frames, onCommit, opts = {}) => numberInput({ value: frames, format: tc, parse: (t, base) => parseTime(t, base), step: 1, big: nominal(), min: opts.min ?? 0, max: opts.max, onCommit, disabled: opts.disabled,
  tip: { title: 'Timecode', desc: 'Type timecode (00:00:02:15), seconds (2.5), frames (75f) or a relative change (+12 / -12 frames).' } });
const plainNumber = (value, decimals, onCommit, opts = {}) => numberInput({ value, format: v => v.toFixed(decimals), parse: t => { const v = Number(String(t).replace(/[^\d.+-]/g, '')); return String(t).trim() === '' ? null : v; }, step: opts.step ?? 1, big: opts.big ?? 10, min: opts.min, max: opts.max, onCommit, disabled: opts.disabled });
function segmented(options, value, onPick, disabled) {
  return h('div', { class: 'segmented' }, options.map(([v, label, tip]) => h('button', { class: v === value ? 'on' : '', disabled, tip: tip ? { title: label, desc: tip } : null, onclick: () => v !== value && onPick(v) }, label)));
}
function chip(id, label, cls = '') { const a = actions[id]; return h('button', { class: `chip-button ${cls}`, dataset: { action: id }, disabled: !can(id), onclick: () => run(id), tip: { action: id } }, a.icon ? icon(a.icon, 'sm') : null, label || a.label, kbd(a.keys[0])); }

function drawInspector() {
  const p = project(); if (!p) return;
  const box = $('inspector');
  const list = selectedClips(), tr = selTransition && transitionById(selTransition);
  const key = tr ? `t:${tr.id}:${tr.revision}` : list.length === 1 ? `c:${list[0].id}:${list[0].revision}:${list[0].trackId}` : list.length ? `m:${list.map(c => c.id).join()}` : `p:${p.revision}`;
  if (box.contains(document.activeElement) && document.activeElement.matches('input') && key.split(':').slice(0, 2).join() === inspectorKey.split(':').slice(0, 2).join()) return;
  inspectorKey = key;
  const scroll = box.scrollTop;
  box.replaceChildren();
  $('inspector-kind').replaceChildren();
  if (tr) drawTransitionInspector(box, tr);
  else if (list.length === 1) drawClipInspector(box, list[0]);
  else if (list.length > 1) {
    $('inspector-title').textContent = 'Inspector';
    box.append(h('div', { class: 'insp-head' }, icon('layers'), h('strong', {}, `${list.length} clips selected`)),
      h('div', { class: 'insp-note' }, `${tc(Math.min(...list.map(startF)))} → ${tc(Math.max(...list.map(endF)))}`),
      h('div', { class: 'insp-actions' }, chip('copy'), chip('mute', 'Mute'), chip('nudgeLeft', 'Nudge'), chip('delete', null, 'danger')),
      h('div', { class: 'insp-note' }, 'Drag any selected clip to move them together. Alt + arrows nudge by a frame.'));
  } else drawSequenceInspector(box, p);
  box.scrollTop = scroll;
}
function drawClipInspector(box, c) {
  const m = mediaById(c.mediaId), locked = !!trackById(c.trackId)?.locked || !editable();
  const durF = endF(c) - startF(c), speed = secs(c.speed);
  // `changes` may be a function of the clip as it is when the edit runs.
  const putClip = (changes, message) => edit(() => { const fresh = clipById(c.id); return fresh ? { ops: [put('clips', { id: c.id, ...(typeof changes === 'function' ? changes(fresh) : changes) })], message } : null; });
  $('inspector-title').textContent = 'Clip';
  $('inspector-kind').append(icon(kindIcon(m?.kind), 'sm'), kindLabel(m?.kind));
  const name = h('input', { value: clipName(c), maxlength: 160, disabled: locked, spellcheck: 'false', tip: { title: 'Clip name', desc: 'Shown on the timeline. Agents see this name through the CLI.' } });
  name.onkeydown = e => { if (e.key === 'Enter') name.blur(); if (e.key === 'Escape') { name.value = clipName(c); name.blur(); } };
  name.onblur = () => { const v = name.value.trim(); if (v && v !== clipName(c)) putClip({ name: v }, 'Clip renamed'); else name.value = clipName(c); };
  box.append(h('div', { class: 'insp-head' }, icon(kindIcon(m?.kind)), name), h('div', { class: 'insp-source', tip: { title: mediaName(m), meta: m?.metadata?.authoringPath || m?.path } }, `${mediaName(m)} · track “${trackById(c.trackId)?.name}”`));
  if (locked && editable()) box.append(h('div', { class: 'insp-note warn' }, 'This track is locked. Unlock it in the track header to edit.'));

  const maxDur = sourceBound(m) ? Math.floor((secs(m.duration) - secs(c.sourceIn)) / speed * fps() + 1e-6) : undefined;
  const timing = h('div', { class: 'insp-section' }, h('div', { class: 'section-title' }, 'Timing'),
    field('Start', timeInput(startF(c), f => putClip({ start: fromF(f) }, `Start ${tc(f)}`), { disabled: locked }), { tip: 'Where the clip begins on the timeline.' }),
    field('Duration', timeInput(durF, f => { const d = fromF(f); putClip(fresh => ({ duration: d, ...fadeClamp(fresh, d) }), `Duration ${shortTc(f)}`); }, { min: 1, max: maxDur, disabled: locked }), { tip: 'Length on the timeline. Speed stays the same, so this trims or extends the source.' }),
    ...(m?.kind === 'image' ? [] : [field('Source in', timeInput(toF(c.sourceIn), f => putClip({ sourceIn: fromF(f) }, `Source in ${tc(f)}`), { disabled: locked, max: sourceBound(m) ? Math.floor((secs(m.duration) - secs(c.duration) * speed) * fps() + 1e-6) : undefined }), { tip: 'The first source frame used, measured in the source media.' }),
      field('Speed', plainNumber(speed * 100, 1, v => {
        const next = frac(Math.round(v * 10), 1000), dur = Math.max(1, Math.floor(durF * speed / secs(next) + 1e-6));
        putClip(fresh => ({ speed: next, duration: fromF(dur), ...fadeClamp(fresh, fromF(dur)) }), `Speed ${pct(secs(next))}`);
      }, { min: 1, max: 1600, step: 1, big: 10, disabled: locked }), { unit: '%', tip: 'Keeps the same source section and changes duration to match. Audio pitch follows speed. Shift-dragging a clip edge does the same on the timeline.' })]));
  box.append(timing);

  if (hasAudio(m)) box.append(h('div', { class: 'insp-section' }, h('div', { class: 'section-title' }, 'Audio', h('span', { class: 'tab-spacer' }),
      h('button', { class: `icon-button small ${c.mute ? 'warn' : ''}`, disabled: locked, onclick: () => putClip({ mute: !c.mute }, c.mute ? 'Unmuted' : 'Muted'), tip: { action: 'mute', title: c.mute ? 'Unmute' : 'Mute' } }, icon(c.mute ? 'mute' : 'volume'))),
    field('Volume', numberInput({ value: c.volume <= 0 ? -60 : Math.max(-60, 20 * Math.log10(c.volume)), format: v => v <= -60 ? '-∞' : v.toFixed(1), parse: t => /^-?\s*(inf|∞)/i.test(String(t).trim()) ? -60 : Number.isFinite(Number(t)) && String(t).trim() !== '' ? Number(t) : null, step: .5, big: 3, min: -60, max: 24, disabled: locked,
      onCommit: db => putClip({ volume: db <= -60 ? 0 : Math.min(16, 10 ** (db / 20)) }, `Volume ${db <= -60 ? '-∞' : db.toFixed(1)} dB`) }), { unit: 'dB', tip: '0 dB is the source level. Type -inf to silence.' }),
    field('Fade in', timeInput(toF(c.fadeIn), f => putClip({ fadeIn: fromF(f) }, `Fade in ${shortTc(f)}`), { max: durF, disabled: locked }), { tip: 'Ramps picture and sound up from silence/black at the clip start.' }),
    field('Fade out', timeInput(toF(c.fadeOut), f => putClip({ fadeOut: fromF(f) }, `Fade out ${shortTc(f)}`), { max: durF, disabled: locked }), { tip: 'Ramps down to silence/black at the clip end.' })));
  else if (m?.kind !== 'audio') box.append(h('div', { class: 'insp-section' }, h('div', { class: 'section-title' }, 'Fades'),
    field('Fade in', timeInput(toF(c.fadeIn), f => putClip({ fadeIn: fromF(f) }, `Fade in ${shortTc(f)}`), { max: durF, disabled: locked })),
    field('Fade out', timeInput(toF(c.fadeOut), f => putClip({ fadeOut: fromF(f) }, `Fade out ${shortTc(f)}`), { max: durF, disabled: locked }))));

  if (isVisual(m)) {
    const t = c.transform || {}, setT = (k, v, message) => putClip(fresh => ({ transform: { ...(fresh.transform || {}), [k]: v } }), message);
    box.append(h('div', { class: 'insp-section' }, h('div', { class: 'section-title' }, 'Transform'),
      field('Position', h('div', { class: 'field-pair' }, plainNumber(t.x ?? 0, 0, v => setT('x', v, `X ${v}`), { disabled: locked }), plainNumber(t.y ?? 0, 0, v => setT('y', v, `Y ${v}`), { disabled: locked })), { tip: 'Offset in pixels from the centered layout, X then Y.' }),
      field('Scale', plainNumber((t.scale ?? 1) * 100, 1, v => setT('scale', v / 100, `Scale ${v}%`), { min: 1, max: 1000, disabled: locked }), { unit: '%' }),
      field('Rotation', plainNumber(t.rotation ?? 0, 1, v => setT('rotation', v, `Rotation ${v}°`), { step: 1, big: 15, disabled: locked }), { unit: '°' }),
      field('Opacity', plainNumber((t.opacity ?? 1) * 100, 0, v => setT('opacity', v / 100, `Opacity ${v}%`), { min: 0, max: 100, disabled: locked }), { unit: '%' }),
      field('Framing', segmented([['fit', 'Fit', 'Show the whole picture, letterboxing if needed.'], ['fill', 'Fill', 'Cover the frame and crop the excess.']], t.fit || 'fit', v => setT('fit', v, v === 'fill' ? 'Fill frame' : 'Fit frame'), locked), { tip: 'Shift+F toggles.' })));
  }
  box.append(h('div', { class: 'insp-actions' }, chip('split', 'Split'), chip('dissolve', 'Dissolve'), chip('copy'), chip('delete', null, 'danger')));
}
function drawTransitionInspector(box, t) {
  const a = clipById(t.fromClipId), b = clipById(t.toClipId), locked = !!trackById(t.trackId)?.locked || !editable();
  $('inspector-title').textContent = 'Transition';
  $('inspector-kind').append(icon('dissolve', 'sm'), 'Dissolve');
  const room = alignment => dissolveRoom(a, b, alignment, t.id);
  box.append(h('div', { class: 'insp-head' }, icon('dissolve'), h('strong', {}, 'Cross dissolve')),
    h('div', { class: 'insp-source' }, `${clipName(a)} → ${clipName(b)}`),
    h('div', { class: 'insp-section' }, h('div', { class: 'section-title' }, 'Timing'),
      field('Duration', timeInput(toF(t.duration), f => edit([put('transitions', { id: t.id, duration: fromF(f) })], `Dissolve ${shortTc(f)}`), { min: 1, max: room(t.alignment), disabled: locked }), { tip: 'Uses source frames beyond each clip edge. Timeline length does not change.' }),
      field('Alignment', segmented([['start', 'Start', 'Begins at the cut and runs into the next clip.'], ['center', 'Center', 'Centered on the cut (default).'], ['end', 'End', 'Ends at the cut.']], t.alignment, v => {
        const max = room(v);
        if (max < toF(t.duration)) { say(`Only ${shortTc(max)} of footage is available for “${v}” alignment`, 'warn'); return; }
        edit([put('transitions', { id: t.id, alignment: v })], `Alignment ${v}`);
      }, locked))),
    h('div', { class: 'insp-note' }, `Up to ${shortTc(room(t.alignment))} with the footage available at this cut.`),
    h('div', { class: 'insp-actions' }, chip('delete', null, 'danger')));
}
function drawSequenceInspector(box, p) {
  $('inspector-title').textContent = 'Sequence';
  const disabled = !editable();
  const name = h('input', { value: p.name, maxlength: 160, disabled, spellcheck: 'false', tip: { title: 'Project name' } });
  name.onkeydown = e => { if (e.key === 'Enter') name.blur(); if (e.key === 'Escape') { name.value = p.name; name.blur(); } };
  name.onblur = () => { const v = name.value.trim(); if (v && v !== p.name) edit([{ op: 'project', value: { name: v } }], 'Project renamed'); else name.value = p.name; };
  const rates = [['24000/1001', '23.976'], ['24/1', '24'], ['25/1', '25'], ['30000/1001', '29.97'], ['30/1', '30'], ['50/1', '50'], ['60000/1001', '59.94'], ['60/1', '60']];
  const current = `${p.fps.num}/${p.fps.den}`;
  if (!rates.some(r => r[0] === current)) rates.push([current, fpsLabel()]);
  const rateSelect = h('select', { disabled, onchange: e => { const [num, den] = e.target.value.split('/').map(Number); edit([{ op: 'project', value: { fps: { num, den } } }], `Frame rate ${e.target.selectedOptions[0].textContent} fps`); } }, rates.map(([v, l]) => h('option', { value: v, selected: v === current }, `${l} fps`)));
  const dim = (k, other) => plainNumber(p.resolution[k], 0, v => {
    if (v % 2) { say('Width and height must be even numbers', 'warn'); drawInspector(); return; }
    edit([{ op: 'project', value: { resolution: { ...p.resolution, [k]: v } } }], `Resolution ${k === 'width' ? v : other}×${k === 'height' ? v : other}`);
  }, { min: 16, max: 4096, step: 2, big: 64, disabled });
  box.append(h('div', { class: 'insp-head' }, icon('sliders'), name),
    h('div', { class: 'insp-section' }, h('div', { class: 'section-title' }, 'Format'),
      field('Resolution', h('div', { class: 'field-pair' }, dim('width', p.resolution.height), dim('height', p.resolution.width)), { tip: 'Width × height in pixels. Same-aspect changes keep the composition proportional.' }),
      field('Frame rate', rateSelect, { tip: 'Changing it keeps every cut at the same time in seconds. Later edits snap to the new frame grid.' }),
      field('Duration', h('span', { class: 'numeric', style: { font: '11.5px var(--mono)', color: 'var(--text-2)' } }, tc(timelineEndF())))),
    h('div', { class: 'insp-section' }, h('div', { class: 'section-title' }, 'Contents'),
      h('div', { class: 'insp-note', style: { marginTop: 0 } }, `${p.tracks.length} tracks · ${p.clips.length} clips · ${p.transitions.length} dissolves · ${p.media.length} media`)),
    h('div', { class: 'insp-note' }, 'Select a clip to edit its timing, audio and framing.'));
}

// ---------------------------------------------------------------- Timeline
const lanesWidth = () => Math.max(200, $('tl-scroll').clientWidth - HEAD_W);
const frameX = f => f / fps() * pps;
const xFrame = x => Math.round(x / pps * fps());
function contentWidth() {
  const endS = Math.max(timelineEndF() / fps(), 5);
  return fitZoom ? lanesWidth() : Math.max(lanesWidth(), Math.ceil(endS * pps + lanesWidth() * .5));
}
function drawRuler(width) {
  const ruler = $('ruler'), n = nominal();
  ruler.style.width = `${width}px`;
  const steps = [1, 2, 5, 10, ...(n % 3 === 0 ? [n / 3, n / 2].filter(Number.isInteger) : [Math.round(n / 2)]), ...[1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800, 3600].map(s => s * n)].sort((a, b) => a - b);
  const step = steps.find(s => frameX(s) >= 84) || steps.at(-1);
  const minor = [5, 4, 3, 2].find(d => step % d === 0 && frameX(step / d) >= 8);
  const parts = [];
  const total = xFrame(width) + step;
  for (let f = 0; f <= total; f += step) {
    const label = step % n === 0 ? tc(f).slice(0, -3).replace(/^00:/, '') : shortTc(f);
    parts.push(h('div', { class: 'tick major', style: { left: `${frameX(f)}px` } }, h('span', {}, label)));
    if (minor) for (let i = 1; i < minor; i++) parts.push(h('div', { class: 'tick', style: { left: `${frameX(f + i * step / minor)}px` } }));
  }
  ruler.replaceChildren(...parts, h('div', { class: 'ruler-range', hidden: true }), h('div', { class: 'ruler-head' }));
}
function drawTimeline() {
  const p = project(); if (!p) return;
  if (drag || editingTrack) { deferredDraw = true; return; }
  deferredDraw = false;
  if (fitZoom) pps = Math.max(2, (lanesWidth() - 24) / Math.max(timelineEndF() / fps(), 5));
  const width = contentWidth();
  $('tl-inner').style.width = `${HEAD_W + width}px`;
  drawRuler(width);
  const host = $('tracks'), overlay = $('tl-overlay');
  host.replaceChildren(overlay);
  overlay.style.width = `${width}px`;
  for (const t of displayTracks()) host.append(trackRow(t, width));
  if (!p.tracks.length) host.append(h('div', { class: 'tl-empty-note' }, 'Drag media here from the bin, or double-click it to add it at the playhead.'));
  $('tl-empty').style.width = `${HEAD_W + width}px`;
  drawPlayhead(); pinLabels();
}
// Keep clip names readable when a clip starts left of the visible area.
function pinLabels() {
  const left = $('tl-scroll').scrollLeft;
  for (const body of document.querySelectorAll('.clip-body')) {
    const clip = body.parentElement, x = clip.offsetLeft, w = clip.offsetWidth;
    body.style.left = left > x ? `${7 + Math.min(left - x, Math.max(0, w - 60))}px` : '';
  }
}
function trackRow(t, width) {
  const nameEl = h('span', { class: 'track-name', ondblclick: () => renameTrack(t, nameEl) }, t.name);
  nameEl.tip = { title: t.name, desc: `Track ${trackLabel(t)} of ${tracks().length}. Higher tracks draw over lower ones; audio from every enabled track is mixed.`, hint: [{ keys: '#Double-click', text: 'rename' }, { keys: '#Right-click', text: 'track options' }] };
  const locked = !editable();
  const head = h('div', { class: 'track-head', oncontextmenu: e => contextMenu(e, trackMenu(t)) },
    h('span', { class: 'track-index' }, trackLabel(t)), nameEl,
    h('button', { class: `icon-button ${t.disabled ? 'off' : ''}`, disabled: locked || t.locked, onclick: () => toggleTrack(t, 'disabled'),
      tip: { title: t.disabled ? 'Enable track' : 'Disable track', desc: 'Disabling hides the picture and silences the audio. Clips stay editable.' } }, icon(t.disabled ? 'eye-off' : 'eye')),
    h('button', { class: `icon-button ${t.locked ? 'off' : ''}`, disabled: locked, onclick: () => toggleTrack(t, 'locked'),
      tip: { title: t.locked ? 'Unlock track' : 'Lock track', desc: 'Locked tracks reject every GUI and CLI edit, including agent batches.' } }, icon(t.locked ? 'lock' : 'unlock')));
  const lane = h('div', { class: `lane ${tool === 'razor' ? 'razor' : ''}`, style: { width: `${width}px` }, dataset: { track: t.id } });
  lane.tip = { title: 'Track', hint: tool === 'razor' ? [{ text: 'Click a clip to split it' }] : [{ keys: '#Click', text: 'move playhead' }, { keys: '#Drag', text: 'box select' }, { keys: '#Right-click', text: 'paste / add track' }] };
  lane.oncontextmenu = e => { if (!e.target.closest('.clip, .xfade')) contextMenu(e, [{ action: 'paste' }, { action: 'addTrack' }, '-', { action: 'selectAll' }]); };
  for (const c of clipsOn(t.id)) lane.append(clipBlock(c, t));
  for (const tr of transitions().filter(x => x.trackId === t.id)) {
    const b = clipById(tr.toClipId); if (!b) continue;
    const d = secs(tr.duration), before = tr.alignment === 'start' ? 0 : tr.alignment === 'end' ? d : d / 2;
    const w = d * pps;
    const el = h('div', { class: `xfade ${selTransition === tr.id ? 'selected' : ''}`, dataset: { id: tr.id }, style: { left: `${(secs(b.start) - before) * pps}px`, width: `${Math.max(4, w)}px` } }, w > 18 ? icon('dissolve') : null);
    el.tip = { title: 'Cross dissolve', follow: true, meta: `Duration ${shortTc(toF(tr.duration))} · ${tr.alignment}`, hint: [{ keys: '#Click', text: 'select' }, { keys: 'Delete', text: 'remove' }] };
    el.oncontextmenu = e => { selectTransition(tr.id); contextMenu(e, [{ action: 'delete' }]); };
    lane.append(el);
  }
  return h('div', { class: `track ${t.disabled ? 'disabled' : ''} ${t.locked ? 'locked' : ''}`, dataset: { track: t.id } }, head, lane);
}
function clipBlock(c, t) {
  const m = mediaById(c.mediaId), left = secs(c.start) * pps, width = Math.max(2, secs(c.duration) * pps), speed = secs(c.speed);
  const badges = [];
  if (Math.abs(speed - 1) > 1e-9) badges.push(h('span', { class: 'clip-badge' }, icon('speed'), pct(speed)));
  if (c.mute) badges.push(h('span', { class: 'clip-badge' }, icon('mute')));
  const el = h('div', { class: `clip ${m?.kind || 'missing'} ${selection.has(c.id) ? 'selected' : ''} ${t.locked ? 'locked' : ''}`, dataset: { id: c.id }, style: { left: `${left}px`, width: `${width}px` } },
    width > 30 ? h('div', { class: 'clip-body' }, icon(kindIcon(m?.kind)), h('span', { class: 'clip-name' }, clipName(c)), width > 110 ? h('span', { class: 'clip-badges' }, badges) : null) : null,
    !hasAudio(m) && width > 70 && prefs.trackH >= 44 ? h('span', { class: 'clip-meta' }, shortTc(endF(c) - startF(c))) : null,
    secs(c.fadeIn) > 0 ? h('i', { class: 'fade in', style: { width: `${secs(c.fadeIn) * pps}px` } }) : null,
    secs(c.fadeOut) > 0 ? h('i', { class: 'fade out', style: { width: `${secs(c.fadeOut) * pps}px` } }) : null,
    t.locked ? null : h('i', { class: 'handle l' }), t.locked ? null : h('i', { class: 'handle r' }));
  if (hasAudio(m)) addAudioControls(el, c, t);
  el.tip = () => ({ title: clipName(c), follow: true, desc: `${kindLabel(m?.kind)} · ${mediaName(m)}`,
    meta: [`Start ${tc(startF(c))}   End ${tc(endF(c))}`, `Duration ${tc(endF(c) - startF(c))}   Source in ${tc(toF(c.sourceIn))}`, [Math.abs(speed - 1) > 1e-9 ? `Speed ${pct(speed)}` : null, hasAudio(m) ? `Volume ${toDb(c.volume)} dB${c.mute ? ' (muted)' : ''}` : null].filter(Boolean).join('   ')].filter(Boolean).join('\n'),
    hint: t.locked ? [{ text: 'Track is locked' }] : tool === 'razor' ? [{ keys: '#Click', text: 'split here' }, { keys: 'V', text: 'selection tool' }] : [{ keys: '#Drag', text: 'move' }, { keys: '#Drag edge', text: 'trim' }, { keys: ['Shift', '#+ edge'], text: 'stretch speed' }, { keys: 'Alt', text: 'no snap' }, { keys: 'Ctrl+K', text: 'split' }] });
  el.oncontextmenu = e => { if (!selection.has(c.id)) select([c.id]); contextMenu(e, [{ action: 'split' }, { action: 'dissolve' }, '-', { action: 'mute' }, { action: 'fill' }, '-', { action: 'copy' }, { action: 'paste' }, { action: 'delete' }]); };
  return el;
}
const waveformRequests = new Map();
function volumePosition(volume) {
  const db = volume > 0 ? Math.max(-60, 20 * Math.log10(volume)) : -60;
  return (24 - db) / 84 * 100;
}
function paintAudioControls(el, c) {
  const area = el.querySelector('.clip-audio');
  if (!area) return;
  area.querySelector('.volume-line').style.top = `${volumePosition(c.volume)}%`;
  area.style.opacity = c.mute ? '.35' : '1';
  const duration = secs(c.duration);
  for (const field of ['fadeIn', 'fadeOut']) {
    const fraction = secs(c[field]) / duration;
    area.querySelector(`[data-audio="${field}"]`).style.left = `${100 * (field === 'fadeIn' ? fraction : 1 - fraction)}%`;
    const side = field === 'fadeIn' ? 'in' : 'out';
    let shade = el.querySelector(`.fade.${side}`);
    if (!shade) {
      shade = h('i', { class: `fade ${side}` });
      el.insertBefore(shade, area);
    }
    shade.style.width = `${secs(c[field]) * pps}px`;
    shade.hidden = fraction === 0;
  }
  const canvas = area.querySelector('canvas'), ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (!canvas.peaks) return;
  ctx.strokeStyle = '#c5e6da'; ctx.globalAlpha = .65; ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = 0; x < canvas.width; x++) {
    const time = (x + .5) / canvas.width * duration;
    const fade = (secs(c.fadeIn) ? window.ReeletTimeline.easeInOut(time / secs(c.fadeIn)) : 1) * (secs(c.fadeOut) ? window.ReeletTimeline.easeInOut((duration - time) / secs(c.fadeOut)) : 1);
    const peak = Math.min(1, canvas.peaks[x] * c.volume * fade) * (canvas.height / 2 - 1);
    ctx.moveTo(x + .5, canvas.height / 2 - peak); ctx.lineTo(x + .5, canvas.height / 2 + peak);
  }
  ctx.stroke();
}
function addAudioControls(el, c, t) {
  const canvas = h('canvas', { width: 2048, height: 64, class: 'clip-waveform' });
  const area = h('div', { class: 'clip-audio' }, canvas,
    h('div', { class: 'volume-line', dataset: { audio: 'volume' }, title: 'Drag up/down to adjust volume' }),
    h('div', { class: 'audio-fade in', dataset: { audio: 'fadeIn' }, title: 'Drag to set fade in (Ease In/Out)' }),
    h('div', { class: 'audio-fade out', dataset: { audio: 'fadeOut' }, title: 'Drag to set fade out (Ease In/Out)' }));
  if (t.locked || !editable()) area.classList.add('audio-locked');
  el.append(area);
  paintAudioControls(el, c);
  const m = mediaById(c.mediaId);
  const key = JSON.stringify([c.mediaId, m?.revision, c.sourceIn, c.duration, c.speed]);
  if (!waveformRequests.has(key)) {
    waveformRequests.set(key, api.waveform(c.id).then(peaks => ({ peaks }), error => ({ error: error.message })));
    while (waveformRequests.size > 64) waveformRequests.delete(waveformRequests.keys().next().value);
  }
  area.dataset.status = 'Preparing waveform';
  waveformRequests.get(key).then(result => {
    if (result.error) { area.dataset.status = 'Waveform unavailable'; area.title = result.error; return; }
    delete area.dataset.status;
    canvas.peaks = result.peaks;
    paintAudioControls(el, drag?.type === 'audio' && drag.c.id === c.id ? { ...c, ...drag.changes } : c);
  });
}
function beginAudioDrag(e, c, field) {
  playback.pause();
  const el = document.querySelector(`.clip[data-id="${c.id}"]`);
  startDrag({ type: 'audio', c, field, el, x0: e.clientX, y0: e.clientY,
    height: el.querySelector('.clip-audio').getBoundingClientRect().height, changes: null });
  hintItems([{ keys: 'Escape', text: 'cancel' }]);
}
function audioDrag(e) {
  const d = drag;
  if (d.field === 'volume') {
    const initial = d.c.volume > 0 ? Math.max(-60, 20 * Math.log10(d.c.volume)) : -60;
    const db = Math.max(-60, Math.min(24, initial + (d.y0 - e.clientY) / d.height * 84));
    d.changes = { volume: db <= -60 ? 0 : 10 ** (db / 20) };
    readout(`Volume ${toDb(d.changes.volume)} dB`);
  } else {
    const delta = xFrame(e.clientX - d.x0) * (d.field === 'fadeIn' ? 1 : -1);
    const frames = Math.max(0, Math.min(Math.floor(secs(d.c.duration) * fps() + 1e-8), toF(d.c[d.field]) + delta));
    d.changes = { [d.field]: fromF(frames) };
    readout(`${d.field === 'fadeIn' ? 'Fade in' : 'Fade out'} ${shortTc(frames)}`);
  }
  paintAudioControls(d.el, { ...d.c, ...d.changes });
}
function trackMenu(t) {
  return [
    { label: 'Rename…', icon: 'sliders', disabled: !editable() || t.locked, run: () => renameTrack(t, document.querySelector(`.track[data-track="${t.id}"] .track-name`)) },
    { label: t.disabled ? 'Enable track' : 'Disable track', icon: t.disabled ? 'eye' : 'eye-off', disabled: !editable() || t.locked, run: () => toggleTrack(t, 'disabled') },
    { label: t.locked ? 'Unlock track' : 'Lock track', icon: t.locked ? 'unlock' : 'lock', disabled: !editable(), run: () => toggleTrack(t, 'locked') },
    '-', { action: 'addTrack' },
    { label: 'Delete track', icon: 'trash', disabled: !editable() || t.locked || clipsOn(t.id).length > 0, run: () => deleteTrack(t) }];
}
function renameTrack(t, nameEl) {
  if (!nameEl || t.locked || !editable()) return;
  editingTrack = t.id;
  const input = h('input', { class: 'track-name-input', value: t.name, maxlength: 80, spellcheck: 'false' });
  nameEl.replaceWith(input); input.focus(); input.select();
  let done = false;
  const finish = save => {
    if (done) return; done = true; editingTrack = null;
    const v = input.value.trim();
    if (save && v && v !== t.name) changeTrack(t, { name: v }, `Renamed track to “${v}”`); else drawTimeline();
    if (deferredDraw) drawTimeline();
  };
  input.onkeydown = e => { e.stopPropagation(); if (e.key === 'Enter') finish(true); if (e.key === 'Escape') finish(false); };
  input.onblur = () => finish(true);
}

// Pointer gestures on the timeline
function laneFrame(clientX) { return xFrame(clientX - $('tracks').getBoundingClientRect().left - HEAD_W); }
function snapTargets(exclude = new Set()) {
  const set = new Set([0, playF]);
  if (inF != null) set.add(inF); if (outF != null) set.add(outF + 1);
  for (const c of clips()) if (!exclude.has(c.id)) { set.add(startF(c)); set.add(endF(c)); }
  return [...set];
}
function snapFrame(edges, targets, e) {
  if (!prefs.snap || e.altKey) { $('snapline').hidden = true; return 0; }
  const threshold = 8 / pps * fps();
  let best = null;
  for (const edge of edges) for (const t of targets) { const d = t - edge; if (Math.abs(d) <= threshold && (!best || Math.abs(d) < Math.abs(best.d))) best = { d, at: t }; }
  $('snapline').hidden = !best;
  if (best) $('snapline').style.left = `${frameX(best.at)}px`;
  return best?.d || 0;
}
function readout(text, bad, at = pointer) {
  const r = $('drag-readout');
  r.replaceChildren(h('span', {}, text), ...(bad ? [h('span', { class: 'bad' }, `\n${bad}`)] : []));
  r.hidden = false;
  r.style.left = `${Math.min(innerWidth - r.offsetWidth - 8, at.x + 14)}px`;
  r.style.top = `${at.y + 18}px`;
}
function endDrag() {
  drag = null;
  $('drag-readout').hidden = true; $('snapline').hidden = true; $('marquee').hidden = true;
  document.removeEventListener('pointermove', onDragMove); document.removeEventListener('pointerup', onDragUp); document.removeEventListener('pointercancel', onDragCancel);
  idleHint();
  if (deferredDraw) drawTimeline();
}
function startDrag(state) {
  if (state.type === 'move' || state.type === 'trim') playback.pause();
  drag = state; hideTip();
  document.addEventListener('pointermove', onDragMove); document.addEventListener('pointerup', onDragUp); document.addEventListener('pointercancel', onDragCancel);
}
$('tracks').addEventListener('pointerdown', e => {
  if (e.button !== 0) return;
  const lane = e.target.closest('.lane'); if (!lane) return;
  const xf = e.target.closest('.xfade'), clipEl = e.target.closest('.clip'), handle = e.target.closest('.handle');
  if (xf) { selectTransition(xf.dataset.id); return; }
  if (clipEl) {
    const c = clipById(clipEl.dataset.id); if (!c) return;
    if (tool === 'razor') { const f = laneFrame(e.clientX), d = Math.abs(f - playF) <= 8 / pps * fps() && prefs.snap && !e.altKey ? playF - f : 0; splitAt([c.id], f + d); return; }
    const audio = e.target.closest('[data-audio]');
    if (audio) {
      e.preventDefault();
      if (trackById(c.trackId)?.locked || !editable()) return;
      select([c.id]);
      beginAudioDrag(e, c, audio.dataset.audio);
      return;
    }
    if (e.ctrlKey || e.metaKey) { select([c.id], 'toggle'); return; }
    if (e.shiftKey && !handle) select([c.id], 'add');
    else if (!selection.has(c.id) || handle) select([c.id]);
    if (trackById(c.trackId)?.locked || !editable()) return;
    if (handle) beginTrim(e, c, handle.classList.contains('l') ? 'l' : 'r');
    else beginMove(e, c);
    return;
  }
  startDrag({ type: 'marquee', x0: e.clientX, y0: e.clientY, moved: false, additive: e.shiftKey || e.ctrlKey, base: new Set(selection) });
});
function beginMove(e, primary) {
  const list = selectedClips(), disp = displayTracks();
  const rows = list.map(c => disp.findIndex(t => t.id === c.trackId));
  const ids = new Set(list.map(c => c.id));
  startDrag({ type: 'move', x0: e.clientX, y0: e.clientY, primary, list, ids, horizontal: false, dF: 0, dTrack: 0, res: null,
    minRow: Math.min(...rows), maxRow: Math.max(...rows), minStart: Math.min(...list.map(startF)), targets: snapTargets(ids),
    els: list.map(c => document.querySelector(`.clip[data-id="${c.id}"]`)).filter(Boolean) });
  hintItems([{ keys: 'Alt', text: 'bypass snapping' }, { keys: 'Escape', text: 'cancel' }]);
}
function beginTrim(e, c, edge) {
  const m = mediaById(c.mediaId), s0 = startF(c), e0 = endF(c);
  const others = clipsOn(c.trackId).filter(o => o.id !== c.id);
  startDrag({ type: 'trim', x0: e.clientX, c, m, edge, s0, e0, prevEnd: Math.max(0, ...others.map(endF).filter(x => x <= s0)), nextStart: Math.min(Infinity, ...others.map(startF).filter(x => x >= e0)),
    targets: snapTargets(new Set([c.id])), el: document.querySelector(`.clip[data-id="${c.id}"]`), result: null });
  hintItems([{ keys: 'Shift', text: 'stretch (change speed)' }, { keys: 'Alt', text: 'bypass snapping' }, { keys: 'Escape', text: 'cancel' }]);
}
function onDragMove(e) {
  if (!drag) return;
  if (drag.type === 'audio') { audioDrag(e); return; }
  if (drag.type === 'move') moveDrag(e); else if (drag.type === 'trim') trimDrag(e); else if (drag.type === 'marquee') marqueeDrag(e); else if (drag.type === 'scrub') seek(drag.frameAt(e.clientX));
}
function moveDrag(e) {
  const d = drag, dx = e.clientX - d.x0;
  if (!d.horizontal && Math.abs(dx) > 6) d.horizontal = true;
  let dF = d.horizontal ? xFrame(dx) : 0;
  if (d.horizontal) dF += snapFrame([startF(d.primary) + dF, endF(d.primary) + dF], d.targets, e);
  dF = Math.max(dF, -d.minStart);
  const rowH = prefs.trackH;
  const dTrack = Math.max(-d.minRow, Math.min(displayTracks().length - 1 - d.maxRow, Math.round((e.clientY - d.y0) / rowH)));
  d.dF = dF; d.dTrack = dTrack; d.res = moveOps(d.list, dF, dTrack);
  for (const el of d.els) { el.classList.add('dragging'); el.classList.toggle('invalid', !!d.res.error); el.style.transform = `translate(${frameX(dF)}px, ${dTrack * rowH}px)`; }
  if (dF || dTrack) readout(`${dF >= 0 ? '+' : '−'}${shortTc(Math.abs(dF))}   ${tc(startF(d.primary) + dF)}`, d.res.error || (d.res.dropped ? `Removes ${d.res.dropped} dissolve${d.res.dropped > 1 ? 's' : ''}` : '')); else $('drag-readout').hidden = true;
}
function trimDrag(e) {
  const d = drag, c = d.c, m = d.m, speed = secs(c.speed);
  const stretch = e.shiftKey && m?.kind !== 'image';
  let dF = xFrame(e.clientX - d.x0);
  dF += snapFrame([(d.edge === 'l' ? d.s0 : d.e0) + dF], d.targets, e);
  let s = d.s0, en = d.e0, limit = '';
  if (d.edge === 'r') {
    en = d.e0 + dF;
    let max = d.nextStart;
    if (!stretch && sourceBound(m)) { const srcMax = d.s0 + Math.floor((secs(m.duration) - secs(c.sourceIn)) / speed * fps() + 1e-6); if (srcMax < max) max = srcMax; }
    if (en >= max) { en = max; limit = max === d.nextStart ? 'next clip' : 'end of media'; }
    en = Math.max(d.s0 + 1, en);
  } else {
    s = d.s0 + dF;
    let min = d.prevEnd;
    if (!stretch && sourceBound(m)) { const srcMin = d.s0 - Math.floor(secs(c.sourceIn) / speed * fps() + 1e-6); if (srcMin > min) min = srcMin; }
    if (s <= min) { s = min; limit = min === d.prevEnd && min > 0 ? 'previous clip' : 'start of media'; }
    s = Math.min(d.e0 - 1, s);
  }
  const dur = en - s, d0 = d.e0 - d.s0;
  d.result = { s, en, dur, stretch };
  d.el.classList.add('dragging');
  d.el.style.left = `${frameX(s)}px`; d.el.style.width = `${Math.max(2, frameX(dur))}px`;
  const delta = d.edge === 'l' ? s - d.s0 : en - d.e0;
  readout(stretch ? `Speed ${pct(speed * d0 / dur)}   Duration ${shortTc(dur)}` : `${delta >= 0 ? '+' : '−'}${shortTc(Math.abs(delta))}   Duration ${shortTc(dur)}`, limit ? `Limited by ${limit}` : '');
}
function marqueeDrag(e) {
  const d = drag;
  if (!d.moved && Math.hypot(e.clientX - d.x0, e.clientY - d.y0) < 4) return;
  d.moved = true;
  const host = $('tracks').getBoundingClientRect();
  const l = Math.min(d.x0, e.clientX), r = Math.max(d.x0, e.clientX), t = Math.min(d.y0, e.clientY), b = Math.max(d.y0, e.clientY);
  Object.assign($('marquee').style, { left: `${l - host.left - HEAD_W}px`, top: `${t - host.top}px`, width: `${r - l}px`, height: `${b - t}px` });
  $('marquee').hidden = false;
  const hit = new Set(d.additive ? d.base : []);
  for (const el of document.querySelectorAll('.clip')) { const cr = el.getBoundingClientRect(); if (cr.right > l && cr.left < r && cr.bottom > t && cr.top < b) hit.add(el.dataset.id); }
  for (const el of document.querySelectorAll('.clip')) el.classList.toggle('selected', hit.has(el.dataset.id));
  d.hit = hit;
}
function onDragCancel() {
  const d = drag; if (!d) return;
  if (d.type === 'move') d.els.forEach(el => { el.style.transform = ''; el.classList.remove('dragging', 'invalid'); });
  endDrag(); drawTimeline();
  if (d.type === 'scrub') playback.seek(secs(fromF(Math.min(playF, lastFrame()))), false);
}
function onDragUp(e) {
  const d = drag; if (!d) return;
  if (d.type === 'audio') {
    endDrag(); drawTimeline();
    if (d.changes) edit(() => {
      const current = clipById(d.c.id);
      if (!current || current.revision !== d.c.revision) return refuse('The clip changed during the drag. Nothing was applied.');
      return { ops: [put('clips', { id: current.id, ...d.changes })], message: d.field === 'volume' ? `Volume ${toDb(d.changes.volume)} dB` : 'Adjusted fade' };
    });
    return;
  }
  if (d.type === 'move') {
    for (const el of d.els) { el.style.transform = ''; el.classList.remove('dragging', 'invalid'); }
    const moved = d.dF || d.dTrack;
    endDrag();
    if (moved) { if (d.res?.error) say(d.res.error, 'warn'); else commitMove(d.list.map(c => c.id), d.dF, d.dTrack); }
  } else if (d.type === 'trim') {
    endDrag();
    const r = d.result;
    if (!r || (r.s === d.s0 && r.en === d.e0)) { drawTimeline(); return; }
    edit(() => {
      const c = clipById(d.c.id);
      if (!c || c.revision !== d.c.revision) return refuse('The clip changed during the drag. Nothing was applied.');
      const duration = fromF(r.dur), changes = { duration, ...fadeClamp(c, duration) };
      if (r.stretch) changes.speed = frac(c.speed.num * (d.e0 - d.s0), c.speed.den * r.dur);
      if (d.edge === 'l') { changes.start = fromF(r.s); if (!r.stretch) changes.sourceIn = fadd(c.sourceIn, fmul(fsub(fromF(r.s), c.start), c.speed)); }
      const gone = transitions().filter(t => d.edge === 'l' ? t.toClipId === c.id : t.fromClipId === c.id);
      return { ops: [...gone.map(t => remove('transitions', t.id)), put('clips', { id: c.id, ...changes })],
        message: `${r.stretch ? `Speed ${pct(secs(changes.speed))}` : 'Trimmed'} · duration ${shortTc(r.dur)}${gone.length ? ' · removed dissolve' : ''}` };
    });
  } else if (d.type === 'marquee') {
    endDrag();
    if (d.moved) select([...(d.hit || [])]);
    else { if (!d.additive) select([]); seek(laneFrame(d.x0), true); }
  } else if (d.type === 'scrub') { endDrag(); playback.seek(secs(fromF(Math.min(playF, lastFrame()))), d.resume); }
}
function scrubber(el, frameAt) {
  el.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    el.setPointerCapture(e.pointerId);
    const resume = playback.wantsPlay; playback.pause(false);
    startDrag({ type: 'scrub', frameAt, resume });
    seek(frameAt(e.clientX));
    hintItems([{ text: 'Scrub to preview. Release to settle on the exact frame.' }]);
  });
}
scrubber($('ruler'), x => laneFrame(x));
scrubber($('mini-ruler'), x => { const r = $('mini-ruler').getBoundingClientRect(); return Math.round((x - r.left) / r.width * timelineEndF()); });
$('ruler').tip = { title: 'Time ruler', hint: [{ keys: '#Drag', text: 'scrub' }, { keys: ['I', 'O'], text: 'mark range' }, { keys: ['=', '-'], text: 'zoom' }, { keys: '\\', text: 'fit' }] };
$('mini-ruler').tip = { title: 'Sequence overview', hint: [{ keys: '#Click', text: 'jump' }, { keys: '#Drag', text: 'scrub' }] };
$('tl-scroll').addEventListener('wheel', e => {
  if (!e.ctrlKey) return;
  e.preventDefault();
  zoom(e.deltaY < 0 ? 1.2 : 1 / 1.2, e.clientX - $('tl-scroll').getBoundingClientRect().left - HEAD_W);
}, { passive: false });

// Structured library drops resolve IDs through the service, never trust a dragged path.
document.addEventListener('dragover', e => {if(e.dataTransfer.types.includes('application/x-reelet-library')&&editable()){e.preventDefault();e.dataTransfer.dropEffect='copy';}});
document.addEventListener('drop', async e => {
  const raw=e.dataTransfer.getData('application/x-reelet-library');if(!raw)return;e.preventDefault();
  try{const data=JSON.parse(raw);await window.reelet.command({command:'library-import',id:data.rangeId||data.assetId,libraryId:data.libraryId,sourceId:data.sourceId});}
  catch(error){console.error(error);alert(error.message);}
});

// Dropping media from the bin
let dragMedia = null, dropGhost = null;
function clearDropGhost() { dropGhost?.remove(); dropGhost = null; for (const el of document.querySelectorAll('.drop-target')) el.classList.remove('drop-target'); }
function dropPlan(e) {
  const lane = e.target.closest?.('.lane'), m = dragMedia; if (!m) return null;
  const len = mediaLength(m);
  let f = Math.max(0, laneFrame(e.clientX));
  if (prefs.snap && !e.altKey) f += snapFrame([f, f + len], snapTargets(), e);
  f = Math.max(0, f);
  const t = lane ? trackById(lane.dataset.track) : null;
  return { lane, f, len, trackId: t?.id || null, fits: !!t && !t.locked && free(t.id, f, f + len) };
}
for (const zone of [$('tracks'), $('tl-empty')]) {
  zone.addEventListener('dragover', e => {
    if (!dragMedia || !editable()) return;
    e.preventDefault(); e.dataTransfer.dropEffect = 'copy';
    const plan = dropPlan(e); clearDropGhost();
    const host = plan.lane || $('tl-empty');
    host.classList.add('drop-target');
    if (plan.lane) { dropGhost = h('div', { class: `drop-ghost ${plan.fits ? '' : 'invalid'}`, style: { left: `${frameX(plan.f)}px`, width: `${frameX(plan.len)}px` } }); plan.lane.append(dropGhost); }
    readout(`${tc(plan.f)}   ${shortTc(plan.len)}`, plan.fits ? '' : 'Adds a new track', { x: e.clientX, y: e.clientY });
  });
  zone.addEventListener('dragleave', e => { if (!zone.contains(e.relatedTarget)) { clearDropGhost(); $('drag-readout').hidden = true; $('snapline').hidden = true; } });
  zone.addEventListener('drop', e => {
    e.preventDefault();
    const plan = dropPlan(e), m = dragMedia;
    clearDropGhost(); $('drag-readout').hidden = true; $('snapline').hidden = true; dragMedia = null;
    if (plan && m) addMediaAt(m, plan.fits ? plan.trackId : null, plan.f);
  });
}

// ---------------------------------------------------------------- Chrome: toolbar, transport, splitters
function actionButton(id, iconName, cls = '') {
  return h('button', { class: `icon-button ${cls}`, dataset: { action: id }, onclick: () => run(id), tip: { action: id } }, icon(iconName || actions[id].icon));
}
function buildChrome() {
  $('tool-group').append(actionButton('selectTool'), actionButton('razorTool'), actionButton('snap'));
  $('edit-group').append(actionButton('split'), actionButton('dissolve'), actionButton('addTrack'));
  $('zoom-group').append(actionButton('zoomOut'), actionButton('zoomFit'), actionButton('zoomIn'));
  $('transport-buttons').append(actionButton('toStart'), actionButton('prevEdit'), actionButton('stepBack'), actionButton('play', 'play', 'primary'), actionButton('stepForward'), actionButton('nextEdit'), actionButton('toEnd'), actionButton('renderFrame'), h('span', { class: 'gap' }), actionButton('markIn'), actionButton('markOut'));
  for (const [id, a] of [['undo', 'undo'], ['redo', 'redo'], ['export', 'export'], ['import', 'import']]) { $(id).dataset.action = a; $(id).tip = { action: a }; $(id).onclick = () => run(a); }
  $('command-center-keys').replaceWith(kbd('Ctrl+Shift+P'));
  $('command-center').onclick = () => run('palette', 'key');
  $('command-center').tip = () => ({ title: 'Search commands', desc: 'Every action, with its shortcut. Type a timecode to jump there.', keys: 'Ctrl+Shift+P', meta: project() ? `${project().name}\n${project().resolution.width}×${project().resolution.height} · ${fpsLabel()} fps` : null });
  $('mode-chip').onclick = () => run('softwareRender');
  for (const tab of document.querySelectorAll('.bin .tab')) tab.onclick = () => showTab(tab.dataset.tab);
  document.querySelector('.bin [data-tab="media"]').tip = { title: 'Media bin', desc: 'Imported footage, audio, images and graphics. Originals stay where they are.' };
  document.querySelector('.bin [data-tab="history"]').tip = { title: 'History', desc: 'Shared undo/redo and restorable checkpoints.' };
  for (const tab of document.querySelectorAll('.monitor .tab')) tab.onclick = () => tab.dataset.view === 'export' ? playExport() : setMonitorView('frame');
  document.querySelector('.monitor [data-view="frame"]').tip = { title: 'Program monitor', desc: 'Live timeline preview with audio. Enter renders a full-resolution frame.', keys: 'Enter' };
  $('export-tab').tip = { title: 'Last export', desc: 'Play the most recent finished MP4.', keys: 'Space' };
  $('search').oninput = drawMedia;
  $('search').tip = { title: 'Search media', desc: 'Filter the bin by file name.' };
  const tcInput = $('timecode');
  tcInput.tip = { title: 'Playhead timecode', desc: 'Click and type a timecode, seconds or +/- frames, then press Enter.' };
  tcInput.onfocus = () => setTimeout(() => tcInput.select(), 0);
  tcInput.onkeydown = e => {
    if (e.key === 'Enter') { const f = parseTime(tcInput.value, playF); if (f != null) seek(f, true); tcInput.blur(); e.preventDefault(); }
    if (e.key === 'Escape') { tcInput.value = tc(playF); tcInput.blur(); }
  };
  tcInput.onblur = () => { tcInput.value = tc(playF); };
  for (const s of document.querySelectorAll('.splitter')) {
    s.tip = { title: 'Resize panels', hint: [{ keys: '#Drag', text: 'resize' }, { keys: '#Double-click', text: 'reset' }] };
    s.ondblclick = () => run('resetLayout');
    s.onpointerdown = e => {
      e.preventDefault(); s.setPointerCapture(e.pointerId); s.classList.add('active');
      const kind = s.dataset.split, x0 = e.clientX, y0 = e.clientY, start = { ...prefs };
      s.onpointermove = ev => {
        if (kind === 'left') prefs.leftW = Math.max(180, Math.min(480, start.leftW + ev.clientX - x0));
        if (kind === 'right') prefs.rightW = Math.max(240, Math.min(520, start.rightW - (ev.clientX - x0)));
        if (kind === 'timeline') prefs.tlH = Math.max(160, Math.min(innerHeight - 260, start.tlH - (ev.clientY - y0)));
        applyLayout();
      };
      s.onpointerup = () => { s.onpointermove = s.onpointerup = null; s.classList.remove('active'); savePrefs(); drawTimeline(); };
    };
  }
  for (const name of ['play', 'pause', 'ended']) $('export-video').addEventListener(name, syncPlayButton);
  new ResizeObserver(() => { if (fitZoom && project()) drawTimeline(); }).observe($('tl-scroll'));
  let pinFrame = 0;
  $('tl-scroll').addEventListener('scroll', () => { cancelAnimationFrame(pinFrame); pinFrame = requestAnimationFrame(pinLabels); }, { passive: true });
}

// ---------------------------------------------------------------- Keyboard
function comboOf(e) {
  let key = e.key;
  if (/^Key[A-Z]$/.test(e.code)) key = e.code.slice(3);
  else if (/^Digit\d$/.test(e.code) && (e.ctrlKey || e.altKey)) key = e.code.slice(5);
  else if (key === ' ') key = 'Space';
  else if (key.startsWith('Arrow')) key = key.slice(5);
  else if (key === '+') key = '=';
  else if (key === '_') key = '-';
  else if (key.length === 1) key = key.toUpperCase();
  const shift = e.shiftKey && !['?', '='].includes(key);
  return [e.ctrlKey || e.metaKey ? 'Ctrl' : null, e.altKey ? 'Alt' : null, shift ? 'Shift' : null, key].filter(Boolean).join('+');
}
document.addEventListener('keydown', e => {
  if (modal) return;
  if (openMenuState) { menuKey(e); return; }
  const combo = comboOf(e);
  const typing = e.target.closest?.('input, textarea, select, [contenteditable]');
  if (typing) {
    if (combo === 'Escape') e.target.blur();
    if (!['Ctrl+Shift+P', 'Ctrl+M', 'Ctrl+S', 'Ctrl+Shift+S', 'Ctrl+I'].includes(combo)) return;
  }
  if (e.altKey && !e.ctrlKey && !e.shiftKey && /^Key[A-Z]$/.test(e.code)) {
    const menu = [...$('menubar').children].find(b => b.textContent[0].toUpperCase() === e.code.slice(3));
    if (menu) { e.preventDefault(); menu.dispatchEvent(new Event('open')); openMenuState?.buttons.find(b => !b.disabled)?.classList.add('active'); return; }
  }
  if (combo === 'Escape') {
    if (drag) { const d = drag; if (d.type === 'move') d.els.forEach(el => { el.style.transform = ''; el.classList.remove('dragging', 'invalid'); }); endDrag(); drawTimeline(); say('Drag cancelled'); }
    else if (tool !== 'select') setTool('select');
    else if (hasSelection()) select([]);
    e.preventDefault(); return;
  }
  if (drag) return;
  const id = keymap.get(combo);
  if (!id) return;
  if (id === 'play' && e.repeat) { e.preventDefault(); return; }
  e.preventDefault();
  run(id, 'key');
});

// ---------------------------------------------------------------- Events and startup
window.reeletPrepareReload = () => {
  if (!connected || drag || modal || editingTrack || editsInFlight || playback.wantsPlay || playback.busy || frameJobId ||
      document.activeElement?.matches('input,textarea,select,[contenteditable="true"]') || document.querySelector(':active')) return false;
  rememberMarks(); clearTimeout(rememberMarks.t); savePrefs();
  return true;
};
api.onEvent(async event => {
  try {
    if (event.type === 'disconnected') { playback.pause(false); setConnected(false, event.value?.message); syncChrome(); say('Project connection closed. Reopen the project to reconnect.', 'error'); return; }
    if (event.type === 'job') { await onJob(event.value.job || event.value); return; }
    if (event.type === 'change' || event.type === 'hello') {
      const next = event.value.inspect || event.value;
      const external = snapshot && next.project && next.project.revision !== snapshot.project.revision;
      if (next.project && next.revisions) { snapshot = next; draw(); } else await refresh();
      if (external && prefs.autoRender) requestFrame(600);
    }
  } catch (error) { say(explain(error), 'error'); }
});

applyLayout(); buildMenubar(); buildChrome(); idleHint();
refresh().then(async () => {
  say('Connected to project');
  const state = await api.command({ command: 'status' });
  const jobs = (Array.isArray(state) ? state : state.jobs || (state.id ? [state] : [])).sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
  for (const job of jobs) await onJob(job, { silent: true });
  if (prefs.autoRender && clips().length) requestFrame(0);
  welcome();
  api.ready();
}).catch(error => { setConnected(false, explain(error)); say(explain(error), 'error'); api.ready(); });
