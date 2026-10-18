# macOS playback and seeking, October 17, 2026

Prepared seeking meets the 25 ms p95 target and all 300 scrub requests delivered the correct picture at the display's nominal 60 Hz cadence. Playback is near 60 fps after warmup, but **consistent drop-free playback is not established**: the first full run stalled during title animations, and both runs reported clip-start drops. GPU export remains Windows-only.

The checkout was fast-forwarded from `26603f6` to `82c8090`, bringing in 39 commits. [Recorded measurements](macos-performance.json) retain per-shot playback metrics, seek timestamps, preparation timings, controls and verification results. [Run instructions](../benchmarks/macos/README.md) use the existing Windows playback/seek diagnostic against the production editor.

## Workload and comparison

- Mac mini, Apple M4, 10 CPU cores, 24 GiB memory, macOS 27.0 build 26A428. Electron 44.8.0, Chromium 152, ARM64 FFmpeg 6.0 and ffprobe 4.4.1.
- A 64-second 1920×1080, 60 fps project: eight gameplay shots, seven one-second dissolves, the existing Sample opening/closing graphics and mixed original audio. The monitor occupied 1920×1080 physical pixels at device-pixel ratio 1.
- Four original 3840×2160, 60 fps H.264 recordings from `/path/to/media`, approximately 47–323 seconds each. Playback used their original pixels, without transcoding. The fixture builder selects source ranges near 1 and 10 seconds.
- The Windows Sample sources and soundtrack are absent here. Windows used 1440p60 HEVC, eight sources and music/effects. This exercises the same editor and interaction checks with a different workload; it is not a same-media platform comparison.
- The attached 2560×1440 display reports 59.9505 Hz. Its usable height is 1320 pixels, so full physical-size 1440p/2160p presentation was not tested. Audio was muted while retaining the real mixed-audio clock. No speaker/display latency or audio audition is claimed.

Runs were serial. Generated caches were empty for the cold preparation measurement; OS filesystem and driver caches were not flushed.

## Fixes

