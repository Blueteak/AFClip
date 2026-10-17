# Continuous timeline playback

The Program monitor plays the current timeline with synchronized audio. Space or the central transport button toggles playback. Frame stepping, edit-point navigation, timecode entry, and both rulers seek the same preview session. Scrubbing temporarily silences playback, updates the picture while dragging, and resumes on release if playback was running. Pause and seek settle on the requested project frame. Playback stops on the last frame; Play there restarts at zero. In/Out marks continue to define the export range.

The existing dark layout, icons, menus, and tooltips are retained. Enter and the aperture button still render a full-resolution frame from original media. The Export tab remains a separate player for the last finished MP4.

## Implementation

### Direct GPU preview

GPU mode now uses Chromium's native video decoding and composition in the Program monitor. Original source video stays in the browser media pipeline; playback no longer copies each frame through FFmpeg RGBA, an offscreen bitmap, JPEG encoding and base64 IPC. The project-sized composition supports full 1920×1080 presentation. The monitor scales it to its available display area without creating a 540p intermediate.

The preparation worker still snapshots accepted graphics, indexes source timestamps and mixes audio. It keeps those resources alive until the session closes. The GUI receives allowlisted local media URLs, uses the shared timeline evaluator for visibility/transforms/fades/dissolves, and renders graphics in sandboxed iframes using explicit source times. The mixed WAV remains the playback clock. Video elements follow source speed and make small rate corrections against that clock; upcoming clips are prepared one second ahead, and distant video elements are released.

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

## Direct preview measurements, October 17, 2026

The full 64-second Vellum edit ran as a disposable **1920×1080, 60 fps** project, with all seven dissolves, both animated titles and mixed audio. The Program monitor occupied 1920×1080 physical pixels at device-pixel ratio 1. Chromium reported `D3D11VideoDecoder` and platform video decoding on the RTX 5080. The same Core Ultra 9 285K / RTX 5080 / 64 GB system was used.

Chromium's cumulative presented-frame counts measured **55.8–56.6 fps per shot**. The GUI made 3,622 animation updates; its longest update interval was 97.4 ms. No large video/audio clock resynchronizations occurred. Callback counts alone were lower for some shots because a callback can span multiple presented frames. Counts from overlapping clips are not added to claim a composition frame rate. These results **do not meet the 60 fps target**.

A separate FFmpeg D3D11VA control decoded 720 original 1440p60 HEVC frames in 1.702 seconds, about **423 fps**, without composition or presentation. A native-video-only Electron control also missed 60 fps. Disabling frame-rate limiting or vsync did not resolve the loss; those diagnostic switches are not enabled in Reelet. The evidence supports investigating Chromium/Windows presentation pacing next, not reducing the target or assuming insufficient decode capacity. It does not yet identify the exact cause.

Paused previews at project seconds 2, 8 and 60 selected the expected source presentation timestamps, including both sides of a dissolve. Rapid requests for 8, 1, 60 and 2 seconds settled on 2. The opening-title sample matched the full-resolution software export frame with **SSIM 0.993816**. Visual inspection caught and fixed an iframe color-scheme mismatch that had made transparent graphics opaque. This sample is not a complete color-management validation or an audio audition.

[Recorded measurements](playback-performance.json) preserve the results, hardware and local artifact location. Full callback and media-decoder telemetry is retained in that artifact directory.

Manual lifecycle checks switched GPU → software → GPU, confirmed an engine edit replaced the preview session, and confirmed undo refreshed it again. A half-second 1080p60 software export across a dissolve passed full verification with 30 decoded video frames and audio. JavaScript syntax and diff-whitespace checks passed. No always-run tests were added.

## Current limits

The agreed throughput target is **sustained 60 fps at full 1920×1080**, using a 60 fps version of the representative edit with original footage, titles, dissolves and synchronized audio. The original 24.6 fps result at 540p is not acceptable against this target. Seek-latency targets are deferred.

Run `node benchmarks/windows/playback.cjs` for a visible full-size measurement. It creates a disposable 1080p60 copy of the example project, leaves the original project unchanged, runs the production GUI with a 1920×1080 monitor at device-pixel ratio 1, and records per-source `requestVideoFrameCallback` timestamps, Chromium presented-frame counts, dropped-frame counters, decoder identity and display/GPU information. A project path and measurement length in seconds can be supplied as positional arguments. Artifacts go under `.cache/playback/`. A 1080p viewport that fits on screen is required. This is an opt-in diagnostic, not an always-run test suite.

The session prepares the whole timeline's audio and source indexes before its first preview. Edits rebuild that session, so a large edit or uncached source can take longer to become ready. Long-GOP footage still makes distant seeks slower than frame stepping. Native preview prepares upcoming clips one second ahead; proxy generation and broader predictive decoding are not implemented.

Picture delivery can drop below the project frame rate, especially with software decoding or multiple overlapping sources. Audio remains the playback clock. The measurements above do not constitute an audition or a physical audiovisual latency measurement. Broken sources or graphics stop the preview session with an error while the editor remains usable.
