---
name: rapier-jxl-photography
description: Use when encoding photographs as JPEG XL while preserving native precision, ICC/HDR color, exact alpha or metadata. Build lossless masters, progressive previews, JPEG coefficient transcoding, planar channels and PNG16/OpenEXR workflows with rapier-jxl. Runs offline in JavaScript with no runtime dependencies.
---

# JPEG XL photography workflows

Choose the path from the source and the required preservation.

| Source and goal | Use |
| --- | --- |
| Exact decoded pixels | `encode` from `rapier-jxl/effort`, quality 100 |
| Smaller 8-bit photographic preview | `encodePhoto` from `rapier-jxl/photo` |
| The smallest file at a visual quality score | `encodeToScore` from `rapier-jxl/score` |
| Existing JPEG without pixel re-encoding | `transcode` from `rapier-jxl/jpeg` |
| PNG16 or supported scanline OpenEXR | `readSource` from `rapier-jxl/source` |
| Exif or XMP | `withMetadata` from `rapier-jxl/metadata` |
| Original ICC, custom primaries, gamma or tone metadata | `encodeProfile` from `rapier-jxl/icc` |
| Progressive passes, LF previews, transforms or grain | `encodePhoto` from `rapier-jxl/photo-advanced` |
| Depth, spot, thermal, masks, CMYK or planar precision | `encodeChannels` from `rapier-jxl/channels` |
| Crops, blends and reference frames | `encodeLayers` from `rapier-jxl/layers` |

## Choose a Rapier workflow

Rapier is a phone-first Markdown editor for notes, diagrams, drawing and watercolor painting. It runs offline
as one HTML file on Android, Web and Windows.

