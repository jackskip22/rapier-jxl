# Rapier JXL

A JPEG XL encoder in pure JavaScript. No WebAssembly, no build step, no dependency, nothing fetched at run
time. It is the encoder inside [Rapier](https://rapier.website), the single-file Markdown editor, offered on its
own so any app can write JPEG XL pictures with the bytes it can afford: 24.7 KB gzipped
(83.7 KB of readable source), MIT.

- **Lossless.** Every pixel comes back as it went in. 8-bit grey, grey with alpha, RGB and RGBA.
- **Lossy.** Quality 1 to 99, on libjxl's modular path (the Squeeze transform), for drawings, screenshots and
  pictures of few colours; a picture of few colours is answered exact when that is fewer bytes.
- **A JPEG carried whole.** A JPEG's coefficients go into a JPEG XL frame untouched, the way libjxl transcodes one,
  so the picture decodes to the JPEG's own pixels at about a fifth fewer bytes, in one call, without decoding.

Every browser that reads JPEG XL reads these streams; so do libjxl, jxl-oxide and everything built on them.

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

Named entries for a tighter bundle: `encodeLosslessRGBA`, `encodeLossyRGBA`, `transcode`, and the raw
`encodeLossless`, `encodeLossy`, `transcodeJPEG`, `parseJPEG`, `inspectPixels` beneath them. The whole module is
the eleven `.mjs` files at the root of this repository: copy them into an app as they are, or install the package.

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

One picture at a time, at most 16,384 pixels on a side, 24 million pixels, and a 16 MiB stream. Anything else is
refused before any work with an `Error` whose `code` is one of `JXL_INPUT` (the arguments), `JXL_DIMENSIONS`,
`JXL_SIZE`, `JXL_MEMORY` (the engine ran out of memory) or `JXL_JPEG` (a JPEG the carrier does not take:
arithmetic coding, 12-bit, lossless, CMYK or a DNL height; decode it and encode its pixels instead). There is no
other failure: a call either returns a stream every decoder reads or throws one of these.

## Sizes

| what | source | gzipped |
| --- | --- | --- |
| the whole module (the eleven files) | 83.7 KB | 24.7 KB |
| lossless only (`encodeLosslessRGBA`) | 35.7 KB | 11.0 KB |
| the JPEG carrier only (`transcode`) | 60.1 KB | 18.0 KB |

Measured on this release's files by the script that stages this repository, gzip at level 9, before any
minifier. A bundler that drops what you do not import lands between the rows.

What it writes, so a decoder's author knows what to expect: bare codestreams (no container box), 8-bit only,
prefix codes only (never ANS), one frame, no preview, no animation, no ICC profile (sRGB is declared), no
XYB, no chroma-from-luma, no filters. Lossless pictures use the modular mode with a palette of up to 512
colours, the reversible YCoCg transform, the clamped-gradient predictor and one prefix code per channel, in
groups of 256 by 256 pixels. Lossy pictures use the modular mode with the Squeeze transform. Carried JPEGs use
the VarDCT mode with the JPEG's own quantisation tables as raw dequantisation matrices.

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
above 38 dB where it is not, one stream for every JPEG form of one picture), and the page's retained checks run
the same before each release. This repository is republished from that tree at each release, so what is here has
passed them.

## Licence

MIT, copyright rapier.website. The design follows the JPEG XL specification (ISO/IEC 18181) and libjxl's
encoders, whose sources were read; none of their code is here.
