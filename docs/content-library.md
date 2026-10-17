# Content Library MVP

The library is a standalone local application in this repository. It shares Reelet's visual styling, media probing, frame indexing, seek-cache generation, timeline evaluator and native video presentation component. It does not require an editor project or an open Reelet window.

## Start

```powershell
npm run library:gui
npm run library -- --help
node src/library/cli.ts search --kind audio
```

Node 24 and the repository's installed dependencies are required. The GUI and CLI automatically start the same headless service. Its default catalog is `%LOCALAPPDATA%\Reelet\Library`. `REELET_LIBRARY_HOME` selects another active catalog; individual CLI commands can also use `--catalog PATH`. SQLite stores annotations, identity records, project references, jobs and bounded history. Disposable artifacts live in the catalog's `cache` directory. Media stays at its original path.

The browser version uses the local URL returned by `endpoint`. The desktop version adds a native file picker, file drops, reveal in Explorer and original-file drag-out. Keep endpoint tokens local. Reelet's library browser uses a separate read-only capability and session; annotation writes through that capability are rejected by the service.

## Workflow

1. Import files or a directory into a logical home folder. Imports return before background hashing and probing finish. Exact duplicates eventually resolve to the same asset, retaining provisional IDs as aliases.
2. Choose **Prepare for review** to generate source audio, exact video frame indexes and the existing Reelet fast-seek cache. MKV/AVI video gets a container-only MP4 remux for native playback. No edited media export is created.
3. Preview, select vocabulary tags and add notes. **Save & next** advances through the current result page. CLI and GUI edits appear through the same change stream. Unsaved GUI annotations are retained when external changes arrive; saving a stale revision produces a conflict.
4. Mark In/Out with `I` and `O`, then save an optional named range. Video ranges store source frame indices, integer PTS and a rational time base. Audio ranges store integer sample boundaries. End boundaries are exclusive. Whole-file audio remains useful without a range.
5. Search names and notes; filter by folder, media type, tag or duration. Assets and ranges appear in the results. Collections can reference either, independently of home folders.

`Space` plays/pauses, `Ctrl+S` saves annotations, `Ctrl+Z` undoes and `Ctrl+Shift+Z` redoes. Right-click a folder or collection in the sidebar to rename, move or delete it. Use **Organize** in the inspector for collection membership, explicit replacement media and catalog purge.

## CLI operations

Every GUI operation calls `/v1/command`. The CLI accepts the operation name followed by `--field value`, or exact JSON with `call request.json` / `call -`. All responses are JSON. Author defaults to `agent`; the GUI defaults to `human` and allows choosing `agent` for a GUI-driven annotation pass.

```powershell
node src/library/cli.ts folder-create --name SFX
node src/library/cli.ts import "/path/to/media/source" --folder FOLDER_ID --limit 25 --wait
node src/library/cli.ts search --q impact --kind audio --limit 20 --offset 0
node src/library/cli.ts inspect --id ASSET_ID
node src/library/cli.ts annotate --id ASSET_ID --revision 2 --name "Spell hit" --tags TAG_ID --notes "Candidate for ability contact."
node src/library/cli.ts prepare --ids ASSET_ID --wait
node src/library/cli.ts preview --id ASSET_ID
node src/library/cli.ts frames --id VIDEO_ASSET_ID
node src/library/cli.ts original --id ASSET_OR_RANGE_ID
node src/library/cli.ts range-save --assetId ASSET_ID --revision 3 --name "Contact" --startSample 0 --endSample 24000
node src/library/cli.ts range-save --assetId VIDEO_ASSET_ID --revision 3 --name "Opening" --startFrame 0 --endFrame 90
```

IDs and revisions come from `inspect`, `search` and `overview`. Tag assignments accept vocabulary IDs. `--tags ""` clears assignments. Video timing requires review preparation; audio boundaries use the probed source sample rate. `preview` returns authenticated local media URLs and seek/index metadata. `original` returns the original path and structured range provenance for external consumers.

| Area | Operations and fields |
| --- | --- |
| Inspection | `overview`, `inspect --id`, `search`, `original --id`, `frames --id`, `preview --id` |
| Search | `--q`, `--folder`, `--kind audio\|video`, `--tag`, `--collection`, `--minDuration`, `--maxDuration`, `--offset`, `--limit`, `--assetsOnly`, `--deleted` |
| Registration | `import PATH [--folder ID --limit N]`; JSON also accepts `paths: [...]`. `register` is the project Inbox intake operation. |
| Organization | `folder-create --name --parent`; `folder-update --id --revision --name --parent`; `folder-delete --id --revision`; `move` / `promote --id --revision --folder` |
| Collections | `collection-create --name`; `collection-update --id --revision [--name --members ID,ID]`; `collection-delete --id --revision` |
| Annotation | `annotate --id --revision [--name --notes --tags]`; `range-save --assetId --revision [--id] --name` and frame/sample bounds; `range-delete --id --revision` |
| Vocabulary | `tag-create --name`; `tag-rename --id --revision --name`; `tag-merge --id --revision --target --targetRevision`; `tag-delete --id --revision --confirm clear-assignments` |
| Source lifecycle | `rescan`; `replace --id --revision --path --confirm reset-annotations`; `remove` / `restore --id --revision`; `purge --id --revision --confirm purge-catalog-record` |
| History | `history`, `undo`, `redo`, `checkpoint --name`, `checkpoints`, `checkpoint-restore --id --confirm discard-later-edits` |
| Background work | `prepare [--ids ID,ID --folder ID] [--wait]`, `jobs`, `cancel --id JOB_ID` |
| Cache | `cache`, `cache-budget --bytes N`, `cache-clear` |
| Project references | `references`, `retain` / `withdraw --id --projectId`, JSON `sync-project` with `projectId`, `projectPath`, `assetIds` |
| Service | `endpoint`, `gui [--id ASSET_ID]`, `close` |

