# Editing prototype

This is the first usable project-engine slice, not the complete [MVP](../Reelet-MVP-Overview.md). It follows the independent Node engine and worker architecture in the [Technical Overview](../Reelet-Technical-Overview.md).

The first complete edit is exported locally at `exports/sample-first-edit.mp4`: 64 seconds, 1920 by 1080, 30 fps, H.264 and stereo 48 kHz AAC. It contains eight gameplay shots, seven dissolves, two animated titles, a music bed and four supplied sound effects. The project remains editable in `/path/to/project`.

## Run it

Use Node 24 and `npm ci`. Dependencies pin Electron, FFmpeg and ffprobe; a separate FFmpeg installation is unnecessary.

```powershell
node src/cli.ts --help
npm start -- /path/to/project
node src/cli.ts inspect /path/to/project
node src/cli.ts export /path/to/project exports/sample-first-edit.mp4 --mode gpu --wait
```

The supplied example is a 64-second Sample edit assembled from local gameplay, a music bed, sound effects and two animated HTML graphics. Its source paths belong to this PC. `npm run edit:example` imports those sources and commits the timeline through engine commands. It takes a starting checkpoint and refuses to replace a project that already contains clips.

The GUI displays the media bin, checkpoints, tracks, clips and dissolves. You can import media and graphic folders, drag media onto tracks, move, trim, stretch, split, copy, paste and delete clips, add and adjust dissolves, edit clip timing, audio and transforms in the inspector, change sequence resolution and frame rate, rename, disable or lock tracks, undo/redo, create or restore checkpoints, play and scrub the timeline with synchronized audio, render a full-resolution frame, export the sequence or an In/Out range, cancel and play the finished MP4. Each action has a keyboard shortcut shown in menus and tooltips; `?` lists them all. Edits are built from the latest project state and carry its revisions, so a conflicting CLI or agent batch is rejected rather than overwritten. CLI changes arrive live through the same engine. Closing the GUI leaves an active export running.

The program monitor now keeps a persistent preview worker. Space plays or pauses, and dragging either ruler updates the picture while scrubbing. Playback follows the mixed audio clock; slow picture rendering skips frames. Seeking and pause settle on the requested project frame. Live preview does not lock edits. Enter still runs a full-resolution inspection job and briefly locks edits. Preview and export share source timestamp indexes, composition rules, deterministic graphics, and audio mixing. See [continuous playback](timeline-playback.md) for behavior, measurements, and limitations.

## Create and edit through the CLI

```powershell
node src/cli.ts create .cache/my-edit --name "My edit" --width 1920 --height 1080 --fps 30
node src/cli.ts import .cache/my-edit "/path/to/media/source"
node src/cli.ts checkpoint .cache/my-edit --task "First rough cut"
node src/cli.ts inspect .cache/my-edit
```

Commands return JSON with `ok` and either `result` or a structured `error`. Inspection includes the manifest, object and relationship revisions, undo/redo counts, and any rendering lock. Media imports return the stable imported media ID. Normal imports reference originals; graphic imports copy editable assets into the project.

Edits are atomic batches. Save a JSON file and pass it to `node src/cli.ts apply <project-dir> <batch.json>`. This example adds one track and a four-second clip. Replace `IMPORTED_MEDIA_ID`, and use current revision values from inspection:

```json
{
  "preconditions": {
    "order:tracks": 0,
    "track:gameplay": 0,
    "occupancy:gameplay": 0,
    "clip:opening": 0,
    "media:IMPORTED_MEDIA_ID": 1
  },
  "operations": [
    { "op": "put", "collection": "tracks", "value": {
      "id": "gameplay", "name": "Gameplay"
    } },
    { "op": "put", "collection": "clips", "value": {
      "id": "opening", "trackId": "gameplay", "mediaId": "IMPORTED_MEDIA_ID",
      "start": { "num": 0, "den": 1 },
      "duration": { "num": 4, "den": 1 },
      "sourceIn": { "num": 1, "den": 1 }
    } }
  ]
}
```

