# Changelog

## 8.3.1 (2026-11-08)

- New `rapier-jxl/emdash`: `npx rapier-jxl add emdash` sets up the EmDash plug-in.
- `capture-complete` is resumable. Resumable jobs can verify their result: pass `verify` from `rapier-jxl/verify`. `workerAdmission` says whether a job fits a Workers isolate.
- `onPreview` reports each candidate file while an encode runs.
- Quality 99 is now lossy; only 100 is exact.
- On Cloudflare Workers, JPEGs are stored losslessly up to 12 MP; other conversions are limited to about 1 MP for now, and larger ones convert in the browser.
- Fixed: effort 7 made files no smaller than effort 3.
- Fixed: pictures under 128 px could miss the requested quality, and at effort 7 could fail.
- Fixed: PNGs with libpng's default color intent were about 6x larger at effort 3.
- Fixed: `verify` refused lossy copies of Display P3 photos.
- Fixed: a worker file the bundler didn't copy now fails with the list of files to serve.

## 8.3.0 (2026-11-06)

- API change: every encoding operation now returns one result record; verification and resumable encoding are separate modules. Kept on V8 because it's more fitting, rather than making this 9.0.0
- One quality number: `{webp: 0.8}` is now `{quality: 80}`.
- Page capture is `rapier-jxl/capture` and `rapier-jxl/capture-complete`; JPEG recompression is `rapier-jxl/jpeg` and `rapier-jxl/upload`.
- New `rapier-jxl/resumable`: encodes continue across calls in short steps and write the same file as one call.
- New `rapier-jxl/verify` checks an output against its original.
- Outside a browser, `capture-complete` measures photos after `configureDecoder(decode)`, with `decode` from `rapier-jxl/decode`.

## 8.2.0 (2026-11-04)

- New `rapier-jxl/capture-complete` for page screenshots: the page lossy as VarDCT, text lossless in a small modular atlas placed as patches, in one file.
- Page screenshots are smaller than WebP on 24 of 47 test pages; the rest are being worked on for 8.2.x.
- At WebP's file size, page screenshots keep text lossless and photos closer to the original: SSIMULACRA 2 +6, CVVDP +0.04 on 30 of 47 test pages.
- `fidelity: {webp: 0.8}` takes the number you pass to `canvas.toBlob('image/webp', 0.8)`.
- Repeated letters and words are stored once, as JPEG XL patches. Pages over 40 MP are coded band by band, so memory stays bounded.
- New `fit` (best quality under a size limit) and `variants` (several sizes from one upload).
- `npx rapier-jxl --json` prints one JSON line per file and a summary, for scripts and coding agents. A rerun leaves finished files untouched. `SKILL.md` ships in the package.
- JPEG recompression up to 64 MP. Ultra HDR and motion photos restore exactly. HEIC and animated AVIF encode.
- New `rapier-jxl/svg-jxl` converts the images inside any SVG to JPEG XL where that makes them smaller; new `rapier-jxl/page-rects` finds the text and photos on a page.

## 8.1.0 (2026-11-01)

- Faster effort 1 for screenshots and previews, and faster low-colour bounded captures.
- Large-photo uploads are about 3× faster with 3 helpers.
- Effort 7 files are 3% smaller at the same quality, at the same speed.
- `npx rapier-jxl` converts pictures and folders from the command line.
- `rapier-jxl/serve` sends one stored file as JPEG XL or the original JPEG, by what the browser accepts.
- Decode reads a picture's `region` or shows a file cut short at 1:8 with `{partial: true}`.
- Banded pictures decode in about half the memory.
- Encode reads HDR canvases, playing video, texture array layers, and depth textures.

## 8.0.1 (2026-10-31)

- Efforts 8 and 9 now run at every size, not only up to 1 MP: files 2.6–5.7% smaller than effort 7 at the same quality.
- Efforts 8 and 9 are faster on WebGPU: a 12 MP photo at effort 8 takes half the time.
- `rapier-jxl/upload` is 25–34% faster on one thread and uses less memory: a 12 MP upload fits in a 128 MB edge worker.
- Efforts 4 and 5 split one picture across `helpers`: a 12 MP photo at effort 4 is 2.4× faster with 3 helpers.
- `helpers` run the WebAssembly kernels; a helper started before the first job used the slower path.
- The decoder requires WebAssembly with SIMD; its JavaScript fallback is removed.

## 8.0.0 (2026-10-31)

- Breaking: new modules. `rapier-jxl` is the full encoder; `rapier-jxl/upload` (efforts 1–3) and `/capture` are subsets.
- Breaking: `createCodec` in `rapier-jxl/codec` replaces `createEncoder` and runs any module in a worker.
- Breaking: one `fidelity` option replaces `quality`, `lossless`, `target` and `maxError`. Quality 100 is lossless.
- Breaking: `colorSpace`, `bitDepth`, `icc` and other sample fields move from options to the image. Added `readAs`.
- Breaking: requires WebAssembly with SIMD. The JavaScript fallback is removed.
- Efforts 7–9 use WebGPU when available. Set `webgpu: 'required'` or `false` to change this.
- Smaller files at efforts 6–9. Quality now matches libjxl at every effort. Efforts 8–9 apply up to 1 MP for now.
- Added `rapier-jxl/polyfill` and `prepare()`. Errors use one of 19 `JXL_*` codes.
