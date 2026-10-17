# Content Library MVP

The library is a standalone local application in this repository. It shares Reelet's visual styling, media probing, frame indexing, seek-cache generation, timeline evaluator and native video presentation component. It does not require an editor project or an open Reelet window.

## Start

```powershell
npm run library:gui
npm run library:dev   # Live GUI reload during development
npm run library -- --help
node src/library/cli.ts search --kind audio
```

Node 24 and the repository's installed dependencies are required. The GUI and CLI automatically start the same headless service. Its default catalog is `%LOCALAPPDATA%\Reelet\Library`. `REELET_LIBRARY_HOME` selects another active catalog; individual CLI commands can also use `--catalog PATH`. SQLite stores annotations, identity records, project references, jobs and bounded history. Disposable artifacts live in the catalog's `cache` directory. Media stays at its original path.

`npm run library:dev` or `npm run library -- gui --dev` watches the library HTML, CSS and JavaScript plus shared Reelet styles, native preview and timeline code. It reloads after a short debounce and preserves the selected asset, filters, playhead and In/Out marks. Reload waits while annotations are unsaved, a dialog is open, playback is running, a request is in flight or an input has focus. Save your edit and move focus out of the field to apply a pending reload. Main-process, preload and service code still require restarting their processes.

The browser version uses the local URL returned by `endpoint`. The desktop version adds a native file picker, file drops, reveal in Explorer and original-file drag-out. Keep endpoint tokens local. Reelet's library browser uses a separate read-only capability and session; annotation writes through that capability are rejected by the service.

## Workflow

1. Import files or a directory into a logical home folder. Imports return before background hashing and probing finish. Exact duplicates eventually resolve to the same asset, retaining provisional IDs as aliases.
2. Choose **Prepare for review** to generate source audio, exact video frame indexes and the existing Reelet fast-seek cache. MKV/AVI video gets a container-only MP4 remux for native playback. No edited media export is created.
3. Select a source in the left Content Browser. Preview appears above its annotation timeline. Click the full-clip block for its Tags and Notes popup. Edits to names, tags and notes save automatically, including when the popover closes. CLI and GUI edits appear through the same change stream. Unsaved GUI annotations are retained when external changes arrive; saving a stale revision produces a conflict.
4. Drag across an empty annotation track to create a named range. The playhead and source preview follow the mouse while hovering or dragging over timeline lanes. With a prepared video, hover and drag starts snap to the displayed source frame. On release, the annotation is saved immediately with empty tags and notes, and its popover opens for editing. Clicking outside closes it without removing the annotation. **Delete** in the popover, or the `Del` key while hovering or selecting an annotation, removes it; Undo restores it. Hover takes priority over selection, and the shortcut does not run while typing in a field. Alternatively, mark In/Out with `I` and `O` and choose **+ Annotation**. Click a range for its Tags and Notes popup. Drag a block to move it in time or between tracks; drag its edges to trim. **+ Track** adds a track; double-click a track name or use its menu to rename, reorder, or delete an empty track. Tracks and range placement are saved in the catalog and support Undo. Video ranges store source frame indices, integer PTS and a rational time base. Audio ranges store integer sample boundaries. End boundaries are exclusive. Whole-file audio remains useful without a range.
The **Takes** track sits above the full clip. Drag to create a take immediately without opening its popover; its label is derived from timestamp order, so inserting or deleting takes renumbers later ones. Click a take to open its popover containing only optional text, saved automatically, and Delete. Takes with text show a shortened preview on the right side of the block at 50% opacity. Drag blocks or edges to move or trim; `Del` works on hovered or selected takes and Undo restores them. Each asset stores only `takes: [{start, end, text?}]`, with start/end in seconds, sorted by start then end. Names and numbers are not stored. Structured `annotate` accepts the same array; timestamps must be within the source, with distinct spans. Source replacement clears takes.

5. Search names and notes; filter by folder, media type, tag or duration. Assets and ranges appear in the results. Collections can reference either, independently of home folders.

