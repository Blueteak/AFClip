'use strict';
const $ = id => document.getElementById(id);
const api = window.afclip;
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
let libraryMedia = {}, libraryOffline = false, libraryLoading = false, libraryMediaKey = '';
let graphicTextEdit = null, textCommit = null;
const project = () => snapshot?.project;
const clips = () => project()?.clips || [];
const tracks = () => project()?.tracks || [];
const folders = () => project()?.folders || [];
const transitions = () => project()?.transitions || [];
const markers = () => project()?.markers || [];
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
// Markers may sit past the last clip. They stay reachable without lengthening the sequence or its exports.
const markerF = m => toF(m.time);
const navEndF = () => Math.max(timelineEndF(), ...markers().map(markerF));
const tc = f => {
  const n = nominal(), a = Math.abs(Math.round(f)), s = Math.floor(a / n);
  return (f < 0 ? '-' : '') + [Math.floor(s / 3600), Math.floor(s / 60) % 60, s % 60, a % n].map(x => String(x).padStart(2, '0')).join(':');
};
const shortTc = f => {
  const seconds = Math.abs(f) / fps(), hundredths = Math.round(seconds * 100);
  const whole = seconds < 3600 ? Math.floor(hundredths / 100) : Math.floor(seconds);
  const parts = [Math.floor(whole / 60) % 60, whole % 60];
  if (whole >= 3600) parts.unshift(Math.floor(whole / 3600));
  return (f < 0 ? '-' : '') + parts.map(x => String(x).padStart(2, '0')).join(':')
    + (seconds < 3600 ? `.${String(hundredths % 100).padStart(2, '0')}` : '');
};
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
const folderById = id => byId(folders(), id);
// Folders are one level deep and hold adjacent tracks. Their Disable and Lock apply on top of each
// track's own settings, which stay untouched. A collapsed folder hides its tracks from editing.
const folderOf = t => t?.folderId ? folderById(t.folderId) || null : null;
const folderMembers = id => displayTracks().filter(t => t.folderId === id);
const lockedTrack = id => { const t = trackById(id); return !!(t?.locked || folderOf(t)?.locked); };
const disabledTrack = id => { const t = trackById(id); return !!(t?.disabled || folderOf(t)?.disabled); };
const hiddenTrack = id => !!folderOf(trackById(id))?.collapsed;
const visibleTracks = () => displayTracks().filter(t => !hiddenTrack(t.id));
function blockReason(trackId) {
  const t = trackById(trackId), f = folderOf(t);
  if (!t) return 'The track no longer exists';
  if (t.locked) return `“${t.name}” is locked`;
  if (f?.locked) return `Folder “${f.name}” is locked`;
  if (f?.collapsed) return `Expand folder “${f.name}” to edit its clips`;
  return null;
}
const mediaById = id => byId(project()?.media || [], id);
const transitionById = id => byId(transitions(), id);
const markerById = id => byId(markers(), id);
const sortedMarkers = () => [...markers()].sort((a, b) => secs(a.time) - secs(b.time) || a.id.localeCompare(b.id));
const clipsOn = trackId => clips().filter(c => c.trackId === trackId);
const strip = ({ revision, ...rest }) => rest;
const uid = prefix => `${prefix}_${crypto.randomUUID().replaceAll('-', '')}`;
const basename = value => String(value || '').split(/[\\/]/).filter(Boolean).pop() || '';
const stem = value => basename(value).replace(/\.[^.]+$/, '');
const mediaName = m => {
  if (!m) return 'Missing media';
  // Imported graphic folders are renamed to stable IDs, so borrow the name of a clip that uses them.
  if (m.metadata?.asset) return m.metadata.asset.name;
  if (m.kind === 'graphic') return clips().find(c => c.mediaId === m.id && c.name)?.name || `Graphic ${m.id.slice(-6)}`;
  return libraryMedia[m.id]?.name || m.metadata?.library?.name || basename(m.path);
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
// A detached pair shares one source: the picture clip is silent and the audio clip has no picture.
const clipKind = c => c.stream === 'audio' ? 'audio' : mediaById(c.mediaId)?.kind;
const clipHasAudio = c => c.stream !== 'video' && hasAudio(mediaById(c.mediaId));
const clipVisual = c => c.stream !== 'audio' && isVisual(mediaById(c.mediaId));
const linkedPeers = c => c?.linkId ? clips().filter(o => o.linkId === c.linkId && o.id !== c.id) : [];
// Timing edits act on whole link groups, so moves, trims, splits and deletes expand to companions.
const withLinked = list => { const out = new Map(list.map(c => [c.id, c])); for (const c of list) for (const o of linkedPeers(c)) out.set(o.id, o); return [...out.values()]; };

// ---------------------------------------------------------------- Preferences
const prefs = (() => {
  const defaults = { leftW: 250, rightW: 290, tlH: 330, trackH: 50, snap: true, autoRender: true, renderMode: 'gpu', verification: 'quick', binView: 'grid', welcomed: false, tips: {}, marks: {} };
  try { return { ...defaults, ...JSON.parse(localStorage.getItem('afclip.ui') || '{}') }; } catch { return defaults; }
})();
const savePrefs = () => localStorage.setItem('afclip.ui', JSON.stringify(prefs));
function applyLayout() {
  const root = document.documentElement.style;
  root.setProperty('--left-w', `${prefs.leftW}px`); root.setProperty('--right-w', `${prefs.rightW}px`);
  root.setProperty('--tl-h', `${prefs.tlH}px`); root.setProperty('--track-h', `${prefs.trackH}px`);
}

// ---------------------------------------------------------------- UI state
let playF = 0, inF = null, outF = null, tool = 'select', pps = 40, fitZoom = true;
let selTracks = new Set(), selFolder = null;
let selection = new Set(), selTransition = null, selPoint = null, selMarker = null, binSelection = null, clipboard = null;
let drag = null, deferredDraw = false, editingTrack = null, firstLoad = true, connected = false;
let shown = null, frameJobId = null, frameQueued = false, frameTimer = null, exportJobId = null, exportProgress = 0, exportMessage = '', monitorView = 'frame';
const frameFor = new Map(), seenJobs = new Set(), jobModes = new Map();
let agents = null;
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
  const running = playback.wantsPlay;
  const button = document.querySelector('#transport-buttons [data-action="play"]');
  const label = running ? 'Pause' : 'Play';
  if (button && button.getAttribute('aria-label') !== label) { button.replaceChildren(icon(running ? 'pause' : 'play')); button.setAttribute('aria-label', label); }
}
// Source monitor: previews bin media with its own clock. It never touches the timeline session or the project.
const source = new window.AFClipSourcePreview({
  api, stage: $('source-stage'), strip: $('source-strip'),
  format: t => tc(Math.floor(t * fps() + 1e-7)), frameDuration: () => 1 / fps(),
  onTime: t => drawSourceTime(t),
  onState: () => { syncSourceTransport(); if (monitorView === 'source') drawMonitor(); refreshSourceInspector(); },
  onSelect: () => refreshSourceInspector(),
  onError: error => say(explain(error), 'error'),
  onDragStart: payload => { hideTip(); dragMedia = payload.media; dragSource = payload; },
  onDragEnd: () => { dragMedia = null; dragSource = null; clearDropGhost(); $('drag-readout').hidden = true; $('snapline').hidden = true; },
});


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
  if (code === 'TRACK_LOCKED') return 'That track or its folder is locked. Unlock it in the track header to edit it.';
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
  if (monitorView === 'source') return hintItems([{ keys: 'Space', text: 'play source' }, { keys: ['Up', 'Down'], text: 'annotations' }, ...(source.wave ? [{ keys: ['=', '-'], text: 'zoom' }, { keys: '\\', text: 'fit' }] : []), { keys: 'Esc', text: 'Program' }]);
  if (tool === 'razor') return hintItems([{ text: 'Razor: click a clip to split it' }, { keys: 'V', text: 'back to selection' }]);
  hintItems([{ keys: '?', text: 'Shortcuts' }, { keys: 'Ctrl+Space', text: 'Search commands' }]);
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
  return { title: spec.title || a?.label?.replace(/…$/, ''), desc: spec.desc ?? a?.desc, keys: spec.keys ?? a?.keys?.[0], meta: spec.meta, hint: spec.hint, follow: spec.follow, compact: spec.compact };
}
function showTip(target) {
  const spec = resolveTip(target); if (!spec || !target.isConnected) return;
  tipEl.classList.toggle('compact', !!spec.compact);
  const meta = spec.compact && spec.meta ? spec.meta.split('\n').map(line => h('div', { class: 'tip-line' }, line)) : [spec.meta];
  tipEl.replaceChildren(...[h('div', { class: 'tip-title' }, h('span', {}, spec.title), kbd(spec.keys)), spec.desc && h('div', { class: 'tip-desc' }, spec.desc), spec.meta && h('div', { class: 'tip-meta' }, ...meta)].filter(Boolean));
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
const hasSelection = () => selection.size > 0 || !!selTransition || !!selMarker || selTracks.size > 0 || !!selFolder;

action('import', { menu: 'File', group: 1, label: 'Import media…', icon: 'import', keys: ['Ctrl+I'], desc: 'Add footage, music, sound effects or images. Originals stay where they are.', enabled: editable, run: () => importMedia() });
action('library', { menu: 'File', group: 1, label: 'Browse content library…', icon: 'folder', keys: ['Ctrl+L'], desc: 'Browse and preview reusable assets and ranges. Edit annotations in the standalone library.', run: () => api.library() });
action('importGraphic', { menu: 'File', group: 1, label: 'Import HTML asset folder…', icon: 'graphic', keys: ['Ctrl+Shift+I'], desc: 'Add an HTML/CSS/JS graphic. The folder needs an index.html.', enabled: editable, run: () => importMedia('graphic') });
action('export', { menu: 'File', group: 2, label: 'Export…', icon: 'export', keys: ['Ctrl+M'], desc: 'Render an H.264/AAC MP4 of the sequence or the In/Out range.', enabled: () => editable() && clips().length > 0, run: () => openExport() });
action('collect', { menu: 'File', group: 2, label: 'Collect project…', icon: 'folder', keys: ['Ctrl+Alt+S'], desc: 'Copy the saved project, all bin media and HTML assets into a new portable folder. History and caches are excluded.', enabled: editable, run: () => perform(() => { say('Collecting project…'); return api.collectProject(project().revision); }, result => result ? `Collected project: ${result.path}` : 'Collection cancelled') });
action('checkpoint', { menu: 'File', group: 3, label: 'New checkpoint…', icon: 'flag', keys: ['Ctrl+Shift+S'], desc: 'Save a restorable snapshot of the whole project. The latest five are kept.', enabled: editable, run: () => newCheckpoint() });
action('syncLibrary', { menu: 'File', group: 2, label: 'Refresh media locations', icon: 'folder', desc: 'Recover moved audio and video from verified Content Library locations, preserving the saved source version and timeline cuts.', enabled: editable, run: () => perform(() => api.command({ command: 'library-sync' }), result => `${plural(result.relocated || 0, 'source')} relocated${result.skipped?.length ? ` · ${result.skipped.length} unavailable or unverified` : ''}`) });
action('showHistory', { menu: 'File', group: 3, label: 'Checkpoints', icon: 'history', desc: 'Show checkpoints and shared undo history.', run: () => showTab('history') });
action('save', { label: 'Save', keys: ['Ctrl+S'], run: () => flashHint([{ text: 'Every committed edit saves automatically.' }, { keys: 'Ctrl+Shift+S', text: 'checkpoint' }]) });

action('undo', { menu: 'Edit', group: 1, label: 'Undo', icon: 'undo', keys: ['Ctrl+Z'], desc: 'Undo the latest edit or agent batch. History is shared with the CLI.', enabled: () => editable() && !!snapshot?.history?.undo, run: () => history('undo') });
action('redo', { menu: 'Edit', group: 1, label: 'Redo', icon: 'redo', keys: ['Ctrl+Shift+Z', 'Ctrl+Y'], enabled: () => editable() && !!snapshot?.history?.redo, run: () => history('redo') });
action('copy', { menu: 'Edit', group: 2, label: 'Copy', icon: 'copy', keys: ['Ctrl+C'], enabled: () => selection.size > 0, run: copySelection });
action('paste', { menu: 'Edit', group: 2, label: 'Paste at playhead', icon: 'paste', keys: ['Ctrl+V'], enabled: () => editable() && !!clipboard, run: paste });
action('delete', { menu: 'Edit', group: 2, label: 'Delete', icon: 'trash', keys: ['Delete', 'Backspace'], desc: 'Remove the selected clips, dissolve, volume point or marker. Clips leave a gap.', enabled: () => editable() && (selection.size > 0 || !!selTransition || !!selMarker), run: deleteSelection });
action('rippleDelete', { menu: 'Edit', group: 2, label: 'Ripple delete In/Out range', icon: 'trash', keys: ['Shift+Delete'], desc: 'Remove the marked range across all tracks and close the gap. Out includes its frame. Affected locked tracks block the edit.', enabled: () => editable() && inF != null && outF != null && outF >= inF, run: () => rippleDelete(inF, outF + 1) });
action('selectAll', { menu: 'Edit', group: 3, label: 'Select all clips', keys: ['Ctrl+A'], enabled: () => clips().length > 0, run: () => select(clips().filter(c => !hiddenTrack(c.trackId)).map(c => c.id)) });
action('deselect', { menu: 'Edit', group: 3, label: 'Deselect all', keys: ['Ctrl+Shift+A'], enabled: hasSelection, run: () => select([]) });
action('agentChat', { menu: 'Edit', group: 'agents', label: 'Agent chat', icon: 'chat', keys: ['A'], desc: 'Open or start an agent chat on the hovered timeline item, track or time. Elsewhere it uses the selection, or the project.', enabled: () => !!project() && !!agents?.available(), run: () => agents.openTarget() });
action('agentSettings', { menu: 'Edit', group: 'agents', label: 'Agent settings…', icon: 'sliders', desc: 'Provider, model, thinking, access and steering for new agent chats.', enabled: () => !!agents?.available(), run: () => agents.openSettings() });

action('split', { menu: 'Clip', group: 1, label: 'Split at playhead', icon: 'scissors', keys: ['Ctrl+K'], desc: 'Cut the selected clips (or every unlocked clip) under the playhead.', enabled: editable, run: splitAtPlayhead });
action('dissolve', { menu: 'Clip', group: 1, label: 'Add dissolve', icon: 'dissolve', keys: ['Ctrl+D'], desc: 'Cross-dissolve at the cut nearest the playhead, centered, 1 second or as long as the footage allows.', enabled: editable, run: addDissolve });
action('mute', { menu: 'Clip', group: 2, label: 'Mute audio', icon: 'mute', keys: ['Shift+M'], desc: 'Toggle mute on the selected clips.', enabled: () => editable() && selectedClips().some(clipHasAudio), checked: () => selectedClips().length > 0 && selectedClips().every(c => c.mute), run: toggleMute });
action('fill', { menu: 'Clip', group: 2, label: 'Fill frame', desc: 'Scale to cover the frame, cropping the excess. Off means Fit.', keys: ['Shift+F'], enabled: () => editable() && selectedClips().some(clipVisual), checked: () => selectedClips().length > 0 && selectedClips().every(c => c.transform?.fit === 'fill'), run: toggleFill });
action('detachAudio', { menu: 'Clip', group: 'link', label: 'Detach audio', icon: 'audio', keys: ['Ctrl+Shift+D'], desc: 'Move the selected clip’s sound to its own linked clip on a new track. Moves, trims and splits keep the pair in sync.', enabled: () => editable() && !detachRefusal(), why: () => detachRefusal() || 'Edits are locked', run: detachAudio });
action('unlink', { menu: 'Clip', group: 'link', label: 'Unlink', icon: 'link-off', keys: ['Ctrl+Shift+L'], desc: 'Let the selected clip and its detached audio move and trim independently.', enabled: () => editable() && !unlinkRefusal(), why: () => unlinkRefusal() || 'Edits are locked', run: unlinkClip });
action('nudgeLeft', { menu: 'Clip', group: 3, label: 'Nudge left 1 frame', keys: ['Alt+Left'], enabled: () => editable() && selection.size > 0, run: () => nudge(-1) });
action('nudgeRight', { menu: 'Clip', group: 3, label: 'Nudge right 1 frame', keys: ['Alt+Right'], enabled: () => editable() && selection.size > 0, run: () => nudge(1) });
action('nudgeLeft5', { label: 'Nudge left 5 frames', keys: ['Alt+Shift+Left'], enabled: () => editable() && selection.size > 0, run: () => nudge(-5) });
action('nudgeRight5', { label: 'Nudge right 5 frames', keys: ['Alt+Shift+Right'], enabled: () => editable() && selection.size > 0, run: () => nudge(5) });

action('renderFrame', { menu: 'Timeline', group: 1, label: 'Render frame', icon: 'render', keys: ['Enter'], desc: 'Render the exact frame at the playhead from original media.', enabled: () => clips().length > 0 && !exportJobId, run: () => renderFrame(true) });
action('play', { menu: 'Timeline', group: 1, label: 'Play / pause', icon: 'play', keys: ['Space'], desc: 'Play the timeline with synchronized audio. Pause to inspect the current frame.', enabled: () => clips().length > 0 && connected, run: togglePlay });
action('markIn', { menu: 'Timeline', group: 2, label: 'Mark In', icon: 'in', keys: ['I'], desc: 'Start the export range at the playhead.', enabled: () => !!project(), run: () => setMarks(Math.min(playF, lastFrame()), outF != null && outF < playF ? null : outF) });
action('markOut', { menu: 'Timeline', group: 2, label: 'Mark Out', icon: 'out', keys: ['O'], desc: 'End the export range on the playhead frame.', enabled: () => !!project(), run: () => setMarks(inF != null && inF > playF ? null : inF, Math.min(playF, lastFrame())) });
action('goIn', { menu: 'Timeline', group: 2, label: 'Go to In', keys: ['Shift+I'], enabled: () => inF != null, run: () => seek(inF, true) });
action('goOut', { menu: 'Timeline', group: 2, label: 'Go to Out', keys: ['Shift+O'], enabled: () => outF != null, run: () => seek(outF, true) });
action('clearMarks', { menu: 'Timeline', group: 2, label: 'Clear In and Out', keys: ['Ctrl+Shift+X'], enabled: () => inF != null || outF != null, run: () => setMarks(null, null) });
action('addMarker', { menu: 'Timeline', group: 'markers', label: 'Add marker', icon: 'marker', keys: ['M'], desc: 'Add a marker at the playhead. Markers are shared with the CLI, snap moves and trims, and never change the export length.', enabled: editable, run: () => addMarker(nextMarkerName(), playF) });
action('editMarker', { menu: 'Timeline', group: 'markers', label: 'Edit marker…', desc: 'Rename or retime the selected marker. Right-click or double-click a marker on the ruler to do the same.', enabled: () => editable() && !!markerById(selMarker), run: () => markerPopover(markerById(selMarker)) });
action('prevMarker', { menu: 'Timeline', group: 'markers', label: 'Previous marker', keys: ['Shift+Down'], desc: 'Jump to and select the previous marker.', enabled: () => markers().length > 0, run: () => seekMarker(-1) });
action('nextMarker', { menu: 'Timeline', group: 'markers', label: 'Next marker', keys: ['Shift+Up'], desc: 'Jump to and select the next marker.', enabled: () => markers().length > 0, run: () => seekMarker(1) });
action('addTrack', { menu: 'Timeline', group: 3, label: 'Add track', icon: 'add-track', keys: ['Ctrl+Shift+T'], desc: 'Add an empty track on top, or at the top of the selected folder. Any media can go on any track.', enabled: editable, run: () => addTrack() });
action('groupTracks', { menu: 'Timeline', group: 'folders', label: 'Group into folder…', icon: 'folder', keys: ['Ctrl+G'], desc: 'Put the selected tracks, or the tracks of the selected clips, in a collapsible folder. Folder Disable and Lock apply on top of each track’s own settings.', enabled: () => editable() && tracks().length > 0, run: () => folderDialog(null) });
action('editFolder', { menu: 'Timeline', group: 'folders', label: 'Edit folder…', icon: 'sliders', keys: ['Ctrl+Alt+G'], desc: 'Rename the selected folder and choose its tracks.', enabled: () => editable() && !!folderTarget(), run: () => folderDialog(folderTarget()) });
action('ungroup', { menu: 'Timeline', group: 'folders', label: 'Ungroup folder', icon: 'x', keys: ['Ctrl+Shift+G'], desc: 'Remove the folder. Its tracks stay where they are with their own settings.', enabled: () => editable() && !!folderTarget(), run: () => ungroupFolder() });
action('removeFromFolder', { menu: 'Timeline', group: 'folders', label: 'Remove from folder', desc: 'Take the selected tracks out of their folder. Removing the last track removes the folder.', enabled: () => editable() && trackTargets().some(id => trackById(id)?.folderId), run: () => removeFromFolder() });
action('toggleFolder', { menu: 'Timeline', group: 'folders', label: 'Collapse / expand folder', icon: 'chevron-down', keys: ['Ctrl+Shift+F'], desc: 'A collapsed folder shows a read-only overview of its clips. Expand it to edit them.', enabled: () => editable() && !!folderTarget(), checked: () => !!folderTarget()?.collapsed, run: () => toggleCollapsed() });
action('moveTrackUp', { menu: 'Timeline', group: 'folders', label: 'Move track or folder up', keys: ['Alt+Up'], desc: 'Reorder the selected tracks or folder. Clip times stay the same; higher tracks draw on top.', enabled: () => editable() && (!!selFolder || selTracks.size > 0), run: () => moveStep(-1) });
action('moveTrackDown', { menu: 'Timeline', group: 'folders', label: 'Move track or folder down', keys: ['Alt+Down'], enabled: () => editable() && (!!selFolder || selTracks.size > 0), run: () => moveStep(1) });
action('rename', { menu: 'Timeline', group: 'folders', label: 'Rename track or folder', keys: ['F2'], enabled: () => editable() && (!!selFolder || selTracks.size === 1), run: renameSelected });
action('snap', { menu: 'Timeline', group: 3, label: 'Snapping', icon: 'magnet', keys: ['S'], desc: 'Snap moves and trims to clip edges, markers, the playhead and In/Out. Hold Alt while dragging to bypass.', checked: () => prefs.snap, run: () => { prefs.snap = !prefs.snap; savePrefs(); say(`Snapping ${prefs.snap ? 'on' : 'off'}`); syncChrome(); } });
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
action('binGrid', { menu: 'View', group: 4, label: 'Media bin as grid', icon: 'grid', keys: ['Ctrl+B'], desc: 'Switch the media bin between thumbnail grid and list.', checked: () => prefs.binView === 'grid', run: () => setBinView(prefs.binView === 'grid' ? 'list' : 'grid') });
action('resetLayout', { menu: 'View', group: 4, label: 'Reset panel layout', run: () => { Object.assign(prefs, { leftW: 250, rightW: 290, tlH: 330, trackH: 50 }); savePrefs(); applyLayout(); fitZoom = true; drawTimeline(); } });
action('palette', { menu: 'Help', group: 1, label: 'Search commands…', icon: 'command', keys: ['Ctrl+Space'], desc: 'Find any action by name and see its shortcut.', run: () => openPalette() });
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
function timelineContextMenu(e, items) {
  const anchor = agentTarget(e.target, e.clientX, true);
  contextMenu(e, [...items, '-', { label: 'New Chat', icon: 'chat', keys: ['A'],
    disabled: !anchor || !agents?.available(), run: () => agents.openAnchor(anchor) }]);
}

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
    ['Add to selection', ['Ctrl', '#Click']], ['Add volume point', ['Ctrl', '#Click volume line']], ['Remove volume point', ['#Click point', 'Delete']], ['Box select', ['#Drag empty track']], ['Move marker', ['#Drag marker']], ['Edit marker', ['#Right-click marker']], ['Zoom timeline', ['Ctrl', '#Wheel']], ['Rename track', ['#Double-click name']], ['Select tracks', ['#Click header']], ['Reorder tracks and folders', ['#Drag header']], ['More actions', ['#Right-click']],
  ], joined: true });
  const grid = h('div', { class: 'shortcut-grid' }, groups.filter(g => g.rows.length).map(g => h('div', { class: 'shortcut-group' }, h('h3', {}, g.name),
    g.rows.map(([label, keys]) => h('div', { class: 'shortcut-row' }, h('span', {}, label),
      h('span', { class: 'kbd-group' }, keys.flatMap((k, i) => [i ? h('span', { class: 'alt' }, g.joined ? '+' : 'or') : null, k.startsWith('#') ? h('span', { class: 'alt' }, k.slice(1)) : kbd(k)])))))));
  dialog({ title: 'Keyboard shortcuts', iconName: 'keyboard', wide: true, body: h('div', { class: 'dialog-body' }, grid), foot: [kbd('Ctrl+Space'), ' searches every command'] });
}

