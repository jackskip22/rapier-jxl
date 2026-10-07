# API

All encoding calls are synchronous ES module functions. Inputs stay caller-owned and unmodified. Pixel input is a
`Uint8Array` or `Uint8ClampedArray` containing exactly `width * height * 4` straight RGBA bytes, row by row.
Encoded bytes are `Uint8Array` bare JPEG XL codestreams: save as `.jxl` or use MIME type `image/jxl`. The same pixels and
options write the same bytes in every JavaScript engine.

## Imports

| Import | Exports | Declaration |
| --- | --- | --- |
| `rapier-jxl`, `rapier-jxl/core` | `encode`, `encodeSteps`, `LIMITS` | [index.d.mts](../../src/index.d.mts) |
| `rapier-jxl/effort` | `encode`, `encodeSteps`, `LIMITS` | [effort.d.mts](../../src/effort.d.mts) |
| `rapier-jxl/wasm` | Effort API, `configureKernels`, `kernelMode` | [wasm.d.mts](../../src/wasm.d.mts) |
| `rapier-jxl/jpeg` | `transcode`, `transcodeSteps`, `LIMITS` | [jpeg.d.mts](../../src/jpeg.d.mts) |
| `rapier-jxl/photo` | `encodePhoto`, `encodePhotoSteps`, `LIMITS` | [photo.d.mts](../../src/photo.d.mts) |
| `rapier-jxl/jpeg-ans` | JPEG API with ANS search | [jpeg-ans.d.mts](../../src/jpeg-ans.d.mts) |
| `rapier-jxl/photo-ans` | Photo API with ANS search | [photo-ans.d.mts](../../src/photo-ans.d.mts) |
| `rapier-jxl/kernels` | `configureKernels`, `kernelMode` | [kernels.d.mts](../../src/kernels.d.mts) |
| `rapier-jxl/writer` | Frame, entropy, prediction and admission primitives | [writer.d.mts](../../src/writer.d.mts) |

Each named encoding import also has a `/min` entry containing one self-contained minified module with the same API.
`rapier-jxl/min` is the minified core. [Architecture and sizes](ARCHITECTURE.md).

## Pixel options

`encode(data, width, height, options?)` and `encodePhoto(data, width, height, options?)` return bytes.

| Option | Meaning |
| --- | --- |
| `quality` | Number from 1 to 100. Core and effort default to 100; photo defaults to 90. At 100 every RGBA byte is exact, including RGB under transparent alpha. At 1–99 alpha stays exact. |
| `colorSpace` | `'srgb'` (default) or `'display-p3'`. Declares the input samples' colour space; does not convert them. |
| `effort` | Integer from 1 to 9, default 1, in effort, wasm, photo and JPEG imports. Selects additional search; the core has no effort option. |
| `treeLearning` | `'sampled'`, in effort and wasm only. Selects sampled lossless trees; omit for the ordinary search. |

The core uses modular lossless or lossy coding. The photo import uses VarDCT below quality 100 and lossless modular
coding at 100. Quality numbers do not imply equal fidelity across encoders or images. The core and effort imports
may answer a lossy pixel request with an exact palette candidate when that candidate is smaller.

The effort and wasm imports at effort 1 write the core's bytes. Higher lossless efforts try predictors, palettes,
colour transforms and screen matching, retaining the smallest completed stream. Efforts 3 and above add [screen coding](../SCREENSHOTS.md);
5 and above deepen that search. Sampled mode shares image trees at efforts 2–3 and also tries per-group trees at
4–9. For non-palette lossy inputs the effort import uses the core's lossy path; palette inputs also price an exact
candidate at the requested effort.

Photo and JPEG efforts 3 and 4 try alternative entropy models and coefficient orders. Photo effort 5 also tries
per-block quantisation under its RGB reconstruction-error bound; this can change reconstructed RGB while alpha stays
exact. JPEG effort changes entropy coding while preserving the carried coefficients. The `-ans` imports also try
ANS at effort 2 and above, retaining a completed candidate only when smaller.

## Existing JPEGs

```js
import {transcode} from 'rapier-jxl/jpeg';
const {bytes, width, height, orientation} = transcode(jpegBytes, {effort: 4});
```

`jpegBytes` is a non-empty `Uint8Array`. Baseline, extended sequential and progressive 8-bit grayscale, YCbCr and RGB
JPEGs are accepted, including restart markers. Coefficients, quantisation tables, subsampling, orientation and an
admitted sRGB or Display P3 declaration are carried. `width` and `height` are displayed dimensions, swapped for a
quarter-turn orientation; `orientation` is the Exif value 1–8 retained in the JPEG XL header.

JPEG reconstruction data, ICC bytes, Exif beyond orientation and XMP are not stored. The original JPEG file cannot be
rebuilt from this result. Arithmetic-coded, 12-bit, lossless, CMYK, DNL-height, unsupported-profile and malformed JPEGs
are refused with `JXL_JPEG`. Decode those with a JPEG decoder and pass the resulting pixels to a pixel import.

## Progress and cancellation

`encodeSteps`, `encodePhotoSteps` and `transcodeSteps` take the same arguments as their complete-call counterparts.
They return generators yielding progress in `(0, 1]`. Finish iteration before reading `job.bytes`; a yielded `1`
does not itself complete the generator. `transcodeSteps` also sets displayed dimensions and orientation as it reads
the JPEG.

Leaving a `for…of` loop cancels the job. Set `job.hurry = true` and continue iterating to finish with a completed
candidate. For sampled lossless search, any observed hurry returns effort 1 exactly. The input must remain available
and unchanged until the job completes or is cancelled.

Iteration remains synchronous. Use a worker for work that must not block the page, or yield the event loop between
steps. A worker can be terminated to cancel immediately. Keep a copy before transferring an input buffer if it must
remain usable by the sender. [Worker example](../../examples/worker.mjs).

## Limits and errors

Every encoding import exports `LIMITS` with `bytes`, `pixels` and `edge`. The stream limit is 16 MiB and each dimension
is at most 16,384 pixels. Core, effort and wasm accept 24 million pixels; photo accepts 40 million; JPEG accepts
64 million and an input JPEG of at most 16 MiB. The corresponding ANS import has the same limits.

Checked encoding entries refuse with `Error` objects carrying a stable `code`. Branch on `code`; messages are diagnostic text.
Raw writer primitives require their documented preconditions; their errors are not limited to this vocabulary.

| Code | Meaning |
| --- | --- |
| `JXL_INPUT` | Invalid input type, buffer length, dimensions or option value. |
| `JXL_DIMENSIONS` | Valid positive dimensions exceed the import's edge or pixel limit. |
| `JXL_SIZE` | Input JPEG or encoded stream exceeds its byte limit. |
| `JXL_MEMORY` | Allocation failed while encoding. |
| `JXL_JPEG` | Malformed JPEG or JPEG form the coefficient carrier cannot represent. |

Kernel configuration uses the same `JXL_INPUT` code for an invalid mode. Missing or blocked WebAssembly selects
JavaScript. [Kernel controls](../KERNELS.md).
