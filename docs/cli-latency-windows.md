# CLI latency, Windows, October 18, 2026

Analyzed T3's local AFClip tool history and ran paired CLI benchmarks on the current checkout. `af-cli` was confirmed to mean `af-lib`.

## Findings

The read-only T3 snapshot contained 543 tool rows mentioning the CLIs or their entry-point files. Most were code reads, edits, scripts, or batches, not individual command measurements. Filtering to single invocations beginning with a CLI left 32 samples. Their durations include the shell and tool overhead. See the historical samples in [the measurements](cli-latency-windows.json).

Routine historical commands took 159–255 ms. PNG calls included an early 35-second outlier and later calls at 2.23–2.29 seconds. Successful exports ranged from 1.4 to 102.8 seconds with different durations and content. The 328-second tool call also included close and checkpoint operations, so it is excluded from the single-command samples. Earlier timestamp-indexing fixes already addressed much of that historical delay.

There is no declared latency SLA in this repo. For this audit, warm metadata operations under 300 ms are healthy. Media work must be judged by its workload and worker timings, with avoidable completion polling kept to 100 ms. Export duration alone is not a useful outlier threshold. Long exports, cold hashing, and preview generation cannot share the metadata budget.

Current inspection, edits, search, indexing, and waveforms were healthy. The remaining actionable delays were the two-thread Windows export decoder limit and completion polling. A library artifact job took 407 ms internally but 917 ms through the CLI after missing a poll and backing off to 500 ms.

## Changes

- Windows full-resolution decoding now lets FFmpeg choose its thread count, as macOS already did. Preview retains its four-thread setting; other platforms retain their existing setting.
- Render and project-source waits now poll every 100 ms instead of 500 and 250 ms respectively.
- Library waits still start at 25 ms, but back off only to 100 ms instead of 500 ms. Timeout and failure handling are unchanged. Long waits now make up to ten local status requests per second.

## Paired results

Intel Core Ultra 9 285K, 24 logical cores, Node 24.12.0. Disposable copies of `examples/vellum-first-edit`, 1080p30 output, software mode, full output verification. Serial runs, same sources and Node version, OS caches not flushed. Export numbers are medians of three one-second exports per case; the PNG is one sample per side.

| Command/workload | Before | After | Reduction |
| --- | ---: | ---: | ---: |
| Export, plain footage | 3,726 ms | 2,630 ms | 29% |
| Export, dissolve | 7,292 ms | 5,585 ms | 23% |
| Export, HTML title | 3,725 ms | 2,848 ms | 24% |
| PNG frame | 2,177 ms | 1,101 ms | 49% |

All nine MP4s and the PNG are byte-for-byte identical before and after. All exports passed full decoded-frame verification. A separate 120-frame decode control measured medians of 1,494 ms with two threads, 889 ms with four, 633 ms with eight, and 529 ms with automatic threading. The export measurements include both decoder and polling changes, so their individual contributions are not isolated.

Final library checks measured search at 141 ms, cold/warm indexing at 211/141 ms, and cold/warm waveforms at 184/132 ms. Three uncached frame requests at source times 3, 4, and 5 seconds took 535, 638, and 423 ms, with worker times of 402, 526, and 234 ms. The matching 3-second frame request fell from the observed 917 ms polling outlier to 535 ms. Cold library import took 674 ms, including service startup and 258 ms of verification work; no import speedup is claimed.

Software exports remain below real time on this fixture, especially across dissolves. These changes reduce latency; they do not establish a real-time export target, large-catalog performance, or measured GPU-export speedups. Automatic decoding can use more CPU and decoder memory than a fixed two-thread pool.

## Reproduction

```powershell
node benchmarks/cli/run.cjs examples/vellum-first-edit .cache/cli-latency-new
```

The destination must not exist. The benchmark closes its disposable engine and library. Local paired outputs are in `.cache/cli-latency-before` and `.cache/cli-latency-after`. Final library samples are in `.cache/cli-library-final`. The committed JSON contains timings, verification results, output equality checks, and the filtered T3 history without full conversation transcripts. `after` records the first paired pass; `finalLibrary` records the subsequent library polling fix.
