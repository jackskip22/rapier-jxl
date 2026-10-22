# JPEG XL format coverage

This inventory records what the encoder writes, not merely what an imported file parser accepts. **Yes** means a
writer exists; **Partial** names its actual subset; **No** means the current writer fixes or omits the relevant
field. Writer coverage and decoder qualification are separate: the compatibility notes below identify proved limits. Independent
decoder tests and measurements must accompany changes to this table.

Source references are relative to the encoder source directory. The scope is ISO/IEC 18181-1:2024 codestream and [18181-2:2026](https://www.iso.org/standard/91379.html) file format,
including the third edition's HDR gain-map box. Animation is listed for completeness.

## Reading the inventory

The still worker carries ordinary lossless/photo/JPEG encoding and five format actions: `photo`, `profile`,
`readSource`, `encodeSource` and `opsin`. The complete worker adds the optional authors below. The same imported
module graph builds each worker; public optional subpaths also have self-contained builds. Typed planar admission,
frame metadata, progression, entropy and reference composition each have one implementation.

Emitting a defined representation does not establish support in every decoder. The qualification table records
refused or incorrect native outputs, including changed-declaration controls that do not qualify the original file.
The remaining writer gaps are adaptive LF smoothing, Gaborish, broader filter/subsampling controls, explicit
animation timecodes and a complete independent level validator. Automatic choices also need measured quality
benefits; exposing syntax does not establish a useful default.

## Image, color and sample representation

| Capability | Writes today | Source and exact scope |
|---|---|---|
| Raw codestream and image dimensions | Yes | `frame.mjs`; raw streams or a level-10 container. |
| Grayscale and RGB pixels | Yes | `lossless.mjs`; grayscale is detected, RGB retained where needed. |
| Original-profile sample encoding | Yes | `icc.mjs`, `icc-profile.mjs`, `color-info.mjs`, `planar-input.mjs`: original RGB/gray or supported three-component ICC source spaces, including XYZ, Lab, Luv, YCbCr, Yxy, HSV, HLS and 3CLR. Profile/sample custody is exact; native managed Lab/XYZ rendering remains unqualified. |
| XYB photographic coding | Yes | `photo-xyb.mjs`; `vardct.mjs`. |
| YCbCr coefficient coding | Yes | `photo-dct.mjs`; `vardct.mjs`. |
| Integer sample precision | Yes | `channels.mjs` admits every integer depth 1–31 through planar input. The ordinary RGBA helpers retain 8/10/12/16-bit input. |
| Floating-point sample precision | Yes | `channels.mjs`: IEEE binary16/binary32 and raw words with 2–8 exponent bits and 2–23 mantissa bits, up to 32 bits total. |
| Lossless high-precision samples | Yes | `lossless.mjs`; sample words are preserved at quality 100. |
| High-precision lossy quantization | Yes | `lossless.mjs`; source-domain quantization, alpha exact. |
| sRGB, Display P3, BT.2100/Rec.2020 primaries | Yes | `frame.mjs`; `admit.mjs`. |
| Custom primary chromaticities | Yes | `color-info.mjs`; `/icc` and `/channels` accept explicit xy primaries. |
| D65 white point | Yes | `frame.mjs`; `color-info.mjs`. |
| DCI, equal-energy or custom white point | Yes | `color-info.mjs`; enumerated DCI/E or custom xy coordinates. |
| sRGB and linear transfer | Yes | `frame.mjs`; `admit.mjs`. |
| HDR PQ and HLG transfer | Yes | `frame.mjs`; `admit.mjs`. This signals sample meaning, not conversion from SDR. |
| BT.709, DCI and custom gamma transfer | Yes | `color-info.mjs`; named transfers or explicit gamma through `/icc` and `/channels`. |
| Rendering intent | Yes, with qualification limits | `color-info.mjs`, `source.mjs`: all four intents are written; PNG sRGB intent is retained. Complete decoding of no-ICC original XYB with relative, saturation or absolute intent is not proved by the selected decoder set. |
| Arbitrary embedded ICC profile | Yes | `icc-write.mjs`, `icc-profile.mjs`: allocation-bounded application input, complete ICC-declared extent and structural checks; level-5 admission remains 4 MiB. Explicit original XYB/unknown declarations are available through the typed interface with decoder limits below. CMYK uses a black plane and a matching ICC profile. |
| PNG ICC carry | Yes | `source.mjs`; original iCCP bytes, 16-bit samples and PNG color-declaration precedence are retained. `icc.mjs` consumes the resulting color metadata. |
| HDR intensity target | Yes | `frame.mjs`; `admit.mjs`. |
| HDR minimum luminance, relative display flag and linear-below tone mapping | Yes | `color-info.mjs`; `frame.mjs`; explicit tone-mapping fields describe the stored image, without converting SDR pixels into HDR. |
| Orientation, all eight Exif values | Yes | `format-fields.mjs`; `channels.mjs`; `framing.mjs`; `/channels`, `/layers`, advanced photo and JPEG metadata paths. |
| Intrinsic display size | Yes | `format-fields.mjs`; `channels.mjs`; independent display dimensions through `/channels` and `/layers`. |
| Custom inverse opsin matrix and quantization bias | Yes | `opsin.mjs`; all sixteen finite binary16 fields, partial edits, reset and retained resampling kernels. Coded frames and ICC remain exact. This authors the inverse transform; it does not refit the photographic forward transform. |
| Codestream extensions | No defined extension payload | `frame.mjs` writes no extension. Reserved syntax is not a supported image capability. |

## Modular coding and graphics

| Capability | Writes today | Source and exact scope |
|---|---|---|
| Lossless Modular pixels | Yes | `lossless.mjs`. |
| Automatic palette/RCT compression for compatible planar samples | Yes | `channel-lossless.mjs`, `planar-transforms.mjs`, `planar-planes.mjs`: exact integer/high-depth planar transforms, composed RCT/palette/Squeeze/progression, with one shared input and sample-word owner. Original floating words and mixed extra planes retain their declared meaning. |
| Bounded palette/graphics color reduction | Yes, optional encoder recipe | `graphics.mjs`, `graphics-quantize.mjs`: exact/screen/dither presets, explicit maximum RGB error 0–32, protected source mask and precise edge rule. Alpha and RGB below nonopaque alpha remain exact. Complete exact output remains the floor; automatic default quality policy is separate. |
| Lossy Modular/Squeeze | Yes | `lossy.mjs`; reconstructed residual quantization with exact alpha. |
| Reversible color transform | Yes | `rct-search.mjs` implements all 42; `modular.mjs` writes the selected type. |
| Global whole-color palette | Yes | `lossless.mjs`; `screen.mjs`. |
| Local and frequency-ordered palette | Yes | `palette-search.mjs`; `screen.mjs`. |
| Individual channel palette | Yes | `screen.mjs`. |
| Explicit delta palette | Yes, explicit choice | `delta-palette.mjs`; positive delta entries and predictor choice. libjxl and Chrome decode them; jxl-oxide 0.12.6 has a metadata-width/fast-path defect, so automatic selection excludes this representation. |
| Implicit palette cubes and implicit delta entries | Yes | `delta-palette.mjs`; exact implicit cubes/deltas. Automatic selection considers only independently compatible candidates and retains hidden RGB under alpha. |
| Squeeze transforms | Yes | `squeeze.mjs`; `modular.mjs`; `lossy.mjs`. |
| Lossless Squeeze as a general public option | Yes | `channels.mjs`, `planar-squeeze.mjs`, `squeeze.mjs`, `planar-transforms.mjs`: public default or authored Squeeze schedules, horizontal/vertical and in-place/out-of-place operations, through channels/layers and composed planar transforms. |
| Modular low-resolution-first section ordering | Yes | `lossy.mjs` places coarse/global and DC data before fine groups. |
| Progressive Modular resolution passes | Yes | `modular-progressive.mjs`, `planar-transforms.mjs`: quarter/half/full and custom admitted progression through channels/layers, exact final integer/IEEE words, real partial raw/`jxlp` decoding and early native incomplete-stream images. |
| All 14 specified pixel predictors | Yes | `modular.mjs`; learned search includes them at `sampled.mjs`. |
| Self-correcting weighted predictor | Yes | `weighted.mjs`; `sampled.mjs`. |
| Custom serialized weighted-predictor parameters | Yes | `weighted-custom.mjs`, `channels.mjs`, `planar-squeeze.mjs`: caller parameters are admitted and serialized through the existing Modular prediction/entropy owner; exact output is independently decoded. |
| MA trees, channel/stream selection and residual multiplier/offset | Yes | `modular.mjs`; `sampled.mjs`. |
| Global/shared and local Modular trees | Yes | `modular.mjs`; `screen.mjs`. |
| Modular group sizes 128/256/512/1024 | Yes | `channels.mjs`; explicit planar groups at all four dimensions. Existing graphics searches remain available. |

## VarDCT transforms

The following are the format's **27** strategy IDs, in the reference implementation's rows × columns convention.
Small transforms operate within an 8×8 strategy tile. There are no arbitrary rectangular powers-of-two beyond
the listed combinations. The optional `photo-advanced` entry writes all 27 strategies and mixed maps. Its
`transforms: 'auto'` planner considers 8×8 and 16×16; explicit names or arrays select other tilings, with
8×8 fallback at image/group boundaries. The ordinary photo and JPEG entry points retain their existing bytes.

| Strategy ID | Transform | Writes today | Source |
|---:|---|---|---|
| 0 | DCT 8×8 | Yes | `photo-dct.mjs`; optional generalized writer at `vardct-strategies.mjs`. |
| 1 | IDENTITY | Yes | `vardct-strategies.mjs`; IDs/geometry at `vardct-strategies.mjs`. |
| 2 | DCT 2×2 | Yes | `vardct-strategies.mjs`; IDs/geometry at `vardct-strategies.mjs`. |
| 3 | DCT 4×4 | Yes | `vardct-strategies.mjs`; IDs/geometry at `vardct-strategies.mjs`. |
| 4 | DCT 16×16 | Yes | `vardct-strategies.mjs`; IDs/geometry at `vardct-strategies.mjs`. |
| 5 | DCT 32×32 | Yes | `vardct-strategies.mjs`; IDs/geometry at `vardct-strategies.mjs`. |
| 6 | DCT 16×8 | Yes | `vardct-strategies.mjs`; IDs/geometry at `vardct-strategies.mjs`. |
| 7 | DCT 8×16 | Yes | `vardct-strategies.mjs`; IDs/geometry at `vardct-strategies.mjs`. |
| 8 | DCT 32×8 | Yes | `vardct-strategies.mjs`; IDs/geometry at `vardct-strategies.mjs`. |
| 9 | DCT 8×32 | Yes | `vardct-strategies.mjs`; IDs/geometry at `vardct-strategies.mjs`. |
| 10 | DCT 32×16 | Yes | `vardct-strategies.mjs`; IDs/geometry at `vardct-strategies.mjs`. |
| 11 | DCT 16×32 | Yes | `vardct-strategies.mjs`; IDs/geometry at `vardct-strategies.mjs`. |
| 12 | DCT 4×8 | Yes | `vardct-strategies.mjs`; IDs/geometry at `vardct-strategies.mjs`. |
| 13 | DCT 8×4 | Yes | `vardct-strategies.mjs`; IDs/geometry at `vardct-strategies.mjs`. |
| 14 | AFV0 | Yes | `vardct-strategies.mjs`; IDs/geometry at `vardct-strategies.mjs`. |
| 15 | AFV1 | Yes | `vardct-strategies.mjs`; IDs/geometry at `vardct-strategies.mjs`. |
| 16 | AFV2 | Yes | `vardct-strategies.mjs`; IDs/geometry at `vardct-strategies.mjs`. |
| 17 | AFV3 | Yes | `vardct-strategies.mjs`; IDs/geometry at `vardct-strategies.mjs`. |
| 18 | DCT 64×64 | Yes | `vardct-strategies.mjs`; IDs/geometry at `vardct-strategies.mjs`. |
| 19 | DCT 64×32 | Yes | `vardct-strategies.mjs`; IDs/geometry at `vardct-strategies.mjs`. |
| 20 | DCT 32×64 | Yes | `vardct-strategies.mjs`; IDs/geometry at `vardct-strategies.mjs`. |
| 21 | DCT 128×128 | Yes | `vardct-strategies.mjs`; IDs/geometry at `vardct-strategies.mjs`. |
| 22 | DCT 128×64 | Yes | `vardct-strategies.mjs`; IDs/geometry at `vardct-strategies.mjs`. |
| 23 | DCT 64×128 | Yes | `vardct-strategies.mjs`; IDs/geometry at `vardct-strategies.mjs`. |
| 24 | DCT 256×256 | Yes | `vardct-strategies.mjs`; IDs/geometry at `vardct-strategies.mjs`. |
| 25 | DCT 256×128 | Yes | `vardct-strategies.mjs`; IDs/geometry at `vardct-strategies.mjs`. |
| 26 | DCT 128×256 | Yes | `vardct-strategies.mjs`; IDs/geometry at `vardct-strategies.mjs`. |

| Other VarDCT capability | Writes today | Source and exact scope |
|---|---|---|
| Retained transforms and complete-file byte search | Yes, encoder API | `photo-plan.mjs`. Reuses fixed YCbCr layout/coefficients; highest tested fitting quality, with complete-file size and memory bounds. This is an encoding optimization, not an additional codestream feature. |
| Mixed-size transform map | Yes | `vardct-strategies.mjs`; `vardct.mjs`. Tiles remain within their 256-pixel AC group. Automatic selection considers 8×8/16×16; other strategies are explicit. |
| Custom raw DCT8 quantization matrices | Yes | `vardct.mjs` retains imported/generated tables; `vardct-strategies.mjs` admits public custom matrices. |
| Other custom quantization-table families | Yes | `vardct-strategies.mjs`; `vardct.mjs`. All 17 families accept Y/Cb/Cr raw matrices, with transposed strategies sharing a family. Positive steps are quantized to 1/16. |
| Parametric distance-band/IDENTITY/DCT2/DCT4/AFV table syntax | Yes | `quantization-params.mjs`; `quantization-defaults.mjs`; `vardct-strategies.mjs`. All standard modes 0–7: library, IDENTITY, DCT2, DCT4, DCT4×8, AFV, distance bands and raw. Parameters round to binary16 before coefficient planning. Pinned oxide discrepancies are listed below. |
| Custom LF quantization | Yes | `vardct.mjs`; public Y/Cb/Cr DC steps at `vardct-strategies.mjs`. |
| Per-block quantization fields | Partial | `vardct.mjs` accepts fields internally; the baseline photographic planner does not construct an adaptive field. |
| Chroma from luma | Yes | `photo-xyb.mjs`; `vardct.mjs`. Quality selection belongs to the photographic encoder. |
| Adaptive LF smoothing | No | `vardct.mjs` always sets skip-smoothing. |
| Custom coefficient ordering | Yes | `coefficient-orders.mjs`, `vardct.mjs`: all 13 order buckets used by the 27 strategies, three channel permutations with fixed LF prefixes, per-image or per-pass maps, and copied retained-plan inputs. Default order streams remain exact. |
| Block-context model | Yes | `vardct.mjs`, DC buckets and chroma/luma separation. |
| YCbCr component subsampling | Partial | `vardct.mjs`; factors one or two per axis, JPEG path. |

## Progression, features and compositing

| Capability | Writes today | Source and exact scope |
|---|---|---|
| LF-before-HF section ordering | Yes | `frame.mjs`; `vardct.mjs`. |
| Multiple HF passes and successive approximation | Yes | `vardct-progressive.mjs`; `vardct.mjs`. Presets plus 2–11 custom passes; signed coefficient contributions sum to the original final coefficients. |
| Downsampled HF-pass milestones | Yes | `vardct-progressive.mjs`. Spectral preset declares 1/4 and 1/2 milestones. Truncated first-pass decoding is proved on four sources in `public/bench/format-results.json`. |
| Recursive LF frames | Yes | `lf-frames.mjs`, `framing.mjs`, `photo-advanced.mjs`, `photo-extras.mjs`: levels 1–4, XYB/YCbCr, alpha and typed extra planes, grouped main frames, retained plans and spatial layouts. Frame-specific scale restrictions are admitted explicitly; native refusals remain below. |
| Dedicated preview frame | Yes | `format-fields.mjs`; `channels.mjs`; authored planar preview or a generated bounded thumbnail. `/layers` accepts an authored preview of the finished composition. |
| TOC permutation and saliency/ROI ordering | Yes | `delivery.mjs`; `toc-permutation.mjs`. Region-first/pass-first or explicit section permutation preserves every encoded section; the reader accepts the authored prefix representation. |
| Exact patches for repeated glyphs and graphics | Yes | `screen-patches.mjs`; full RGBA comparisons validate a bounded glyph atlas. |
| Arbitrary patch dictionary input / lossy residual patches | Yes | `patches.mjs`, `patch-composition.mjs`, `patch-code.mjs`: exact RGBA atlases and typed multi-source dictionaries in reference slots 0–3; supplied planar or encoded Modular/VarDCT stills, per-channel blend/alpha selection, and existing bounded-RGB base coding. |
| Shared animation atlas | Yes, optional encoder recipe | `animation-atlas.mjs`, `atlas-plan.mjs`: deterministic repeated glyph/tile discovery or supplied exact RGBA8 atlas in slot 3, alongside canvas slot 2 and ordinary dictionary slot 1. Auto keeps the complete ordinary animation unless the candidate is smaller; native depth/lossy inputs retain the ordinary route. |
| Patch blend modes | Yes | `patch-code.mjs`, `patch-composition.mjs`: all eight modes independently for color and extra planes, selected/associated alpha, clamping, four reference slots and non-byte-aligned source custody. The RGBA and atlas writers use the same dictionary contract. |
| Reference-only frame | Yes | `screen-patches.mjs`; `layers.mjs`; exact atlas and caller-authored references, before or after color conversion. |
| General four-slot reference-frame control | Yes | `layers.mjs`; independent source/save slots 0–3, with read-before-save validation. |
| Splines | Yes | `splines.mjs`; authored control points, XYB color and sigma DCT coefficients. Single-point splines are refused because pinned decoders disagree; automatic extraction from a raster is not implemented. |
| Noise synthesis and photon-noise LUT | Yes | `noise.mjs`; `vardct.mjs`; `photo-crop.mjs`. Explicit eight-point curve or full-frame photon model with ISO; 10-bit strengths. Complete 8-pixel coded tiles are cropped to the original canvas, preserving edge alpha. Noise synthesis does not estimate or remove source grain. |
| Source-grain estimation and bounded residual removal | Yes, bounded recipe | `photo-noise.mjs`; `noise-estimation.mjs`. Optional auto at quality 25–52 for eight-bit opaque-region sRGB analysis; clean/ineligible inputs retain ordinary bytes. Six matched-byte phone/film cases improve both measured perceptual metrics; broader-quality defaults remain unqualified. |
| Gaborish | No | `frame.mjs` fixes it off. |
| Edge-preserving filter | Partial | `frame.mjs`, one iteration with selected sigma; `photo-xyb.mjs`. |
| Color upsampling 2/4/8 | Yes | `photo-layout.mjs`, `photo-advanced.mjs`, `photo-plan.mjs`, `frame.mjs`, and the planar owner: caller-supplied reduced samples, shared coded/display geometry and retained target search. Both independent decoders pass; the strict Chrome partial-group alpha observation remains open. |
| Extra-channel upsampling | Yes | `planar-input.mjs`, `photo-extras.mjs`, `vardct-progressive.mjs`, `lf-frames.mjs`: metadata shifts 0–3 and frame factors 1/2/4/8; combined scale at most eight and at least the color factor. LF-referencing frames reject a factor they cannot signal. |
| Custom upsampling weights | Yes | `photo-layout.mjs`, `format-fields.mjs`: explicit 15/55/210 binary16 symmetric weights for 2x/4x/8x in planar and advanced/retained photo authoring; retained inputs are copied. |
| Exact graphic regions over a lossy photo | Yes, encoder API | `hybrid.mjs`. Explicit block-aligned RGBA crops or complete-file-priced automatic candidates; outside YCbCr coefficients remain unchanged. Standard still-layer syntax. |
| Arbitrary layers/composite stills | Yes | `layers.mjs`; one to 256 authored planar or encoded still frames with shared color/channel metadata and optional preview. |
| Frame blend modes | Yes | `layers.mjs`; `framing.mjs`; replace, add, blend, alpha-weighted add and multiply, independently for color and extra channels. |
| Signed frame origins and reversible crops | Yes | `layers.mjs`; `framing.mjs`; negative/positive origins and cropped layers retain their original encoded samples. |
| Skip-progressive frame | Yes | `layers.mjs`; `framing.mjs`; explicit frame type for a layer that does not become an intermediate progressive display. |
| Frame names | Yes | `layers.mjs`; `framing.mjs`; up to 1071 UTF-8 bytes. |
| Animation, tick rate, duration, looping and timecodes | Partial | `animation.mjs`, `animation-frames.mjs`, `framing.mjs`: exact derived ticks, durations and loops, changed-frame rectangles and shared reference atlases. Explicit timecodes remain unexposed. Allocation bounds output; frame/pixel/edge/timing admission remains. |

## Extra channels

| Capability | Writes today | Source and exact scope |
|---|---|---|
| Straight alpha | Yes | `frame.mjs`; `lossless.mjs`. |
| Associated/premultiplied alpha | Yes | `admit.mjs`; `frame.mjs`. |
| Multiple alpha channels | Yes | `format-fields.mjs`; `channels.mjs`; independent precision, association and sample planes. |
| Depth | Yes | `format-fields.mjs`; `channels.mjs`; named integer or floating-point planes. |
| Spot color with RGBA appearance | Yes | `format-fields.mjs`; `channels.mjs`; normalized RGB appearance and solidity accompany the plane. |
| Thermal | Yes | `format-fields.mjs`; `channels.mjs`; independent integer or floating-point precision. |
| Selection mask | Yes | `format-fields.mjs`; `channels.mjs`. |
| Black channel / CMYK | Yes, declaration-dependent native support | `planar-input.mjs`, `format-fields.mjs`, `photo-extras.mjs`: black planes and matching original CMYK profiles require level 10. A black plane alone does not establish native CMYK display; the recorded VarDCT black declarations are refused by Chrome. |
| CFA/Bayer channel | Yes | `format-fields.mjs`; `channels.mjs`; explicit CFA channel index. |
| Optional named or nonoptional unknown channels | Partial | `format-fields.mjs`; optional non-rendered channel type 16 is supported. Reserved/unknown nonoptional types are refused. |
| Per-extra-channel names | Yes | `channels.mjs`; `format-fields.mjs`; UTF-8 names up to 1071 bytes. |
| Per-extra-channel precision and reduced resolution | Yes | `channels.mjs`; independent integer/float precision, dimension shift and frame upsampling. |
| Typed extra channels beside VarDCT color | Yes | `photo-extras.mjs` shares planar input/planes and metadata owners. Up to 256 combined RGBA-alpha/authored planes, integer depth 1–31 and admitted floating raw-word layouts, grouped streams, progressive passes, LF levels and retained plans. Quality 100 delegates to the exact Channels writer with original words and metadata. |

## Entropy coding and file format

| Capability | Writes today | Source and exact scope |
|---|---|---|
| Prefix/Huffman coding | Yes | `prefix.mjs`; `modular.mjs`. |
| ANS coding | Yes | `ans.mjs`; `coefficient-ans.mjs`; `vardct.mjs`. |
| Hybrid integers and context-map clustering | Yes | `prefix.mjs`; `entropy.mjs`; `sampled.mjs`. |
| LZ77 repetition and 2D copies | Yes | `modular.mjs`; `screen-lz77.mjs`. |
| JPEG coefficients without generation loss | Yes | `jfif.mjs`; `vardct.mjs`. Input JPEG syntax has explicit admission limits. |
| Exact JPEG file reconstruction (`jbrd`) | Yes | `jpeg-reconstruction.mjs`; `container.mjs`; reconstruction stays exact with level-10 ICC containers and ordered fragments. |
| Signature, `ftyp`, complete codestream `jxlc` | Yes | `container.mjs`; `frame.mjs`. A required level box immediately follows the file-type box. |
| Partial codestream `jxlp` writing | Yes | `container-stream.mjs`: ordered complete-buffer and backpressured incremental writers; codestream bytes stay exact. |
| Automatic pass-aligned `jxlp` and metadata-last delivery | Yes | `progressive-container.mjs`; plans and complete boxes at preview, LF, pass and frame boundaries. Two native multi-group examples expose an incomplete picture before the rest arrives. This accepts already encoded input. |
| Out-of-order `jxlp` / file-format version 1 | Yes | `container-advanced.mjs`; complete fragment permutation, frame-start ordering barriers and default Chrome-compatible frame-end barriers. `reframeContainer` normalizes to ordered version 0 for oxide. |
| 64-bit box-size writing | Yes | `container.mjs`; `container-advanced.mjs`; header-only authoring and complete containers with extended headers. Arithmetic is checked through safe integers; a multi-gigabyte allocation is not claimed. |
| Unknown ancillary box preservation | Yes | `metadata.mjs`; `container-stream.mjs` carries untouched boxes verbatim. |
| Exif attach/replace/remove | Yes | `metadata.mjs`; TIFF bytes plus four-byte offset. |
| XMP/XML attach/replace/remove | Yes | `metadata.mjs`. |
| JUMBF writing | Yes | `metadata.mjs`: one or multiple JUMBF superbox payloads; replace/remove and owned-buffer readback. |
| `brob` compressed metadata writing | Yes | `metadata.mjs`, `brotli.mjs`: native-first compression/decompression with an injected codec or portable fallback, complete-payload size selection, and optional explicit expansion budgets. Portable decoding supports its authored subset; other compressed payloads can remain exact and opaque. |
| Animation keyframe index `jxli` | Yes | `container-advanced.mjs`; authored keyframe offsets, tick durations and displayed-frame counts; exact unsigned 63-bit integers. Keyframe independence is supplied by the author. |
| HDR gain-map `jhgm` (18181-2 third edition) | Yes, supplied gain maps | `container-advanced.mjs`; original ISO 21496-1 metadata, encoded gain image, alternate color encoding and ICC. Bundle parsing and both images are proved; deriving gain maps and browser HDR application are separate operations. |
| Level declaration `jxll` | Yes | `frame.mjs`; `container.mjs`; `channels.mjs`; `layers.mjs`; level 10 is selected when the emitted representation requires it. |
| Level 5 image limits | Partial | `channels.mjs`; `icc-write.mjs`; `patches.mjs`; `splines.mjs`; `layers.mjs`. Each new writer checks its applicable limits; no independent all-tools level validator is exposed. |
| Level 10 image limits | Partial | `channels.mjs`, `layers.mjs`, `admit.mjs`: pixel/edge admission remains below format maxima; allocation bounds file output. Explicit level 5 refuses representations requiring level 10. There is no exposed independent all-tools level validator. |
| Level precision/intermediate-buffer restriction | Yes for emitted paths | `frame.mjs`; `channels.mjs`; `layers.mjs`; `vardct.mjs`; LF-pyramid output declares level 10 when it clears the signed-16-bit buffer hint. |

## Format limits and verification

Level 5 permits a maximum dimension of 2^18, at most 2^28 pixels, four extra channels, and a 4 MiB ICC profile;
black/CMYK is not allowed. Level 10 permits a maximum dimension of 2^30, at most 2^40 pixels, 256 extra channels,
and a 256 MiB ICC profile. Precision, Modular intermediates, composite frames, animation and coding tools have
further constraints. Application pixel/edge limits are distinct from format maxima. File output grows to available allocation; there is no fixed 16 MiB output ceiling. Explicit caller byte budgets, safe-integer arithmetic and format bounds still apply. Allocation failure is reported as `JXL_MEMORY`. Raw codestreams
implicitly use level 5; a required level 10 declaration belongs in the container.

Every new feature requires: proof that the requested syntax is emitted; independent decoding by jxl-oxide and
libjxl `djxl` 0.12.0; Chrome 155 native decoding; exact lossless/JPEG reconstruction regressions; a named-corpus
size and encode-time observation; and a complete package-stage result. Metadata proof also extracts and compares
the original bytes. `jxlp` proof reconstructs the original codestream byte for byte. Progressive proof includes
partial-input behavior, not only final decoding. A skipped decoder is not a pass.

### Decoder qualification

The native fixtures pin Chrome 155.0.8059.39 and exercise its `ImageDecoder` and `createImageBitmap` implementations
without enabling a JPEG XL feature flag. They also compare browser-produced files with Node-produced files.
The independent command-line oracles are unmodified libjxl 0.12.0 and jxl-oxide 0.12.6. Planar precision tests inspect
raw Modular sample words through jxl-oxide's public Rust API, so signed zero and floating-point payload bits are
checked before display conversion.

| Representation | Qualification and practical limit |
|---|---|
| Compact IDENTITY/DCT2 and predefined 128×256 tables | Chrome and libjxl agree. Oxide 0.12.6 omits a factor of 64 in compact modes 1/2 and has two different predefined family-16 constants. Equivalent raw matrices remain interoperable; these modes are explicit choices. |
| Version-1 out-of-order fragments | libjxl reads every qualified layout. Oxide 0.12.6 requires ordered normalization. Chrome reads default-admitted layouts; explicitly allowing buffered frame ends retains a documented animation limitation. |
| HDR gain-map rendering | Both independent decoders retain the base and gain samples, and libjxl parses the bundle/ICC. Native base rendering is proved; application of the gain map to an HDR display is not claimed. |
| Explicit delta palette | libjxl and Chrome pass. jxl-oxide's palette metadata/fast path fails; `auto` excludes it. |
| Reduced extra-channel resolution | Both command-line decoders pass. Chrome applies metadata `dimShift` only when color upsampling exceeds one; frame upsampling alone and the combined color/extra-channel case are separately proved. |
| 256 extra channels | Both command-line decoders retain every plane. Full-Modular gray/color plus 256 extras and its ordinary no-patch control are refused by Chrome; four/five-extra controls accept. VarDCT RGB plus 256 extras, and RGBA plus 255 authored extras, pass all four tested native routes because color is outside the auxiliary Modular stream. |
| CMYK | A valid original CMYK profile plus the black plane passes. A bare black plane with an RGB declaration is not a native CMYK display path. |
| Preview on a wide main image | libjxl and Chrome pass. jxl-oxide 0.12.6 can use main-canvas group geometry for a small preview when the canvas exceeds 1024 pixels. |
| Floating-point display | Raw encoded words, including signed zero and NaN payloads, are exact. Decoder display conversion is a separate operation; the fixtures retain jxl-oxide's binary16 zero/display discrepancy. |
| Arithmetic alpha above one | `ImageDecoder` and `createImageBitmap` with `premultiplyAlpha: 'none'` agree. Default bitmap premultiplication can change color before clipping alpha; bounded-alpha controls pass all three routes. |
| Large splines/patches at explicit level 10 | Both command-line decoders pass legal level-10 examples. Chrome applies level-5 tool-area limits and refuses those examples; default level-5 admission remains bounded. |
| Photographic spatial alpha at partial group borders | Both independent decoders pass. Chrome intermittently returns incorrect border pixels on the same historically unchanged 517x521 file: two correct and ten incorrect bounded observations. The strict failure is retained; no tolerance change or encoder workaround is applied. |
| Photographic typed extra declarations | Both independent decoders and raw-word observations pass. The native suite has 39 browser/Node byte identities, 92 accepted routes and 64 refusals across 16 original files. Black-to-Optional and dimension-shift-to-frame-upsample controls preserve words/display pixels and accept; they are different declarations and do not qualify the refused files. |
| Original XYB/unknown declarations | Exact original ICC/source words are retained. Native original-enum refusals remain; no-ICC nonperceptual original XYB has no complete successful decode in the selected oracle set. Perceptual-ICC controls do not prove those rendering intents. |
| Preserved Lab/XYZ ICC sources | Profile and sample custody is exact. Native display does not match the tested color-managed reference, so complete managed rendering of every admitted ICC signature is not claimed. |

`public/test/channels.test.mjs`, `layers.test.mjs`, `patches.test.mjs`, `splines.test.mjs`, `delta-palette.test.mjs`,
`profile.test.mjs`, `profile-core.test.mjs`, `profile-source.test.mjs` and `jpeg-profile.test.mjs` retain the source
proofs. Their `native-*.test.mjs` companions preserve the native outcomes and expected decoder limitations.
The package stager compares every public minified entry with readable source and replays existing lossless/JPEG pins.

## Advanced photo proof and measurements

`public/test/photo-advanced.test.mjs` checks all 27 transforms with jxl-oxide 0.12.6 and libjxl `djxl` 0.12.0,
partial AC/LF-group borders, exact alpha, custom matrices and final-pixel equality across progressive passes.
`public/test/native-photo-advanced.test.mjs` checks 46 cases through Chrome 155's `createImageBitmap` and
`ImageDecoder`, and compares browser-encoded bytes to Node's bytes. Receipts are in
`public/bench/format-native.json`. `public/bench/format-default-bytes.json` records 24 unchanged baseline
photo/JPEG outputs, including eight exact independent JPEG reconstructions.

`public/bench/format.mjs` measures Grace Hopper, Control Paint 0001, Drawing Labels and the versioned synthetic
directional pattern, with input hashes in `public/bench/format-results.json`. Each of the 32 rows includes full-call
time (one warmup, three repeats, one CPU), size, SSIMULACRA2, Butteraugli and independent-decoder comparison.
These are fixed-quality observations, not matched-perceptual-quality claims. Mixed 8×8/16×16 saves bytes on the
photograph in this set but costs bytes on the graphics; it remains explicit. Progressive final pixels are unchanged,
with extra file overhead. A first spectral pass is independently decoded from an incomplete file for every source.

`public/test/photo-lf.test.mjs` checks every LF depth, one-pixel images, partial groups and a wide image whose LF
image itself spans groups. `public/bench/format-lf.mjs` adds 24 measured rows on Grace Hopper, UI Light, Drawing
Labels and the directional pattern in `public/bench/format-lf-results.json`. Every complete output is decoded by
both independent decoders. Every LF row also decodes an incomplete prefix through its main DC sections with
`djxl --allow_partial_files --downsampling=8`. A decoder renders that preview at the full canvas dimensions.
The first LF level matches the existing XYB route exactly on all four inputs; deeper levels differ by at most one
8-bit code value on this measured corpus. LF frames use XYB, so a source that ordinary routing sends through
YCbCr can have a different result even at the same quality setting. These LF measurements do not establish a
matched-perceptual-quality size improvement.

| Opaque corpus input | Ordinary bytes | One LF level, bytes | Four LF levels, bytes | First usable LF prefix, bytes | Prefix fraction of one-level file |
|---|---:|---:|---:|---:|---:|
| Grace Hopper | 56,539 | 66,941 | 74,594 | 19,508 | 29.14% |
| UI Light | 28,330 | 30,773 | 42,752 | 5,031 | 16.35% |
| Drawing Labels | 14,342 | 15,434 | 27,308 | 2,571 | 16.66% |
| Directional pattern v1 | 4,377 | 9,893 | 12,717 | 8,208 | 82.97% |

### Compact tables and combined LF proof

`public/bench/format-quantization-results.json` and `format-lf-combinations-results.json` each contain 41 named
cases, complete-call size/timing samples, input/output hashes and independent-decoder results. The native receipts
exercise both Chrome APIs for all 82 cases and compare browser/Node bytes. These syntax measurements are not
matched-perceptual-quality claims. Alpha stays exact with LF levels 1–4, custom transforms and compact tables.

The extended container receipts measure five recovered corpus inputs and 35 variants. Ordinary boxes total
528,111 B, wide boxes 528,191 B, ordered/version-1 fragments 534,287 B, indexes 528,211 B and supplied gain maps
with alternate color/ICC 532,081 B. All choices preserve the same 527,911 B of image codestreams. Timing measures
complete container work, including alternate ICC compression, and excludes preparing the encoded images.

### Source grain, inverse transforms and progressive delivery

`public/bench/noise-results.json` retains six matched-byte comparisons on the named Siemens C65 phone photo and
Ilford HP4 ISO1600 film scan. Both perceptual metrics improve in all six; nine clean controls keep exact bytes.
These are two older JPEG sources, not evidence for all phones, RAW files or ordinary quality-90 defaults. The
bounded recipe takes about twice the encoding time on those inputs. `noise-rejected-results.json` retains the
failed broader-quality candidate. Fourteen files pass both independent decoders and both native APIs.

The thirty-file Opsin Authored Mini corpus retains coded frames and profiles exactly, passes both command-line
decoders and 91 native decoded frames, and compares the arithmetic with an independent scalar model. Authored
transform edits change 8,305 B to 8,733 B; summed per-file median editing time is 1.328 ms. This is syntax and
arithmetic proof, not a compression-quality improvement.

Pass-aligned delivery has seventeen completed native files and ten exact independent partial-prefix comparisons.
Two native incremental witnesses show an incomplete picture at 3,118/4,876 B and 4,946/6,638 B, then exact final
pixels. Plain/compressed metadata footers can arrive after the complete image. Twenty complete-corpus rows measure
24–36 B of added alignment overhead and 0.097–0.214 ms wrapping time; metadata compression is timed separately.
Dedicated-preview and small single-group early rendering are not claimed.

### Retained plans, exact overlays and offline integration

The planar auto repair preserves complete image headers, metadata and sample words while competing with the
existing palette/RCT encoder. Complete Corpus v1 Grace Hopper changes from 932,062 to 297,029 B, Light interface
from 1,035,039 to 26,594 B, and Drawing labels from 662,565 to 6,065 B. Median full-call times are 85.461,
53.213 and 37.494 ms, versus 63.773, 56.021 and 36.650 ms before. The 31-case source/native proof includes ten
byte-identical forced-option/fallback controls. All 36 layered-corpus rows retain their original sample proof.

The [hybrid study](../../bench/HYBRID.md) records 30 rows and 15 native fixtures. An authored 512×96 text banner
over Grace Hopper writes 39,325 B versus the 41,626 B YCbCr control (5.53% smaller), preserving 147,456 selected
RGB samples exactly and leaving outside samples unchanged. Automatic selection writes 39,488 B but costs
189.614 ms versus the control's 49.118 ms. Four ordinary corpus inputs retain their original photo bytes in auto;
Drawing labels chooses an exact 6,063 B file. These are fixed-quality, representation-specific observations.

The [retained-plan study](../../bench/PHOTO-PLAN.md) covers all 27 transforms and 39 complete fixture files,
with both independent decoders, 78 native decodes and browser/Node byte identity. On five Complete Corpus v1
sources with DCT8 and DCT16, fresh plan plus target search is 1.48–1.71× faster than rebuilding the same tested
candidates. Complete-file budgets are met; a global highest-quality fit is not claimed.

TOC region delivery has 13 native files, exact independent reconstruction, and a selected-region incremental
witness at 3,206/4,365 B. Fifteen named corpus rows add 10–14 B and take 0.071–0.264 ms to reorder. The portable
Brotli Metadata Mini corpus reduces the complete three-field container from 20,315 to 2,076 B in 0.546 ms.
Node and the system libbrotli independently read its 14 codec cases; both use the libbrotli implementation
family. Stock djxl also extracts the original Exif/XMP/JUMBF exactly. Browser fallback requires no Brotli API.

The still and complete workers derive from their named roots in one build list. The still worker supports the five
still actions above and explicitly refuses complete-only actions/options. The complete worker also carries the
remaining format authors, including typed patches, bounded graphics and shared atlases. Actual worker checks
compare source results and refusals, metadata roundtrips, cancellation, busy behavior, ownership and recovery
offline. These checks are separate from native decoder acceptance of each authored representation.

## Primary references

- [libjxl 0.12.0 format overview](https://github.com/libjxl/libjxl/blob/v0.12.0/doc/format_overview.md)
- [Transform IDs and geometry](https://github.com/libjxl/libjxl/blob/v0.12.0/lib/jxl/ac_strategy.h)
- [Frame, progression and blend syntax](https://github.com/libjxl/libjxl/blob/v0.12.0/lib/jxl/frame_header.cc)
- [Image metadata and extra channels](https://github.com/libjxl/libjxl/blob/v0.12.0/lib/jxl/image_metadata.cc)
- [Quantization-table families](https://github.com/libjxl/libjxl/blob/v0.12.0/lib/jxl/quant_weights.h)
- [Container writing and level checks](https://github.com/libjxl/libjxl/blob/v0.12.0/lib/jxl/encode.cc)
- [Codec authors' technical companion to ISO/IEC 18181](https://arxiv.org/html/2506.05987v1)

These references explain the inventory; the applicable edition of ISO/IEC 18181 remains normative.

## Extended authoring checks

`public/test/channel-modular.test.mjs`, `channel-progressive.test.mjs`, `planar-transforms.test.mjs`,
`color-spaces.test.mjs`, `coefficient-orders.test.mjs`, `photo-scale.test.mjs`, `photo-extras.test.mjs`,
`patch-composition.test.mjs`, `atlas.test.mjs` and `graphics.test.mjs` exercise the shared writer owners.
Their native companions retain both successful decodes and the explicit boundaries above. Package minification
replays the same factories. `native-still-format.test.mjs` and `native-format-worker.test.mjs` exercise the actual
classic workers; `worker-format-replies.test.mjs` checks full/offset/short/Buffer/shared reply custody.
