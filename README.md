# Reelet

Reelet is a local desktop video editor for game trailers and marketing videos, targeting Windows first. People and agents edit the same project through a GUI or CLI. Every project action must work through the CLI, including editing and exporting with the GUI closed.

The MVP supports supplied footage, music, sound effects, images and HTML/CSS/JavaScript graphics. It includes universal tracks, track folders, trimming, stretching, audio curves, fades, dissolves, reusable selects and SDR MP4 export. Video treatments and built-in graphic-code editing are deferred.

## Design

- [MVP Overview](Reelet-MVP-Overview.md): agreed behavior and scope.
- [Technical Overview](Reelet-Technical-Overview.md): architecture and Windows prototype criteria.

These overviews supersede the earlier design brief.

## Implementation status

The editor is not implemented yet. Existing local media benchmarks are experiments, not the application.

The planned architecture uses an independent TypeScript/Node.js project engine, an Electron GUI and separate rendering workers. Chromium composition and bundled FFmpeg tools are provisional choices. GPU acceleration should be used where available, with software fallbacks.

The next step is a Windows prototype proving shared GUI/CLI editing, deterministic graphics, synchronized audio and composed export. Rendering correctness and measured performance will determine the final pipeline.
