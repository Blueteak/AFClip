# CLI performance

## Output tokens

Both CLIs emit single-line JSON by default. `--pretty` restores indentation;
`--full` includes default-valued fields. Use both for the previous response format.
The `ok` / `result` envelope remains. HTTP responses and stored data are unchanged.

Default output omits these known values:

- Completed library response envelope: `status:"complete"`. Pending and failed states remain.
- Project inspection: `renderLock:null`.
- Clips: volume 1, mute false, speed 1/1, sourceIn/fadeIn/fadeOut 0/1,
  null linkId, empty effects/volumePoints/text, and default transform components
  x/y/rotation 0, scale/opacity 1, fit `fit`.
- Tracks and folders: disabled/locked/collapsed false and null folderId.
- Library assets and ranges: deleted/purged false, empty notes/tags/takes/
  annotationTracks/references/ranges, availability `available`, sourceStatus `verified`.

Omitted fields have the values above. IDs, revisions, pagination, non-default
values, errors and user-authored metadata remain. Use `--full` when passing output
to a consumer that requires explicit defaults or complete project objects.
`af-lib --fields` retains explicitly selected fields, even defaults.
`af-lib call` retains the complete API response.

`af-lib --wait` emits only the final response. Add `--progress` for state/phase/queue
changes on stderr. Elapsed-time-only heartbeat messages are no longer emitted.

Capture comparable outputs without modifying an existing project or catalog:

```sh
node benchmarks/cli/tokens.mjs /path/to/output.json
```

The capture includes ten samples from real disposable CLI calls and the repository
example edit. It stores old/new strings for counting with any model tokenizer.
Recorded `o200k_base` measurements are in `docs/cli-tokens.json`: 24–38% fewer tokens.
The example edit inspection falls from 26,205 to 18,107 tokens. Search falls from
252 to 156. Progress savings are additional and depend on job duration.

Full project snapshots after edits and waveform sample arrays remain substantial.
They carry useful state, so this change preserves them. Library search/overview
already use compact metadata, and waveform `--summary` remains available when
sample arrays are unnecessary.

## Latency

Run against a 1080p60 fixture built by `benchmarks/macos/project.ts`, with local sources at least 19 seconds long:

```sh
node benchmarks/cli/run.cjs /path/to/project .cache/cli-measurement
```

Requires Node 24 or newer. The destination must not exist. The script copies the edit and graphics, references original media, and uses a separate library catalog. It closes its project engine and library when finished. No user project or catalog is edited.

Measures process-inclusive inspection, markers, undo/redo, three repeated one-second software exports of plain footage, a dissolve and an HTML title, PNG rendering, library import/search, cold/warm exact frame indexing, waveforms and a frame artifact. All exports receive full decoded-frame verification. The range labels assume the Mac fixture's layout. A different edit needs corresponding range changes.

`results.json` contains hardware, elapsed command times, render statistics and job timings. MP4/PNG outputs remain beside it for comparison. The first export has cold application timestamp caches; later exports reuse them. OS caches are not flushed. Run comparisons serially, with the same Node version and source files. Export and project source `--wait` poll every 100 ms. Library waiting starts at 25 ms and backs off to 100 ms; use the recorded worker/job timings to distinguish processing from polling.

To measure repeated/skipped source frames, using the first video of an existing project:

```sh
node benchmarks/cli/speeds.cjs /path/to/project .cache/cli-speeds
```

The first video must contain at least 11 seconds. This creates separate two-second edits at quarter speed, four-times speed, and a still extracted from the same video. Each uses translation, scaling and rotation. Three exports per case receive full verification. `speeds.json` includes source upload/reuse counts; generated media remains available for exact before/after comparison.