`put` patches supplied fields of an existing object or creates a new object. Supported collections are `media`, `tracks`, `clips` and `transitions`. `remove` takes a collection and ID. A project operation accepts `name`, `resolution` or `fps` and requires the current `project` revision:

```json
{ "op": "project", "value": { "fps": { "num": 30000, "den": 1001 } } }
```

Include inspected revision keys for objects the batch depends on. New IDs and previously absent relationship keys have revision zero. The engine checks required keys rather than rejecting every intervening project edit. Missing or stale dependencies return `CONFLICT` with the affected keys and actual revisions. Nothing in a rejected batch is committed. The caller rereads and decides whether to retry.

Times are integer fractions `{num,den}`. CLI time arguments accept decimal seconds or fractions such as `1001/30000`. Changed clip times must fall on the current project-frame grid. Changing the project frame rate preserves existing time fractions. Clip speed is a positive fraction, defaults to one, and changes both picture speed and audio pitch. Changing speed does not automatically choose a new duration; supply the intended duration in the same batch.

Clips default to volume one, unmuted, no fades, source-in zero and Fit. Optional transforms are `x`, `y`, `scale`, `rotation`, `opacity` and `fit: "fit" | "fill"`. Position offsets are pixels from the centered layout. Fade durations use project seconds. Higher tracks composite over lower tracks. Disabled tracks hide and silence their content. Locked tracks reject changes until explicitly unlocked.

Same-track clips must not overlap. A dissolve references adjacent clips by `fromClipId`, `toClipId` and `trackId`, with a rational `duration` and `alignment` of `center`, `start` or `end`. It consumes source handles around the existing cut and preserves timeline length. Insufficient handles cause a validation error with the available amount, rather than frozen frames or a moved cut.

## Timeline markers

Press **M** to create a marker immediately at the playhead with a default name. Right-click empty ruler space and choose **Add Marker** to create one at that time. **Shift+Up** goes to the next marker; **Shift+Down** goes to the previous marker. Click a ruler flag to seek, drag it to move, or right-click or double-click to edit its name and time in a popup above the flag. Delete removes the selected marker; Escape cancels a drag or dismisses the popup. Clip moves and trims snap to markers, with Alt bypassing snapping. Adding a marker selects it without opening the editor.

Named markers belong to the sequence and have stable IDs shared by the GUI and CLI. They save with the project and participate in shared undo/redo and checkpoints. Existing projects without a marker array open with no markers. Markers may sit beyond the last clip to plan future edits, but do not extend playback or export duration.

```powershell
node src/cli.ts marker-add .cache/my-edit --time 4 --name "Music hit" --id music_hit
node src/cli.ts markers .cache/my-edit
node src/cli.ts marker-set .cache/my-edit music_hit --name "Title entrance" --time 5
node src/cli.ts marker-next .cache/my-edit --time 2
node src/cli.ts marker-previous .cache/my-edit --time 6
node src/cli.ts marker-remove .cache/my-edit music_hit
```

Navigation returns the nearest marker strictly after or before the supplied time, or null at the end. Listing orders markers by time and then ID; multiple markers may share a time. Names must contain non-whitespace text and be at most 256 characters. Marker creation and explicit time edits must land on the project frame grid. Changing project FPS preserves existing marker times in seconds.

Agents can include markers in ordinary atomic `apply` batches. Use `collection: "markers"` and `put` values containing `id`, `name`, and `time`, or `remove` with an ID. New markers need `"marker:ID": 0` in the preconditions. Existing edits require the inspected `marker:ID` revision, and time changes also require the inspected `project` revision. The inspection response includes marker objects and revisions. Track locks do not prevent standalone marker edits.

Disposable engine and GUI checks covered marker creation, dragging, naming, navigation, Delete, cancellation, CLI changes appearing live, ripple boundaries, undo/redo, persistence, checkpoints, and preservation of exact times after FPS changes.

