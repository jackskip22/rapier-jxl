# API

All encoding calls are synchronous ES module functions. Inputs stay caller-owned and unmodified. Pixel input is a
`Uint8Array`, `Uint8ClampedArray`, `Uint16Array` or `Float32Array` containing exactly `width * height * 4` RGBA samples,
row by row. Alpha is straight unless `alphaPremultiplied: true` describes the source.
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
| `rapier-jxl/source` | Async `readSource` for PNG16 and supported OpenEXR files | [source.d.mts](../../src/source.d.mts) |

Each named encoding import also has a `/min` entry containing one self-contained minified module with the same API.
`rapier-jxl/min` is the minified core. [Architecture and sizes](ARCHITECTURE.md).

## Pixel options

`encode(data, width, height, options?)` and `encodePhoto(data, width, height, options?)` return bytes.

| Option | Meaning |
| --- | --- |
| `quality` | Number from 1 to 100. Core and effort default to 100; photo defaults to 90. At 100 every source sample is exact, including RGB under transparent alpha. At 1–99 alpha stays exact. A smaller exact stream can satisfy a lossy request. |
| `colorSpace` | `'srgb'` (default), `'display-p3'` or `'rec2020'`. Declares D65 input primaries; does not convert samples. |
| `bitDepth` | Bytes use 8. Integer `Uint16Array` uses 10, 12 or 16, default 16. A value above the declared maximum is refused. Floating depth is fixed at 16 or 32 by its sample format. |
| `sampleFormat` | `'uint'` for integer arrays (inferred); `'float16'` for raw IEEE binary16 words in `Uint16Array`; `'float32'` for `Float32Array` (inferred). |
| `transferFunction` | `'srgb'`, `'linear'`, `'pq'` or `'hlg'`. Defaults to sRGB for integers and linear for floats. The declaration describes existing values. |
| `intensityTarget` | Positive peak luminance in nits, represented in the header as binary16. Defaults to 10000 for PQ, 1000 for HLG, otherwise 255. Accepted from the smallest positive binary16 value up to, but excluding, 65520; other values are refused. |
| `alphaPremultiplied` | Boolean, default false. True carries associated RGB and alpha without division, including nonzero RGB below zero alpha. |
| `effort` | Integer from 1 to 9, default 1, in effort, wasm, photo and JPEG imports. Selects additional search; the core has no effort option. |
| `treeLearning` | `'sampled'`, in effort and wasm only. Selects sampled lossless trees; omit for the ordinary search. |

The core uses modular lossless or lossy coding. For ordinary 8-bit sRGB-transfer inputs the photo import uses VarDCT
below quality 100 and lossless modular coding at 100. Native precision and other colour/alpha declarations use the
shared modular source path through every pixel import. Quality numbers do not imply equal fidelity across encoders or images. The core and effort imports
may answer a lossy pixel request with an exact palette candidate when that candidate is smaller.

The effort and wasm imports at effort 1 write the core's bytes. Higher ordinary 8-bit lossless efforts try predictors, palettes,
colour transforms and screen matching, retaining the smallest completed stream. Efforts 3 and above add [screen coding](../SCREENSHOTS.md);
5 and above deepen that search. Sampled mode shares image trees at efforts 2–3 and also tries per-group trees at
4–9. For non-palette lossy inputs the effort import uses the core's lossy path; palette inputs also price an exact
candidate at the requested effort.

Photo and JPEG efforts 3 and 4 try alternative entropy models and coefficient orders. Photo effort 5 also tries
per-block quantisation under its RGB reconstruction-error bound; this can change reconstructed RGB while alpha stays
exact. JPEG effort changes entropy coding while preserving the carried coefficients. The `-ans` imports also try
ANS at effort 2 and above, retaining a completed candidate only when smaller.

## Native precision

Integer samples are right-justified code values: a 10-bit white sample is 1023, not 65535. All four components share
the array's format and declared depth. Float inputs retain negative values, signed zero, subnormals and values above
one. Binary16 input contains IEEE words, not numeric integers to convert into half floats. Float64 and packed
RGB10A2 inputs require explicit conversion to an admitted layout before encoding.

```js
import {encode} from 'rapier-jxl';

const pq = encode(new Uint16Array([0, 1023, 512, 1023]), 1, 1, {
  bitDepth: 10, colorSpace: 'rec2020', transferFunction: 'pq', intensityTarget: 10000,
});
const linear = encode(new Float32Array([-0.125, 0.5, 7, 1]), 1, 1, {
  colorSpace: 'rec2020', transferFunction: 'linear',
});
```

