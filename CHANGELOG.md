# Changelog

## 8.0.0 (2026-10-31)

- Breaking: new modules. `rapier-jxl` is the full encoder; `rapier-jxl/upload` (efforts 1–3) and `/capture` are subsets.
- Breaking: `createCodec` in `rapier-jxl/codec` replaces `createEncoder` and runs any module in a worker.
- Breaking: one `fidelity` option replaces `quality`, `lossless`, `target` and `maxError`. Quality 100 is lossless.
- Breaking: `colorSpace`, `bitDepth`, `icc` and other sample fields move from options to the image. Added `readAs`.
- Breaking: requires WebAssembly with SIMD. The JavaScript fallback is removed.
- Efforts 7–9 use WebGPU when available. Set `webgpu: 'required'` or `false` to change this.
- Smaller files at efforts 6–9. Quality now matches libjxl at every effort. Efforts 8–9 apply up to 1 MP for now.
- Added `rapier-jxl/polyfill` and `prepare()`. Errors use one of 19 `JXL_*` codes.

## 7.1.0 (2026-10-28)

- Added `rapier-jxl/snapdom`, a SnapDOM 3 plugin that adds `result.toJxl()`.
- Lossless screenshots are 4–8% smaller.
- Faster encoding at efforts 3 and 7, and a faster first upload with `helpers`.
- Faster decoding and encoding of images with color profiles, including Display P3.
- Smaller JPEG recompression at efforts 2–6. `recompress` defaults to `acceleration: 'auto'`.
- The decoder, JPEG recompression and metadata limit the memory and time a damaged file can use.
- Fixed white decoding as black in lossy photos near quality 100, and hangs on malformed JPEGs.
- Works from a CDN and in Next.js server routes. `rapier-jxl/worker` runs as a Node worker thread.

## 7.0.0 (2026-10-28)

- Breaking: new API. `encode(image, options)` and `createEncoder()`, a queue with progress, cancel and limits.
- Added `helpers` for parallel encoding.
- Added `rapier-jxl/capture`, `/jpeg`, `/decode`, `/animation`, `/metadata`, `/format` and `/offline`.
- Node 20.16+ and 22.3+, Deno and Bun.
