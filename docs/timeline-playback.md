# Continuous timeline playback

The Program monitor plays the current timeline with synchronized audio. Space or the central transport button toggles playback. Frame stepping, edit-point navigation, timecode entry, and both rulers seek the same preview session. Scrubbing temporarily silences playback, updates the picture while dragging, and resumes on release if playback was running. Pause and seek settle on the requested project frame. Playback stops on the last frame; Play there restarts at zero. In/Out marks continue to define the export range.

The existing dark layout, icons, menus, and tooltips are retained. Enter and the aperture button still render a full-resolution frame from original media. The Export tab remains a separate player for the last finished MP4.

## Implementation

### Direct GPU preview

GPU mode now uses Chromium's native video decoding and composition in the Program monitor. Original source video stays in the browser media pipeline; playback no longer copies each frame through FFmpeg RGBA, an offscreen bitmap, JPEG encoding and base64 IPC. The project-sized composition supports full 1920×1080 presentation. During playback, the monitor scales it to its available display area without creating a 540p intermediate. Paused seeking uses the lower-resolution cache described below.

The preparation worker still snapshots accepted graphics, indexes source timestamps and mixes audio. It keeps those resources alive until the session closes. The GUI receives allowlisted local media URLs, uses the shared timeline evaluator for visibility/transforms/fades/dissolves, and renders graphics in sandboxed iframes using explicit source times. The mixed WAV remains the playback clock. Video elements follow source speed and make small rate corrections against that clock; upcoming clips are prepared one second ahead and start hidden half a second before visibility, where source handles permit. This lets decoder startup and faster clock correction finish before a cut or dissolve. Distant video elements are released.

On Windows, the editor defaults to Chromium's GPU-backed EGL window compositor with `disable-direct-composition` and `disable-gpu-vsync`. This avoids a hardware-vblank wait fallback observed on the development PC; hardware video decoding and GPU composition remain enabled. Chromium's frame-rate limiter remains enabled. Export workers keep their own settings. To compare the original path, launch `npm start -- examples/vellum-first-edit --presentation direct-composition`, or set `REELET_PRESENTATION=direct-composition` for the editor or benchmark. `compatibility` selects the Windows workaround explicitly; `default` leaves Chromium's presentation switches untouched. Other platforms default to `default`.

Paused seeks select a source presentation interval from the existing timestamp index. Repeated seeks retain the latest request. Native continuous playback follows each source's media clock, so it is a responsive editing preview, not a frame-by-frame verification of the exported timeline. In particular, higher-rate source video can remain smoother than a lower-rate project during playback. Enter still renders the exact project frame through the export compositor.

Native playback depends on Chromium's support for the source codec/container and installed decoder. An unsupported source reports an error with the software-rendering alternative. Software mode retains the previous 540p compositor below. Export decoding, composition and encoding are unchanged.

### Previous compositor and software fallback

The GUI opens a disposable Node preparation worker and a persistent Electron compositor for a snapshot obtained from the project engine. Preview does not acquire the editing lock. A committed GUI or CLI change pauses playback, invalidates the old session, and refreshes the picture when automatic preview updates are enabled. Export and explicit full-resolution inspection retain their existing editing locks.

Preparation reuses export's source timestamp indexes, accepted graphic snapshots, and offline stereo 48 kHz audio mix. The mix includes all enabled tracks, source trims, speed and pitch changes, clip volume/mute, fades, and dissolve audio crossfades. Chromium plays that WAV through a byte-range-capable local media protocol. Its audio clock drives both the playhead and picture requests, including gaps and silent sections.

Preview uses the same compositor, timeline evaluator, graphic sandbox, and explicit graphic playback times as export. It decodes at up to 960 by 540, preserving the project's logical composition dimensions. The GPU setting requests D3D11 video decoding; a failed hardware decode retries in software. The CPU setting uses software decoding and composition. Export continues to use original-resolution software decoding and its existing GPU or software encoder.