`Space` plays/pauses, `Ctrl+Z` undoes and `Ctrl+Shift+Z` redoes. Right-click a folder or collection in the sidebar to rename, move or delete it. Use the CLI for collection membership, explicit replacement media and catalog purge.

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

`annotate` also accepts an asset `annotationTracks` array of `{id,name}` objects through structured `call` input. `range-save` accepts `trackId`; omitting it preserves an existing assignment or uses the first track for a new range. Nonempty tracks cannot be removed.

IDs and revisions come from `inspect`, `search` and `overview`. Tag assignments accept vocabulary IDs. `--tags ""` clears assignments. Video timing requires review preparation; audio boundaries use the probed source sample rate. `preview` returns authenticated local media URLs and seek/index metadata. `original` returns the original path and structured range provenance for external consumers.

| Area | Operations and fields |
| --- | --- |
| Inspection | `overview`, `inspect --id`, `search`, `original --id`, `frames --id`, `preview --id` |
| Search | `--q`, `--folder`, `--kind audio\|video`, `--tag`, `--collection`, `--minDuration`, `--maxDuration`, `--offset`, `--limit`, `--assetsOnly`, `--deleted` |
| Registration | `import PATH [--folder ID --limit N --hierarchy]`; JSON also accepts `paths: [...]`. Directory enumeration runs as a background scan job. `--wait` waits for discovery; source verification remains separate visible work. `register` is the project Inbox intake operation. |
| Source folders | `source-folders`; `source-folder-save --path PATH --folder ID [--hierarchy --watched]`; update with `--id --revision`; `source-folder-remove --id --revision`; `rescan [--id MAPPING_ID] [--wait]`. Watching scans every 15 seconds while the service runs. |
| Review artifacts | `artifact --id ID --type frame\|contact-sheet\|excerpt [--time SEC --frame N --start SEC --end SEC --width PX --count N --columns N] [--wait]`. Returns a cached path, authenticated URL and job IDs. Excerpts are limited to 60 seconds. |
| Organization | `folder-create --name --parent`; `folder-update --id --revision --name --parent`; `folder-delete --id --revision`; `move` / `promote --id --revision --folder` |
| Collections | `collection-create --name`; `collection-update --id --revision [--name --members ID,ID]`; `collection-delete --id --revision` |
| Annotation | `annotate --id --revision [--name --notes --tags]`; `range-save --assetId --revision [--id] --name` and frame/sample bounds; `range-delete --id --revision` |
| Vocabulary | `tag-create --name`; `tag-rename --id --revision --name`; `tag-merge --id --revision --target --targetRevision`; `tag-delete --id --revision --confirm clear-assignments` |
| Source lifecycle | `rescan`; `replace --id --revision --path --confirm reset-annotations`; `remove` / `restore --id --revision`; `purge --id --revision --confirm purge-catalog-record` |
| History | `history`, `undo`, `redo`, `checkpoint --name`, `checkpoints`, `checkpoint-restore --id --confirm discard-later-edits` |
| Background work | `prepare [--ids ID,ID --folder ID] [--wait]`, `jobs [--id JOB_ID]`, `cancel --id JOB_ID` |
| Cache | `cache`, `cache-budget --bytes N`, `cache-clear` |
| Project references | `references`, `retain` / `withdraw --id --projectId`, JSON `sync-project` with `projectId`, `projectPath`, `assetIds` |
| Service | `endpoint`, `gui [--id ASSET_ID]`, `close` |

Mutation batches are atomic. Existing targets require revisions; a conflicting operation rejects the whole batch. Tag revisions also cover their assignment sets, and asset revisions cover their named ranges. Inspect again after changing those relationships. Unrelated objects do not share a global edit precondition.

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

Search uses a disposable SQLite projection and trigram full-text index maintained in the same transaction as the catalog. Keyword matches use stable registration order; unfiltered browsing uses name order. Search results expose `nextOffset` and `complete`. A page marked incomplete is not the entire result set. Events carry the catalog revision; reconnecting clients refresh their view. History retains the most recent 100 operations and 10 checkpoints. Catalog purge is separate from recoverable trash and removes the asset's annotations from retained history/checkpoints, leaving a tombstone for consumers. No library operation deletes original files.

