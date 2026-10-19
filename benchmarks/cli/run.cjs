// Opt-in CLI measurements against a disposable copy of an existing edit.
// node benchmarks/cli/run.cjs <project> <new-output-directory>
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '../..');
const [sourceArg, outputArg] = process.argv.slice(2);
if (!sourceArg || !outputArg) throw new Error('Supply a project and a new output directory');
const source = path.resolve(sourceArg), output = path.resolve(outputArg);
fs.mkdirSync(output); // Refuse to overwrite previous measurements.
const projectDir = path.join(output, 'project'), catalog = path.join(output, 'library');
fs.mkdirSync(projectDir);
const project = JSON.parse(fs.readFileSync(path.join(source, 'project.json'), 'utf8'));
for (const media of project.media) {
  const original = path.resolve(source, media.path);
  if (media.kind === 'graphic') {
    media.path = path.join('graphics', media.id);
    fs.cpSync(original, path.join(projectDir, media.path), { recursive: true });
    delete media.metadata.authoringPath;
  } else media.path = original;
}
fs.writeFileSync(path.join(projectDir, 'project.json'), JSON.stringify(project));
const report = { hardware: { cpu: os.cpus()[0].model, cores: os.cpus().length, ramBytes: os.totalmem(), node: process.version }, source, samples: [] };
function run(name, args, library = false) {
  const start = performance.now();
  const child = spawnSync(process.execPath, [path.join(root, library ? 'src/library/cli.ts' : 'src/cli.ts'), ...args, ...(library ? ['--catalog', catalog] : [])], {
    cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 ** 2, env: { ...process.env, AFCLIP_LIBRARY_HOME: catalog },
  });
  const response = JSON.parse(child.stdout || child.stderr);
  const result = response.result;
  report.samples.push({ name, ms: performance.now() - start, ok: child.status === 0,
    stats: result?.stats, jobs: result?.jobs?.map(j => ({ kind: j.kind, status: j.status, runningMs: j.runningMs, result: j.result })), error: response.error || result?.error });
  fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(report, null, 2));
  if (child.status) throw new Error(JSON.stringify(response));
  console.log(`${name}: ${report.samples.at(-1).ms.toFixed(1)} ms`);
  return result;
}
try {
  run('inspect cold', ['inspect', projectDir]);
  for (let i = 0; i < 5; i++) run('inspect warm', ['inspect', projectDir]);
  const marker = 'perf_' + Date.now();
  run('marker add', ['marker-add', projectDir, '--time', '2', '--name', 'benchmark', '--id', marker]);
  run('undo', ['undo', projectDir]); run('redo', ['redo', projectDir]);
  run('marker remove', ['marker-remove', projectDir, marker]);
  // These ranges match benchmarks/macos/project.ts: plain, dissolve, HTML title.
  for (let repeat = 0; repeat < 3; repeat++) for (const [name, start] of [['plain', 10], ['dissolve', 7.5], ['title', 2]]) {
    run(name, ['export', projectDir, path.join(output, `${name}-${repeat}.mp4`), '--mode', 'software', '--start', String(start), '--end', String(start + 1), '--verify', 'full', '--wait']);
  }
  run('frame', ['frame', projectDir, path.join(output, 'frame.png'), '--time', '2', '--mode', 'software', '--wait']);
  const videos = project.media.filter(m => m.kind === 'video').sort((a, b) => a.duration.num / a.duration.den - b.duration.num / b.duration.den);
  if (videos.length) {
    run('library import', ['import', videos[0].path, '--wait'], true);
    const asset = run('library search', ['search', '--include-inbox'], true).items[0];
    for (const state of ['cold', 'warm']) run(`source index ${state}`, ['prepare', '--ids', asset.id, '--level', 'index', '--wait'], true);
    for (const state of ['cold', 'warm']) run(`waveform ${state}`, ['waveform', '--id', asset.id, '--start', '0', '--duration', String(Math.min(30, asset.duration)), '--bins', '2048'], true);
    run('source frame', ['artifact', '--id', asset.id, '--type', 'frame', '--time', '3', '--wait'], true);
  }
} finally {
  run('close project', ['close', projectDir]);
  run('close library', ['close'], true);
}