function welcome(force) {
  if (prefs.welcomed && !force) return;
  toast({ cls: 'welcome', title: 'Welcome to AFClip', timeout: 0,
    body: h('div', {}, 'Hover any control to see what it does and its shortcut. Most editing is one key away.', h('br'),
      kbd('?'), ' all shortcuts  ·  ', kbd('Ctrl+Space'), ' search commands', h('br'), 'Drag media from the bin onto the timeline to start.'),
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
      if (prefs.autoRender) requestFrame(0);
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
    try {
      await api.command({ command: 'apply', batch: { preconditions: { ...snapshot.revisions, ...pre }, operations: ops } });
    } catch (error) {
      if (error.message.includes('Unsupported object field') && ops.some(op => op.collection === 'clips' && op.value?.volumePoints !== undefined)) {
        throw new Error('The project engine is older than the volume-point controls. Restart AFClip and its project engine to enable volume points. Saved edits are preserved; session undo history resets.');
      }
      if (error.message.includes('supported collection') && ops.some(op => op.collection === 'markers')) {
        throw new Error('The project engine is older than markers. Restart AFClip and its project engine to enable markers. Saved edits are preserved; session undo history resets.');
      }
      throw error;
    }
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
  selTransition = null; selPoint = null; selMarker = null; selTracks = new Set(); selFolder = null;
  drawTimeline(); drawInspector(); syncChrome();
}
function selectTransition(id) { selection = new Set(); selTransition = id; selPoint = null; selMarker = null; selTracks = new Set(); selFolder = null; drawTimeline(); drawInspector(); syncChrome(); }
function selectMarker(id) { selection = new Set(); selTransition = null; selPoint = null; selMarker = id; selTracks = new Set(); selFolder = null; drawTimeline(); drawInspector(); syncChrome(); }
// Track and folder headers select without rebuilding the timeline, so a double-click can still rename.
let trackAnchor = null;
function selectTracks(ids, mode = 'replace') {
  const hadClips = selection.size || selTransition || selMarker;
  selection = new Set(); selTransition = null; selPoint = null; selMarker = null; selFolder = null;
  if (mode === 'range' && trackAnchor && trackById(trackAnchor)) {
    const disp = visibleTracks().map(t => t.id), a = disp.indexOf(trackAnchor), b = disp.indexOf(ids[0]);
    if (a >= 0 && b >= 0) ids = disp.slice(Math.min(a, b), Math.max(a, b) + 1);
    selTracks = new Set(ids);
  } else if (mode === 'toggle') { for (const id of ids) selTracks.has(id) ? selTracks.delete(id) : selTracks.add(id); trackAnchor = ids[0]; }
  else { selTracks = new Set(ids); trackAnchor = ids[0] ?? null; }
  hadClips ? drawTimeline() : paintHeads(); drawInspector(); syncChrome();
}
function selectFolder(id) {
  const hadClips = selection.size || selTransition || selMarker;
  selection = new Set(); selTransition = null; selPoint = null; selMarker = null; selTracks = new Set(); selFolder = id;
  hadClips ? drawTimeline() : paintHeads(); drawInspector(); syncChrome();
}
function paintHeads() {
  for (const row of document.querySelectorAll('#tracks > .track')) row.classList.toggle('selected', row.dataset.folder ? row.dataset.folder === selFolder : selTracks.has(row.dataset.track));
}
function setTool(next) { tool = next; syncChrome(); drawTimeline(); idleHint(); }
function seek(f, render = false) {
  playF = Math.max(0, Math.min(Math.round(f), navEndF()));
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
// Markers sharing a frame are stepped through one at a time, in sorted order.
function seekMarker(direction) {
  const list = sortedMarkers(), i = list.findIndex(m => m.id === selMarker);
  const target = i >= 0 && markerF(list[i]) === playF ? list[i + direction]
    : direction < 0 ? list.filter(m => markerF(m) < playF).pop() : list.find(m => markerF(m) > playF);
  if (!target) { say(direction < 0 ? 'No earlier marker' : 'No later marker'); return; }
  selectMarker(target.id); seek(markerF(target), true);
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
// Clips that cannot be edited: locked directly or by their folder, or hidden in a collapsed folder.
function lockedIn(list) { return list.find(c => blockReason(c.trackId)); }
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
const lockedRefusal = list => { const c = lockedIn(list); return c ? refuse(blockReason(c.trackId)) : false; };
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

function splitAt(ids, f, fallback) {
  return edit(() => {
    const under = c => startF(c) < f && f < endF(c);
    let targets = withLinked(ids.map(clipById).filter(c => c && under(c))).filter(under);
    if (!targets.length && fallback) targets = clips().filter(c => under(c) && !lockedIn(withLinked([c])));
    if (!targets.length) return refuse('No clip under the playhead to split');
    if (lockedRefusal(targets) !== false) return null;
    // Right halves of a linked pair form a new pair rather than joining the left halves' link.
    const ops = [], pre = {}, links = new Map();
    for (const c of targets) {
      const part = splitOps(c, f);
      if (c.linkId) { if (!links.has(c.linkId)) links.set(c.linkId, uid('link')); part.ops[1].value.linkId = links.get(c.linkId); }
      ops.push(...part.ops); Object.assign(pre, part.pre);
    }
    return { ops, pre, message: `Split ${plural(targets.length, 'clip')} at ${tc(f)}` };
  });
}
function splitAtPlayhead() { splitAt([...selection], playF, true); }

// A selected volume point takes Delete before its clip does.
function deletePoint(point) {
  selPoint = null;
  return edit(() => {
    const c = clipById(point.clipId), points = c?.volumePoints || [];
    if (!c || !points.some(p => sameTime(p.time, point.time))) return refuse('The volume point no longer exists');
    if (lockedRefusal([c]) !== false) return null;
    return { ops: [put('clips', { id: c.id, volumePoints: points.filter(p => !sameTime(p.time, point.time)) })], message: 'Removed volume point' };
  });
}
function rippleDelete(start, end, revision = project().revision) {
  return perform(async () => {
    try {
      return await api.command({ command: 'apply', batch: { preconditions: { project: revision }, operations: [{ op: 'ripple-delete', start: fromF(start), end: fromF(end) }] } });
    } catch (error) {
      if (error.message.includes('Expected put or remove')) throw new Error('Restart AFClip and its project engine to enable ripple delete. Saved edits are preserved; session undo history resets.');
      throw error;
    }
  }, `Ripple deleted ${shortTc(end - start)} across all tracks`).then(result => {
    if (!result) return;
    select([]); setMarks(null, null); seek(Math.min(start, lastFrame()), true);
  });
}
function gapAt(trackId, frame) {
  const list = clipsOn(trackId), t = secs(fromF(frame));
  if (list.some(c => secs(c.start) <= t && secs(endOf(c)) > t)) return null;
  const before = Math.max(0, ...list.filter(c => secs(endOf(c)) <= t).map(c => secs(endOf(c))));
  const after = Math.min(Infinity, ...list.filter(c => secs(c.start) > t).map(c => secs(c.start)));
  const start = Math.ceil(before * fps() - 1e-8), end = Math.floor(after * fps() + 1e-8);
  return Number.isFinite(end) && end > start ? { start, end } : null;
}
// Markers are global: no track lock applies, and every edit asserts the snapshot it was built from.
function addMarker(name, f) {
  const id = uid('marker'), at = Math.max(0, f);
  return edit(() => ({ ops: [put('markers', { id, name, time: fromF(at) })], pre: { [`marker:${id}`]: 0 }, message: `Added marker “${name}” at ${tc(at)}` })).then(ok => { if (ok) selectMarker(id); return ok; });
}
// Only changed fields are sent, so renaming keeps an off-grid time from an earlier frame rate exact.
function changeMarker(id, { name, f }) {
  return edit(() => {
    const m = markerById(id); if (!m) return refuse('The marker no longer exists');
    const value = { id };
    if (name != null && name !== m.name) value.name = name;
    if (f != null && f !== markerF(m)) value.time = fromF(Math.max(0, f));
    if (!value.name && !value.time) return null;
    return { ops: [put('markers', value)], message: value.time ? `Moved marker “${value.name || m.name}” to ${tc(Math.max(0, f))}` : `Renamed marker to “${value.name}”` };
  });
}
function deleteMarker(id) {
  if (selMarker === id) selMarker = null;
  return edit(() => { const m = markerById(id); return m ? { ops: [remove('markers', id)], message: `Removed marker “${m.name}”` } : refuse('The marker no longer exists'); });
}
// New markers take the next free default name so repeated adds never need a prompt.
function nextMarkerName() {
  const n = Math.max(0, ...markers().map(m => Number(/^Marker (\d+)$/.exec(m.name)?.[1] || 0)));
  return `Marker ${Math.max(n, markers().length) + 1}`;
}
// The marker editor floats above its ruler flag, like the Content Library annotation popover.
// Closing it in any way keeps what was typed; each committed field is its own undo step.
let markerPop = null;
function closeMarkerPopover(save = true) {
  const pop = markerPop; if (!pop) return;
  markerPop = null;
  if (save) {
    if (pop.box.contains(document.activeElement)) document.activeElement.blur();
    const m = markerById(pop.id), v = pop.name.value.trim();
    if (m && v && v !== m.name) changeMarker(pop.id, { name: v });
  }
  pop.box.remove();
}
function markerPopover(m) {
  closeMarkerPopover(); closeMenu(); hideTip(); playback.pause(false);
  if (selMarker !== m.id) selectMarker(m.id);
  const disabled = !editable();
  const name = h('input', { value: m.name, maxlength: 256, spellcheck: 'false', disabled, 'aria-label': 'Marker name' });
  name.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); closeMarkerPopover(); } };
  const time = timeInput(markerF(m), f => changeMarker(m.id, { f }), { disabled });
  const box = h('div', { class: 'marker-popover', role: 'dialog', 'aria-label': 'Marker' },
    h('div', { class: 'popover-heading' }, name, h('button', { class: 'icon-button small', onclick: () => closeMarkerPopover(), tip: { title: 'Close', keys: 'Escape' } }, icon('x'))),
    h('div', { class: 'popover-body' }, field('Time', time, { tip: 'Where the marker sits on the timeline. Markers apply to every track.' })),
    h('div', { class: 'popover-actions' }, h('button', { class: 'popover-delete', disabled, onclick: () => { closeMarkerPopover(false); deleteMarker(m.id); }, tip: { title: 'Delete marker', keys: 'Delete' } }, 'Delete', kbd('Delete'))));
  document.body.append(box);
  markerPop = { id: m.id, box, name, time };
  positionMarkerPopover();
  if (!disabled) setTimeout(() => { if (markerPop?.name === name) name.select(); }, 0);
}
// Ruler redraws replace the flags, so the anchor is looked up again on every redraw and scroll.
function positionMarkerPopover() {
  const pop = markerPop; if (!pop) return;
  const m = markerById(pop.id); if (!m) { closeMarkerPopover(false); return; }
  if (selMarker !== pop.id) { closeMarkerPopover(); return; }
  const flag = [...$('ruler').querySelectorAll('.marker')].find(el => el.group?.some(o => o.id === pop.id));
  const view = $('tl-scroll').getBoundingClientRect(), r = flag?.getBoundingClientRect();
  const x = r && r.left + 5;
  if (!r || x < view.left + HEAD_W || x > view.right) { pop.box.hidden = true; return; }
  pop.box.hidden = false;
  const width = pop.box.offsetWidth, height = pop.box.offsetHeight;
  const left = Math.max(10, Math.min(innerWidth - width - 10, x - width / 2));
  pop.box.style.left = `${left}px`; pop.box.style.top = `${Math.max(10, r.top - height - 10)}px`;
  pop.box.style.setProperty('--popover-tip', `${Math.max(14, Math.min(width - 14, x - left))}px`);
}
document.addEventListener('pointerdown', e => { if (markerPop && !markerPop.box.contains(e.target) && !e.target.closest?.('.layer')) closeMarkerPopover(); }, true);
document.addEventListener('keydown', e => {
  if (!markerPop || modal || openMenuState || e.key !== 'Escape') return;
  e.preventDefault(); e.stopImmediatePropagation(); closeMarkerPopover();
}, true);
addEventListener('resize', positionMarkerPopover);
$('tl-scroll').addEventListener('scroll', positionMarkerPopover, { passive: true });

function deleteSelection() {
  if (selMarker) return deleteMarker(selMarker);
  if (selPoint && selection.size === 1 && selection.has(selPoint.clipId)) return deletePoint(selPoint);
  const tid = selTransition, ids = [...selection];
  selection = new Set(); selTransition = null;
  if (tid) return edit(() => transitionById(tid) ? { ops: [remove('transitions', tid)], message: 'Transition removed' } : null);
  edit(() => {
    const list = withLinked(ids.map(clipById).filter(Boolean)); if (!list.length) return null;
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
    // Copies never join the original's link. A pair copied whole links to itself; a lone half pastes unlinked.
    const counts = new Map(), links = new Map();
    for (const c of board.clips) if (c.linkId) counts.set(c.linkId, (counts.get(c.linkId) || 0) + 1);
    for (const [linkId, n] of counts) links.set(linkId, n > 1 ? uid('link') : null);
    const placed = board.clips.map(c => ({ c, s: at + c.offset - board.base, e: at + c.offset - board.base + toF(c.duration) }));
    const fits = placed.every(p => trackById(p.c.trackId) && !blockReason(p.c.trackId) && free(p.c.trackId, p.s, p.e));
    for (const { c, s } of placed) {
      let trackId = c.trackId;
      if (!fits) {
        if (!newTracks.has(c.trackId)) { const t = { id: uid('track'), name: `${trackById(c.trackId)?.name || 'Pasted'} copy`, disabled: false, locked: false }; newTracks.set(c.trackId, t.id); ops.push(put('tracks', t)); Object.assign(pre, { [`track:${t.id}`]: 0, [`occupancy:${t.id}`]: 0 }); }
        trackId = newTracks.get(c.trackId);
      }
      const id = uid('clip'); ids.push(id); pre[`clip:${id}`] = 0;
      const { offset, ...value } = c;
      ops.push(put('clips', { ...value, id, trackId, start: fromF(s), ...(value.linkId ? { linkId: links.get(value.linkId) } : {}) }));
    }
    return { ops, pre, message: `Pasted ${plural(placed.length, 'clip')}${fits ? '' : ' on a new track'}` };
  }).then(ok => { if (ok) select(ids); });
}

function moveOps(list, dF, dTrack) {
  list = withLinked(list);
  const disp = visibleTracks(), ids = new Set(list.map(c => c.id)), dest = new Map();
  for (const c of list) {
    const why = blockReason(c.trackId); if (why) return { error: why };
    const t = disp[disp.findIndex(x => x.id === c.trackId) + dTrack];
    if (!t) return { error: 'No track there' };
    if (blockReason(t.id)) return { error: blockReason(t.id) };
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
    const list = withLinked(ids.map(clipById).filter(Boolean)); if (!list.length) return null;
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
    const list = ids.map(clipById).filter(c => c && clipHasAudio(c)); if (!list.length) return null;
    const mute = !list.every(c => c.mute);
    return { ops: list.map(c => put('clips', { id: c.id, mute })), message: mute ? 'Muted' : 'Unmuted' };
  });
}
function toggleFill() {
  const ids = [...selection];
  edit(() => {
    const list = ids.map(clipById).filter(c => c && clipVisual(c)); if (!list.length) return null;
    const fit = list.every(c => c.transform?.fit === 'fill') ? 'fit' : 'fill';
    return { ops: list.map(c => put('clips', { id: c.id, transform: { ...(c.transform || {}), fit } })), message: fit === 'fill' ? 'Fill frame' : 'Fit frame' };
  });
}

function detachRefusal() {
  const list = selectedClips(), c = list[0], m = c && mediaById(c.mediaId);
  if (list.length !== 1) return list.length ? 'Select a single clip to detach its audio' : 'Select a video clip with audio';
  if (c.stream || c.linkId) return 'Audio is already detached';
  if (m?.kind !== 'video' || m.metadata?.hasAudio !== true) return 'The clip has no audio to detach';
  if (blockReason(c.trackId)) return blockReason(c.trackId);
  if (transitionsTouching(new Set([c.id])).length) return 'Remove the clip’s dissolves before detaching audio';
  return null;
}
function unlinkRefusal() {
  const groups = new Set(selectedClips().map(c => c.linkId).filter(Boolean));
  if (groups.size !== 1) return groups.size ? 'Select clips from a single linked pair' : 'Select a linked clip';
  const c = selectedClips().find(c => c.linkId), locked = lockedIn(withLinked([c]));
  return locked ? blockReason(locked.trackId) : null;
}
// Detach and Unlink must be the only operation in their batch and assert the whole project revision.
function linkCommand(op, refusal, message) {
  return perform(async () => {
    const why = refusal(); if (why) { say(why, 'warn'); return SKIP; }
    try {
      return await api.command({ command: 'apply', batch: { preconditions: { project: project().revision }, operations: [op()] } });
    } catch (error) {
      if (/Expected put or remove|Unsupported operation|Unknown operation/i.test(error.message)) throw new Error('The project engine is older than linked audio. Restart AFClip and its project engine to enable Detach Audio. Saved edits are preserved; session undo history resets.');
      throw error;
    }
  }, message);
}
function detachAudio() {
  const id = selectedClips()[0]?.id;
  linkCommand(() => ({ op: 'detach-audio', clipId: id }), () => clipById(id) && selection.has(id) ? detachRefusal() : 'The clip no longer exists', 'Detached audio to a new track');
}
function unlinkClip() {
  const id = selectedClips().find(c => c.linkId)?.id;
  linkCommand(() => ({ op: 'unlink', clipId: id }), () => clipById(id)?.linkId ? unlinkRefusal() : 'The clip is no longer linked', 'Unlinked picture and audio');
}

// Longest transition that fits without overlapping another transition.
function dissolveRoom(a, b, alignment = 'center', ignoreId) {
  const occupied = (t, side) => !t || t.id === ignoreId ? 0 : t.alignment === 'center' ? secs(t.duration) / 2 : t.alignment === side ? secs(t.duration) : 0;
  const aRoom = secs(a.duration) - occupied(transitions().find(t => t.toClipId === a.id), 'start');
  const bRoom = secs(b.duration) - occupied(transitions().find(t => t.fromClipId === b.id), 'end');
  const before = aRoom, after = bRoom;
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
      if (transitions().some(t => t.fromClipId === a.id && t.toClipId === b.id) || blockReason(a.trackId)) continue;
      cuts.push({ a, b, f: startF(b) });
    }
    if (!cuts.length) return refuse(scope ? 'The selected clips have no open cut to dissolve' : 'No open cut between adjacent clips');
    const { a, b, f } = cuts.sort((x, y) => Math.abs(x.f - at) - Math.abs(y.f - at))[0];
    const room = dissolveRoom(a, b), wanted = nominal();
    if (room < 2) { toast({ kind: 'error', title: 'No room for a dissolve', body: `There is no room between neighbouring transition windows at ${tc(f)}.` }); return null; }
    let frames = Math.min(wanted, room); if (frames % 2 && frames > 2) frames--;
    return { ops: [put('transitions', { id, trackId: a.trackId, fromClipId: a.id, toClipId: b.id, duration: fromF(frames), alignment: 'center' })], pre: { [`transition:${id}`]: 0 },
      message: frames < wanted ? `Dissolve at ${tc(f)} limited to ${shortTc(frames)} by neighbouring transitions` : `Dissolve added at ${tc(f)}` };
  }).then(ok => { if (ok) selectTransition(id); });
}

// With an expanded folder (or one of its tracks) selected, the new track goes in at the folder's top.
function addTrack(name) {
  const into = selFolder ? folderById(selFolder) : selTracks.size ? folderOf(trackById([...selTracks][0])) : null;
  const fid = into && !into.collapsed ? into.id : null;
  return edit(() => {
    const t = { id: uid('track'), name: name || `Track ${tracks().length + 1}`, disabled: false, locked: false };
    const pre = { [`track:${t.id}`]: 0, [`occupancy:${t.id}`]: 0 }, f = folderById(fid);
    if (!f || !folderMembers(f.id).length) return { ops: [put('tracks', t)], pre, message: `Added “${t.name}”` };
    const disp = displayTracks().map(x => x.id);
    disp.splice(disp.indexOf(folderMembers(f.id)[0].id), 0, t.id);
    return layoutPlan({ disp, before: [put('tracks', { ...t, folderId: f.id })], pre, message: `Added “${t.name}” to “${f.name}”` });
  });
}

