# Continuous timeline playback

The Program monitor plays the current timeline with synchronized audio. Space or the central transport button toggles playback. Frame stepping, edit-point navigation, timecode entry, and both rulers seek the same preview session. Scrubbing temporarily silences playback, updates the picture while dragging, and resumes on release if playback was running. Pause and seek settle on the requested project frame. Playback stops on the last frame; Play there restarts at zero. In/Out marks continue to define the export range.

The existing dark layout, icons, menus, and tooltips are retained. Enter and the aperture button still render a full-resolution frame from original media. The Export tab remains a separate player for the last finished MP4.

## Implementation

The GUI opens a disposable Node preparation worker and a persistent Electron compositor for a snapshot obtained from the project engine. Preview does not acquire the editing lock. A committed GUI or CLI change pauses playback, invalidates the old session, and refreshes the picture when automatic preview updates are enabled. Export and explicit full-resolution inspection retain their existing editing locks.

Preparation reuses export's source timestamp indexes, accepted graphic snapshots, and offline stereo 48 kHz audio mix. The mix includes all enabled tracks, source trims, speed and pitch changes, clip volume/mute, fades, and dissolve audio crossfades. Chromium plays that WAV through a byte-range-capable local media protocol. Its audio clock drives both the playhead and picture requests, including gaps and silent sections.

Preview uses the same compositor, timeline evaluator, graphic sandbox, and explicit graphic playback times as export. It decodes at up to 960 by 540, preserving the project's logical composition dimensions. The GPU setting requests D3D11 video decoding; a failed hardware decode retries in software. The CPU setting uses software decoding and composition. Export continues to use original-resolution software decoding and its existing GPU or software encoder.

Only one picture is rendered at a time. The worker retains the newest waiting request, and seek generations prevent older results from replacing newer selections. Sequential frames reuse decoders; larger or backward seeks reopen them at indexed source timestamps. Frames more than 250 ms behind the audio clock are discarded during playback. The monitor receives JPEG frames; paused preview is temporally exact, while Enter provides the original-resolution PNG inspection path.

Windows Electron closes stdin, so the Node worker relays control over an authenticated loopback socket. Closing or replacing a session stops its subprocesses and removes its temporary audio, graphics, and profile. A failed worker reports an error without stopping the project engine; another seek can open a fresh session.

## Manual checks, October 17, 2026

Checks used the existing 64-second Vellum edit on the documented Core Ultra 9 285K / RTX 5080 Windows machine, with 1440p60 HEVC sources and a 30 fps timeline. These are individual runs, not performance guarantees.

- An eight-second GPU preview starting at 5.5 seconds displayed 197 frames, about 24.6 fps, across cuts and dissolves. Audio started at 5.5 seconds and advanced 7.95 seconds. The largest measured difference between a displayed frame's requested time and the audio clock at delivery was 112 ms. This measures delivery, not physical speaker/display latency.
- Seven arbitrary seeks, including animated titles and distant cuts, settled at the requested frame and audio position in 390–766 ms with cached source indexes. A subsequent adjacent-frame step took 23 ms. Six rapid seeks spaced 20 ms apart settled on the final request in 1.08 seconds measured from the first request, without displaying stale seek results.
- Playback stopped at frame 1919, the final frame of the 64-second edit. A disposable project copy verified that a track-disable edit paused playback and replaced the preview session, and undo refreshed it again. The engine reported no preview render lock.
- A GPU preview sample at two seconds visually retained the opening graphic and composition. Compared with the full-resolution software frame downscaled to preview size, SSIM was 0.9765, including JPEG compression and scaling differences.
- A one-second software export across a dissolve passed full verification: 30 decoded video frames, 30 video packets, and 48 audio packets. The GUI was visually inspected with the added transport control. Clicking Play and pressing Space to pause landed on the displayed frame; switching between GPU and software preview produced the same selected frame. JavaScript syntax and diff whitespace checks passed. No always-run test suite was added.

## Current limits

The session prepares the whole timeline's audio and source indexes before its first preview. Edits rebuild that session, so a large edit or uncached source can take longer to become ready. Long-GOP footage still makes distant seeks slower than frame stepping. Proxy generation and predictive decoding are not implemented.

Picture delivery can drop below the project frame rate, especially with software decoding or multiple overlapping sources. Audio remains the playback clock. The measurements above do not constitute an audition or a physical audiovisual latency measurement. Broken sources or graphics stop the preview session with an error while the editor remains usable.
