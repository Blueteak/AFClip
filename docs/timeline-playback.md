# Continuous timeline playback

The Program monitor plays the current timeline with synchronized audio. Space or the central transport button toggles playback. Frame stepping, edit-point navigation, timecode entry, and both rulers seek the same preview session. Scrubbing temporarily silences playback, updates the picture while dragging, and resumes on release if playback was running. Pause and seek settle on the requested project frame. Playback stops on the last frame; Play there restarts at zero. In/Out marks continue to define the export range.

The existing dark layout, icons, menus, and tooltips are retained. Enter and the aperture button still render a full-resolution frame from original media. The Export tab remains a separate player for the last finished MP4.

## Implementation

### Direct GPU preview

GPU mode now uses Chromium's native video decoding and composition in the Program monitor. Original source video stays in the browser media pipeline; playback no longer copies each frame through FFmpeg RGBA, an offscreen bitmap, JPEG encoding and base64 IPC. The project-sized composition supports full 1920×1080 presentation. The monitor scales it to its available display area without creating a 540p intermediate.

The preparation worker still snapshots accepted graphics, indexes source timestamps and mixes audio. It keeps those resources alive until the session closes. The GUI receives allowlisted local media URLs, uses the shared timeline evaluator for visibility/transforms/fades/dissolves, and renders graphics in sandboxed iframes using explicit source times. The mixed WAV remains the playback clock. Video elements follow source speed and make small rate corrections against that clock; upcoming clips are prepared one second ahead and start hidden half a second before visibility, where source handles permit. This lets decoder startup and faster clock correction finish before a cut or dissolve. Distant video elements are released.

On Windows, the editor defaults to Chromium's GPU-backed EGL window compositor with `disable-direct-composition` and `disable-gpu-vsync`. This avoids a hardware-vblank wait fallback observed on the development PC; hardware video decoding and GPU composition remain enabled. Chromium's frame-rate limiter remains enabled. Export workers keep their own settings. To compare the original path, launch `npm start -- /path/to/project --presentation direct-composition`, or set `REELET_PRESENTATION=direct-composition` for the editor or benchmark. `compatibility` selects the Windows workaround explicitly; `default` leaves Chromium's presentation switches untouched. Other platforms default to `default`.

Paused seeks select a source presentation interval from the existing timestamp index. Repeated seeks retain the latest request. Native continuous playback follows each source's media clock, so it is a responsive editing preview, not a frame-by-frame verification of the exported timeline. In particular, higher-rate source video can remain smoother than a lower-rate project during playback. Enter still renders the exact project frame through the export compositor.

Native playback depends on Chromium's support for the source codec/container and installed decoder. An unsupported source reports an error with the software-rendering alternative. Software mode retains the previous 540p compositor below. Export decoding, composition and encoding are unchanged.

### Previous compositor and software fallback

The GUI opens a disposable Node preparation worker and a persistent Electron compositor for a snapshot obtained from the project engine. Preview does not acquire the editing lock. A committed GUI or CLI change pauses playback, invalidates the old session, and refreshes the picture when automatic preview updates are enabled. Export and explicit full-resolution inspection retain their existing editing locks.

Preparation reuses export's source timestamp indexes, accepted graphic snapshots, and offline stereo 48 kHz audio mix. The mix includes all enabled tracks, source trims, speed and pitch changes, clip volume/mute, fades, and dissolve audio crossfades. Chromium plays that WAV through a byte-range-capable local media protocol. Its audio clock drives both the playhead and picture requests, including gaps and silent sections.

Preview uses the same compositor, timeline evaluator, graphic sandbox, and explicit graphic playback times as export. It decodes at up to 960 by 540, preserving the project's logical composition dimensions. The GPU setting requests D3D11 video decoding; a failed hardware decode retries in software. The CPU setting uses software decoding and composition. Export continues to use original-resolution software decoding and its existing GPU or software encoder.

