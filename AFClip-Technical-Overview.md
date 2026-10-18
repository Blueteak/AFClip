# AFClip Technical Overview

AFClip targets Windows first. The [MVP Overview](AFClip-MVP-Overview.md) defines product behavior; this document records the agreed architecture and the prototype needed to validate it. These are implementation decisions, not claims that the editor already exists.

## Architecture

### Project engine

Use TypeScript on Node.js for project state, command validation, transactions, conflict detection, history, persistence and render-job coordination. Keep this engine independent of Electron and browser APIs. Frame processing and audio processing belong in separate workers.

One background process owns each open project. GUI and CLI send commands through the same versioned, machine-local protocol, with structured responses and change subscriptions. The CLI starts the process when needed without opening a window. Electron is the desktop GUI, not the project engine.

The process stays alive while a GUI, CLI operation or render needs it, then exits after a short idle period. Sequential CLI calls share ordinary undo history while that process remains alive. Its exit ends the editing session; persistent checkpoints remain available.

The TypeScript choice is provisional until the prototype demonstrates responsive command handling alongside media work. Runtime validation is required for incoming commands and project data; TypeScript types alone do not validate external input.

### Rendering workers

Put decoding, graphic rendering, frame composition, audio mixing and encoding behind a separate rendering interface. A worker failure must not take down the project engine or lose committed edits. Report the failed operation and restart the worker for subsequent requests.

Provisionally use Chromium for HTML/CSS composition, sharing composition code and browser-engine version between preview and export. Chromium runs as part of the rendering backend without requiring the Electron GUI. The backend remains replaceable without rewriting project operations.

Graphic text uses stable `data-afclip-text` IDs on static plain-text HTML elements. The project stores per-clip `text` overrides separately from graphic source. GUI and CLI submit revision-checked edits through the shared engine. A sandbox-local bridge applies the same values during native preview and Chromium export; editing controls are enabled only in the GUI preview. Source animation continues to use explicit AFClip time. Field elements must remain stable and must not generate or replace their own text. Embedded code editing and arbitrary source rewriting remain out of scope.

Bundle pinned FFmpeg and ffprobe builds for inspection, conversion and export. Users should not need to install them separately. Keep their command syntax inside the worker implementation. The precise decoding, capture and GPU frame-transfer paths remain subject to prototype results.

### Content Library and shared media infrastructure

The standalone [Content Library](content-library-overview.md) lives in this monorepo and owns reusable video/audio asset identity, source versions, annotations, ranges and organization. Its headless service, GUI, CLI, state and history remain separate from AFClip's project engine. Both applications share media processing code as workflows require it.

Use versioned local operations and change subscriptions across the application boundary. Neither application accesses the other's database internals. AFClip may register sources and retain or withdraw durable project-bin references; it cannot author library annotations or folders. Inbox lifetime and promotion are enforced by the library. Registration and project insertion are separate transactions with idempotent, retryable reconciliation, including failed insertion and project undo.

Persist library provenance, source-version identity, usable source locations and selected source timing in AFClip projects. Existing edits remain playable and exportable without the library service if their originals are present. Preserve library source-frame/PTS and audio-sample boundaries independently of the project frame grid. Library range changes update browser metadata without rewriting timeline cuts or swapping source versions.

The prototype now persists library identities alongside project-local media IDs and coordinates project references through a durable outbox. The source monitor and headless CLI share source inspection and insertion code. Library preparation owns reusable source indexes, seek proxies and playback artifacts; project-local fallback caches still support independent editing. Continue extracting shared media work as workflows need it rather than replacing the editor architecture upfront. See [the integration guide](docs/content-library.md) for implemented operations and verification limits.

## Project representation and persistence

- Store authoritative times as exact integer fractions, independently of project frame rate. Frame numbers serve snapping and display. Changing frame rate must not rewrite clip positions.
- Use a project folder containing a readable manifest, graphic source files and bounded history. Save committed state atomically so interruption cannot leave a half-written manifest.
- Reference original media by default. Provide a per-project setting to copy newly imported media into the project folder. Changing that setting affects future imports; Collect project brings existing references into the folder.
- Store disposable artifacts separately from authoritative data, with configurable cache limits and protection for active readers. The Content Library owns reusable source proxies, waveforms, frame-color barcodes and indexes; AFClip owns timeline-specific compositions and mixed audio. Until library integration is implemented, the prototype's source caches remain project-local. Imported originals and graphic assets are not disposable cache data.
- Require project edits to go through GUI or CLI while the project is open. Direct manifest editing is supported only while it is closed. Graphic-code hot reload is the explicit exception.

### Transactions and conflicts

Check revisions of the objects a command depends on, including relevant relationships such as destination-track occupancy. An unrelated project change must not invalidate an otherwise valid command.

Publish coherent batches atomically and reject an entire conflicting batch. The project process owns autosave, shared undo, checkpoint operations and render locks. The agent decides how to respond to conflict details.

Saved external graphic changes enter through the project process as undoable edits. Queue reloads while rendering holds the editing lock. Render from the last accepted graphic-code version so an external save cannot change an in-progress export.

