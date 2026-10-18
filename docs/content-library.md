# Content Library MVP

The library is a standalone local application in this repository. It shares AFClip's visual styling, media probing, frame indexing, seek-cache generation, timeline evaluator and native video presentation component. It does not require an editor project or an open AFClip window.

## Start

```powershell
af-lib gui
npm run library:dev   # Live GUI reload during development
af-lib --help
af-lib search --kind audio
```

Node 24 or newer is required. Run `npm ci` and `npm link` from the checkout once to register `af-clip` and `af-lib` globally. The GUI and CLI automatically start the same headless service. Its default catalog is `%LOCALAPPDATA%\AFClip\Library`. `AFCLIP_LIBRARY_HOME` selects another active catalog; individual CLI commands can also use `--catalog PATH`. SQLite stores annotations, identity records, project references, jobs and bounded history. Disposable artifacts live in the catalog's `cache` directory. Media stays at its original path.

`npm run library:dev` or `af-lib gui --dev` watches the library HTML, CSS and JavaScript plus shared AFClip styles, native preview and timeline code. It reloads after a short debounce and preserves the selected asset, filters, playhead and In/Out marks. Reload waits while annotations are unsaved, a dialog is open, playback is running, a request is in flight or an input has focus. Save your edit and move focus out of the field to apply a pending reload. Main-process, preload and service code still require restarting their processes.

The browser version uses the local URL returned by `endpoint`. The desktop version adds a native file picker, file drops, reveal in Explorer and original-file drag-out. Keep endpoint tokens local. AFClip's library browser uses a separate read-only capability and session; annotation writes through that capability are rejected by the service.

## Workflow

1. Import files or a directory into a logical home folder. Imports return before background hashing and probing finish. Exact duplicates eventually resolve to the same asset, retaining provisional IDs as aliases.
2. Choose **Prepare for review** to generate source audio, exact video frame indexes and the existing AFClip fast-seek cache. MKV/AVI video gets a container-only MP4 remux for native playback. No edited media export is created.
3. Select a source in the left Content Browser. Preview appears above its annotation timeline. Click the full-clip block for its Tags and Notes popup. Edits to names, tags and notes save automatically, including when the popover closes. CLI and GUI edits appear through the same change stream. Unsaved GUI annotations are retained when external changes arrive; saving a stale revision produces a conflict.
4. Drag across an empty annotation track to create a named range. The playhead and source preview follow the mouse while hovering or dragging over timeline lanes. With a prepared video, hover and drag starts snap to the displayed source frame. On release, the annotation is saved immediately with empty tags and notes, and its popover opens for editing. Clicking outside closes it without removing the annotation. **Delete** in the popover, or the `Del` key while hovering or selecting an annotation, removes it; Undo restores it. Hover takes priority over selection, and the shortcut does not run while typing in a field. Alternatively, mark In/Out with `I` and `O` and choose **+ Annotation**. Click a range for its Tags and Notes popup. Drag a block to move it in time or between tracks; drag its edges to trim. **+ Track** adds a track; double-click a track name or use its menu to rename, reorder, or delete an empty track. Tracks and range placement are saved in the catalog and support Undo. Video ranges store source frame indices, integer PTS and a rational time base. Audio ranges store integer sample boundaries. End boundaries are exclusive. Whole-file audio remains useful without a range.
The **Takes** track sits above the full clip. Drag to create a take immediately without opening its popover; its label is derived from timestamp order, so inserting or deleting takes renumbers later ones. Click a take to open its popover containing only optional text, saved automatically, and Delete. Takes with text show a shortened preview on the right side of the block at 50% opacity. Drag blocks or edges to move or trim; `Del` works on hovered or selected takes and Undo restores them. Each asset stores only `takes: [{start, end, text?}]`, with start/end in seconds, sorted by start then end. Names and numbers are not stored. Structured `annotate` accepts the same array; timestamps must be within the source, with distinct spans. Source replacement clears takes.