Only one picture is rendered at a time. The worker retains the newest waiting request, and seek generations prevent older results from replacing newer selections. Sequential frames reuse decoders; larger or backward seeks reopen them at indexed source timestamps. Frames more than 250 ms behind the audio clock are discarded during playback. The monitor receives JPEG frames; paused preview is temporally exact, while Enter provides the original-resolution PNG inspection path.

Windows Electron closes stdin, so the Node worker relays control over an authenticated loopback socket. Closing or replacing a session stops its subprocesses and removes its temporary audio, graphics, and profile. A failed worker reports an error without stopping the project engine; another seek can open a fresh session.

## Initial compositor checks, October 17, 2026

Checks used the existing 64-second Vellum edit on the documented Core Ultra 9 285K / RTX 5080 Windows machine, with 1440p60 HEVC sources and a 30 fps timeline. These are individual runs, not performance guarantees.

- An eight-second GPU preview starting at 5.5 seconds displayed 197 frames, about 24.6 fps, across cuts and dissolves. Audio started at 5.5 seconds and advanced 7.95 seconds. The largest measured difference between a displayed frame's requested time and the audio clock at delivery was 112 ms. This measures delivery, not physical speaker/display latency.
- Seven arbitrary seeks, including animated titles and distant cuts, settled at the requested frame and audio position in 390–766 ms with cached source indexes. A subsequent adjacent-frame step took 23 ms. Six rapid seeks spaced 20 ms apart settled on the final request in 1.08 seconds measured from the first request, without displaying stale seek results.
- Playback stopped at frame 1919, the final frame of the 64-second edit. A disposable project copy verified that a track-disable edit paused playback and replaced the preview session, and undo refreshed it again. The engine reported no preview render lock.
- A GPU preview sample at two seconds visually retained the opening graphic and composition. Compared with the full-resolution software frame downscaled to preview size, SSIM was 0.9765, including JPEG compression and scaling differences.
- A one-second software export across a dissolve passed full verification: 30 decoded video frames, 30 video packets, and 48 audio packets. The GUI was visually inspected with the added transport control. Clicking Play and pressing Space to pause landed on the displayed frame; switching between GPU and software preview produced the same selected frame. JavaScript syntax and diff whitespace checks passed. No always-run test suite was added.

## Initial direct preview measurements, October 17, 2026

The full 64-second Vellum edit ran as a disposable **1920×1080, 60 fps** project, with all seven dissolves, both animated titles and mixed audio. The Program monitor occupied 1920×1080 physical pixels at device-pixel ratio 1. Chromium reported `D3D11VideoDecoder` and platform video decoding on the RTX 5080. The same Core Ultra 9 285K / RTX 5080 / 64 GB system was used.

Before the presentation pacing fix, Chromium's cumulative presented-frame counts measured **55.8–56.6 fps per shot**. The GUI made 3,622 animation updates; its longest update interval was 97.4 ms. No large video/audio clock resynchronizations occurred. Callback counts alone were lower for some shots because a callback can span multiple presented frames. Counts from overlapping clips are not added to claim a composition frame rate. These initial results **did not meet the 60 fps target**.

A separate FFmpeg D3D11VA control decoded 720 original 1440p60 HEVC frames in 1.702 seconds, about **423 fps**, without composition or presentation. A native-video-only Electron control also missed 60 fps. Disabling frame-rate limiting or GPU vsync alone did not resolve the loss. The subsequent investigation below identified the presentation wait.

Paused previews at project seconds 2, 8 and 60 selected the expected source presentation timestamps, including both sides of a dissolve. Rapid requests for 8, 1, 60 and 2 seconds settled on 2. The opening-title sample matched the full-resolution software export frame with **SSIM 0.993816**. Visual inspection caught and fixed an iframe color-scheme mismatch that had made transparent graphics opaque. This sample is not a complete color-management validation or an audio audition.

[Recorded measurements](playback-performance.json) preserve the results, hardware and local artifact location. Full callback and media-decoder telemetry is retained in that artifact directory.

