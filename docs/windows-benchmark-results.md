# Windows rendering measurements

Follow-up: [tested rendering fixes](windows-rendering-solutions.md) resolve the sampled color mismatch, enable original-media software HEVC rendering, and demonstrate working Intel QSV encoding. This document preserves the original baseline.

Run on October 16, 2026, Pacific time. The repository contained design documents but no runnable editor or checked-in benchmark. This work adds the [Windows experiment runner](../benchmarks/windows/README.md) and tests its rendering path with local gameplay footage.

The renderer is not ready for architecture acceptance. The simple composed export is slower than real time, GPU/software color conversion differs, native software HEVC preview fails, and Intel QSV cannot initialize with the tested binary and driver. The shared project engine and GUI/CLI workflow do not exist yet.

## Reproduce and inspect

```powershell
npm ci
npm run bench:windows -- --source "/path/to/media/source" --source "/path/to/media/source"
```

The recorded run is `.cache/windows-benchmark/2026-10-17T04-46-22-175Z/`. Rendering was rerun after correcting benchmark initialization and color-comparison instrumentation; the report records both timestamps. [Machine-readable results](windows-benchmark-results.json) preserve the measurements and check outcomes. Full logs, media, captures and per-frame timings remain in the ignored local run directory. Source recordings were not modified or uploaded.

## Machine and inputs

- Windows 11 Pro, build 26200; Intel Core Ultra 9 285K, 24 cores; about 63.4 GiB usable RAM.
- NVIDIA GeForce RTX 5080, driver 32.0.16.1714; Intel Graphics, driver 32.0.101.6314. No AMD machine was tested.
- Node 24.12.0; Electron 44.8.0; FFmpeg 6.1.1 essentials build; ffprobe 4.0.2. Dependencies are pinned in the lockfile. These old FFmpeg/probe binaries are experimental tooling, not a packaging decision.
- Sample recording: H.264/AAC, 1920x1080 at 48 fps, about 12 seconds, BT.709 SDR.
- Gauntlet recording: HEVC/AAC, 2560x1440 at 60 fps, about 15.3 seconds, BT.709 SDR.
- Generated fixtures: six-second 1080p60 H.264/AAC color/motion pattern with timed white flashes and audio pulses; 90-frame VFR grayscale identity pattern with roughly 33 and 100 ms frame intervals.

## Results

The final numbers and check counts below are generated from the recorded JSON.

26 checks passed; 1 failed. The runner exits 1 because the cross-path SDR comparison fails. Intel QSV initialization failures and native software HEVC failure are additional recorded capability failures, not included in that check count.

| Five-second 1080p30 composed export | Default GPU + NVENC | Software + x264 |
| --- | ---: | ---: |
| Wall time | 7.21 s | 10.62 s |
| Export rate | 20.8 fps | 14.1 fps |
| Relative to real time | 0.69x | 0.47x |
| Seek/readiness, median per frame | 22.1 ms | 51.9 ms |
| Capture, median per frame | 15.3 ms | 13.5 ms |
| Bitmap conversion, median per frame | 4.0 ms | 4.0 ms |
| Pipe write, median per frame | 1.3 ms | 1.3 ms |

| Source preview | GPU seek median / p95 | GPU dropped / total frames | Software seek median / p95 | Software dropped / total frames |
| --- | ---: | ---: | ---: | ---: |
| Synthetic 1080p60 | 32.8 / 60.2 ms | 0 / 179 | 58.4 / 85.5 ms | 0 / 179 |
| Sample H.264 1080p48 | 105.1 / 170.4 ms | 0 / 143 | 137.1 / 207.8 ms | 3 / 142 |
| Gauntlet HEVC 1440p60 | 95.5 / 278.4 ms | 0 / 179 | Failed, black frames | 0 decoded frames |

The HEVC software proxy took 1.04 seconds to generate for six seconds of media. Its three-second preview reported 6 dropped frames out of 179, about 3.4%.

| Six seconds of media, median elapsed time | Software decode | D3D11 decode + download | x264 transcode | CUDA/NVENC transcode |
| --- | ---: | ---: | ---: | ---: |
| Synthetic 1080p60 | 175.1 ms | 747.0 ms | 884.1 ms | 904.2 ms |
| Sample H.264 1080p48 | 148.4 ms | 674.7 ms | 764.5 ms | 758.4 ms |
| Gauntlet HEVC 1440p60 | 553.2 ms | 1121.0 ms | 2055.8 ms | 1377.7 ms |

All eight sampled exported frames matched their captures with SSIM between 0.997593 and 0.999634 after explicit conversion to the output BT.709 YUV420 format. Same-mode SDR patch errors were at most 3/255. Repeated composition seeks and renderer-crash recovery produced identical hashes within each mode. Both exports contained all 150 frames and AAC audio.

