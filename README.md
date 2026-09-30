# Rapier JXL

A JPEG XL encoder in pure JavaScript: one file, 36.3 kB, 15.0 kB gzipped, no WebAssembly, no
dependencies, MIT. The encoder inside [Rapier](https://rapier.website), published on its own. The smallest
JavaScript or WebAssembly JPEG XL encoder among the payloads [we measured](ENCODER-COMPARISON.md).

- **Lossless.** Every pixel back as it went in: 8-bit grey, grey with alpha, RGB, RGBA.
- **Lossy**, quality 1 to 99, for flat-colour rasters (screenshots, pixel art, scanned line art). Alpha stays exact.
  A picture of few colours is written exact when that is smaller.
- **Photographs**, optionally: `rapier-jxl/photo`, DCT8 compression with exact alpha, adding nothing to the core.
- **A JPEG carried as its coefficients**: one call, no decode, the way libjxl transcodes. Not carried: the
  reconstruction data (the JPEG file cannot be rebuilt), ICC, Exif beyond the orientation, XMP.

## Use it

```js
import {encode, transcode} from 'rapier-jxl';

const {data, width, height} = context.getImageData(0, 0, canvas.width, canvas.height);
const exact = encode(data, width, height);                  // lossless
const small = encode(data, width, height, {quality: 80});   // lossy
const blob = new Blob([small], {type: 'image/jxl'});

const {bytes, width: w, height: h, orientation} = transcode(new Uint8Array(await file.arrayBuffer()));
```

`encode(data, width, height, {quality = 100})` takes straight RGBA bytes, row by row, and returns a `Uint8Array`
holding a bare JPEG XL codestream. `transcode(jpeg)` returns `{bytes, width, height, orientation}`: the size as
shown, the orientation kept in the header.

```js
import {encodePhotoRGBA} from 'rapier-jxl/photo';
const photo = encodePhotoRGBA(data, width, height, {quality: 90});   // 100 is exact
```

Entries: `rapier-jxl` (the readable modules), `rapier-jxl/min` (one minified file), `rapier-jxl/lossless`,
`rapier-jxl/jpeg`, `rapier-jxl/photo`. Each minified file carries its MIT notice, TypeScript declarations sit
beside each entry, and a worker and a page are under `public/examples/`. Quality numbers are not the same fidelity
across encoders or pictures, and lossy is not always smaller than lossless.

### In a worker

Encoding is synchronous. Run it off the main thread:

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

To cancel, terminate the worker and drop its request id. Keep the input in the caller if you may retry.

### Limits and errors

One picture at a time, at most 16,384 pixels a side, 24 million pixels and a 16 MiB stream. Arguments are checked
before any work. A refusal is an `Error` whose `code` is `JXL_INPUT`, `JXL_DIMENSIONS`, `JXL_SIZE`, `JXL_MEMORY` or
`JXL_JPEG` (arithmetic coding, 12-bit, lossless, CMYK, a DNL height, a colour profile other than sRGB, or a JPEG
cut short: decode it and encode the pixels instead).

## Sizes

| file | bytes | gzip | Brotli |
| --- | ---: | ---: | ---: |
| `rapier-jxl.min.mjs`, core | 36,284 | 14,987 | 13,313 |
| `lossless.min.mjs`, `encodeLosslessRGBA` alone | 13,754 | 6,131 | 5,405 |
| `jpeg.min.mjs`, `transcode` alone | 27,750 | 11,590 | 10,243 |
| `photo.min.mjs`, photographic pixels | 22,563 | 9,768 | 8,627 |
| all readable modules, including photo | 102,565 | 31,745 | |

Exact bytes of this release's files, measured by the script that stages this repository; `sizes.json` carries
their hashes and tools (terser 5.51.2, Node v22.22.2; gzip 9, Brotli 11). Each minified file is proved at
staging to write the same bytes as its readable source.

What it writes: bare codestreams, 8-bit, prefix codes (never ANS), one frame, no preview, animation, ICC (sRGB is
declared), XYB, chroma-from-luma or filters. Lossless in modular mode, a palette of up to 2,048 colours weighed
against direct coding by actual length, groups of 256, reversible YCoCg, a predictor chosen per channel. Lossy
through Squeeze with exact alpha. Carried JPEGs in VarDCT with the JPEG's own tables. The photo entry writes DCT8
coefficients for the same writer.

## Checked

Tests and seeded structure-aware fuzzing in `public/test/`: `npm test`, decoded through
[jxl-oxide](https://github.com/tirr-c/jxl-oxide) 0.12.6 and FFmpeg's native libjxl (a missing native decoder is
reported, and fails in CI). Exact pixels and alpha where promised, fidelity where relevant, the accepted JPEG
forms, refusal of malformed input. The 30 September run put 2,000,000 JPEG mutations and 32,768 pixel cases
through both decoders. The two decoders differ by one RGB unit on some JPEG and photo streams (floating-point
reconstruction), kept in `public/test/seeds/`; alpha and modular output are exact. With a C compiler and libjxl
headers, `npm run fuzz:scale -- --out fuzz-run --workers 4` repeats the fixed budget.

## Why

Rapier keeps pictures inside Markdown, and its standard says a raster picture in Markdown is JPEG XL: exact where
it must be, small where it may be. Drawings stay SVG. An editor carrying an encoder offline in a small page needed
one this size, and none existed. The standard is at [rapier.website](https://rapier.website); for an agent, see
`AGENTS.md`.

## Licence

MIT, copyright rapier.website. The design follows ISO/IEC 18181 and libjxl's encoders, whose sources were read;
none of their code is here.