5. Search names and notes; filter by folder, media type, tag or duration. Assets and ranges appear in the results. Collections can reference either, independently of home folders.

`Space` plays/pauses, `Ctrl+Z` undoes and `Ctrl+Shift+Z` redoes. Right-click a folder or collection in the sidebar to rename, move or delete it. Select an asset and use **Organize** to change its home folder or collection memberships. When a named range is selected, collection membership applies to that range; the home folder still belongs to its asset. Inbox items offer **Keep in library** before annotation. Folder and membership changes publish as one undoable batch. Organize also offers recoverable catalog removal; select an item in Trash to restore it. Use the CLI for explicit replacement media and permanent catalog purge.

The desktop library also offers **Reveal original** and **Drag original** beside the source preview. Drag original hands over the full original file even when a range is selected. Asset/range cards retain their structured AFClip drag payload. These controls are hidden in an ordinary web browser, which cannot initiate Electron's native file drag.

## CLI review and agent workflow

CLI `search` and `overview` now return compact responses by default. Search keeps IDs, revisions, media kind, duration, folders, tags, notes, availability and cached preparation state. Range results include their parent ID/name and exact boundaries. `--full` restores full source metadata; `inspect` remains detailed. `--fields id,name,revision` projects search items, or selected overview fields. Direct service requests and GUI consumers retain their previous full responses unless they request `compact:true`.

Use `search --folder inbox` for only Inbox items. `--include-inbox` searches both Inbox and the main library. The ambiguous old `--inbox` CLI flag now returns an error explaining both alternatives. Unknown options and invalid enum/numeric values fail before contacting the service. `help COMMAND`, `COMMAND --help` and `schema [COMMAND]` expose supported fields, types and revision rules. Structured `call` remains available for exact API requests.

```powershell
af-lib search --folder inbox --assetsOnly --fields id,name,revision
af-lib prepare --ids ASSET_ID --level index --wait
af-lib artifact --id ASSET_ID --type contact-sheet --start 0 --end 20 --count 8 --wait
af-lib waveform --id AUDIO_ID --summary
af-lib schema range-save
```

`prepare --level index` creates exact video frame boundaries without seek proxies or decoded audio. It enables frame-based range annotations. Audio needs only verified source metadata for sample-based ranges. Default `--level preview` retains full preparation. Cached preparation flags describe generated artifacts, not whether an original file can already play.

The single worker prioritizes verification, then review artifacts, then index preparation, then other jobs, then full previews. Jobs within each class remain FIFO. Running jobs are not interrupted. This keeps a batch of queued full previews from delaying every contact sheet; it does not promise immediate execution while a long job is active.

Contact sheets return `artifact.sourceName`, `columns`, and a `frames` manifest containing zero-based row-major `tile` indices and measured `timeSeconds` in source time. The image stays uncluttered. `--wait` merges the completed manifest into the artifact response; asynchronous callers can read it from `jobs[].result`. Cached sheets return the same manifest. There may be fewer sampled frames than requested when the source interval contains fewer frames.

`waveform --summary` omits sample arrays and defaults to 2048 bins. It returns `sourceSampleRate` for annotation sample boundaries, `decodedSampleRate` for waveform data, and peak/activity timing. Timing is approximate to `summary.timeResolutionSeconds`. Activity uses a fixed -40 dBFS peak threshold; silence returns no activity and no peak time. These are signal measurements, not semantic or musical annotations. Detailed waveform responses retain the original channel arrays and add the same summary/rate fields.

CLI responses distinguish `status: accepted`, `complete`, and `failed`. `--wait` writes progress JSON to stderr at phase changes and every two seconds, and one final response to stdout. Jobs expose queue position, enqueue elapsed time and running time. Failed/cancelled jobs produce `ok:false` and a nonzero exit code. `--timeout SECONDS` defaults to 300; timeout returns `WAIT_TIMEOUT` and job IDs without cancelling work. Import/rescan waits cover the jobs returned by that command; directory scans can enqueue separate verification work.