Ripple delete removes markers inside its half-open range and shifts markers at or after its end earlier by the deleted duration. Markers before the range remain fixed. Undo restores both clips and markers in one step.

## Ripple delete

Mark In and Out with I and O, then press Shift+Delete or choose **Edit > Ripple delete In/Out range**. Out includes its frame, matching range export. Right-click an empty section of a track and choose **Ripple delete gap across all tracks** to remove that gap. The gap must have a later clip on that track; trailing empty space is not a gap. Both routes cut across every track, including disabled tracks, and close the removed time in one shared undoable edit. Affected locked tracks reject the whole operation; locked tracks entirely before the range do not block it.

```powershell
node src/cli.ts ripple-delete .cache/my-edit --start 3 --end 5
```

CLI ranges are half-open: this removes 3 seconds up to, but not including, 5 seconds. Both boundaries must land on the project frame grid. Use `--revision N` to require an inspected project revision; without it the CLI reads the revision immediately before submitting. Concurrent project changes reject the entire edit.

The same action works through `apply` as the only operation in a batch:

```json
{"preconditions":{"project":12},"operations":[{"op":"ripple-delete","start":{"num":3,"den":1},"end":{"num":5,"den":1}}]}
```

Clips inside the range are removed. Spanning clips become adjacent pieces that retain the surviving source sections, speed, transforms and source-timed volume points. Newly cut edges have no clip fade; existing outer fades clamp to the remaining piece. Later clips shift earlier by the range length. Source offsets remain exact even at fractional speeds. Dissolves intersecting the removed time are removed; unaffected dissolves retain their settings and follow surviving pieces. This action does not create a transition at the new cut. Sequence markers follow the same ripple edit.

A disposable edit checked CLI and GUI range deletion, gap deletion, source offsets at half speed, disabled tracks, dissolve preservation, shared undo/redo, and atomic rejection for locked tracks or stale revisions. Its 9.3-second software export passed full verification with 279 frames.

## Push clips to crossfade

Drag one clip horizontally toward its neighbour on the same track. It stops at the cut; continue more than eight screen pixels past contact to preview a crossfade, then release to commit. The attempted overlap sets its duration, clamped to available source handles and room beside existing transitions. Pull back below the threshold to remove the pending fade, or press Escape to cancel the whole drag. If no source handles are available, the clip stops at the cut without adding a transition.

The move and transition are one shared undoable batch. The cut stays at the contact position; overshooting does not shorten the sequence or overlap the stored clips. Audio clips crossfade, visual clips dissolve, and combined clips do both. Pushing an already joined pair adjusts its existing transition. Multi-clip and cross-track moves retain their ordinary collision rules. CLI callers can create the same result in one `apply` batch containing the clip placement and transition `put` operations.

A disposable GUI edit verified both directions, one-step undo, pulling back, Escape, and a half-second overshoot clamped to a 0.2-second transition by source handles.

## Timeline audio controls

Audio and combined video/audio clips show a waveform below their name. Drag the yellow horizontal line up or down to change clip volume, from silence to +24 dB. Drag the small handles at the top of the waveform left or right to set fade-in and fade-out durations. The inspector remains available for precise values. Fades on combined clips affect both picture and sound, matching the existing clip fade behavior.

Each completed drag commits one shared, undoable edit. Escape or pointer cancellation discards the preview. Locked tracks block the controls, and a concurrent change to the clip rejects the drag's commit. Waveforms reflect volume, mute and Ease In/Out fades; trimming and stretching request the corresponding source section. Preparation runs asynchronously through FFmpeg with bounded peak data and an in-memory cache. Unavailable audio shows a waveform error without blocking editing. The cache is disposable and does not require the library service.

CLI callers use the same existing clip fields through `apply`, with current inspection preconditions:

```json
{"op":"put","collection":"clips","value":{"id":"CLIP_ID","volume":0.5,"fadeIn":{"num":1,"den":1},"fadeOut":{"num":1,"den":1}}}
```