// ---------------------------------------------------------------- Track folders
// Display order is top first; the engine stores tracks bottom first (higher index composites on top).
// Every layout change is one atomic batch: reorder, folder puts and membership, empty folders removed.
// `disp` is the wanted display order, `assign` maps track IDs to a folder ID or null, `before` adds new tracks.
function layoutPlan({ disp, assign = new Map(), before = [], pre = {}, folder = null, message }) {
  const added = before.filter(op => op.collection === 'tracks').map(op => op.value);
  const cur = [...tracks().map(t => t.id), ...added.map(t => t.id)], order = [...disp].reverse();
  if (order.length !== cur.length || new Set(order).size !== cur.length) return refuse('The tracks changed. Try again.');
  for (const [id, fid] of [...assign]) {
    const t = trackById(id);
    if (!t || (t.folderId || null) === fid) { assign.delete(id); continue; }
    const from = folderOf(t), to = fid && folderById(fid);
    if (t.locked) return refuse(`Unlock “${t.name}” to change its folder`);
    if (from?.locked) return refuse(`Unlock folder “${from.name}” first`);
    if (to?.locked) return refuse(`Unlock folder “${to.name}” first`);
  }
  // The engine keeps locked tracks at their index, so any shift past one is refused here first.
  for (const [i, id] of cur.entries()) if (order[i] !== id && trackById(id) && lockedTrack(id)) return refuse(`${blockReason(id)}. Unlock it to reorder tracks.`);
  const final = id => assign.has(id) ? assign.get(id) : (added.find(t => t.id === id) || trackById(id))?.folderId || null;
  const spans = new Map();
  order.forEach((id, i) => { const f = final(id); if (f) spans.set(f, [...(spans.get(f) || []), i]); });
  for (const idx of spans.values()) if (idx.at(-1) - idx[0] + 1 !== idx.length) return refuse('A folder’s tracks must stay together');
  const emptied = folders().filter(f => !spans.has(f.id));
  for (const f of emptied) if (f.locked) return refuse(`Unlock folder “${f.name}” first`);
  const ops = [...before];
  if (order.some((id, i) => id !== cur[i])) ops.push({ op: 'reorder-tracks', trackIds: order });
  if (folder) ops.push(put('folders', folder));
  for (const [id, fid] of assign) ops.push(put('tracks', { id, folderId: fid }));
  for (const f of emptied) ops.push(remove('folders', f.id));
  return ops.length ? { ops, pre, message } : null;
}
const sameFolderAt = (disp, i) => { const a = trackById(disp[i - 1]), b = trackById(disp[i]); return !!a?.folderId && a.folderId === b?.folderId; };
// Sets folder `fid` to exactly `ids`, gathered at its topmost remaining member. Tracks may come from
// other folders; members not listed leave the folder just outside it. An empty list ungroups it.
function membershipPlan(fid, ids, { name, create = false, message } = {}) {
  const disp = displayTracks().map(t => t.id), want = new Set(ids.filter(id => trackById(id)));
  const old = create ? [] : folderMembers(fid).map(t => t.id), f = folderById(fid);
  if (!create && !f) return refuse('The folder no longer exists');
  const leaving = old.filter(id => !want.has(id));
  const assign = new Map([...leaving.map(id => [id, null]), ...[...want].map(id => [id, fid])]);
  const folder = create ? { id: fid, name, disabled: false, locked: false, collapsed: false } : name && name !== f.name ? { id: fid, name } : null;
  const label = name || f?.name;
  if (!want.size) return layoutPlan({ disp, assign, message: message || `Ungrouped “${label}”` });
  const anchor = disp.find(id => want.has(id) && old.includes(id)) || disp.find(id => want.has(id)), at = disp.indexOf(anchor);
  const moving = new Set([...want, ...leaving]), rest = disp.filter(id => !moving.has(id));
  let pos = disp.slice(0, at).filter(id => !moving.has(id)).length;
  while (pos > 0 && pos < rest.length && sameFolderAt(rest, pos)) pos++;
  rest.splice(pos, 0, ...disp.filter(id => leaving.includes(id) && disp.indexOf(id) < at), ...disp.filter(id => want.has(id)), ...disp.filter(id => leaving.includes(id) && disp.indexOf(id) > at));
  return layoutPlan({ disp: rest, assign, folder, pre: create ? { [`folder:${fid}`]: 0 } : {}, message: message || (create ? `Grouped ${plural(want.size, 'track')} into “${label}”` : `Updated folder “${label}”`) });
}
function newFolderName() {
  const n = Math.max(0, ...folders().map(f => Number(/^Folder (\d+)$/.exec(f.name)?.[1] || 0)));
  return `Folder ${Math.max(n, folders().length) + 1}`;
}
// Selected track headers win; otherwise the tracks of the selected clips.
function trackTargets() {
  const ids = selTracks.size ? [...selTracks] : selectedClips().map(c => c.trackId);
  return displayTracks().map(t => t.id).filter(id => ids.includes(id));
}
function folderTarget() {
  if (selFolder) return folderById(selFolder);
  const owners = new Set(trackTargets().map(id => trackById(id)?.folderId).filter(Boolean));
  return owners.size === 1 ? folderById([...owners][0]) : null;
}
function setFolderMembers(fid, ids, options) {
  return edit(() => membershipPlan(fid, ids, options)).then(ok => { if (ok && folderById(fid)) selectFolder(fid); return ok; });
}
function addToFolder(fid, ids) { const f = folderById(fid); if (f) setFolderMembers(fid, [...folderMembers(fid).map(t => t.id), ...ids], { message: `Moved ${plural(ids.length, 'track')} into “${f.name}”` }); }
function removeFromFolder(ids = trackTargets()) {
  const f = folderOf(trackById(ids.find(id => trackById(id)?.folderId)));
  if (!f) return refuse('Select tracks inside a folder');
  const out = new Set(ids.filter(id => trackById(id)?.folderId === f.id));
  edit(() => membershipPlan(f.id, folderMembers(f.id).map(t => t.id).filter(id => !out.has(id)), { message: `Removed ${plural(out.size, 'track')} from “${f.name}”` }));
}
function ungroupFolder(f = folderTarget()) {
  if (!f) return refuse('Select a folder');
  const ids = folderMembers(f.id).map(t => t.id);
  edit(() => membershipPlan(f.id, [])).then(ok => { if (ok) selectTracks(ids.filter(id => trackById(id))); });
}
// Collapse and expand stay available on a locked folder. Collapsing drops selections that would become hidden.
function setCollapsed(f, collapsed) {
  if (collapsed) {
    for (const c of selectedClips()) if (trackById(c.trackId)?.folderId === f.id) selection.delete(c.id);
    if (selTransition && trackById(transitionById(selTransition)?.trackId)?.folderId === f.id) selTransition = null;
    for (const id of [...selTracks]) if (trackById(id)?.folderId === f.id) selTracks.delete(id);
    if (!hasSelection()) selFolder = f.id;
    drawInspector(); syncChrome();
  }
  edit(() => folderById(f.id) ? { ops: [put('folders', { id: f.id, collapsed })], message: `${collapsed ? 'Collapsed' : 'Expanded'} “${f.name}”` } : null);
}
function toggleCollapsed(f = folderTarget()) { if (!f) return refuse('Select a folder'); setCollapsed(f, !f.collapsed); }
function toggleFolder(f, key) {
  edit(() => {
    const fresh = folderById(f.id); if (!fresh) return null;
    const on = !fresh[key];
    return { ops: [put('folders', { id: fresh.id, [key]: on })], message: `${key === 'locked' ? on ? 'Locked' : 'Unlocked' : on ? 'Disabled' : 'Enabled'} folder “${fresh.name}”` };
  });
}
// The unit to move: the selected folder, or selected tracks that sit together in one folder (or none).
function moveUnit(ids = null) {
  if (!ids && selFolder && folderById(selFolder)) return { folder: selFolder, ids: folderMembers(selFolder).map(t => t.id) };
  const disp = displayTracks().map(t => t.id), want = new Set(ids || selTracks), list = disp.filter(id => want.has(id));
  if (!list.length) return null;
  const first = disp.indexOf(list[0]), fid = trackById(list[0]).folderId || null;
  if (list.some((id, i) => disp[first + i] !== id || (trackById(id).folderId || null) !== fid)) return { error: 'Select adjacent tracks in the same folder to move them together' };
  return { ids: list, inFolder: fid };
}
const unitName = u => u.folder ? `“${folderById(u.folder).name}”` : u.ids.length === 1 ? `“${trackById(u.ids[0]).name}”` : plural(u.ids.length, 'track');
// Moves one row in the expanded view. Tracks step into and out of expanded folders at their edges and jump
// past collapsed ones; folders jump past whole folders. Clip times never change.
function movePlan(u, dir) {
  const disp = displayTracks().map(t => t.id), first = disp.indexOf(u.ids[0]), last = disp.indexOf(u.ids.at(-1));
  const n = trackById(disp[dir < 0 ? first - 1 : last + 1]), g = folderOf(n);
  const message = `Moved ${unitName(u)} ${dir < 0 ? 'up' : 'down'}`;
  const shift = past => {
    const rest = disp.filter(id => !u.ids.includes(id)), i = dir < 0 ? rest.indexOf(past[0]) : rest.indexOf(past.at(-1)) + 1;
    rest.splice(i, 0, ...u.ids);
    return layoutPlan({ disp: rest, message });
  };
  if (u.inFolder && n?.folderId !== u.inFolder) return layoutPlan({ disp, assign: new Map(u.ids.map(id => [id, null])), message: `Moved ${unitName(u)} out of “${folderById(u.inFolder).name}”` });
  if (!n) return refuse(`Already at the ${dir < 0 ? 'top' : 'bottom'}`);
  if (u.inFolder || !g) return shift([n.id]);
  if (!u.folder && !g.collapsed) return layoutPlan({ disp, assign: new Map(u.ids.map(id => [id, g.id])), message: `Moved ${unitName(u)} into “${g.name}”` });
  return shift(folderMembers(g.id).map(t => t.id));
}
function moveStep(dir) {
  edit(() => {
    const u = moveUnit();
    if (!u) return refuse('Select a track or folder header first');
    if (u.error) return refuse(u.error);
    return movePlan(u, dir);
  });
}
function renameSelected() {
  if (selFolder) { renameFolder(folderById(selFolder), document.querySelector(`.track[data-folder="${selFolder}"] .track-name`)); return; }
  const t = trackById([...selTracks][0]); if (t) renameTrack(t, document.querySelector(`.track[data-track="${t.id}"] .track-name`));
}
// One dialog creates a folder or edits an existing folder's name and tracks.
function folderDialog(f) {
  const fid = f?.id || uid('folder'), preset = new Set(f ? folderMembers(f.id).map(t => t.id) : trackTargets());
  const name = h('input', { value: f?.name || newFolderName(), maxlength: 256, spellcheck: 'false', 'aria-label': 'Folder name', disabled: !!f?.locked });
  const boxes = [];
  const rows = displayTracks().map(t => {
    const other = t.folderId && t.folderId !== f?.id ? folderOf(t) : null;
    const box = h('input', { type: 'checkbox', checked: preset.has(t.id) });
    box.trackId = t.id; boxes.push(box);
    const row = h('label', { class: 'folder-pick' }, box, h('span', { class: 'track-index' }, trackLabel(t)), h('span', { class: 'label' }, t.name),
      other ? h('span', { class: 'where' }, icon('folder', 'sm'), other.name) : null, lockedTrack(t.id) ? icon('lock', 'sm') : null);
    if (other) row.tip = { title: `In “${other.name}”`, desc: 'Checking it moves the track into this folder.' };
    return row;
  });
  const count = h('span', {});
  const recount = () => { count.textContent = plural(boxes.filter(b => b.checked).length, 'track'); };
  for (const b of boxes) b.onchange = recount;
  recount();
  const body = h('div', { class: 'dialog-body' }, field('Name', name), h('div', { class: 'folder-pick-list' }, rows));
  dialog({ title: f ? 'Edit folder' : 'New folder', iconName: 'folder', body, foot: [count],
    onKey: e => {
      const i = boxes.indexOf(document.activeElement);
      if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && (i >= 0 || e.target === name)) {
        e.preventDefault(); boxes[Math.max(0, Math.min(boxes.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))]?.focus(); return true;
      }
      return false;
    },
    buttons: [{ label: 'Cancel' }, ...(f ? [{ label: 'Ungroup', run: () => ungroupFolder(f) }] : []),
      { label: f ? 'Apply' : 'Create', kind: 'primary', keys: 'Enter', run: () => {
        const v = name.value.trim(), ids = boxes.filter(b => b.checked).map(b => b.trackId);
        if (!v) { say('Name the folder', 'warn'); name.focus(); return false; }
        if (!f && !ids.length) { say('Choose at least one track', 'warn'); return false; }
        setFolderMembers(fid, ids, { name: v, create: !f });
      } }] });
}
function mediaLength(m) { const range=m.metadata?.library; return m.kind === 'graphic' || m.kind === 'image' ? 5 * nominal() : range?.end ? Math.max(1, Math.floor(secs(range.end)*fps()+1e-6)-Math.ceil(secs(range.start)*fps()-1e-6)) : Math.max(1, Math.floor(secs(m.duration) * fps() + 1e-6)); }
function applyAsset(m){
  if(m.metadata.asset.role==='transition'){
    if(!selTransition)return refuse('Select a transition on the timeline, then choose its asset');
    return edit([put('transitions',{id:selTransition,assetId:m.id,params:{}})],'Transition asset changed');
  }
  const selected=selectedClips().filter(clipVisual);
  if(!selected.length)return refuse('Select a visual clip before adding an effect');
  return edit(selected.map(c=>put('clips',{id:c.id,effects:[...(c.effects||[]),{id:uid('effect'),assetId:m.id,params:{},seed:crypto.getRandomValues(new Uint32Array(1))[0]}]})),'Effect added');
}
function addMediaAt(m, trackId, f, sourceRange = null) {
  if(m.metadata.asset&&m.metadata.asset.role!=='content')return applyAsset(m);
  return perform(() => {
    const len = sourceRange ? sourceRangeLength(sourceRange) : mediaLength(m), target = trackId && trackById(trackId);
    const chosen = target && !blockReason(target.id) && free(target.id, f, f + len) ? trackId : undefined;
    return api.command({command:'source-insert', id:m.id, trackId:chosen, at:fromF(Math.max(0,f)),
      fps:project().fps, selection:sourceRange?.selection,
      range:sourceRange && !sourceRange.selection ? sourceRange.range : undefined,
      preconditions:{...snapshot.revisions, ...(sourceRange ? {[`media:${m.id}`]:sourceRange.revision} : {})}});
  }, `Added ${stem(mediaName(m))} at ${tc(f)}`).then(result => { if (result?.clip) select([result.clip.id]); });
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
// Deleting a folder's last track removes the folder in the same batch.
function deleteTrack(t) {
  edit(() => {
    if (!trackById(t.id)) return null;
    if (clipsOn(t.id).length) return refuse('Remove the track’s clips first');
    const f = folderOf(trackById(t.id)), last = f && folderMembers(f.id).length === 1;
    return { ops: [remove('tracks', t.id), ...(last ? [remove('folders', f.id)] : [])], message: `Deleted “${t.name}”${last ? ` and folder “${f.name}”` : ''}` };
  });
}

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
function requestFrame(delay = 100) { if (graphicTextEdit) return; clearTimeout(frameTimer); frameTimer = setTimeout(() => { if (!graphicTextEdit && clips().length && !playback.wantsPlay && monitorView === 'frame') playback.seek(secs(fromF(Math.min(playF, lastFrame()))), false); }, delay); }
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
    const output = jobOutput(job);
    if (!silent) toast({ kind: 'ok', title: 'Export complete', body: basename(output), timeout: 12000, actions: [{ label: 'Show in folder', primary: true, run: () => api.showOutput(output) }] });
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
function togglePlay() {
  if (monitorView === 'source') { source.togglePlay(); return; }
  clearTimeout(frameTimer);
  if (playback.wantsPlay) { playback.pause(); rememberMarks(); }
  else playback.play(secs(fromF(playF)));
}
function setMonitorView(view) {
  if (view !== 'frame') playback.pause(false);
  if (view !== 'source') source.pause();
  const previous = monitorView;
  monitorView = view;
  for (const t of document.querySelectorAll('.monitor .tab')) t.classList.toggle('active', t.dataset.view === view);
  syncPlayButton();
  drawMonitor();
  if (previous !== view && (previous === 'source' || view === 'source')) { drawInspector(); idleHint(); }
  // Edits made while browsing sources were not previewed. Bring Program up to date.
  if (previous === 'source' && view === 'frame' && clips().length) requestFrame(0);
}

// ---------------------------------------------------------------- Drawing
function draw() {
  if (graphicTextEdit) return;
  const p = project(); if (!p) return;
  playback.setProject(p, prefs.renderMode);
  if (!p.clips.length) { shown = null; $('preview').removeAttribute('src'); }
  if (firstLoad) {
    const saved = prefs.marks[p.id];
    if (saved) { inF = saved.in ?? null; outF = saved.out ?? null; playF = saved.play ?? 0; } else if (p.clips.length) playF = Math.min(2 * nominal(), lastFrame());
  }
  // Clips inside collapsed folders cannot stay selected, whoever collapsed them.
  for (const id of [...selection]) if (!clipById(id) || hiddenTrack(clipById(id).trackId)) selection.delete(id);
  if (selTransition && (!transitionById(selTransition) || hiddenTrack(transitionById(selTransition).trackId))) selTransition = null;
  for (const id of [...selTracks]) if (!trackById(id) || hiddenTrack(id)) selTracks.delete(id);
  if (selFolder && !folderById(selFolder)) selFolder = null;
  if (selMarker && !markerById(selMarker)) selMarker = null;
  if (firstLoad && !selection.size && p.clips.some(c => !hiddenTrack(c.trackId))) selection.add([...p.clips].filter(c => !hiddenTrack(c.trackId)).sort((a, b) => secs(a.start) - secs(b.start))[0].id);
  playF = Math.min(playF, navEndF());
  $('project-name').textContent = p.name;
  document.title = `${p.name} · AFClip`;
  drawMedia(); syncSource(); drawInspector(); drawMonitor(); syncChrome();
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

function mediaFolder(m) { return libraryMedia[m.id]?.folder || (m.metadata?.library ? 'Content library' : 'Project media'); }
function mediaLibraryId(m) {
  const link = m.metadata?.library;
  return libraryMedia[m.id]?.importId || (link?.temporary ? link.assetId : link?.rangeId || link?.assetId);
}
function filteredMedia() {
  const query = $('search').value.trim().toLowerCase();
  return (project()?.media || []).filter(m => {
    const data = libraryMedia[m.id];
    return [mediaName(m), m.path, mediaLibraryId(m), m.metadata?.library?.assetId, kindLabel(m.kind), data?.assetName, data?.notes, data?.parentNotes, mediaFolder(m), ...(data?.tags || [])].join('\n').toLowerCase().includes(query);
  }).sort((a, b) => mediaFolder(a).localeCompare(mediaFolder(b)) || mediaName(a).localeCompare(mediaName(b)) || a.id.localeCompare(b.id));
}
async function refreshLibraryMedia() {
  if (libraryLoading || dragMedia || !project() || !api.libraryMedia) return;
  libraryLoading = true;
  const previous = JSON.stringify(libraryMedia), wasOffline = libraryOffline, sourceId = source.mediaId, sourceBefore = JSON.stringify(libraryMedia[sourceId] ?? null);
  const key = JSON.stringify(project().media.map(m => [m.id, m.metadata?.library]));
  try {
    const data = await api.libraryMedia();
    if (dragMedia) return;
    // Ignore a response for media removed or replaced while the request was running.
    if (key !== JSON.stringify(project().media.map(m => [m.id, m.metadata?.library]))) return;
    libraryMedia = data; libraryOffline = false; libraryMediaKey = key;
    if (sourceId && sourceId === source.mediaId && JSON.stringify(data[sourceId] ?? null) !== sourceBefore) void source.refreshAnnotations();
  } catch { libraryOffline = true; libraryMediaKey = key; }
  finally {
    libraryLoading = false;
    if (!dragMedia && (previous !== JSON.stringify(libraryMedia) || wasOffline !== libraryOffline || key !== libraryMediaKey)) drawMedia();
  }
}
setInterval(refreshLibraryMedia, 5000);
// Keep paused source artifacts leased and pick up range/take edits as well.
setInterval(() => { if (monitorView === 'source') void source.refreshAnnotations(); }, 20000);
window.addEventListener('focus', refreshLibraryMedia);

// Thumbnails load lazily, four requests at a time, once per media, path and range. Their <img>
// nodes survive bin redraws, so metadata polling never reloads or re-decodes them. No retries.
const thumbs = new Map(), thumbQueue = [], thumbTargets = new WeakMap();
let thumbActive = 0;
const thumbKey = m => JSON.stringify([m.id, m.path, secs(m.metadata?.library?.start), secs(m.metadata?.library?.end)]);
function thumbFor(m) {
  const key = thumbKey(m);
  let entry = thumbs.get(key);
  if (!entry) {
    const img = new Image(); img.alt = ''; img.decoding = 'async'; img.draggable = false; img.hidden = true;
    entry = { key, id: m.id, state: api.mediaThumbnail ? 'idle' : 'none', img };
    img.onload = () => { entry.state = 'ready'; img.hidden = false; };
    img.onerror = () => { entry.state = 'error'; img.hidden = true; };
    thumbs.set(key, entry);
  }
  return entry;
}
function pumpThumbs() {
  while (thumbActive < 4 && thumbQueue.length) {
    const entry = thumbQueue.shift();
    if (thumbs.get(entry.key) !== entry) continue;
    thumbActive++; entry.state = 'loading';
    Promise.resolve().then(() => api.mediaThumbnail(entry.id))
      .then(result => { if (result?.url) entry.img.src = result.url; else entry.state = 'none'; }, () => { entry.state = 'error'; })
      .finally(() => { thumbActive--; pumpThumbs(); });
  }
}
const thumbObserver = new IntersectionObserver(items => {
  for (const item of items) {
    if (!item.isIntersecting) continue;
    thumbObserver.unobserve(item.target);
    const entry = thumbTargets.get(item.target);
    if (entry?.state === 'idle') { entry.state = 'queued'; thumbQueue.push(entry); }
  }
  pumpThumbs();
}, { root: $('media-list'), rootMargin: '120px 0px' });

function drawMedia() {
  const list = $('media-list'), media = project().media, query = $('search').value.trim().toLowerCase();
  const key = JSON.stringify(media.map(m => [m.id, m.metadata?.library]));
  if (key !== libraryMediaKey && !libraryLoading) void refreshLibraryMedia();
  const usage = new Map(); for (const c of clips()) usage.set(c.mediaId, (usage.get(c.mediaId) || 0) + 1);
  for(const tr of transitions())usage.set(tr.assetId,(usage.get(tr.assetId)||0)+1);
  for(const c of clips())for(const effect of c.effects||[])usage.set(effect.assetId,(usage.get(effect.assetId)||0)+1);
  const visible = filteredMedia();
  $('media-count').textContent = query ? `${visible.length}/${media.length}` : media.length || '';
  const grid = prefs.binView === 'grid';
  list.classList.toggle('grid', grid);
  for (const b of $('bin-view').children) b.classList.toggle('on', b.dataset.view === prefs.binView);
  const scrollTop = list.scrollTop;
  thumbObserver.disconnect();
  list.replaceChildren();
  const live = new Set(media.map(thumbKey));
  for (const key of thumbs.keys()) if (!live.has(key)) thumbs.delete(key);
  let folder;
  for (const m of visible) {
    const data = libraryMedia[m.id], link = m.metadata?.library;
    if (mediaFolder(m) !== folder) {
      folder = mediaFolder(m);
      list.append(h('div', { class: 'section-title' }, folder === 'Inbox'
        ? h('button', { onclick: () => perform(() => api.library(undefined, 'inbox')), 'aria-label': 'Open Inbox in content library', tip: { title: 'Open Inbox in content library' } }, folder)
        : folder));
    }
    const used = usage.get(m.id) || 0, d = secs(m.duration), selectedRange = link?.end != null;
    const status = libraryOffline && link ? 'Library offline, showing saved metadata' : data?.status;
    const meta = (status ? '! ' : '') + (selectedRange ? '↳ ' : '') + (m.kind === 'image' ? 'still' : d ? shortTc(mediaLength(m)) : '—');
    const thumb = thumbFor(m), thumbEl = h('span', { class: 'media-thumb' }, icon(kindIcon(m.kind)), thumb.img);
    if (thumb.state === 'idle') { thumbTargets.set(thumbEl, thumb); thumbObserver.observe(thumbEl); }
    const row = h('div', { class: `media-row ${m.kind} ${status ? 'missing' : ''} ${used ? '' : 'unused'} ${binSelection === m.id ? 'selected' : ''}`, draggable: 'true', dataset: { id: m.id } },
      thumbEl, h('span', { class: 'media-text' }, h('span', { class: 'name' }, mediaName(m)), h('span', { class: 'meta' }, meta)));
    row.tip = () => ({ compact: true, title: mediaName(m), desc: [kindLabel(m.kind), d ? shortTc(Math.round(d * fps())) : null, used ? `${used} clip${used > 1 ? 's' : ''}` : 'Unused'].filter(Boolean).join(' · '),
      meta: [status, selectedRange ? `${link.temporary ? 'Selection' : 'Range'} ${shortTc(toF(link.start))} → ${shortTc(toF(link.end))}` : null,
        m.metadata?.width ? `${m.metadata.width}×${m.metadata.height}${m.metadata.fps ? ` · ${Math.round(secs(frac(...m.metadata.fps.split('/').map(Number))) * 100) / 100} fps` : ''}` : null,
        data?.tags?.length ? data.tags.join(' · ') : null, m.metadata?.authoringPath || m.path].filter(Boolean).join('\n'),
      hint: [{ keys: '#Click', text: 'preview' }, { keys: '#Double-click', text: 'add at playhead' }, { keys: '#Drag', text: 'to timeline' }] });
    row.onclick = () => { binSelection = m.id; list.focus(); drawMedia(); openSource(m); };
    row.ondblclick = () => editable() && addMediaAt(m, null, playF);
    row.oncontextmenu = e => { binSelection = m.id; drawMedia(); contextMenu(e, [{ label: 'Add at playhead on a new track', icon: 'plus', keys: ['Enter'], disabled: !editable(), run: () => addMediaAt(m, null, playF) }, { label: 'Preview in Source monitor', icon: 'eye', run: () => openSource(m) }, ...(m.metadata?.library ? [{label:'Open in content library',icon:'folder',run:()=>api.library(m.metadata.library.assetId)}, {label:link.temporary?'Copy source library ID':'Copy library ID',icon:'copy',run:()=>perform(()=>api.copyText(mediaLibraryId(m)), 'Library ID copied')}]:[]), ...(m.kind !== 'graphic' ? [{label:'Relink media…',icon:'folder',disabled:!editable(),run:()=>perform(()=>api.relinkMedia(m.id, project().revision), result=>result?'Media relinked':'Relink cancelled')}] : []), {label:'Remove from project bin',icon:'x',disabled:!!used||!editable(),run:()=>edit(()=>({ops:[{op:'remove',collection:'media',id:m.id}],pre:{['usage:'+m.id]:snapshot.revisions['usage:'+m.id]||0},message:'Removed from bin'}))}]); };
    row.ondragstart = e => { hideTip(); e.dataTransfer.setData('application/x-afclip-media', m.id); e.dataTransfer.effectAllowed = 'copy'; dragMedia = m; };
    row.ondragend = () => { dragMedia = null; clearDropGhost(); };
    if(m.metadata.asset&&m.metadata.asset.role!=='content'){
      row.draggable=false;row.ondragstart=null;
      row.querySelector('.meta').textContent=m.metadata.asset.role;
      row.tip={compact:true,title:mediaName(m),desc:'Double-click to apply to the selected '+(m.metadata.asset.role==='transition'?'transition':'clip'),meta:m.metadata.authoringPath||m.path};
      row.onclick=()=>{binSelection=m.id;list.focus();drawMedia();};
      row.ondblclick=()=>editable()&&applyAsset(m);
      row.oncontextmenu=e=>contextMenu(e,[{label:'Apply to selection',disabled:!editable(),run:()=>applyAsset(m)},{label:'Remove from project bin',disabled:!!used||!editable()||m.metadata.builtin==='dissolve',run:()=>edit(()=>({ops:[remove('media',m.id)],pre:{['usage:'+m.id]:snapshot.revisions['usage:'+m.id]||0}}),'Asset removed')}]);
    }
    list.append(row);
  }
  if (!media.length) list.append(h('div', { class: 'empty-note' }, 'No media yet.', h('br'), h('button', { class: 'link-button', onclick: () => run('import') }, 'Import media'), ' ', kbd('Ctrl+I'), h('br'), h('button', { class: 'link-button', onclick: () => run('library') }, 'Browse content library'), ' ', kbd('Ctrl+L')));
  else if (!visible.length) list.append(h('div', { class: 'empty-note' }, 'Nothing matches that search.'));
  list.scrollTop = scrollTop;
}
function setBinView(view) {
  if (prefs.binView === view) return;
  prefs.binView = view; savePrefs(); drawMedia(); syncChrome();
  $('media-list').querySelector('.selected')?.scrollIntoView({ block: 'nearest' });
}
// Grid Up/Down picks the nearest card in the adjacent visual row, so folder breaks and
// short rows behave like the eye expects.
function gridStep(i, dir) {
  const rows = [...$('media-list').querySelectorAll('.media-row')], at = rows[i]?.getBoundingClientRect();
  if (!at) return 0;
  const x = at.left + at.width / 2;
  let best = null, bestY = Infinity, bestX = Infinity;
  rows.forEach((el, j) => {
    const r = el.getBoundingClientRect(), dy = (r.top - at.top) * dir;
    if (dy < 1) return;
    const dx = Math.abs(r.left + r.width / 2 - x);
    if (dy < bestY - 1 || (Math.abs(dy - bestY) <= 1 && dx < bestX)) { best = j; bestY = dy; bestX = dx; }
  });
  return best ?? i;
}
$('media-list').addEventListener('keydown', e => {
  const media = filteredMedia(), i = media.findIndex(m => m.id === binSelection), grid = prefs.binView === 'grid';
  const vertical = e.key === 'ArrowDown' || e.key === 'ArrowUp', horizontal = grid && (e.key === 'ArrowLeft' || e.key === 'ArrowRight') && !e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey;
  if (vertical || horizontal) {
    const dir = e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : -1;
    const next = i < 0 ? 0 : grid && vertical ? gridStep(i, dir) : i + dir;
    binSelection = media[Math.max(0, Math.min(media.length - 1, next))]?.id; drawMedia(); $('media-list').querySelector('.selected')?.scrollIntoView({ block: 'nearest' }); e.preventDefault(); e.stopPropagation();
    // Held arrows settle before a source loads.
    clearTimeout(sourceTimer); sourceTimer = setTimeout(() => openSource(mediaById(binSelection)), 90);
  }
  else if (e.key === 'Enter' && i >= 0 && editable()) {
    if (monitorView === 'source' && source.mediaId === media[i].id && source.draft) insertMonitoredSource();
    else addMediaAt(media[i], null, playF);
    e.preventDefault(); e.stopPropagation();
  }
});

const sourceKey = m => JSON.stringify([m.id, m.revision, m.path, m.metadata?.library ?? null]);
let sourceTimer = null;
function openSource(m) {
  clearTimeout(sourceTimer);
  if (!m) return;
  setMonitorView('source');
  void source.open(m, sourceKey(m));
}
// Bin edits can remove or repoint the previewed media.
function syncSource() {
  if (!source.mediaId) return;
  const m = mediaById(source.mediaId);
  if (!m) { source.clear(); if (monitorView === 'source') setMonitorView('frame'); return; }
  if (monitorView === 'source' && sourceKey(m) !== source.key) void source.open(m, sourceKey(m));
}
function drawSourceTime(t) {
  $('source-time').textContent = source.timed ? tc(Math.floor(t * fps() + 1e-7)) : source.status === 'ready' ? kindLabel(source.kind) : '';
}
function syncSourceTransport() {
  const timed = source.timed;
  for (const b of $('source-buttons').querySelectorAll('button')) b.disabled = !timed || (b.dataset.source === 'jump' && !source.blocks.length)
    || (['mark-in','mark-out'].includes(b.dataset.source) && !source.canMark)
    || (b.dataset.source === 'clear' && !source.draft) || (b.dataset.source === 'insert' && !editable());
  const play = $('source-buttons').querySelector('[data-source="play"]'), label = source.running ? 'Pause' : 'Play';
  if (play && play.getAttribute('aria-label') !== label) { play.replaceChildren(icon(source.running ? 'pause' : 'play')); play.setAttribute('aria-label', label); }
  $('source-duration').textContent = timed ? tc(Math.round(source.duration * fps())) : '';
  drawSourceTime(source.time);
}
function drawSourceMonitor() {
  const state = $('frame-state'), loading = source.status === 'loading', warning = source.data?.warning || source.notice;
  state.className = `frame-state ${loading ? 'busy' : source.status === 'error' || warning ? 'stale' : ''}`;
  state.replaceChildren(); state.tip = null;
  if (loading) state.append(icon('render'), 'Loading source');
  else if (source.status === 'error') { state.append(icon('alert'), 'Unavailable'); state.tip = { title: 'Source unavailable', desc: source.error }; }
  else if (source.running) state.append(icon('play'), 'Playing');
  else if (warning) { state.append(icon('alert'), 'Warning'); state.tip = { title: 'Source warning', desc: warning }; }
  else if (source.status === 'ready') state.append(h('span', {}, source.data?.width && source.kind !== 'audio' ? `${source.data.width}×${source.data.height}` : kindLabel(source.kind)));
  $('stage').classList.remove('stale');
  $('stage-busy').hidden = !loading;
  $('preview').hidden = $('native-preview').hidden = $('stage-empty').hidden = true;
}
// Source keys hold JSON, so this key uses a separator the program inspector keys never split on.
const sourceInspectorKey = () => ['source', source.key, source.status, source.version, source.selected?.key || '', source.notice || ''].join('\u0001');
function refreshSourceInspector() { if (monitorView === 'source' && sourceInspectorKey() !== inspectorKey) drawInspector(); }
function insertMonitoredSource() {
  if (!source.timed || !editable()) return;
  const id = source.mediaId, selection = source.selectionRequest(), at = fromF(playF);
  perform(() => api.command({command:'source-insert', id, selection, range:source.draft && !selection ? source.markedRange : undefined, at, fps:project().fps,
    preconditions:{...snapshot.revisions, [`media:${id}`]:source.data.revision}}), 'Inserted source selection').then(result => {
    if (result?.clip) { source.pause(); setMonitorView('frame'); select([result.clip.id]); }
  });
}
const staticField = (label, value, tip) => field(label, h('span', { class: 'field-static', tip: { title: label, desc: tip, meta: value } }, value));
function annotationBody(tags, notes, empty = 'No tags or notes') {
  const out = [];
  if (tags?.length) out.push(h('div', { class: 'tag-list' }, tags.map(t => h('span', { class: 'tag-chip' }, t))));
  if (notes) out.push(h('div', { class: 'insp-notes' }, notes));
  if (!out.length) out.push(h('div', { class: 'insp-notes empty' }, empty));
  return out;
}
// Library annotations are read-only here. Edit them in the content library.
function drawSourceInspector(box) {
  const d = source.data, m = mediaById(source.mediaId) || source.media, kind = source.kind, a = d?.annotations;
  const at = t => tc(Math.floor(t * fps() + 1e-7)), path = m?.metadata?.authoringPath || m?.path;
  $('inspector-title').textContent = 'Source';
  $('inspector-kind').append(icon(kindIcon(kind), 'sm'), kindLabel(kind));
  box.append(h('div', { class: 'insp-head' }, icon(kindIcon(kind)), h('span', { class: 'insp-title' }, a?.name || d?.name || mediaName(m))),
    h('div', { class: 'insp-source', tip: { title: mediaName(m), meta: path } }, basename(path) || kindLabel(kind)));
  if (source.status === 'loading') { box.append(h('div', { class: 'insp-note' }, 'Loading source…')); return; }
  if (source.status === 'error') {
    box.append(h('div', { class: 'insp-note warn' }, source.error),
      h('div', {class:'insp-actions'}, h('button', {class:'chip-button',onclick:()=>source.open(m,sourceKey(m))}, 'Retry source')),
      sourcePreparationControls());
    return;
  }
  if (!d) return;
  for (const text of [d.warning, source.notice]) if (text) box.append(h('div', { class: 'insp-note warn' }, text));
  const range = d.selection;
  box.append(h('div', { class: 'insp-section' }, h('div', { class: 'section-title' }, 'Source'),
    source.duration ? staticField('Duration', at(source.duration)) : null,
    d.width && kind !== 'audio' ? staticField('Size', `${d.width}×${d.height}`) : null,
    range ? staticField('Saved range', `${at(range.start)} → ${at(range.end)}`, 'Project timing for this bin item. Adding it to the timeline uses this range.') : null));
  if (a) box.append(h('div', { class: 'insp-section' }, h('div', { class: 'section-title' }, 'Annotation'), annotationBody(a.tags, a.notes)));
  if (source.timed) box.append(h('div', {class:'insp-section'}, h('div', {class:'section-title'}, 'Editorial selection'),
    source.draft ? staticField('In / Out', `${source.markedRange.start.toFixed(6)} → ${source.markedRange.end.toFixed(6)} s`) : h('div', {class:'insp-note'}, 'Insert the saved range or mark a temporary selection with I and O.'),
    h('div', {class:'source-selection-actions'}, h('button', {class:'chip-button', disabled:!source.canMark, onclick:()=>source.mark()}, 'Mark In'),
    h('button', {class:'chip-button', disabled:!source.canMark, onclick:()=>source.mark(true)}, 'Mark Out'),
    h('button', {class:'chip-button', disabled:!source.draft, onclick:()=>source.clearMarks()}, 'Clear marks'),
    h('button', {class:'chip-button', disabled:!editable(), onclick:insertMonitoredSource}, 'Insert at playhead')),
    !source.canMark ? h('div', {class:'insp-note'}, 'Prepare this source to enable exact In/Out selection. Saved selections can still be inserted.') : null,
    sourcePreparationControls()));
  if (m?.metadata?.library) box.append(h('div', {class:'insp-actions'}, h('button', {class:'chip-button', onclick:()=>api.editLibrary(m.metadata.library.assetId)}, 'Edit in library')));
  const b = source.selected;
  if (b) box.append(h('div', { class: 'insp-section' }, h('div', { class: 'section-title' }, b.name),
    staticField('In', at(b.start)), staticField('Out', at(b.end)), staticField('Length', shortTc(Math.max(0, Math.round((b.end - b.start) * fps())))),
    b.track ? staticField('Track', b.track) : null,
    b.type === 'take' ? annotationBody(null, b.item.text, 'No transcript') : annotationBody(b.item.tags, b.item.notes),
    h('button', {class:'chip-button', disabled:!source.canMark, onclick:()=>source.useSelected()}, 'Use as In/Out')));
  if (source.blocks.length) box.append(h('div', { class: 'insp-section' }, h('div', { class: 'section-title' }, 'Ranges and takes', h('span', { class: 'tab-spacer' }), String(source.blocks.length)),
    source.blocks.map(x => h('button', { class: `annotation-item ${x.type} ${x.key === b?.key ? 'selected' : ''}`, onclick: () => source.select(x), tip: { title: x.name, meta: [`${at(x.start)} → ${at(x.end)}`, x.track ? `Track ${x.track}` : null].filter(Boolean).join('\n') } },
      h('span', { class: 'swatch' }), h('span', { class: 'label' }, x.name), h('span', { class: 'when' }, shortTc(Math.floor(x.start * fps() + 1e-7)))))));
}

function sourcePreparationControls() {
  if (!source.media?.metadata?.library) return null;
  return h('div', {}, h('div', {class:'source-selection-actions'},
    h('button', {class:'chip-button',disabled:source.preparing,onclick:()=>source.prepare()}, source.data?.prepared ? 'Prepare again' : 'Prepare source'),
    source.preparing ? h('button', {class:'chip-button',onclick:()=>source.cancelPreparation()}, 'Cancel preparation') : null),
    source.preparing ? h('div', {class:'insp-note'}, (source.preparation||[]).map(j=>`${j.phase||j.status} · ${Math.round((j.progress||0)*100)}%`).join('\n') || 'Queuing preparation…') : null,
    source.status==='error'&&source.notice ? h('div',{class:'insp-note warn'},source.notice) : null);
}

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
  const sourceMode = monitorView === 'source';
  $('monitor').classList.toggle('source-mode', sourceMode);
  $('source-stage').hidden = $('source-panel').hidden = !sourceMode;
  $('program-transport').hidden = $('mini-ruler').hidden = sourceMode;
  $('source-tab').hidden = !source.media;
  if (sourceMode) { drawSourceMonitor(); drawPlayhead(); return; }
  const busy = !!frameJobId || playback.busy, cur = Math.min(playF, lastFrame());
  const stale = !!shown && !playback.wantsPlay && (shown.f !== cur || shown.revision !== p.revision);
  const state = $('frame-state');
  state.className = `frame-state ${busy ? 'busy' : stale ? 'stale' : ''}`;
  state.replaceChildren();
  if (busy) state.append(icon('render'), playback.busy ? (playback.ready ? 'Seeking' : playback.audioDirty ? 'Updating audio' : 'Preparing preview') : `Rendering ${tc(cur)}`);
  else if (playback.wantsPlay) state.append(icon('play'), 'Playing');
  else if (stale) state.append(icon('alert'), shown.f !== cur ? 'Not at playhead' : 'Edited since render', kbd('Enter'));
  else if (shown) state.append(h('span', {}, `Frame ${tc(shown.f)}`));
  state.tip = busy ? { title: 'Rendering exact frame', desc: frameJobId ? 'Full-resolution frame from original media.' : 'Preview uses the same composition and timing as export.' } : stale ? { action: 'renderFrame', desc: 'The image shows an earlier frame or project state. Render to update it.' } : null;
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
  agents?.contextChanged();
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
  if (monitorView === 'source' && source.media) {
    const key = sourceInspectorKey(), scroll = key.split('\u0001')[1] === inspectorKey.split('\u0001')[1] ? box.scrollTop : 0;
    inspectorKey = key; box.replaceChildren(); $('inspector-kind').replaceChildren();
    drawSourceInspector(box); box.scrollTop = scroll; return;
  }
  const list = selectedClips(), tr = selTransition && transitionById(selTransition), mk = selMarker && markerById(selMarker);
  const fo = selFolder && folderById(selFolder), heads = displayTracks().filter(t => selTracks.has(t.id));
  const layout = () => `${p.revision}`;
  const key = mk ? `k:${mk.id}:${mk.revision}:${p.fps.num}/${p.fps.den}` : tr ? `t:${tr.id}:${tr.revision}` : list.length === 1 ? `c:${list[0].id}:${list[0].revision}:${list[0].trackId}` : list.length ? `m:${list.map(c => c.id).join()}`
    : fo ? `f:${fo.id}:${layout()}` : heads.length ? `r:${heads.map(t => t.id).join()}:${layout()}` : `p:${p.revision}`;
  if (box.contains(document.activeElement) && document.activeElement.matches('input') && key.split(':').slice(0, 2).join() === inspectorKey.split(':').slice(0, 2).join()) return;
  inspectorKey = key;
  const scroll = box.scrollTop;
  box.replaceChildren();
  $('inspector-kind').replaceChildren();
  if (mk) drawMarkerInspector(box, mk);
  else if (tr) drawTransitionInspector(box, tr);
  else if (list.length === 1) drawClipInspector(box, list[0]);
  else if (list.length > 1) {
    $('inspector-title').textContent = 'Inspector';
    box.append(h('div', { class: 'insp-head' }, icon('layers'), h('strong', {}, `${list.length} clips selected`)),
      h('div', { class: 'insp-note' }, `${tc(Math.min(...list.map(startF)))} → ${tc(Math.max(...list.map(endF)))}`),
      h('div', { class: 'insp-actions' }, chip('copy'), chip('mute', 'Mute'), chip('nudgeLeft', 'Nudge'), chip('delete', null, 'danger')),
      h('div', { class: 'insp-note' }, 'Drag any selected clip to move them together. Alt + arrows nudge by a frame.'));
  } else if (fo) drawFolderInspector(box, fo);
  else if (heads.length) drawTracksInspector(box, heads);
  else drawSequenceInspector(box, p);
  box.scrollTop = scroll;
}
function drawClipInspector(box, c) {
  const m = mediaById(c.mediaId), locked = !!lockedTrack(c.trackId) || !editable();
  const durF = endF(c) - startF(c), speed = secs(c.speed);
  // `changes` may be a function of the clip as it is when the edit runs.
  // The engine carries timing to linked companions; their fades are clamped here so a shorter pair stays valid.
  const putClip = (changes, message) => edit(() => {
    const fresh = clipById(c.id); if (!fresh) return null;
    const value = typeof changes === 'function' ? changes(fresh) : changes;
    const peers = value.duration ? linkedPeers(fresh).map(o => ({ id: o.id, ...fadeClamp(o, value.duration) })).filter(o => Object.keys(o).length > 1) : [];
    return { ops: [put('clips', { id: c.id, ...value }), ...peers.map(o => put('clips', o))], message };
  });
  const kind = clipKind(c), peers = linkedPeers(c);
  $('inspector-title').textContent = 'Clip';
  $('inspector-kind').append(icon(kindIcon(kind), 'sm'), kindLabel(kind));
  const name = h('input', { value: clipName(c), maxlength: 160, disabled: locked, spellcheck: 'false', tip: { title: 'Clip name', desc: 'Shown on the timeline. Agents see this name through the CLI.' } });
  name.onkeydown = e => { if (e.key === 'Enter') name.blur(); if (e.key === 'Escape') { name.value = clipName(c); name.blur(); } };
  name.onblur = () => { const v = name.value.trim(); if (v && v !== clipName(c)) putClip({ name: v }, 'Clip renamed'); else name.value = clipName(c); };
  box.append(h('div', { class: 'insp-head' }, icon(kindIcon(kind)), name), h('div', { class: 'insp-source', tip: { title: mediaName(m), desc: peers.length ? `Linked to “${peers.map(clipName).join('”, “')}”. Moves, trims and splits act on both.` : null, meta: m?.metadata?.authoringPath || m?.path } }, `${mediaName(m)} · track “${trackById(c.trackId)?.name}”`, peers.length ? h('span', { class: 'insp-link' }, icon('link', 'sm'), 'Linked') : null));
  if (locked && editable()) box.append(h('div', { class: 'insp-note warn' }, `${trackById(c.trackId)?.locked ? 'This track' : 'This track’s folder'} is locked. Unlock it in the track header to edit.`));

  const timingLocked = locked || !!lockedIn(peers);
  const maxDur = sourceBound(m) ? Math.floor((secs(m.duration) - secs(c.sourceIn)) / speed * fps() + 1e-6) : undefined;
  const timing = h('div', { class: 'insp-section' }, h('div', { class: 'section-title' }, 'Timing'),
    field('Start', timeInput(startF(c), f => putClip({ start: fromF(f) }, `Start ${tc(f)}`), { disabled: timingLocked }), { tip: 'Where the clip begins on the timeline.' }),
    field('Duration', timeInput(durF, f => { const d = fromF(f); putClip(fresh => ({ duration: d, ...fadeClamp(fresh, d) }), `Duration ${shortTc(f)}`); }, { min: 1, max: maxDur, disabled: timingLocked }), { tip: 'Length on the timeline. Speed stays the same, so this trims or extends the source.' }),
    ...(m?.kind === 'image' ? [] : [field('Source in', timeInput(toF(c.sourceIn), f => putClip({ sourceIn: fromF(f) }, `Source in ${tc(f)}`), { disabled: timingLocked, max: sourceBound(m) ? Math.floor((secs(m.duration) - secs(c.duration) * speed) * fps() + 1e-6) : undefined }), { tip: 'The first source frame used, measured in the source media.' }),
      field('Speed', plainNumber(speed * 100, 1, v => {
        const next = frac(Math.round(v * 10), 1000), dur = Math.max(1, Math.floor(durF * speed / secs(next) + 1e-6));
        putClip(fresh => ({ speed: next, duration: fromF(dur), ...fadeClamp(fresh, fromF(dur)) }), `Speed ${pct(secs(next))}`);
      }, { min: 1, max: 1600, step: 1, big: 10, disabled: timingLocked }), { unit: '%', tip: 'Keeps the same source section and changes duration to match. Audio pitch follows speed. Shift-dragging a clip edge does the same on the timeline.' })]));
  box.append(timing);

  if (clipHasAudio(c)) box.append(h('div', { class: 'insp-section' }, h('div', { class: 'section-title' }, 'Audio', h('span', { class: 'tab-spacer' }),
      h('button', { class: `icon-button small ${c.mute ? 'warn' : ''}`, disabled: locked, onclick: () => putClip({ mute: !c.mute }, c.mute ? 'Unmuted' : 'Muted'), tip: { action: 'mute', title: c.mute ? 'Unmute' : 'Mute' } }, icon(c.mute ? 'mute' : 'volume'))),
    field('Volume', numberInput({ value: c.volume <= 0 ? -60 : Math.max(-60, 20 * Math.log10(c.volume)), format: v => v <= -60 ? '-∞' : v.toFixed(1), parse: t => /^-?\s*(inf|∞)/i.test(String(t).trim()) ? -60 : Number.isFinite(Number(t)) && String(t).trim() !== '' ? Number(t) : null, step: .5, big: 3, min: -60, max: 24, disabled: locked,
      onCommit: db => putClip({ volume: db <= -60 ? 0 : Math.min(16, 10 ** (db / 20)) }, `Volume ${db <= -60 ? '-∞' : db.toFixed(1)} dB`) }), { unit: 'dB', tip: '0 dB is the source level. Type -inf to silence.' }),
    field('Fade in', timeInput(toF(c.fadeIn), f => putClip({ fadeIn: fromF(f) }, `Fade in ${shortTc(f)}`), { max: durF, disabled: locked }), { tip: 'Ramps picture and sound up from silence/black at the clip start.' }),
    field('Fade out', timeInput(toF(c.fadeOut), f => putClip({ fadeOut: fromF(f) }, `Fade out ${shortTc(f)}`), { max: durF, disabled: locked }), { tip: 'Ramps down to silence/black at the clip end.' })));
  else if (kind !== 'audio') box.append(h('div', { class: 'insp-section' }, h('div', { class: 'section-title' }, 'Fades'),
    field('Fade in', timeInput(toF(c.fadeIn), f => putClip({ fadeIn: fromF(f) }, `Fade in ${shortTc(f)}`), { max: durF, disabled: locked })),
    field('Fade out', timeInput(toF(c.fadeOut), f => putClip({ fadeOut: fromF(f) }, `Fade out ${shortTc(f)}`), { max: durF, disabled: locked }))));

  if (m?.kind === 'graphic') {
    const section = h('div', {class:'insp-section'}, h('div', {class:'section-title'}, 'Text'));
    box.append(section);
    api.command({command:'text-fields',clipId:c.id}).then(info => {
      if (!section.isConnected) return;
      for (const item of info.fields) {
        const input = h('textarea', {rows:2, value:item.value, disabled:locked, 'aria-label':item.id});
        let base;
        input.onfocus = () => { clearTimeout(frameTimer); playback.pause(false); base = {revision:info.revision,mediaRevision:info.mediaRevision}; graphicTextEdit = {inspector:true,clipId:c.id,field:item.id,...base,predecessor:textCommit}; };
        input.onkeydown = e => { if (e.key === 'Escape') {input.value=item.value;input.blur();} };
        input.onblur = () => {
          const edit = graphicTextEdit, value = input.value; graphicTextEdit = null;
          if (value !== item.value) commitGraphicText(edit, value).then(result => {
            if (result?.project) { info.revision = result.project.clips.find(clip => clip.id === c.id).revision; item.value = value; }
          });
          else if (playback.revision !== project().revision && !textCommit) {draw();requestFrame(0);}
        };
        section.append(field(item.id, input));
        if (item.overridden) section.append(h('button', {class:'chip-button text-reset', onclick:() => perform(() => api.command({command:'text-set',clipId:c.id,field:item.id,reset:true,revision:info.revision,mediaRevision:info.mediaRevision}), 'Text reset'), disabled:locked}, `Reset ${item.id}`));
      }
      for (const id of info.missing) section.append(h('button', {class:'chip-button text-reset', disabled:locked, onclick:() => perform(() => api.command({command:'text-set',clipId:c.id,field:id,reset:true,revision:info.revision,mediaRevision:info.mediaRevision}), 'Missing text override removed')}, `Remove missing field ${id}`));
      if (!info.fields.length && !info.missing.length) section.remove();
    }).catch(error => { if (section.isConnected) section.append(h('p',{},explain(error))); });
  }
  if (clipVisual(c)) {
    const t = c.transform || {}, setT = (k, v, message) => putClip(fresh => ({ transform: { ...(fresh.transform || {}), [k]: v } }), message);
    box.append(h('div', { class: 'insp-section' }, h('div', { class: 'section-title' }, 'Transform'),
      field('Position', h('div', { class: 'field-pair' }, plainNumber(t.x ?? 0, 0, v => setT('x', v, `X ${v}`), { disabled: locked }), plainNumber(t.y ?? 0, 0, v => setT('y', v, `Y ${v}`), { disabled: locked })), { tip: 'Offset in pixels from the centered layout, X then Y.' }),
      field('Scale', plainNumber((t.scale ?? 1) * 100, 1, v => setT('scale', v / 100, `Scale ${v}%`), { min: 1, max: 1000, disabled: locked }), { unit: '%' }),
      field('Rotation', plainNumber(t.rotation ?? 0, 1, v => setT('rotation', v, `Rotation ${v}°`), { step: 1, big: 15, disabled: locked }), { unit: '°' }),
      field('Opacity', plainNumber((t.opacity ?? 1) * 100, 0, v => setT('opacity', v / 100, `Opacity ${v}%`), { min: 0, max: 100, disabled: locked }), { unit: '%' }),
      field('Framing', segmented([['fit', 'Fit', 'Show the whole picture, letterboxing if needed.'], ['fill', 'Fill', 'Cover the frame and crop the excess.']], t.fit || 'fit', v => setT('fit', v, v === 'fill' ? 'Fill frame' : 'Fit frame'), locked), { tip: 'Shift+F toggles.' })));
  }
  if(clipVisual(c))drawEffectsInspector(box,c,locked);
  box.append(h('div', { class: 'insp-actions' }, chip('split', 'Split'), chip('dissolve', 'Dissolve'), peers.length ? chip('unlink', 'Unlink') : clipHasAudio(c) && m?.kind === 'video' ? chip('detachAudio', 'Detach') : null, chip('copy'), chip('delete', null, 'danger')));
}
function assetParameters(box, instance, locked, update) {
  const asset=mediaById(instance.assetId)?.metadata.asset;
  if(!asset)return;
  const section=h('div',{class:'insp-section'},h('div',{class:'section-title'},'Parameters'));
  for(const [id,spec] of Object.entries(asset.parameters||{})){
    const value=instance.params?.[id]??spec.default,set=value=>update({...instance.params,[id]:value});let input;
    if(spec.type==='number')input=plainNumber(value,2,set,{min:spec.min,max:spec.max,step:spec.step||.1,disabled:locked});
    else if(spec.type==='boolean'){input=h('input',{type:'checkbox',checked:value,disabled:locked});input.onchange=()=>set(input.checked);}
    else if(spec.type==='choice'){input=h('select',{disabled:locked},...spec.choices.map(v=>h('option',{value:v,selected:v===value},v)));input.onchange=()=>set(input.value);}
    else {input=h('input',{type:spec.type==='color'?'color':'text',value,disabled:locked});input.onchange=()=>set(input.value);}
    section.append(field(spec.label||id,input));
  }
  for(const id of Object.keys(instance.params||{}))if(!Object.hasOwn(asset.parameters||{},id))section.append(h('button',{disabled:locked,onclick:()=>{const next={...instance.params};delete next[id];update(next);}},`Remove missing parameter ${id}`));
  if(section.children.length>1)box.append(section);
}
function assetSelect(role,value,locked,change){
  const select=h('select',{disabled:locked,'aria-label':role+' asset'},...project().media.filter(m=>m.metadata.asset?.role===role).map(m=>h('option',{value:m.id,selected:m.id===value},mediaName(m))));
  select.onchange=()=>change(select.value);return select;
}
function drawTransitionInspector(box, t) {
  const a=clipById(t.fromClipId),b=clipById(t.toClipId),locked=!!lockedTrack(t.trackId)||!editable(),asset=mediaById(t.assetId);
  const update=value=>edit([put('transitions',{id:t.id,...value})],'Transition updated');
  $('inspector-title').textContent='Transition';$('inspector-kind').append(icon('dissolve','sm'),asset?.metadata.asset?.name||'HTML');
  const room=alignment=>dissolveRoom(a,b,alignment,t.id);
  box.append(h('div',{class:'insp-head'},icon('dissolve'),h('strong',{},asset?.metadata.asset?.name||'HTML transition')),
    h('div',{class:'insp-source'},`${clipName(a)} to ${clipName(b)}`),
    field('Asset',assetSelect('transition',t.assetId,locked,assetId=>update({assetId,params:{}}))),
    h('div',{class:'insp-section'},h('div',{class:'section-title'},'Timing'),
      field('Duration',timeInput(toF(t.duration),f=>update({duration:fromF(f)}),{min:1,max:room(t.alignment),disabled:locked})),
      field('Alignment',segmented([['start','Start'],['center','Center'],['end','End']],t.alignment,v=>{if(room(v)<toF(t.duration)){say('Transition would overlap another cut','warn');return;}update({alignment:v});},locked)),
      field('Audio',segmented([['crossfade','Crossfade'],['cut','Cut']],t.audio,v=>update({audio:v}),locked))));
  assetParameters(box,t,locked,params=>update({params}));
  const before=t.alignment==='start'?0:t.alignment==='end'?secs(t.duration):secs(t.duration)/2,after=secs(t.duration)-before;
  const hold=(sourceBound(mediaById(a.mediaId))&&secs(a.sourceIn)+(secs(a.duration)+after)*secs(a.speed)>secs(mediaById(a.mediaId).duration)+1e-7)||(sourceBound(mediaById(b.mediaId))&&secs(b.sourceIn)<before*secs(b.speed));
  box.append(h('div',{class:'insp-note'},hold?'Uses held boundary frames where source footage runs out.':'Uses available source footage. Cut position and timeline duration stay fixed.'),
    h('div',{class:'insp-note'},asset?.metadata.authoringPath||asset?.path||''),
    h('button',{class:'chip-button',disabled:locked,onclick:()=>perform(async()=>{const r=await api.command({command:'asset-duplicate',assetId:t.assetId});await api.command({command:'apply',batch:{preconditions:r.revisions,operations:[put('transitions',{id:t.id,assetId:r.media.id})]}});},'Transition made unique')},'Make unique'),
    h('div',{class:'insp-actions'},chip('delete',null,'danger')));
}
function drawEffectsInspector(box,c,locked){
  const choices=project().media.filter(m=>m.metadata.asset?.role==='effect');if(!choices.length)return;
  const set=effects=>edit([put('clips',{id:c.id,effects})],'Effects updated');
  const section=h('div',{class:'insp-section'},h('div',{class:'section-title'},'Effects'));
  for(const [index,effect] of (c.effects||[]).entries()){
    section.append(h('div',{class:'section-title'},mediaName(mediaById(effect.assetId)),
      h('button',{disabled:locked||index===0,onclick:()=>{const next=[...c.effects];[next[index-1],next[index]]=[next[index],next[index-1]];set(next);}},'Up'),
      h('button',{disabled:locked,onclick:()=>set(c.effects.filter(e=>e.id!==effect.id))},'Remove')));
    assetParameters(section,effect,locked,params=>set(c.effects.map(e=>e.id===effect.id?{...e,params}:e)));
    section.append(h('button',{disabled:locked,onclick:()=>perform(async()=>{const r=await api.command({command:'asset-duplicate',assetId:effect.assetId});const clip=r.project.clips.find(v=>v.id===c.id);return api.command({command:'apply',batch:{preconditions:r.revisions,operations:[put('clips',{id:c.id,effects:clip.effects.map(e=>e.id===effect.id?{...e,assetId:r.media.id}:e)})]}});},'Effect made unique')},'Make unique'));
  }
  const select=assetSelect('effect',choices[0].id,locked,()=>{});
  section.append(select,h('button',{class:'chip-button',disabled:locked,onclick:()=>set([...(c.effects||[]),{id:uid('effect'),assetId:select.value,params:{},seed:crypto.getRandomValues(new Uint32Array(1))[0]}])},'Add effect'));
  box.append(section);
}
function drawMarkerInspector(box, m) {
  const disabled = !editable(), beyond = secs(m.time) * fps() > timelineEndF() + 1e-8;
  $('inspector-title').textContent = 'Marker';
  $('inspector-kind').append(icon('marker', 'sm'), 'Timeline');
  const name = h('input', { value: m.name, maxlength: 256, disabled, spellcheck: 'false', tip: { title: 'Marker name', desc: 'Shown on the ruler. Agents see markers through the CLI.' } });
  name.onkeydown = e => { if (e.key === 'Enter') name.blur(); if (e.key === 'Escape') { name.value = m.name; name.blur(); } };
  name.onblur = () => { const v = name.value.trim(); if (v && v !== m.name) changeMarker(m.id, { name: v }); else name.value = m.name; };
  box.append(h('div', { class: 'insp-head' }, icon('marker'), name),
    h('div', { class: 'insp-section' }, h('div', { class: 'section-title' }, 'Timing'),
      field('Time', timeInput(markerF(m), f => changeMarker(m.id, { f }), { disabled }), { tip: 'Where the marker sits on the timeline. Markers apply to every track.' })),
    ...(beyond ? [h('div', { class: 'insp-note' }, 'After the last clip. Exports are unaffected.')] : []),
    h('div', { class: 'insp-actions' }, chip('prevMarker', 'Previous'), chip('nextMarker', 'Next'), chip('delete', null, 'danger')));
}
// Toggles show the object's own state; a folder's state is listed separately because it applies on top.
const stateField = (label, on, labels, onPick, disabled, tip) => field(label, segmented([[false, labels[0]], [true, labels[1]]], !!on, onPick, disabled), { tip });
function nameInput(value, disabled, title, commit) {
  const input = h('input', { value, maxlength: 256, disabled, spellcheck: 'false', tip: { title, keys: 'F2' } });
  input.onkeydown = e => { if (e.key === 'Enter') input.blur(); if (e.key === 'Escape') { input.value = value; input.blur(); } };
  input.onblur = () => { const v = input.value.trim(); if (v && v !== value) commit(v); else input.value = value; };
  return input;
}
function drawFolderInspector(box, f) {
  $('inspector-title').textContent = 'Folder';
  $('inspector-kind').append(icon('folder', 'sm'), f.collapsed ? 'Collapsed' : 'Expanded');
  const off = !editable(), members = folderMembers(f.id);
  box.append(h('div', { class: 'insp-head' }, icon('folder'), nameInput(f.name, off || f.locked, 'Folder name', v => edit(() => folderById(f.id) ? { ops: [put('folders', { id: f.id, name: v })], message: `Renamed folder to “${v}”` } : null))));
  if (f.locked && !off) box.append(h('div', { class: 'insp-note warn' }, 'Locked. Unlock to edit its tracks, membership or order.'));
  box.append(h('div', { class: 'insp-section' }, h('div', { class: 'section-title' }, 'Folder'),
      stateField('Output', f.disabled, ['On', 'Off'], () => toggleFolder(f, 'disabled'), off || f.locked, 'Off hides the picture and silences the audio of every track inside. Their own settings return when it is back on.'),
      stateField('Lock', f.locked, ['Unlocked', 'Locked'], () => toggleFolder(f, 'locked'), off, 'Locked folders reject edits to their tracks and clips, including membership and reordering.'),
      stateField('View', f.collapsed, ['Expanded', 'Collapsed'], () => setCollapsed(f, !f.collapsed), off, 'Collapsed folders show a read-only clip overview.')),
    h('div', { class: 'insp-section' }, h('div', { class: 'section-title' }, 'Tracks', h('span', { class: 'tab-spacer' }), String(members.length)),
      members.map(t => h('button', { class: 'annotation-item folder-member', disabled: f.collapsed, onclick: () => selectTracks([t.id]), tip: { title: t.name, meta: [t.disabled ? 'Own setting: disabled' : null, t.locked ? 'Own setting: locked' : null].filter(Boolean).join('\n') || null } },
        h('span', { class: 'track-index' }, trackLabel(t)), h('span', { class: 'label' }, t.name), t.disabled ? icon('eye-off', 'sm') : null, t.locked ? icon('lock', 'sm') : null))),
    h('div', { class: 'insp-actions' }, chip('editFolder', 'Tracks…'), chip('moveTrackUp', 'Up'), chip('moveTrackDown', 'Down'), chip('ungroup', 'Ungroup', 'danger')));
}
function drawTracksInspector(box, list) {
  const off = !editable(), t = list[0], f = folderOf(t);
  $('inspector-title').textContent = list.length > 1 ? 'Tracks' : 'Track';
  if (list.length > 1) {
    box.append(h('div', { class: 'insp-head' }, icon('layers'), h('strong', {}, `${list.length} tracks selected`)),
      h('div', { class: 'insp-actions' }, chip('groupTracks', 'Group'), chip('moveTrackUp', 'Up'), chip('moveTrackDown', 'Down'), can('removeFromFolder') ? chip('removeFromFolder', 'Remove from folder') : null));
    return;
  }
  const locked = lockedTrack(t.id);
  box.append(h('div', { class: 'insp-head' }, icon('add-track'), nameInput(t.name, off || locked, 'Track name', v => changeTrack(t, { name: v }, `Renamed track to “${v}”`))));
  if (f?.locked && !off) box.append(h('div', { class: 'insp-note warn' }, `Folder “${f.name}” is locked.`));
  box.append(h('div', { class: 'insp-section' }, h('div', { class: 'section-title' }, 'Track'),
      stateField('Output', t.disabled, ['On', 'Off'], () => toggleTrack(t, 'disabled'), off || locked, 'Off hides the picture and silences the audio. Clips stay editable.'),
      stateField('Lock', t.locked, ['Unlocked', 'Locked'], () => toggleTrack(t, 'locked'), off || !!f?.locked, 'Locked tracks reject every GUI and CLI edit.'),
      field('Folder', f ? h('button', { class: 'chip-button', onclick: () => selectFolder(f.id), tip: { title: 'Select folder' } }, icon('folder', 'sm'), f.name, f.disabled ? icon('eye-off', 'sm') : null, f.locked ? icon('lock', 'sm') : null) : h('span', { class: 'field-static' }, '—'))),
    h('div', { class: 'insp-actions' }, f ? chip('removeFromFolder', 'Remove from folder') : chip('groupTracks', 'Group'), chip('moveTrackUp', 'Up'), chip('moveTrackDown', 'Down')));
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
      h('div', { class: 'insp-note', style: { marginTop: 0 } }, `${p.tracks.length} tracks · ${folders().length ? `${plural(folders().length, 'folder')} · ` : ''}${p.clips.length} clips · ${p.transitions.length} dissolves · ${markers().length} markers · ${p.media.length} media`)),
    h('div', { class: 'insp-note' }, 'Select a clip to edit its timing, audio and framing.'));
}

