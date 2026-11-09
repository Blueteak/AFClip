# AFClip

Agent First Clip. Home: [afclip.com](https://afclip.com).

AFClip is a local desktop video editor targeted at making short videos. People and Agents edit the same project concurrently through a GUI or CLI. Every project action can work through the CLI, including editing and exporting with the GUI closed.

## Design

- [MVP Overview](AFClip-MVP-Overview.md): software behavior and scope.
- [Technical Overview](AFClip-Technical-Overview.md): architecture and prototype criteria.
- [Content Library Overview](content-library-overview.md): standalone library scope, ownership, Library-AFClip integration.

## CLI output goal

Minimize the tokens needed to complete an editing task. Default output reports useful results and exceptions, omits predictable defaults, and avoids repeating unchanged state. Raw diagnostics and complete snapshots remain available with `--full`; use `help COMMAND` for focused usage. See the [output contract and measurements](benchmarks/cli/README.md#output-tokens).

## Implementation status

The [editing prototype](docs/editing-prototype.md) loads a project folder, imports source media, commits atomic edits through a background Node engine, updates an Electron GUI over a local change stream, and coordinates headless frame renders and MP4 exports. The same commands handle GUI and CLI edits. Source decoding now streams through bounded live-frame buffers instead of writing a whole-clip RGBA cache.

Windows installer builds are available through the manually dispatched **Windows installer** GitHub Actions workflow. The default build produces a private artifact, not a public release. Download its `AFClip-…-windows-x64-setup.exe`, run it, and choose **New project** or **Open project**. It installs for the current user, adds AFClip and Content Library to Start, and registers `af-clip` / `af-lib` for new terminals. No account or developer tools are required. Unsigned development artifacts can trigger Windows security warnings; public publication requires signing.

Build on Windows x64 with Node 24+ and Visual Studio C++ Build Tools plus the Windows SDK:

```powershell
npm ci
npm run dist:win
```

The installer lands in `dist/`. Node, Electron, FFmpeg/ffprobe and the native encoder are bundled. **Help > Updates** manages published releases; private builds keep automatic checks off. Publication is explicit, requires a public repository and license, and uses the `WINDOWS_CSC_LINK` / `WINDOWS_CSC_KEY_PASSWORD` Actions secrets. Uninstall keeps projects, originals and catalog data. On Apple Silicon, run `npm ci` then `npm run dist:mac`, or download the **macOS installer** workflow artifact. Open its DMG, drag AFClip to Applications, and launch. No account or developer tools are needed to use the installed app. Local builds are ad-hoc signed; public Developer ID signing and notarization remain pending. See [macOS installation](docs/macos-installation.md).

Install from a checkout with Node 24 or newer:

```powershell
npm ci
npm link
af-clip --help
npm start -- /path/to/project
af-clip export /path/to/project exports/sample-first-edit.mp4 --mode gpu --wait
```

`npm link` registers `af-clip` and `af-lib` on all platforms. Both commands work from any directory, and relative project/media paths resolve from your current directory. The commands use this checkout, so pulled changes are available immediately. Keep the checkout in place; run `npm unlink --global afclip-prototypes` to remove the commands. If your terminal cannot find them, add the global npm bin directory to PATH: `npm config get prefix` on Windows, or that prefix plus `/bin` on macOS/Linux, then reopen the terminal.

The executable is named `af-clip` to avoid Apple's `/usr/bin/afclip` audio clipping checker on macOS. If you linked an older version, run `npm unlink --global afclip-prototypes` before updating, then `npm link` again. `npm run afclip -- <command> ...` still works from the checkout.

The example references local recordings and audio on this PC. It is not a portable media bundle. `npm run edit:example` assembles the example through engine commands when it does not already contain clips, and refuses to overwrite an existing edit. See the [prototype guide](docs/editing-prototype.md) for creating your own project, editing batches, graphics, checkpoints, GPU prerequisites and current limits.

The GUI is a keyboard-first dark editor modeled on Premiere and Resolve conventions. Drag media from the bin, move and trim clips, Shift-drag edges to change speed, split with Ctrl+K or the razor (C), add dissolves with Ctrl+D or by pushing a clip past its neighbour, add markers instantly with M and navigate them with Shift+Up/Down, mark In/Out with I and O, ripple-delete that range with Shift+Delete, and export with Ctrl+M. Every menu item and tooltip shows its shortcut. Press `?` for the full list or Ctrl+Space to search commands. Space plays and pauses the timeline with synchronized audio. Drag either ruler to scrub; Enter renders a full-resolution frame. See the [playback notes](docs/timeline-playback.md) for measured performance and current limits. The overviews describe the destination, not completed features.

Transitions now reference editable HTML/CSS/JS assets. The inspector exposes asset parameters and independent audio settings; clips support ordered effects through the same runtime. See [HTML assets](docs/html-assets.md) for authoring, timing rules and the Sample validation commands. Existing transition records intentionally require replacement.

Use **File > Collect project…** or `af-clip collect <project-dir> <new-folder>` to copy an edit, all bin sources and HTML assets into a portable folder. The source project stays unchanged.

Relink moved or replacement footage, audio and images from the project bin context menu or `af-clip relink`. Cuts and clip settings survive, and undo restores the old file reference.

For relocated video and audio, import or rescan the new location in the Content Library first. Once identity verification finishes, **File > Refresh media locations** or `af-clip library-sync <project-dir>` adopts available locations for the saved source version. Timeline cuts and annotations stay unchanged; the saved project can use the recovered paths with the library offline. Deliberate source replacement and project-owned images still use Relink.

Exports use fast container and timestamp verification by default. Choose **Thorough** verification in the Export dialog or pass `--verify full` to also decode and count the output frames.

The playback target is sustained **1080p60**; seeking targets 25 ms at p95 with 60 fps updates during scrubbing. The prepared seek cache now meets those targets on the representative Windows edit: 20.7 ms p95 across 120 randomized seeks and 300/300 correct scrub updates at 60 Hz. Scrubbing uses bounded 540p proxies built in the background. After 75 ms idle, paused video refines to the original source resolution; playback and full-resolution inspection also use originals. Unprepared ranges use slower original decoding. GPU preview presents native Chromium video layers directly, removing the previous 540p JPEG transfer path. The representative Windows edit now measures 60 fps steady-state playback, with an opening startup interval still present. See the [playback notes](docs/timeline-playback.md) for measurements and limits, or run `node benchmarks/windows/playback.cjs` to measure a disposable 1080p60 copy of the example edit.

Mac measurements and setup are in [macOS performance](docs/macos-performance.md). Prepared seeking passes on the M4; playback still has intermittent startup/title misses, and GPU export remains Windows-only.

[CLI performance measurements](docs/cli-performance.md) cover editing, library preparation, waveforms and software exports, with a [repeatable benchmark](benchmarks/cli/README.md).

## Content Library

Run `af-lib gui` for the standalone library, or `af-lib --help` for its CLI. Both use the same local service and persistent catalog. Imports reference originals in place; folders, tags, notes, named source ranges, shared undo, preparation jobs and cache controls work through either interface. Preview shares AFClip's native media presentation and fast-seek implementation.

In AFClip, **File > Browse content library** or `Ctrl+L` opens its read-only browser. Assets and ranges can be added to the project bin; annotations are edited in the standalone library. See the [Content Library guide](docs/content-library.md) for commands, measured playback/seeking and remaining scope.

## Development reload

Run `npm run dev:install` with Node 24+ to install **AFClip Dev** in the Windows Start Menu or `~/Applications/AFClip Dev.app` on macOS. Open the Mac app through Finder or Spotlight. It launches this checkout with `--dev`, restores the last project and uses the AFClip icon, without opening a terminal.

On another machine, pull the checkout, run `npm ci`, then `npm run dev:install` to create its local launcher. Rerun `dev:install` after `npm ci` to restore the macOS runtime's AFClip Dev name in the menu bar.

The launcher records absolute checkout and Node paths, so it works without your shell environment. Rerun after moving the checkout or replacing Node. Generated paths and icons stay in ignored `.afclip/` storage or the installed app, outside Git. Remove the Start Menu shortcut or Mac app to uninstall. Mac launch diagnostics go to `~/Library/Logs/AFClip Dev.log`. These source-based launchers are separate from future installed releases and do not download updates.

Run `npm run dev -- /path/to/project` to reload GUI JavaScript, HTML, CSS and the shared timeline evaluator after source changes. Without a project path, `npm start` and `npm run dev` reopen the last successfully opened project, or show the folder picker if none is available. The watcher waits until playback, dragging, text editing and pending GUI edits have stopped. It preserves saved project state and the playhead, then rebuilds the preview. Main-process, preload and worker changes still require restarting the editor. Normal `npm start` does not watch files.

## Rendering experiments

The [Windows benchmarks](benchmarks/windows/README.md) remain available separately. [Baseline measurements](docs/windows-benchmark-results.md) record the original path, and [rendering fixes](docs/windows-rendering-solutions.md) explain the color and decode changes. The [shared-texture experiment](docs/windows-gpu-export.md) removes full-frame bitmap readback from NVIDIA export through a D3D11-to-NVENC bridge. Run `npm run bench:gpu` to compare that path with the earlier CPU and GPU bitmap controls.
