# API

```js
import {encode} from 'rapier-jxl/effort';
const bytes = encode(rgba, width, height, {quality: 100, effort: 6});
```

Use `rapier-jxl` for the core, `/effort` for compression search, `/wasm` for the same search with optional kernels,
`/jpeg` for existing JPEG coefficients, and `/photo` for lossy photographic pixels. `/photo-advanced` adds explicit
transform, progression and texture controls; `/channels` and `/layers` retain authored image structure.
`/metadata` attaches or compresses Exif/XMP/JUMBF. Optional entry points keep specialized code separate.
Encoding and metadata entry points provide self-contained `/min` builds.
[Offline HTML embedding](ARCHITECTURE.md#one-html-file).

Agent skills: [Single-file apps](../../skills/rapier-jxl-single-file-app/SKILL.md) · [Photography](../../skills/rapier-jxl-photography/SKILL.md).

Encoding functions run synchronously and do not modify input arrays. Pixel input is a
`Uint8Array`, `Uint8ClampedArray`, `Uint16Array`, or `Float32Array` containing exactly `width * height * 4` RGBA samples,
row by row. Alpha is straight unless `alphaPremultiplied: true` describes the source.
The output is a `Uint8Array` of JPEG XL file bytes: save as `.jxl` or use MIME type `image/jxl`. Integer inputs up to
12 bits use a bare codestream. The 16-bit integer and floating-point formats use a JPEG XL container with a level 10
declaration. The same pixels and options produce the same bytes in every JavaScript engine.

## Version 5

Two workers: `rapier-jxl/rapier/still-worker` supports still pictures and the `photo`, `profile`, `readSource`,
`encodeSource` and `opsin` format actions. `rapier-jxl/rapier/worker` also supports animation and every other format
action documented below. The still worker answers `JXL_UNAVAILABLE` to animation, complete-only format actions
and advanced photo options. Lossy pixels use photographic coding unless you pass `photo: false` or a preset that
says otherwise. JPEG transcoding returns reconstruction containers, metadata edits to them are refused, and a
reconstruction response may carry `bytes: null`.

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
| `rapier-jxl/image` | `toJXL`, one call from a page to an `image/jxl` Blob | [image.d.mts](../../src/image.d.mts) |
| `rapier-jxl/metadata` | `withMetadata` for Exif/XMP container boxes | [metadata.d.mts](../../src/metadata.d.mts) |
| `rapier-jxl/animation` | `encodeAnimation`, `encodeAnimationSteps`, `LIMITS` | [animation.d.mts](../../src/animation.d.mts) |
| `rapier-jxl/animation-atlas` | `buildAnimationAtlas`, `encodeAnimationAtlas`, `encodeAnimationAtlasSteps` | [animation-atlas.d.mts](../../src/animation-atlas.d.mts) |
| `rapier-jxl/icc` | `encodeProfile`, `encodeProfileSteps`, `prepareICC`, `LIMITS` | [icc.d.mts](../../src/icc.d.mts) |
| `rapier-jxl/photo-advanced` | Photo API, `TRANSFORMS`, `photonNoise` | [photo-advanced.d.mts](../../src/photo-advanced.d.mts) |
| `rapier-jxl/delta-palette` | `encodeDeltaPalette`, `encodeDeltaPaletteSteps` | [delta-palette.d.mts](../../src/delta-palette.d.mts) |
| `rapier-jxl/graphics` | `encodeGraphics`, `encodeGraphicsSteps`, `LIMITS` | [graphics.d.mts](../../src/graphics.d.mts) |
| `rapier-jxl/channels` | `encodeChannels`, `encodeChannelsSteps`, `EXTRA_CHANNEL_TYPES`, `LIMITS` | [channels.d.mts](../../src/channels.d.mts) |
| `rapier-jxl/layers` | `encodeLayers`, `encodeLayersSteps`, `LAYER_BLEND_MODES`, `LIMITS` | [layers.d.mts](../../src/layers.d.mts) |
| `rapier-jxl/splines` | `encodeSplines`, `encodeSplinesSteps`, `splineStroke` | [splines.d.mts](../../src/splines.d.mts) |
| `rapier-jxl/patches` | `encodePatches`, `encodePatchesSteps`, `encodePatchComposition`, `encodePatchCompositionSteps`, `PATCH_BLEND_MODES` | [patches.d.mts](../../src/patches.d.mts) |
| `rapier-jxl/container` | `withContainer`, `containerChunks`, `streamContainer` | [container-stream.d.mts](../../src/container-stream.d.mts) |
| `rapier-jxl/container-advanced` | Reframing, box inspection, frame indexes and supplied gain maps | [container-advanced.d.mts](../../src/container-advanced.d.mts) |
| `rapier-jxl/progressive-container` | Pass-aligned plans, chunks, collected output and async metadata delivery | [progressive-container.d.mts](../../src/progressive-container.d.mts) |
| `rapier-jxl/opsin` | `DEFAULT_OPSIN`, `prepareOpsinTransform`, `withOpsin` | [opsin.d.mts](../../src/opsin.d.mts) |
| `rapier-jxl/hybrid` | `encodeHybrid`, `encodeHybridSteps`, `hybridRegions`, `LIMITS` | [hybrid.d.mts](../../src/hybrid.d.mts) |
| `rapier-jxl/photo-plan` | `createPhotoPlan`, `createPhotoPlanSteps`, `LIMITS` | [photo-plan.d.mts](../../src/photo-plan.d.mts) |
| `rapier-jxl/delivery` | `deliveryLayout`, `withDeliveryOrder`, `normalizeDelivery` | [delivery.d.mts](../../src/delivery.d.mts) |
| `rapier-jxl/brotli` | `compressBrotli`, `decompressBrotli` | [brotli.d.mts](../../src/brotli.d.mts) |
| `rapier-jxl/noise` | Grain-aware `encodePhoto`, `encodePhotoSteps`, `photonNoise`, `LIMITS` | [photo-noise.d.mts](../../src/photo-noise.d.mts) |

`rapier-jxl/min` and `rapier-jxl/core/min` both select the minified core. The source reader, kernel controls, and writer
have no `/min` entry. Encoding needs no decoder; rendering JPEG XL requires a separate decoder or native support.

## Pixel options

`encode(data, width, height, options?)` and `encodePhoto(data, width, height, options?)` return bytes.

| Option | Meaning |
| --- | --- |
| `quality` | Number from 1 to 100. Core and effort default to 100; photo defaults to 90. At 100 every source sample is exact, including RGB under transparent alpha. At 1–99 alpha stays exact. The encoder can return a smaller exact stream for a lossy request. |
| `photo` | Boolean in core, effort and wasm; default `true`. Ordinary non-palette straight RGBA8 below quality 100 uses photographic coding. Set `false` for Modular lossy coding. Palette, native-precision, ICC and quality-100 inputs retain their existing paths. The explicit photo entry always uses its own coding path. |
| `filter` | `'auto'` (default) or `'off'`. Auto applies one edge-preserving pass to sRGB XYB photographs at quality 90 or below. Off keeps the unfiltered reconstruction. Alpha stays exact; other coding paths do not use this filter. |
| `colorSpace` | `'srgb'` (default), `'display-p3'`, or `'rec2020'`. Declares D65 input primaries; does not convert samples. |
| `bitDepth` | Bytes use 8. Integer `Uint16Array` uses 10, 12, or 16, default 16. The encoder rejects a value above the declared maximum. Floating depth is fixed at 16 or 32 by its sample format. |
| `sampleFormat` | `'uint'` for integer arrays (inferred); `'float16'` for raw IEEE binary16 words in `Uint16Array`; `'float32'` for `Float32Array` (inferred). |
| `transferFunction` | `'srgb'`, `'linear'`, `'pq'`, or `'hlg'`. Defaults to sRGB for integers and linear for floats. The declaration describes existing values. |
| `intensityTarget` | Positive peak luminance in nits, represented in the header as binary16. Defaults to 10000 for PQ, 1000 for HLG, otherwise 255. Accepted from the smallest positive binary16 value up to, but excluding, 65520; other values are refused. |
| `alphaPremultiplied` | Boolean, default false. True carries associated RGB and alpha without division, including nonzero RGB below zero alpha. |
| `icc` | Complete RGB or GRAY ICC bytes as `Uint8Array`. Copies and preserves the profile, with no sample conversion. Omit `colorSpace` and `transferFunction`; gray profiles require identical R/G/B source words. |
| `iccCompression` | `'auto'` (default), `'prefix'`, or `'lz77'`, with `icc`. Auto selects the smaller encoded profile. |
| `effort` | Integer from 1 to 9, default 1, in effort, wasm, photo, and JPEG entry points. Selects additional search; the core has no effort option. |
| `treeLearning` | `'sampled'`, in effort and wasm only. Selects a separate reduced lossless search. Normally omit to include all candidates. |
| `losslessProfile` | `'painting'` or `'painting-search'`, in effort, wasm, and the complete encoder. Requires quality 100 and straight RGBA8 with sRGB transfer, sRGB or Display P3 primaries, and the default intensity target. `'painting'` uses core lossless coding without the effort ladder; `'painting-search'` runs the effort ladder for paintings. |

The core, effort and wasm entries use VarDCT for non-palette straight RGBA8 below quality 100 when the input has
sRGB transfer, sRGB or Display P3 primaries, default intensity and no ICC profile. `photo: false` selects Modular
lossy coding. The core uses photographic effort 1; effort and wasm use the requested photographic search level.
The explicit photo entry uses VarDCT for these ordinary byte inputs below quality 100, including palettes.
Quality 100 uses exact Modular coding throughout. Native precision, ICC and other color/alpha declarations use
the shared Modular source path through every pixel entry point. Quality numbers do not imply equal fidelity
across encoders or images. The core and effort entry points may answer a lossy pixel request with an exact
palette candidate when that candidate is smaller.

### Lossless effort

Effort and wasm default to 1. Ordinary 8-bit lossless levels retain every earlier candidate.
Only a strictly smaller complete stream replaces the result; equal lengths keep the earlier candidate.
Search cost depends on the image and increases with each level.

| Effort | Additional search and cost |
| ---: | --- |
| 1 | Core channel prediction, prefix codes and zero runs; shortest search. |
| 2 | Weighted prediction; one additional prediction family. |
| 3 | A 16-leaf learned tree per group with ANS coding in place of 2's search; for a screen, weighted error contexts, screen palettes, residual runs and repeated glyphs instead; additional image passes. |
| 4 | Weighted error contexts, reversible color transforms and local palettes; several complete candidates. |
| 5 | Per-group learned trees from up to 65,536 samples, prefix/ANS selection and histogram sharing; tree-learning cost. |
| 6 | The learned model under the first-ranked reversible color transform; another learned candidate. |
| 7 | Eight predictors and broader spatial/channel properties; the complete worker's default search. |
| 8 | All 14 predictors, denser samples, wider trees and local screen transforms; several additional learned candidates. |
| 9 | A second-ranked transform, denser sampling and deeper trees; the longest search. |

Higher effort spends more time searching for smaller lossless files. There is no automatic deadline.
Set `job.hurry` to finish with a completed result. [Screen coding](../SCREENSHOTS.md).

The explicit `treeLearning: 'sampled'` option selects a reduced search: shared image trees at efforts 2–3, plus
per-group trees at 4–9. It does not include the ordinary predictor, screen, and mixed-predictor candidate ladder.
Any observed hurry in this mode returns effort 1 exactly.

For non-palette ordinary lossy inputs the effort and wasm entries use the photographic entropy ladder unless
`photo: false`; palette inputs also price an exact candidate at the requested effort. Native precision uses the
search described below.

Photo and JPEG efforts 3 and 4 try alternative entropy models and coefficient orders. Photographic coding through
core has fixed effort 1; through effort, wasm and photo it adds clustering at 3, a learned coefficient order at 4,
and ANS candidates at 5 and above. These searches preserve coefficients and decoded samples. The `-ans` imports
try ANS from effort 2.
At JPEG efforts 2 to 7 the ANS entry writes one ANS pass first and runs the prefix search only for pictures up to
512 x 512 pixels, where it can still be smaller.
JPEG effort 8 also combines learned orders with alternate histogram clustering. Effort 9 adds exact prefix-header
pricing and exact-count order candidates. The optional JPEG ANS entry adds corresponding ANS combinations.
These higher levels increase search time without changing decoded samples. The complete worker's JPEG route
uses the ANS entry and defaults to effort 7; its `effort` option accepts 1 through 9.
Only a strictly smaller completed stream replaces the retained result. Alpha stays exact at every quality.

### Lossless painting profile

Set `losslessProfile: 'painting'` to encode washes, textured brush strokes, edges, and transparent paper with core
lossless prediction, palette selection and prefix coding. It preserves every RGBA byte, including hidden RGB.
Files can be larger than the ordinary effort
search. The profile replaces that search regardless of the valid numeric effort or `treeLearning` setting; omitting
it keeps the ordinary effort behavior. Other pixel formats and quality below 100 are refused.

```js
const bytes = encode(rgba, width, height, {quality: 100, losslessProfile: 'painting'});
```

Set `losslessProfile: 'painting-search'` to search for a smaller painting at the requested effort. It runs that
effort's ladder without the weighted and color-transform searches and the `maximum` learned models, which did not win
on paintings. At effort 7 it wrote the same bytes as the ordinary search on eight paintings in 69% of the time.

`hurry` finishes the core lossless encode rather than returning a partial stream. Leaving the iterator cancels and leaves
`job.bytes` null. The complete encoder can distribute painting groups across available helper workers.

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
F16-output diagnostic repair is applied. The full suite uses four documented decoder repairs, including
three retained ordinary-image defects. Floating output
APIs can quiet signaling NaNs or canonicalize NaN payloads; the encoder's lossless modular input retains the supplied
IEEE words. Arbitrary NaN payload round trips through every decoder output format are not claimed.

### Reading PNG16 and OpenEXR

```js
import {readSource} from 'rapier-jxl/source';
import {encodeProfile} from 'rapier-jxl/icc';

const {data, width, height, ...source} = await readSource(fileBytes);
const bytes = encodeProfile(data, width, height, {...source, quality: 100});
```

`readSource` accepts `Uint8Array` or `ArrayBuffer`, copies the file before asynchronous work, and returns typed RGBA
samples plus encoding options. Decompression uses the platform's `DecompressionStream`; Node 22 is supported.
It shares the core's dimension limits and refuses malformed or unrepresentable input without returning partial pixels.

| Format | Accepted source forms | Color and alpha |
| --- | --- | --- |
| PNG16 | Grayscale, grayscale+alpha, RGB, or RGBA; every row filter; noninterlaced or Adam7; `tRNS` transparency | Supported full-range cICP; original `iCCP`; sRGB intent; representable gAMA/cHRM, including custom chromaticities. Straight alpha. Untagged files assume sRGB. |
| OpenEXR | Single-part flat scanlines; uniform HALF or FLOAT RGB or Y, optional A; NONE/RLE/ZIPS/ZIP; square pixels and coincident data/display windows | Supported D65 chromaticities, linear transfer, associated alpha; `whiteLuminance` carries the intensity target. Absent chromaticities assume linear sRGB primaries. |

PNG cICP takes precedence over other color chunks according to the [PNG specification](https://www.w3.org/TR/png-3/#color-chunk-precedence).
An unsupported cICP declaration, unrepresentable gamma/primary, animation, deep or tiled OpenEXR, mixed channel
precision, layers, subsampling, or a different display extent requires another
source reader. OpenEXR association follows its [channel convention](https://openexr.com/en/latest/TechnicalIntroduction.html#image-channels-and-sampling-rates).
The reader carries the listed sample and color information, not an archival copy of every file attribute. Exif,
text, camera metadata, and PNG mastering-display/content-light chunks are not copied into the JPEG XL output.
The original source file cannot be reconstructed from the result. Attach separately obtained Exif/XMP with
[`withMetadata`](#exif-and-xmp).

## Original profiles and HDR metadata

```js
import {encodeProfile} from 'rapier-jxl/icc';
const bytes = encodeProfile(rgba16, width, height, {
  quality: 100, icc: originalICC, iccCompression: 'auto',
});
```

Ordinary `encode`, photo and worker calls accept `icc`. Use `encodeProfile` for explicit custom color fields or
tone-mapping metadata. It preserves source sample words, complete three-component or GRAY profile bytes, unknown
ICC tags and padding. The three-component signatures are RGB, XYZ, Lab, Luv, YCbr, Yxy, HSV, HLS, CMY and 3CLR;
the RGBA array positions hold those profile-defined components and alpha. No color conversion, gamut mapping or
tone mapping is performed. Profiles are copied immediately, validated against their declared extent and use
available memory. Profiles above the normative level-5 limit of 4 MiB select level 10. Explicit `level: 5` refuses incompatible precision or profile size;
`level: 10` declares the higher level. `effort` is 1 or 2; 2 also prices coding without a reversible color transform.

Without ICC, `colorEncoding` supplies these fields. Alongside ICC it may supply only an explicit `space`; the
profile supplies the remaining color meaning.

| Field | Values |
| --- | --- |
| `space` | `'rgb'`, `'gray'`, `'xyb'` or `'unknown'`; gray RGBA input repeats identical R/G/B words. Unknown requires ICC. Original XYB describes already-scaled source components and does not enable the encoder's internal XYB transform. |
| `whitePoint` | `'d65'`, `'e'`, `'dci'`, or `[x, y]`. Custom coordinates round to millionths. |
| `primaries` | RGB only: `'srgb'`, `'display-p3'`, `'rec2020'`, or three `[x, y]` pairs in red/green/blue order. |
| `transferFunction` | `'srgb'`, `'linear'`, `'pq'`, `'hlg'`, `'bt709'`, or `'dci'`. |
| `gamma` | Encoding exponent from 1/8192 through 1, such as `1 / 2.2`; mutually exclusive with transfer function. |
| `renderingIntent` | `'perceptual'`, `'relative'`, `'saturation'`, or `'absolute'`. |

`toneMapping` accepts `intensityTarget` (peak nits), `minNits`, `relativeToMaxDisplay` and `linearBelow`.
The last is nits or a fraction of the display peak according to the flag. Luminances use binary16;
minimum luminance cannot exceed the peak. These fields describe display adaptation of already-encoded values.
PQ defaults to 10000 peak nits, HLG to 1000. Original XYB omits white-point, primaries and transfer fields and defaults
to perceptual intent. Decoder support for original XYB/unknown enums and specialized non-RGB ICC interpretation
varies; see [format coverage](FORMAT-COVERAGE.md). Omit other color declarations when supplying `icc`, except the
optional explicit `colorEncoding.space`.

`prepareICC(profile, {compression, level, colorSpace})` supplies `colorData` and `iccData` bit writers for the
readable `/writer` API. Append the ICC data after transform data and before image-header byte alignment.
CMYK requires `colorSpace: 'cmyk'`, three color planes and a black extra plane through `/channels`.

## Progressive photographs and transform controls

```js
import {encodePhoto, photonNoise} from 'rapier-jxl/photo-advanced';
const progressive = encodePhoto(rgba8, width, height, {
  quality: 90, progressive: 'spectral', transforms: 'auto',
});
const earlyPreview = encodePhoto(rgba8, width, height, {
  quality: 90, lfFrames: 1, progressive: 'spectral',
});
```

Omitting advanced options retains ordinary photo output. Format options below quality 100 require eight-bit
samples with sRGB transfer. They remain explicit choices: fixed-quality measurements do not establish equal-look
compression gains. `TRANSFORMS` lists all 27 supported IDs, geometries and shared quantization families.

| Option | Meaning |
| --- | --- |
| `transforms` | `'auto'` compares DCT8/DCT16 coefficient cost. A transform name or array selects explicit tilings: DCT2, DCT4, IDENTITY, AFV0–3, square DCT8–256 and every specified rectangle. Names use rows before columns; DCT8 fills incomplete boundary tiles. |
| `quantization` | Maps transform-family names to raw three-channel step matrices or compact descriptors below. Raw steps round to 1/16 and lie in 1/16–4095. Transposed strategies share one family; supply it once. Optional `dc` supplies three LF steps in Y/Cb/Cr order. |
| `progressive` | `true`/`'spectral'`, `'successive'`, `'responsive'`, or `{passes: [{downsample, shift}, ...]}`. Two to eleven passes; downsample is 1/2/4/8, shift 0–3, neither increases, and the final pass is `{downsample: 1, shift: 0}`. Final coefficients sum exactly to the corresponding complete reconstruction. |
| `lfFrames` | `true` or 1–4 recursive levels at successive 1/8 scales. Eight-bit sRGB, including exact alpha, XYB or explicit YCbCr transforms, raw/compact tables, HF progression and noise. Normal XYB DC units use a lossless Modular deepest frame; YCbCr or finer units use fine VarDCT. Uses level 10 for intermediate buffers. |
| `noise` | Eight strengths from 0 to 1023/1024, quantized to 1/1024; `'photon'` for ISO 800; or `{iso}` from 1 to 1e9. `photonNoise(width, height, iso)` returns the curve. This synthesizes grain; it does not estimate or remove existing grain. |
| `orientation` | Exif orientation 1–8, default 1. |

Compact quantization uses `{mode, ...fields}`. Every channel vector is in Y/Cb/Cr order. Positive weights are
inverse steps: larger retains finer detail. A band's first value is positive; later entries are signed relative
changes. Values round through their actual binary16 wire fields before planning. `library` and `dct` work for all
17 table families; modes `identity` through `afv` require an 8×8 family.

| Mode | Fields |
| --- | --- |
| `library` | No additional fields; predefined format weights. |
| `identity` | `weights`: three vectors of three positive weights. |
| `dct2` | `weights`: three vectors of six positive weights. |
| `dct4` | `bands`: three vectors of 1–16 values; `multipliers`: three vectors of two positive values. |
| `dct4x8` | `bands`: three vectors of 1–16 values; `multipliers`: three positive values. |
| `afv` | `weights`: three vectors of nine positive values; `bands4x8` and `bands4x4`: three vectors of 1–16 values each. |
| `dct` | `bands`: three vectors of 1–16 values. |

Chrome 155 and libjxl agree on these tables. Oxide 0.12.6 has separate defects in compact `identity`/`dct2` and
the predefined 128×256 family; use equivalent raw matrices when that decoder must render the same pixels.

HF progression preserves final coefficients. LF1 matches the existing XYB route exactly on the measured corpus;
deeper LF intermediates differ by at most one 8-bit code value there. A usable LF prefix includes the pyramid
and the main frame's DC sections. A bare LF-frame prefix alone is not a renderable `djxl` image.
`withContainer` can subsequently emit ordered `jxlp`; fragmentation and image progression are separate controls.
Noise encodes complete eight-pixel tiles and crops to the original canvas, preserving original alpha and dimensions.

## Reuse photographic transforms and fit a byte budget

```js
import {createPhotoPlan} from 'rapier-jxl/photo-plan';

const plan = createPhotoPlan(rgba8, width, height, {quality: 85, transforms: 'auto'});
try {
  const preview = plan.encode(55);
  const full = plan.encode(85);
  const fitted = plan.encodeTarget(50000, {minQuality: 25, maxQuality: 95, maxProbes: 12});
  save(fitted.bytes);
} finally {
  plan.dispose();
}
```

Planning retains unquantized YCbCr transform coefficients and LF samples once. The transform layout stays fixed
at `planningQuality` (default 90); each encode repeats quantization and entropy coding. Explicit layouts cover all
27 transforms and match the corresponding ordinary advanced encode. An automatic layout can differ from
replanning at another quality. Input is eight-bit straight RGBA with sRGB transfer, sRGB or Display P3 primaries,
and no ICC. Advanced custom matrices, progressive passes, orientation and explicit noise are supported; LF frames
require sRGB primaries. Alpha remains exact. Quality is at least 1 and less than 100.

`encodeTarget(targetBytes, options)` measures complete files, including alpha, LF frames and container overhead.
`minQuality` defaults to 1, `maxQuality` to 99.9, and `maxProbes` to 12 (allowed 2–32). An optional `initialQuality`
must lie inside the chosen range. The result contains `bytes`, `quality`, `targetBytes` and every probe's quality
and file size; `null` size records a candidate rejected with `JXL_SIZE`. It returns the highest quality
actually tested that fits. Quantization and entropy choices make size nonmonotonic, so this is not a global
quality optimum. No fitting tested candidate raises `JXL_SIZE`.

`maxRetainedBytes` defaults to 256 MiB and accepts up to 2 GiB. It bounds retained typed arrays; object overhead and
transient encoding buffers are additional. `retainedBytes`, `blockCount` and `strategies` describe the prepared
plan. The source pixels are neither retained nor changed. `dispose()` releases retained buffers and makes later
encodes fail with `JXL_INPUT`. Planning and both encoding operations have incremental counterparts. Exhaust
`createPhotoPlanSteps` before reading `job.plan`; `encodeTargetSteps` exposes `job.result` and `job.bytes` on completion.
Its `hurry` finishes with a complete fitting candidate once one exists. See [measured reuse](../../bench/PHOTO-PLAN.md).

## Exact text and graphics over a photograph

```js
import {encodeHybrid, hybridRegions} from 'rapier-jxl/hybrid';

const bytes = encodeHybrid(rgba8, width, height, {
  quality: 85, effort: 3, regions: [{x: 0, y: 0, width, height: 96}],
});
const candidates = hybridRegions(rgba8, width, height);
```

Explicit `regions` retain every original RGBA byte within each selected rectangle, including hidden RGB. Each
rectangle expands to enclosing 8×8 blocks and clips to the canvas. Outside those blocks, the YCbCr DCT8 picture
has the same coefficients as the corresponding ordinary advanced photo. The encoder writes exact Modular crops
over that photograph using the existing layer writer. At most 255 rectangles are accepted.

`regions: 'auto'` is the default. It finds few-color tiles, prices exact crops against their photographic coding,
and retains a hybrid only when its complete file is smaller than the ordinary YCbCr result. For mostly graphical
images a complete lossless candidate also competes. Automatic detection does not promise to recognize all text.
Use explicit regions when exactness is required; that request can produce a larger file. `hybridRegions` reports
detection candidates before the complete-file cost selection.

`quality` is 1–100 (default 90), `effort` is 1–9 (default 1), `colorSpace` is sRGB or Display P3, `orientation` is
1–8, and `progressive` accepts the advanced HF-pass forms. Input is straight RGBA8 with sRGB transfer. Quality 100
is lossless. ICC, native precision and other advanced photo options are not admitted by this entry. The incremental
`encodeHybridSteps` provides the usual cancellation and hurry behavior. [Hybrid measurements](../../bench/HYBRID.md)
show both savings and the substantial automatic-analysis cost.

## Source grain

```js
import {encodePhoto} from 'rapier-jxl/noise';

const grainAware = encodePhoto(rgba8, width, height, {quality: 40, noise: 'auto'});
```

This entry accepts advanced photo options and adds `noise: 'auto' | 'off' | number`. Auto is its default.
It estimates grain in flat, opaque regions, removes a bounded luminance residual and writes a conservative
noise-synthesis curve. Automatic replacement is active only at qualities 25–52 for eight-bit, straight-alpha
sRGB with the sRGB transfer, a 255-nit intensity target and no ICC profile. Other qualities and declarations
retain the ordinary route. Quality defaults to 90, where automatic replacement is inactive. Clean inputs and
quality 100 keep their ordinary encoded bytes; transparent source regions do not establish a grain estimate.

`'off'` disables noise. A positive numeric ISO uses the full-frame photon model without removing source grain.
The advanced entry's explicit LUT, `'photon'` and `{iso}` forms are also accepted. Ordinary photo entries and
package presets retain their defaults. The [grain study](../../bench/NOISE-STUDY.md) records matched-byte
SSIMULACRA2 and Butteraugli results, the extra analysis time and the rejected broader-quality candidate.

## Custom inverse color transform

```js
import {DEFAULT_OPSIN, prepareOpsinTransform, withOpsin} from 'rapier-jxl/opsin';

const edited = withOpsin(encodedXYB, {
  inverseMatrix: [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
  opsinBiases: [0, 0, 0], quantizationBiases: [1, 1, 1, 0],
});
const restored = withOpsin(edited, {reset: true});
const transformData = prepareOpsinTransform(DEFAULT_OPSIN);
```

This edits the global inverse transform of an encoder-authored XYB image while retaining coded frames and ICC
entropy bits. It does not refit the encoder's forward transform. Non-XYB images are refused.

| Option | Meaning |
|---|---|
| `inverseMatrix` | Nine row-major values or three rows of three. |
| `opsinBiases` | Three signed inverse cube-response biases. |
| `quantizationBiases` | Four values: three per-channel biases for nonzero AC magnitude one, then the shared numerator subtracted from other nonzero AC coefficients. DC is unchanged. |
| `reset` | Restore the format defaults; conflicts with a matrix or bias replacement. |
| `upsamplingWeights` | Existing symmetric kernel layout: 15/55/210 values for factors 2/4/8. Omission retains existing kernels. |

Numeric array-like views are accepted. Values must be finite and round to finite binary16; absolute values of
65,520 or more are refused. Any custom opsin field writes all sixteen binary16 fields, rounding omitted defaults
too. On an existing custom image, omitted fields retain their existing values. Empty options return an owned exact
copy. The prepared writer composes as `ImageHeaderOptions.transformData` with `xyb: true`.

Containers retain brands, level and auxiliary boxes, coalesce the edited image into `jxlc`, and adjust frame-index
offsets by the header-size change. Actual edits to JPEG-reconstruction files are refused. Input and output use
available memory. This parser accepts the encoder's supported header/profile syntax.

## Exact graphics and authored patches

```js
import {encodeDeltaPalette} from 'rapier-jxl/delta-palette';
const exact = encodeDeltaPalette(rgba8, width, height, {paletteMode: 'auto'});

import {encodePatches} from 'rapier-jxl/patches';
const repeated = encodePatches(background, width, height, {
  atlas: {data: iconRGBA, width: 32, height: 32},
  patches: [{sourceX: 0, sourceY: 0, width: 32, height: 32,
    positions: [{x: 16, y: 16}, {x: 80, y: 16}]}],
});
```

Delta palettes preserve every RGBA8 byte, including hidden RGB. `paletteMode: 'auto'` compares the existing core,
screen search and implicit delta palettes, keeping the smallest complete interoperable file. `'implicit'` forces
implicit cubes/deltas; `'explicit'` and `'hybrid'` use custom difference tables. The latter decode exactly in
libjxl 0.12.0 and Chrome 155; jxl-oxide 0.12.6 has explicit-table decoding defects, so auto excludes them.
`deltaPredictor` is `'auto'`, `'left'`, `'top'`, `'average'`, `'gradient'` or `'weighted'`; `groupSize` is
128/256/512/1024 (default 1024). `maxDeltaEntries` is 1–4096 (default 256), `maxPaletteColors` 1–65536
(default 4096), and `screenEffort` 1–9 (default 5). `colorSpace` is sRGB or Display P3.

Authored patches copy rectangles from a caller-owned RGBA atlas. Every source and destination rectangle fits its
image. Position order is compositing order. `blend` accepts `'none'`, `'replace'`, `'add'`, `'multiply'`,
`'blend-above'`, `'blend-below'`, `'alpha-weighted-add-above'` or `'alpha-weighted-add-below'`.
`alphaBlend` defaults to the color operation; color-over modes define composite alpha. `clamp` and `alphaClamp`
clamp foreground factors for multiplication and alpha-aware operations. Replacement copies retain hidden RGB.

`effort` is 1–9, default 1. `baseError` is 0–127, default 0: it permits bounded quantization of base RGB before
blending while keeping atlas samples, alpha and fully transparent RGB exact. Replacement patches remain exact.
`orientation` is 1–8; `colorSpace` is sRGB or Display P3. Default level 5 enforces the native browser's patch-area
budget. Explicit `level: 10` admits larger legal dictionaries, which Chrome 155 can still refuse.
Automatic glyph detection remains in the existing screen search; authored patches do not automatically replace it.

### Bounded graphics

```js
import {encodeGraphics} from 'rapier-jxl/graphics';
const bytes = encodeGraphics(rgba8, width, height, {preset: 'screen', protectedMask});
```

This entry compares complete exact and bounded-error Modular/palette files and keeps the smallest; the exact
candidate wins size ties. It accepts straight RGBA8 with sRGB transfer and sRGB or Display P3 primaries. Alpha and
every RGB sample at alpha below 255 stay exact, including hidden RGB. Source pixels are never modified.

| Option | Meaning |
| --- | --- |
| `preset` | `'exact'` by default; `'screen'` allows two RGB code values of error, and `'dither'` allows eight. |
| `maxColorError` | Integer 0–32, overriding the preset; hard maximum absolute error per RGB channel. Zero retains the ordinary exact delta-palette selection. |
| `paletteColors` | Learned-cluster search budget, 1–4096, default 256. Protected/unmerged colors or an exact winner may exceed this color count. |
| `preserveEdges` | Default `true`; preserves the outer border and pixels whose 3×3 source neighborhood has a channel range of at least 32 or touches nonopaque alpha. This is a precise pixel rule, not text recognition. |
| `undither` | Also prices a 3×3 binomial-mean candidate clamped to the original per-channel error bounds, then palette reduction. Default `true` only for the dither preset. |
| `protectedMask` | One byte per pixel; each nonzero entry preserves all four original samples exactly. |

`colorSpace`, `deltaPredictor`, `maxPaletteColors`, `groupSize` and `screenEffort` have the delta-palette meanings
above. `encodeGraphicsSteps` has the same result; keep source and mask unchanged until completion. Hurry retains
a complete candidate, and ending iteration cancels without partial output. This entry does not admit arbitrary
ICC profiles or native-depth samples.

### Typed planes and multiple patch sources

```js
import {encodePatchComposition} from 'rapier-jxl/patches';

const bytes = encodePatchComposition({
  base: {image: backgroundPlanes},
  references: [
    {slot: 0, image: firstSourcePlanes},
    {slot: 3, bytes: secondSourceJXL},
  ],
  patches: [
    {reference: 0, sourceX: 0, sourceY: 0, width: 32, height: 24,
      positions: [{x: 16, y: 16}]},
    {reference: 3, sourceX: 4, sourceY: 4, width: 16, height: 16,
      positions: [{x: 80, y: 16, blend: 'blend-above', alpha: 2,
        extraBlending: ['none', 'replace', 'none']}]},
  ],
}, {bitDepth: 16});
```

Each source supplies either a `PlanarImage` or existing encoded `bytes`. One to four references use distinct
slots 0–3, and each rectangle selects its own `reference`; omission selects the first supplied reference.
All sources share channel precision, extra-channel meaning and order, orientation, color, tone and transform
metadata. The example's extra planes are primary alpha, depth and a second alpha. An encoded source is one
independent, full replacement Modular or VarDCT frame without an existing patch or low-frequency dependency.
References have one coding pass; the base may retain progressive passes. RGB Modular and compatible RGB
VarDCT sources can mix. XYB sources compose with the same XYB domain. Existing encoded payload sections stay
unchanged; only framing, the patch dictionary and the first section's bit alignment are written.

Typed inputs use the same planar encoder and precision controls as `encodeChannels`, including integer and
floating planes and up to 256 extras. Per-source `options` may select `groupSize`, `predictor`,
`weightedPredictor`, `transforms`, `squeeze`, `progressive`, `maxTransformBytes` and `upsampling` without
changing shared metadata. Encoded sources already own those choices. Exact ICC/transform bits are part of the
compatibility check: two differently compressed copies of the same ICC profile can be refused. An implicit
default sRGB declaration and its equivalent explicit declaration are accepted together.

`alpha` selects an alpha extra-channel index, defaulting to the first alpha. `extraBlending` has one named
operation or `{blend, alpha, clamp}` object per extra channel; omission follows the color operation. All eight
patch operations apply independently. Color `blend-above`/`blend-below` also assigns that operation to the
selected composite alpha so native decoders agree. A non-alpha plane cannot serve as an alpha selector.

Destination coordinates refer to the base's coded pixels before spatial upsampling. Source coordinates refer
to the saved reference after its own spatial upsampling. For an upsampled base, color and every extra plane
must have the same total sampling factor, including `dimShift`. Every source and destination rectangle must
fit, and the writer enforces the format's image-dependent patch/blending and level-specific area budgets.

Patches blend floating-point samples in the decoder's pre-color domain. Even replacement therefore has
rendered-sample semantics for wide integers and nonfinite floating values; it does not promise raw uint31 or
NaN-payload copying. The original encoded source sections remain exact. A supplied `preview` is an authored
planar image of the finished composition. An encoded base retains its existing preview and refuses a separate
preview option. `encodePatchCompositionSteps` reports monotone progress; hurry keeps the same complete
composition, cancellation leaves `bytes` null, and all source buffers stay caller-owned and unchanged.

## Planar images, extra channels and previews

```js
import {encodeChannels} from 'rapier-jxl/channels';
const image = encodeChannels({width, height, color: [red, green, blue], extraChannels: [
  {type: 'alpha', data: alpha},
  {type: 'depth', data: depth16, name: 'Depth', bitDepth: 16},
]}, {preview: {maxDimension: 128}, orientation: 1});
```

`color` contains one gray plane or three color planes. Up to 256 extra planes independently declare `type`,
`data`, precision, `name` (up to 1071 UTF-8 bytes), `dimShift` and `upsampling`. Types are `'alpha'`, `'depth'`,
`'spot'`, `'selection'`, `'black'`, `'cfa'`, `'thermal'` and `'optional'`. Alpha supports `alphaPremultiplied`;
spot uses `spotColor: [red, green, blue, solidity]` in 0–1; CFA uses `cfaChannel` 0–274. CMYK uses three
color planes, a black plane and its original CMYK ICC. An isolated black plane without that color profile does
not give a browser a complete CMYK interpretation.

Integer `bitDepth` is 1–31 in unsigned typed arrays. Float32Array retains binary32 words; `'float16'` declares
raw IEEE half words. `'float'` permits raw unsigned words with 2–8 `exponentBits` and 2–23 mantissa bits,
including the sign in `bitDepth`. Color planes share precision; each extra plane can differ. Quality is 100.
The source is preserved as stored words; a decoder's floating output may canonicalize NaNs.

| Option | Meaning |
| --- | --- |
| `predictor` | `'auto'`, `'zero'`, `'left'`, `'top'`, `'average'` or `'gradient'`. |
| `groupSize` | 128, 256 (default), 512 or 1024. The general path uses tile scratch; compatible automatic lossless candidates also allocate temporary RGBA. |
| `upsampling` | 1/2/4/8. Stored color dimensions are `ceil(width/factor)` × `ceil(height/factor)`. |
| Extra `dimShift`, `upsampling` | Metadata shift 0–3 times frame factor 1/2/4/8. Combined scale is at least the color scale and at most eight; supply the corresponding reduced plane dimensions. |
| `upsamplingWeights` | Custom symmetric kernel arrays keyed by 2, 4 or 8, containing 15, 55 or 210 binary16 coefficients. |
| `orientation`, `intrinsicSize` | Exif orientation 1–8; independent intrinsic display `{width, height}`. |
| `preview` | `{maxDimension: 1..5440}` samples a preview, or supply an authored planar image sharing all channel metadata. The preview is a separate frame before the main image. |
| Color and level | `icc`, `iccCompression`, `colorEncoding`, `colorSpace`, `transferFunction`, `toneMapping`, `intensityTarget`, `level` as above. Required level 10 is automatic; incompatible explicit level 5 is refused. |

At group size 256 with predictor `auto`, compatible eight-bit RGB/gray and one full-resolution alpha plane also
compete through the shared palette/RCT lossless encoder. Complete frame size decides, with the existing result
retained on ties. Original metadata, explicit alpha shape and sample words remain exact. This candidate creates
one temporary RGBA buffer (four bytes per coded pixel); transform/model scratch and candidate outputs are
additional. Forced predictors, other group sizes, wider samples and other extra-channel layouts retain the general path.

Chrome 155 reads reduced extras when their reduction is expressed by per-frame `upsampling`. Its metadata
`dimShift` path is defective when color upsampling is one; the same metadata shift works with color upsampling
two. It also imposes a 256-total-channel resource cap, so gray plus 256 extras is refused despite a level 10
declaration. Both independent decoders retain all 256 extras. jxl-oxide 0.12.6 misreads small preview TOCs when
the canvas exceeds 1024 pixels on an axis; libjxl and Chrome read those previews correctly.

## Still layers and reference frames

```js
import {encodeLayers} from 'rapier-jxl/layers';
const bytes = encodeLayers({width, height, layers: [
  {image: backgroundPlanes, name: 'Background'},
  {image: detailPlanes, x: 40, y: 24, blend: 'blend', name: 'Detail'},
]});
```

Each layer supplies `image` (planar input) or `bytes` (a compatible one-frame encoded still). Image color meaning,
sample precision, channel metadata, orientation and transform data are shared. Negative `x`/`y` origins clip
against the canvas. `blend` is `'replace'`, `'add'`, `'blend'`, `'muladd'` or `'multiply'`; `alpha` selects an
extra alpha channel, and `clamp` controls foreground factors. `extraBlending` supplies one operation per extra
plane. Color-over defines composite alpha even if a different alpha operation was supplied.

Nonfinal visible layers save to reference slot 3 by default and the next layer uses that completed canvas.
`saveAs` and `source` explicitly select slots 0–3; an unread slot is refused. `referenceOnly: true` stores a frame
without displaying it. A post-color reference covers the canvas; `beforeColorTransform: true` also permits
smaller reference-only frames for low-level composition. `skipProgressive: true` writes that frame type.
The final layer displays the result. Names allow 1071 UTF-8 bytes. At most 256 authored layers are accepted.

Per-layer `options` can change `groupSize`, `predictor` or `upsampling`; shared options are the `/channels`
options. A layer preview is an authored planar image of the finished composition. Encoded layers with atlas
references or LF pyramids need their dedicated encoders; this compositor accepts one frame per layer.
Composite area above 2^28 pixels or wide channel buffers requires level 10. Slots 1 and 2 are conventionally
reserved for patch atlases and animation when composing with those independent tools.

Arithmetic blending can produce alpha above one before display conversion. In Chrome 155, use `ImageDecoder`
or `createImageBitmap(blob, {premultiplyAlpha: 'none'})` for that case; default bitmap premultiplication changes
the displayed color. Ordinary alpha compositing can round by one display code value across decoders.

## Authored splines

```js
import {encodeSplines, splineStroke} from 'rapier-jxl/splines';
const stroke = splineStroke([[12, 20], [40, 28], [68, 18]], {
  colorXYB: [0, 0.04, 0], sigma: 1.25,
});
const bytes = encodeSplines(rgba8, width, height, {quality: 90, splines: [stroke]});
```

Splines add authored XYB curves over an sRGB photographic base; they do not extract curves from a raster image.
`splineStroke` quantizes a constant amplitude and Gaussian width. Advanced callers provide integer
`controlPoints`, three 32-element signed `colorDct` arrays (X, Y, B-minus-Y correlation), and 32 `sigmaDct`
coefficients. All curves share `quantizationAdjustment`, default zero. At least two distinct adjacent control
points are required: one-point curves have inconsistent meanings in the pinned independent decoders.

Base `quality` is 1–99, default 90; `effort` 1–9, default 1; `filter` `'auto'` or `'off'`; `orientation` 1–8.
Alpha remains exact. Default `level: 5` enforces the spline resource budget used by Chrome 155. Explicit level 10
admits broader legal curves that independent decoders accept, but Chrome retains its level 5 area restriction.
Coordinate, point-count and rasterization limits are checked before encoding; see the declaration for exact bounds.

## Optional bundle sizes

These values are generated from the staged, import-checked files. gzip uses level 9; Brotli uses quality 11.
Added gzip is the entry bundled with the core minus the core alone, so shared code is counted once.

| Entry | Minified bytes | gzip | Brotli | Added gzip with core |
| --- | ---: | ---: | ---: | ---: |
| `icc` | 37,338 | 14,741 | 13,076 | 2,136 |
| `photo-advanced` | 155,438 | 56,358 | 48,306 | 34,297 |
| `delta-palette` | 85,856 | 33,315 | 29,098 | 20,501 |
| `channels` | 85,600 | 31,653 | 27,681 | 24,589 |
| `layers` | 96,157 | 35,091 | 30,625 | 28,115 |
| `splines` | 57,870 | 23,071 | 20,369 | 4,516 |
| `patches` | 141,353 | 52,471 | 44,966 | 38,475 |
| `container` | 7,499 | 3,359 | 2,838 | 1,896 |
| `container-advanced` | 42,346 | 15,778 | 13,868 | 15,574 |
| `opsin` | 70,796 | 27,491 | 23,797 | 18,352 |
| `progressive-container` | 53,698 | 20,042 | 17,610 | 19,858 |
| `noise` | 183,536 | 68,332 | 57,607 | 45,435 |
| `hybrid` | 140,074 | 52,251 | 45,109 | 32,302 |
| `photo-plan` | 115,544 | 42,338 | 36,406 | 24,951 |
| `delivery` | 48,052 | 17,921 | 15,759 | 17,711 |
| `brotli` | 12,269 | 5,484 | 4,770 | 9,285 |

## Existing JPEGs

```js
import {transcode, reconstructJPEG} from 'rapier-jxl/jpeg';
const {bytes, width, height, orientation} = transcode(jpegBytes, {effort: 4});
const original = reconstructJPEG(bytes); // original JPEG bytes
```

`jpegBytes` is a non-empty `Uint8Array`. Baseline, extended sequential, and progressive 8-bit grayscale, YCbCr, and RGB
JPEGs are accepted, including restart markers. Coefficients, quantization tables, subsampling, orientation, and
RGB/GRAY color profiles are carried. Recognized sRGB/Display P3 profiles keep the existing named-color codestream
by default; other admitted profiles are embedded exactly. Set `icc: 'preserve'` to embed every original profile;
`iccCompression: 'auto' | 'prefix' | 'lz77'` then controls its entropy coding. JPEG reconstruction retains the original
APP2 bytes in either mode. `width` and `height` are displayed dimensions, swapped for a
quarter-turn orientation; `orientation` is the Exif value 1–8 retained in the JPEG XL header.

`transcode` writes a JPEG XL container with standard `jbrd` reconstruction metadata. It retains JPEG marker payloads,
including admitted ICC, Exif and XMP, and scan choices; image coefficients live only in the codestream.
`reconstructJPEG(bytes)` restores the original JPEG from this encoder's output, including the optional ANS entry point.
It returns `null` for files without reconstruction data, and throws `JXL_RECONSTRUCTION` for damaged or unsupported
reconstruction forms. This is a coefficient reader for this encoder's VarDCT streams, not a general JPEG XL decoder.
Metadata edits to carried JPEGs are refused because they would invalidate reconstruction.
Arithmetic-coded, 12-bit, lossless, CMYK, DNL-height, incompatible-profile and malformed JPEGs are refused with
`JXL_JPEG`. Decode those with a JPEG decoder and pass the resulting pixels to a pixel entry point.
Reconstruction also requires an EOI marker, a fixed restart interval, and normalized sampling factors for progressive
or interleaved scans. Any JPEG syntax the writer cannot reproduce exactly is refused before returning a carried file.

## Streaming containers

```js
import {withContainer, containerChunks, streamContainer} from 'rapier-jxl/container';

const file = withContainer(bytes, {chunkSize: 65536});
for (const chunk of containerChunks(bytes)) await sink.write(chunk);
for await (const chunk of streamContainer(rawCodestreamChunks, {level: 5})) await sink.write(chunk);
```

`withContainer` collects a new file; `containerChunks` yields owned byte arrays. Both accept raw codestreams or
containers, preserve the codestream and other boxes exactly, and write ordered `jxlp` fragments. This framing
does not add progressive image coding. JPEG reconstruction stays exact. `streamContainer` consumes a synchronous
or asynchronous iterable of raw codestream chunks with backpressure, holding one byte for the final fragment.

`chunkSize` is a positive safe integer, default 65,536. `maxBytes` is an optional positive safe-integer budget for
total output; omission uses available memory. `signal` cancels iteration.
For incremental raw input, set `level: 10` when required by the image; it defaults to 5. A canceled, failed or
incomplete producer does not receive a successful final fragment. Use `/container/min` for a self-contained build.

## Pass-aligned delivery

```js
import {
  progressiveContainerPlan, progressiveContainerChunks,
  withProgressiveContainer, streamProgressiveContainer,
} from 'rapier-jxl/progressive-container';

const file = withProgressiveContainer(progressiveImage);
const plan = progressiveContainerPlan(progressiveImage);
for await (const chunk of streamProgressiveContainer(progressiveImage, {
  metadata: {xmp: suppliedXmp, compression: 'auto'},
})) await sink.write(chunk);
```

These calls cut ordered `jxlp` boxes at actual preview, LF, progressive-pass and frame boundaries, keeping every
codestream byte. They take an already encoded complete image; `streamContainer` remains the raw-source iterable
API. Framing alone does not add progression to an image.

| Option | Meaning |
|---|---|
| `chunkSize` | 1–2,147,483,647 bytes, default 65,536; also cuts large sections. |
| `maxBytes` | Optional positive safe-integer total-byte budget; omission uses available memory. |
| `metadataPlacement` | `'after'` by default, or `'before'`; indexes stay after the image. |
| `extended` | Use extended box headers. |
| `level` | 5 or 10; existing level 10 is retained and demotion refused. |
| `iccBitLength` | Encoded ICC length for supported profile-bearing framing. |
| `signal` | AbortSignal for cancellation. |
| `metadata` | Async entry only: the compressed-metadata options, including `compress`. |

The plan reports dimensions, level, byte totals, physical fragments and semantic milestones with both codestream
and container end offsets. Passes include a reduced-resolution hint; LF dependency frames include their pyramid
level; a dedicated preview has frame index −1. LF dependencies are distinct from renderable low-frequency data.
Actual early rendering depends on the reader and file: multi-group pass and LF examples render before completion,
while the tested small single-group and dedicated-preview examples wait for more input.

The chunk iterator snapshots input at the call and yields owned, complete boxes. Backpressure limits later chunk
allocation. Async metadata compression completes before the first chunk, even when the metadata is placed last.
Version-1 fragments normalize to ordered delivery; auxiliary payloads and JPEG reconstruction remain exact.
Metadata editing uses available memory and refuses reconstruction files. Unsupported external header syntax
and permuted frame TOCs are refused by this entry's framing reader.

## Deliver a selected region first

```js
import {deliveryLayout, withDeliveryOrder, normalizeDelivery} from 'rapier-jxl/delivery';

const reordered = withDeliveryOrder(progressiveImage, {
  region: {x: 256, y: 256, width: 128, height: 128}, strategy: 'region-first',
});
const layout = deliveryLayout(reordered);
const ordinaryOrder = normalizeDelivery(reordered);
```

This changes the frame's TOC permutation and physical section order while preserving every encoded section.
`region-first` completes the intersecting groups before the remaining groups. `pass-first` refines the image by
pass, putting selected groups first within each pass. The rectangle uses canvas pixels before Exif orientation.
`frameIndex` selects a displayed frame (last by default), or −1 for a dedicated preview. LF dependency frames
accept explicit `sectionOrder` only. That option is a complete bijection of logical section indices and is
mutually exclusive with `region`.

`deliveryLayout` reports frames, pass/group geometry, logical and physical indices, and absolute naked-codestream
offsets. These are byte-delivery observations, not a promise about every reader's partial rendering. The native
region witness finishes the selected 128×128 region at 3,206 of 4,365 bytes while other regions still await data.

`normalizeDelivery` restores logical order for the layer, animation and progressive-container readers. Supported
permutations use this writer's one-histogram prefix form without LZ77; arbitrary external ANS permutations are
refused. `maxBytes` is an optional positive safe-integer budget and otherwise uses available memory;
`iccBitLength` supports known profile-bearing framing. Empty options retain
input bytes exactly. Actual TOC edits refuse JPEG-reconstruction containers; the no-op keeps reconstruction exact.

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
| `jumb` | Contents of one JUMBF superbox as a `Uint8Array`, or an array of superboxes. `null` or `[]` removes all. |

Omit a field, or pass `undefined`, to retain its existing metadata. Supply a value to replace it, or `null` to remove
it. New metadata uses standard uncompressed `Exif`, `xml ` and `jumb` boxes. Matching existing boxes, including compressed
metadata boxes, are replaced or removed; other boxes and the image codestream retain their bytes. Adding metadata
to a bare codestream wraps it in a JPEG XL container. Total output, including metadata, uses available memory.

Pixels, color encoding and orientation stay unchanged. Keep Exif orientation consistent with the encoded image.
This module does not extract metadata from source files, import ICC profiles or convert color. It checks container
framing and the TIFF signature without decoding the image or parsing the Exif/XMP contents.

Requested edits, including removal, throw `JXL_INPUT` for a container with JPEG reconstruction data (`jbrd`),
because changing metadata can invalidate reconstruction. Omitting all fields returns a copy.

`await withCompressedMetadata(bytes, {...fields, compression: 'auto'})` writes Brotli `brob` metadata only when the
complete compressed payload is smaller. Use `compression: 'brotli'` to require compression. Node loads its native
Brotli codec lazily; browsers use native Brotli streams when available and the bundled portable codec otherwise.
An explicit `compress(bytes, {maxOutputLength})` callback overrides that choice and may return bytes or a promise.
The complete worker uses the same native-first choice. Compressed metadata bytes can differ between native
implementations; extracted payload bytes remain the comparison boundary.

`readMetadata(bytes)` returns owned `exif`, `xmp`, and `jumb` arrays in file order, plus `compressed` entries with
`boxType` and `data`. `await readMetadataAsync(bytes, {decompress, maxDecodedBytes})` also expands compressed
metadata. `maxDecodedBytes` optionally bounds all expanded payloads, including the Exif offset; omission uses
available memory. A supplied decoder must honor a supplied `maxOutputLength` before allocating its result. These calls preserve payloads without interpreting
their application-specific contents.

## Portable Brotli

```js
import {compressBrotli, decompressBrotli} from 'rapier-jxl/brotli';

const compressed = compressBrotli(metadataBytes);
const original = decompressBrotli(compressed, {maxOutputLength: 16 * 1024 * 1024});
```

These synchronous calls return owned `Uint8Array` buffers and leave input unchanged. `maxOutputLength` is an
optional nonnegative safe-integer output budget; omission uses available memory. The encoder uses a 64 KiB window, adaptive prefix coding and LZ77;
incompressible blocks use stored output. It is an original MIT implementation with no runtime dependency.

The portable reader supports the form this writer emits, not every external Brotli stream. Multiple context
configurations, direct/postfix distances and static-dictionary references require a full native or supplied
decoder. `readMetadata` preserves other `brob` payloads as owned compressed bytes without expanding them;
`readMetadataAsync` refuses an unsupported form rather than returning altered metadata. Supply a bounded
`decompress` callback when reading broader external metadata. Browser metadata fallback and the complete worker
can compress and read back their own Exif, XMP and JUMBF without any network request.

## Extended containers, indexes and gain maps

```js
import {reframeContainer, withFrameIndex, withGainMap} from 'rapier-jxl/container-advanced';
const wide = reframeContainer(encoded, {extended: true, chunkSize: 65536});
const ordered = reframeContainer(version1File);
const indexed = withFrameIndex(encoded, {
  tickNumerator: 1, tickDenominator: 1000,
  frames: [{byteOffset: firstFrameOffset, duration: 70, framesToNext: 1}],
});
const gained = withGainMap(encoded, {
  gainMapMetadata: originalISO21496Metadata, gainMap: encodedGainImage,
  alternativeColorEncoding: {primaries: 'rec2020', transferFunction: 'pq'},
  alternativeICC: originalAlternateICC,
});
```

`inspectContainer(bytes)` returns owned logical codestream bytes, level, version, fragment records and opaque
auxiliary payloads. `containerBoxHeader(type, bodyLength, {extended})` writes a header without allocating its
payload. `maxBytes` is an optional positive safe-integer budget for complete inputs and outputs; omission uses
available memory.
Writing options accept `extended` and `level: 5 | 10`. The signature keeps its fixed header, and level 10 cannot
be demoted. Image coding, unknown payloads and JPEG reconstruction bytes remain exact.

`reframeContainer` writes ordinary `jxlc` by default. `chunkSize` splits ordered `jxlp`; `fragmentOrder` supplies a
complete permutation and selects file-format version 1. `minorVersion` may explicitly select 0 or 1. Every fragment
containing a frame start stays after earlier and before later fragments. Automatic framing reads this encoder's
headers; supply `iccBitLength` for an ICC-bearing image, or a complete `frameStarts` list for external syntax.
The author is responsible for that list's correctness, including previews and hidden frames. Default admission
also keeps each frame's preceding fragment in order for Chrome 155. `allowBufferedFrameEnds: true` admits broader
legal layouts with a recorded native animation limitation. Oxide 0.12.6 requires ordered normalization.

`frameIndexPayload(index)` serializes `jxli`; `withFrameIndex(bytes, index | null)` replaces or removes it, and
`readFrameIndex(bytes)` returns it or `null`. A tick lasts `tickNumerator / tickDenominator` seconds; these fields
are unsigned 32-bit and the denominator is nonzero. Every entry supplies `byteOffset`, `duration` and `framesToNext`.
Offsets count from the naked codestream's `FF0A`, excluding boxes. Durations use index ticks; displayed-frame counts
are at least one. All three accept unsigned 63-bit values; use `bigint` beyond safe integers. The first displayed
frame is indexed. The author supplies keyframe independence, accurate offsets and durations; the helper checks
wire ranges and bounds, without decoding frame dependencies.

`gainMapPayload(bundle)` serializes the third-edition `jhgm` bundle. `withGainMap(bytes, bundle | null)` replaces
or removes it; `readGainMap(bytes)` returns owned version-0 fields or `null`. Supply original ISO 21496-1 metadata
(at most 65,535 B) and an already encoded JPEG XL gain image. Optional alternate rendering metadata accepts
`alternativeColorEncoding`, original `alternativeICC` and `iccCompression`, or the reader's exact
`alternativeColorEncodingBytes` and `alternativeICCCompressed` forms. Structured/raw alternatives are exclusive.
A container gain image is unwrapped. This carries supplied gain maps; it does not derive samples, interpret gain
metadata or perform HDR rendering. A Brotli-wrapped gain-map box requires external decompression before reading.

## Animation

`rapier-jxl/animation` writes animated JPEG XL from whole-canvas frames:

```js
import {encodeAnimation} from 'rapier-jxl/animation';
const bytes = encodeAnimation({width, height, loops: 0, frames: [{data: rgba0, duration: 100}, {data: rgba1, duration: 100}]},
  {quality: 100, effort: 3});
```

- `data` is the whole canvas in any layout `encode` admits; every frame uses the same array type. `duration` is in
  milliseconds. `loops` is how many times the animation plays; `0` (default) plays forever.
- Each frame stores only the rectangles that changed since the frame before, placed over the saved canvas. Separate
  changes, such as a cursor and a clock, become separate rectangles. A frame identical to the one before adds its
  duration to it. A frame of 0 ms before the last is never shown alone; the frame after it shows its changes.
- Durations are exact when the header can express them as ticks: 100 ms frames use 10 ticks per second, 1001/30 ms
  frames 30000/1001. Other durations round to milliseconds without drift over the animation.
- Quality 100 (default) keeps every frame exact, including RGB under zero alpha and floating-point bit patterns.
  Below 100, 8-bit frames use DCT8 (XYB when the first frame suits it), or modular coding when an exact first frame is
  smaller than its DCT coding; `photo: true` or `false` decides. Changes are measured against the source each shown
  pixel was coded from, never against decoded error, so lossy error does not build up across frames. Modular frames
  compare exactly; a DCT block within a small tolerance of its coded source (scaled by the quality's distance) stays
  on the canvas, so a still camera's noise costs no new blocks. Alpha stays exact.
- Opaque animations may mask rectangles: pixels a rectangle leaves unchanged become transparent and blend over the
  canvas. The file then declares alpha; every shown pixel stays opaque.
- Options are `encode`'s, plus `effort` (1–9, applied to each frame), `photo`, `filter`, `signal` and `progress`.
  `encodeAnimationSteps` yields progress like `encodeSteps`.
- `LIMITS`: each frame within the core's 24 million pixels and 16,384 pixels per side, with at most 1,048,576 frames.
  Encoded output uses available memory.

The complete encoder has the same call: `await encoder.animation({width, height, loops, frames}, options)` takes the
complete encoder's presets and defaults. The worker request is `{id, operation: 'animation', width, height, loops,
frames, options}`; transfer each frame's buffer. The still worker has no animation and answers `JXL_UNAVAILABLE`.

### Shared animation atlas

```js
import {encodeAnimationAtlas} from 'rapier-jxl/animation-atlas';
const bytes = encodeAnimationAtlas(animation, {
  quality: 100, atlasMode: 'auto', atlasSearch: {strategy: 'auto', maxEntries: 256},
});
```

`buildAnimationAtlas(animation, searchOptions?)` deterministically discovers and packs byte-exact repeated glyphs
and tiles, returning an owned `AnimationAtlasPlan` or `null` when none fits. All channels, including hidden RGB,
participate in matching. Placements unchanged from the previously shown frame do not inflate use counts.

`encodeAnimationAtlas` accepts ordinary animation options plus `atlas`, `atlasMode` and `atlasSearch`. An authored
`atlas` supplies `{atlas: {data, width, height}, patches}`; each patch contains `sourceX`, `sourceY`, `width`,
`height` and `positions: [{frame, x, y}]`. Every placement must exactly match its source frame. A plan admits up to
1,048,576 atlas pixels, 4096 rectangles and 262,144 positions.

| Option | Meaning |
| --- | --- |
| `atlasMode` | `'auto'` by default retains an atlas only when the complete animation is smaller; `'force'` requires a usable atlas; `'off'` returns ordinary animation bytes. |
| `atlasSearch.strategy` | `'auto'`, `'glyphs'` or `'tiles'`; auto combines connected glyphs and aligned tiles. |
| `atlasSearch.tileSize` | 4, 8, 16, 32 or 64 pixels; default 16. |
| `atlasSearch.maxEntries` | Search budget of 1–4096 rectangles; default 256. |
| `atlasSearch.maxPixels` | Packed atlas search budget of 16–1,048,576 pixels; default 262,144. |
| `atlasSearch.minUses` | Useful repeated placements per rectangle, 2–65,536; default 2. |

Automatic atlas coding returns the ordinary animation bytes outside straight RGBA8 quality 100 or without a
saving; forced atlas coding refuses an unsupported input or an unusable plan. The atlas uses reference slot 3,
the ordinary animation canvas uses slot 2, and per-frame patch dictionaries retain slot 1. Timing, loops and
source differencing use the ordinary animation owner. Keep all source and supplied atlas buffers unchanged while
`encodeAnimationAtlasSteps` is active. Exhaust iteration to set `bytes`; cancellation leaves it null. Hurry can
retain the completed baseline at planning boundaries, while a started candidate may finish; force completes its
authored candidate.

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

The published `LIMITS` records expose `pixels` and `edge`; each dimension is at most 16,384 pixels. Core,
effort and wasm accept 24 million pixels; photo accepts 40 million; JPEG accepts 64 million. The corresponding
ANS entry point has the same dimension limits. Inputs and encoded output use available memory. APIs that expose
`maxBytes`, `maxDecodedBytes`, `maxOutputLength` or `maxRetainedBytes` retain those explicit caller-controlled
budgets; format-level restrictions, including level-5 ICC size, also remain in force.

Checked encoding entry points throw `Error` objects with a stable `code`. Branch on `code`; messages are diagnostic text.
Raw writer primitives require their documented preconditions; their errors are not limited to this vocabulary.

| Code | Meaning |
| --- | --- |
| `JXL_INPUT` | Invalid input type, buffer length, dimensions or option value; malformed metadata container or a rejected reconstruction-data edit. |
| `JXL_RECONSTRUCTION` | Invalid or unsupported JPEG reconstruction metadata or coefficient stream. |
| `JXL_DIMENSIONS` | Valid positive dimensions exceed the import's edge or pixel limit. |
| `JXL_SIZE` | An explicit byte/format budget is exceeded, or no complete candidate fits a requested target size. |
| `JXL_MEMORY` | Allocation failed or the requested storage length cannot be represented. |
| `JXL_JPEG` | Malformed JPEG or JPEG form the coefficient carrier cannot represent. |

Kernel configuration uses the same `JXL_INPUT` code for an invalid mode. Missing or blocked WebAssembly selects
JavaScript. [Kernel controls](../KERNELS.md).

## One call from a page

```js
import {toJXL} from 'rapier-jxl/image/min';
const blob = await toJXL(file, {worker: './rapier-worker.js'}); // type 'image/jxl'
```

`toJXL(source, options)` takes a `Blob` or `File`, `ImageBitmap`, `ImageData`, canvas, `OffscreenCanvas` or image element
and returns a `Blob`. `options.worker` is required: a `Worker` running either worker, or the URL of
`rapier-still-worker.js` or `rapier-worker.js` (one worker, ended after the call). A worker handles one call at a time.

- A JPEG file is carried losslessly at `effort` (7 by default) and `reconstruct` returns its exact bytes. Pass
  `transcode: false` to decode it and encode the pixels; a JPEG that cannot be carried fails with `JXL_JPEG`.
- Anything else is decoded with `createImageBitmap` (EXIF orientation applied) and encoded losslessly, or lossy with
  photographic coding when `quality` is 1 to 99. A canvas holds premultiplied alpha, so RGB under partly transparent
  pixels can round; `ImageData` reaches the encoder as given.
- Either worker also answers `{id, operation: 'image', source, options?, progress?}` with `{id, ok: true, bytes}`
  (plus `width`, `height` and `orientation` for a carried JPEG), and `createEncoder().image({source}, options)` does the
  same inside a worker. Failures use the codes above.

## Complete Rapier system

`rapier-jxl/rapier` and `/rapier/min` expose the complete encoder. Two self-starting classic workers are provided:
`rapier-jxl/rapier/still-worker` (`dist/rapier-still-worker.js`, what Rapier's page embeds) and
`rapier-jxl/rapier/worker` (`dist/rapier-worker.js`, the still worker plus animation and the other format writers described
here). Both include effort search, optional WASM with JavaScript fallback, photographic pixel encoding, reversible JPEG
coefficient transcoding and parallel lossless groups. Each packaged worker contains its supported features. Rapier
embeds the still worker and provides the complete worker in its on-demand JPEG XL complete part. Pixel decoding
uses the browser or an external decoder.

In a worker or Node:

```js
import {createEncoder} from 'rapier-jxl/rapier/min';
const encoder = createEncoder();
const bytes = await encoder.encode({data: rgba, width, height}, {lossless: true, effort: 9});
const carried = await encoder.transcode({bytes: jpegBytes});
```

`encode(image, options)` accepts the typed RGBA formats and color declarations above. Defaults are quality 90 and
effort 7. `lossless: true` forces quality 100. Add `losslessProfile: 'painting'` to skip the effort ladder for exact painting saves.
Photographic coding is the default for non-palette RGBA8 below quality 100; `photo: false` asks for the ordinary
pixel encoder, which other inputs always use. The complete entry admits 24 million pixels and
16,384 pixels per edge. JPEG input admits 64 million pixels; input bytes and encoded output use available memory.
Transcoding takes `effort` 1 to 9 (7 by default),
preserves admitted coefficients, orientation and the original JPEG syntax. `await encoder.reconstruct({bytes})`
returns the original JPEG bytes, or `null` for a file without reconstruction data.
`encode` and `transcode` accept `options.progress(fraction)` to report completed work from 0 to 1.

Use `preset` to choose defaults. Explicit `quality`, `effort`, and `photo` options override the preset;
`lossless: true` always forces quality 100. The default without a preset is quality 90, effort 7 and photographic coding.

| Preset | Quality | Effort | Coding below quality 100 |
| --- | --- | --- | --- |
| `web` | 85 | 3 | Photograph |
| `photo` | 90 | 7 | Photograph |
| `archive` | 100 | 9 | Ordinary pixels |
| `screen` | 100 | 5 | Ordinary pixels |
| `lossless` | 100 | 3 | Ordinary pixels |

These are starting points, not quality equivalences to other encoders. Keep `losslessProfile: 'painting'` for exact painting saves.
All color, precision, alpha, search, parallelism, and metadata choices remain explicit in the APIs above.
Photographic `filter: 'auto'` applies one edge-preserving filter to XYB at quality 90 or below.
`filter: 'off'` disables it. Alpha, quality 100, JPEG transcoding, and non-XYB coding do not use this filter.

Pass an `AbortSignal` to `encode` or `transcode` to cancel between incremental work units:

```js
const controller = new AbortController();
const result = encoder.encode({data: rgba, width, height}, {
  preset: 'photo', signal: controller.signal, progress: fraction => report(fraction),
});
// From your cancel handler:
controller.abort();
await result; // Rejects with controller.signal.reason; no partial file is returned.
```

Cancellation terminates helper workers and leaves the encoder reusable. Progress reaches 1 only after a complete
output exists. It measures completed work, not elapsed time. Synchronous parsing or one work unit can delay an abort;
the scheduling interval is not a maximum response time. The synchronous core still cancels by leaving job iteration.

The standard worker accepts one operation at a time:

- `{id, operation: 'encode', data, width, height, options?, progress?}` returns `{id, ok: true, bytes}`.
- `{id, operation: 'transcode', bytes, options?, progress?}` returns `{id, ok: true, bytes, width, height, orientation}`.
- `{id, operation: 'reconstruct', bytes}` returns `{id, ok: true, bytes}` with the original JPEG, or `bytes: null` when no reconstruction data is present.
- `{id, operation: 'cancel'}` cancels the active operation with that exact ID. Its response has code `JXL_ABORTED`; a stale ID has no effect.
- A failure returns `{id, ok: false, error: {code, message, stage?, detail?}}`. A concurrent request returns `JXL_BUSY`.

With `progress: true`, encoding and transcoding first send `{id, progress}` replies. Fractions increase to 1; intermediate
reports advance by at least one hundredth and are separated by at least 100 ms. Completion is the final response.

### Format operations

The still worker accepts `photo`, `profile`, `readSource`, `encodeSource` and `opsin`. Its photo action uses the
ordinary photo options: transforms, quantization, coefficient orders, progressive/noise/LF controls, upsampling,
extra channels, explicit level and orientation require the complete worker and refuse `JXL_UNAVAILABLE` in the
still worker. The complete worker accepts those five actions, advanced photo options and every other action below.

```js
const image = await encoder.format({
  action: 'hybrid', data: rgba8, width, height,
  options: {quality: 85, regions: [{x: 0, y: 0, width, height: 96}]},
}, {signal, progress: fraction => report(fraction)});
const plan = await encoder.format({
  action: 'photoPlan', data: rgba8, width, height,
  options: {transforms: 'dct16'}, qualities: [35, 55, 85], targetBytes: 50000,
});
```

`encoder.format(input, controls?)` exposes the format APIs through the same offline encoder. Put ordinary feature
options in `input.options`; cancellation and progress belong in `controls`. The standard worker message is
`{id, operation: 'format', input, progress?}`. Byte results return `{id, ok: true, bytes}` and transfer their buffer;
structured results return `{id, ok: true, result}`. `FormatRequest` and `FormatResult` in
[the declarations](../../src/format-worker.d.mts) define each input and result.

| Actions | Input and operation |
|---|---|
| `photo`, `noise`, `hybrid`, `deltaPalette`, `graphics`, `patches`, `splines`, `profile` | `data`, `width`, `height`, `options`; corresponding encoder. |
| `animationAtlas`, `animationAtlasPlan` | `animation`, `options`; shared-atlas animation or an owned discovered plan. |
| `hybridRegions` | RGBA8 dimensions and data; detected candidate rectangles. |
| `splineStroke` | `controlPoints`, `options`; quantized spline description. |
| `channels`, `layers` | `image`, `options`; authored planes or layers. |
| `patchComposition` | `image: {base, references, patches}`, `options`; typed or encoded Modular/VarDCT sources through one patch dictionary. |
| `photoPlan` | Pixel input and planning options, `qualities`, optional `targetBytes`/`targetOptions`; one retained plan shared across all results. |
| `readSource`, `encodeSource` | Source-file `bytes`; decoded native samples or their profile-preserving JPEG XL encoding. |
| `container`, `reframeContainer`, `progressiveContainer` | Encoded `bytes`, `options`; collected complete container. |
| `streamContainer` | `chunks` array and options; collected result of raw-chunk framing. |
| `inspectContainer`, `progressivePlan`, `deliveryLayout` | Encoded `bytes`, `options`; structure and byte milestones. |
| `deliveryOrder`, `normalizeDelivery`, `opsin` | Encoded `bytes`, `options`; corresponding exact-structure edit. |
| `metadata`, `compressedMetadata` | Encoded `bytes`, metadata options; original or native-first Brotli-compressed metadata. |
| `readMetadata`, `readCompressedMetadata` | Encoded `bytes`; owned metadata, with optional bounded expansion for the latter. |
| `frameIndex`, `readFrameIndex`, `frameIndexPayload` | Index attachment/removal, reading or payload authoring; use `index` for authored data. |
| `gainMap`, `readGainMap`, `gainMapPayload` | Supplied gain-map attachment/removal, reading or payload authoring; use `bundle` for authored data. |
| `boxHeader` | `boxType`, `bodyByteLength`, optional extended-header options. |
| `brotliCompress`, `brotliDecompress` | Raw `bytes` and bounded codec options; portable Brotli. |

The photo-plan request accepts up to 32 `qualities`, each at least 1 and less than 100. Omitted qualities encode
the planning quality, unless a target was supplied. The result reports plan dimensions/retained bytes/strategies,
`images: [{quality, bytes}]`, and a target result or `null`. Output images use available memory. Retained
buffers are disposed after success, failure or cancellation; a later request starts a fresh plan.

All requests are structured-cloneable. Compression callbacks do not cross worker messages: metadata uses native
Brotli when available and the built-in portable codec otherwise. Explicit `brotliCompress` and `brotliDecompress`
actions always use the portable entry, whose reader retains the external-stream limitations above. Progressive metadata is
compressed before the collected result completes. Existing busy, cancellation, transfer and error rules apply;
no partial result is returned as success.

Use a string or number `id` whose string representation is at most 128 characters. Output buffers transfer to the
caller. Passing an input buffer in `postMessage`'s transfer list detaches it from the sender. Send a cancel request to
reuse the worker, or terminate it to stop all its work. Pass the cancel message instead of sending an `AbortSignal`
across the message boundary. The complete entry runs off the browser document thread; call it from a worker.

`installWorker()` installs this protocol in a worker that imports the module. For a module-worker bootstrap, pass
`{spawn: () => new Worker(import.meta.url, {type: 'module'})}` so helpers run the same bootstrap and build. The
published classic worker needs no configuration. It uses up to three helpers in addition to the calling worker,
subject to hardware concurrency. Ordinary lossless images use group workers from 40 initial 256-pixel groups;
the painting profile uses them from 32 groups. Effort 9 can also use helpers for independent candidates below
that threshold. Photographic RGBA8 uses helpers from 3 million pixels. Full-width bands end on 64-pixel boundaries,
preserving chroma-from-luma tiles and output bytes; the coordinator combines coefficients and writes one frame.
Set `options.parallel: false` on a complete encoder or worker encode request to disable all helper
workers for that request. The calling worker writes the same bytes; terminating it cancels the whole search.
Omitting the option retains automatic parallel work. Failed helpers fall back to the same local encoding.
`kernelMode()` reports the selected kernel mode after the first encode. Input arrays passed to `encode` remain unchanged.
