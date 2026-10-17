const $ = id => document.getElementById(id);
const api = window.reelet;
let snapshot, selectedId, playhead = 0, dirty = false, formRevisions, formValues, activeJob, finishedExport, pending = false, firstLoad = true, requestedFrame = 0;
const seenCompleted = new Set();
const secs = time => typeof time === 'number' ? time : time ? time.num / time.den : 0;
const fps = () => secs(snapshot?.project.fps) || 30;
const project = () => snapshot?.project;
const endTime = () => Math.max(1 / fps(), ...(project()?.clips || []).map(clip => secs(clip.start) + secs(clip.duration)));
const time = value => ({ num: Math.round(Number(value) * fps()) * project().fps.den, den: project().fps.num });
const basename = value => value.split(/[\\/]/).pop();
const clipName = clip => clip.name || basename(project().media.find(media => media.id === clip.mediaId)?.path || 'Clip');
const frameCode = value => {
  const rate = fps(), frames = Math.round(value * rate), whole = Math.floor(frames / rate);
  return [Math.floor(whole / 3600), Math.floor(whole / 60) % 60, whole % 60, Math.round(frames - whole * rate)].map(x => String(x).padStart(2, '0')).join(':');
};

function status(message, error = false) { $('status').textContent = message; $('status').classList.toggle('error', error); }
function button(text, fn, title) { const element = document.createElement('button'); element.textContent = text; element.onclick = fn; if (title) element.title = title; return element; }
function isLocked() { return pending || !!snapshot?.renderLock; }
function controls() {
  const locked = isLocked();
  $('playhead').disabled = locked; $('render-mode').disabled = locked; $('full-verification').disabled = locked;
  for (const id of ['export', 'import', 'add-track', 'render-frame', 'first-preview', 'previous-frame', 'next-frame']) $(id).disabled = locked;
  $('undo').disabled = locked || !snapshot?.history?.undo;
  $('redo').disabled = locked || !snapshot?.history?.redo;
  const clip = project()?.clips.find(item => item.id === selectedId);
  const trackLocked = clip && project().tracks.find(track => track.id === clip.trackId)?.locked;
  for (const input of $('clip-form').elements) input.disabled = locked || !!trackLocked;
  for (const element of document.querySelectorAll('[data-action="add-media"], [data-action="lock-track"]')) element.disabled = locked;
  for (const element of document.querySelectorAll('[data-action="disable-track"]')) element.disabled = locked || !!project()?.tracks.find(track => track.id === element.dataset.trackId)?.locked;
  $('save-status').textContent = snapshot?.renderLock ? 'Rendering · edits locked' : dirty ? 'Unapplied clip changes' : 'All committed changes saved';
}

async function refresh() {
  snapshot = await api.inspect();
  $('connection-dot').classList.add('connected');
  draw();
  return snapshot;
}

function draw() {
  const p = project(); if (!p) return;
  if (firstLoad && !selectedId && p.clips.length) selectedId = [...p.clips].sort((a, b) => secs(a.start) - secs(b.start))[0].id;
  $('project-name').textContent = p.name;
  document.title = `${p.name} · Reelet`;
  $('project-specs').textContent = `${p.resolution.width} × ${p.resolution.height}  /  ${fps().toFixed(3).replace(/\.?0+$/, '')} fps`;
  $('timeline-duration').textContent = `${endTime().toFixed(2)} seconds`;
  $('playhead').max = Math.max(0, endTime() - 1 / fps());
  $('playhead').step = 1 / fps();
  playhead = Math.min(playhead, Number($('playhead').max));
  drawMedia(); drawTimeline(); drawInspector(); updatePlayhead(); controls();
  if (firstLoad) {
    firstLoad = false;
    if (p.clips.length) { playhead = Math.min(2, Math.max(0, endTime() - 1 / fps())); updatePlayhead(); }
    api.ready();
  }
}

function drawMedia() {
  const list = $('media-list'); list.replaceChildren();
  const query = $('search').value.toLowerCase();
  for (const media of project().media.filter(item => basename(item.path).toLowerCase().includes(query))) {
    const row = document.createElement('div'); row.className = 'media-item';
    const symbol = document.createElement('span'); symbol.className = 'media-symbol'; symbol.textContent = { video: 'VID', audio: 'AUD', graphic: 'HTML', image: 'IMG' }[media.kind];
    const content = document.createElement('div');
    const name = document.createElement('span'); name.className = 'media-name'; name.textContent = basename(media.path); name.title = media.path;
    const meta = document.createElement('span'); meta.className = 'media-meta'; meta.textContent = [media.metadata.width ? `${media.metadata.width} × ${media.metadata.height}` : media.kind, secs(media.duration) ? `${secs(media.duration).toFixed(1)}s` : null].filter(Boolean).join(' · ');
    const add = button('+ Add', () => addMedia(media), 'Add this source on a new track'); add.dataset.action = 'add-media'; add.className = 'small'; add.style.marginTop = '8px'; add.disabled = isLocked();
    content.append(name, meta, add); row.append(symbol, content); list.append(row);
  }
  if (!project().media.length) { const empty = document.createElement('p'); empty.className = 'empty-copy'; empty.textContent = 'Import footage, audio or images to begin.'; list.append(empty); }
}

