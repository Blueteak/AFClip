// Turn the Vellum first edit into an HTML asset showcase through engine commands:
// custom WebGL/Canvas transitions on every cut, stacked clip effects, animated
// overlays, kinetic type, a boss HUD and a 2x2 split-screen from clip transforms.
// Run after build.mjs. Undo or restore the checkpoint to return to the plain edit.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { endpoint, request } from '../../src/engine/client.ts';
const dir = path.dirname(fileURLToPath(import.meta.url)), assets = path.join(dir, 'showcase');
const ep = await endpoint(dir), command = value => request(ep, '/command', value);
const initial = await request(ep, '/inspect');
const staged = (name, target) => {
  fs.rmSync(target, { recursive: true, force: true });
  fs.cpSync(path.join(assets, name), target, { recursive: true });
  if (fs.readFileSync(path.join(target, 'index.html'), 'utf8').includes('src="gl.js"')) fs.copyFileSync(path.join(assets, '_shared', 'gl.js'), path.join(target, 'gl.js'));
};
// --sync copies edited packages into their authoring folders; the engine accepts them as new snapshots.
if (process.argv.includes('--sync')) {
  for (const name of fs.readdirSync(assets).filter(n => !n.startsWith('_'))) {
    const title = JSON.parse(fs.readFileSync(path.join(assets, name, 'asset.json'))).name;
    for (const m of initial.project.media.filter(m => m.metadata.asset?.name === title && !m.metadata.builtin)) staged(name, path.join(dir, m.metadata.authoringPath));
  }
  process.exit(0);
}
if (!initial.project.clips.some(c => c.id === 'shot_8')) throw new Error('Build the first edit before applying the showcase');
if (initial.project.tracks.some(t => t.id === 'overlays')) throw new Error('The showcase is already applied');
await command({ command: 'checkpoint', task: 'Showcase HTML transitions, effects and graphics' });

// Stage each package with the shared WebGL helper so imports stay self-contained.
const stage = path.join(dir, '.afclip', 'showcase-stage'), ids = {};
for (const name of fs.readdirSync(assets).filter(n => !n.startsWith('_'))) {
  const target = path.join(stage, name);
  staged(name, target);
  ids[name] = (await command({ command: 'import', path: target, kind: 'graphic' })).media.id;
  console.log(`Imported ${name}`);
}
const media = new Map();
async function source(file) { if (!media.has(file)) media.set(file, (await command({ command: 'import', path: file })).media); return media.get(file); }
const rec = 'D:\\Recordings\\Vellum_TrailerCap_November\\', sfx = 'D:\\Audio Effects\\';
const tiles = [['4P_Fantasy_5.mp4', 12], ['4P_Dares_2.mp4', 10], ['4P_Spire_1.mp4', 14], ['4P_Fund_5.mp4', 9]];
// [file, sourceIn, timeline start, duration, gain dB]. Starts place each measured peak on its visual beat.
const accents = [
  ['Boom Library -  Magic Bundle\\MAGIC - Construction Kit\\MACK Fire Burst Blowtorch Medium.wav', 14, 7.13, 2.2, -10],
  ['Arcane Activations\\Arcane Magic\\Shatter Stasis Field 01.wav', 0, 15.09, 3, -8],
  ['Motion, Whooshes, and Impacts\\Impacts\\Impact Horror Glitch.wav', 1, 23.6, 2.5, -10],
  ['Arcane Activations\\Risers Transitions Whooshes\\Arcane Reveal Transition.wav', 0, 26.4, 2.16, -10],
  ['Arcane Activations\\Risers Transitions Whooshes\\Dark Whirlwind Whoosh.wav', 0, 31.31, 2.4, -10],
  ['Book_SFX\\Hard Cover\\Turn page\\Hard_cover_turn_page_004.mp3', 0, 39.68, 1.1, 0],
  ['Motion, Whooshes, and Impacts\\Impacts\\Impact Distorted 001.wav', 0, 47.55, 1.7, -10],
  ['Arcane Activations\\Risers Transitions Whooshes\\Arcane Sparkle Transition.wav', 0, 54.22, 3.1, -10],
  ['Motion, Whooshes, and Impacts\\Impacts\\Impact Tom 001.wav', 0, 9.0, 2, -12],
  ['Motion, Whooshes, and Impacts\\Impacts\\Impact Tom 001.wav', 0, 17.2, 2, -12],
  ['Motion, Whooshes, and Impacts\\Impacts\\Impact Tom 001.wav', 0, 33.2, 2, -12],
];
for (const [file] of tiles) await source(rec + file);
for (const [file] of accents) await source(sfx + file);

const state = await request(ep, '/inspect'), preconditions = { ...state.revisions }, operations = [];
for (const m of state.project.media) preconditions[`usage:${m.id}`] ??= 0;
const key = { tracks: 'track', clips: 'clip', transitions: 'transition' };
function put(collection, value, existing = false) {
  if (!existing) { preconditions[`${key[collection]}:${value.id}`] = 0; if (collection === 'tracks') preconditions[`occupancy:${value.id}`] = 0; }
  operations.push({ op: 'put', collection, value });
}
const t = n => ({ num: Math.round(n * 30), den: 30 });
const tracks = [['sfx_showcase', 'Showcase accents'], ['sfx_type', 'Type hits'], ['tile_1', 'Split I'], ['tile_2', 'Split II'], ['tile_3', 'Split III'], ['tile_4', 'Split IV'], ['overlays', 'Overlays'], ['callouts', 'Callouts']];
for (const [id, name] of tracks) put('tracks', { id, name, locked: false, disabled: false });