Cache eviction protects sources used by active streams, preparation jobs and recently selected previews. The GUI renews its selected preview lease every 20 seconds. Unused source artifacts remain eligible for eviction while another source is playing. Shared index entries are conservatively protected while any reader is active. Missing artifacts can be prepared again. Metadata-only edits do not regenerate them.

## Reelet integration

Reelet's normal import registers audio/video and persists library identity, source version and known locations inside the project media record. Project-bin references are reconciled through a project-owned durable outbox. Removing a timeline clip does not release its bin reference. Removing unused media from the bin does. Closing the project does neither. Promotion makes an Inbox item independent of project references.

Open **File > Browse content library**, or `Ctrl+L`, to browse, preview and add an asset or named range to the project bin. **Edit in library** opens the standalone writer. Existing project media is registered when opening this browser; CLI users can explicitly migrate it:

```powershell
node src/cli.ts library-sync PROJECT_DIR
node src/cli.ts library-import PROJECT_DIR ASSET_OR_RANGE_ID
```

The read-only browser also allows temporary In/Out marks, which are inserted without creating library annotations. CLI callers use `library-import PROJECT ASSET --selection '{"revision":N,"sourceId":"SOURCE_ID","startSample":0,"endSample":22050}'`, or `startFrame`/`endFrame` for prepared video. The selected range's exact source timing and revision are saved in media provenance. Timeline insertion fits that selection to the project's frame grid; subsequent library range edits do not change existing clips. Existing project playback/export uses its saved original paths without contacting the library. Images and graphics remain project-owned.

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

## Follow-up verification

Source-folder mappings, automatic discovery, hierarchy seeding, inspection frames, contact sheets and bounded excerpts are implemented in both interfaces. A scratch GUI session saved a watched mapping and generated a 12-frame contact sheet. A rescan discovered a duplicate location while preserving the asset's notes. Temporarily disconnecting its scratch folder left the item searchable and unavailable, with notes intact.

A stale tag deletion was rejected after its assignments changed; deletion with the current revision and undo both worked. Cache clearing reclaimed 2,014,123 unused bytes while protecting 1,395,681 bytes belonging to the selected source, with annotations unchanged. A queued preparation was cancelled. A temporary 0..22050-sample audio selection retained its 44.1 kHz boundaries when inserted into a 24 fps project. That project exported successfully with its library service stopped and its original available.

The opt-in `node benchmarks/windows/library-search.ts .temp/library-scale` benchmark builds **100,000 synthetic assets and one million ranges** in a scratch catalog. On the same development machine, tested service queries returned their first 60 results in 0.3–22.3 ms warm and 1.9–21.9 ms on newly opened SQLite connections. A common-keyword query initially took 278 ms; streaming indexed matches removed that full-result sorting cost. GUI input-to-result-card mutation measured 7.6–15.6 ms across four queries. Rapidly replacing the query displayed only the latest match. Pagination and exhaustive versus incomplete result status were checked.

These measurements do not include a flushed Windows disk cache, first-paint timing, disconnected-drive filesystem delays or concurrent hashing. The synthetic records have no playable media. Playback measurements above use actual media and the shared native preview separately. Contact-sheet and two-second excerpt generation in the scratch catalog each took roughly 0.15 seconds; long-source preparation has not been profiled.

## Current limitations

Drag asset/range cards into Reelet for structured identity and range context. **Drag original** uses Electron's native file handoff for generic Windows destinations; dragging a selected range this way hands over its whole original. **Add to Reelet** provides the explicit insertion route. Native cross-application drop acceptance remains unverified because the desktop automation tool rejected a destination outside the source window bounds. The structured card-drop handler also still needs a physical desktop drag check.

The library is an MVP, not a claim that every acceptance condition in the full overview has been measured. Full disk-cold search, search under large concurrent ingestion, long-source preparation cost and cross-application desktop drag acceptance remain follow-up validation. Images, cloud sync, managed copies, semantic search and permanent modified-media exports remain outside this release.