function drawTimeline() {
  const scale = Math.max(10, endTime() * 1.04), ruler = $('ruler'); ruler.replaceChildren();
  for (let i = 0; i < 10; i++) { const tick = document.createElement('span'); tick.className = 'tick'; tick.style.left = `${i * 10}%`; tick.textContent = `${(scale * i / 10).toFixed(scale > 100 ? 0 : 1)}s`; ruler.append(tick); }
  ruler.onclick = event => seekFromClick(event, ruler, scale);
  const trackList = $('track-list'); trackList.replaceChildren();
  for (const track of [...project().tracks].reverse()) {
    const row = document.createElement('div'); row.className = `track-row${track.disabled ? ' disabled' : ''}`;
    const head = document.createElement('div'); head.className = 'track-head';
    const label = document.createElement('span'); label.className = 'track-name'; label.textContent = track.name; label.title = track.name;
    const disable = button(track.disabled ? 'OFF' : 'ON', () => changeTrack(track, { disabled: !track.disabled }), 'Disable picture and audio'); disable.className = track.disabled ? 'on' : ''; disable.disabled = isLocked() || track.locked;
    const lock = button(track.locked ? 'LOCK' : 'OPEN', () => changeTrack(track, { locked: !track.locked }), 'Lock or unlock track'); lock.className = track.locked ? 'on' : ''; lock.disabled = isLocked();
    disable.dataset.action = 'disable-track'; disable.dataset.trackId = track.id; lock.dataset.action = 'lock-track';
    head.append(label, disable, lock);
    const lane = document.createElement('div'); lane.className = 'track-lane'; lane.dataset.scale = scale; lane.onclick = event => seekFromClick(event, lane, scale);
    for (const clip of project().clips.filter(item => item.trackId === track.id)) {
      const media = project().media.find(item => item.id === clip.mediaId);
      const block = button('', event => { event.stopPropagation(); selectClip(clip.id); }, clipName(clip));
      block.className = `clip ${media?.kind || ''}${clip.id === selectedId ? ' selected' : ''}`;
      block.style.left = `${100 * secs(clip.start) / scale}%`; block.style.width = `${100 * secs(clip.duration) / scale}%`;
      const name = document.createElement('strong'); name.textContent = clipName(clip);
      const info = document.createElement('small'); info.textContent = `${secs(clip.duration).toFixed(2)}s${clip.mute ? ' · muted' : ''}`;
      block.append(name, info); lane.append(block);
    }
    for (const transition of project().transitions.filter(item => item.trackId === track.id)) {
      const incoming = project().clips.find(item => item.id === transition.toClipId); if (!incoming) continue;
      const duration = secs(transition.duration), before = transition.alignment === 'start' ? 0 : transition.alignment === 'end' ? duration : duration / 2;
      const band = document.createElement('span'); band.className = 'transition'; band.title = `Dissolve · ${duration}s`; band.style.left = `${100 * (secs(incoming.start) - before) / scale}%`; band.style.width = `${100 * duration / scale}%`; lane.append(band);
    }
    const line = document.createElement('div'); line.className = 'playhead-line'; lane.append(line);
    row.append(head, lane); trackList.append(row);
  }
}

function drawInspector() {
  const clip = project().clips.find(item => item.id === selectedId);
  $('clip-form').hidden = !clip; $('inspector-empty').hidden = !!clip;
  if (!clip) { $('clip-type').textContent = ''; return; }
  $('clip-type').textContent = project().media.find(item => item.id === clip.mediaId)?.kind;
  if (dirty) return;
  const form = $('clip-form'); form.elements.name.value = clipName(clip);
  for (const field of ['start', 'sourceIn', 'duration']) { form.elements[field].value = secs(clip[field]).toFixed(6).replace(/\.?0+$/, ''); form.elements[field].step = 'any'; }
  form.elements.volume.value = Math.round(clip.volume * 100);
  formRevisions = { ...snapshot.revisions };
  formValues = Object.fromEntries(['name', 'start', 'sourceIn', 'duration', 'volume'].map(field => [field, form.elements[field].value]));
}