Manual lifecycle checks switched GPU → software → GPU, confirmed an engine edit replaced the preview session, and confirmed undo refreshed it again. A half-second 1080p60 software export across a dissolve passed full verification with 30 decoded video frames and audio. JavaScript syntax and diff-whitespace checks passed. No always-run tests were added.

## Windows presentation pacing investigation, October 17, 2026

A four-second Chromium trace found 226 `WaitForVSync Sleep` events consuming 3.974 seconds on the presentation thread. Each fallback wait took roughly 17.4–18 ms, limiting submissions to about 56.7 fps while decode and GPU composition had spare capacity. Chromium 152's [Windows VSync implementation](https://github.com/chromium/chromium/blob/152.0.7977.167/ui/gl/vsync_thread_win.cc) rounds a failed or early hardware-vblank wait up to an integer-millisecond sleep. The trace identifies the fallback; it does not establish why the Windows hardware wait fails on this machine.

Using the EGL window compositor **and** disabling GPU vsync bypassed that wait. Either switch alone was insufficient. The native-video control then scheduled about 60 updates per second with zero reported dropped frames. No driver settings were changed, and `disable-frame-rate-limit` is not enabled. This is evidence that 1080p60 is feasible on this hardware, not a reason to lower the target.

Upcoming clips now pre-roll for half a second while hidden. Their media clocks catch up before visibility, with bounded rate corrections only when needed. During pre-roll only, a 1×1 canvas consumes the current video frame each animation tick: otherwise Chromium's [hidden-video compositor](https://github.com/chromium/chromium/blob/152.0.7977.167/third_party/blink/renderer/platform/media/video_frame_compositor.cc) falls back to a 250 ms timer. Visible playback still presents the source video directly and follows the mixed audio clock; paused frame selection and the export path are unchanged.

The final full **64-second 1080p60 run** measured **59.998–60.000 fps on all seven incoming shots**, including dissolves and the closing title. The opening shot averaged **59.882 fps**, with one 33.3 ms startup callback interval. Every shot had a 95th-percentile callback interval of 16.7–16.8 ms. Chromium reported **zero dropped video frames during visible intervals**, measured at the visibility boundaries as well as periodically; hidden pre-roll drops are excluded. The GUI made 3,845 updates, with a maximum interval of 22.6 ms, and no large clock resyncs. Incoming video clocks stayed within 6.1 ms of their expected audio-clock position; the opening shot stayed within 16.8 ms. This establishes 60 fps steady-state playback on the representative workload, with an opening startup interval still present.

The benchmark now records presentation switches, per-frame media-clock errors and playback rates, and dropped-frame counters at shot boundaries. Earlier pre-roll experiments sometimes lost frames in the first half-second of a shot, which the boundary samples help expose. The final artifacts are `.cache/playback/2026-10-17T17-23-33-326Z`; [recorded measurements](playback-performance.json) retain the original 56 fps baseline alongside the new results.

Paused source-frame selection at 2, 8 and 60 seconds and rapid seeks passed again. The opening title still matched the software reference with SSIM 0.993816. GPU → software → GPU switching, edit invalidation and undo passed. Syntax and diff checks passed; no always-run tests were added.

These measurements concern Chromium's submitted/presented-frame counters. They do not measure physical monitor scanout, tearing, speaker latency, or audiovisual perception. The workaround needs validation on other Windows displays and drivers before treating it as universal.

## 1440p headroom measurement, October 17, 2026

Two full 64-second runs at **2560×1440 physical pixels, 60 fps** used the same original footage, seven dissolves, titles and mixed audio. Every shot measured **59.998–60.000 fps after its first 0.6 seconds**. Whole-shot averages ranged from **59.11 to 60.00 fps** because startup losses remain: the runs reported **8 and 9 dropped source frames during visible intervals**, concentrated around incoming shots. The 95th-percentile callback interval stayed at 16.7–16.8 ms; the largest callback interval was 33.4 ms. There were no large clock resyncs. These repeats show that the prior zero-drop 1080p run should not be read as a guarantee of drop-free clip starts.

