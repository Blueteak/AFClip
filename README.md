# Reelet

Reelet is a local desktop video editor for game trailers and marketing videos, targeting Windows first. People and agents edit the same project through a GUI or CLI. Every project action must work through the CLI, including editing and exporting with the GUI closed.

The planned MVP covers supplied footage, music, sound effects, images and HTML/CSS/JavaScript graphics. The implementation includes a shared project engine, CLI, desktop editor, separate export workers and a standalone Content Library for reusable video/audio annotations and named selects. Track folders, ripple editing and other parts of the editing overview remain future work.

## Design

- [MVP Overview](Reelet-MVP-Overview.md): agreed behavior and scope.
- [Technical Overview](Reelet-Technical-Overview.md): architecture and Windows prototype criteria.
- [Content Library Overview](content-library-overview.md): standalone library scope, ownership, Inbox lifetime and Reelet integration.

These overviews supersede the earlier design brief.

## Implementation status

The [editing prototype](docs/editing-prototype.md) loads a project folder, imports source media, commits atomic edits through a background Node engine, updates an Electron GUI over a local change stream, and coordinates headless frame renders and MP4 exports. The same commands handle GUI and CLI edits. Source decoding now streams through bounded live-frame buffers instead of writing a whole-clip RGBA cache.

With Node 24 and dependencies installed:

```powershell
npm ci
node src/cli.ts --help
npm start -- /path/to/project
node src/cli.ts export /path/to/project exports/sample-first-edit.mp4 --mode gpu --wait
```

The example references local recordings and audio on this PC. It is not a portable media bundle. `npm run edit:example` assembles the example through engine commands when it does not already contain clips, and refuses to overwrite an existing edit. See the [prototype guide](docs/editing-prototype.md) for creating your own project, editing batches, graphics, checkpoints, GPU prerequisites and current limits.

The GUI is a keyboard-first dark editor modeled on Premiere and Resolve conventions. Drag media from the bin, move and trim clips, Shift-drag edges to change speed, split with Ctrl+K or the razor (C), add dissolves with Ctrl+D, mark In/Out with I and O, and export with Ctrl+M. Every menu item and tooltip shows its shortcut. Press `?` for the full list or Ctrl+Shift+P to search commands. Space plays and pauses the timeline with synchronized audio. Drag either ruler to scrub; Enter renders a full-resolution frame. See the [playback notes](docs/timeline-playback.md) for measured performance and current limits. The overviews describe the destination, not completed features.

Exports use fast container and timestamp verification by default. Choose **Thorough** verification in the Export dialog or pass `--verify full` to also decode and count the output frames.

The playback target is sustained **1080p60**; seeking targets 25 ms at p95 with 60 fps updates during scrubbing. The prepared seek cache now meets those targets on the representative Windows edit: 20.7 ms p95 across 120 randomized seeks and 300/300 correct scrub updates at 60 Hz. Scrubbing uses bounded 540p proxies built in the background. After 75 ms idle, paused video refines to the original source resolution; playback and full-resolution inspection also use originals. Unprepared ranges use slower original decoding. GPU preview presents native Chromium video layers directly, removing the previous 540p JPEG transfer path. The representative Windows edit now measures 60 fps steady-state playback, with an opening startup interval still present. See the [playback notes](docs/timeline-playback.md) for measurements and limits, or run `node benchmarks/windows/playback.cjs` to measure a disposable 1080p60 copy of the example edit.

## Content Library

Run `npm run library:gui` for the standalone library, or `npm run library -- --help` for its CLI. Both use the same local service and persistent catalog. Imports reference originals in place; folders, tags, notes, named source ranges, shared undo, preparation jobs and cache controls work through either interface. Preview shares Reelet's native media presentation and fast-seek implementation.

In Reelet, **File > Browse content library** or `Ctrl+L` opens its read-only browser. Assets and ranges can be added to the project bin; annotations are edited in the standalone library. See the [Content Library guide](docs/content-library.md) for commands, measured playback/seeking, the 35-asset GUI annotation pass and remaining scope.

## Development reload

Run `npm run dev -- /path/to/project` to reload GUI JavaScript, HTML, CSS and the shared timeline evaluator after source changes. The watcher waits until playback, dragging, text editing and pending GUI edits have stopped. It preserves saved project state and the playhead, then rebuilds the preview. Main-process, preload and worker changes still require restarting the editor. Normal `npm start` does not watch files.

## Rendering experiments

The [Windows benchmarks](benchmarks/windows/README.md) remain available separately. [Baseline measurements](docs/windows-benchmark-results.md) record the original path, and [rendering fixes](docs/windows-rendering-solutions.md) explain the color and decode changes. The [shared-texture experiment](docs/windows-gpu-export.md) removes full-frame bitmap readback from NVIDIA export through a D3D11-to-NVENC bridge. Run `npm run bench:gpu` to compare that path with the earlier CPU and GPU bitmap controls.