function selectClip(id) { selectedId = id; dirty = false; drawTimeline(); drawInspector(); updatePlayhead(); controls(); }
function updatePlayhead() {
  $('timecode').textContent = frameCode(playhead); $('playhead').value = playhead;
  for (const line of document.querySelectorAll('.playhead-line')) line.style.left = `${100 * playhead / Number(line.parentElement.dataset.scale)}%`;
}
function seekFromClick(event, lane, scale) { if (isLocked()) return; const box = lane.getBoundingClientRect(); setPlayhead((event.clientX - box.left) / box.width * scale, true); }
function setPlayhead(value, render = false) { playhead = Math.max(0, Math.min(Math.round(value * fps()) / fps(), endTime() - 1 / fps())); updatePlayhead(); $('preview-status').textContent = 'Frame not rendered'; if (render) renderFrame(); }

async function perform(action, success) {
  if (pending) return;
  pending = true; controls();
  try { const result = await action(); if (success) status(success); await refresh(); return result; }
  catch (error) { status(error.message, true); }
  finally { pending = false; controls(); }
}

async function changeTrack(track, changes) {
  await perform(() => api.command({ command: 'apply', batch: { preconditions: { ...snapshot.revisions }, operations: [{ op: 'put', collection: 'tracks', value: { id: track.id, ...changes } }] } }), 'Track saved');
}

async function addTrack() {
  const track = { id: `track_${crypto.randomUUID().replaceAll('-', '')}`, name: `Track ${project().tracks.length + 1}`, disabled: false, locked: false };
  await perform(() => api.command({ command: 'apply', batch: { preconditions: { ...snapshot.revisions, [`track:${track.id}`]: 0, [`occupancy:${track.id}`]: 0 }, operations: [{ op: 'put', collection: 'tracks', value: track }] } }), 'Track added');
}

async function addMedia(media) {
  const id = crypto.randomUUID().replaceAll('-', ''), track = { id: `track_${id}`, name: basename(media.path), disabled: false, locked: false };
  const length = media.kind === 'graphic' || media.kind === 'image' ? 5 : Math.floor(secs(media.duration) * fps()) / fps();
  const clip = { id: `clip_${id}`, trackId: track.id, mediaId: media.id, name: basename(media.path), start: time(playhead), duration: time(length), sourceIn: time(0), speed: { num: 1, den: 1 }, volume: 1, mute: false, fadeIn: time(0), fadeOut: time(0) };
  const result = await perform(() => api.command({ command: 'apply', batch: { preconditions: { ...snapshot.revisions, [`track:${track.id}`]: 0, [`occupancy:${track.id}`]: 0, [`clip:${clip.id}`]: 0 }, operations: [{ op: 'put', collection: 'tracks', value: track }, { op: 'put', collection: 'clips', value: clip }] } }), 'Media added on a new track');
  if (result) selectClip(clip.id);
}

async function renderFrame() {
  if (!snapshot || isLocked() || !project().clips.length) { api.ready(); return; }
  requestedFrame = playhead;
  $('preview-status').textContent = 'Rendering frame';
  await startRender({ kind: 'frame', mode: $('render-mode').value, frameTime: time(playhead) });
}

async function startRender(options) {
  await perform(async () => { const job = await api.render(options); if (job) await showJob(job); return job; });
}

async function showJob(job) {
  if (!job?.id) return;
  activeJob = job;
  const state = job.status, complete = ['complete', 'completed', 'succeeded'].includes(state), failed = ['failed', 'cancelled', 'canceled'].includes(state);
  const detail = job.result || (typeof job.progress === 'object' ? job.progress : job), kind = job.kind || job.config?.kind || detail.kind;
  $('render-card').hidden = false;
  $('job-title').textContent = complete ? kind === 'frame' ? 'Preview ready' : 'Export ready' : failed ? state === 'failed' ? 'Render failed' : 'Render cancelled' : kind === 'frame' ? 'Rendering preview' : 'Exporting MP4';
  const progress = typeof job.progress === 'number' ? job.progress : detail.fraction ?? detail.progress ?? (detail.frame && detail.totalFrames ? detail.frame / detail.totalFrames : 0);
  $('job-progress').value = complete ? 1 : Math.max(0, Math.min(1, progress || 0));
  $('job-detail').textContent = failed ? job.error?.message || job.error || 'No incomplete export was kept.' : complete ? kind === 'frame' ? 'Exact project frame, using original media.' : 'Finished MP4 is ready to play.' : detail.message || detail.stage || 'Preparing media. You can close this window while the export continues.';
  $('cancel-job').hidden = complete || failed;
  const output = job.output || job.result?.output;
  if (complete && output && !seenCompleted.has(job.id)) {
    seenCompleted.add(job.id);
    if (kind === 'frame' || /\.png$/i.test(output)) {
      $('export-video').pause(); $('export-video').hidden = true; $('preview').onload = () => api.ready(); $('preview').src = await api.mediaUrl(output); $('preview').hidden = false; $('preview-empty').hidden = true;
      $('preview-status').textContent = `Frame at ${frameCode(secs(job.result?.frameTime || job.frameTime) || requestedFrame)}${job.projectRevision !== project().revision ? ' · earlier edit' : ''}`;
    } else { finishedExport = output; $('watch-export').hidden = false; $('show-export').hidden = false; }
    status(kind === 'frame' ? 'Preview rendered' : 'Export complete');
  }
  if (failed) { status(job.error?.message || job.error || 'Render cancelled', state === 'failed'); if (kind === 'frame') $('preview-status').textContent = 'Render stopped'; api.ready(); }
  if (complete || failed) { activeJob = null; await refresh(); }
  controls();
}