This sets approximately -6 dB and one-second Ease In/Out audio fades. Fade lengths use timeline time and clamp when the clip is shortened. Audio fades use a smoothstep curve with a gentle start and finish; picture fades remain linear. The audio fade shading rises with volume to form a hill. Volume automation points are supported; adjustable fade shapes are deferred beyond MVP.

Ctrl/Cmd-click the audio envelope to add a volume point, drag a point to adjust its time and level, and press Delete to remove the selected point. Escape cancels an unfinished gesture. Point gain multiplies the overall clip volume, and fades apply over that result. The envelope and waveform show the audible level. Each completed gesture is one shared undoable edit.

CLI callers set `volumePoints` through the same clip `put` operation:

```json
{"op":"put","collection":"clips","value":{"id":"CLIP_ID","volumePoints":[{"time":{"num":0,"den":1},"value":1},{"time":{"num":1,"den":1},"value":1},{"time":{"num":3,"den":2},"value":0.25},{"time":{"num":5,"den":2},"value":0.25},{"time":{"num":3,"den":1},"value":1}]}}
```

Point times are absolute source seconds, not project time or offsets from the clip start. They must be unique, increasing integer fractions within the source duration. Values are linear gain multipliers from 0 to 16; 1 leaves the clip volume unchanged and 0.25 ducks it by about 12 dB. Up to 1024 points are supported per clip. Gains use smoothstep Ease In/Out between points, with a gentle start and finish on each segment. Exactly one explicit point gets temporary anchors at both clip edges with gain 1, so moving it changes a local dip or peak. These dim anchors cannot be dragged and are not stored. Adding a second point removes them; deleting back to one restores them. An explicit point at a clip edge replaces the helper there. Two or more explicit points hold their nearest endpoint values outside their span. Removing the last point removes the helpers too. An absent or empty array applies no automation; set `volumePoints: []` to clear it. Trimming hides points outside the selected source section without deleting them. Single-point helpers follow the current clip edges; a lone point trimmed outside the clip has no audible effect until it is revealed again. Splitting copies the source envelope to both pieces, and stretching changes when points play while preserving their relationship to source sounds. Preview and export evaluate automated gain per audio sample. A disposable four-second edit verified point insertion, dragging, Delete, undo and Escape in the running editor, plus preview-session retention after a point edit. Its software MP4 passed full verification with 120 frames; preview measured the intended 0.25 ducking gain and exported AAC measured 0.2495 to 0.2507. Source-relative evaluation also matched after trim, split and speed changes.

Volume, volume-point, mute, fade edits and audio-only clip moves refresh the mixed preview audio without replacing the video session. Moving audio between tracks or beyond the previous sequence end updates its placement and the mix duration while retaining the video preview. Native video elements, decoded-frame caches and prepared seek proxies stay available; visual fades update composition opacity using the same source frames. The monitor reports **Updating audio** during the remix. Undo and redo use the same path. Visual source, timing and other composition changes still rebuild the preview. GPU and software checks covered session retention, rapid edits, undo, refreshed volume levels and silent muted output; the GPU check also verified video-element/frame-cache identity and fade opacity.

A disposable four-second audio project verified handle gestures, volume dragging, cancellation, undo/redo, external-command updates and locked tracks. Its software export passed full verification with 120 frames; sampled decoded audio gains agreed with the volume/fade envelope within 0.025 absolute gain. A synthetic stereo source verified source-section peaks at 0.2 and 0.8, including opposite-phase channels. These checks did not modify the example project.

## Render and inspect

```powershell
node src/cli.ts frame .cache/my-edit exports/frame.png --time 2 --mode gpu --wait
node src/cli.ts export .cache/my-edit exports/section.mp4 --start 1 --end 3 --mode gpu --wait
node src/cli.ts status .cache/my-edit
node src/cli.ts cancel .cache/my-edit
node src/cli.ts export .cache/my-edit exports/software.mp4 --mode software --wait
```

