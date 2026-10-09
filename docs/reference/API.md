# API

```js
import {encode} from 'rapier-jxl/effort';
const bytes = encode(rgba, width, height, {quality: 100, effort: 6});
```

Use `rapier-jxl` for the core, `/effort` for compression search, `/wasm` for the same search with optional kernels,
`/jpeg` for existing JPEG coefficients, and `/photo` for lossy photographic pixels. `/metadata` attaches Exif/XMP
after encoding. Encoding and metadata entry points provide self-contained `/min` builds.
[Offline HTML embedding](ARCHITECTURE.md#one-html-file).

Agent skills: [Single-file apps](../../skills/rapier-jxl-single-file-app/SKILL.md) · [Photography](../../skills/rapier-jxl-photography/SKILL.md).

Encoding functions run synchronously and do not modify input arrays. Pixel input is a
`Uint8Array`, `Uint8ClampedArray`, `Uint16Array`, or `Float32Array` containing exactly `width * height * 4` RGBA samples,
row by row. Alpha is straight unless `alphaPremultiplied: true` describes the source.
The output is a `Uint8Array` of JPEG XL file bytes: save as `.jxl` or use MIME type `image/jxl`. Integer inputs up to
12 bits use a bare codestream. The 16-bit integer and floating-point formats use a JPEG XL container with a level 10
declaration. The same pixels and options produce the same bytes in every JavaScript engine.

## Entry points

| Entry point | Exports | Declaration |
| --- | --- | --- |
| `rapier-jxl`, `rapier-jxl/core` | `encode`, `encodeSteps`, `LIMITS` | [index.d.mts](../../src/index.d.mts) |
| `rapier-jxl/effort` | `encode`, `encodeSteps`, `LIMITS` | [effort.d.mts](../../src/effort.d.mts) |
| `rapier-jxl/wasm` | Effort API, `configureKernels`, `kernelMode` | [wasm.d.mts](../../src/wasm.d.mts) |
| `rapier-jxl/jpeg` | `transcode`, `transcodeSteps`, `LIMITS` | [jpeg.d.mts](../../src/jpeg.d.mts) |
| `rapier-jxl/photo` | `encodePhoto`, `encodePhotoSteps`, `LIMITS` | [photo.d.mts](../../src/photo.d.mts) |
| `rapier-jxl/jpeg-ans` | JPEG API with ANS search | [jpeg-ans.d.mts](../../src/jpeg-ans.d.mts) |
| `rapier-jxl/photo-ans` | Photo API with ANS search | [photo-ans.d.mts](../../src/photo-ans.d.mts) |
| `rapier-jxl/kernels` | `configureKernels`, `kernelMode` | [kernels.d.mts](../../src/kernels.d.mts) |
| `rapier-jxl/writer` | Frame, entropy, prediction, and admission primitives | [writer.d.mts](../../src/writer.d.mts) |
| `rapier-jxl/source` | Async `readSource` for PNG16 and supported OpenEXR files | [source.d.mts](../../src/source.d.mts) |
| `rapier-jxl/metadata` | `withMetadata` for Exif/XMP container boxes | [metadata.d.mts](../../src/metadata.d.mts) |

`rapier-jxl/min` and `rapier-jxl/core/min` both select the minified core. The source reader, kernel controls, and writer
have no `/min` entry. Encoding needs no decoder; rendering JPEG XL requires a separate decoder or native support.

## Pixel options

`encode(data, width, height, options?)` and `encodePhoto(data, width, height, options?)` return bytes.

| Option | Meaning |
| --- | --- |
| `quality` | Number from 1 to 100. Core and effort default to 100; photo defaults to 90. At 100 every source sample is exact, including RGB under transparent alpha. At 1–99 alpha stays exact. The encoder can return a smaller exact stream for a lossy request. |
| `colorSpace` | `'srgb'` (default), `'display-p3'`, or `'rec2020'`. Declares D65 input primaries; does not convert samples. |
| `bitDepth` | Bytes use 8. Integer `Uint16Array` uses 10, 12, or 16, default 16. The encoder rejects a value above the declared maximum. Floating depth is fixed at 16 or 32 by its sample format. |
| `sampleFormat` | `'uint'` for integer arrays (inferred); `'float16'` for raw IEEE binary16 words in `Uint16Array`; `'float32'` for `Float32Array` (inferred). |
| `transferFunction` | `'srgb'`, `'linear'`, `'pq'`, or `'hlg'`. Defaults to sRGB for integers and linear for floats. The declaration describes existing values. |
| `intensityTarget` | Positive peak luminance in nits, represented in the header as binary16. Defaults to 10000 for PQ, 1000 for HLG, otherwise 255. Accepted from the smallest positive binary16 value up to, but excluding, 65520; other values are refused. |
| `alphaPremultiplied` | Boolean, default false. True carries associated RGB and alpha without division, including nonzero RGB below zero alpha. |
| `effort` | Integer from 1 to 9, default 1, in effort, wasm, photo, and JPEG entry points. Selects additional search; the core has no effort option. |
| `treeLearning` | `'sampled'`, in effort and wasm only. Selects a separate reduced lossless search. Normally omit to include all candidates. |

The core uses modular lossless or lossy coding. For ordinary 8-bit sRGB-transfer inputs the photo entry point uses VarDCT
below quality 100 and lossless modular coding at 100. Native precision and other color/alpha declarations use the
shared modular source path through every pixel entry point. Quality numbers do not imply equal fidelity across encoders or images. The core and effort entry points
may answer a lossy pixel request with an exact palette candidate when that candidate is smaller.

### Lossless effort

Effort and wasm default to 1 and write the core's bytes at that level. Ordinary 8-bit lossless search adds these
candidates. Levels 1 to 4 accumulate; from level 5 each level's learned group model replaces the level below's while
the fixed candidates stay, so a level can be a few tenths of a percent larger than the level below on some pictures.
Only a strictly smaller complete stream replaces the retained result, so equal lengths keep the earlier candidate.

| Effort | Additional search | Use |
| ---: | --- | --- |
| 1 | Core encoding: gradient or average prediction per channel, prefix codes, zero runs. | Live previews and working copies. |
| 2 | Weighted prediction. | |
| 3 | Weighted error contexts, screen palettes, residual runs, and repeated glyphs. | Screenshots, drawings and documents: their large wins arrive here. |
| 4 | Reversible color-transform search and local palette models. | |
| 5 | A learned model per group of up to 1,024 × 1,024 pixels: gradient, average, or weighted prediction and neighbor, weighted-error and previous-channel contexts from 65,536 samples, up to 64 leaves per channel (63 for RGBA), with prefix/ANS selection and histogram sharing. Broader screen matching. | Balanced: most of the final size in about a fifth of effort 9's time. |
| 6 | The learned model under the reversible color transform that sampled gradient residuals rank first (YCoCg for grey pictures). | |
| 7 | Eight predictors with spatial, signed neighbor and previous-channel properties, learned in the hybrid token split the stream is written in. | Within a few tenths of a percent of effort 9 at about half its time. |
| 8 | All 14 predictors. | |
| 9 | The effort-8 model under the second-ranked transform as a second candidate, for pictures the ranking misjudges. | Kept pictures where every byte counts. |

Higher effort spends more time searching for smaller lossless files. There is no automatic deadline.
Set `job.hurry` to finish with a completed result. [Screen coding](../SCREENSHOTS.md).

The explicit `treeLearning: 'sampled'` option selects a reduced search: shared image trees at efforts 2–3, plus
per-group trees at 4–9. It does not include the ordinary predictor, screen, and mixed-predictor candidate ladder.
Any observed hurry in this mode returns effort 1 exactly.

For non-palette lossy inputs the effort entry point uses the core's lossy path; palette inputs also price an exact
candidate at the requested effort. Native precision uses the search described below.

Photo and JPEG efforts 3 and 4 try alternative entropy models and coefficient orders. Photo effort 5 and above
also tries ANS. These searches preserve coefficients and decoded samples. The `-ans` imports try ANS from effort 2.
Only a strictly smaller completed stream replaces the retained result. Alpha stays exact at every quality.

## Native precision

Integer samples are right-justified code values: a 10-bit white sample is 1023, not 65535. All four components share
the array's format and declared depth. Float inputs retain negative values, signed zero, subnormals, and values above
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

Native lossless coding prices palette and direct representations, with gradient, average, left, top, and zero
prediction selected from spatial samples. Integer color uses reversible YCoCg; efforts 2–9 also price untransformed
RGB. Floating-point words use reversible integer prediction without a color transform. Float efforts have no
additional lossless search. `treeLearning` selects an ordinary 8-bit search and does not change the native path.

Below quality 100, a native request tries exact representations first, then prices quantized RGB. The smallest
complete stream wins, and completed candidates survive a later size or allocation failure. If an exact candidate
cannot fit, a complete quantized candidate may still satisfy the request. Quantization precedes reversible coding
and never changes alpha. The encoder maps integer RGB values to the midpoints of bins of width `2^d`,
within the original integer range. Floating RGB rounds low mantissa
bits to nearest, ties to even; it preserves the sign of zero and leaves nonfinite values unchanged. A rounding that
would turn a finite maximum into infinity retains the original value.

Let `d = floor((100 - quality) * p / 100)`. For integers, `p = bitDepth - 1` and the maximum absolute RGB error is
`2^d / 2` source code units; with `d = 0` the result is exact. For floats, `p` is 10 for binary16 and 23 for binary32.
The absolute error is at most `max(abs(source), minimumNormal) * 2^(d - p - 1)`, with minimum normal values
`2^-14` and `2^-126` respectively. A retained exact candidate has zero error. These are source-domain bounds;
they do not predict display-space or perceptual error after PQ, HLG, compositing, or tone mapping.

Conformance tests independently read back bit depth, exponent width, primaries, transfer function, intensity target,
and alpha association. Finite source samples, including signed zero and subnormals, return exactly
through native libjxl 0.12.0. Unmodified jxl-rs 0.7.4 also returns every finite binary16 value exactly when F32 output
is requested. Its F16 output conversion halves subnormals and fails the strict F16 test until the explicitly named
F16-output diagnostic repair is applied. The full public suite uses four documented decoder repairs, including
three retained ordinary-image defects. [Decoder pins, output formats, and repairs](DECODERS.md) identify
the unmodified release and diagnostic builds separately; no browser binary is inferred from them. Floating output
APIs can quiet signaling NaNs or canonicalize NaN payloads; the encoder's lossless modular input retains the supplied
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

| Format | Accepted source forms | Color and alpha |
| --- | --- | --- |
| PNG16 | Grayscale, grayscale+alpha, RGB, or RGBA; every row filter; noninterlaced or Adam7; `tRNS` transparency | Full-range RGB cICP for supported primaries/transfers; sRGB; linear gAMA with supported cHRM. Straight alpha. Untagged files assume sRGB. |
| OpenEXR | Single-part flat scanlines; uniform HALF or FLOAT RGB or Y, optional A; NONE/RLE/ZIPS/ZIP; square pixels and coincident data/display windows | Supported D65 chromaticities, linear transfer, associated alpha; `whiteLuminance` carries the intensity target. Absent chromaticities assume linear sRGB primaries. |

PNG cICP takes precedence over other color chunks according to the [PNG specification](https://www.w3.org/TR/png-3/#color-chunk-precedence).
An embedded ICC profile without a supported higher-priority cICP declaration, an unsupported gamma/primary, animation,
deep or tiled OpenEXR, mixed channel precision, layers, subsampling, or a different display extent requires another
source reader. OpenEXR association follows its [channel convention](https://openexr.com/en/latest/TechnicalIntroduction.html#image-channels-and-sampling-rates).
The reader carries the listed sample and color information, not an archival copy of every file attribute. Exif,
text, camera metadata, and PNG mastering-display/content-light chunks are not copied into the JPEG XL output.
The original source file cannot be reconstructed from the result. Attach separately obtained Exif/XMP with
[`withMetadata`](#exif-and-xmp).

## Existing JPEGs

```js
import {transcode} from 'rapier-jxl/jpeg';
const {bytes, width, height, orientation} = transcode(jpegBytes, {effort: 4});
```

`jpegBytes` is a non-empty `Uint8Array`. Baseline, extended sequential, and progressive 8-bit grayscale, YCbCr, and RGB
JPEGs are accepted, including restart markers. Coefficients, quantization tables, subsampling, orientation, and an
admitted sRGB or Display P3 declaration are carried. `width` and `height` are displayed dimensions, swapped for a
quarter-turn orientation; `orientation` is the Exif value 1–8 retained in the JPEG XL header.

`transcode` does not store JPEG reconstruction data, ICC bytes, Exif beyond orientation or XMP. The original JPEG file
cannot be rebuilt from this result. Attach separately obtained Exif/XMP with [`withMetadata`](#exif-and-xmp).
Arithmetic-coded, 12-bit, lossless, CMYK, DNL-height, unsupported-profile and malformed JPEGs are refused with
`JXL_JPEG`. Decode those with a JPEG decoder and pass the resulting pixels to a pixel entry point.

## Exif and XMP

```js
import {withMetadata} from 'rapier-jxl/metadata';

const file = withMetadata(bytes, {exif: tiffBytes, xmp: xmpPacket});
const withoutXmp = withMetadata(file, {xmp: null});
```

`withMetadata(bytes, options?)` accepts JPEG XL bytes in a `Uint8Array` and returns a new `Uint8Array`. It leaves all
input arrays unchanged. Use `rapier-jxl/metadata/min` for the self-contained module.

| Option | Meaning |
| --- | --- |
| `exif` | Raw TIFF `Uint8Array`, beginning with `II` or `MM`. Omit the `Exif\0\0` prefix and JPEG APP1 header. |
| `xmp` | XMP packet as a string, encoded as UTF-8, or its original UTF-8 `Uint8Array`. |

Omit a field, or pass `undefined`, to retain its existing metadata. Supply a value to replace it, or `null` to remove
it. New metadata uses standard uncompressed `Exif` and `xml ` boxes. Matching existing boxes, including compressed
metadata boxes, are replaced or removed; other boxes and the image codestream retain their bytes. Adding metadata
to a bare codestream wraps it in a JPEG XL container. Total output, including metadata, is limited to 16 MiB.

Pixels, color encoding and orientation stay unchanged. Keep Exif orientation consistent with the encoded image.
This module does not extract metadata from source files, import ICC profiles or convert color. It checks container
framing and the TIFF signature without decoding the image or parsing the Exif/XMP contents.

Requested edits, including removal, throw `JXL_INPUT` for a container with JPEG reconstruction data (`jbrd`),
because changing metadata can invalidate reconstruction. Omitting both fields returns a copy.

## Progress and cancellation

`encodeSteps`, `encodePhotoSteps` and `transcodeSteps` take the same arguments as their complete-call counterparts.
They return generators yielding progress in `(0, 1]`. Finish iteration before reading `job.bytes`; a yielded `1`
does not itself complete the generator. `transcodeSteps` also sets displayed dimensions and orientation as it reads
the JPEG.

Leaving a `for…of` loop cancels the job. Set `job.hurry = true` and continue iterating to finish with a completed
candidate. For explicit `treeLearning: 'sampled'` search, any observed hurry returns effort 1 exactly. The input must remain available
and unchanged until the job completes or is canceled.

Iteration remains synchronous. Use a worker for work that must not block the page, or yield the event loop between
steps. A worker can be terminated to cancel immediately. Keep a copy before transferring an input buffer if it must
remain usable by the sender. [Worker example](../../examples/worker.mjs).

## Limits and errors

Every encoding entry point exports `LIMITS` with `bytes`, `pixels` and `edge`. The output limit is 16 MiB and each dimension
is at most 16,384 pixels. Core, effort and wasm accept 24 million pixels; photo accepts 40 million; JPEG accepts
64 million and an input JPEG of at most 16 MiB. The corresponding ANS entry point has the same limits.

Checked encoding entry points throw `Error` objects with a stable `code`. Branch on `code`; messages are diagnostic text.
Raw writer primitives require their documented preconditions; their errors are not limited to this vocabulary.

| Code | Meaning |
| --- | --- |
| `JXL_INPUT` | Invalid input type, buffer length, dimensions or option value; malformed metadata container or a rejected reconstruction-data edit. |
| `JXL_DIMENSIONS` | Valid positive dimensions exceed the import's edge or pixel limit. |
| `JXL_SIZE` | Input JPEG or output, including attached metadata, exceeds its byte limit. |
| `JXL_MEMORY` | Allocation failed. |
| `JXL_JPEG` | Malformed JPEG or JPEG form the coefficient carrier cannot represent. |

Kernel configuration uses the same `JXL_INPUT` code for an invalid mode. Missing or blocked WebAssembly selects
JavaScript. [Kernel controls](../KERNELS.md).

## Complete Rapier system

`rapier-jxl/rapier` and `/rapier/min` expose the complete encoder used by Rapier. The self-starting classic worker is
`rapier-jxl/rapier/worker` (`dist/rapier-worker.js`). It includes effort search, optional WASM with JavaScript fallback,
photographic pixel encoding, JPEG coefficient transcoding and parallel lossless groups. There is no decoder.

In a worker or Node:

```js
import {createEncoder} from 'rapier-jxl/rapier/min';
const encoder = createEncoder();
const bytes = await encoder.encode({data: rgba, width, height}, {lossless: true, effort: 9});
const carried = await encoder.transcode({bytes: jpegBytes});
```

`encode(image, options)` accepts the typed RGBA formats and color declarations above. Defaults are quality 90 and
effort 9. `lossless: true` forces quality 100. `photo: true` selects photographic coding for non-palette RGBA8 below
quality 100; other inputs use the ordinary pixel encoder. The complete entry admits 24 million pixels,
16,384 pixels per edge and 16 MiB output. JPEG input admits 16 MiB and 64 million pixels; transcoding uses effort 9,
preserves admitted coefficients and orientation, and does not preserve the original JPEG file.

The standard worker accepts one operation at a time:

- `{id, operation: 'encode', data, width, height, options?, progress?}` returns `{id, ok: true, bytes}`. With `progress: true` the worker first sends `{id, progress}` replies, each a number above the last up to 1, at most about every hundredth and every 100 ms.
- `{id, operation: 'transcode', bytes}` returns `{id, ok: true, bytes, width, height, orientation}`.
- A failure returns `{id, ok: false, error: {code, message, stage?, detail?}}`. A concurrent request returns `JXL_BUSY`.

Use a string or number `id` whose string representation is at most 128 characters. Output buffers transfer to the
caller. Passing an input buffer in `postMessage`'s transfer list detaches it from the sender. Terminate the worker to
cancel the whole operation. The complete entry runs off the browser document thread; call it from a worker.

`installWorker()` installs this protocol in a worker that imports the module. For a module-worker bootstrap, pass
`{spawn: () => new Worker(import.meta.url, {type: 'module'})}` so helpers run the same bootstrap and build. The
published classic worker needs no configuration. It uses up to four helpers, subject to hardware concurrency, for
lossless images with at least 40 initial 256-pixel groups. Failed helpers fall back to the same local encoding.
`kernelMode()` reports the selected kernel mode after the first encode. Input arrays passed to `encode` remain unchanged.