1. **Native Apple Silicon probing.** `ffprobe-static` 3.1.0 contains an x86_64 executable in its `darwin/arm64` directory. It failed to launch with system error -86. The shared resolver now selects pinned `@ffprobe-installer/darwin-arm64` 5.0.1 on Apple Silicon. Its executable reports ffprobe 4.4.1 and runs natively. The optional package is restricted to macOS ARM64; other platforms keep the original binary. Engine imports, rendering and library jobs share the resolver. The package comes from [node-ffprobe-installer](https://github.com/SavageCore/node-ffprobe-installer).
2. **Threaded Mac timestamp scanning.** These fragmented MP4 files lack `nb_frames`, so the existing conservative indexer decodes every source frame. A 600-frame control took 10,792 ms with default threading, 3,693 ms with four threads and 2,020 ms with automatic threading. All 600 timestamps matched exactly. Mac rendering preparation now supplies `-threads 0` for that decoded-index fallback. Packet-index validation and Windows probe arguments are unchanged.
3. **Progress-based preparation timeout.** Even with threading, the full worker took 137.2 seconds to become ready. The old GUI deadline was 120 seconds for the entire operation. It now allows 120 seconds without current-session progress, so completing each source keeps a healthy preparation alive. A stalled source can still time out. The diagnostic has an explicit startup deadline override for long projects.

The Windows DirectComposition workaround, decoder/export settings and D3D11/NVENC helper were not changed. A resolver check confirmed the Windows branch still selects the existing binary. Windows execution was not available on this Mac, so this is not a Windows runtime regression certification.

## Playback

Both complete runs used the default `GraphiteDawnMetal` compositor and `VideoToolboxVideoDecoder`. Hardware video decoding was reported for every observed video player. Neither run required a large audio/video clock resynchronization.

| Check | First full run | Second full run |
| --- | ---: | ---: |
| Preview ready, reused caches | 2.00 s | 1.89 s |
| Whole-shot presented rate | 57.38–59.96 fps | 59.18–59.95 fps |
| Presented rate after each shot's first 0.6 s | 57.66–59.97 fps | 59.82–59.97 fps |
| Largest GUI update interval | 183.5 ms | 20.2 ms |
| Dropped source frames during visible intervals | 57 | 19 |
| Large clock resyncs | 0 | 0 |

The first run's long gaps coincided with the opening animation and closing-title entrance around seconds 58–59.4. Shots without those stalls sustained 59.94–59.97 fps. The second full run did not reproduce the long title stalls; its smaller losses were concentrated around clip startup. Callback delivery coalesced more often in that run, so raw callback rates around 45–49 fps were lower than Chromium's cumulative presented-frame rates. Overlapping source counts are not added to claim composition throughput.

An eight-second trace starting at timeline 56 seconds also failed to reproduce the long stall. It measured 59.95 fps after startup on the closing shot with no reported visible drops. This does not identify the cause of the first-run stalls. The trace cannot substantiate a shader-compilation or rasterization explanation, and the report does not treat warmup as a fix.

A separate attempt disabled Skia Graphite using Chromium's [documented source switch](https://chromium.googlesource.com/chromium/src/+/HEAD/gpu/config/gpu_finch_features.cc). That process failed with `GPU access not allowed. Reason: GPU access is disabled due to frequent crashes.` No alternate graphics setting was retained. Further work needs a trace that captures the actual intermittent stall and a reliable clip-start improvement. The current result supports nominal 60 Hz steady playback, not an unconditional 60 fps guarantee.

## Prepared seeking and scrubbing

These numbers use the unchanged Windows seek diagnostic after all four seek ranges were ready. They measure request to exact selected source PTS, graphic/preview readiness, and the next animation frame. They exclude preparation and original-resolution refinement, and do not measure physical scanout.

| Interaction | Samples | Median | p95 | Within 25 ms |
| --- | ---: | ---: | ---: | ---: |
| Forward frame step | 12 | 17.8 ms | 20.1 ms | 12/12 |
| Backward frame step | 12 | 3.2 ms | 16.7 ms | 12/12 |
| Nearby seek | 12 | 16.8 ms | 18.1 ms | 12/12 |
| Distant seek | 12 | 18.4 ms | 19.9 ms | 12/12 |
| Seeded full-timeline seek | 120 | 17.9 ms | 20.8 ms | 119/120 |

The one random outlier took 32.7 ms at timeline 59.367 seconds; source/graphic readiness took 4.3 ms. The p95 target passes, but 25 ms is not a worst-case bound.

Cached reversals delivered 120/120 correct next-tick pictures, the new-bitmap sweep 60/60, and dissolve reversals 120/120. Rates were 59.949–59.958 correct updates/sec, matching this display's 59.9505 Hz refresh. Release settled exactly in 16.4–16.7 ms. The decoded bitmap cache ended at 255.1 MiB, below its separate 256 MiB budget, so broad coverage exercised eviction.

With all seek-proxy references removed, the same original-media positioning path had p95 85.5 ms forward, 451.2 ms nearby and 1004.5 ms distant. Backward steps were resident and took 3.4 ms at p95. Native bitmap caching and read-ahead remained enabled, so this control mixes resident and missing frames. Long-GOP original decoding still misses 25 ms when a picture is not cached. Missing, corrupt or over-budget seek ranges cannot inherit the prepared-cache claim.

## Preparation costs

The first diagnostic attempt exceeded its old 90-second startup limit while scanning the first original source. After enabling Mac decode threading, production worker readiness took 137.2 seconds across all four full-file scans. The two long files accounted for most of that time. Reopening with timestamp indexes and seek packets reused brought measured GUI readiness down to 1.89–2.00 seconds.

After worker readiness, the first seek range arrived 8.37 seconds later and all four finished after 32.31 seconds of background encoding. They occupy 239.3 MiB within the 256 MiB disk budget. Warm cache lookup took about 1.9 ms in the first full playback run. The worker benchmark measured generation without concurrent GUI playback; it is not a measurement of playback under background encoding load.

The timeout fix permits long preparation; it does not make full-file indexing cheap. Faster cold open for fragmented recordings needs an equally trustworthy timestamp path that avoids decoding every unused frame, or more incremental preparation. The current conservative fallback was retained rather than weakening frame selection correctness.

## Correctness and export

A cached packet at source PTS 3.0 matched a separate frame-180 encode decoded from the source beginning byte-for-byte.

Lifecycle checks passed for exact rapid-seek settlement, original-video resume/pause, paused 4K refinement, unavailable-proxy fallback, a forced 4 MiB bitmap budget, software preview through a dissolve, returning to native preview and releasing bitmaps on close.

At timeline 2 seconds, the refined original reported source PTS 3.0, video width 3840 and the proxy hidden. After allowing the compositor to paint, the native capture matched the full-resolution software reference with YUV420 SSIM **0.995165**. An earlier immediate screenshot was stale, SSIM 0.900730. The settled capture is the correctness comparison; callback readiness must not be equated with scanout. This is one title/frame sample, not full color-management validation.

A one-second 1080p60 software export across the dissolve at 7.5–8.5 seconds passed full verification: 60 decoded video frames, 60 video packets and 48 audio packets. Rendering took 4.67 seconds, **12.84 fps**, and the whole job took 5.86 seconds. Two original 4K decoders, CPU composition, full-frame readback and x264 remain in this path. It is correct but below real-time throughput.

The same GPU export request failed explicitly: `Shared-texture benchmark requires Windows x64.` The helper consumes Windows D3D11 handles and encodes with NVENC; there is no Mac shared-texture/VideoToolbox encoder implementation in this editor. No silent software fallback or Windows-equivalent GPU-export throughput is claimed.

Clean `npm ci`, native probe execution, changed-file syntax checks and diff whitespace checks passed. Focused watchdog checks covered progress refresh, stale-session rejection, readiness cleanup and stalled-worker rejection. No always-run test suite was added.

## Local artifacts

- First playback: `.cache/playback/2026-10-18T00-32-03-955Z/results.json`
- Second playback: `.cache/playback/2026-10-18T00-34-12-635Z/results.json`
- Prepared seeks: `.cache/playback/2026-10-18T00-33-16-667Z/seeks.json`
- Original-media seek control: `.cache/playback/2026-10-18T00-37-25-093Z/seeks.json`
- Title trace: `.cache/playback/2026-10-18T00-33-43-806Z/trace.json`
- Rejected graphics control: `.cache/playback/2026-10-18T00-35-29-192Z/error.json`
- Lifecycle/refined capture: `.cache/playback/2026-10-18T00-37-59-663Z/`
- Worker preparation, threading control, reference PNG and export results: `.cache/macos/`