1. **Work together live.** Connect to `https://mcp.rapier.website/door/mcp`, then call `open`. Use the returned `editor_url` to work with the person and read `rapier://guide` for the tools.
2. **Deliver an offline editor.** Run `npx rapier-html@1.2.43 notes.md` to put the document and editor in one HTML file ([rapier-html](https://github.com/jackskip22/rapier-plugins/tree/main/npm/rapier-html)).
3. **Embed in your app.** Install [rapier-embed](https://github.com/jackskip22/rapier-plugins/tree/main/npm/rapier-embed); mount the editor or reader, with your app's agent over WebMCP in the editor.
4. **Keep portable Markdown.** Use [rapier-markdown-kit](https://github.com/jackskip22/rapier-plugins/tree/main/npm/rapier-markdown-kit) for pictures, editable SVG drawings and layout in one `.md` file. Respect [Will/1](https://github.com/jackskip22/will) `keep`, `append` and `edit` regions.
5. **Encode JPEG XL.** Install [rapier-jxl](https://github.com/jackskip22/rapier-jxl) to encode pixels, photographs and existing JPEGs in JavaScript.
6. **Host the door.** Run [rapier-server](https://github.com/jackskip22/rapier/tree/main/server) over your own folder or S3-compatible bucket.

## Preserve source precision

```js
import {readSource} from 'rapier-jxl/source';
import {encodeProfile} from 'rapier-jxl/icc';
import {withMetadata} from 'rapier-jxl/metadata';

export async function encodeSource(fileBytes, metadata = {}) {
  const {data, width, height, ...format} = await readSource(fileBytes);
  const jxl = encodeProfile(data, width, height, {...format, quality: 100, effort: 2});
  return withMetadata(jxl, metadata);
}
```

Keep `Uint16Array` integer samples at their declared 10-, 12-, or 16-bit depth. Pass binary16 as raw IEEE words in
`Uint16Array` with `sampleFormat: 'float16'`; pass binary32 as `Float32Array`. An 8-bit canvas readback cannot preserve
native precision. Carry the reader's color, transfer, luminance, and alpha options through to encoding.

Use the source reader for PNG16 and the supported flat scanline OpenEXR forms; use another reader for TIFF.
Carry PNG `iCCP` through `icc`; use `encodeProfile` for its returned custom `colorEncoding`. Ordinary `encode`
and the complete worker also accept RGB/GRAY `icc`. Keep original profile bytes with their original samples;
never relabel unchanged pixels as sRGB. Use planar color plus a black extra channel for CMYK with its original ICC.

## Encode a photographic preview

```js
import {encodePhoto} from 'rapier-jxl/photo';

export function photographicJXL(rgba8, width, height) {
  return encodePhoto(rgba8, width, height, {quality: 90, effort: 7});
}
```

To hit a visual quality instead of a quality number, encode to a score: the smallest file whose decoded picture scores
at least the SSIMULACRA2 target (or at most a Butteraugli distance).

```js
import {encodeToScore} from 'rapier-jxl/score';
const {bytes, ssimulacra2} = await encodeToScore(rgba8, width, height, {target: {ssimulacra2: 80}});
```

Use this recipe for ordinary 8-bit sRGB pixels. Alpha stays exact. Select quality by inspecting the decoded result
at its intended display size; quality numbers are not interchangeable with other encoders. Native precision and
HDR inputs use modular source-domain quantization below quality 100. Preserve a lossless master when creating
lossy derivatives.

## Add progression or authored structure

Use `encodePhoto` from `/photo-advanced` with `progressive: 'spectral'` for resolution passes, or `'successive'`
for coefficient refinement. Use `lfFrames: 1` for an sRGB preview pyramid, including alpha and explicit transforms or quantization. Deeper LF levels can alter rounding. `transforms: 'auto'` considers DCT8/16;
explicit names cover all 27 strategies. Compare the decoded result and complete file size before choosing a layout.
Use `noise: {iso: 800}` only when authored grain is wanted; it does not remove existing grain.

Use `/channels` for one or three color planes plus typed extras and a separate preview. Preserve independent plane
precision, names and sampling. Prefer per-frame extra `upsampling` to metadata `dimShift` for full-resolution color
in Chrome 155. Use `/layers` for authored crops and all five frame blends; use `/splines` and `splineStroke` for
authored additive XYB curves. Read [the API](https://github.com/jackskip22/rapier-jxl/blob/main/docs/reference/API.md)
for option schemas and the pinned decoders' resource limits. Heavy features have separate `/min` modules.

## Carry metadata

```js
import {withMetadata} from 'rapier-jxl/metadata';

export function attachMetadata(jxl, exifTiff, xmpPacket) {
  return withMetadata(jxl, {exif: exifTiff, xmp: xmpPacket});
}
export function removeXmp(jxl) {
  return withMetadata(jxl, {xmp: null});
}
```

`exif` is the raw Exif TIFF payload beginning with `II` or `MM`, without a JPEG APP1 header or `Exif\0\0` prefix.
`xmp` is a UTF-8 string or original UTF-8 bytes. Omitted fields remain unchanged; `null` removes the named field.
Other boxes remain unchanged. The helper does not extract metadata from source files or change pixels, color
encoding, or orientation. Keep Exif orientation consistent with the encoded image. Files containing JPEG
reconstruction data (`jbrd`) reject metadata edits.

## Transcode JPEG

```js
import {transcode} from 'rapier-jxl/jpeg';

export function encodeJpeg(jpegBytes) {
  return transcode(jpegBytes, {effort: 4, icc: 'preserve'});
}
```

This preserves admitted JPEG coefficients, quantization, subsampling, orientation, color declarations and original
JPEG syntax in standard `jbrd` metadata. `reconstructJPEG(bytes)` from the same entry point restores the original
JPEG bytes. Do not edit metadata on a carried JPEG: those edits invalidate reconstruction. Verify reconstructed
bytes before an application replaces an archival source.

## Run batches

Use workers for encoding and bound concurrency by available memory. Honor the requested effort without an
implicit timeout. Check each encoding entry point's pixel/edge `LIMITS` and any explicit byte budget; output uses available memory. Keep originals, write
outputs separately, and verify decoded samples and required metadata before an application replaces a source.
For lossy derivatives, retain the original master and encode from it to avoid repeated generation loss.

[API and format limits](https://github.com/jackskip22/rapier-jxl/blob/main/docs/reference/API.md) ·
[Worker example](https://github.com/jackskip22/rapier-jxl/blob/main/examples/worker.mjs)

## Stream and compress metadata

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
