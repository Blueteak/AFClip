# CLI performance

## Repeated editing

See [the editing-loop measurements](../../docs/cli-edit-loop.md) for repeated
inspection, mutations and library queries. Keep returned revisions and changes,
use focused inspection, and combine related edits into an atomic `apply` batch
when they belong to one undo step. This avoids process launches and repeated
project saves without weakening conflict checks.

CLI entry points enable Node's module compile cache before loading command code.
Set `NODE_DISABLE_COMPILE_CACHE=1` to disable it. This does not cache responses or
project state, and command output contracts are unchanged.

## Output tokens

The goal is the fewest tokens per completed task, with enough information for the
next action. Omit expected defaults and unchanged state; preserve IDs, revisions,
exact boundaries, pagination, warnings and errors. Keep diagnostics accessible,
avoid cryptic abbreviations, and measure output with a named tokenizer. Smaller
responses that force repeated discovery calls are not an improvement.

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
- Jobs: null queuePosition; completed progress 1 and phase Ready/completed.
  Completed artifact job results omit fields already present in `artifact`.

Omitted fields have the values above. IDs, revisions, pagination, non-default
values, errors and user-authored metadata remain. Use `--full` when passing output
to a consumer that requires explicit defaults or complete project objects.
`af-lib --fields` retains explicitly selected fields, even defaults.
`af-lib call` retains the complete API response.

Default media metadata summarizes FFprobe streams and format: codecs, dimensions,
pixel/audio format, time base, frame rates, duration/start time, frame count,
color, disposition, tags and side data remain. Ancillary diagnostics are available
with `--full`; this summary is not a complete probe record.

`source-inspect` and library `preview` replace full PTS arrays with `frameCount`
and `timing.first`/`timing.last`. Explicit `--start-frame N --frame-count N` returns
stored timestamps. `af-clip source-frames` and `af-lib frames` return exact ticks
and their time base, with 120 entries by default and a 10000-entry limit per page.
Continue at `nextFrame`; null means the final page. `--full` without a window
returns the whole index. Empty/unprepared indexes reject window requests.

`af-clip inspect --id ID` or `--collection NAME` returns selected items, project
settings and relevant revision keys. `--since REVISION` instead returns changes
from retained undo/redo history; it cannot be combined with filters. Expired
history returns `HISTORY_UNAVAILABLE`, requiring a fresh inspection. Full output
does not cancel explicitly requested filters or windows.

Top-level help is a command index. `help COMMAND` includes its usage and contract;
`help all` retains the full reference. Library `schema` remains machine-readable.

Project edits return `baseRevision`, `revision`, changed `revisions`, and history.
`changes` contains new or changed objects grouped by collection, plus changed
project settings under `changes.project`. `removed` contains removed IDs grouped
by collection. `order` contains the final ID sequence for collections whose
existing order changed or whose additions were not appended at the end.
`removedRevisions` lists revision keys that disappeared.
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
run through the actual CLI. It stores original, compact snapshot and current strings for
counting with any model tokenizer. Recorded `o200k_base` measurements are in
`docs/cli-tokens.json`. The example marker edit falls from 26,264 original tokens
to 18,139 after whitespace/default culling, then 124 with changed-state output.
Current example inspection is 15,327 tokens versus 26,205 originally. Top-level
help is 180 tokens for af-clip and 178 for af-lib, down from 1,489 and 707.
Progress savings are additional and depend on job duration.

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