Thirty whole-GPU `nvidia-smi` samples during the first run averaged **4% GPU utilization**, with a **9% peak**. Video-decoder utilization averaged **10.7%**, peaking at **33%**. These coarse, roughly one-second samples include other desktop work and can miss short spikes. They support spare GPU capacity, not a precise multiplier for maximum throughput.

1440p has **77.8% more output pixels than 1080p**, and sustained playback remains at 60 fps. There is resolution/composition headroom on this PC. Both measurements already decode the same original 1440p sources, so this is not an increase in decode workload. The remaining misses are concentrated at shot startup rather than sustained saturation. A 60 Hz presentation measurement cannot establish maximum fps or how many additional effects or layers fit. [Recorded runs and utilization](playback-1440p-performance.json) preserve both results.

## Seeking and scrubbing, October 17, 2026

The current target is **25 ms request-to-picture latency at the 95th percentile**, plus **60 fps picture updates during continuous scrubbing**. These are separate requirements: a 25 ms serial seek loop can produce only 40 updates per second. New pointer positions must supersede old requests without accumulating a queue. Releasing the pointer must settle on the exact selected frame. Measure cold, resident and cached requests separately after preview-session preparation; report preparation time separately rather than counting it as a seek.

The first native-path diagnostic at 1080p60 measured the following isolated requests. Each category has 12 samples. The endpoint waits for the requested source presentation timestamp on every visible video, preview/graphic readiness, and one further animation frame. It is conservative browser-side presentation evidence, not physical scanout timing. The small sample set is exploratory.

| Request | Original footage median / p95 | Intraframe control median / p95 |
| --- | --- | --- |
| Forward frame step | 170 / 177 ms | 38 / 46 ms |
| Backward frame step | 173 / 248 ms | 37 / 44 ms |
| Nearby seek | 63 / 312 ms | 36 / 43 ms |
| Distant seek, original sources | 325 / 394 ms | Not compared |

Distant requests took 183–394 ms, improved against the earlier 390–766 ms compositor measurements. Frame stepping regressed against the earlier 23 ms adjacent-step sample. Most of the native request time was spent in video positioning, with graphics acknowledgements typically taking only a few milliseconds. The control replaced only the first source with full-resolution 1440p60 H.264 containing an independently decodable frame at every timestamp; the player code stayed the same. Its 12 seconds took 3.72 seconds to encode and occupied about 553 MiB. This is a diagnostic encoding, not a production cache preset. It establishes a major codec-dependent cost but does **not** meet the 25 ms target.