Without `--wait`, export/frame return a job ID immediately. Status can inspect that ID. `--wait` returns the final job and exits nonzero if it failed or was cancelled. Logs and job records live under `.reelet/jobs/<job-id>/`.

Every render holds the engine's editing lock, including single-frame and short-section renders. Rendering happens in a separate Node worker with Electron/FFmpeg children. A failure releases the lock while preserving committed project state. Cancellation signals the worker, stops its child processes and removes the partial output. Completion renames a temporary output beside the destination, preserving any previous completed output until the new file is ready. Output paths cannot replace imported media or accepted/editable graphic assets.

GPU export uses Chromium shared textures, D3D11 color conversion and NVENC. It currently requires Windows x64 and compatible NVIDIA hardware. The first native build needs Visual Studio C++ Build Tools and a Windows SDK. It downloads a pinned, checksum-verified NVENC header into the local cache. This is development tooling, not a packaged installer. Software mode uses CPU composition and x264. Both encoders disable B-frame reordering so the raw H.264 mux path can assign presentation timestamps without losing range boundary frames. A three-second software section completed with all 90 frames, titles and mixed audio. GPU failure offers a fresh software restart; it never silently changes encoder halfway through a job.

Both modes decode original media with FFmpeg on the CPU. Each live clip has a reusable decoded RGBA frame buffer, with stream backpressure and a default 256 MiB active-frame budget. No whole-clip RGBA files are written. That budget covers the retained decoder frames, not all FFmpeg, Chromium, GPU, timestamp-index or process memory. The worker records decoding/rendering statistics with the result. Inactive canvases release their backing buffers. Timestamp indexes use a separate 64 MiB disk cache keyed by source path, size and modification time. Large intermediate media, graphic job snapshots and Chromium job profiles are removed after each job.

The renderer supports even output dimensions up to 4096 pixels per side. Video currently requires tagged limited-range BT.709 SDR. HDR is rejected on import; other unsupported color tags fail explicitly at render. Audio is mixed offline from original media with volume, mute, fades, dissolves and speed changes, then encoded to AAC alongside H.264 video. There is no live speaker recording.

## Graphic assets and history

```powershell
node src/cli.ts import .cache/my-edit path/to/title-folder --kind graphic
node src/cli.ts undo .cache/my-edit
node src/cli.ts redo .cache/my-edit
node src/cli.ts checkpoints .cache/my-edit
node src/cli.ts restore .cache/my-edit latest --confirm discard-later-edits
```

A graphic folder needs `index.html`. Import copies it into `graphics/<media-id>`. The imported media's `metadata.authoringPath` identifies that editable folder, while `media.path` points to the accepted immutable version. Edit the authoring folder. The engine observes stable saves, accepts them as undoable changes and queues acceptance while rendering holds the lock. Export uses accepted assets, including a separate job snapshot. Assets are capped at 128 MiB per graphic and symlinks are rejected.

Graphics run in sandboxed iframes without Node APIs or network access. They receive a `postMessage` containing `{type:"reelet-render",requestId,time}`. Render the supplied source time, await assets, and respond with `{type:"reelet-ready",requestId}` or `{type:"reelet-error",requestId,error}`. Each requested time must produce a complete state independently of previous calls. The example graphics demonstrate this contract. The default logical canvas is 1920 by 1080; metadata can specify `logicalWidth` and `logicalHeight`. The compositor scales that canvas to fit the output.

The engine waits for the readiness response and fails if it times out. Broken graphics currently block export; the MVP's explicit omit-broken-graphic override is not implemented. This is a local authoring prototype, not a fully audited hostile-code execution service.

Undo/redo share one chronological session history across GUI and CLI, capped at 100 edits or batches. New edits clear redo. The project daemon survives sequential commands, exits after five idle minutes without a subscriber or active render, and can be closed with `node src/cli.ts close <project-dir>`. Exit ends ordinary undo history.