## Graphics and deterministic rendering

Graphic code runs without filesystem, process or unrestricted network access. Supply project-local assets and playback time through a narrow interface.

Each graphic accepts an explicit playback time and reports when its frame is ready. Required assets and rendering must finish before capture. A timeout becomes a graphic error rather than an unfinished captured frame.

The result at a requested time must be independent of previously rendered times. Support arbitrary seeking through a deterministic render interface and helpers that drive CSS animation from AFClip time. Ordinary timers and accumulated animation state must not determine output.

Export advances through explicit project-frame times. The prototype must prove correct source-frame selection using actual timestamps, including variable-frame-rate footage, rather than assuming evenly spaced frames.

## Audio and color

Calculate export audio directly from the timeline, including volume automation, fades and speed changes, then combine it with composed video. Export must not depend on recording real-time speaker playback. The specific offline mixing implementation remains a prototype decision.

MVP output is SDR. Preview and export must share a color-conversion policy and be checked for color consistency. HDR export is outside scope; the supported handling of HDR source imports must be explicit before claiming support for them.

## GPU acceleration and recovery

Support acceleration independently for decoding, composition and encoding where available, with software fallbacks. Aim to work across NVIDIA, AMD and Intel GPUs on Windows without requiring a specific vendor. Report which stages use software fallback; only claim performance on configurations actually tested.

Measure frame-transfer costs between decoding, Chromium composition and encoding. Acceleration within individual stages is insufficient evidence of a fast end-to-end pipeline.

If hardware processing fails during export, offer to restart from the beginning using software. Do not switch paths partway through the output. Make failure details available through GUI and CLI.

## Windows prototype

Build one complete path before expanding the editor: import video with audio, add an animated HTML/CSS graphic, edit through the CLI, see the GUI update, and export the composition after closing the GUI.

The existing macOS benchmark is useful experimental tooling, but does not validate Windows performance or browser-composed export. Windows results are required before committing to the rendering architecture.

The [Windows rendering measurements](docs/windows-benchmark-results.md) now exercise FFmpeg and offscreen Electron with local gameplay footage. They establish an experimental baseline and record failed color/fallback assumptions. They do not complete the independent project-engine and GUI/CLI prototype below.

The [follow-up rendering experiment](docs/windows-rendering-solutions.md) resolves the sampled color/fallback issues with shared FFmpeg RGB decoding, canvas composition and paint-event readiness. It also demonstrates working QSV encoding through system-memory NV12 input. That experiment used a temporary whole-clip frame cache; the [editing prototype](docs/editing-prototype.md) now uses bounded streaming decoding.

The [shared-texture export experiment](docs/windows-gpu-export.md) keeps composed frames on the GPU through D3D11 BT.709 conversion and NVENC encoding. It removes full-frame CPU readback and the raw-video pipe from the NVIDIA export path. Source decoding and canvas upload still use CPU RGBA data. The existing bitmap/software paths remain available as controls and fallback candidates.

### Functional checks

- CLI starts the project engine; Electron attaches; both use the same editing operations and receive committed state changes.
- Closing the GUI leaves headless editing and export available.
- Preview and export preserve composition, timing and graphic animation, including arbitrary seeks, trimming, stretching and project-frame-rate changes.
- Include synchronized audio, a dissolve and overlapping graphics.
- Test variable-frame-rate source footage and verify selected source frames and audio synchronization.
- Verify frame readiness, SDR color consistency, and worker failure isolation.
- Exercise hardware acceleration and software fallback on available Windows hardware.

### Performance measurements

The agreed playback target is sustained **60 fps at 1920×1080**. Validate it using a 60 fps copy of the representative edit, original footage, synchronized audio, animated graphics and dissolves. Measure actual video presentation at full 1080p, including dropped frames and pacing; UI update counts or summed frames from overlapping sources do not establish success. Keep this target unless measurements demonstrate a concrete constraint. Seeking targets 25 ms request-to-picture latency at p95 and 60 fps picture updates during continuous scrubbing. Measure cold, resident and cached seeks separately after session preparation. Latest requests must supersede older work, and release must settle on the exact selected frame. The bounded seek cache meets these targets on the representative Windows edit after preparation, using at most 960×540 source pictures for scrubbing while preserving original playback and export. Missing seek ranges generate in the background without blocking preview; shorter trims reuse containing cached ranges. See docs/timeline-playback.md for measurements, preparation cost and uncovered-source limitations.

Measure preview smoothness, seek latency, export speed, command responsiveness and frame-transfer overhead using representative footage. Record the hardware, codecs, source characteristics and enabled acceleration paths with results.

Use those measurements to set numerical acceptance targets before committing to the renderer. Determine the frame-selection, capture, audio-mixing and GPU-sharing implementations from evidence. A simple capture path can establish correctness, but does not by itself establish acceptable export performance.

### Completion criteria

The prototype is complete when it demonstrates the independent engine and GUI workflow, passes the functional checks on Windows, and has measured results against explicitly agreed performance targets. Resolve any failed rendering assumptions before building out the full editor.