The four flash/pulse checks per mode found the video flash at the expected frame and audio onset approximately 0.042 ms later. Video timing resolution is 33.3 ms; the audio sample offset does not imply sub-frame video synchronization precision.

Controller event-loop p95 was 16.1 ms during GPU rendering and 16.1 ms during software rendering. This includes Windows timer granularity and is not a command round-trip measurement.

## Interpretation

The capture path spends substantial time waiting for seeks and browser paint, then reading frames back to CPU memory. Each five-second export transfers 1.244 GB of BGRA pixels through Node and an FFmpeg pipe. This result measures that implementation, including startup of the encoder, flushing, and four saved PNG samples. It does not measure a sequential decoder or shared GPU textures.

The FFmpeg cases use the first six seconds of each source, three serial samples, and warm filesystem caches. They include process startup and disk I/O. D3D11 decode returns frames to CPU memory. CUDA/NVENC keeps the decode/encode path on the GPU. x264 uses `fast`/CRF 20, while NVENC uses `p4`/CQ 20; the same numeric quality setting does not establish equal visual quality. These transcodes do not contain browser composition.

Chromium telemetry confirms D3D11 video decoding and enabled GPU composition in the default run. The forced software run reports FFmpeg video decoding for H.264 and disabled GPU composition. The tiny VFR fixture uses software decoding even in the default run, demonstrating that acceleration must be reported per stage and source.

The Intel QSV attempts fail with `Error creating a MFX session: -9`, both with automatic device selection and an explicit Intel D3D11 adapter. This is a failure of the tested build/driver configuration, not evidence that the Intel hardware cannot encode.

Direct HEVC preview with Chromium acceleration disabled produces black video, zero decoded frames, and an advancing playback clock. An explicit FFmpeg CPU decode to an H.264 proxy restores preview, with some dropped frames. This establishes one preview fallback experiment. It does not implement original-resolution software export of arbitrary HEVC projects.

GPU and software captures differ in SDR color despite using the same source tags and forced sRGB browser output. Each exported file closely matches the capture from its own mode, but that is insufficient to establish consistent color when switching paths. The maximum observed patch difference is 13/255, above this experiment's 5/255 tolerance. The conversion cause is unresolved and must be investigated before accepting the renderer.

Preview measurements cover three seconds of muted playback in an offscreen window with two animated overlays and one visible video. They are not sustained visible-GUI playback or live audio-sync acceptance tests. Ten seeks give only a small sample; their nearest-rank p95 equals their maximum.

## Prototype checklist

| Requirement from the technical overview | Evidence/status |
| --- | --- |
| CLI starts independent engine; Electron attaches and receives edits | Untested, engine and editor are absent |
| Editing/export after closing GUI | Hidden rendering process exports, but the actual GUI-close/headless-edit workflow is unimplemented |
| Deterministic graphic seeks and frame readiness | Passed for the fixed local HTML fixture and generated media |
| Trimmed media, dissolve, overlapping graphics, offline synchronized audio | Passed in a fixed five-second composition |
| Stretching and project-frame-rate changes preserve timing | Untested |
| VFR frame selection | Passed at nine requested times using actual PTS and encoded frame identities |
| VFR audio synchronization | Untested; audio/flash export test uses CFR footage |
| SDR color consistency | Same-mode export checks pass; GPU/software preview consistency fails |
| Worker failure isolation | Forced renderer crash and reload passes; project-state survival is untested |
| Hardware and software fallback | NVIDIA path works; native software HEVC fails; explicit H.264 proxy works; Intel QSV fails; AMD untested |
| Preview/seek/export/transfer measurements | Measured on this machine with the limits above |
| Command responsiveness under rendering | Engine absent; only the standalone controller event loop was observed |
| Agreed numerical performance targets | Not yet agreed |

## Next work

Resolve the GPU/software color difference and compare the current seek/capture implementation against sequential source decoding and a cheaper frame-transfer path. Keep source-decoding fallback explicit, including HEVC. Investigate a newer pinned FFmpeg build for Intel QSV before rejecting that path.

Then prove the smallest complete engine workflow: one persistent project process, CLI import/edit, an attached GUI receiving the same change, GUI close, and original-media export. Measure real command round trips while exporting. Do not count the benchmark controller as that engine.

Suggested targets for agreement, not current acceptance criteria: at most 1% preview frame drops over 30 seconds at 1080p60; p95 seek-to-frame below 150 ms using an allowed proxy; at least real-time 1080p30 composed export; p95 engine command response below 50 ms under render load. These short experiments do not establish those targets, and the present capture path falls below the suggested export rate.
