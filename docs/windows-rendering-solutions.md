# Windows rendering fixes

The follow-up experiment resolves the measured color mismatch, provides original-media HEVC software rendering, and makes Intel QSV encoding work. It also replaces per-frame browser video seeks and screenshot capture with decoded RGB frames and Electron paint events. The shared project engine and editor remain unimplemented.

## What changed

### One video conversion path for both renderers

FFmpeg decodes the supplied source media at its original resolution and converts limited-range BT.709 YUV to full-range RGBA with explicit matrix and range settings. Both GPU and software composition receive the same pixels through a canvas. This bypasses Chromium's differing native-video paths and its missing software HEVC decoder.

The six sampled SDR patches differed by up to 13/255 in the original experiment. They now match exactly across GPU/software composition. The VFR identity checks also pass. This establishes consistency for these tagged SDR inputs, not a complete color-management or HDR implementation. The experiment preserves nonlinear RGB code values into an sRGB canvas and reverses the matrix/range conversion for BT.709 export. It does not apply separate transfer-function remapping or HDR tone mapping.

The original browser discrepancy occurs before screenshot capture: drawing native video into a canvas reproduces the same differing RGB values. The precise Chromium conversion defect remains unidentified. The fix here is a replacement decoding boundary, not a Chromium patch.

### Capture the finished paint instead of waiting and taking a screenshot

A trusted preload adapter reads a requested decoded frame into a canvas. Graphic code receives only bounded source IDs and frame numbers. After both canvases and explicit-time HTML graphics update, the fixture changes an 8x8 readiness token. The controller accepts a paint event only when that token is present in the captured pixels.

This removes browser video seeking, two animation-frame waits and `capturePage()` from the export loop. It also avoids serializing multi-megabyte frames through JavaScript evaluation. CPU bitmap readback and the FFmpeg pipe remain; this is not a shared GPU texture implementation.

The token occupies a visible diagnostic patch at the bottom-right corner of these experimental exports. Hash comparisons exclude it. Production capture must move it outside the exported canvas or replace it with a compositor acknowledgment.

### Give QSV system-memory NV12 input

The existing FFmpeg 6.1.1 build can use Intel hardware encoding when the encoder owns its input upload:

```powershell
& .\node_modules\ffmpeg-static\ffmpeg.exe -i input.mp4 -t 6 -an -vf format=nv12 -c:v h264_qsv -global_quality 20 output.mp4
```

All three measured attempts encoded 360 frames. Verbose logs explicitly report a hardware-accelerated MFX implementation. The earlier explicit QSV device/frame-pool setup was the failing path, so it was wrong to infer that Intel encoding as a whole was unavailable.

FFmpeg 9.0.2 was also tested locally. It got past explicit device initialization but failed on texture allocation with the old upload setup. Direct NV12 input worked in both versions. No system driver or installed FFmpeg was changed, and no dependency upgrade is needed for this fix.

## Measurements

Final run: October 16, 2026, Pacific time, on the same Ultra 9 285K / RTX 5080 / Intel Graphics machine as the baseline. 62 checks passed, none failed. [Machine-readable results](windows-rendering-solutions.json) preserve the evidence. Local artifacts: `.cache/windows-solutions/2026-10-17T05-07-50-441Z/`.

| Five-second 1080p30 export | Original native-video path | New RGB/paint path | New decode + mix + export sum |
| --- | ---: | ---: | ---: |
| Synthetic, GPU composition + NVENC | 20.8 fps | 43.7 fps | 4.18 s |
| Synthetic, software composition + x264 | 14.1 fps | 68.3 fps | 2.94 s |

| Gameplay export | GPU composition + NVENC | Software composition + x264 | Including decode/cache + mix, GPU / software |
| --- | ---: | ---: | ---: |
| Sample H.264, 1080p48 source | 45.7 fps | 67.5 fps | 4.04 / 2.98 s |
| Gauntlet HEVC, 1440p60 source | 43.0 fps | 42.7 fps | 4.78 / 4.80 s |