// ---------------------------------------------------------------- Timeline
const lanesWidth = () => Math.max(200, $('tl-scroll').clientWidth - HEAD_W);
const frameX = f => f / fps() * pps;
const xFrame = x => Math.round(x / pps * fps());
function contentWidth() {
  const endS = Math.max(navEndF() / fps(), 5);
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
  ruler.replaceChildren(...parts, h('div', { class: 'ruler-range', hidden: true }), ...rulerMarkers(), h('div', { class: 'ruler-head' }));
}
// Markers at the same instant share one flag. Its label shows the selected (or first) name and a count.
function markerGroups() {
  const groups = [];
  for (const m of sortedMarkers()) { const g = groups.at(-1); if (g && sameTime(g[0].time, m.time)) g.push(m); else groups.push([m]); }
  return groups;
}
function rulerMarkers() {
  const groups = markerGroups(), lastF = timelineEndF();
  return groups.map((g, i) => {
    const m = g.find(o => o.id === selMarker) || g[0], left = secs(m.time) * pps;
    const room = i + 1 < groups.length ? (secs(groups[i + 1][0].time) - secs(m.time)) * pps - 12 : 180;
    const beyond = secs(m.time) * fps() > lastF + 1e-8;
    const el = h('div', { class: `marker ${g.some(o => o.id === selMarker) ? 'selected' : ''} ${beyond ? 'beyond' : ''}`, dataset: { id: m.id }, style: { left: `${left}px` } },
      room >= 28 ? h('span', { class: 'marker-name', style: { maxWidth: `${Math.min(180, room)}px` } }, m.name, g.length > 1 ? h('b', {}, ` +${g.length - 1}`) : null) : null);
    el.group = g;
    el.tip = () => ({ title: g.length > 1 ? plural(g.length, 'marker') : m.name, follow: true,
      meta: [tc(markerF(m)), ...(g.length > 1 ? g.map(o => `· ${o.name}`) : []), beyond ? 'After the last clip. Exports are unaffected.' : null].filter(Boolean).join('\n'),
      hint: [{ keys: '#Click', text: g.length > 1 ? 'go to / cycle' : 'go to' }, { keys: '#Drag', text: 'move' }, { keys: '#Double-click', text: 'edit' }, { keys: 'Delete', text: 'remove' }, { keys: ['Shift+Up', 'Shift+Down'], text: 'next / prev' }] });
    return el;
  });
}
function drawMarkerLine(f) {
  for (const old of document.querySelectorAll('.marker-line')) old.remove();
  const m = markerById(selMarker);
  if (!m && f == null) return;
  $('tl-overlay').append(h('div', { class: 'marker-line', style: { left: `${f != null ? frameX(f) : secs(m.time) * pps}px` } }));
}
function drawTimeline() {
  const p = project(); if (!p) return;
  if (drag || editingTrack) { deferredDraw = true; return; }
  deferredDraw = false;
  if (fitZoom) pps = Math.max(2, (lanesWidth() - 24) / Math.max(navEndF() / fps(), 5));
  const width = contentWidth();
  $('tl-inner').style.width = `${HEAD_W + width}px`;
  drawRuler(width);
  const host = $('tracks'), overlay = $('tl-overlay');
  host.replaceChildren(overlay);
  overlay.style.width = `${width}px`;
  const headed = new Set();
  for (const t of displayTracks()) {
    const f = folderOf(t);
    if (f && !headed.has(f.id)) { headed.add(f.id); host.append(folderRow(f, width)); }
    if (!f?.collapsed) host.append(trackRow(t, width, f));
  }
  if (!p.tracks.length) host.append(h('div', { class: 'tl-empty-note' }, 'Drag media here from the bin, or double-click it to add it at the playhead.'));
  $('tl-empty').style.width = `${HEAD_W + width}px`;
  drawMarkerLine(); drawPlayhead(); pinLabels(); positionMarkerPopover(); agents?.reposition();
}
// Keep clip names readable when a clip starts left of the visible area.
function pinLabels() {
  const left = $('tl-scroll').scrollLeft;
  for (const body of document.querySelectorAll('.clip-body')) {
    const clip = body.parentElement, x = clip.offsetLeft, w = clip.offsetWidth;
    body.style.left = left > x ? `${7 + Math.min(left - x, Math.max(0, w - 60))}px` : '';
  }
}
const HEAD_HINT = [{ keys: '#Click', text: 'select' }, { keys: '#Drag', text: 'reorder' }, { keys: '#Double-click name', text: 'rename' }, { keys: ['Alt+Up', 'Alt+Down'], text: 'move' }, { keys: 'Ctrl+G', text: 'group' }];
// Track buttons show the track's own setting. A folder's Disable dims it on top; a folder's Lock freezes it.
function trackRow(t, width, f = folderOf(t)) {
  const nameEl = h('span', { class: 'track-name' }, t.name);
  nameEl.tip = { title: t.name, desc: `Track ${trackLabel(t)} of ${tracks().length}${f ? ` in “${f.name}”` : ''}. Higher tracks draw over lower ones; audio from every enabled track is mixed.`, hint: HEAD_HINT };
  const off = !editable(), held = !!f?.locked;
  const head = h('div', { class: 'track-head', oncontextmenu: e => { if (!selTracks.has(t.id)) selectTracks([t.id]); timelineContextMenu(e, trackMenu(t)); } },
    h('span', { class: 'track-index' }, trackLabel(t)), nameEl,
    h('button', { class: `icon-button ${t.disabled ? 'off' : f?.disabled ? 'inherit' : ''}`, disabled: off || lockedTrack(t.id), onclick: () => toggleTrack(t, 'disabled'),
      tip: { title: t.disabled ? 'Enable track' : 'Disable track', desc: 'Disabling hides the picture and silences the audio. Clips stay editable.', meta: f?.disabled ? `Folder “${f.name}” is disabled` : null } }, icon(t.disabled || f?.disabled ? 'eye-off' : 'eye')),
    h('button', { class: `icon-button ${t.locked ? 'off' : held ? 'inherit' : ''}`, disabled: off || held, onclick: () => toggleTrack(t, 'locked'),
      tip: { title: t.locked ? 'Unlock track' : 'Lock track', desc: 'Locked tracks reject every GUI and CLI edit, including agent batches.', meta: held ? `Folder “${f.name}” is locked` : null } }, icon(t.locked || held ? 'lock' : 'unlock')));
  head.onpointerdown = e => headDown(e, { track: t.id });
  const lane = h('div', { class: `lane ${tool === 'razor' ? 'razor' : ''}`, style: { width: `${width}px` }, dataset: { track: t.id } });
  lane.tip = { title: 'Track', hint: tool === 'razor' ? [{ text: 'Click a clip to split it' }] : [{ keys: '#Click', text: 'move playhead' }, { keys: '#Drag', text: 'box select' }, { keys: '#Right-click', text: 'paste / add track' }] };
  lane.oncontextmenu = e => {
    if (e.target.closest('.clip, .xfade')) return;
    const gap = gapAt(t.id, laneFrame(e.clientX)), revision = project().revision;
    timelineContextMenu(e, [{ label: 'Ripple delete gap across all tracks', icon: 'trash', disabled: !editable() || !gap,
      run: () => gap && rippleDelete(gap.start, gap.end, revision) }, '-', { action: 'paste' }, { action: 'addTrack' }, '-', { action: 'selectAll' }]);
  };
  for (const c of clipsOn(t.id)) lane.append(clipBlock(c, t));
  for (const tr of transitions().filter(x => x.trackId === t.id)) {
    const b = clipById(tr.toClipId); if (!b) continue;
    const d = secs(tr.duration), before = tr.alignment === 'start' ? 0 : tr.alignment === 'end' ? d : d / 2;
    const w = d * pps;
    const el = h('div', { class: `xfade ${selTransition === tr.id ? 'selected' : ''}`, dataset: { id: tr.id }, style: { left: `${(secs(b.start) - before) * pps}px`, width: `${Math.max(4, w)}px` } }, w > 18 ? icon('dissolve') : null);
    el.tip = { title: mediaById(tr.assetId)?.metadata.asset?.name||'Transition', follow: true, meta: `Duration ${shortTc(toF(tr.duration))} · ${tr.alignment}`, hint: [{ keys: '#Click', text: 'select' }, { keys: 'Delete', text: 'remove' }] };
    el.oncontextmenu = e => { selectTransition(tr.id); timelineContextMenu(e, [{ action: 'delete' }]); };
    lane.append(el);
  }
  const members = f ? folderMembers(f.id) : [];
  return h('div', { class: `track ${disabledTrack(t.id) ? 'disabled' : ''} ${lockedTrack(t.id) ? 'locked' : ''} ${f ? 'in-folder' : ''} ${members.at(-1) === t ? 'folder-end' : ''} ${selTracks.has(t.id) ? 'selected' : ''}`, dataset: { track: t.id } }, head, lane);
}
// Folder header. Collapsed, its lane is a read-only overview of the clips inside, one strip per track.
let lastFolderOverviewDown = null;
function folderRow(f, width) {
  const members = folderMembers(f.id), off = !editable();
  const nameEl = h('span', { class: 'track-name' }, f.name);
  nameEl.tip = { title: f.name, desc: `Folder with ${plural(members.length, 'track')}. Its Disable and Lock apply to every track inside and keep their own settings.`, hint: HEAD_HINT };
  const head = h('div', { class: 'track-head folder-head', oncontextmenu: e => { selectFolder(f.id); timelineContextMenu(e, folderMenu(f)); } },
    h('button', { class: 'icon-button folder-toggle', disabled: off, onclick: () => setCollapsed(f, !f.collapsed), tip: { title: f.collapsed ? 'Expand folder' : 'Collapse folder', keys: 'Ctrl+Shift+F' } }, icon('chevron-down')),
    icon('folder', 'sm folder-glyph'), nameEl, h('span', { class: 'folder-count' }, members.length),
    h('button', { class: `icon-button ${f.disabled ? 'off' : ''}`, disabled: off || f.locked, onclick: () => toggleFolder(f, 'disabled'),
      tip: { title: f.disabled ? 'Enable folder' : 'Disable folder', desc: 'Hides the picture and silences the audio of every track inside. Their own Disable settings return when re-enabled.' } }, icon(f.disabled ? 'eye-off' : 'eye')),
    h('button', { class: `icon-button ${f.locked ? 'off' : ''}`, disabled: off, onclick: () => toggleFolder(f, 'locked'),
      tip: { title: f.locked ? 'Unlock folder' : 'Lock folder', desc: 'Rejects edits to every track inside, including membership and reordering. Collapse still works.' } }, icon(f.locked ? 'lock' : 'unlock')));
  head.onpointerdown = e => headDown(e, { folder: f.id });
  const lane = h('div', { class: 'lane folder-lane', style: { width: `${width}px` }, dataset: { folder: f.id } });
  if (f.collapsed) {
    lane.append(h('div', { class: 'folder-overview' }, members.map(t => h('div', { class: `folder-strip ${t.disabled ? 'disabled' : ''}` },
      clipsOn(t.id).map(c => h('i', { class: `folder-seg ${mediaById(c.mediaId) ? clipKind(c) : 'missing'}`, style: { left: `${secs(c.start) * pps}px`, width: `${Math.max(1, secs(c.duration) * pps)}px` } }))))));
    // Selection redraws rows, so native dblclick cannot survive the first click.
    lane.onpointerdown = e => {
      if (e.button !== 0) return;
      e.stopPropagation(); e.preventDefault();
      const previous = lastFolderOverviewDown, now = performance.now();
      lastFolderOverviewDown = { id: f.id, time: now, x: e.clientX, y: e.clientY };
      if (previous?.id === f.id && now - previous.time < 500 && Math.hypot(e.clientX - previous.x, e.clientY - previous.y) < 5) {
        lastFolderOverviewDown = null; setCollapsed(f, false);
      } else { selectFolder(f.id); seek(laneFrame(e.clientX), true); }
    };
  }
  lane.tip = { title: f.name, desc: f.collapsed ? 'Clip overview. Expand the folder to edit its clips.' : null, hint: f.collapsed ? [{ keys: '#Double-click', text: 'expand' }, { keys: 'Ctrl+Shift+F', text: 'expand' }] : [{ keys: '#Click', text: 'move playhead' }] };
  lane.oncontextmenu = e => { selectFolder(f.id); timelineContextMenu(e, folderMenu(f)); };
  return h('div', { class: `track folder-row ${f.collapsed ? 'collapsed' : ''} ${f.disabled ? 'disabled' : ''} ${f.locked ? 'locked' : ''} ${selFolder === f.id ? 'selected' : ''}`, dataset: { folder: f.id } }, head, lane);
}
function clipBlock(c, t) {
  const locked = lockedTrack(t.id);
  const m = mediaById(c.mediaId), left = secs(c.start) * pps, width = Math.max(2, secs(c.duration) * pps), speed = secs(c.speed);
  const kind = clipKind(c), audible = clipHasAudio(c), peers = linkedPeers(c), peerSelected = peers.some(o => selection.has(o.id));
  const badges = [];
  if (Math.abs(speed - 1) > 1e-9) badges.push(h('span', { class: 'clip-badge' }, icon('speed'), pct(speed)));
  if (c.mute) badges.push(h('span', { class: 'clip-badge' }, icon('mute')));
  if (peers.length) badges.push(h('span', { class: 'clip-badge' }, icon('link')));
  const el = h('div', { class: `clip ${m ? kind : 'missing'} ${selection.has(c.id) ? 'selected' : peerSelected ? 'link-peer' : ''} ${locked ? 'locked' : ''}`, dataset: { id: c.id }, style: { left: `${left}px`, width: `${width}px` } },
    width > 30 ? h('div', { class: 'clip-body' }, icon(kindIcon(kind)), h('span', { class: 'clip-name' }, clipName(c)), width > 110 ? h('span', { class: 'clip-badges' }, badges) : null) : null,
    !audible && width > 70 && prefs.trackH >= 44 ? h('span', { class: 'clip-meta' }, shortTc(endF(c) - startF(c))) : null,
    !audible && secs(c.fadeIn) > 0 ? h('i', { class: 'fade in', style: { width: `${secs(c.fadeIn) * pps}px` } }) : null,
    !audible && secs(c.fadeOut) > 0 ? h('i', { class: 'fade out', style: { width: `${secs(c.fadeOut) * pps}px` } }) : null,
    locked ? null : h('i', { class: 'handle l' }), locked ? null : h('i', { class: 'handle r' }));
  if (audible) addAudioControls(el, c, t);
  el.tip = () => ({ title: clipName(c), follow: true, desc: `${kindLabel(kind)} · ${mediaName(m)}`,
    meta: [`Start ${tc(startF(c))}   End ${tc(endF(c))}`, `Duration ${tc(endF(c) - startF(c))}   Source in ${tc(toF(c.sourceIn))}`, [Math.abs(speed - 1) > 1e-9 ? `Speed ${pct(speed)}` : null, audible ? `Volume ${toDb(c.volume)} dB${c.mute ? ' (muted)' : ''}` : null, c.volumePoints?.length ? plural(c.volumePoints.length, 'volume point') : null].filter(Boolean).join('   '), peers.length ? `Linked to “${peers.map(clipName).join('”, “')}”` : null].filter(Boolean).join('\n'),
    hint: locked ? [{ text: blockReason(t.id) }] : tool === 'razor' ? [{ keys: '#Click', text: 'split here' }, { keys: 'V', text: 'selection tool' }] : [{ keys: '#Drag', text: 'move' }, { keys: '#Drag edge', text: 'trim' }, { keys: ['Shift', '#+ edge'], text: 'stretch speed' }, { keys: 'Alt', text: 'no snap' }, { keys: 'Ctrl+K', text: 'split' },
      ...(audible ? [{ keys: ['Ctrl', '#+ line'], text: 'volume point' }] : [])] });
  el.oncontextmenu = e => { if (!selection.has(c.id)) select([c.id]); timelineContextMenu(e, [{ action: 'split' }, { action: 'dissolve' }, '-', { action: 'mute' }, { action: 'fill' }, '-', peers.length ? { action: 'unlink' } : { action: 'detachAudio' }, '-', { action: 'copy' }, { action: 'paste' }, { action: 'delete' }]); };
  return el;
}
const waveformRequests = new Map();
function volumePosition(volume) {
  const db = volume > 0 ? Math.max(-60, 20 * Math.log10(volume)) : -60;
  return Math.max(0, Math.min(100, (24 - db) / 84 * 100));
}
const pointLocal = (c, p) => (secs(p.time) - secs(c.sourceIn)) / secs(c.speed);
const sourceAtFrame = (c, f) => fadd(c.sourceIn, fmul(fsub(fromF(f), c.start), c.speed));
const sameTime = (a, b) => a.num * b.den === b.num * a.den;
const levelGain = (c, t) => (c.volume ?? 1) * window.AFClipTimeline.automationGain(c, t);
// Subdivide each eased gain segment to draw its dB curve.
function envelopePaths(c) {
  const duration = secs(c.duration), fi = Math.min(secs(c.fadeIn), duration), fo = Math.min(secs(c.fadeOut), duration), ease = window.AFClipTimeline.easeInOut;
  const fade = t => (fi ? ease(t / secs(c.fadeIn)) : 1) * (fo ? ease((duration - t) / secs(c.fadeOut)) : 1);
  const times = new Set([0, duration]);
  for (let i = 0; i <= 32; i++) { times.add(fi * i / 32); times.add(duration - fo * i / 32); }
  const points = window.AFClipTimeline.automationPoints(c);
  if (points.length) {
    const marks = [0, ...points.map(p => pointLocal(c, p)).filter(t => t > 0 && t < duration), duration], steps = Math.max(1, Math.min(12, Math.floor(600 / marks.length)));
    for (let i = 1; i < marks.length; i++) for (let k = 0; k < steps; k++) times.add(marks[i - 1] + (marks[i] - marks[i - 1]) * k / steps);
  }
  const sorted = [...times].sort((a, b) => a - b), x = t => (t / duration * 1000).toFixed(2);
  const level = sorted.map(t => volumePosition(levelGain(c, t)));
  const line = sorted.map((t, i) => `${i ? 'L' : 'M'}${x(t)} ${(100 - fade(t) * (100 - level[i])).toFixed(2)}`).join('');
  const top = sorted.map((t, i) => `L${x(t)} ${level[i].toFixed(2)}`).reverse().join('');
  return { line, shade: `${line}${top}Z`, fill: `${line}L1000 100L0 100Z` };
}
function paintAudioControls(el, c) {
  const area = el.querySelector('.clip-audio');
  if (!area) return;
  const duration = secs(c.duration), paths = envelopePaths(c);
  const fi = Math.min(duration, secs(c.fadeIn)), fo = Math.min(duration, secs(c.fadeOut));
  area.classList.toggle('muted', !!c.mute);
  area.querySelector('.env-shade').setAttribute('d', paths.shade);
  area.querySelector('.env-fill').setAttribute('d', paths.fill);
  area.querySelector('.env-line').setAttribute('d', paths.line);
  area.querySelector('.env-hit').setAttribute('d', paths.line);
  Object.assign(area.querySelector('[data-audio="fadeIn"]').style, { left: `${100 * fi / duration}%`, top: `${volumePosition(levelGain(c, fi))}%` });
  Object.assign(area.querySelector('[data-audio="fadeOut"]').style, { left: `${100 * (1 - fo / duration)}%`, top: `${volumePosition(levelGain(c, duration - fo))}%` });
  for (const old of area.querySelectorAll('.audio-point')) old.remove();
  for (const p of window.AFClipTimeline.automationPoints(c).filter(p => p.implicit)) {
    area.append(h('div', { class: 'audio-point', title: 'Temporary anchor at clip volume',
      style: { left: `${100 * pointLocal(c, p) / duration}%`, top: `${volumePosition(c.volume ?? 1)}%`, opacity: .45, pointerEvents: 'none' } }));
  }
  const live = drag?.field === 'point' && drag.c.id === c.id ? drag.ins : -1;
  (c.volumePoints || []).forEach((p, i) => {
    const t = pointLocal(c, p);
    if (t < -1e-9 || t > duration + 1e-9) return;
    const selected = live === i || (live < 0 && selPoint?.clipId === c.id && sameTime(selPoint.time, p.time));
    area.append(h('div', { class: `audio-point ${selected ? 'selected' : ''} ${live === i ? 'dragging' : ''}`, dataset: { audio: 'point', index: i },
      title: `${toDb(p.value)} dB`, style: { left: `${100 * t / duration}%`, top: `${volumePosition((c.volume ?? 1) * p.value)}%` } }));
  });
  const canvas = area.querySelector('canvas'), ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (!canvas.peaks) return;
  ctx.strokeStyle = '#c5e6da'; ctx.globalAlpha = .65; ctx.lineWidth = 1;
  ctx.beginPath();
  const audible = { ...c, mute: false };
  for (let x = 0; x < canvas.width; x++) {
    const peak = Math.min(1, canvas.peaks[x] * window.AFClipTimeline.audioGain(audible, (x + .5) / canvas.width * duration)) * (canvas.height / 2 - 1);
    ctx.moveTo(x + .5, canvas.height / 2 - peak); ctx.lineTo(x + .5, canvas.height / 2 + peak);
  }
  ctx.stroke();
}
function addAudioControls(el, c, t) {
  const canvas = h('canvas', { width: 2048, height: 64, class: 'clip-waveform' });
  const envelope = document.createElementNS(SVG, 'svg');
  envelope.setAttribute('class', 'clip-envelope'); envelope.setAttribute('viewBox', '0 0 1000 100'); envelope.setAttribute('preserveAspectRatio', 'none');
  for (const name of ['env-fill', 'env-shade', 'env-line', 'env-hit']) { const path = document.createElementNS(SVG, 'path'); path.setAttribute('class', name); envelope.append(path); }
  const hit = envelope.lastChild, title = document.createElementNS(SVG, 'title');
  hit.dataset.audio = 'volume'; title.textContent = 'Drag up/down to adjust volume · Ctrl+click to add a point'; hit.append(title);
  const area = h('div', { class: 'clip-audio' }, canvas, envelope,
    h('div', { class: 'audio-fade in', dataset: { audio: 'fadeIn' }, title: 'Drag to set fade in (Ease In/Out)' }),
    h('div', { class: 'audio-fade out', dataset: { audio: 'fadeOut' }, title: 'Drag to set fade out (Ease In/Out)' }));
  if (lockedTrack(t.id) || !editable()) area.classList.add('audio-locked');
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
  const el = document.querySelector(`.clip[data-id="${c.id}"]`), area = el.querySelector('.clip-audio');
  area.classList.add('active');
  area.querySelector(`[data-audio="${field}"]`).classList.add('dragging');
  startDrag({ type: 'audio', c, field, el, x0: e.clientX, y0: e.clientY,
    height: el.querySelector('.clip-audio').getBoundingClientRect().height, changes: null });
  hintItems([{ keys: 'Escape', text: 'cancel' }]);
}
// Points are edited on frame-snapped timeline positions but stored in source time.
// An untouched axis keeps the stored value exactly, and the whole gesture commits once.
function beginPointDrag(e, c, index) {
  playback.pause();
  const points = c.volumePoints || [], rate = fps(), s0 = startF(c), e0 = endF(c);
  let base = index == null ? null : points[index];
  if (!base) {
    const f = Math.max(s0, Math.min(e0, laneFrame(e.clientX))), time = sourceAtFrame(c, f), hit = points.findIndex(p => sameTime(p.time, time));
    base = hit >= 0 ? points[hit] : { time, value: window.AFClipTimeline.automationGain(c, secs(fsub(fromF(f), c.start))) };
    index = hit >= 0 ? hit : null;
  }
  const rest = points.filter(p => p !== base), at = rest.findIndex(p => secs(p.time) > secs(base.time)), ins = at < 0 ? rest.length : at;
  const frameOf = p => s0 + pointLocal(c, p) * rate, prev = rest[ins - 1], next = rest[ins];
  const el = document.querySelector(`.clip[data-id="${c.id}"]`), area = el.querySelector('.clip-audio');
  const d = { type: 'audio', field: 'point', c, el, x0: e.clientX, y0: e.clientY, height: area.getBoundingClientRect().height, rest, ins, base, cur: base, added: index == null,
    f0: Math.round(frameOf(base)), minF: Math.max(s0, prev ? Math.floor(frameOf(prev) + 1e-6) + 1 : s0), maxF: Math.min(e0, next ? Math.ceil(frameOf(next) - 1e-6) - 1 : e0) };
  d.changes = d.added ? { volumePoints: [...rest.slice(0, ins), base, ...rest.slice(ins)] } : null;
  if (!d.added) selPoint = { clipId: c.id, time: base.time };
  area.classList.add('active');
  startDrag(d);
  paintAudioControls(el, d.changes ? { ...c, ...d.changes } : c);
  readout(`Point ${toDb(base.value)} dB   ${tc(d.f0)}`);
  hintItems([{ keys: 'Escape', text: 'cancel' }]);
}
function pointDrag(e) {
  const d = drag, locked = d.minF > d.maxF;
  const f = locked ? d.f0 : Math.max(d.minF, Math.min(d.maxF, d.f0 + xFrame(e.clientX - d.x0)));
  const db0 = d.base.value > 0 ? Math.max(-60, 20 * Math.log10(d.base.value)) : -60, dy = d.y0 - e.clientY;
  const db = Math.max(-60, Math.min(24, db0 + dy / d.height * 84));
  const value = dy === 0 ? d.base.value : db <= -60 ? 0 : Math.min(16, 10 ** (db / 20));
  d.cur = { time: f === d.f0 ? d.base.time : sourceAtFrame(d.c, f), value };
  d.changes = d.added || d.cur.value !== d.base.value || d.cur.time !== d.base.time ? { volumePoints: [...d.rest.slice(0, d.ins), d.cur, ...d.rest.slice(d.ins)] } : null;
  readout(`Point ${toDb(value)} dB   ${tc(f)}`, locked && e.clientX !== d.x0 ? 'No room between neighbouring points' : '');
}
function audioDrag(e) {
  const d = drag;
  if (d.field === 'point') pointDrag(e);
  else if (d.field === 'volume') {
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
  const f = folderOf(t), off = !editable(), locked = lockedTrack(t.id), ids = selTracks.has(t.id) ? trackTargets() : [t.id];
  return [
    { label: 'Rename…', icon: 'sliders', keys: ['F2'], disabled: off || locked, run: () => renameTrack(t, document.querySelector(`.track[data-track="${t.id}"] .track-name`)) },
    { label: t.disabled ? 'Enable track' : 'Disable track', icon: t.disabled ? 'eye' : 'eye-off', disabled: off || locked, run: () => toggleTrack(t, 'disabled') },
    { label: t.locked ? 'Unlock track' : 'Lock track', icon: t.locked ? 'unlock' : 'lock', disabled: off || !!f?.locked, run: () => toggleTrack(t, 'locked') },
    '-', { action: 'groupTracks' },
    ...folders().filter(g => g.id !== t.folderId).map(g => ({ label: `Move into “${g.name}”`, icon: 'folder', disabled: off || g.locked || locked, run: () => addToFolder(g.id, ids) })),
    f ? { label: `Remove from “${f.name}”`, icon: 'x', disabled: off || locked, run: () => removeFromFolder(ids) } : null,
    { action: 'moveTrackUp' }, { action: 'moveTrackDown' },
    '-', { action: 'addTrack' },
    { label: 'Delete track', icon: 'trash', disabled: off || locked || clipsOn(t.id).length > 0, run: () => deleteTrack(t) }].filter(Boolean);
}
function folderMenu(f) {
  const off = !editable();
  return [
    { label: 'Rename…', icon: 'sliders', keys: ['F2'], disabled: off || f.locked, run: () => renameFolder(f, document.querySelector(`.track[data-folder="${f.id}"] .track-name`)) },
    { label: f.collapsed ? 'Expand' : 'Collapse', icon: 'chevron-down', keys: ['Ctrl+Shift+F'], disabled: off, run: () => setCollapsed(f, !f.collapsed) },
    { label: f.disabled ? 'Enable folder' : 'Disable folder', icon: f.disabled ? 'eye' : 'eye-off', disabled: off || f.locked, run: () => toggleFolder(f, 'disabled') },
    { label: f.locked ? 'Unlock folder' : 'Lock folder', icon: f.locked ? 'unlock' : 'lock', disabled: off, run: () => toggleFolder(f, 'locked') },
    '-', { action: 'editFolder' }, { action: 'moveTrackUp' }, { action: 'moveTrackDown' }, { action: 'addTrack' },
    '-', { action: 'ungroup' }];
}
// Shared inline rename for track and folder headers. Timeline redraws wait until it finishes.
function inlineRename(nameEl, value, maxlength, save) {
  editingTrack = true;
  const input = h('input', { class: 'track-name-input', value, maxlength, spellcheck: 'false' });
  nameEl.replaceWith(input); input.focus(); input.select();
  let done = false;
  const finish = ok => {
    if (done) return; done = true; editingTrack = null;
    const v = input.value.trim();
    if (ok && v && v !== value) save(v); else drawTimeline();
    if (deferredDraw) drawTimeline();
  };
  input.onkeydown = e => { e.stopPropagation(); if (e.key === 'Enter') finish(true); if (e.key === 'Escape') finish(false); };
  input.onblur = () => finish(true);
}
function renameTrack(t, nameEl) {
  if (!nameEl || lockedTrack(t.id) || !editable()) return;
  inlineRename(nameEl, t.name, 80, v => changeTrack(t, { name: v }, `Renamed track to “${v}”`));
}
function renameFolder(f, nameEl) {
  if (!nameEl || !f || f.locked || !editable()) return;
  inlineRename(nameEl, f.name, 256, v => edit(() => folderById(f.id) ? { ops: [put('folders', { id: f.id, name: v })], message: `Renamed folder to “${v}”` } : null));
}

// Header gestures: click selects, drag reorders. A dragged track drops between rows and joins the
// folder it lands in; a dragged folder, or a track over a collapsed folder, lands beside whole folders.
let lastHeaderClick = null;
function headDown(e, unit) {
  if (e.button !== 0 || e.target.closest('button, input')) return;
  const nameEl = e.target.closest('.track-name'), key = unit.folder || unit.track;
  if (nameEl && lastHeaderClick?.key === key && performance.now() - lastHeaderClick.time < 500 && Math.hypot(e.clientX - lastHeaderClick.x, e.clientY - lastHeaderClick.y) < 5) {
    lastHeaderClick = null; e.preventDefault(); e.stopPropagation();
    if (unit.folder) renameFolder(folderById(unit.folder), nameEl); else renameTrack(trackById(unit.track), nameEl);
    return;
  }
  const ids = unit.folder ? folderMembers(unit.folder).map(t => t.id) : selTracks.has(unit.track) && !selFolder ? moveUnit()?.ids || [unit.track] : [unit.track];
  startDrag({ type: 'reorder', unit: { ...unit, ids }, ids, x0: e.clientX, y0: e.clientY, moved: false, shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey, drop: null, line: null });
}
function headClick(d) {
  lastHeaderClick = { key: d.unit.folder || d.unit.track, time: performance.now(), x: d.x0, y: d.y0 };
  if (d.unit.folder) selectFolder(d.unit.folder);
  else selectTracks([d.unit.track], d.shift ? 'range' : d.ctrl ? 'toggle' : 'replace');
}
function reorderDrop(d, clientY) {
  const rows = [...$('tracks').querySelectorAll(':scope > .track')].map(el => ({ r: el.getBoundingClientRect(), track: el.dataset.track, folder: el.dataset.folder }));
  if (!rows.length) return null;
  const row = rows.find(x => clientY < x.r.bottom) || rows.at(-1), upper = clientY < row.r.top + row.r.height / 2;
  const fid = row.folder || trackById(row.track)?.folderId;
  let drop;
  if (fid && (d.unit.folder || folderById(fid)?.collapsed)) {
    const block = rows.filter(x => x.folder === fid || trackById(x.track)?.folderId === fid), m = folderMembers(fid);
    const top = block[0].r.top, bottom = block.at(-1).r.bottom, up = clientY < (top + bottom) / 2;
    drop = { anchor: up ? m[0].id : m.at(-1).id, after: !up, folder: null, y: up ? top : bottom };
  } else if (row.folder) drop = { anchor: folderMembers(row.folder)[0]?.id, after: false, folder: upper ? null : row.folder, y: upper ? row.r.top : row.r.bottom };
  else drop = { anchor: row.track, after: !upper, folder: d.unit.folder ? null : trackById(row.track)?.folderId || null, y: upper ? row.r.top : row.r.bottom };
  const joins = !d.unit.folder && drop.folder !== (trackById(d.ids[0])?.folderId || null);
  return drop.anchor && (joins || !d.ids.includes(drop.anchor)) ? drop : null;
}
function reorderDrag(e) {
  const d = drag;
  if (!d.moved && Math.abs(e.clientY - d.y0) < 4) return;
  if (!d.moved) {
    d.moved = true;
    for (const row of document.querySelectorAll('#tracks > .track')) if (d.ids.includes(row.dataset.track) || (d.unit.folder && row.dataset.folder === d.unit.folder)) row.classList.add('reordering');
  }
  d.drop = reorderDrop(d, e.clientY);
  d.line?.remove(); d.line = null;
  if (!d.drop) { $('drag-readout').hidden = true; return; }
  d.line = h('div', { class: `reorder-line ${d.drop.folder ? 'into' : ''}`, style: { top: `${d.drop.y - $('tracks').getBoundingClientRect().top}px` } });
  $('tracks').append(d.line);
  readout(d.drop.folder ? `Into “${folderById(d.drop.folder)?.name}”` : 'Move here', '');
}
// Rebuilt from the project as it is when the edit runs.
function reorderPlan(unit, drop) {
  const u = unit.folder ? folderById(unit.folder) && { folder: unit.folder, ids: folderMembers(unit.folder).map(t => t.id) } : moveUnit(unit.ids);
  if (!u || u.error) return refuse(u?.error || 'The tracks changed. Try again.');
  if (!trackById(drop.anchor)) return null;
  const disp = displayTracks().map(t => t.id), at = disp.indexOf(drop.anchor) + (drop.after ? 1 : 0);
  const rest = disp.filter(id => !u.ids.includes(id));
  rest.splice(disp.slice(0, at).filter(id => !u.ids.includes(id)).length, 0, ...u.ids);
  const into = drop.folder && folderById(drop.folder);
  return layoutPlan({ disp: rest, assign: u.folder ? new Map() : new Map(u.ids.map(id => [id, drop.folder])), message: into && u.inFolder !== into.id ? `Moved ${unitName(u)} into “${into.name}”` : `Moved ${unitName(u)}` });
}

// Pointer gestures on the timeline
function laneFrame(clientX) { return xFrame(clientX - $('tracks').getBoundingClientRect().left - HEAD_W); }
function snapTargets(exclude = new Set()) {
  const set = new Set([0, playF]);
  if (inF != null) set.add(inF); if (outF != null) set.add(outF + 1);
  for (const c of clips()) if (!exclude.has(c.id)) { set.add(startF(c)); set.add(endF(c)); }
  for (const m of markers()) if (!exclude.has(m.id)) set.add(markerF(m));
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
  drag?.transitionPreview?.remove(); drag?.line?.remove();
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
    const audio = e.target.closest('[data-audio]'), field = audio?.dataset.audio;
    if (audio) {
      e.preventDefault();
      const addPoint = (e.ctrlKey || e.metaKey) && field === 'volume';
      if (!editable()) return;
      if (blockReason(c.trackId)) { if (addPoint) refuse(blockReason(c.trackId)); return; }
      select([c.id]);
      if (field === 'point' || addPoint) beginPointDrag(e, c, field === 'point' ? Number(audio.dataset.index) : null);
      else beginAudioDrag(e, c, field);
      return;
    }
    if (e.ctrlKey || e.metaKey) { select([c.id], 'toggle'); return; }
    if (e.shiftKey && !handle) select([c.id], 'add');
    else if (!selection.has(c.id) || handle) select([c.id]);
    if (blockReason(c.trackId) || !editable()) return;
    if (handle) beginTrim(e, c, handle.classList.contains('l') ? 'l' : 'r');
    else beginMove(e, c);
    return;
  }
  startDrag({ type: 'marquee', x0: e.clientX, y0: e.clientY, moved: false, additive: e.shiftKey || e.ctrlKey, base: new Set(selection) });
});
// Rows are measured from the DOM because folder headers sit between tracks and are not drop targets.
function beginMove(e, primary) {
  const list = withLinked(selectedClips()), disp = visibleTracks();
  const hidden = list.find(c => hiddenTrack(c.trackId)); if (hidden) { refuse(blockReason(hidden.trackId)); return; }
  const rows = list.map(c => disp.findIndex(t => t.id === c.trackId));
  const ids = new Set(list.map(c => c.id));
  const lanes = disp.map(t => document.querySelector(`.track[data-track="${t.id}"]`)).map(el => ({ top: el?.offsetTop ?? 0, h: el?.offsetHeight ?? prefs.trackH }));
  const pairs = list.map((c, i) => [document.querySelector(`.clip[data-id="${c.id}"]`), rows[i]]).filter(p => p[0]);
  startDrag({ type: 'move', x0: e.clientX, y0: e.clientY, primary, list, ids, horizontal: false, dF: 0, dTrack: 0, res: null,
    pre: { ...snapshot.revisions }, transitionId: uid('transition'), lanes, primaryRow: disp.findIndex(t => t.id === primary.trackId),
    minRow: Math.min(...rows), maxRow: Math.max(...rows), minStart: Math.min(...list.map(startF)), targets: snapTargets(ids),
    els: pairs.map(p => p[0]), elRows: pairs.map(p => p[1]) });
  hintItems([{ text: 'Push past a neighbour to crossfade' }, { keys: 'Alt', text: 'bypass snapping' }, { keys: 'Escape', text: 'cancel' }]);
}
function beginTrim(e, c, edge) {
  const m = mediaById(c.mediaId), s0 = startF(c), e0 = endF(c), group = withLinked([c]);
  if (lockedRefusal(group) !== false) return;
  // Linked companions share timing, so neighbours on every linked track bound the trim.
  const ids = new Set(group.map(o => o.id)), others = group.flatMap(g => clipsOn(g.trackId).filter(o => !ids.has(o.id)));
  startDrag({ type: 'trim', x0: e.clientX, c, m, edge, s0, e0, prevEnd: Math.max(0, ...others.map(endF).filter(x => x <= s0)), nextStart: Math.min(Infinity, ...others.map(startF).filter(x => x >= e0)),
    targets: snapTargets(ids), el: document.querySelector(`.clip[data-id="${c.id}"]`),
    peers: group.filter(o => o.id !== c.id).map(o => ({ c: o, el: document.querySelector(`.clip[data-id="${o.id}"]`) })), result: null });
  hintItems([{ keys: 'Shift', text: 'stretch (change speed)' }, { keys: 'Alt', text: 'bypass snapping' }, { keys: 'Escape', text: 'cancel' }]);
}
function onDragMove(e) {
  if (!drag) return;
  if (drag.type === 'audio') { audioDrag(e); return; }
  if (drag.type === 'reorder') reorderDrag(e); else if (drag.type === 'marker') markerDrag(e); else if (drag.type === 'move') moveDrag(e); else if (drag.type === 'trim') trimDrag(e); else if (drag.type === 'marquee') marqueeDrag(e); else if (drag.type === 'scrub') seek(drag.frameAt(e.clientX));
}
function moveDrag(e) {
  const d = drag, dx = e.clientX - d.x0;
  d.transitionPreview?.remove(); d.transitionPreview = null; d.crossfade = null;
  if (!d.horizontal && Math.abs(dx) > 6) d.horizontal = true;
  let dF = d.horizontal ? xFrame(dx) : 0;
  if (d.horizontal) dF += snapFrame([startF(d.primary) + dF, endF(d.primary) + dF], d.targets, e);
  dF = Math.max(dF, -d.minStart);
  const home = d.lanes[d.primaryRow], y = home.top + home.h / 2 + e.clientY - d.y0;
  let row = 0, best = Infinity;
  for (const [i, r] of d.lanes.entries()) { const dist = Math.abs(r.top + r.h / 2 - y); if (dist < best) { best = dist; row = i; } }
  const dTrack = Math.max(-d.minRow, Math.min(d.lanes.length - 1 - d.maxRow, row - d.primaryRow));
  let contact = null, neighbour = null, right = dx > 0, pushed = 0;
  if (d.horizontal && d.list.length === 1 && dTrack === 0) {
    const others = clipsOn(d.primary.trackId).filter(c => c.id !== d.primary.id);
    neighbour = right ? others.filter(c => startF(c) >= endF(d.primary)).sort((a,b) => startF(a)-startF(b))[0]
      : others.filter(c => endF(c) <= startF(d.primary)).sort((a,b) => endF(b)-endF(a))[0];
    if (neighbour) {
      const boundary = right ? startF(neighbour)-endF(d.primary) : endF(neighbour)-startF(d.primary);
      if (right ? dF >= boundary : dF <= boundary) {
        contact = boundary; dF = boundary;
        pushed = (right ? 1 : -1) * (dx - frameX(boundary));
      }
    }
  }
  d.dF = dF; d.dTrack = dTrack; d.res = moveOps(d.list, dF, dTrack);
  if (contact != null && !d.res.error && pushed > 8) {
    const moved = { ...d.primary, start: fromF(startF(d.primary)+dF) };
    const a = right ? moved : neighbour, b = right ? neighbour : moved;
    const existing = transitions().find(t => t.fromClipId === a.id && t.toClipId === b.id);
    const alignment = existing?.alignment || 'center', room = dissolveRoom(a,b,alignment,existing?.id);
    const wanted = Math.max(1, xFrame(pushed)), frames = Math.min(wanted,room);
    if (frames > 0) {
      const id = existing?.id || d.transitionId;
      d.crossfade = { id, frames, limited: frames < wanted, pre: { ...d.pre, ...(!existing ? { [`transition:${id}`]: 0 } : {}) } };
      d.res.ops.push(put('transitions',{id,trackId:a.trackId,fromClipId:a.id,toClipId:b.id,duration:fromF(frames),alignment}));
      const before = alignment === 'start' ? 0 : alignment === 'end' ? frames : frames/2;
      d.transitionPreview = h('div',{class:'xfade selected',style:{left:`${frameX(startF(b)-before)}px`,width:`${Math.max(4,frameX(frames))}px`,pointerEvents:'none'}},icon('dissolve'));
      d.els[0].parentElement.append(d.transitionPreview);
    } else d.res.limit = 'No spare source footage for a crossfade';
  }
  for (const [i, el] of d.els.entries()) { const r = d.elRows[i]; el.classList.add('dragging'); el.classList.toggle('invalid', !!d.res.error); el.style.transform = `translate(${frameX(dF)}px, ${(d.lanes[r + dTrack]?.top ?? 0) - (d.lanes[r]?.top ?? 0)}px)`; }
  if (d.crossfade) readout(`Crossfade ${shortTc(d.crossfade.frames)}`, d.crossfade.limited ? 'Limited by neighbouring transitions' : 'Release to apply');
  else if (dF || dTrack || contact != null) readout(`${dF >= 0 ? '+' : '−'}${shortTc(Math.abs(dF))}   ${tc(startF(d.primary) + dF)}`, d.res.error || d.res.limit || (d.res.dropped ? `Removes ${d.res.dropped} dissolve${d.res.dropped > 1 ? 's' : ''}` : '')); else $('drag-readout').hidden = true;
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
  for (const el of [d.el, ...d.peers.map(p => p.el)].filter(Boolean)) {
    el.classList.add('dragging');
    el.style.left = `${frameX(s)}px`; el.style.width = `${Math.max(2, frameX(dur))}px`;
  }
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
    if (d.field === 'point' && d.changes) selPoint = { clipId: d.c.id, time: d.cur.time };
    endDrag(); drawTimeline();
    if (d.changes) edit(() => {
      const current = clipById(d.c.id);
      if (!current || current.revision !== d.c.revision) return refuse('The clip changed during the drag. Nothing was applied.');
      if (blockReason(current.trackId)) return refuse(blockReason(current.trackId));
      const message = d.field === 'point' ? `${d.added ? 'Added' : 'Moved'} volume point · ${toDb(d.cur.value)} dB` : d.field === 'volume' ? `Volume ${toDb(d.changes.volume)} dB` : 'Adjusted fade';
      return { ops: [put('clips', { id: current.id, ...d.changes })], message };
    });
    return;
  }
  if (d.type === 'reorder') {
    endDrag();
    if (!d.moved) { headClick(d); return; }
    drawTimeline();
    if (d.drop) edit(() => reorderPlan(d.unit, d.drop)).then(ok => { if (ok) { if (d.unit.folder) selectFolder(d.unit.folder); else selectTracks(d.ids); } });
    return;
  }
  if (d.type === 'marker') {
    endDrag();
    if (!d.moved) {
      // A second click on an already selected stack cycles through its markers.
      const g = d.group, next = d.wasSelected && g.length > 1 ? g[(g.findIndex(m => m.id === d.m.id) + 1) % g.length] : d.m;
      if (next !== d.m) selectMarker(next.id);
      seek(markerF(next), true);
      return;
    }
    drawTimeline();
    if (d.f !== d.f0) edit(() => {
      const current = markerById(d.m.id);
      if (!current || current.revision !== d.m.revision) return refuse('The marker changed during the drag. Nothing was applied.');
      return { ops: [put('markers', { id: current.id, time: fromF(d.f) })], message: `Moved marker “${current.name}” to ${tc(d.f)}` };
    });
    return;
  }
  if (d.type === 'move') {
    moveDrag(e);
    for (const el of d.els) { el.style.transform = ''; el.classList.remove('dragging', 'invalid'); }
    const moved = d.dF || d.dTrack;
    endDrag();
    if (d.crossfade) {
      edit(() => ({ ops: d.res.ops, pre: d.crossfade.pre, message: `Crossfade ${shortTc(d.crossfade.frames)}${d.crossfade.limited ? ' · limited by source handles' : ''}` }));
    } else if (moved) { if (d.res?.error) say(d.res.error, 'warn'); else commitMove(d.list.map(c => c.id), d.dF, d.dTrack); }
  } else if (d.type === 'trim') {
    endDrag();
    const r = d.result;
    if (!r || (r.s === d.s0 && r.en === d.e0)) { drawTimeline(); return; }
    edit(() => {
      const c = clipById(d.c.id);
      if (!c || c.revision !== d.c.revision) return refuse('The clip changed during the drag. Nothing was applied.');
      const group = withLinked([c]);
      if (d.peers.some(p => clipById(p.c.id)?.revision !== p.c.revision) || group.length !== d.peers.length + 1) return refuse('A linked clip changed during the drag. Nothing was applied.');
      if (lockedRefusal(group) !== false) return null;
      const duration = fromF(r.dur), changes = { duration };
      if (r.stretch) changes.speed = frac(c.speed.num * (d.e0 - d.s0), c.speed.den * r.dur);
      if (d.edge === 'l') { changes.start = fromF(r.s); if (!r.stretch) changes.sourceIn = fadd(c.sourceIn, fmul(fsub(fromF(r.s), c.start), c.speed)); }
      // Companions get the same timing explicitly, plus their own fade clamps.
      const ids = new Set(group.map(o => o.id));
      const gone = transitions().filter(t => d.edge === 'l' ? ids.has(t.toClipId) : ids.has(t.fromClipId));
      return { ops: [...gone.map(t => remove('transitions', t.id)), ...group.map(o => put('clips', { id: o.id, ...changes, ...fadeClamp(o, duration) }))],
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
// Marker flags sit inside the ruler, so they claim the pointer before the scrubber sees it.
let lastMarkerDown = null;
$('ruler').addEventListener('pointerdown', e => {
  const el = e.target.closest('.marker'); if (!el) return;
  e.stopPropagation();
  if (e.button !== 0 || drag) return;
  e.preventDefault();
  const g = el.group, m = g.find(x => x.id === selMarker) || markerById(el.dataset.id) || g[0], now = Date.now();
  if (lastMarkerDown && g.some(x => x.id === lastMarkerDown.id) && now - lastMarkerDown.at < 400) { lastMarkerDown = null; if (can('editMarker')) markerPopover(m); return; }
  lastMarkerDown = { id: m.id, at: now };
  const wasSelected = selMarker === m.id;
  if (!wasSelected) selectMarker(m.id);
  startDrag({ type: 'marker', m, group: g, wasSelected, x0: e.clientX, f0: markerF(m), f: markerF(m), moved: false,
    el: $('ruler').querySelector(`.marker[data-id="${m.id}"]`), targets: snapTargets(new Set([m.id])) });
}, true);
function markerDrag(e) {
  const d = drag;
  if (!d.moved && (Math.abs(e.clientX - d.x0) < 4 || !editable())) return;
  if (!d.moved) { d.moved = true; hintItems([{ keys: 'Alt', text: 'bypass snapping' }, { keys: 'Escape', text: 'cancel' }]); }
  let f = d.f0 + xFrame(e.clientX - d.x0);
  f += snapFrame([f], d.targets, e);
  d.f = Math.max(0, f);
  if (d.el) { d.el.style.left = `${frameX(d.f)}px`; d.el.classList.add('dragging'); }
  drawMarkerLine(d.f);
  readout(`${d.m.name}   ${tc(d.f)}`);
}
$('ruler').addEventListener('contextmenu', e => {
  const el = e.target.closest('.marker'), at = Math.max(0, laneFrame(e.clientX));
  if (!el) { timelineContextMenu(e, [{ label: 'Add marker', icon: 'marker', disabled: !editable(), run: () => addMarker(nextMarkerName(), at) }, '-', { action: 'prevMarker' }, { action: 'nextMarker' }]); return; }
  e.preventDefault();
  const g = el.group, m = g.find(x => x.id === selMarker) || g[0];
  timelineContextMenu(e, [{ label: 'Edit marker', icon: 'marker', run: () => markerPopover(m) }]);
});
$('ruler').tip = { title: 'Time ruler', hint: [{ keys: '#Drag', text: 'scrub' }, { keys: 'M', text: 'add marker' }, { keys: ['I', 'O'], text: 'mark range' }, { keys: ['=', '-'], text: 'zoom' }, { keys: '\\', text: 'fit' }] };
$('mini-ruler').tip = { title: 'Sequence overview', hint: [{ keys: '#Click', text: 'jump' }, { keys: '#Drag', text: 'scrub' }] };
$('tl-scroll').addEventListener('wheel', e => {
  if (!e.ctrlKey) return;
  e.preventDefault();
  zoom(e.deltaY < 0 ? 1.2 : 1 / 1.2, e.clientX - $('tl-scroll').getBoundingClientRect().left - HEAD_W);
}, { passive: false });

// Structured library drops resolve IDs through the service, never trust a dragged path.
document.addEventListener('dragover', e => {if(e.dataTransfer.types.includes('application/x-afclip-library')&&editable()){e.preventDefault();e.dataTransfer.dropEffect='copy';}});
document.addEventListener('drop', async e => {
  const raw=e.dataTransfer.getData('application/x-afclip-library');if(!raw)return;e.preventDefault();
  try{const data=JSON.parse(raw);await window.afclip.command({command:'library-import',id:data.rangeId||data.assetId,libraryId:data.libraryId,sourceId:data.sourceId});}
  catch(error){console.error(error);alert(error.message);}
});

// Dropping media from the bin
let dragMedia = null, dragSource = null, dropGhost = null;
function sourceRangeLength(payload) {
  return Math.max(0, Math.floor(payload.range.end * fps() + 1e-6) - Math.ceil(payload.range.start * fps() - 1e-6));
}
function clearDropGhost() { dropGhost?.remove(); dropGhost = null; for (const el of document.querySelectorAll('.drop-target')) el.classList.remove('drop-target'); }
function dropPlan(e) {
  const lane = e.target.closest?.('.lane[data-track]'), m = dragMedia; if (!m) return null;
  const len = dragSource ? sourceRangeLength(dragSource) : mediaLength(m);
  let f = Math.max(0, laneFrame(e.clientX));
  if (prefs.snap && !e.altKey) f += snapFrame([f, f + len], snapTargets(), e);
  f = Math.max(0, f);
  const t = lane ? trackById(lane.dataset.track) : null;
  return { lane, f, len, trackId: t?.id || null, fits: !!t && !blockReason(t.id) && free(t.id, f, f + len) };
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
    const plan = dropPlan(e), m = dragMedia, sourceRange = dragSource;
    clearDropGhost(); $('drag-readout').hidden = true; $('snapline').hidden = true; dragMedia = null; dragSource = null;
    if (plan && m) addMediaAt(m, plan.fits ? plan.trackId : null, plan.f, sourceRange);
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
  for (const [id, a] of [['undo', 'undo'], ['redo', 'redo'], ['export', 'export'], ['import', 'import'], ['add-library', 'library']]) { $(id).dataset.action = a; $(id).tip = { action: a }; $(id).onclick = () => run(a); }
  $('command-center-keys').replaceWith(kbd('Ctrl+Space'));
  $('command-center').onclick = () => run('palette', 'key');
  $('command-center').tip = () => ({ title: 'Search commands', desc: 'Every action, with its shortcut. Type a timecode to jump there.', keys: 'Ctrl+Space', meta: project() ? `${project().name}\n${project().resolution.width}×${project().resolution.height} · ${fpsLabel()} fps` : null });
  $('mode-chip').onclick = () => run('softwareRender');
  for (const b of $('bin-view').children) { b.onclick = () => setBinView(b.dataset.view); b.tip = { title: b.dataset.view === 'grid' ? 'Grid view' : 'List view', keys: 'Ctrl+B' }; }
  for (const tab of document.querySelectorAll('.bin .tab')) tab.onclick = () => showTab(tab.dataset.tab);
  document.querySelector('.bin [data-tab="media"]').tip = { title: 'Media bin', desc: 'Imported footage, audio, images and graphics. Originals stay where they are.' };
  document.querySelector('.bin [data-tab="history"]').tip = { title: 'History', desc: 'Shared undo/redo and restorable checkpoints.' };
  const sourceButton = (name, iconName, title, keys, onclick) => h('button', { class: `icon-button ${name === 'play' ? 'primary' : ''}`, dataset: { source: name }, disabled: true, onclick, tip: { title, keys } }, icon(iconName));
  $('source-buttons').append(sourceButton('start', 'to-start', 'Go to source start', 'Home', () => source.toStart()), sourceButton('jump', 'prev-edit', 'Previous range or take', 'Up', () => source.jump(-1)),
    sourceButton('back', 'step-back', 'Back 1 frame', 'Left', () => source.step(-1)), sourceButton('play', 'play', 'Play / pause source', 'Space', () => source.togglePlay()),
    sourceButton('forward', 'step-forward', 'Forward 1 frame', 'Right', () => source.step(1)), sourceButton('jump', 'next-edit', 'Next range or take', 'Down', () => source.jump(1)),
    sourceButton('end', 'to-end', 'Go to source end', 'End', () => source.toEnd()));
  for (const [name, label, title, click] of [
    ['mark-in','I','Mark source In',()=>source.mark()], ['mark-out','O','Mark source Out',()=>source.mark(true)],
    ['clear','Clear','Clear temporary marks',()=>source.clearMarks()], ['insert','Insert','Insert at timeline playhead',insertMonitoredSource],
  ]) $('source-buttons').append(h('button', {class:'chip-button', dataset:{source:name}, disabled:true, onclick:click, tip:{title}}, label));
  for (const tab of document.querySelectorAll('.monitor .tab')) tab.onclick = () => tab.dataset.view === 'source' ? openSource(mediaById(source.mediaId)) : setMonitorView('frame');
  $('source-tab').tip = { title: 'Source monitor', desc: 'Preview bin media and its library annotations without touching the timeline.' };
  // Working on the timeline returns the monitor to Program.
  document.querySelector('.timeline.panel').addEventListener('pointerdown', () => { if (monitorView === 'source') setMonitorView('frame'); }, true);
  document.querySelector('.monitor [data-view="frame"]').tip = { title: 'Program monitor', desc: 'Live timeline preview with audio. Enter renders a full-resolution frame.', keys: 'Enter' };
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
  new ResizeObserver(() => { if (fitZoom && project()) drawTimeline(); }).observe($('tl-scroll'));
  let pinFrame = 0;
  $('tl-scroll').addEventListener('scroll', () => { cancelAnimationFrame(pinFrame); pinFrame = requestAnimationFrame(pinLabels); }, { passive: true });
}

// ---------------------------------------------------------------- Keyboard
// While the Source monitor is up, transport keys drive the source and timeline keys stay inert.
const SOURCE_SAFE = new Set(['agentChat', 'agentSettings', 'import', 'importGraphic', 'library', 'export', 'checkpoint', 'showHistory', 'save', 'palette', 'shortcuts', 'welcome', 'binGrid', 'zoomIn', 'zoomOut', 'zoomFit', 'taller', 'shorter']);
function sourceShortcut(combo, e) {
  if (combo === 'Enter' && e.target.closest?.('button')) return false;
  const keys = {
    Space: () => { if (!e.repeat) source.togglePlay(); }, Left: () => source.step(-1), Right: () => source.step(1),
    'Shift+Left': () => source.step(-5), 'Shift+Right': () => source.step(5), Home: () => source.toStart(), End: () => source.toEnd(),
    Up: () => source.jump(-1), Down: () => source.jump(1), Escape: () => setMonitorView('frame'),
    I: () => source.mark(), O: () => source.mark(true), 'Alt+X': () => source.clearMarks(), Enter: insertMonitoredSource,
  };
  // Waveform zoom while previewing audio; other sources fall through to the usual handling.
  const zoom = { '=': 1.6, '-': 1 / 1.6, '\\': 0 }[combo];
  if (zoom != null && source.zoomWave(zoom)) { e.preventDefault(); return true; }
  if (keys[combo]) { e.preventDefault(); keys[combo](); return true; }
  const id = keymap.get(combo);
  if (!id || SOURCE_SAFE.has(id)) return false;
  e.preventDefault();
  flashHint([{ text: 'Timeline keys pause while previewing a source' }, { keys: 'Esc', text: 'Program' }]);
  return true;
}
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
    if (!['Ctrl+Space', 'Ctrl+M', 'Ctrl+S', 'Ctrl+Shift+S', 'Ctrl+I'].includes(combo)) return;
  }
  if (e.altKey && !e.ctrlKey && !e.shiftKey && /^Key[A-Z]$/.test(e.code)) {
    const menu = [...$('menubar').children].find(b => b.textContent[0].toUpperCase() === e.code.slice(3));
    if (menu) { e.preventDefault(); menu.dispatchEvent(new Event('open')); openMenuState?.buttons.find(b => !b.disabled)?.classList.add('active'); return; }
  }
  if (monitorView === 'source' && !drag && sourceShortcut(combo, e)) return;
  if (combo === 'Escape') {
    if (drag) { const d = drag; if (d.type === 'move') d.els.forEach(el => { el.style.transform = ''; el.classList.remove('dragging', 'invalid'); }); endDrag(); drawTimeline(); say('Drag cancelled'); }
    else if (selPoint) { selPoint = null; drawTimeline(); }
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

function commitGraphicText(edit, value) {
  const pending = {clipId:edit.clipId,revision:edit.revision,mediaRevision:edit.mediaRevision};
  // Switching fields can begin a new draft before the previous save returns.
  // Only advance its base through our own accepted edit, never an external one.
  pending.promise = perform(async () => {
    let revision = edit.revision;
    const prior = edit.predecessor;
    if (prior && prior.clipId === edit.clipId && prior.revision === revision && prior.mediaRevision === edit.mediaRevision) {
      const result = await prior.promise;
      if (!result?.project) throw new Error('The previous text edit was not saved. Select the field again.');
      revision = result.project.clips.find(c => c.id === edit.clipId)?.revision;
    }
    return api.command({command:'text-set',clipId:edit.clipId,field:edit.field,revision,mediaRevision:edit.mediaRevision,value});
  }, 'Text updated');
  textCommit = pending;
  pending.promise.finally(() => { if (textCommit === pending) textCommit = null; });
  return pending.promise;
}

// Direct text editing keeps the preview alive until commit/cancel. Revisions are
// captured at entry, not refreshed at commit, so external edits cannot be lost.
$('native-preview').addEventListener('graphic-text-start', event => {
  if (graphicTextEdit || (editsInFlight && !textCommit) || !editable()) return;
  const {clipId, field, activate} = event.detail, clip = clipById(clipId);
  if (!clip || blockReason(clip.trackId)) return;
  clearTimeout(frameTimer); playback.pause(false);
  graphicTextEdit = {clipId,field,revision:clip.revision,mediaRevision:mediaById(clip.mediaId).revision,predecessor:textCommit};
  selection = new Set([clipId]); selTransition = selPoint = selMarker = null;
  drawInspector(); drawTimeline(); activate();
});
$('native-preview').addEventListener('graphic-text-end', async event => {
  const edit = graphicTextEdit, data = event.detail;
  if (!edit || edit.clipId !== data.clipId || edit.field !== data.field) return;
  graphicTextEdit = null;
  if (!data.cancel) {
    await commitGraphicText(edit, data.value);
  }
  else { await refresh(); requestFrame(0); }
});
document.addEventListener('pointerdown', () => {
  if (graphicTextEdit) playback.native?.finishText();
}, true);

// ---------------------------------------------------------------- Agent chats
// Timeline knowledge for agents.js: what is hovered, where an anchor sits now, and what to send as context.
const AGENT_WORDS = { clip: 'clip', transition: 'transition', marker: 'marker', track: 'track', folder: 'folder' };
function agentItemLabel({ kind, id }) {
  if (kind === 'clip') { const c = clipById(id); return c && clipName(c); }
  if (kind === 'transition') { const t = transitionById(id); return t && (mediaById(t.assetId)?.metadata?.asset?.name || 'Transition'); }
  if (kind === 'marker') return markerById(id)?.name;
  if (kind === 'track') return trackById(id)?.name;
  if (kind === 'folder') return folderById(id)?.name;
  if (kind === 'project') return project()?.name;
  return null;
}
function agentAnchor(items, extra = {}) {
  if (!items.length && !extra.kind) items = [{ kind: 'project', id: project().id }];
  const kind = extra.kind || items[0].kind, first = items[0];
  const anchor = { kind, items, ...extra };
  if (first?.kind === 'clip') { const c = clipById(first.id); if (c) Object.assign(anchor, { trackId: c.trackId, time: c.start }); }
  if (first?.kind === 'transition') { const t = transitionById(first.id), b = t && clipById(t.toClipId); if (t) anchor.trackId = t.trackId; if (b) anchor.time = b.start; }
  if (first?.kind === 'marker') { const m = markerById(first.id); if (m) anchor.time = m.time; }
  if (first?.kind === 'track') anchor.trackId = first.id;
  const time = anchor.time ? ` · ${tc(toF(anchor.time))}` : '';
  anchor.label = items.length > 1 ? plural(items.length, AGENT_WORDS[kind] || 'item')
    : first ? agentItemLabel(first) || kind
    : kind === 'point' && anchor.trackId ? `${trackById(anchor.trackId)?.name || 'Track'}${time}` : `Timeline${time}`;
  return anchor;
}
function agentSelection() {
  if (selection.size) return [...selection].filter(clipById).map(id => ({ kind: 'clip', id }));
  if (selTransition && transitionById(selTransition)) return [{ kind: 'transition', id: selTransition }];
  if (selMarker && markerById(selMarker)) return [{ kind: 'marker', id: selMarker }];
  if (selTracks.size) return [...selTracks].map(id => ({ kind: 'track', id }));
  if (selFolder && folderById(selFolder)) return [{ kind: 'folder', id: selFolder }];
  return [];
}
// The hovered timeline thing, or the selection (else the project) when the pointer is elsewhere.
// A hovered item that belongs to the selection stands for the whole selection.
function agentTarget(el = document.elementFromPoint(pointer.x, pointer.y), x = pointer.x, timeline = false) {
  if (!project()) return null;
  if (!el || (!timeline && !$('tl-scroll').contains(el))) return agentAnchor(agentSelection());
  const at = Math.max(0, laneFrame(x));
  const clip = el.closest('.clip');
  if (clip && clipById(clip.dataset.id)) return agentAnchor(selection.has(clip.dataset.id) ? agentSelection() : [{ kind: 'clip', id: clip.dataset.id }]);
  const xf = el.closest('.xfade');
  if (xf && transitionById(xf.dataset.id)) return agentAnchor([{ kind: 'transition', id: xf.dataset.id }]);
  const flag = el.closest('.marker');
  if (flag?.group) return agentAnchor([{ kind: 'marker', id: (flag.group.find(m => m.id === selMarker) || flag.group[0]).id }]);
  if (el.closest('.ruler')) return agentAnchor([], { kind: 'point', time: fromF(at) });
  const row = el.closest('.track');
  if (row?.dataset.folder) return agentAnchor([{ kind: 'folder', id: row.dataset.folder }]);
  if (row?.dataset.track && el.closest('.track-head')) return agentAnchor(selTracks.has(row.dataset.track) ? agentSelection() : [{ kind: 'track', id: row.dataset.track }]);
  if (row?.dataset.track) return agentAnchor([], { kind: 'point', trackId: row.dataset.track, time: fromF(at) });
  return agentAnchor([], { kind: 'timeline', time: fromF(at) });
}
// Viewport point for an anchor's chat glyph. `last` is the remembered { trackId, time } once its items are gone.
function agentLocate(anchor, last) {
  if (!project() || anchor.kind === 'project') return null;
  const scroll = $('tl-scroll'), view = scroll.getBoundingClientRect(), lanesLeft = view.left + HEAD_W, top = view.top + 26;
  const right = view.left + scroll.clientWidth, bottom = view.top + scroll.clientHeight;
  const laneX = time => $('tracks').getBoundingClientRect().left + HEAD_W + secs(time) * pps;
  const rulerY = () => $('ruler').getBoundingClientRect().top + 13;
  const folderRect = id => document.querySelector(`#tracks > .track[data-folder="${CSS.escape(id)}"]`)?.getBoundingClientRect() || null;
  const rowOf = trackId => {
    const t = trackById(trackId); if (!t) return null;
    if (hiddenTrack(t.id)) return folderRect(t.folderId);
    return document.querySelector(`#tracks > .track[data-track="${CSS.escape(t.id)}"]`)?.getBoundingClientRect() || null;
  };
  const inX = x => x >= lanesLeft + 4 && x <= right - 4;
  const out = (x, y, pos, head = false) => ({ x, y, pos, visible: y >= top + 4 && y <= bottom - 4 && (head || inX(x)) });
  const onRuler = (x, pos) => ({ x, y: rulerY(), pos, visible: inX(x) });
  for (const item of anchor.items || []) {
    if (item.kind === 'clip') {
      const c = clipById(item.id), r = c && rowOf(c.trackId); if (!r) continue;
      const s = laneX(c.start), e = laneX(endOf(c));
      return out(Math.max(s + 10, Math.min(e, right) - 18), r.top + 10, { trackId: c.trackId, time: c.start });
    }
    if (item.kind === 'transition') {
      const t = transitionById(item.id), b = t && clipById(t.toClipId), r = b && rowOf(t.trackId); if (!r) continue;
      return out(laneX(b.start), r.top + 10, { trackId: t.trackId, time: b.start });
    }
    if (item.kind === 'marker') { const m = markerById(item.id); if (m) return onRuler(laneX(m.time) - 14, { time: m.time }); continue; }
    if (item.kind === 'track' || item.kind === 'folder') {
      const r = item.kind === 'track' ? rowOf(item.id) : folderRect(item.id); if (!r) continue;
      return out(lanesLeft, r.top + r.height / 2, item.kind === 'track' ? { trackId: item.id } : {}, true);
    }
  }
  const pos = anchor.items?.length ? last || anchor : anchor;
  if (pos.time == null && !pos.trackId) return null;
  const x = laneX(pos.time || ZERO), r = pos.trackId && rowOf(pos.trackId);
  if (r) return out(x, r.top + r.height / 2, pos);
  if (anchor.kind === 'timeline' || pos.trackId) { const e = $('tl-empty').getBoundingClientRect(); return out(x, Math.min(e.top + 14, bottom - 10), pos); }
  return onRuler(x, pos);
}
function agentHighlight(items) {
  for (const el of document.querySelectorAll('.agent-focus')) el.classList.remove('agent-focus');
  for (const { kind, id } of items || []) {
    const q = CSS.escape(id);
    const el = kind === 'clip' ? document.querySelector(`.clip[data-id="${q}"]`) : kind === 'transition' ? document.querySelector(`.xfade[data-id="${q}"]`)
      : kind === 'track' ? document.querySelector(`#tracks > .track[data-track="${q}"]`) : kind === 'folder' ? document.querySelector(`#tracks > .track[data-folder="${q}"]`)
      : kind === 'marker' ? [...$('ruler').querySelectorAll('.marker')].find(m => m.group?.some(o => o.id === id)) : null;
    el?.classList.add('agent-focus');
  }
}
function agentReveal(anchor) {
  const items = (anchor.items || []).filter(i => i.kind !== 'project' && agentItemLabel(i) != null), kind = items[0]?.kind;
  if (kind === 'clip') { select(items.map(i => i.id)); seek(Math.min(...items.map(i => startF(clipById(i.id))))); }
  else if (kind === 'transition') selectTransition(items[0].id);
  else if (kind === 'marker') { selectMarker(items[0].id); seek(markerF(markerById(items[0].id))); }
  else if (kind === 'track') selectTracks(items.map(i => i.id));
  else if (kind === 'folder') selectFolder(items[0].id);
  else if (anchor.time) seek(toF(anchor.time));
}
// Small, exact GUI state captured with every message. Times are project rationals { num, den } in seconds.
function agentItemContext({ kind, id }) {
  if (kind === 'clip') { const c = clipById(id); return c && { kind, id, name: clipName(c), mediaKind: mediaById(c.mediaId)?.kind, trackId: c.trackId, start: c.start, duration: c.duration, mediaId: c.mediaId, ...(c.linkId ? { linkId: c.linkId } : {}) }; }
  if (kind === 'transition') { const t = transitionById(id); return t && { kind, id, trackId: t.trackId, fromClipId: t.fromClipId, toClipId: t.toClipId, duration: t.duration, alignment: t.alignment }; }
  if (kind === 'marker') { const m = markerById(id); return m && { kind, id, name: m.name, time: m.time }; }
  if (kind === 'track') { const t = trackById(id); return t && { kind, id, name: t.name, index: tracks().indexOf(t), ...(t.folderId ? { folderId: t.folderId } : {}) }; }
  if (kind === 'folder') { const f = folderById(id); return f && { kind, id, name: f.name, trackIds: folderMembers(id).map(t => t.id) }; }
  if (kind === 'project') return { kind, id, name: project()?.name };
  return null;
}
function agentContext(anchor) {
  const p = project(); if (!p) return null;
  const sel = {};
  if (selection.size) sel.clips = [...selection];
  if (selTransition) sel.transition = selTransition;
  if (selMarker) sel.marker = selMarker;
  if (selTracks.size) sel.tracks = [...selTracks];
  if (selFolder) sel.folder = selFolder;
  if (selPoint) sel.volumePoint = { clipId: selPoint.clipId, time: selPoint.time };
  const context = { capturedAt: new Date().toISOString(), projectId: p.id, projectRevision: p.revision, fps: rate(), playhead: fromF(playF), playheadTimecode: tc(playF), selection: sel };
  if (inF != null || outF != null) context.range = { in: fromF(inF ?? 0), out: fromF((outF ?? lastFrame()) + 1) };
  if (anchor) context.anchor = { kind: anchor.kind, label: anchor.label, ...(anchor.trackId ? { trackId: anchor.trackId } : {}), ...(anchor.time ? { time: anchor.time } : {}),
    items: (anchor.items || []).map(i => agentItemContext(i) || { kind: i.kind, id: i.id, missing: true }) };
  return context;
}

// ---------------------------------------------------------------- Events and startup
window.addEventListener('beforeunload', () => source.clear());
window.afclipPrepareReload = () => {
  if (graphicTextEdit || !connected || drag || modal || markerPop || agents?.holdsReload() || editingTrack || editsInFlight || playback.wantsPlay || playback.busy || frameJobId || source.running ||
      document.activeElement?.matches('input,textarea,select,[contenteditable="true"]') || document.querySelector(':active')) return false;
  rememberMarks(); clearTimeout(rememberMarks.t); savePrefs();
  return true;
};
api.onEvent(async event => {
  try {
    if (event.type === 'disconnected') { playback.pause(false); setConnected(false, event.value?.message); syncChrome(); say('Project connection closed. Reopen the project to reconnect.', 'error'); return; }
    if(event.type==='graphic-error'){playback.pause(false);say(event.value.error?.message||'HTML asset reload failed','error');return;}
    if (event.type === 'job') { await onJob(event.value.job || event.value); return; }
    if (event.type === 'change' || event.type === 'hello') {
      const next = event.value.inspect || event.value;
      const external = snapshot && next.project && next.project.revision !== snapshot.project.revision;
      if (next.project && next.revisions) { snapshot = next; draw(); } else await refresh();
      if (external && prefs.autoRender) requestFrame(0);
    }
  } catch (error) { say(explain(error), 'error'); }
});

applyLayout(); buildMenubar(); buildChrome(); idleHint();
agents = window.AFClipAgents?.({
  api, h, icon, kbd, dialog, closeModal, field, segmented, toast, say, report, explain, hideTip, openMenu,
  blocked: () => !!modal || !!openMenuState, pointer: () => pointer, project, hasSelection,
  target: agentTarget, anchor: agentAnchor, label: agentItemLabel, locate: agentLocate, context: agentContext, highlight: agentHighlight, reveal: agentReveal,
}) || null;
refresh().then(async () => {
  say('Connected to project');
  if (project().media.some(m => sourceBound(m) && !m.metadata?.library)) {
    // Older projects gain identities once; annotation reads never rewrite clips.
    void api.command({ command: 'library-sync' }).then(() => refresh()).then(refreshLibraryMedia).catch(() => {});
  }
  const state = await api.command({ command: 'status' });
  const jobs = (Array.isArray(state) ? state : state.jobs || (state.id ? [state] : [])).sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
  for (const job of jobs) await onJob(job, { silent: true });
  if (prefs.autoRender && clips().length) requestFrame(0);
  welcome();
  api.ready();
}).catch(error => { setConnected(false, explain(error)); say(explain(error), 'error'); api.ready(); });
