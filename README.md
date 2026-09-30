# Rapier JXL

A JPEG XL encoder in pure JavaScript. No WebAssembly, no build step, no dependency, nothing fetched at run
time. It is the encoder inside [Rapier](https://rapier.website), the single-file Markdown editor, offered on its
own so any app can write JPEG XL pictures with the bytes it can afford: one file of 40.3 kB,
15.9 kB gzipped, MIT. The smallest JavaScript/WebAssembly JPEG XL encoder among the published
payloads [we measured](ENCODER-COMPARISON.md); the table explains the scope and how to reproduce it.

- **Lossless.** Every pixel comes back as it went in. 8-bit grey, grey with alpha, RGB and RGBA.
- **Lossy.** Quality 1 to 99, on libjxl's modular path (the Squeeze transform), for drawings, screenshots and
  pictures of few colours; alpha stays exact. A picture of few colours is answered exact when that is fewer bytes.
- **Photographs, optionally.** Import `rapier-jxl/photo` for DCT8 photographic compression with exact alpha.
  This separate module shares the JPEG carrier's VarDCT writer and adds no bytes to the core import.
- **A JPEG carried as its coefficients.** A JPEG's quantised DCT coefficients, quantisation tables, subsampling
  and Exif orientation go into a JPEG XL frame the way libjxl transcodes them, so the picture decodes to the
  JPEG's own pixels at about a fifth fewer bytes, in one call, without decoding. Not carried: the JPEG
  reconstruction data (the JPEG file cannot be rebuilt from the stream), ICC, Exif beyond the orientation, XMP.

The retained corpus and seeded fuzz cases are decoded through jxl-oxide and native libjxl (below).

## Use it

```js
import {encode, transcode} from 'rapier-jxl';

// Pixels from a canvas (straight RGBA, row by row) to a JPEG XL codestream.
const {data, width, height} = context.getImageData(0, 0, canvas.width, canvas.height);
const exact = encode(data, width, height);                  // lossless
const small = encode(data, width, height, {quality: 80});   // lossy
const blob = new Blob([small], {type: 'image/jxl'});

// A JPEG file to JPEG XL, its pixels kept.
const jpeg = new Uint8Array(await file.arrayBuffer());
const {bytes, width: w, height: h, orientation} = transcode(jpeg);
```

`encode(data, width, height, {quality = 100})` takes a `Uint8Array` or `Uint8ClampedArray` of `width * height * 4`
bytes and returns a `Uint8Array` holding a bare JPEG XL codestream (the `.jxl` file's bytes). `transcode(jpeg)`
takes a JPEG's bytes and returns `{bytes, width, height, orientation}`; the width and height are the picture's as
shown (swapped when the Exif orientation turns it), and the orientation is kept in the JPEG XL header.

Four complete ES modules carry their MIT notice inside: `rapier-jxl.min.mjs` (core; `rapier-jxl/min`),
`lossless.min.mjs` (`encodeLosslessRGBA`, `LIMITS`; `rapier-jxl/lossless`), `jpeg.min.mjs` (`transcode`, `LIMITS`;
`rapier-jxl/jpeg`), and `photo.min.mjs` (`encodePhotoRGBA`, `LIMITS`; `rapier-jxl/photo`). The readable modules
are beside them, `index.mjs` the core entry and `photo.mjs` the optional photo entry. Copy a complete bundle
into an app, or install the package. The checked entries are `encode`, `encodeLosslessRGBA`,
`encodeLossyRGBA`, `encodePhotoRGBA` and `transcode`; the raw
`encodeLossless`, `encodeLossy`, `transcodeJPEG`, `parseJPEG` and `inspectPixels` beneath them take input the
checked entries have already admitted and may throw plain errors on anything else.

```js
import {encodePhotoRGBA} from 'rapier-jxl/photo';
const photo = encodePhotoRGBA(data, width, height, {quality: 90});
```

The photo entry defaults to quality 90; quality 100 is exact lossless. Its 1–99 range controls photographic
quantisation, while `encode` retains its artwork-oriented modular path. Quality numbers do not promise
identical PSNR between codecs or images. Neither lossy entry promises fewer bytes than lossless for every input.

### In a worker

Encoding is synchronous; large pictures can take seconds, so run it off the main thread. A complete worker is this:

```js
// jxl-worker.mjs
import {encode, transcode} from 'rapier-jxl';
self.onmessage = ({data: {id, op, ...ask}}) => {
  try {
    const out = op === 'transcode' ? transcode(ask.jpeg) : {bytes: encode(ask.data, ask.width, ask.height, {quality: ask.quality})};
    self.postMessage({id, ok: true, ...out}, [out.bytes.buffer]);
  } catch (error) { self.postMessage({id, ok: false, code: error.code || 'JXL_ERROR', message: String(error.message || error)}); }
};
```

Post `{id, op: 'encode', data, width, height, quality}` or `{id, op: 'transcode', jpeg}`; receive `{id, ok: true,
bytes, ...}` or `{id, ok: false, code, message}`, the output bytes transferred. To cancel synchronous work,
terminate that dedicated worker and discard its request ID. A queued abort message cannot interrupt a
synchronous encode. Keep the input buffer in the caller if retry is needed; posting it without a transfer list
copies it, while transferring it gives ownership to the worker.

### Limits and errors

One picture at a time, at most 16,384 pixels on a side, 24 million pixels, and a 16 MiB stream. The arguments are
read before any work, and a JPEG's header before a byte of it is allocated. A refusal is an `Error` whose `code`
is one of `JXL_INPUT` (the arguments), `JXL_DIMENSIONS`, `JXL_SIZE`, `JXL_MEMORY` (the engine ran out of memory)
or `JXL_JPEG`: a JPEG the carrier does not take (arithmetic coding, 12-bit, lossless, CMYK, a DNL height, a colour
profile other than sRGB), or a JPEG cut short or out of order, which is refused rather than carried with pixels
invented; decode such a JPEG and encode its pixels instead. A checked call returns a stream or throws one of these.

## Sizes

| file | bytes | gzip | Brotli |
| --- | ---: | ---: | ---: |
| `rapier-jxl.min.mjs`, core | 40,286 | 15,904 | 14,096 |
| `lossless.min.mjs`, `encodeLosslessRGBA` alone | 16,085 | 6,747 | 5,948 |
| `jpeg.min.mjs`, `transcode` alone | 30,624 | 12,274 | 10,866 |
| `photo.min.mjs`, photographic pixels | 25,418 | 10,409 | 9,209 |
| all readable modules, including photo | 103,193 | 31,376 | |

Exact bytes of this release's files, measured by the script that stages this repository; `sizes.json` carries
their hashes and the tools (terser 5.51.2, Node v22.22.2; gzip at level 9, Brotli at quality 11). A minified
file keeps every check and every export it names, and is proved at staging to encode what the readable source
encodes; the readable modules' gzip is of their concatenation.

What it writes, so a decoder's author knows what to expect: bare codestreams (no container box), 8-bit only,
prefix codes only (never ANS), one frame, no preview, no animation, no ICC profile (sRGB is declared, and a JPEG
with another profile is refused), no XYB, no chroma-from-luma, no filters. Lossless pictures use modular mode,
comparing a palette of up to 512 colours with direct encoding by actual stream length, in groups of 256 by 256
pixels. Measured prediction and colour-transform choices keep smooth artwork and independent channels small.
Lossy artwork uses the Squeeze transform with exact alpha. Carried JPEGs use VarDCT with the JPEG's quantisation
tables as raw dequantisation matrices. The photo entry produces DCT8 coefficients from pixels for the same writer.

## Why it exists

Rapier keeps pictures inside Markdown documents, and the standard it publishes says the best way to embed a
picture in a Markdown document is JPEG XL: exact where it must be exact, small where it may be small, one format
for photographs, paintings and diagrams alike. An editor that follows the standard needs an encoder it can carry
offline in a page that must stay small, and none existed at the size, so Rapier wrote one. This repository is
that encoder, unchanged, republished from Rapier's tree at each of its releases.

If your app embeds pictures in Markdown, the standard is at [rapier.website](https://rapier.website) and the
encoder is this one: tell your agent to add `rapier-jxl` (see `AGENTS.md`) and it is done.

## How it is checked

Tests and deterministic structure-aware fuzzing live in `public/test/`, with small JPEG seeds and generated pixel
cases. Install the development dependencies and run `npm test`. The workflow requires both
[jxl-oxide](https://github.com/tirr-c/jxl-oxide) 0.12.6 and FFmpeg's native libjxl decoder; a missing native oracle
is explicitly reported locally and is a failure in CI. Cases compare exact pixels and alpha where promised,
lossy fidelity where relevant, accepted JPEG content, and refusal of malformed inputs. Staging also proves each
minified entry returns the same bytes as its readable source. The 30 September audit's 131 pixel cases and
36 JPEG forms remain the acceptance baseline. These checks cover their inputs, not every possible codestream
or every decoder implementation.

## Licence

MIT, copyright rapier.website. The design follows the JPEG XL specification (ISO/IEC 18181) and libjxl's
encoders, whose sources were read; none of their code is here.
