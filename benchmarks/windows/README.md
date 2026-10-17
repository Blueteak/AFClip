# Windows rendering experiments

This is a measurement tool, not the Reelet editor or its shared project engine. It exercises the provisional FFmpeg/Electron pipeline described in the [technical overview](../../Reelet-Technical-Overview.md). See [the measured results](../../docs/windows-benchmark-results.md) for findings and untested requirements.

## Run

Use Windows, Node.js 22.12 or newer, and npm:

```powershell
npm ci
npm run bench:windows -- --source "D:\Recordings\example.mp4"
```

Repeat `--source` to include more footage. Supply clips at least six seconds long with a video track. With no sources, the run uses generated fixtures only. First installation downloads the pinned Electron and FFmpeg tools. These are experimental dependencies, not approved application distribution bundles. The FFmpeg package currently contains FFmpeg 6.1.1 and the probe package contains ffprobe 4.0.2; the report records the actual binaries.

To repeat only the Chromium experiments and output verification after changing the capture path, use `npm run bench:windows -- --resume ".cache/windows-benchmark/<run-directory>"`. This retains the earlier FFmpeg timings, overwrites that run's Chromium outputs, and records a separate rendering rerun timestamp.

The runner writes a unique directory under `.cache/windows-benchmark/`. It includes `results.json`, per-mode Chromium reports, command logs, source metadata, generated fixtures, captures and composed MP4s. Files passed through `--source` are read without modification. Media stays local and is excluded from Git. Allow a few minutes and several hundred MB of disk space. Electron runs in hidden offscreen windows.

## Measurements

- Three serial samples each of software decode, D3D11 decode with CPU readback, x264 transcode, and CUDA/NVENC transcode. The six-second intervals include startup, disk I/O and encoder flushing. Encoder presets are recorded; these are not equal-quality encoder comparisons.
- Intel QSV initialization and encode, with an explicit Intel adapter retry if automatic selection fails. Hardware failures remain visible in the report.
- Ten nonsequential seeks per source, including capture time. Three seconds of muted single-video preview with two animated HTML overlays. Frame counters detect dropped frames and the false success where audio advances without any decoded video frames.
- Default Chromium acceleration and explicitly disabled acceleration. Chromium Media telemetry records decoder selection. A failed direct software preview is retried through an explicit FFmpeg software decode to a six-second 1080p H.264 proxy.
- A five-second 1080p30 export containing two trimmed video segments, a one-second dissolve, overlapping HTML graphics and offline mixed audio. The default mode encodes with NVENC; the software mode uses x264. An NVENC export failure does not silently switch paths.
- Per-frame render/readiness, capture, bitmap conversion and pipe-write timings. The CPU BGRA path transfers 1.244 GB for 150 frames. It does not use shared GPU textures.
- Controller event-loop delay while the rendering process works. This is not project-engine command latency.

## Correctness probes

The generated VFR fixture has frame values that identify their source index. The runner compares seeks against ffprobe presentation timestamps, including times within a long frame interval. Other checks compare repeated composition hashes after arbitrary seeks, capture dimensions, export frame count, four captured/exported frames with SSIM above 0.98 in BT.709 YUV420, six SDR patches within five 8-bit code values, and audio pulse versus video flash onset within one 30 fps frame. It also compares GPU and software preview color patches against each other. These local tolerances are correctness checks, not agreed product performance targets.

The renderer is deliberately crashed after export and reloaded. A successful recovery establishes that its controller survived and reproduced the same pixels. It does not establish project-engine isolation or persistence.

The runner exits nonzero for failed generated-fixture correctness checks or an incomplete Chromium run. Optional hardware initialization failures and native source failures remain recorded separately. Always inspect those statuses, even when the exit code is zero. A proxy fallback establishes preview compatibility only; export must eventually decode original media through the worker implementation.

## Limits

These are short, serial experiments on one machine with warm filesystem caches, not sustained-load or installation tests. Preview is muted and offscreen. Export uses explicit seeks and two animation-frame waits before capture. This simple path measures its own synchronization overhead as well as media work. It cannot establish the performance of a future sequential decoder or shared-texture implementation.

No project commands, GUI/CLI collaboration, autosave, edit locks, undo, frame-rate changes, speed changes, VFR audio export, graphic sandbox enforcement, or export cancellation are implemented here. The fixed local HTML fixture is trusted test code, not a sandbox for arbitrary user graphics. HDR and AMD hardware are untested.

References: [Electron offscreen rendering](https://www.electronjs.org/docs/latest/tutorial/offscreen-rendering), [capturePage](https://www.electronjs.org/docs/latest/api/web-contents#contentscapturepagerect-opts), [FFmpeg options](https://ffmpeg.org/ffmpeg.html).
