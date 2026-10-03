# Rapier JXL

A JPEG XL encoder in pure JavaScript: one file, 19.5 kB, 8.5 kB gzipped, no WebAssembly, no
dependencies, MIT. The encoder inside [Rapier](https://rapier.website), published on its own. The smallest
JavaScript or WebAssembly JPEG XL encoder among the payloads [we measured](ENCODER-COMPARISON.md).

- **Lossless.** Every pixel back as it went in: 8-bit grey, grey with alpha, RGB, RGBA.
- **Lossy**, quality 1 to 99, for flat-colour rasters (screenshots, pixel art, scanned line art). Alpha stays exact.
  A picture of few colours is written exact when that is smaller.
- **Smaller exact pictures, slower**: `rapier-jxl/effort`, the same `encode` with `{effort: 2}`, `3`, `4` or `6`, each never
  larger than the effort below. Effort 1, its default, is the core's bytes.
- **Photographs**: `rapier-jxl/photo`, DCT8 compression with exact alpha, a door of its own. Effort 5 searches
  quantisation per block and keeps a candidate only when its complete stream is smaller.
- **A JPEG carried as its coefficients**: `rapier-jxl/jpeg`, one call, no decode, the way libjxl transcodes. Not
  carried: the reconstruction data (the JPEG file cannot be rebuilt), the ICC bytes, Exif beyond the orientation, XMP.
- **Optional ANS entropy coding**: import `transcode` from `rapier-jxl/jpeg-ans` or `encodePhoto` from
  `rapier-jxl/photo-ans` and pass `{effort: 2}`. Each tries ANS after writing the prefix-coded floor and keeps
  the smaller complete stream, with identical reconstructed pixels. These imports leave the core unchanged.
- **sRGB or Display P3.** `{colorSpace: 'display-p3'}` declares a wide-gamut canvas's samples. A JPEG's profile is
  read by what it does, not what it says: sRGB and Display P3 are carried and declared.

## Use it

```js
import {encode} from 'rapier-jxl';
import {transcode} from 'rapier-jxl/jpeg';
import {encodePhoto} from 'rapier-jxl/photo';

const {data, width, height} = context.getImageData(0, 0, canvas.width, canvas.height);
const exact = encode(data, width, height);                  // lossless
const small = encode(data, width, height, {quality: 80});   // lossy
const photo = encodePhoto(data, width, height);             // quality 90; 100 is exact
const blob = new Blob([small], {type: 'image/jxl'});

const {bytes, width: w, height: h, orientation} = transcode(new Uint8Array(await file.arrayBuffer()));
```

`encode(data, width, height, {quality = 100})` takes straight RGBA bytes, row by row, and returns a `Uint8Array`
holding a bare JPEG XL codestream; `encodePhoto` takes the same. `transcode(jpeg)` returns
`{bytes, width, height, orientation}`: the size as shown, the orientation kept in the header.

Doors: `rapier-jxl` (the core), `rapier-jxl/effort`, `rapier-jxl/jpeg`, `rapier-jxl/photo`, and the two optional
ANS doors above, each readable, so a
bundler carries their shared modules once; `rapier-jxl/min` is the core as one minified file. `rapier-jxl/writer`
gives a module's author the layers beneath the doors (readable only; they change only with the major version).
TypeScript declarations sit beside each door, and a worker and a page are under `public/examples/`. Quality numbers
are not the same fidelity across encoders or pictures, and lossy is not always smaller than lossless.

The photo door defaults to effort 1. Its higher efforts keep the preceding stream as a candidate; effort 5 also
bounds effort 1's unclipped RGB sample reconstruction error on edge-extended DCT blocks, before clipping and integer output.
Decoded integer RGB error can differ from that model. Quality 100 remains exact at every effort.
The quantisation search keeps the preceding stream when its estimated memory would exceed the photo door's
working budget; the door's 40-million-pixel admission stays the same.

### In a worker

Encoding is synchronous. Run it off the main thread:

```js
// jxl-worker.mjs
import {encode} from 'rapier-jxl';
import {transcode} from 'rapier-jxl/jpeg';
self.onmessage = ({data: {id, op, ...ask}}) => {
  try {
    const out = op === 'transcode' ? transcode(ask.jpeg) : {bytes: encode(ask.data, ask.width, ask.height, {quality: ask.quality})};
    self.postMessage({id, ok: true, ...out}, [out.bytes.buffer]);
  } catch (error) { self.postMessage({id, ok: false, code: error.code || 'JXL_ERROR', message: String(error.message || error)}); }
};
```

To cancel, terminate the worker and drop its request id. Keep the input in the caller if you may retry.

Each door has a twin that does the same work in steps: `encodeSteps`, `transcodeSteps`, `encodePhotoSteps` return a
job, `for (const done of job)` runs one group of one pass per step (`done` is the fraction, the last exactly 1), and
`job.bytes` is the stream after the loop, the same bytes the door writes. Leaving the loop cancels, so a worker can
take messages and report progress between steps (`public/examples/worker.mjs`). `job.hurry = true` (the example's
`deadline` sets it) ends a door's search at its next step with the smallest stream written so far, never
larger than effort 1's.

The JPEG and photograph doors also read effort: 3 tries a 32-cluster budget, and 4 also tries an order learned
from coefficient counts. These entropy rungs keep the smaller complete stream and preserve every reconstructed pixel. Their
default remains 1; effort 2 keeps the default plan. A hurried JPEG job finishes its effort-1 floor in its first
half; through effort 4 the photo job first makes coefficients, then writes that floor, and searches in its final
quarter. At effort 5, its first half finishes the preceding stream and its second half searches quantisation,
keeping the completed floor on a hurry.

The optional ANS doors keep default effort 1's prefix bytes. Effort 2 adds one ANS candidate; efforts 3 and 4
also retain the ordinary prefix searches, and photo effort 5 retains its quantisation search. ANS uses a bounded
group buffer of 1,376,256 bytes plus histogram tables; encoding both candidates costs more CPU and may raise peak
RSS. Hurry keeps a completed candidate even when it arrives at the final group's yield.

Version 2.1.0 fits the photo door's existing quantisation constants across thumbnail and source-sized photos.
Lossy photo bytes change deliberately; lossless and ordinary JPEG streams retain their hashes. Pin a package
version when exact lossy output bytes matter. Quality numbers remain a setting, not a guarantee of equal
perceptual quality on every image.

### Limits and errors

One picture at a time, at most 16,384 pixels a side and a 16 MiB stream. Each door's `LIMITS` sets its pixels by its
memory, so that none needs more at its limit than the core at its own: 24 million for the core and `effort` (a lossy
picture holds its planes whole, 15.7 bytes a pixel at its peak besides the input), 40 million for `photo` (6.5), and
64 million for a JPEG that `jpeg` carries (3.3 at 4:2:0, 6.4 at 4:4:4), so a phone's 24 and 48 megapixel
photographs are carried. Arguments are checked before any work. A refusal is an `Error` whose `code` is `JXL_INPUT`,
`JXL_DIMENSIONS`, `JXL_SIZE`, `JXL_MEMORY` or `JXL_JPEG` (arithmetic coding, 12-bit, lossless, CMYK, a DNL height, a
colour profile other than sRGB or Display P3, or a JPEG cut short: decode it and encode the pixels instead).

### From 1.x

2.0.0 is the package's own version (1.x took Rapier's), and the core is pixels only:

