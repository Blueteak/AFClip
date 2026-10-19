# CLI latency audit — 18 October 2026

All 102 commands were exercised: 47 af-clip commands and 55 af-lib commands, including a separate GUI launch check. Help/schema paths were also checked. These are representative workflows, not exhaustive flag combinations or statistical latency guarantees.

## Results and budgets

Timings include the CLI process. Repeated workloads report the median of three serial samples; most mutations have one sample. OS caches were not flushed. Hardware: Core Ultra 9 285K, RTX 5080, 68 GB RAM, Windows, Node 24.12.0, FFmpeg 6.1.1, ffprobe 4.0.2.

| Workload | AFClip | Processing reference | Assessment |
|---|---:|---:|---|
| 4 s 1080p30 software export | 3,423 ms | 1,012 ms with full verification | Real time; 3.4× reference |
| 4 s 1080p30 GPU export | 3,621 ms | 1,013 ms with full verification | Real time; 3.6× reference |
| Cold 640 px source frame | 324 ms | 168 ms | Reasonable CLI overhead |
| Cold contact sheet | 318 ms | 181 ms | Reasonable CLI overhead |
| Cold 4 s excerpt | 424 ms | 278 ms | Reasonable CLI overhead |
| Cold packet index | 210 ms | 38 ms | Reasonable CLI overhead |
| Cold waveform | 197 ms | 43 ms PCM extraction only | Reference excludes binning |
| Cold preview preparation | 1,419 ms | About 1,227 ms proxy + index + audio | Close to processing cost |
| Warm preview preparation | 135 ms | Cached application operation | Responsive |
| 10,000-record search | 139 ms | — | Responsive |
| 1,000-clip inspect / edit / undo | 150 / 162 / 163 ms | — | Responsive |
| Invalid project startup | 331 ms | Previously 16,380 ms | Fixed |

Working budgets for this machine: warm metadata under 300 ms; cold endpoint under 500 ms; failed startup under 1 s; source review processing cost plus about 250 ms; cold preview processing cost plus about 300 ms. These are engineering targets, not published industry SLAs. Simple exports should run at least in real time; a stretch target of twice the fully verified processing reference is still missed.

The scale fixture contains 10,000 catalog records sharing one verified source, not 10,000 physical media files. Its project has 1,000 sequential clips on one track. Cold library/project endpoints were 346/360 ms. GUI acknowledgment was 358 ms cold and 104–112 ms warm; a native window handle appeared at about 701 ms cold and 427–432 ms warm. Window appearance does not measure completed UI rendering.

## Changes

The export decoder now derives a safe stride from actual source-frame requests. It skips unused frames before RGBA conversion and transport. The 60-to-30 fps fixture transports 120 frames instead of 239. Variable cadence, fractional frame rates, transition handles and held ends retain exact frame selection; unsafe strides fall back to one. Planning is bounded by each clip's visible interval.

The isolated synthetic comparison improved software export from 4,051 to 3,429 ms and GPU export from 4,170 to 3,505 ms (15–16%). A separate worktree at 349dca1, with only rendering changes applied, improved real-footage plain/dissolve/title medians from 2,629/6,234/2,861 to 2,415/5,691/2,635 ms (8–9%). Those exports are one-second samples; dissolves remain well below real time. The final run includes concurrent CLI output improvements and measured 3,423/3,621 ms on the synthetic exports. Full-resolution still-image generation did not improve; no gain is claimed there.

Both service clients now notice an unsuccessful child exit immediately instead of waiting through the startup timeout. Successful exit remains compatible with simultaneous launchers sharing the same service. Invalid project/catalog and concurrent launcher checks passed.

Fifteen paired MP4s and four paired PNGs were byte-identical. Exports passed full verification. Targeted stride checks cover exact decoded buffers, non-keyframe starts, skipped requests, VFR fallback and 24 fractional-rate/handle cases. No broad test framework was added.

## Professional-tool comparison and remaining gap