Checkpoints persist across restarts and retain the latest five. They copy project state and graphic code, while referencing source media. Restore requires the explicit confirmation shown above because it discards later edits, newer checkpoints and ordinary undo/redo history. It does not create another checkpoint first.

## Local protocol and files

`node src/cli.ts endpoint <project-dir>` returns the local `/v1` HTTP endpoint and bearer token. The GUI keeps that token in its main process. `GET /inspect`, `POST /command` and `GET /events` share engine state; SSE emits `hello`, `change` and `job` events. The engine binds only to `127.0.0.1` and rejects browser origins. Keep the token local.

`project.json` is the readable authoritative manifest. Accepted changes save by writing and flushing a temporary file, then renaming it over the manifest. Do not edit the manifest directly while its engine is running. `.reelet/` contains daemon coordination, accepted graphic versions, bounded checkpoints, render jobs and logs. The project folder currently references source media and is not a Collect-project bundle.

## Manual validation and remaining scope

Manual engine checks covered persistent ownership across calls, stale batch rejection, atomic failure, undo/redo, source import, transition source handles, unchanged clip times after an FPS change, track locking, graphic hot reload and graphic history, and checkpoint confirmation/restoration.

A separate disposable project verified cancellation during source indexing: the render lock rejected an edit, cancellation released it, an existing valid MP4 retained its exact SHA-256, and no partial output remained. A second cancellation after the software encoder's first rendered frame also released the lock, removed partial output and preserved the previous MP4. A missing-source worker failure left the daemon PID unchanged, released the lock and allowed a subsequent edit. These checks did not interrupt the example project. The actual GUI also passed a CLI rename/undo over SSE and a GUI volume edit/undo through the shared engine. The temporary edits were restored before export.

The rest of the MVP is still open: folders, linked audio detach, Content Library integration for reusable selects, video barcodes, collection/relink UI, complete GUI coverage of CLI operations, and packaging. The [Content Library overview](../content-library-overview.md) defines the planned standalone library and ownership boundary; the prototype still uses project-local media and caches. Fresh long-edit performance targets have not been agreed. Frame selection uses integer presentation timestamps and the stream time base. A manual VFR check covered 15 requested times, including 100 ms holds and exact 30 fps boundaries, plus six sequential frame reads. Every sampled frame matched its known gray identifier within one level. This caught and corrected a one-frame error caused by FFprobe decimal timestamp rounding. The 90-frame fixture reused its index in 1.33 ms versus 39.1 ms to generate it.

## First edit measurements

These are the initial implementation's measurements. The faster indexing section below records the subsequent improvement.

On the same Core Ultra 9 285K / RTX 5080 / 64 GB Windows system, the cold full export rendered 1,920 frames in 76.73 seconds, or 25.02 fps. Including first-time source indexing, audio preparation, muxing and verification, it took 326.77 seconds. This includes streaming HEVC source decoding and is not directly comparable to the earlier benchmark with predecoded media. The final revised edit reused all eight timestamp indexes and completed in 101.96 seconds end to end, with 78.19 seconds of rendering at 24.56 fps. These are individual runs, not a statistical benchmark. Full timings are recorded in [first-edit-results.json](first-edit-results.json).

Peak retained decoded-frame memory was 28.125 MiB with two active decoders during dissolves. Sampled Chromium process working sets peaked at 695.7 MiB. The latter excludes FFmpeg workers, driver/GPU allocation and other processes. No raw-frame disk cache or full-frame GPU readback was used. The readiness token is below the picture and cropped out of the export.

The completed first export had exact 64-second video/audio stream durations and 1,920 video frames. Decoded audio measured -23.2 dB mean and -4.4 dB sample peak. A 500 ms music correlation sample at project second 5 matched source second 4 with zero sample offset, correlation 0.998. This checks the intended one-second music placement, not every possible synchronization case. Audio selection used the supplied library names, metadata and waveform levels; it has not been auditioned by ear.