// Every cut gets its own asset and timing.
const cuts = [
  ['ember-burn', 1.4, { originX: .15, originY: .85 }],
  ['glass-shatter', 1.2, { impactX: .55, impactY: .42 }],
  ['glitch', .8, {}],
  ['vortex', 1.4, {}],
  ['page-curl', 1.6, {}],
  ['zoom-punch', .9, {}],
  ['hex-flip', 1.4, {}],
];
cuts.forEach(([name, duration, params], i) => put('transitions', { id: `dissolve_${i + 1}`, assetId: ids[name], duration: t(duration), params, seed: 300 + i }, true));

// Ordered effect stacks per shot.
const fx = (name, params = {}, n = 0) => ({ id: `${name}_${n}`, assetId: ids[name], params, seed: 400 + n });
const stacks = {
  shot_1: [fx('cinematic', { bars: .1, barsIn: .12 })],
  shot_3: [fx('frost')],
  shot_5: [fx('prism')],
  shot_6: [fx('impact-shake', { hits: '0.5, 2.2, 3.6, 5.1' }, 1), fx('cinematic', { highlights: '#ff7b54', shadows: '#2a1020', bars: .08, barsIn: 0 }, 2)],
  shot_7: [fx('bloom')],
  shot_8: [fx('impact-shake', { hits: '0.3, 1.4', flash: '#f1cf86', shake: .018 }, 3), fx('cinematic', { highlights: '#ffd28a', bars: .1, barsIn: 0, grade: .5 }, 4)],
};
for (const [id, effects] of Object.entries(stacks)) put('clips', { id, effects }, true);

// HTML content clips.
const graphic = (id, trackId, name, start, duration, params = {}, seed = 0) => put('clips', { id, trackId, mediaId: ids[name], name: id, start: t(start), duration: t(duration), sourceIn: t(0), params, seed });
put('clips', { id: 'opening_title', mediaId: ids['grimoire-title'], params: {}, seed: 7 }, true);
graphic('embers_open', 'overlays', 'embers', 0, 8, { count: 120 }, 11);
graphic('word_explore', 'callouts', 'word-slam', 9, 2.6, { word: 'EXPLORE', kicker: 'CHAPTER I', accent: '#8dffb0', align: 'left' });
graphic('word_survive', 'callouts', 'word-slam', 17.2, 2.6, { word: 'SURVIVE', kicker: 'CHAPTER II', accent: '#9fe8ff', align: 'right' });
graphic('split_frame', 'overlays', 'split-frame', 26.9, 4);
graphic('word_conquer', 'callouts', 'word-slam', 33.2, 2.6, { word: 'CONQUER', kicker: 'CHAPTER III', accent: '#c08bff' });
graphic('embers_boss', 'overlays', 'embers', 40, 16, { count: 170, color: '#ff4422', drift: -60, rise: .16 }, 12);
graphic('boss_hud_1', 'callouts', 'boss-hud', 41, 5.5, { name: 'THE SKELETON' });
graphic('boss_hud_2', 'callouts', 'boss-hud', 49, 5.5, { name: 'THE REAPER', color: '#b76bff', targetX: .5, targetY: .45 });
graphic('embers_finale', 'overlays', 'embers', 56, 8, { count: 200, color: '#f1cf86', rise: .1, size: 1.3 }, 13);
graphic('shockwave', 'callouts', 'shockwave', 58, 3, {}, 14);

// 2x2 split-screen: four transformed clips reveal in turn under the frame graphic.
tiles.forEach(([file, sourceIn], i) => put('clips', {
  id: `tile_clip_${i + 1}`, trackId: `tile_${i + 1}`, mediaId: media.get(rec + file).id, name: file.replace('.mp4', ''), mute: true,
  start: t(27 + i * .15), duration: t(3.9 - i * .15), sourceIn: t(sourceIn), fadeIn: t(.3), fadeOut: t(.35),
  transform: { scale: .5, x: i % 2 ? 480 : -480, y: i < 2 ? -270 : 270, fit: 'fill' },
}));
accents.forEach(([file, sourceIn, start, duration, gain], i) => { const m = media.get(sfx + file); put('clips', {
  id: `accent_${i + 1}`, trackId: file.includes('Impact Tom') ? 'sfx_type' : 'sfx_showcase', mediaId: m.id, name: path.basename(file).replace(/\.\w+$/, ''),
  start: t(start), duration: { num: Math.floor(Math.min(duration, m.duration.num / m.duration.den - sourceIn) * 30), den: 30 },
  sourceIn: t(sourceIn), volume: 10 ** (gain / 20), fadeIn: t(.02), fadeOut: t(.25),
}); });
await command({ command: 'apply', batch: { preconditions, operations } });

// Overlays stack above footage, below the titles.
const placed = await request(ep, '/inspect'), order = ['music', 'sfx', 'sfx_showcase', 'sfx_type', 'footage', 'tile_1', 'tile_2', 'tile_3', 'tile_4', 'overlays', 'callouts', 'titles'];
const rest = placed.project.tracks.map(tr => tr.id).filter(id => !order.includes(id));
const result = await command({ command: 'apply', batch: { preconditions: placed.revisions, operations: [{ op: 'reorder-tracks', trackIds: [...order, ...rest] }] } });
console.log(JSON.stringify({ revision: result.project?.revision, assets: Object.keys(ids).length, operations: operations.length }));