- `transcode` is in `rapier-jxl/jpeg`, and `encodePhotoRGBA` is `encodePhoto` in `rapier-jxl/photo`.
- `encodeLosslessRGBA(data, width, height)` and `rapier-jxl/lossless` are `encode(data, width, height)`;
  `encodeLossyRGBA(data, width, height, quality)` is `encode(data, width, height, {quality})`.
- `encodeLossless`, `encodeLossy`, `inspectPixels`, `parseJPEG` and `transcodeJPEG` are in `rapier-jxl/writer`.
- A JPEG's colour profile is read by what it does: Display P3 (an iPhone's) is carried and declared, where 1.x
  refused it; a profile of lookup tables is refused, even one named sRGB.
- Lossless streams and carried JPEGs are 1.x's bytes. Lossy streams of a picture wider or taller than 256 pixels,
  or of a colour picture one pixel wide or high, and every photo stream changed where Chrome's decoder (jxl-rs
  0.7.4) misread a valid stream; each decodes to the same pixels as before through jxl-oxide and libjxl.

New: `rapier-jxl/effort`, each door's twin in steps with `hurry`, `colorSpace: 'display-p3'`, each door's own
`LIMITS`.

## Sizes

| file | bytes | gzip | Brotli | added to the core, gzip |
| --- | ---: | ---: | ---: | ---: |
| `rapier-jxl.min.mjs`, the core: `encode` | 19,539 | 8,511 | 7,515 | |
| `effort.min.mjs`: `encode` with effort | 30,008 | 12,320 | 10,860 | 3,809 |
| `jpeg.min.mjs`: `transcode` | 32,218 | 13,439 | 11,874 | 8,497 |
| `photo.min.mjs`: `encodePhoto` | 31,288 | 12,872 | 11,370 | 6,257 |
| `jpeg-ans.min.mjs`: optional ANS carrier | 35,281 | 14,506 | 12,804 | 9,564 |
| `photo-ans.min.mjs`: optional ANS photo | 34,293 | 13,899 | 12,295 | 7,298 |
| every door in one bundle | 61,101 | 24,091 | 21,147 | |
| all readable modules | 174,894 | 53,445 | | |

