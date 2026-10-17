// Assemble the supplied-media edit through exactly the same commands as the GUI and CLI.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createProject } from '../../src/engine/state.ts';
import { endpoint, request } from '../../src/engine/client.ts';
const dir = path.dirname(fileURLToPath(import.meta.url));
const edl = JSON.parse(fs.readFileSync(path.join(dir, 'edit.json')));
const soundtrack = JSON.parse(fs.readFileSync(path.join(dir, 'soundtrack.json')));
if (!fs.existsSync(path.join(dir, 'project.json'))) createProject(dir, { name: 'Vellum - First Edit', width: 1920, height: 1080, fps: { num: 30, den: 1 } });
const ep = await endpoint(dir), command = value => request(ep, '/command', value);
const initial = await request(ep, '/inspect');
if (initial.project.clips.length) throw new Error('This edit already contains clips. Open it with npm start -- examples/vellum-first-edit. Assembly will not overwrite edits.');
await command({ command: 'checkpoint', task: 'Assemble the first 64-second Vellum edit' });
const media = new Map();
async function imported(file, kind) {
  if (!media.has(file)) { console.log(`Importing ${path.basename(file)}`); const r = await command({ command: 'import', path: file, kind }); media.set(file, r.media); }
  return media.get(file);
}
for (const clip of edl.clips) await imported(clip.file);
await imported(soundtrack.music.file); for (const sfx of soundtrack.effects) await imported(sfx.file);
const opening = await imported(path.join(dir, 'graphics/opening'), 'graphic'), closing = await imported(path.join(dir, 'graphics/closing'), 'graphic');
const state = await request(ep, '/inspect'), preconditions = { ...state.revisions }, operations = [];
function put(collection, value) { const key = { tracks: 'track', clips: 'clip', transitions: 'transition' }[collection]; preconditions[`${key}:${value.id}`] = 0; if (collection === 'tracks') preconditions[`occupancy:${value.id}`] = 0; operations.push({ op: 'put', collection, value }); }
const t = n => ({ num: Math.round(n * 30), den: 30 });
for (const [id, name] of [['music', 'Music'], ['sfx', 'Title and transition accents'], ['footage', 'Gameplay selects'], ['titles', 'Titles']]) put('tracks', { id, name, locked: false, disabled: false });
for (const [i, clip] of edl.clips.entries()) {
  put('clips', { id: `shot_${i + 1}`, trackId: 'footage', mediaId: media.get(clip.file).id, name: clip.intent, start: t(clip.timelineStart), duration: t(clip.duration), sourceIn: t(clip.sourceIn),
    fadeIn: t(i === 0 ? .6 : 0), fadeOut: t(i === edl.clips.length - 1 ? 1.2 : 0) });
  if (i) put('transitions', { id: `dissolve_${i}`, trackId: 'footage', fromClipId: `shot_${i}`, toClipId: `shot_${i + 1}`, duration: t(1), alignment: 'center' });
}
for (const [i, clip] of [soundtrack.music, ...soundtrack.effects].entries()) {
  const m = media.get(clip.file), maxDuration = m.duration.num / m.duration.den - clip.sourceIn;
  put('clips', { id: i ? `effect_${i}` : 'music_bed', trackId: i ? 'sfx' : 'music', mediaId: m.id, name: clip.name || 'Fantasy Action', start: t(clip.timelineStart),
    duration: { num: Math.floor(Math.min(clip.duration, maxDuration) * 30 + 1e-7), den: 30 }, sourceIn: t(clip.sourceIn), volume: 10 ** (clip.gainDb / 20), fadeIn: t(clip.fadeIn), fadeOut: t(clip.fadeOut) });
}
put('clips', { id: 'opening_title', trackId: 'titles', mediaId: opening.id, name: 'Vellum opening', start: t(0), duration: t(8), sourceIn: t(0) });
put('clips', { id: 'closing_title', trackId: 'titles', mediaId: closing.id, name: 'Vellum closing', start: t(58), duration: t(6), sourceIn: t(0) });
const result = await command({ command: 'apply', batch: { preconditions, operations } });
console.log(JSON.stringify({ projectDir: dir, revision: result.project.revision, clips: result.project.clips.length, duration: 64 }, null, 2));
