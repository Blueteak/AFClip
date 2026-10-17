# Reelet

Reelet is a local desktop video editor for game trailers and marketing videos, targeting Windows first. People and agents edit the same project through a GUI or CLI. Every project action must work through the CLI, including editing and exporting with the GUI closed.

The planned MVP covers supplied footage, music, sound effects, images and HTML/CSS/JavaScript graphics. The first implementation is a smaller editing slice: a shared project engine, CLI, basic desktop editor and separate export workers. Track folders, audio automation curves, reusable selects and the rest of the agreed MVP remain future work.

## Design

- [MVP Overview](Reelet-MVP-Overview.md): agreed behavior and scope.
- [Technical Overview](Reelet-Technical-Overview.md): architecture and Windows prototype criteria.

These overviews supersede the earlier design brief.

## Implementation status

The [editing prototype](docs/editing-prototype.md) loads a project folder, imports source media, commits atomic edits through a background Node engine, updates an Electron GUI over a local change stream, and coordinates headless frame renders and MP4 exports. The same commands handle GUI and CLI edits. Source decoding now streams through bounded live-frame buffers instead of writing a whole-clip RGBA cache.

With Node 24 and dependencies installed:

```powershell
npm ci
node src/cli.ts --help
npm start -- examples/vellum-first-edit
node src/cli.ts export examples/vellum-first-edit exports/vellum-first-edit.mp4 --mode gpu --wait
```

The example references local recordings and audio on this PC. It is not a portable media bundle. `npm run edit:example` assembles the example through engine commands when it does not already contain clips, and refuses to overwrite an existing edit. See the [prototype guide](docs/editing-prototype.md) for creating your own project, editing batches, graphics, checkpoints, GPU prerequisites and current limits.

The GUI currently offers clip selection and numeric edits, track controls, exact-frame rendering and playback of completed exports. Continuous timeline playback and most gesture-based editing are not implemented. The overviews describe the destination, not completed features.

Exports use fast container and timestamp verification by default. Enable **Thorough export check** in the editor or pass `--verify full` to also decode and count the output frames.

## Rendering experiments

The [Windows benchmarks](benchmarks/windows/README.md) remain available separately. [Baseline measurements](docs/windows-benchmark-results.md) record the original path, and [rendering fixes](docs/windows-rendering-solutions.md) explain the color and decode changes. The [shared-texture experiment](docs/windows-gpu-export.md) removes full-frame bitmap readback from NVIDIA export through a D3D11-to-NVENC bridge. Run `npm run bench:gpu` to compare that path with the earlier CPU and GPU bitmap controls.
