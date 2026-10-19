# CLI performance, October 18, 2026

Measured on the local Apple M4 Mac mini, 10 CPU cores, 24 GiB RAM. The workload uses original 4K60 H.264 gameplay in a 1080p60 edit, dissolves, HTML graphics and source audio. Runs were serial, using disposable projects/catalogs. OS caches were not flushed.

## Changes and results

Library source preparation now uses the same validated MP4 packet/fragment timestamp indexing as rendering. It previously decoded every frame with a single ffprobe thread, even when the container supplied enough information to establish exact boundaries. Unsupported containers retain decoded indexing, with automatic threading on macOS.

For a 46.95-second, 2,816-frame recording, the cold indexing worker fell from **28,729 ms to 199 ms**, a 144× improvement. Process-inclusive CLI time initially fell from **29.24 seconds to 0.58 seconds**. Those command measurements precede the polling change below. All 2,816 integer timestamp ticks and the time base match the decoded baseline exactly.

Full-resolution software rendering on macOS now lets FFmpeg choose decoder threading. A 120-frame 4K decode control took 1,742 ms with two threads and 941 ms with automatic threading. Four threads took 1,173 ms; eight took 994 ms. More filter threads did not help. Preview decode settings and Windows decode settings remain unchanged.

Three one-second export runs per case, each with full output verification:

- Plain footage: median rendering rose from **25.46 to 32.26 fps**, up 27%. Median CLI time fell from 3.60 to 3.10 seconds.
- Dissolve: **12.99 to 15.07 fps**, up 16%. Median CLI time fell from 6.13 to 5.64 seconds.
- HTML title: **28.37 to 28.04 fps**, essentially unchanged. Median CLI time stayed at 3.11 seconds.

All nine corresponding MP4 files are byte-for-byte identical before and after the decoder change. The PNG frame is also byte-for-byte identical. No resolution, encoder quality, color conversion or frame-selection changes were made.

Library `--wait` now polls after 25 ms initially, doubling up to 500 ms for longer work. Previously even a 1 ms cached indexing job took about 614 ms through the CLI. This preserves the timeout and failure handling while reducing short-job latency. The final Node 24 run measured 126 ms for cached indexing, down from 614 ms, and 480 ms for cold indexing. All benchmark commands and full export verification passed.

## Other features

Warm project inspection took about 91 ms including Node startup; cold engine startup plus inspection took 203 ms. Marker changes, undo and redo took 90–97 ms. Project import took 257 ms. Library search took 89 ms on the small fixture catalog. A 30-second stereo waveform took 309 ms cold and 88 ms from memory. A full-resolution PNG took 1.1 seconds through the CLI. These measurements do not establish large-project or million-item catalog performance.

## Limits and reproduction

Software export is still below real time, especially across dissolves. Automatic decoder threading does not remove full-resolution RGBA transfer, CPU canvas composition, Chromium readback or x264 encoding. The Mac shared-texture/VideoToolbox export backend is still absent. These fixes do not establish a hardware-limit throughput ceiling or resolve the previously reported intermittent GUI playback stalls.

The paired export comparison used the shell's native ARM Node 22.22.1 for both sides, with Electron 44.8.0 doing the rendering. Library comparisons used the required Node 24.19.0. A complete additional run uses Node 24.19.0 for the committed benchmark. Do not compare process startup times across Node versions as an optimization claim.

See [measurements](cli-performance.json) and [benchmark instructions](../benchmarks/cli/README.md). Local before/after media and detailed command responses are under `.cache/cli-perf/`; the complete Node 24 run is under `.cache/cli-perf/validated/`. Early attempts with stale pre-rename graphics failed their protocol handshake and were excluded; measured runs use current example graphics.
