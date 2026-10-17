# Windows shared-texture GPU export

The NVIDIA export path now receives Electron's shared D3D11 texture directly. A small native helper converts its full-range RGB pixels to limited-range BT.709 NV12 on the GPU, then gives that texture to NVENC. FFmpeg only muxes the compressed H.264 stream with the offline mixed audio.

Previously, every composed 1080p frame came back to CPU memory, crossed a raw-video pipe, underwent CPU color conversion, and was uploaded for encoding. The new path removes those full-frame transfers. It retains a one-pixel CPU readback to verify the frame's readiness token before encoding. That is four bytes per accepted frame instead of 8,294,400 bytes. The token still occupies the benchmark's diagnostic 8x8 patch.

## Implementation

`shared-frames.cjs` selects Electron's `offscreen.useSharedTexture` path. It holds the texture until the helper acknowledges encoding completion, then releases it. Paints arriving during a native operation are held in a bounded one-texture queue. Older queued paints are released. The readiness pixel rejects stale frames, and the helper confirms the sequential encoded frame index.

`native/texture-encoder.cpp` duplicates the texture's NT handle from Electron, opens it on the NVIDIA D3D11 device, runs the video processor with explicit color matrix/range settings and automatic picture adjustments disabled, and encodes the resulting GPU NV12 resource. The helper uses NVENC P4, constant QP16, no B frames and no lookahead. A single reusable NV12 texture and bitstream buffer keep its allocation bounded. Every submitted frame is drained before acknowledgment.

CPU FFmpeg decoding and the original-resolution RGBA cache remain unchanged. Canvas input still uploads CPU pixels to the GPU. This fixes the composition-to-encoder round trip; it is not a fully GPU-resident decoder or a production editor pipeline. The helper targets NVIDIA on Windows x64. A texture created on another adapter fails explicitly. No automatic hardware fallback is claimed.

## Results

The final run on October 16, 2026 Pacific time passed all 94 comparison checks. It produced 36 complete exports across four paths, three sources and three repetitions. The original RGB solution suite also passed before this comparison. [Machine-readable results](windows-gpu-export.json) preserve the timings and checks. Local artifacts: `.cache/windows-gpu/2026-10-17T05-31-26-544Z/`.

The machine is the same Windows 11 / Core Ultra 9 285K / RTX 5080 / 64 GB system used in the previous experiments. The code uses Electron 44.8.0, the existing FFmpeg 6.1.1 package, and the NVENC 12.1 API through the installed NVIDIA driver.

| Median export rate, three runs | GPU bitmap + NVENC | CPU + x264 | CPU + NVENC | Shared texture + NVENC | Gain over GPU bitmap |
| --- | ---: | ---: | ---: | ---: | ---: |
| Generated timing fixture | 43.6 fps | 69.1 fps | 71.9 fps | 72.5 fps | 1.66x |
| Sample H.264, 1080p48 source | 45.7 fps | 69.4 fps | 72.9 fps | 71.6 fps | 1.57x |
| Gauntlet HEVC, 1440p60 source | 42.6 fps | 43.7 fps | 48.2 fps | 61.9 fps | 1.45x |

Shared textures remove the measured GPU bitmap penalty. CPU composition with NVENC remains competitive for the simple 1080p scene and is slightly faster on the H.264 sample. The 1440p source benefits more from GPU composition, with shared-texture export 42% faster than CPU/x264 and 28% faster than CPU/NVENC. These short runs do not establish sustained performance or statistical significance for the small 1080p differences.

All 48 sampled encoded frames passed SSIM > 0.98 against their bitmap references. The shared path's six encoded color patches differ from the uncompressed reference by at most 2/255. All generated flash/audio onsets agree within one 30 fps frame. The VFR identity samples pass, and every shared-texture frame is accepted only after its readiness token matches the requested frame. One stale initial paint was rejected during the final run. The full-frame CPU pixel payload is eliminated; accepted frames read back a four-byte readiness pixel, excluding driver allocation alignment and encoded output bytes.

## Measurement method

The runner compares three serial repetitions per source of GPU bitmap composition with NVENC, CPU composition with x264, CPU composition with NVENC, and shared-texture composition with NVENC. Each export contains 150 frames at 1080p30, the same two source segments and dissolve, animated HTML graphics and corresponding offline audio.

NVENC controls use P4, constant QP16, and no B frames. Native and FFmpeg encoder wrappers can still differ in other defaults; these are complete export-path measurements rather than equal-quality encoder microbenchmarks. The shared path's reported time includes encoder initialization, all frame submission/draining, and the subsequent FFmpeg audio encode/mux. Bitmap timing includes frame submission/draining and concurrent audio encode/mux, but excludes its FFmpeg process spawn call. This small asymmetry favors the bitmap controls. Source preparation, Electron/helper startup, output validation and PNG writes are excluded from both. Filesystem caches are warm.

The initial CQ18/no-B-frame comparison failed the existing SSIM > 0.98 threshold on the HEVC dissolve frame for both bitmap/NVENC controls, at 0.9795 and 0.9794. All shared-texture checks passed. The final comparison uses constant QP16 for every NVENC path to give the quality checks enough margin, keeping the threshold unchanged. The original `bench:solutions` preset remains unchanged.

Correctness checks cover the original RGB/VFR suite, encoded dimensions/frame counts/SDR tags/audio duration for every export, four frame comparisons per source/path against the bitmap reference, six encoded SDR color patches, generated flash/audio synchronization, and arbitrary VFR source-time selection. Timing and quality tolerances are experiment checks, not agreed product acceptance targets.

## Reproduce

```powershell
npm ci
npm run bench:windows -- --source "/path/to/media/source" --source "/path/to/media/source"
npm run bench:gpu
```

The original benchmark preserves its known native-video color failure and can exit 1. Its generated fixtures are still usable. `bench:gpu` runs the corrected RGB suite, builds the native helper with the installed Visual Studio C++ compiler and Windows SDK, and executes the comparison. The NVENC 12.1 API header is downloaded from a pinned FFmpeg header release and SHA256-verified; its NVIDIA license notice is retained in the cached header. No global installation is performed.

Results and media stay under `.cache/windows-gpu/<timestamp>/`. The raw input recordings are read without modification. Generated RGBA caches are deleted after success unless `REELET_KEEP_FRAMES=1` is set. To reuse retained caches, pass the corresponding `.cache/windows-solutions/<timestamp>` directory to `bench:gpu`. This trusted fixed graphics fixture still requires the existing preload filesystem adapter and disabled renderer sandbox.

The next decoder change should replace the six-second raw caches with a bounded queue. GPU decoder-to-canvas interop, long-project cancellation/recovery, non-NVIDIA shared-texture encoding and arbitrary graphics sandboxing remain separate work.

References: [Electron offscreen rendering](https://www.electronjs.org/docs/latest/tutorial/offscreen-rendering), [shared texture lifetime and handles](https://www.electronjs.org/docs/latest/api/structures/offscreen-shared-texture), [D3D11 shared-resource access](https://learn.microsoft.com/en-us/windows/win32/api/d3d11_1/nf-d3d11_1-id3d11device1-opensharedresource1), [D3D11 video processing](https://learn.microsoft.com/en-us/windows/win32/api/d3d11/nf-d3d11-id3d11videocontext-videoprocessorblt), [pinned NVIDIA API header](https://github.com/FFmpeg/nv-codec-headers/blob/n12.1.14.0/include/ffnvcodec/nvEncodeAPI.h).