Native lossless coding prices palette and direct representations, with gradient, average, left, top and zero
prediction selected from spatial samples. Integer colour uses reversible YCoCg; efforts 2–9 also price untransformed
RGB. Floating-point words use reversible integer prediction without a colour transform. Float efforts have no
additional lossless search. `treeLearning` selects an ordinary 8-bit search and does not change the native path.

Below quality 100, a native request tries exact representations first, then prices quantised RGB. The smallest
complete stream wins, and completed candidates survive a later size or allocation failure. If an exact candidate
cannot fit, a complete quantised candidate may still satisfy the request. Quantisation precedes reversible coding
and never changes alpha. Integer RGB rounds to a
power-of-two step and clips only the rounded result to the original integer range. Floating RGB rounds low mantissa
bits to nearest, ties to even; it preserves the sign of zero and leaves nonfinite values unchanged. A rounding that
would turn a finite maximum into infinity retains the original value.

Let `d = floor((100 - quality) * p / 100)`. For integers, `p = bitDepth - 1` and the maximum absolute RGB error is
`2^d / 2` source code units; with `d = 0` the result is exact. For floats, `p` is 10 for binary16 and 23 for binary32.
The absolute error is at most `max(abs(source), minimumNormal) * 2^(d - p - 1)`, with minimum normal values
`2^-14` and `2^-126` respectively. A retained exact candidate has zero error. These are source-domain bounds;
they do not predict display-space or perceptual error after PQ, HLG, compositing or tone mapping.

The bit depth, exponent width, primaries, transfer function, intensity target and alpha association are read back
independently in the conformance tests. Finite source samples, including signed zero and subnormals, return exactly
through native libjxl 0.12.0. Unmodified jxl-rs 0.7.4 also returns every finite binary16 value exactly when F32 output
is requested. Its F16 output conversion halves subnormals and fails the strict F16 test until the explicitly named
F16-output diagnostic repair is applied. The full public suite uses four documented decoder repairs, including
three retained ordinary-image defects. [Decoder pins, output formats and repairs](DECODERS.md) identify
the unmodified release and diagnostic builds separately; no browser binary is inferred from them. Floating output
APIs can quiet signaling NaNs or canonicalise NaN payloads; the encoder's lossless modular input retains the supplied
IEEE words. Arbitrary NaN payload round trips through every decoder output format are not claimed.

### Reading PNG16 and OpenEXR

```js
import {readSource} from 'rapier-jxl/source';
import {encode} from 'rapier-jxl';

const {data, width, height, ...source} = await readSource(fileBytes);
const bytes = encode(data, width, height, {...source, quality: 100});
```

`readSource` accepts `Uint8Array` or `ArrayBuffer`, copies the file before asynchronous work, and returns typed RGBA
samples plus encoding options. Decompression uses the platform's `DecompressionStream`; Node 22 is supported.
It shares the core's dimension limits and refuses malformed or unrepresentable input without returning partial pixels.

| Format | Accepted source forms | Colour and alpha |
| --- | --- | --- |
| PNG16 | Grayscale, grayscale+alpha, RGB or RGBA; every row filter; noninterlaced or Adam7; `tRNS` transparency | Full-range RGB cICP for supported primaries/transfers; sRGB; linear gAMA with supported cHRM. Straight alpha. Untagged files assume sRGB. |
| OpenEXR | Single-part flat scanlines; uniform HALF or FLOAT RGB or Y, optional A; NONE/RLE/ZIPS/ZIP; square pixels and coincident data/display windows | Supported D65 chromaticities, linear transfer, associated alpha; `whiteLuminance` carries the intensity target. Absent chromaticities assume linear sRGB primaries. |

PNG cICP takes precedence over other colour chunks according to the [PNG specification](https://www.w3.org/TR/png-3/#color-chunk-precedence).
An embedded ICC profile without a supported higher-priority cICP declaration, an unsupported gamma/primary, animation,
deep or tiled OpenEXR, mixed channel precision, layers, subsampling or a different display extent requires another
source reader. OpenEXR association follows its [channel convention](https://openexr.com/en/latest/TechnicalIntroduction.html#image-channels-and-sampling-rates).
The reader carries the listed sample and colour information, not an archival copy of every file attribute. Exif,
text, camera metadata and PNG mastering-display/content-light chunks are not copied into the bare codestream.
The original source file cannot be reconstructed from the result.

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
