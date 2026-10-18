# Mac playback measurements

Use the same visible editor diagnostic as Windows. It measures original-source playback at a 1920×1080 monitor, exact source PTS after seeks, 120 seeded timeline seeks, and continuous scrubbing through a dissolve. A display that fits the monitor at device-pixel ratio 1 is required. Source media stays local.

```sh
npm ci
node benchmarks/macos/project.ts .cache/macos/gameplay /absolute/path/clip1.mp4 /absolute/path/clip2.mp4
node benchmarks/macos/prepare.cjs .cache/macos/gameplay
node benchmarks/windows/playback.cjs .cache/macos/gameplay 64 1080 --reuse-cache
node benchmarks/windows/playback.cjs .cache/macos/gameplay 64 1080 --reuse-cache --seek
```

The fixture has eight eight-second shots, seven one-second dissolves, the Sample opening and closing graphics, and mixed source audio. Supply tagged limited-range BT.709 gameplay sources at least 19 seconds long. Four 4K60 recordings were used for the [Mac results](../../docs/macos-performance.md); they are different footage/codecs from the Windows Sample test. No rescaling or transcoding is applied to playback sources.

`prepare.cjs` runs the production preparation worker and records startup/background-cache timings without the GUI. It leaves timestamp indexes and seek packets in the disposable project. `--reuse-cache` copies those two caches into each isolated benchmark project, and the worker still validates their source fingerprints. Omit it for cold preparation. For long source files, set `REELET_PREPARE_TIMEOUT_SECONDS=600` to allow the diagnostic up to ten minutes for startup. This does not change playback or seek targets. Editor preparation itself times out after two minutes without worker progress.

Results go under `.cache/playback/<timestamp>/`; preparation defaults to `.cache/macos/preparation.json`. Playback and seeking run serially, muted, using the real mixed-audio clock. Seeking waits for background cache generation; playback does not. Read `seekCache.hits`, `built` and `sources` to distinguish full coverage from fallback. The 256 MiB disk and decoded-bitmap budgets are separate. These measurements establish browser readiness and presentation counters, not physical scanout or speaker latency.

Apple Silicon uses the pinned native ARM ffprobe package. Other platforms retain `ffprobe-static` 3.1.0. Windows presentation switches and the D3D11/NVENC export implementation are unchanged. Mac GPU export is not implemented; use software export when checking rendered output.
