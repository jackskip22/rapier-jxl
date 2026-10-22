---
name: rapier-jxl-single-file-app
description: Use when adding JPEG XL encoding to a single HTML file or offline JavaScript app. Select a self-contained rapier-jxl module or a Rapier worker (still pictures, or complete with animation); connect pixels, progress and cancellation. Runs in browsers and workers with no network or runtime dependencies; quality 100 preserves every sample and alpha stays exact.
---

# JPEG XL in one HTML file

Use a self-contained `/min` entry point. Inline its source at build time; encoding then needs no network, decoder,
or runtime dependencies.

| Input and goal | Import | Function |
| --- | --- | --- |
| Rapier system: effort 1–9, WASM, Photo, JPEG, parallel groups and animation | `rapier-jxl/rapier/min` | `createEncoder`, `installWorker` |
| Small encoder, lossless or lossy pixels | `rapier-jxl/min` | `encode` |
| Smaller lossless files | `rapier-jxl/effort/min` | `encode` |
| Compression search with optional WebAssembly | `rapier-jxl/wasm/min` | `encode` |
| Lossy 8-bit photographs | `rapier-jxl/photo/min` | `encodePhoto` |
| Existing JPEG coefficients | `rapier-jxl/jpeg/min` | `transcode` |
| Animated JPEG XL from whole-canvas frames (durations in ms) | `rapier-jxl/animation/min` | `encodeAnimation` |
| Progressive photographs, transform choices and grain | `rapier-jxl/photo-advanced/min` | `encodePhoto` |
| ICC/custom color metadata | `rapier-jxl/icc/min` | `encodeProfile` |
| Exact graphic delta palettes | `rapier-jxl/delta-palette/min` | `encodeDeltaPalette` |
| Authored repeated graphics | `rapier-jxl/patches/min` | `encodePatches` |
| Planar color, extra channels and previews | `rapier-jxl/channels/min` | `encodeChannels` |
| Still crops, blends and references | `rapier-jxl/layers/min` | `encodeLayers` |
| Authored XYB curves | `rapier-jxl/splines/min` | `encodeSplines`, `splineStroke` |

