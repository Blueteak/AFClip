# CLI performance

## Output tokens

Both CLIs emit single-line JSON by default. `--pretty` restores indentation;
`--full` includes default-valued fields and complete edit snapshots. Use both for
the previous response format. The `ok` / `result` envelope remains. Stored data,
GUI events and HTTP responses without an explicit `response:"changes"` request
are unchanged.

Default output omits these known values:

- Completed library response envelope: `status:"complete"`. Pending and failed states remain.
- Project inspection: `renderLock:null`.
- Clips: volume 1, mute false, speed 1/1, sourceIn/fadeIn/fadeOut 0/1,
  null linkId, empty effects/volumePoints/text, and default transform components
  x/y/rotation 0, scale/opacity 1, fit `fit`.
- Tracks and folders: disabled/locked/collapsed false and null folderId.
- Library assets and ranges: deleted/purged false, empty notes/tags/takes/
  annotationTracks/references/ranges, availability `available`, sourceStatus `verified`.
- Text fields: overridden false, value equal to default, and an empty missing list.

Omitted fields have the values above. IDs, revisions, pagination, non-default
values, errors and user-authored metadata remain. Use `--full` when passing output
to a consumer that requires explicit defaults or complete project objects.
`af-lib --fields` retains explicitly selected fields, even defaults.
`af-lib call` retains the complete API response.

Project edits return `baseRevision`, `revision`, changed `revisions`, and history.
`changes` contains new or changed objects grouped by collection, plus changed
project settings under `changes.project`. `removed` contains removed IDs grouped
by collection. `order` contains the final ID sequence for collections whose order
or membership changed. `removedRevisions` lists revision keys that disappeared.
Empty change sections are omitted. Command-specific results such as `media` and
`clip` remain available.

Changed objects replace their previous versions, with omitted defaults restored
as described above. Revision-only changes appear only in `revisions`; this avoids
repeating every media record on undo/redo. Apply those revisions to cached objects
as well. `inspect` still returns the whole project. Use it if your cached revision
does not match `baseRevision`, or use `--full` on the edit itself.

The engine computes changes inside its command queue, without an extra CLI
inspection request. An already-running engine from before this change continues
returning full snapshots until it restarts.

`af-lib --wait` emits only the final response. Add `--progress` for state/phase/queue
changes on stderr. Elapsed-time-only heartbeat messages are no longer emitted.

Capture comparable outputs without modifying an existing project or catalog:

```sh
node benchmarks/cli/tokens.mjs /path/to/output.json
```

The capture includes thirteen samples from disposable CLI calls and the repository
example edit. The example marker insertion is simulated; the small-project edits
run through the actual CLI. It stores original, first-pass and current strings for
counting with any model tokenizer. Recorded `o200k_base` measurements are in
`docs/cli-tokens.json`. The example marker edit falls from 26,264 original tokens
to 18,139 after whitespace/default culling, then 124 with changed-state output.
Small-project undo falls from 2,270 to 245 tokens. Progress savings are additional
and depend on job duration.

Full inspections and waveform sample arrays remain substantial. They carry useful
state, so this change preserves them. Library search/overview already use compact
metadata, and waveform `--summary` remains available when sample arrays are
unnecessary.

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