Visual checks covered the opening title, dissolve, eight shot samples, closing title and final fade. One wall-obscured source selection was replaced with a later arena pan, then the whole edit was exported again. CPU and GPU closing-title samples at the same project time agreed visually, with SSIM 0.9852 after their different encoders. The three-second software section took 5.62 seconds end to end with a cached index.

## Faster first exports

The original indexer used FFprobe `-show_frames`, decoding every source in full to collect timestamps. For this edit that meant processing 275.57 seconds of 1440p60 HEVC before rendering the selected 64 seconds. Log creation times put that preparation stage at approximately 226 seconds. This was avoidable work in the first implementation.

The indexer now uses `-show_packets` for AVC/HEVC samples in MOV/MP4, sorts integer PTS into presentation order, and converts them with the stream time base. It requires recognized codec tags, matching declared sample counts, complete PTS/DTS, increasing DTS, unique PTS, an opening keyframe and matching start time. Interlaced streams, discard/corruption flags and unsupported/ambiguous layouts use the existing decoded-frame fallback. It does not assume a constant frame rate or use DTS as presentation time. FFmpeg documents [packet and frame inspection separately](https://ffmpeg.org/ffprobe.html), and [packet PTS is presentation time in stream time-base units](https://ffmpeg.org/doxygen/5.1/structAVPacket.html).

A fresh full export with zero timestamp-cache hits indexed all eight sources in **0.929 seconds** and completed in **102.11 seconds**, versus **326.77 seconds** for the original cold export. Rendering itself took 77.50 seconds; indexing is no longer the bottleneck. These are individual measurements on the same PC, with application indexes cold but the OS filesystem cache not flushed.

All 16,526 source timestamps exactly matched the prior decoded indexes. The 90-frame VFR fixture also matched exactly, and manual checks confirmed malformed timing/layouts reject the fast path and invoke the decode fallback. The new complete MP4 has the same SHA-256 as the prior revised edit: the output is byte-for-byte identical. [Measurements and parity evidence](indexing-performance.json) include the per-source timings and hashes. Those measurements still included full decoded-frame-count verification. The next change reduces that cost separately.

## Output verification

MP4 exports now default to `--verify quick`. Before publishing the finished file, the worker checks H.264/AAC streams, dimensions, frame rate, zero start times, video packet count, packet flags, continuous presentation timestamps, stream durations, and stereo 48 kHz audio coverage. This relies on our encoders producing one video packet per frame without B-frame reordering. AAC priming is allowed before time zero. MP4 duration rounding gets a 1 ms allowance at the final video packet; ordinary frame timestamps remain checked against the video time base.

For a decoded-frame check, choose **Thorough** verification in the Export dialog or use:

```powershell
node src/cli.ts export /path/to/project exports/sample-first-edit.mp4 --verify full --wait
```

Full mode performs the quick checks, then decodes the output to confirm the expected video frame count and nonempty decoded audio. Quick mode does not decode compressed picture/audio payloads, so it cannot detect every damaged bitstream. Neither mode judges the edit's visual quality or sound by ear. Review the finished export for those. Both modes finish before the temporary MP4 replaces the requested destination, and cancellation remains available during verification. Job statistics record the mode, packet counts, decoded frame count when requested, and elapsed verification time.

On the existing 64-second edit, quick verification took **0.139 seconds**, versus **21.551 seconds** with full decoding. A new GPU export completed in **87.162 seconds**, including 84.699 seconds of rendering and 0.136 seconds of verification, with all eight source indexes cached. Its SHA-256 matched the previous edit exactly. Rendering speed varies between runs; the direct verification comparison isolates the work removed.

Manual checks also covered a three-second software export with full verification, a nine-frame 30000/1001 fps MP4, and rejection of missing frames/audio, incorrect dimensions/timestamps, discarded video packets and audio gaps. The editor checkbox was inspected in a captured window. [Recorded results](output-verification-results.json) contain the timings and output hash. No always-run test suite was added.