$('search').oninput = drawMedia;
$('clip-form').oninput = () => { dirty = true; controls(); };
$('clip-form').onsubmit = async event => {
  event.preventDefault(); const clip = project().clips.find(item => item.id === selectedId); if (!clip) return;
  const fields = $('clip-form').elements;
  const value = { id: clip.id };
  for (const field of ['name', 'start', 'sourceIn', 'duration', 'volume']) if (fields[field].value !== formValues[field]) value[field] = field === 'name' ? fields[field].value : field === 'volume' ? Number(fields[field].value) / 100 : time(fields[field].value);
  if (Object.keys(value).length === 1) { dirty = false; controls(); return; }
  await perform(async () => { const result = await api.command({ command: 'apply', batch: { preconditions: formRevisions, operations: [{ op: 'put', collection: 'clips', value }] } }); dirty = false; return result; }, 'Clip saved');
};
$('undo').onclick = () => perform(async () => { await api.command({ command: 'undo' }); dirty = false; }, 'Undid the last edit');
$('redo').onclick = () => perform(async () => { await api.command({ command: 'redo' }); dirty = false; }, 'Redid the last edit');
$('import').onclick = () => perform(() => api.importMedia(), 'Media imported');
$('add-track').onclick = addTrack;
$('export').onclick = () => startRender({ kind: 'export', mode: $('render-mode').value, verification: $('full-verification').checked ? 'full' : 'quick' });
$('first-preview').onclick = renderFrame; $('render-frame').onclick = renderFrame;
$('previous-frame').onclick = () => setPlayhead(playhead - 1 / fps(), true); $('next-frame').onclick = () => setPlayhead(playhead + 1 / fps(), true);
$('playhead').oninput = event => setPlayhead(Number(event.target.value)); $('playhead').onchange = renderFrame;
$('cancel-job').onclick = () => perform(() => api.command({ command: 'cancel', jobId: activeJob?.id }), 'Cancellation requested');
$('watch-export').onclick = async () => { if (!finishedExport) return; $('export-video').src = await api.mediaUrl(finishedExport); $('export-video').hidden = false; $('preview').hidden = true; $('preview-empty').hidden = true; $('preview-status').textContent = 'Finished export playback'; $('export-video').play().catch(error => status(error.message, true)); };
$('show-export').onclick = () => finishedExport && api.showOutput(finishedExport);
document.addEventListener('keydown', event => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z' && !['INPUT', 'TEXTAREA'].includes(event.target.tagName)) { event.preventDefault(); const control = $(event.shiftKey ? 'redo' : 'undo'); if (!control.disabled) control.click(); } });
api.onEvent(async event => {
  try {
    if (event.type === 'disconnected') { $('connection-dot').classList.remove('connected'); status('Project connection closed. Reopen the project to reconnect.', true); return; }
    if (event.type === 'job') { await showJob(event.value.job || event.value); return; }
    if (event.type === 'change' || event.type === 'hello') { const next = event.value.inspect || event.value; if (next.project && next.revisions) { snapshot = next; draw(); } else await refresh(); }
  } catch (error) { status(error.message, true); }
});
refresh().then(async () => { status('Connected to project'); const state = await api.command({ command: 'status' }); const jobs = Array.isArray(state) ? state : state.jobs || (state.id ? [state] : []); for (const job of [...jobs].sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')))) await showJob(job); }).catch(error => { status(error.message, true); api.ready(); });
setInterval(async () => { if (!activeJob) return; try { const result = await api.command({ command: 'status', jobId: activeJob.id }); await showJob(result.job || result); } catch (error) { status(error.message, true); } }, 2000);