Google's [RAIL guidance](https://web.dev/articles/rail) treats dragging as animation, with roughly 16.7 ms between frames at 60 Hz and a suggested 10 ms application work budget. Its 50 ms response-processing guideline explicitly excludes dragging. [Puget's Premiere benchmark](https://www.pugetsystems.com/pugetbench/creators/premiere-pro/) measures processing through export/Null Encoder workflows rather than publishing click-to-picture seek latency. These sources do not establish a Premiere or Resolve 25 ms seek guarantee. [Adobe proxies](https://helpx.adobe.com/uk/premiere/desktop/organize-media/ingest-proxy-workflow/create-proxies.html) and [Apple optimized media](https://support.apple.com/en-az/guide/final-cut-pro/verb8e5f6fd/12.4/mac/26.6) support using editing-friendly media to improve responsiveness.

The bounded decoded-frame cache and seek-media tracer bullet is now implemented and measured below. Original media remains authoritative for export and exact source-frame selection. [Raw measurements and control details](seeking-performance.json) preserve the baseline. Run `node benchmarks/windows/playback.cjs examples/vellum-first-edit 64 1080 --seek` for the opt-in isolated-seek diagnostic.


### Bounded seek cache results

The existing preparation worker now makes independently decodable JPEG packets for each used video source range, including transition handles. Source pictures fit within 960×540 without upscaling. The worker explicitly converts supported BT.709 SDR input to full-range JPEG color. A packet index maps the original source-frame ordinal to a byte range; the existing source PTS index selects that ordinal, including VFR footage. Graphics, transforms, fades and dissolves still render through the same timeline evaluator at project resolution. Playback, export and Enter inspection use originals.

Packets live in regenerable project cache/seek-preview files keyed by source identity, used frame range and encoding settings. The disk budget and decoded-bitmap budget are each project.cacheLimitBytes (default 256 MiB, capped at 512 MiB), not a combined process-memory cap. Old range files are evicted; incomplete or over-budget encodes are discarded. Decoded bitmaps evict speculative frames before least-recently-used requested frames. Range fetches are cancellable and newer selections supersede older work. A missing/corrupt/uncovered proxy falls back to native source decoding. Original fallback also retains nearby decoded frames and looks ahead eight frames while paused, without retaining decoder-owned surfaces.

Final 1080p60 monitor measurement, cache format 2:

| Interaction | Median | p95 | Within 25 ms |
| --- | ---: | ---: | ---: |
| Forward frame step | 18.6 ms | 19.9 ms | 12/12 |
| Backward frame step | 10.0 ms | 18.7 ms | 12/12 |
| Nearby seek | 6.9 ms | 19.0 ms | 12/12 |
| Distant seek, including dissolves/titles | 10.9 ms | 20.5 ms | 12/12 |

Cached forward/backward reversals delivered 120/120 correct pictures over 2.0002 seconds (59.994 updates/sec). A sweep through frames not yet decoded in memory delivered 60/60 over 1.0001 seconds (59.994 updates/sec). Exact release took 16.9 and 16.0 ms respectively. Earlier development runs occasionally missed one sweep deadline; this is a measured result, not a guarantee for every machine or project. The small isolated samples make each category's p95 its maximum.

All eight source ranges took **30.49 seconds** to prepare and **218.2 MiB** on disk; reopening reused them in **6–7 ms**. End-of-run decoded bitmaps occupied **172.0 MiB**, within the separate 256 MiB limit. These costs are excluded from interaction latency. This initial implementation decoded from the source beginning; the background-generation follow-up below removes that cost. Over-budget ranges remain on the slower original path. The native long-GOP decoder remains the unresolved bottleneck there; its baseline distant seeks took 183–394 ms.

The diagnostic now wakes on readiness events and waits for the next animation frame, removing an extra animation-frame polling delay from the earlier baseline method. This measurement improvement must not be attributed to the cache. Results estimate browser request-to-picture readiness, **not physical display scanout**. Run the same opt-in --seek benchmark for isolated requests, continuous drags, release, cache size and preparation telemetry.

Manual checks covered a 90-frame VFR source with 33/100 ms intervals: independently selected first/middle/last packet bytes matched FFmpeg's corresponding frame encodes exactly, and reopening reused the cache. Titles and dissolves displayed the selected source timestamps; rapid reversals settled on the latest request. A forced missing URL fell back to the exact original frame. A 4 MiB bitmap budget stayed bounded. Seek-to-play used original video; GPU/software switching, edit invalidation, undo and bitmap release on close passed. A full 64-second playback run retained steady 60 fps but reported 14 startup-related source-frame drops, consistent with the previously documented variable clip-start issue. No always-run tests were added.

Artifacts: .cache/playback/2026-10-17T17-58-31-209Z/seeks.json (final format), .cache/playback/2026-10-17T17-54-03-057Z/results.json (playback), .cache/seek-perf/vfr-check.json (packet identity). Committed measurements below retain the baseline alongside the new result.


### Background generation and invalidation follow-up

Preview no longer waits for seek-media encoding. It loads reusable cache indexes, reports ready, and generates missing ranges in the existing worker. Each finished source attaches to the live preview without moving the playhead or restarting playback. Until then, original decoding supplies the picture. Closing or replacing a session cancels its background subprocesses; stale updates are rejected by session ID.

Cache invalidation follows source identity and coverage:

- Title, transform, volume, layout and project-frame-rate changes reuse source packets if the required source range is still covered.
- A shorter trim reuses a containing range. Extending beyond that range, changing source-in beyond coverage, or adding transition handles beyond coverage rebuilds that source range. Incremental extension is not implemented.
- Source path, file size, modification time or cache encoding version changes invalidate that source. This is a metadata fingerprint, not a full content hash.
- Every project edit still replaces the preview snapshot and its decoded bitmap cache. Disk packets survive when valid; audio/graphics are prepared for the new snapshot. Unneeded range files remain eligible for eviction.

Accurate FFmpeg input seeking now starts decoding at the preceding keyframe rather than frame zero. Source selection still uses the original PTS index, with microsecond rounding downward at the seek boundary. Filter and JPEG encoder thread counts are bounded; leaving decoder threading automatic was substantially faster than restricting it to two threads.

On the same representative edit, with source indexes already cached but **no seek media**, first picture appeared in **1.03 seconds** after diagnostic startup, the first seek range arrived at **2.75 seconds**, and all eight ranges finished in **17.07 seconds** of background work while playback continued. That is **44% less generation time** than the initial 30.49-second blocking build. Disk use stayed at 218.2 MiB. This does not remove initial audio/index preparation or guarantee 25 ms for a range still being generated.

A subsequent muted seek run measured p95 **20.3 / 18.3 / 22.5 / 20.6 ms** for forward / backward / nearby / distant requests. All 48 isolated requests met 25 ms. Cached reversals delivered 119/120 pictures at the next display tick; the new-frame sweep delivered 60/60. Releases took 16.2 and 17.1 ms. Occasional missed display deadlines remain, even though the isolated latency target is met.

All eight shortened ranges reused their existing files with no encodes (10.6 ms lookup). Independently decoded frames at source times 46.5, 51 and 55.5 seconds matched the seek packets byte-for-byte after the input-seeking change; the VFR packet check also passed. Playback diagnostics now mute the WebContents audio output from window creation while retaining the real audio clock. Normal GUI playback remains audible; CLI edits do not open a player.

Artifacts: .cache/seek-perf/background-muted.json, .cache/seek-perf/background-muted/seeks.json, and .cache/seek-perf/reuse-accuracy.json.


### Broader seek coverage and final scrub check

The opt-in diagnostic now includes 120 seeded positions across the full timeline, enough distinct frames to exceed the decoded-bitmap cache, plus 120 forward/reverse samples through a dissolve. The first broader run met p95 (21.8 ms) but exposed three 66–70 ms presentation stalls despite source readiness in 5–8 ms. Paused proxy seeks were still warming original-video decoders and copying their frames. Removing that unnecessary work eliminated those long stalls in the next run (120/120 under 25 ms). Playback retains its original-media warmup.

The GUI also rebuilt the monitor, playhead and transport button multiple times per drag sample. Seeking now uses its existing synchronous state notification for the monitor redraw and only changes the transport icon when play/pause state changes.

Final muted run at a 1920×1080 monitor:

| Check | Result |
| --- | --- |
| 120 seeded timeline seeks | Median 17.7 ms; p95 20.7 ms; maximum 24.5 ms; 120/120 within 25 ms |
| Forward / backward / nearby / distant p95 | 19.9 / 18.3 / 22.5 / 19.0 ms; all 48 requests within 25 ms |
| Cached reversals | 120/120 correct pictures over 2.0001 s |
| New-frame sweep | 60/60 correct pictures over 1.0002 s |
| Dissolve reversals | 120/120 correct pictures over 2.0000 s |
| Release after each scrub | 16.7 / 17.0 / 16.9 ms, exact selected frame |

This verifies the 25 ms p95 and nominal 60 Hz scrub targets for the representative prepared edit, including bitmap eviction and overlapping video. It remains a browser-readiness measurement, not physical scanout or a guarantee across arbitrary hardware, codecs and graphics. Earlier occasional stalls remain documented rather than erased.

Final lifecycle checks verified Play/Pause button state, original-video resume, a forced unavailable-proxy fallback selecting the correct source frame, bounded bitmap eviction, GPU/software switching, edit invalidation, undo and resource release. The existing worker and project-engine boundary is preserved. The background-generation and cache-identity measurements above remain applicable. Unprepared, corrupt or over-budget ranges retain the documented long-GOP bottleneck; reducing that further would require additional source decoding or cache coverage work.

Artifacts: .cache/seek-perf/broad-before.json, .cache/seek-perf/broad-no-warmup.json and .cache/seek-perf/background-muted/seeks.json. Summary and source-frame evidence are retained in seeking-performance.json. Syntax and diff checks passed; no always-run tests were introduced.

### Paused original-resolution refinement

Fast seek pictures are temporary. After 150 ms without another seek, GPU preview positions the visible original videos while retaining the proxy image, then reveals the original decoded frame. Titles and compositing stay at the selected timeline time. Pausing an already-correct original frame keeps it on screen immediately. New seeks, playback and closing/replacing the preview invalidate pending refinement; original decoding never blocks a cached scrub request. This is progressive quality: the 25 ms interaction metric measures the first correct picture, not completion of the original-source decode.

Manual checks at timeline 2, 60, 16, 40, 8 and 56 seconds showed exact selected timestamps with the proxy hidden and each source decoded at 2560×1440, including both sides of dissolves. A newer seek arriving during refinement settled on its own full-quality frame. Captures are in .cache/playback-perf/refined-*.png. The opt-in latency check still measured 120/120 random seeks under 25 ms (p95 20.8 ms, maximum 24.5 ms); the concurrent diagnostic run had one missed next-display sample in each scrub category, within previously observed cadence variability. Diagnostics now use their own Chromium profile to avoid sharing the interactive editor's disk cache.

## Current limits

The agreed throughput target is **sustained 60 fps at full 1920×1080**, using a 60 fps version of the representative edit with original footage, titles, dissolves and synchronized audio. The original 24.6 fps result at 540p is not acceptable against this target. Seeking now targets 25 ms at p95 and 60 fps updates during continuous scrubbing; the prepared-cache path meets those targets on this representative edit, with the limits below.

Run `node benchmarks/windows/playback.cjs` for a visible full-size measurement. It creates a disposable 1080p60 copy of the example project, leaves the original project unchanged, runs the production GUI with a 1920×1080 monitor at device-pixel ratio 1, and records per-source `requestVideoFrameCallback` timestamps, Chromium presented-frame counts, dropped-frame counters, decoder identity and display/GPU information. A project path, measurement length in seconds, and output height can be supplied as positional arguments. For example, `node benchmarks/windows/playback.cjs examples/vellum-first-edit 64 1440` measures 2560×1440. Supported heights are 1080, 1440 and 2160. Artifacts go under `.cache/playback/`. The benchmark requires a display that fits the requested viewport at device-pixel ratio 1. This is an opt-in diagnostic, not an always-run test suite.

The session prepares the whole timeline's audio and source indexes before its first preview. Edits rebuild that session, so a large edit or uncached source can take longer to become ready. Uncovered long-GOP footage still has expensive seeks. Native preview prepares upcoming clips one second ahead and pre-rolls them for half a second when source handles permit. Seek-cache generation runs in the background; uncovered ranges use original decoding until their cache arrives. Source indexing, audio mixing and graphics preparation still precede readiness.

Picture delivery can drop below the project frame rate, especially with software decoding or multiple overlapping sources. Audio remains the playback clock. The measurements above do not constitute an audition or a physical audiovisual latency measurement. Broken sources or graphics stop the preview session with an error while the editor remains usable.