Mutation batches are atomic. Existing targets require revisions; a conflicting operation rejects the whole batch. Unrelated objects do not share a global edit precondition.

```json
{
  "command": "apply",
  "author": "agent",
  "operations": [
    {"command": "annotate", "id": "ASSET_ID", "revision": 3,
     "tags": ["TAG_ID"], "notes": "Short setup before the action."},
    {"command": "move", "id": "ANOTHER_ASSET_ID", "revision": 2,
     "folder": "FOLDER_ID"}
  ]
}
```

Search results expose `nextOffset` and `complete`. A page marked incomplete is not the entire result set. Events carry the catalog revision; reconnecting clients refresh their view. History retains the most recent 100 operations and 10 checkpoints. Catalog purge is separate from recoverable trash and removes the asset's annotations from retained history/checkpoints, leaving a tombstone for consumers. No library operation deletes original files.

Cache eviction conservatively protects all artifacts while a job or recent preview reader is active. The configured budget is enforced when readers release those artifacts, rather than interrupting playback to reclaim space. Missing artifacts can be prepared again. Metadata-only edits do not regenerate them.

## Reelet integration

Reelet's normal import registers audio/video and persists library identity, source version and known locations inside the project media record. Project-bin references are reconciled through a project-owned durable outbox. Removing a timeline clip does not release its bin reference. Removing unused media from the bin does. Closing the project does neither. Promotion makes an Inbox item independent of project references.

Open **File > Browse content library**, or `Ctrl+L`, to browse, preview and add an asset or named range to the project bin. **Edit in library** opens the standalone writer. Existing project media is registered when opening this browser; CLI users can explicitly migrate it:

```powershell
node src/cli.ts library-sync PROJECT_DIR
node src/cli.ts library-import PROJECT_DIR ASSET_OR_RANGE_ID
```

The selected range's exact source timing and revision are saved in media provenance. Timeline insertion fits that selection to the project's frame grid; subsequent library range edits do not change existing clips. Existing project playback/export uses its saved original paths without contacting the library. Images and graphics remain project-owned.

## Local verification, 2026-10-17

The default catalog contains **10 video assets and 25 SFX**, plus **two optional ranges**. All 35 assets have tags and notes saved through GUI controls with author `agent`. Videos were inspected in the GUI; SFX were previewed and annotated using their source labels, without claiming an acoustic analysis. Samples came from `D:\Recordings` and five packs under `D:\Audio Effects`: board-game dice, UI/menu, spell impacts, armored footsteps and impacts.

The [verification record](content-library-validation.json) stores counts, exact range boundaries and performance results. A catalog checkpoint named `Initial 35-asset GUI annotation pass` preserves the completed annotation pass.

Verified manually:

- CLI imports and preparation, GUI preview/annotation/save-and-next, tag creation and keyword search across assets and ranges.
- Video frame range `0..90` preserves PTS `21/1000..3021/1000`. Audio range preserves samples `0..22050` at 44.1 kHz. The video range imports into a 24 fps Reelet project with its original exact timing in provenance.
- Two project references share one Inbox asset; first withdrawal retains it, last withdrawal hides it, undo restores the same ID, and promotion survives the final withdrawal.
- Inbox annotation is rejected. Stale batches roll back completely. An in-use tag requires confirmation, clears assignments, and undo restores them.
- A copied source resolves to the same asset with two verified locations, retaining its annotations.
- The GUI and CLI see persisted annotations after service restart.

Playback was checked separately from catalog search. The imported clips are 720p30. A disposable, uniquely animated 1080p60 test pattern in a separate scratch catalog exercised the same library GUI and native preview component. In a six-second warm interval, Chromium reported **360 presented frames over 6.010 seconds**, about **59.9 fps**, and no additional dropped frames during the interval. One startup frame was dropped before measurement. Renderer updates averaged 60.1 fps. Presentation counts use `requestVideoFrameCallback`'s cumulative `presentedFrames`; counting callbacks alone undercounts coalesced deliveries.

Across 60 deterministic prepared seeks through the library playhead control, requested-frame presentation including the next animation frame measured **16.6 ms median / 16.9 ms p95 / 17.0 ms maximum**. This is a small, prepared-source check, not a guarantee for every codec, drive or uncached source. Machine: Core Ultra 9 285K, RTX 5080, 64 GB RAM; Electron 44.8 / Chromium 152. No unrelated render workload was active.

## Remaining scope

This delivers the audio/video import, organization, annotation and preview MVP. The overview remains the full design contract. Watched source-folder discovery/mappings, directory-to-logical-hierarchy seeding, contact sheets and bounded analysis excerpts are not implemented yet. Native original-file drag-out is implemented, but cross-application Windows drop acceptance and structured native range drag-out still need validation/work; use **Add to Reelet** for range-aware insertion.

The 100,000-asset / one-million-range target has not been benchmarked. Search currently uses SQLite JSON predicates and paginated inspection; this is not a claim that the target-scale 50 ms acceptance criterion is met. Concurrent object edits are revision-checked, while broad vocabulary changes operate on their current assignments inside one transaction. Fine-grained relationship preconditions for every bulk operation remain follow-up work. Cache budgeting is conservative around active readers, and preparation cost for long sources has not been profiled.