Batch results are ordered snapshots: each operation returns its resulting ID/revision at that point. A later operation on the same item must use the revision produced by earlier operations. Creating/changing a range also increments its parent asset revision, and tag assignment changes increment tag revisions. Inspect related objects before building another batch. The entire batch rolls back on conflict.

## CLI operations

Every GUI operation calls `/v1/command`. The CLI accepts the operation name followed by `--field value`, or exact JSON with `call request.json` / `call -`. All responses are JSON. Author defaults to `agent`; the GUI defaults to `human` and allows choosing `agent` for a GUI-driven annotation pass.

```powershell
af-lib folder-create --name SFX
af-lib import "D:\Audio Effects\Magic Spell Impacts" --folder FOLDER_ID --limit 25 --wait
af-lib search --q impact --kind audio --limit 20 --offset 0
af-lib inspect --id ASSET_ID
af-lib annotate --id ASSET_ID --revision 2 --name "Spell hit" --tags TAG_ID --notes "Candidate for ability contact."
af-lib prepare --ids ASSET_ID --wait
af-lib preview --id ASSET_ID
af-lib frames --id VIDEO_ASSET_ID
af-lib original --id ASSET_OR_RANGE_ID
af-lib range-save --assetId ASSET_ID --revision 3 --name "Contact" --startSample 0 --endSample 24000
af-lib range-save --assetId VIDEO_ASSET_ID --revision 3 --name "Opening" --startFrame 0 --endFrame 90
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

## AFClip integration

AFClip's normal import registers audio/video and persists library identity, source version and known locations inside the project media record. Project-bin references are reconciled through a project-owned durable outbox. Removing a timeline clip does not release its bin reference. Removing unused media from the bin does. Closing the project does neither. Promotion makes an Inbox item independent of project references.

Open **File > Browse content library**, or `Ctrl+L`, to browse, preview and add an asset or named range to the project bin. **Edit in library** opens the standalone writer. Existing project media is registered when opening this browser; CLI users can explicitly migrate it:

```powershell
af-clip library-sync PROJECT_DIR
af-clip library-import PROJECT_DIR ASSET_OR_RANGE_ID
```

Agents can find clips with `af-lib search --q "impact" --kind audio`, then pass a result's `id` directly to `af-clip library-import PROJECT_DIR ID`. This single import command resolves the original file and adds it to the bin, returning `result.media.id` for timeline edits. An asset ID imports the whole source; a range ID imports its saved selection. Search IDs remain stable across renames and folder moves. Follow `nextOffset` when `complete` is false. Both CLIs must use the same active catalog, selected by `AFCLIP_LIBRARY_HOME` when overriding the default.

AFClip's Media List shows current library names grouped by home folder. Search includes filenames, tags, notes, parent asset context and folder names. Hover a row for tags, notes, take counts and source details. Range rows show the saved selection duration; changed ranges, replaced sources and removed library records are flagged without changing saved project timing or paths. Metadata refreshes every five seconds and when the window gains focus. If the library is unavailable, the list retains its last metadata and project editing remains available. Older projects register audio/video in the background when the editor opens. Images and graphics stay under Project media.

In the Media List, the row tooltip shows the Library ID and the context menu offers **Copy library ID**. Temporary editorial selections offer **Copy source library ID**, since those selections are not saved library ranges. Pasting an ID into Media List search finds matching project items.

Media rows include cached video thumbnails, image previews or audio waveforms. Selecting a row opens the Source monitor, where playback and seeking are independent of the project timeline. The source view displays full-clip tags and notes, annotation ranges and takes as read-only data. Selecting an annotation seeks to its source time. Imported ranges open at their saved In point. Return to Program to view the edit; double-click or Enter in the Media List still inserts media at the timeline playhead. Graphics continue to preview on the timeline.

Audio source previews in both apps draw channel peaks and RMS levels from cached sample data at the display's pixel density. They preserve stereo channels, including opposite-phase signals. The waveform can seek independently of annotation editing. Library CLI consumers can request the same data with `waveform --id ID`, optionally supplying `--start`, `--duration` and `--bins` from 1 to 32768. Default output covers the whole source with up to 16384 bins per channel. Each channel has signed `min`/`max` and `rms` arrays; any visual gain in the viewer does not change the audio samples or playback volume.

The read-only browser also allows temporary In/Out marks, which are inserted without creating library annotations. CLI callers use `library-import PROJECT ASSET --selection '{"revision":N,"sourceId":"SOURCE_ID","startSample":0,"endSample":22050}'`, or `startFrame`/`endFrame` for prepared video. The selected range's exact source timing and revision are saved in media provenance. Timeline insertion fits that selection to the project's frame grid; subsequent library range edits do not change existing clips. Existing project playback/export uses its saved original paths without contacting the library. Images and graphics remain project-owned.

## Source monitor and CLI integration

In AFClip's Source monitor, **I** marks In and **O** marks Out. Video Out includes the displayed frame; stored end frame indices are exclusive. Audio marks use source samples. **Clear marks** or `Alt+X` returns to the bin item's saved selection. Select an annotation or take and choose **Use as In/Out** to copy its boundaries into a temporary selection. **Insert at playhead** or Enter inserts on a new track. **Edit in library** opens the standalone annotation writer.

Temporary selections stay in the monitor until insertion. Insertion saves a separate bin item with exact source timing and adds its timeline clip in one project undo step. It does not change library annotations, the original bin item or existing clips. Source In rounds up and Out rounds down to the project frame grid for placement; selections shorter than one complete project frame are rejected. New marks require the matching library source and a prepared video index. Saved bin selections remain insertable without library reads.

**Prepare source** runs library-owned background preparation directly from the Source inspector, with progress and cancellation. When it finishes, the monitor adopts the index and prepared playback resources at the same source time, retaining temporary marks. A failed source preview offers **Retry source** and preparation, so a source requiring container conversion can recover in place. Preparation reuses complete immutable artifacts and publishes new audio/container files atomically; cancellation leaves existing readers and completed artifacts intact.

The CLI uses the same source inspection, waveform implementation and insertion operation:

```powershell
af-clip source-inspect PROJECT_DIR MEDIA_ID
af-clip source-prepare PROJECT_DIR MEDIA_ID --wait
af-clip source-jobs PROJECT_DIR MEDIA_ID
af-clip source-cancel PROJECT_DIR MEDIA_ID JOB_ID
af-clip source-waveform PROJECT_DIR MEDIA_ID --start 0 --duration 2 --bins 512
af-clip source-insert PROJECT_DIR MEDIA_ID --at 2
af-clip source-insert PROJECT_DIR MEDIA_ID --at 2 --track TRACK_ID --selection '{"revision":3,"sourceId":"SOURCE_ID","startSample":11025,"endSample":55125}'
```

Use `selectionContext` from `source-inspect` for selection revision and source ID. Video selections supply `startFrame` and `endFrame` instead. Inspection includes range IDs, revisions, exact boundaries, tags, notes, takes and parent asset context. `source-waveform` reads the project's saved original and returns per-channel signed peaks and RMS data.

`source-insert` returns `result.clip` and `result.media`. A specified track must be unlocked and have room; the command never overwrites clips. For an agent pass, save `inspect.result.revisions` as JSON and pass `--preconditions FILE --fps 24`, using the inspected FPS. Otherwise the CLI reads project revisions just before insertion. Conflicts reject the entire insertion. Unrelated edits do not invalidate unchanged media and destination relationships.

Duplicate verification can resolve provisional assets to a canonical asset with another source ID. Consumers now compare verified hashes through the library contract. Identical bytes retain annotation access and selection support; changed bytes still produce a source-version warning and cannot replace existing project selections implicitly.

Scratch verification covered 44.1 kHz stereo selections and 30 fps video inserted into a 24 fps project, CLI waveform/inspection, preparation and cancellation, locked and stale destinations, stale library selections, atomic undo/redo, duplicate resolution and insertion of saved selections without library reads.

Project reference updates are persisted to `.afclip/library-outbox.json` before an edit returns and sent to the library in the background. Failed delivery retries every 15 seconds and on reopening the project. Registration first persists the previous reference set so interrupted imports can be reconciled. `af-clip library-status PROJECT` reports `pending`, `syncing`, `error` and `lastSyncedAt`; `library-sync PROJECT` registers legacy bin media and explicitly waits for reconciliation. Ordinary edits and exports do not wait for delivery. Source inspection, waveform and preparation requests also run outside the project edit queue.

`node benchmarks/windows/library-offline.ts` checks a deliberately stalled catalog, including a pending source-inspection request. On 2026-10-18, the project edit returned in 7 ms and a software export completed while delivery was stalled. Killing and restarting that scratch project's engine preserved the edit and delivered its saved references when the catalog responded again. The check uses generated audio and a local stub service; it never changes the active library.

`node benchmarks/windows/source-monitor.cjs` generates disposable media, a catalog and a project, then exercises the actual Electron editor. Add `--mkv` for a source requiring a prepared playback container. Both checks passed on 2026-10-18: an unprepared 640×360, 60 fps source gained 240 indexed frames without manually reopening; source playback left the timeline playhead unchanged; frames 30 through 90 inserted into a 24 fps project; CLI notes appeared live without changing the saved clip; one undo removed both the temporary bin selection and clip. The short playback samples reported zero dropped frames and no renderer errors. Results and a source screenshot are saved under `.temp/source-monitor/`. These are functional integration checks, not a sustained 1080p performance measurement or desktop drag acceptance check.

## Local verification, 2026-10-17

On October 17, the verification catalog contained **10 video assets and 25 SFX**, plus **two optional ranges**. All 35 assets received tags and notes through GUI controls with author `agent`. Videos were inspected in the GUI; SFX were previewed and annotated using their source labels, without claiming an acoustic analysis. Samples came from `D:\Recordings` and five packs under `D:\Audio Effects`: board-game dice, UI/menu, spell impacts, armored footsteps and impacts.

The [verification record](content-library-validation.json) stores counts, exact range boundaries and performance results. The pass created a catalog checkpoint named `Initial 35-asset GUI annotation pass`.

Verified manually:

- CLI imports and preparation, GUI preview/annotation/save-and-next, tag creation and keyword search across assets and ranges.
- Video frame range `0..90` preserves PTS `21/1000..3021/1000`. Audio range preserves samples `0..22050` at 44.1 kHz. The video range imports into a 24 fps AFClip project with its original exact timing in provenance.
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

Drag asset/range cards into AFClip for structured identity and range context. **Drag original** uses Electron's native file handoff for generic Windows destinations; dragging a selected range this way hands over its whole original. **Add to AFClip** provides the explicit insertion route. The native drag and reveal controls were restored on 2026-10-18 after the UI no longer exposed their existing bridges. Inbox promotion plus collection membership was verified through the GUI, including atomic undo/redo. Native cross-application drop acceptance remains unverified: the earlier desktop tool rejected a destination outside the source window bounds, and the current Windows capture returned blank client-area screenshots. The structured card-drop handler still needs a physical desktop drag check.

The library is an MVP, not a claim that every acceptance condition in the full overview has been measured. Full disk-cold search, search under large concurrent ingestion, long-source preparation cost and cross-application desktop drag acceptance remain follow-up validation. Images, cloud sync, managed copies, semantic search and permanent modified-media exports remain outside this release.
