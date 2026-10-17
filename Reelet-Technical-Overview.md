# Reelet Technical Overview

Reelet targets Windows first. The [MVP Overview](Reelet-MVP-Overview.md) defines product behavior; this document records the agreed architecture and the prototype needed to validate it. These are implementation decisions, not claims that the editor already exists.

## Architecture

### Project engine

Use TypeScript on Node.js for project state, command validation, transactions, conflict detection, history, persistence and render-job coordination. Keep this engine independent of Electron and browser APIs. Frame processing and audio processing belong in separate workers.

One background process owns each open project. GUI and CLI send commands through the same versioned, machine-local protocol, with structured responses and change subscriptions. The CLI starts the process when needed without opening a window. Electron is the desktop GUI, not the project engine.

The process stays alive while a GUI, CLI operation or render needs it, then exits after a short idle period. Sequential CLI calls share ordinary undo history while that process remains alive. Its exit ends the editing session; persistent checkpoints remain available.

The TypeScript choice is provisional until the prototype demonstrates responsive command handling alongside media work. Runtime validation is required for incoming commands and project data; TypeScript types alone do not validate external input.

### Rendering workers

Put decoding, graphic rendering, frame composition, audio mixing and encoding behind a separate rendering interface. A worker failure must not take down the project engine or lose committed edits. Report the failed operation and restart the worker for subsequent requests.

Provisionally use Chromium for HTML/CSS composition, sharing composition code and browser-engine version between preview and export. Chromium runs as part of the rendering backend without requiring the Electron GUI. The backend remains replaceable without rewriting project operations.

Bundle pinned FFmpeg and ffprobe builds for inspection, conversion and export. Users should not need to install them separately. Keep their command syntax inside the worker implementation. The precise decoding, capture and GPU frame-transfer paths remain subject to prototype results.

## Project representation and persistence

- Store authoritative times as exact integer fractions, independently of project frame rate. Frame numbers serve snapping and display. Changing frame rate must not rewrite clip positions.
- Use a project folder containing a readable manifest, graphic source files and bounded history. Save committed state atomically so interruption cannot leave a half-written manifest.
- Reference original media by default. Provide a per-project setting to copy newly imported media into the project folder. Changing that setting affects future imports; Collect project brings existing references into the folder.
- Store disposable proxies, waveforms, frame-color barcodes and frame indexes in a separate regenerable cache with a configurable size limit. Evict unused entries as needed. Imported originals and graphic assets are not disposable cache data.
- Require project edits to go through GUI or CLI while the project is open. Direct manifest editing is supported only while it is closed. Graphic-code hot reload is the explicit exception.

### Transactions and conflicts

Check revisions of the objects a command depends on, including relevant relationships such as destination-track occupancy. An unrelated project change must not invalidate an otherwise valid command.

Publish coherent batches atomically and reject an entire conflicting batch. The project process owns autosave, shared undo, checkpoint operations and render locks. The agent decides how to respond to conflict details.

Saved external graphic changes enter through the project process as undoable edits. Queue reloads while rendering holds the editing lock. Render from the last accepted graphic-code version so an external save cannot change an in-progress export.

## Graphics and deterministic rendering

Graphic code runs without filesystem, process or unrestricted network access. Supply project-local assets and playback time through a narrow interface.

Each graphic accepts an explicit playback time and reports when its frame is ready. Required assets and rendering must finish before capture. A timeout becomes a graphic error rather than an unfinished captured frame.

The result at a requested time must be independent of previously rendered times. Support arbitrary seeking through a deterministic render interface and helpers that drive CSS animation from Reelet time. Ordinary timers and accumulated animation state must not determine output.

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

### Functional checks

- CLI starts the project engine; Electron attaches; both use the same editing operations and receive committed state changes.
- Closing the GUI leaves headless editing and export available.
- Preview and export preserve composition, timing and graphic animation, including arbitrary seeks, trimming, stretching and project-frame-rate changes.
- Include synchronized audio, a dissolve and overlapping graphics.
- Test variable-frame-rate source footage and verify selected source frames and audio synchronization.
- Verify frame readiness, SDR color consistency, and worker failure isolation.
- Exercise hardware acceleration and software fallback on available Windows hardware.

### Performance measurements

Measure preview smoothness, seek latency, export speed, command responsiveness and frame-transfer overhead using representative footage. Record the hardware, codecs, source characteristics and enabled acceleration paths with results.

Use those measurements to set numerical acceptance targets before committing to the renderer. Determine the frame-selection, capture, audio-mixing and GPU-sharing implementations from evidence. A simple capture path can establish correctness, but does not by itself establish acceptable export performance.

### Completion criteria

The prototype is complete when it demonstrates the independent engine and GUI workflow, passes the functional checks on Windows, and has measured results against explicitly agreed performance targets. Resolve any failed rendering assumptions before building out the full editor.