The gameplay exports use original-resolution decoded media, not the earlier H.264 proxy. Output is 1080p30. The HEVC preparation-inclusive result is only slightly faster than real time in this short run.

| Cached seek-to-painted-frame p95 | GPU composition | Software composition |
| --- | ---: | ---: |
| Sample H.264 | 17.6 ms | 17.2 ms |
| Gauntlet HEVC | 41.4 ms | 29.1 ms |

QSV's median six-second encode took 2.30 seconds across three attempts. The 24 sampled exported frames had SSIM from 0.980611 to 0.999682 against their captured references. GPU/software SDR patch difference was 0/255. VFR selection passed at seven requested times per mode, including long frame intervals.


The GPU mode uses CPU FFmpeg decoding, GPU canvas/HTML composition and NVENC. Software mode uses CPU decoding, software canvas/HTML composition and x264. The QSV encoding measurement is separate from those composed exports.

Each export contains two trimmed source sections, a one-second dissolve, overlapping animated HTML graphics, and offline mixed audio from the corresponding source. All six MP4s contain 150 frames and AAC audio. Four captured/exported frames per file pass the SSIM check. Generated flash/pulse checks establish audio synchronization; gameplay files establish source-audio inclusion and duration, not independently measured lip sync.

Each composed export has one recorded timing sample in the final run. Earlier implementation runs showed similar synthetic rates, but the table is not a statistical average. Filesystem caches are warm. The preparation-inclusive number is the sum of source decode/cache creation, audio mixing and export. It excludes metadata inspection, Electron startup, validation and saved PNG files, so it is not a cold application-start measurement. The baseline included four PNG writes within its export timer; the new timer excludes those writes.

## Reproduce

```powershell
npm ci
npm run bench:windows -- --source "/path/to/media/source" --source "/path/to/media/source"
npm run bench:solutions
```

The original benchmark still exits 1 on its native-video color mismatch. That behavior is retained as a baseline. The solution experiment uses its fixtures and defaults to the latest baseline directory containing `config.json`. An explicit directory can be supplied:

```powershell
npm run bench:solutions -- ".cache/windows-benchmark/<run-directory>"
```

Outputs go to a unique `.cache/windows-solutions/` directory. The runner deletes its generated RGBA frame caches after a completed run and retains MP4s, captures, logs and JSON. Recordings remain unchanged. The default input checks reject unsupported color tags and full-range sources; these experiments cover the known BT.709 SDR recordings.

## Remaining work

The decoded-cache approach is deliberately small and fixed: six seconds per source, resampled onto a 30 fps project grid. The tested inputs produce about 5.7 GB of temporary RGBA data. This must become a bounded decoder queue/cache before long projects, frame-rate changes, or arbitrary off-grid source requests. The reported seek latencies apply after that cache exists.

The preload uses synchronous file reads in a dedicated rendering process with context isolation and page Node integration disabled. Its Electron sandbox is disabled because the trusted adapter needs filesystem access. This fixed local fixture is not a security boundary for arbitrary graphic code. The production worker/graphics sandbox still needs implementation.

The new paint-token path does not yet repeat the baseline's renderer-crash recovery check. There is still no project engine, GUI/CLI collaboration, render locking, cancel/restart workflow, sustained visible preview test, or agreed performance acceptance target. The original prototype checklist remains open for those requirements.

Use this pipeline as the next renderer implementation baseline. Keep the RGB conversion contract and explicit source-time selection; replace whole-clip caches with bounded sequential decoding. The software compositor is competitive for this 2D scene, but GPU-specific graphics and heavier compositions still need their own measurements.

References: [Electron offscreen rendering and paint events](https://www.electronjs.org/docs/latest/tutorial/offscreen-rendering), [FFmpeg filter documentation](https://ffmpeg.org/ffmpeg-filters.html), [Windows FFmpeg builds](https://www.gyan.dev/ffmpeg/builds/).