Exact bytes of release 2.1.0's files, measured by the script that stages this repository; `sizes.json`
carries their hashes and tools (terser 5.51.2, Node v22.22.2; gzip 9, Brotli 11). Each minified file stands alone
and is proved at staging to write the same bytes as its readable source; the last column is what a door adds to a
bundle that already holds the core. `effort`'s `encode` is the core's at effort 1, so it takes the core's place, in
that column and in the bundle of every door.

What it writes: bare codestreams, 8-bit, prefix codes (or ANS in the optional doors), one frame, no preview, animation, ICC (sRGB or
Display P3 is declared), XYB, chroma-from-luma or filters. Lossless in modular mode, a palette of up to 2,048
colours weighed against direct coding by actual length, groups of 256, reversible YCoCg, a predictor chosen per
channel; at effort 2 and 3 also the weighted predictor, its contexts split by its own error; at 4 local modelling of
palette indices; at 6 local gradient-property splits. Effort 5 uses rung 4. Lossy through Squeeze
with exact alpha. Carried JPEGs in VarDCT with the JPEG's own tables. The photo door
writes DCT8 coefficients for the same writer.

## Checked

Tests and seeded structure-aware fuzzing in `public/test/`: `npm test`, decoded through
[jxl-oxide](https://github.com/tirr-c/jxl-oxide) 0.12.6 and FFmpeg's native libjxl (a missing native decoder is
reported, and fails in CI). Exact pixels and alpha where promised, fidelity where relevant, the accepted JPEG
forms, refusal of malformed input. The same input writes the same bytes in every JavaScript engine: nothing that
decides a byte uses a function engines round differently, and `public/test/bytes.test.mjs` holds the streams' hashes
under Node and Bun. The 30 September run put 2,000,000 JPEG mutations and 32,768 pixel cases
through both decoders. The two decoders differ by one RGB unit on some JPEG and photo streams (floating-point
reconstruction), kept in `public/test/seeds/`; alpha and modular output are exact. With a C compiler and libjxl
headers, `npm run fuzz:scale -- --out fuzz-run --workers 4` repeats the fixed budget.

## Why

Rapier keeps pictures inside Markdown, and its standard defaults to JPEG XL for raster pictures in Markdown: exact where
it must be, small where it may be. Drawings stay SVG. An editor carrying an encoder offline in a small page needed
one this size, and none existed. The standard is at [rapier.website](https://rapier.website); for an agent, see
`AGENTS.md`.

## Licence

MIT, copyright rapier.website. The design follows ISO/IEC 18181 and libjxl's encoders, whose sources were read;
none of their code is here.
