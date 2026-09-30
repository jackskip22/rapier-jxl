# Rapier JXL

A JPEG XL encoder in pure JavaScript. No WebAssembly, no build step, no dependency, nothing fetched at run
time. It is the encoder inside [Rapier](https://rapier.website), the single-file Markdown editor, offered on its
own so any app can write JPEG XL pictures with the bytes it can afford: one file of 39.4 kB,
15.4 kB gzipped, MIT. The smallest JPEG XL encoder we know of; if you know a smaller one, tell us.

- **Lossless.** Every pixel comes back as it went in. 8-bit grey, grey with alpha, RGB and RGBA.
- **Lossy.** Quality 1 to 99, on libjxl's modular path (the Squeeze transform), for drawings, screenshots and
  pictures of few colours; a picture of few colours is answered exact when that is fewer bytes.
- **A JPEG carried as its coefficients.** A JPEG's quantised DCT coefficients, quantisation tables, subsampling
  and Exif orientation go into a JPEG XL frame the way libjxl transcodes them, so the picture decodes to the
  JPEG's own pixels at about a fifth fewer bytes, in one call, without decoding. Not carried: the JPEG
  reconstruction data (the JPEG file cannot be rebuilt from the stream), ICC, Exif beyond the orientation, XMP.

Every stream is checked at each release against jxl-oxide and libjxl (below).

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

Three files to choose from, each a complete ES module with its MIT notice inside: `rapier-jxl.min.mjs`
(everything; `rapier-jxl/min`), `lossless.min.mjs` (`encodeLosslessRGBA` and `LIMITS` alone; `rapier-jxl/lossless`)
and `jpeg.min.mjs` (`transcode` and `LIMITS` alone; `rapier-jxl/jpeg`). The readable source is the eleven `.mjs`
files beside them, `index.mjs` the entry (`rapier-jxl`): copy them into an app as they are, or install the
package. The checked entries are `encode`, `encodeLosslessRGBA`, `encodeLossyRGBA` and `transcode`; the raw
`encodeLossless`, `encodeLossy`, `transcodeJPEG`, `parseJPEG` and `inspectPixels` beneath them take input the
checked entries have already admitted and may throw plain errors on anything else.

### In a worker

Encoding is synchronous and takes tens to hundreds of milliseconds on a large picture, so do it off the main
thread. A complete worker is this:

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
bytes, ...}` or `{id, ok: false, code, message}`, the bytes transferred, never copied.

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
| `rapier-jxl.min.mjs`, everything | 39,447 | 15,417 | 13,651 |
| `lossless.min.mjs`, `encodeLosslessRGBA` alone | 16,028 | 6,637 | 5,842 |
| `jpeg.min.mjs`, `transcode` alone | 30,185 | 12,042 | 10,637 |
| the eleven readable modules | 94,845 | 28,403 | |

Exact bytes of this release's files, measured by the script that stages this repository; `sizes.json` carries
their hashes and the tools (terser 5.51.2, Node v22.22.2; gzip at level 9, Brotli at quality 11). A minified
file keeps every check and every export it names, and is proved at staging to encode what the readable source
encodes; the readable modules' gzip is of their concatenation.

What it writes, so a decoder's author knows what to expect: bare codestreams (no container box), 8-bit only,
prefix codes only (never ANS), one frame, no preview, no animation, no ICC profile (sRGB is declared, and a JPEG
with another profile is refused), no XYB, no chroma-from-luma, no filters. Lossless pictures use the modular
mode with a palette of up to 512 colours, the reversible YCoCg transform, the clamped-gradient predictor and one
prefix code per channel, in groups of 256 by 256 pixels. Lossy pictures use the modular mode with the Squeeze
transform. Carried JPEGs use the VarDCT mode with the JPEG's own quantisation tables as raw dequantisation
matrices.

## Why it exists

Rapier keeps pictures inside Markdown documents, and the standard it publishes says the best way to embed a
picture in a Markdown document is JPEG XL: exact where it must be exact, small where it may be small, one format
for photographs, paintings and diagrams alike. An editor that follows the standard needs an encoder it can carry
offline in a page that must stay small, and none existed at the size, so Rapier wrote one. This repository is
that encoder, unchanged, republished from Rapier's tree at each of its releases.

If your app embeds pictures in Markdown, the standard is at [rapier.website](https://rapier.website) and the
encoder is this one: tell your agent to add `rapier-jxl` (see `AGENTS.md`) and it is done.

## How it is checked

Rapier's own tree holds the tests: every stream this encoder writes is decoded again through
[jxl-oxide](https://github.com/tirr-c/jxl-oxide) and compared pixel by pixel (exact where exactness is promised,
above 38 dB where it is not, one stream for every JPEG form of one picture, an RGB JPEG's flat field at every DC
step); what it refuses is tested too (a header past the limits, a JPEG cut short, a scan out of order, a colour
profile other than sRGB); and the staged files are proved to encode what the source encodes. An independent
audit of 30 September 2026 decoded 131 pixel cases and 36 JPEG forms through jxl-oxide 0.12.6 and libjxl 0.7;
its findings are fixed in this release. This repository is republished from that tree at each release, so what is
here has passed them.

## Licence

MIT, copyright rapier.website. The design follows the JPEG XL specification (ISO/IEC 18181) and libjxl's
encoders, whose sources were read; none of their code is here.
