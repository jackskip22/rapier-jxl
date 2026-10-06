# Rapier JXL

A JPEG XL encoder in pure JavaScript. It writes `.jxl` from canvas pixels or a JPEG in a browser, a worker, Node or
Deno. No dependencies, no server, MIT.

- The core is one file of 21.3 kB, 9.3 kB gzipped: the smallest JavaScript or WebAssembly JPEG XL
  encoder in the [payloads measured](docs/ENCODER-COMPARISON.md).
- Lossless and lossy in one `encode` call; alpha stays exact at every quality.
- Photographs, JPEGs carried without decoding, smaller exact files at more time and WebAssembly acceleration are
  separate imports, loaded only when used.
- The same input writes the same bytes in every JavaScript engine.

```sh
npm install rapier-jxl
```

## Use

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
holding a bare JPEG XL codestream. `{colorSpace: 'display-p3'}` declares a wide-gamut canvas. `transcode(jpeg)` returns
`{bytes, width, height, orientation}`. TypeScript declarations sit beside each module in `src/`.

Calls are synchronous: run them in a worker (`examples/worker.mjs`, `examples/browser.html`). Each door has a
twin that works in steps (`encodeSteps`, `transcodeSteps`, `encodePhotoSteps`): loop over the job for progress, leave
the loop to cancel, set `job.hurry = true` to finish with the smallest stream written so far.

## Imports

| import | what it does |
| --- | --- |
| `rapier-jxl` | `encode`: 8-bit grey, grey with alpha, RGB and RGBA. Quality 100 is lossless; 1 to 99 is lossy, for flat-colour rasters. |
| `rapier-jxl/min` | The core as one minified file. |
| `rapier-jxl/effort` | The same `encode` with `{effort: 2, 3, 4 or 6}`: smaller exact files, more time, never larger than the effort below. Effort 1 is the core. From effort 3, screenshots, text and drawings also get exact palettes, repeated-run matching and a repeated-glyph dictionary, often half the size or less. See [docs/SCREENSHOTS.md](docs/SCREENSHOTS.md). |
| `rapier-jxl/wasm` | The effort door with integer WebAssembly SIMD kernels; the same bytes, JavaScript when SIMD is unavailable. See [docs/KERNELS.md](docs/KERNELS.md). |
| `rapier-jxl/photo` | `encodePhoto`: DCT compression for photographs, exact alpha. |
| `rapier-jxl/jpeg` | `transcode`: a JPEG carried as its coefficients, no decode. The JPEG file itself cannot be rebuilt; ICC bytes, Exif beyond orientation and XMP are not carried. |
| `rapier-jxl/jpeg-ans`, `rapier-jxl/photo-ans` | The same doors with `{effort: 2}` also trying ANS entropy coding, keeping the smaller stream. |
| `rapier-jxl/writer` | The layers beneath the doors, readable only. |
| `rapier-jxl/kernels` | Controls for the WebAssembly kernels. |

Each door is a readable module in `src/` (a bundler carries shared modules once) and, except `writer` and `kernels`,
a single minified file in `dist/` that can be copied on its own.

## Limits

One picture at a time, at most 16,384 pixels a side and a 16 MiB stream. Each door's `LIMITS` sets its pixels: 24 million
for the core and `effort`, 40 million for `photo`, 64 million for a JPEG that `jpeg` carries. Arguments are checked
before any work. A refusal is an `Error` whose `code` is `JXL_INPUT`, `JXL_DIMENSIONS`, `JXL_SIZE`, `JXL_MEMORY` or
`JXL_JPEG` (arithmetic coding, 12-bit, lossless, CMYK, a DNL height, a colour profile other than sRGB or Display P3,
or a JPEG cut short: decode it and encode the pixels instead).

Quality numbers are not the same fidelity across encoders or pictures, and lossy is not always smaller than lossless.

## Sizes

| file in `dist/` | bytes | gzip | Brotli | added to the core, gzip |
| --- | ---: | ---: | ---: | ---: |
| `rapier-jxl.min.mjs`, the core: `encode` | 21,326 | 9,271 | 8,228 | |
| `effort.min.mjs`: `encode` with effort | 43,792 | 17,571 | 15,488 | 8,300 |
| `wasm.min.mjs`: accelerated effort, JS fallback | 53,759 | 22,372 | 19,547 | 13,101 |
| `jpeg.min.mjs`: `transcode` | 32,354 | 13,505 | 11,916 | 8,525 |
| `photo.min.mjs`: `encodePhoto` | 33,011 | 13,616 | 12,037 | 6,249 |
| `jpeg-ans.min.mjs`: optional ANS carrier | 35,491 | 14,608 | 12,896 | 9,580 |
| `photo-ans.min.mjs`: optional ANS photo | 35,994 | 14,649 | 13,005 | 7,316 |
| every door in one bundle | 84,844 | 34,121 | 29,680 | |
| all readable modules in `src/` | 237,783 | 74,443 | | |

Exact bytes of release 2.3.0, with hashes and tools in `dist/sizes.json` (terser 5.51.2, Node v22.22.2; gzip 9,
Brotli 11). Each minified file stands alone and writes the same bytes as its readable source. The last column is what
a door adds to a bundle that already holds the core; `effort`'s `encode` is the core's at effort 1, so it takes the
core's place.

## Output

Bare codestreams, 8-bit, one frame, prefix codes (ANS in the optional doors). No preview, animation, XYB, chroma-from-luma
or filters; sRGB or Display P3 is declared. Lossless uses modular mode with a palette of up to 2,048 colours, reversible
YCoCg and a predictor and integer code chosen per channel by exact cost. Lossy uses Squeeze with exact alpha. Carried
JPEGs use VarDCT with the JPEG's own tables.

## Tests

`npm test` in a clone decodes every stream through [jxl-oxide](https://github.com/tirr-c/jxl-oxide) and, where
installed, libjxl, and checks exact pixels and alpha, fidelity, the accepted JPEG forms, refusal of malformed input and
the hashes of the written streams under Node and Bun. `npm run fuzz:scale` repeats the seeded fuzzing budget.
Contributions: [.github/CONTRIBUTING.md](.github/CONTRIBUTING.md). Agents adding the encoder to an app: [AGENTS.md](AGENTS.md).

## Licence

MIT, copyright rapier.website. The design follows ISO/IEC 18181 and libjxl's encoders, whose sources were read; none of
their code is here. The encoder is part of [Rapier](https://rapier.website).
