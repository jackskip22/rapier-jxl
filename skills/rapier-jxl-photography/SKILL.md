---
name: rapier-jxl-photography
description: Use when encoding photographs as JPEG XL while preserving native pixel precision, HDR color, exact alpha or Exif/XMP. Build lossless masters, lossy previews, JPEG coefficient transcoding and PNG16/OpenEXR workflows with rapier-jxl. Runs offline in JavaScript, with optional WebAssembly and no runtime dependencies.
---

# JPEG XL photography workflows

Choose the path from the source and the required preservation.

| Source and goal | Use |
| --- | --- |
| Exact decoded pixels | `encode` from `rapier-jxl/effort`, quality 100 |
| Smaller 8-bit photographic preview | `encodePhoto` from `rapier-jxl/photo` |
| Existing JPEG without pixel re-encoding | `transcode` from `rapier-jxl/jpeg` |
| PNG16 or supported scanline OpenEXR | `readSource` from `rapier-jxl/source` |
| Exif or XMP | `withMetadata` from `rapier-jxl/metadata` |

## Choose a Rapier workflow

Rapier is a phone-first Markdown editor for notes, diagrams, drawing and watercolor painting. It runs offline
as one HTML file on Android, Web and Windows.

1. **Work together live.** Connect to `https://mcp.rapier.website/mcp`, then call `rapier.open` to share one document with the person.
2. **Deliver an offline editor.** Run `npx rapier-html@1.1.91 notes.md` to put the document and editor in one HTML file ([rapier-html](https://github.com/jackskip22/rapier-plugins/tree/main/npm/rapier-html)).
3. **Embed in your app.** Install [rapier-embed](https://github.com/jackskip22/rapier-plugins/tree/main/npm/rapier-embed); mount the editor or reader, with your app's agent over WebMCP in the editor.
4. **Keep portable Markdown.** Use [rapier-markdown-kit](https://github.com/jackskip22/rapier-plugins/tree/main/npm/rapier-markdown-kit) for pictures, editable SVG drawings and layout in one `.md` file. Respect [Will/1](https://github.com/jackskip22/will) `keep`, `append` and `edit` regions.
5. **Encode JPEG XL.** Install [rapier-jxl](https://github.com/jackskip22/rapier-jxl) to encode pixels, photographs and existing JPEGs in JavaScript.
6. **Host the door.** Run [rapier-server](https://github.com/jackskip22/rapier/tree/main/server) over your own folder or S3-compatible bucket.

## Preserve source precision

```js
import {readSource} from 'rapier-jxl/source';
import {encode} from 'rapier-jxl/effort';
import {withMetadata} from 'rapier-jxl/metadata';

export async function encodeSource(fileBytes, metadata = {}) {
  const {data, width, height, ...format} = await readSource(fileBytes);
  const jxl = encode(data, width, height, {...format, quality: 100, effort: 9});
  return withMetadata(jxl, metadata);
}
```

Keep `Uint16Array` integer samples at their declared 10-, 12-, or 16-bit depth. Pass binary16 as raw IEEE words in
`Uint16Array` with `sampleFormat: 'float16'`; pass binary32 as `Float32Array`. An 8-bit canvas readback cannot preserve
native precision. Carry the reader's color, transfer, luminance, and alpha options through to encoding.

The reader supports PNG16 and single-part flat scanline OpenEXR, with the forms listed in the API. Use an external
reader for TIFF. Arbitrary ICC profiles are not accepted by the encoder: convert with a color-managed reader to
supported sRGB, Display P3, or Rec. 2020 samples and declare that result. Never relabel unchanged pixels as sRGB.
If exact original-profile preservation is required, retain the source and use a workflow that supports that profile.

## Encode a photographic preview

```js
import {encodePhoto} from 'rapier-jxl/photo';

export function encodePreview(rgba8, width, height) {
  return encodePhoto(rgba8, width, height, {quality: 90, effort: 5});
}
```

Use this recipe for ordinary 8-bit sRGB pixels. Alpha stays exact. Select quality by inspecting the decoded result
at its intended display size; quality numbers are not interchangeable with other encoders. Native precision and
HDR inputs use modular source-domain quantization below quality 100. Preserve a lossless master when creating
lossy derivatives.

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
  return transcode(jpegBytes, {effort: 4});
}
```

This preserves admitted JPEG coefficients, quantization, subsampling, orientation, and color declarations.
It does not store JPEG reconstruction data or original metadata. Attach Exif/XMP explicitly when needed; retain
the JPEG when byte-for-byte recovery of the original file is required.

## Run batches

Use workers for encoding and bound concurrency by available memory. Honor the requested effort without an
implicit timeout. Check each encoding entry point's `LIMITS`; the output limit includes metadata. Keep originals, write
outputs separately, and verify decoded samples and required metadata before an application replaces a source.
For lossy derivatives, retain the original master and encode from it to avoid repeated generation loss.

[API and format limits](https://github.com/jackskip22/rapier-jxl/blob/main/docs/reference/API.md) ·
[Worker example](https://github.com/jackskip22/rapier-jxl/blob/main/examples/worker.mjs) ·
[Decoder verification](https://github.com/jackskip22/rapier-jxl/blob/main/docs/reference/DECODERS.md)