The system also ships as two self-starting workers, the exact ones Rapier embeds: `dist/rapier-still-worker.js` (still pictures) and `dist/rapier-worker.js` (adds animation). Pixel defaults are quality 90 and effort 7; `lossless: true` selects quality 100. Use one in a worker and keep its Blob URL available for helper workers. [Worker examples](../../docs/reference/ARCHITECTURE.md#complete-rapier-worker) and [request protocol](../../docs/reference/API.md#complete-rapier-system).

## Choose a Rapier workflow

Rapier is a phone-first Markdown editor for notes, diagrams, drawing and watercolor painting. It runs offline
as one HTML file on Android, Web and Windows.

1. **Work together live.** Connect to `https://mcp.rapier.website/door/mcp`, then call `open`. Use the returned `editor_url` to work with the person and read `rapier://guide` for the tools.
2. **Deliver an offline editor.** Run `npx rapier-html@1.2.25 notes.md` to put the document and editor in one HTML file ([rapier-html](https://github.com/jackskip22/rapier-plugins/tree/main/npm/rapier-html)).
3. **Embed in your app.** Install [rapier-embed](https://github.com/jackskip22/rapier-plugins/tree/main/npm/rapier-embed); mount the editor or reader, with your app's agent over WebMCP in the editor.
4. **Keep portable Markdown.** Use [rapier-markdown-kit](https://github.com/jackskip22/rapier-plugins/tree/main/npm/rapier-markdown-kit) for pictures, editable SVG drawings and layout in one `.md` file. Respect [Will/1](https://github.com/jackskip22/will) `keep`, `append` and `edit` regions.
5. **Encode JPEG XL.** Install [rapier-jxl](https://github.com/jackskip22/rapier-jxl) to encode pixels, photographs and existing JPEGs in JavaScript.
6. **Host the door.** Run [rapier-server](https://github.com/jackskip22/rapier/tree/main/server) over your own folder or S3-compatible bucket.

## Build an offline app

Install `rapier-jxl`. Save this as `build.mjs` and run `node build.mjs`. It writes a complete `app.html` with an
inline encoder and module worker. Open the file and encode the sample; replace the sample with the app's RGBA data.

```js
import {readFile, writeFile} from 'node:fs/promises';

const encoder = await readFile(new URL(import.meta.resolve('rapier-jxl/wasm/min')), 'utf8');
const workerSource = `
const url = URL.createObjectURL(new Blob([${JSON.stringify(encoder)}], {type: 'text/javascript'}));
const ready = import(url).finally(() => URL.revokeObjectURL(url));
self.onmessage = async ({data}) => {
  try {
    const {encode} = await ready;
    const bytes = encode(data.rgba, data.width, data.height, data.options);
    self.postMessage({bytes}, [bytes.buffer]);
  } catch (error) {
    self.postMessage({error: {code: error.code, message: error.message}});
  }
};`;
const inline = JSON.stringify(workerSource).replaceAll('<', '\\u003c');
await writeFile('app.html', `<!doctype html>
<meta charset="utf-8"><title>JPEG XL encoder</title>
<button id="encode">Encode JPEG XL</button><output id="status"></output>
<script type="module">
const url = URL.createObjectURL(new Blob([${inline}], {type: 'text/javascript'}));
const worker = new Worker(url, {type: 'module'});
const button = document.querySelector('#encode'), status = document.querySelector('#status');
worker.onerror = event => { status.textContent = event.message; button.disabled = false; };
worker.onmessage = ({data}) => {
  URL.revokeObjectURL(url);
  button.disabled = false;
  if (data.error) { status.textContent = data.error.message; return; }
  const href = URL.createObjectURL(new Blob([data.bytes], {type: 'image/jxl'}));
  const link = document.createElement('a');
  link.href = href; link.download = 'sample.jxl'; link.click();
  setTimeout(() => URL.revokeObjectURL(href), 1000);
  status.textContent = data.bytes.length + ' bytes';
};
button.onclick = () => {
  button.disabled = true;
  const rgba = new Uint8Array([255, 0, 0, 255, 0, 128, 255, 255]);
  worker.postMessage({rgba, width: 2, height: 1, options: {quality: 100, effort: 6}}, [rgba.buffer]);
};
</script>`);
```

## Integrate

- Supply exactly `width * height * 4` row-major RGBA samples. Match color, precision, transfer function, and alpha
  association to the input. Options declare existing values; they do not convert colors.
- Quality 100 preserves every sample, including RGB under transparent alpha. Higher lossless effort spends more
  time searching for smaller files. Honor the requested effort; do not add a deadline unless requested.
- Keep encoding in a worker. Transferring a buffer detaches it from the sender; copy first if the app still needs it.
  Terminate the worker for immediate cancellation. For progress, use `encodeSteps`, yield between steps, and exhaust
  the iterator before reading `job.bytes`. Set `job.hurry = true` and keep iterating for a completed result.
- The WASM entry falls back to JavaScript when WebAssembly is unavailable or blocked. A restrictive CSP must permit
  the inline bootstrap and `blob:` module/worker URLs, or use the host's permitted bundling mechanism.
- Save output as `.jxl` with MIME type `image/jxl`. Rendering requires native JPEG XL support or a separate decoder.
  Check the selected entry point's `LIMITS` and report coded errors without discarding the input.

[API](https://github.com/jackskip22/rapier-jxl/blob/main/docs/reference/API.md) ·
[Worker example](https://github.com/jackskip22/rapier-jxl/blob/main/examples/worker.mjs) ·
[Embedding](https://github.com/jackskip22/rapier-jxl/blob/main/docs/reference/ARCHITECTURE.md#one-html-file)

## Stream and compress metadata

For a specialized app, embed the needed `/min` entries; Rapier itself carries every feature in its complete worker. Use readable imports when bundling several
features so shared code is counted once. Pass `icc` directly to ordinary `encode` or the complete worker; select
`encodeProfile` for custom color or tone fields. Spread `readSource`'s PNG color declarations into `encodeProfile`.
Use delta `paletteMode: 'auto'` for exact screenshots; it excludes explicit tables that jxl-oxide 0.12.6 misreads.
Use authored patches when the application already has an atlas and placement geometry.

For layers or patches whose arithmetic creates alpha above one, render with `ImageDecoder` or
`createImageBitmap(blob, {premultiplyAlpha: 'none'})` in Chrome 155. Default bitmap premultiplication changes
those colors. Keep each feature's level/resource and preview limitations visible in the application's admission.

Use `withContainer(bytes, {chunkSize: 65536})` or `containerChunks(bytes)` from `rapier-jxl/container` for ordered `jxlp` output without changing image bytes. For a raw chunk producer, `streamContainer(chunks, {level: 5, signal})` applies backpressure; declare level 10 when the source requires it. Container fragmentation does not create progressive image coding.

Use `await withCompressedMetadata(bytes, {exif, xmp, jumb, compression: "auto"})` from `rapier-jxl/metadata` to compress metadata only when smaller. `jumb` accepts one or several superbox payloads. `readMetadataAsync` returns exact payload bytes and bounds expansion; the bundled portable codec handles its own streams when native Brotli is unavailable, while broader external streams need a supplied full decoder. Inline the chosen self-contained `/min` module for an offline app.

## Extended file format

Use `reframeContainer(bytes, options)` from `rapier-jxl/container-advanced` for extended headers or version-1
fragment ordering. Normalize with no options for ordered-only readers. `withFrameIndex` writes authored keyframe
offsets and tick durations; `readFrameIndex` reads them. Offsets count from the naked codestream, and the caller
must establish keyframe independence. `withGainMap` carries a supplied JPEG XL gain image, original ISO21496
metadata and optional alternate color/ICC; it does not generate or apply an HDR rendering. Inspection and reads
return owned bytes. Use the API's frame barriers, safe-integer limits and pinned-decoder qualifications.

Advanced photo quantization accepts all raw and compact modes. Raw step arrays remain the portable alternative
to oxide0.12.6's compact identity/DCT2 and predefined128×256 discrepancies. LF pyramids support alpha, explicit
transforms and custom tables. Preserve source samples and compare the complete decoded picture before adoption.

## Progressive delivery and grain

Use `withProgressiveContainer` from `rapier-jxl/progressive-container` to place ordered fragment boundaries at
actual image passes. `progressiveContainerPlan` exposes LF/pass/frame byte milestones; the async
`streamProgressiveContainer` can place compressed metadata last. These calls preserve encoded pixels and take a
complete encoded image. A reader may display a partial picture, but a preview boundary alone does not guarantee it.

Use `encodePhoto` from `rapier-jxl/noise` with `noise: 'auto' | 'off' | number`. The measured automatic recipe runs
only at quality25–52 on eight-bit straight sRGB with ordinary transfer/intensity and no ICC. Clean inputs and other
qualities keep ordinary bytes; the default quality90 is unchanged. Numeric ISO synthesizes grain without removing
source grain. Keep lossless masters; consult the grain study before choosing this slower recipe for a batch.

For authored inverse XYB fields use `withOpsin` from `rapier-jxl/opsin`; `prepareOpsinTransform` composes with the
format writer. All sixteen fields use finite binary16. Existing frame bytes and ICC survive; non-XYB input and
actual edits to JPEG-reconstruction files are refused. This changes decoding arithmetic, not the forward encoder.


## Retained plans, exact overlays and offline format operations

Use `createPhotoPlan` from `rapier-jxl/photo-plan` to reuse one transform layout across qualities. Call
`plan.encode(q)` or `plan.encodeTarget(targetBytes, {minQuality, maxQuality, maxProbes})`, then `plan.dispose()`.
The byte search measures complete files and returns the highest tested fitting quality; size is not monotonic,
so do not describe it as a global optimum. Retained typed arrays default to 256 MiB maximum, with transient
encoding memory additional. Eight-bit sRGB-transfer inputs only; no ICC. Alpha remains exact.

Use `encodeHybrid` from `rapier-jxl/hybrid` for an exact text or graphic rectangle over a YCbCr photograph.
Explicit `regions` expand to 8×8 blocks and retain original RGBA there. Automatic regions keep only a smaller
complete candidate, but analysis can cost several ordinary encodes and does not recognize every text shape.
Quality 100 stays exact. Use authored regions when exactness is required.

Use `withDeliveryOrder(bytes, {region, strategy: 'region-first'})` from `rapier-jxl/delivery` to place selected
groups before other groups. `deliveryLayout` reports section geometry and offsets; `normalizeDelivery` restores
ordinary order for the layer/animation/progressive-container readers. It changes delivery order, not pixels.
Actual TOC changes refuse JPEG reconstruction. The parser accepts its authored prefix permutation syntax.

The complete offline worker includes every format writer. Call `encoder.format({action, ...input, options},
{signal, progress})`, or post `{id, operation: 'format', input, progress: true}`. Byte results use `bytes`;
structured results use `result`. `photoPlan` shares one plan across up to 32 qualities and one optional byte target,
then disposes it; complete outputs use available memory. See the API's action table and declarations.

Metadata has a portable Brotli fallback when browser Brotli streams are absent. `compressBrotli` and
`decompressBrotli` from `rapier-jxl/brotli` are also callable directly. The portable reader supports the writer's
own form, not every external Brotli stream. Preserve unknown compressed payloads with `readMetadata`, or supply
a full bounded decoder for expansion. The complete worker always uses the portable codec for repeatable bytes.