Only one picture is rendered at a time. The worker retains the newest waiting request, and seek generations prevent older results from replacing newer selections. Sequential frames reuse decoders; larger or backward seeks reopen them at indexed source timestamps. Frames more than 250 ms behind the audio clock are discarded during playback. The monitor receives JPEG frames; paused preview is temporally exact, while Enter provides the original-resolution PNG inspection path.

Windows Electron closes stdin, so the Node worker relays control over an authenticated loopback socket. Closing or replacing a session stops its subprocesses and removes its temporary audio, graphics, and profile. A failed worker reports an error without stopping the project engine; another seek can open a fresh session.

## Initial compositor checks, October 17, 2026

Checks used the existing 64-second Sample edit on the documented Core Ultra 9 285K / RTX 5080 Windows machine, with 1440p60 HEVC sources and a 30 fps timeline. These are individual runs, not performance guarantees.

- An eight-second GPU preview starting at 5.5 seconds displayed 197 frames, about 24.6 fps, across cuts and dissolves. Audio started at 5.5 seconds and advanced 7.95 seconds. The largest measured difference between a displayed frame's requested time and the audio clock at delivery was 112 ms. This measures delivery, not physical speaker/display latency.
- Seven arbitrary seeks, including animated titles and distant cuts, settled at the requested frame and audio position in 390–766 ms with cached source indexes. A subsequent adjacent-frame step took 23 ms. Six rapid seeks spaced 20 ms apart settled on the final request in 1.08 seconds measured from the first request, without displaying stale seek results.
- Playback stopped at frame 1919, the final frame of the 64-second edit. A disposable project copy verified that a track-disable edit paused playback and replaced the preview session, and undo refreshed it again. The engine reported no preview render lock.
- A GPU preview sample at two seconds visually retained the opening graphic and composition. Compared with the full-resolution software frame downscaled to preview size, SSIM was 0.9765, including JPEG compression and scaling differences.
- A one-second software export across a dissolve passed full verification: 30 decoded video frames, 30 video packets, and 48 audio packets. The GUI was visually inspected with the added transport control. Clicking Play and pressing Space to pause landed on the displayed frame; switching between GPU and software preview produced the same selected frame. JavaScript syntax and diff whitespace checks passed. No always-run test suite was added.

## Initial direct preview measurements, October 17, 2026

The full 64-second Sample edit ran as a disposable **1920×1080, 60 fps** project, with all seven dissolves, both animated titles and mixed audio. The Program monitor occupied 1920×1080 physical pixels at device-pixel ratio 1. Chromium reported `D3D11VideoDecoder` and platform video decoding on the RTX 5080. The same Core Ultra 9 285K / RTX 5080 / 64 GB system was used.

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

## Current limits

The agreed throughput target is **sustained 60 fps at full 1920×1080**, using a 60 fps version of the representative edit with original footage, titles, dissolves and synchronized audio. The original 24.6 fps result at 540p is not acceptable against this target. Seek-latency targets are deferred.

Run `node benchmarks/windows/playback.cjs` for a visible full-size measurement. It creates a disposable 1080p60 copy of the example project, leaves the original project unchanged, runs the production GUI with a 1920×1080 monitor at device-pixel ratio 1, and records per-source `requestVideoFrameCallback` timestamps, Chromium presented-frame counts, dropped-frame counters, decoder identity and display/GPU information. A project path and measurement length in seconds can be supplied as positional arguments. Artifacts go under `.cache/playback/`. A 1080p viewport that fits on screen is required. This is an opt-in diagnostic, not an always-run test suite.

The session prepares the whole timeline's audio and source indexes before its first preview. Edits rebuild that session, so a large edit or uncached source can take longer to become ready. Long-GOP footage still makes distant seeks slower than frame stepping. Native preview prepares upcoming clips one second ahead and pre-rolls them for half a second when source handles permit; proxy generation and broader predictive decoding are not implemented.

Picture delivery can drop below the project frame rate, especially with software decoding or multiple overlapping sources. Audio remains the playback clock. The measurements above do not constitute an audition or a physical audiovisual latency measurement. Broken sources or graphics stop the preview session with an error while the editor remains usable.
