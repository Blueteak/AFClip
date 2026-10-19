# CLI performance

Run against a 1080p60 fixture built by `benchmarks/macos/project.ts`, with local sources at least 19 seconds long:

```sh
node benchmarks/cli/run.cjs /path/to/project .cache/cli-measurement
```

Requires Node 24 or newer. The destination must not exist. The script copies the edit and graphics, references original media, and uses a separate library catalog. It closes its project engine and library when finished. No user project or catalog is edited.

Measures process-inclusive inspection, markers, undo/redo, three repeated one-second software exports of plain footage, a dissolve and an HTML title, PNG rendering, library import/search, cold/warm exact frame indexing, waveforms and a frame artifact. All exports receive full decoded-frame verification. The range labels assume the Mac fixture's layout. A different edit needs corresponding range changes.

`results.json` contains hardware, elapsed command times, render statistics and job timings. MP4/PNG outputs remain beside it for comparison. The first export has cold application timestamp caches; later exports reuse them. OS caches are not flushed. Run comparisons serially, with the same Node version and source files. Export `--wait` polls every 500 ms. Library waiting starts at 25 ms and backs off to 500 ms; use the recorded worker/job timings to distinguish processing from polling.

To measure repeated/skipped source frames, using the first video of an existing project:

```sh
node benchmarks/cli/speeds.cjs /path/to/project .cache/cli-speeds
```

The first video must contain at least 11 seconds. This creates separate two-second edits at quarter speed, four-times speed, and a still extracted from the same video. Each uses translation, scaling and rotation. Three exports per case receive full verification. `speeds.json` includes source upload/reuse counts; generated media remains available for exact before/after comparison.