Neither Resolve nor Premiere is installed here, so this is a same-machine FFmpeg/ffprobe processing comparison, not a measured win or loss against either editor. Professional benchmark suites distinguish encoding, processing and real-world workloads; their media, settings and hardware must match before comparing numbers. See [PugetBench for DaVinci Resolve methodology](https://www.pugetsystems.com/pugetbench/creators/davinci-resolve/).

The export reference transcodes the same synthetic 1080p60 source into 120 frames at 1080p30, H.264 without B frames, stereo 48 kHz AAC, then runs AFClip's actual full container/decode verifier. Its software encode median is 614 ms and GPU encode median 493 ms; verification brings each to about 1,012 ms. It does not perform HTML composition, project management, or AFClip's audio mixing. NVENC rate control is not identical, so this is a processing baseline rather than a quality ranking. Earlier raw references in the JSON used mono audio and video-only verification; the table uses the corrected verifiedReference samples.

The remaining export gap is in the application rendering path: source conversion, transport, uploads, Chromium composition and frame delivery. The synthetic render phase alone takes about 2.0–2.4 s. GPU encoding does not remove these costs. A future improvement should profile those stages and evaluate a direct render path for simple cuts while preserving the compositor for HTML and effects. Source-review and metadata commands do not currently justify that level of rework.

## Reproduce

Run each script with a new output directory:

```sh
node benchmarks/cli/commands.mjs .cache/audit-new
node benchmarks/cli/scale.mjs .cache/audit-new .cache/scale-new
node benchmarks/cli/startup.mjs .cache/startup-new
node benchmarks/cli/verify-strides.cjs .cache/audit-new/sources/video.mp4 .cache/strides-new
node benchmarks/cli/reference.cjs .cache/audit-new/sources/video.mp4 .cache/reference-new
```

See [raw measurements](cli-command-audit.json) for labels, per-command samples, renderer statistics, paired comparisons and validation results. The GUI was launched separately three times and its window handle was polled. The full command suite creates disposable sources, catalog and project and closes services it starts.

## Command coverage

Ranges below mix cold/warm calls and different workloads; they are not p95s. Export includes an asynchronous acknowledgment as well as completed exports. Job commands can wait for actual work. Use the labeled raw samples for individual scenarios.

| Tool | Command | Samples | Min–max ms |
|---|---|---:|---:|
| af-clip | create | 1 | 146–146 |
| af-clip | collect | 1 | 201–201 |
| af-clip | inspect | 5 | 140–158 |
| af-clip | endpoint | 1 | 356–356 |
| af-clip | import | 2 | 157–200 |
| af-clip | relink | 1 | 181–181 |
| af-clip | library-import | 1 | 181–181 |
| af-clip | library-sync | 1 | 145–145 |
| af-clip | library-status | 1 | 154–154 |
| af-clip | source-inspect | 1 | 145–145 |
| af-clip | source-frames | 1 | 144–144 |
| af-clip | source-prepare | 2 | 152–232 |
| af-clip | source-jobs | 1 | 140–140 |
| af-clip | source-cancel | 1 | 143–143 |
| af-clip | source-waveform | 1 | 189–189 |
| af-clip | source-insert | 1 | 143–143 |
| af-clip | apply | 1 | 146–146 |
| af-clip | asset-builtin | 1 | 167–167 |
| af-clip | asset-duplicate | 1 | 165–165 |
| af-clip | text-fields | 1 | 145–145 |
| af-clip | text-set | 1 | 155–155 |
| af-clip | text-reset | 1 | 141–141 |
| af-clip | folders | 1 | 152–152 |
| af-clip | folder-create | 1 | 157–157 |
| af-clip | folder-set | 1 | 140–140 |
| af-clip | folder-members | 1 | 154–154 |
| af-clip | folder-move | 1 | 140–140 |
| af-clip | folder-remove | 1 | 154–154 |
| af-clip | markers | 1 | 137–137 |
| af-clip | marker-add | 1 | 136–136 |
| af-clip | marker-set | 1 | 140–140 |
| af-clip | marker-remove | 1 | 136–136 |
| af-clip | marker-next | 1 | 138–138 |
| af-clip | marker-previous | 1 | 136–136 |
| af-clip | ripple-delete | 1 | 153–153 |
| af-clip | detach-audio | 1 | 143–143 |
| af-clip | unlink | 1 | 140–140 |
| af-clip | undo | 2 | 143–157 |
| af-clip | redo | 1 | 157–157 |
| af-clip | export | 7 | 169–3624 |
| af-clip | frame | 3 | 700–718 |
| af-clip | status | 6 | 155–181 |
| af-clip | cancel | 1 | 177–177 |
| af-clip | close | 1 | 145–145 |
| af-clip | checkpoint | 1 | 197–197 |
| af-clip | checkpoints | 1 | 146–146 |
| af-clip | restore | 1 | 205–205 |
| af-lib | gui | 3 | 104–358 |
| af-lib | endpoint | 1 | 326–326 |
| af-lib | search | 3 | 130–138 |
| af-lib | overview | 5 | 128–141 |
| af-lib | inspect | 13 | 129–145 |
| af-lib | original | 1 | 140–140 |
| af-lib | preview | 1 | 131–131 |
| af-lib | frames | 1 | 132–132 |
| af-lib | selection | 1 | 131–131 |
| af-lib | waveform | 2 | 131–197 |
| af-lib | import | 2 | 201–333 |
| af-lib | register | 1 | 133–133 |
| af-lib | annotate | 1 | 134–134 |
| af-lib | range-save | 1 | 135–135 |
| af-lib | range-delete | 1 | 131–131 |
| af-lib | move | 1 | 130–130 |
| af-lib | promote | 1 | 141–141 |
| af-lib | folder-create | 1 | 149–149 |
| af-lib | folder-update | 1 | 130–130 |
| af-lib | folder-delete | 1 | 138–138 |
| af-lib | tag-create | 2 | 134–139 |
| af-lib | tag-rename | 1 | 147–147 |
| af-lib | tag-delete | 1 | 136–136 |
| af-lib | tag-merge | 1 | 132–132 |
| af-lib | collection-create | 1 | 142–142 |
| af-lib | collection-update | 1 | 132–132 |
| af-lib | collection-delete | 1 | 133–133 |
| af-lib | prepare | 6 | 133–1419 |
| af-lib | artifact | 7 | 132–424 |
| af-lib | jobs | 1 | 129–129 |
| af-lib | cancel | 1 | 131–131 |
| af-lib | history | 1 | 137–137 |
| af-lib | undo | 1 | 141–141 |
| af-lib | redo | 1 | 143–143 |
| af-lib | references | 1 | 131–131 |
| af-lib | source-folder-save | 1 | 142–142 |
| af-lib | source-folder-remove | 1 | 131–131 |
| af-lib | source-folders | 1 | 135–135 |
| af-lib | rescan | 1 | 143–143 |
| af-lib | replace | 1 | 131–131 |
| af-lib | remove | 2 | 131–144 |
| af-lib | restore | 1 | 136–136 |
| af-lib | purge | 1 | 131–131 |
| af-lib | retain | 1 | 131–131 |
| af-lib | withdraw | 1 | 134–134 |
| af-lib | sync-project | 1 | 144–144 |
| af-lib | checkpoint | 1 | 129–129 |
| af-lib | checkpoints | 1 | 143–143 |
| af-lib | checkpoint-restore | 1 | 139–139 |
| af-lib | cache | 1 | 160–160 |
| af-lib | cache-clear | 1 | 143–143 |
| af-lib | cache-budget | 1 | 154–154 |
| af-lib | close | 1 | 133–133 |
| af-lib | apply | 1 | 143–143 |
| af-lib | call | 1 | 132–132 |
