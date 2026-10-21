# JPEG XL format coverage

This inventory records what the encoder writes, not merely what an imported file parser accepts. **Yes** means a
writer exists; **Partial** names its actual subset; **No** means the current writer fixes or omits the relevant
field. Writer coverage and decoder qualification are separate: the compatibility notes below identify proved limits. Independent
decoder tests and measurements must accompany changes to this table.

The baseline is commit `4431d0ecd`; qualified additions are identified below. Source references are relative to `images/jxl/`;
line numbers identify the audited implementation; qualified additions update the affected rows below. The scope is ISO/IEC 18181-1:2024 codestream and [18181-2:2026](https://www.iso.org/standard/91379.html) file format,
including the third edition's HDR gain-map box. Animation is listed for completeness.

## What to build first

| Priority | Gap | What a person gains |
|---|---|---|
| 1 | Variable VarDCT transforms and useful custom quantization | Smaller smooth photographs while retaining detailed edges. |
| 2 | Progressive HF passes, LF/preview frames and ordered `jxlp` output | A useful picture appears before its complete file arrives. Container fragmentation alone is not image progression. |
| 3 | Generalized exact patches and delta palettes | Repeated lettering and graphics stay exact with fewer bytes. Existing glyph patches already provide part of this. |
| 4 | ICC carry, JUMBF and compressed metadata | Source color meaning, attribution and other metadata survive conversion. |
| 5 | Noise synthesis and upsampling | More useful choices for photographic texture and low bit rates. |
| 6 | Layers, reference control and typed extra channels | Authoring, print, depth and scientific images retain their structure. |
| 7 | Splines, full transform/entropy controls and complete level validation | Specialized images and advanced callers can use the rest of the format precisely. |

Lossy Modular/Squeeze, pixel precision, HDR transfer signaling, exact glyph patches, palette coding, ANS and
JPEG reconstruction already exist. Their remaining subsets must be filled without replacing working routes.

## Image, color and sample representation

| Capability | Writes today | Source and exact scope |
|---|---|---|
| Raw codestream and image dimensions | Yes | `frame.mjs:14–19,159–177`; raw streams or a level-10 container. |
| Grayscale and RGB pixels | Yes | `lossless.mjs:21–47`; grayscale is detected, RGB retained where needed. |
| Original-profile sample encoding | Yes | `icc.mjs:19–51`; `admit.mjs:69`; arbitrary RGB/GRAY ICC or an explicit color encoding, with unchanged sample meaning. |
| XYB photographic coding | Yes | `photo-xyb.mjs:50–105`; `vardct.mjs:142–155`. |
| YCbCr coefficient coding | Yes | `photo-dct.mjs:70–106`; `vardct.mjs:151–167`. |
| Integer sample precision | Yes | `channels.mjs:18–40` admits every integer depth 1–31 through planar input. The ordinary RGBA helpers retain 8/10/12/16-bit input. |
| Floating-point sample precision | Yes | `channels.mjs:18–40`: IEEE binary16/binary32 and raw words with 2–8 exponent bits and 2–23 mantissa bits, up to 32 bits total. |
| Lossless high-precision samples | Yes | `lossless.mjs:237–290`; sample words are preserved at quality 100. |
| High-precision lossy quantization | Yes | `lossless.mjs:239–248,275–290`; source-domain quantization, alpha exact. |
| sRGB, Display P3, BT.2100/Rec.2020 primaries | Yes | `frame.mjs:36–48`; `admit.mjs:40–43`. |
| Custom primary chromaticities | Yes | `color-info.mjs:42–88`; `/icc` and `/channels` accept explicit xy primaries. |
| D65 white point | Yes | `frame.mjs:41,54`; `color-info.mjs:42–88`. |
| DCI, equal-energy or custom white point | Yes | `color-info.mjs:42–88`; enumerated DCI/E or custom xy coordinates. |
| sRGB and linear transfer | Yes | `frame.mjs:36–43`; `admit.mjs:42–43`. |
| HDR PQ and HLG transfer | Yes | `frame.mjs:42`; `admit.mjs:42–46`. This signals sample meaning, not conversion from SDR. |
| BT.709, DCI and custom gamma transfer | Yes | `color-info.mjs:42–88`; named transfers or explicit gamma through `/icc` and `/channels`. |
| Rendering intent | Yes | `color-info.mjs:42–88`; all four intents. PNG sRGB intent is retained at `source.mjs:90–106`. |
| Arbitrary embedded ICC profile | Yes | `icc-write.mjs:105`; `icc-profile.mjs`; up to the application limit of 16 MiB, with level-5 admission at 4 MiB. Common `encode()` and JPEG transcode carry profiles. CMYK uses a black extra channel through `/channels`. |
| PNG ICC carry | Yes | `source.mjs:90–106`; original iCCP bytes, 16-bit samples and PNG color-declaration precedence are retained. `icc.mjs:19–51` consumes the resulting color metadata. |
| HDR intensity target | Yes | `frame.mjs:54–58`; `admit.mjs:44–46`. |
| HDR minimum luminance, relative display flag and linear-below tone mapping | Yes | `color-info.mjs:90`; `frame.mjs:56–64`; explicit tone-mapping fields describe the stored image, without converting SDR pixels into HDR. |
| Orientation, all eight Exif values | Yes | `format-fields.mjs:15–35`; `channels.mjs:102`; `framing.mjs:307`; `/channels`, `/layers`, advanced photo and JPEG metadata paths. |
| Intrinsic display size | Yes | `format-fields.mjs:15–35`; `channels.mjs:102`; independent display dimensions through `/channels` and `/layers`. |
| Custom inverse opsin matrix and quantization bias | Yes | `opsin.mjs:42–59,69–119`; all sixteen finite binary16 fields, partial edits, reset and retained resampling kernels. Coded frames and ICC remain exact. This authors the inverse transform; it does not refit the photographic forward transform. |
| Codestream extensions | No defined extension payload | `frame.mjs:66` writes no extension. Reserved syntax is not a supported image capability. |

## Modular coding and graphics

| Capability | Writes today | Source and exact scope |
|---|---|---|
| Lossless Modular pixels | Yes | `lossless.mjs:187–234`. |
| Automatic palette/RCT compression for compatible planar samples | Yes | `channel-lossless.mjs:6–48`; `channels.mjs:184–202`. Whole frames compete while original metadata and sample words stay exact. Forced options and other precisions/types retain their declared path. |
| Lossy Modular/Squeeze | Yes | `lossy.mjs:43–75`; reconstructed residual quantization with exact alpha. |
| Reversible color transform | Yes | `rct-search.mjs:8–26` implements all 42; `modular.mjs:54` writes the selected type. |
| Global whole-color palette | Yes | `lossless.mjs:33–45,187–193`; `screen.mjs:76–100`. |
| Local and frequency-ordered palette | Yes | `palette-search.mjs:15–43`; `screen.mjs:76–100`. |
| Individual channel palette | Yes | `screen.mjs:102–120`. |
| Explicit delta palette | Yes, explicit choice | `delta-palette.mjs:73–125,177–223`; positive delta entries and predictor choice. libjxl and Chrome decode them; jxl-oxide 0.12.6 has a metadata-width/fast-path defect, so automatic selection excludes this representation. |
| Implicit palette cubes and implicit delta entries | Yes | `delta-palette.mjs:13–64,196–223`; exact implicit cubes/deltas. Automatic selection considers only independently compatible candidates and retains hidden RGB under alpha. |
| Squeeze transforms | Yes | `squeeze.mjs`; `modular.mjs:62–69`; `lossy.mjs:60–70`. |
| Lossless Squeeze as a general public option | No | `lossy.mjs:47–48` requires positive distance; default lossless plans at `lossless.mjs:187–189` use palette or RCT only. |
| Modular low-resolution-first section ordering | Yes | `lossy.mjs:72–75` places coarse/global and DC data before fine groups. |
| All 14 specified pixel predictors | Yes | `modular.mjs:12–13`; learned search includes them at `sampled.mjs:19–22`. |
| Self-correcting weighted predictor | Yes | `weighted.mjs`; `sampled.mjs:21–22`. |
| Custom serialized weighted-predictor parameters | No | `modular.mjs:75` fixes the default weighted header. |
| MA trees, channel/stream selection and residual multiplier/offset | Yes | `modular.mjs:20–45,82`; `sampled.mjs:19–29`. |
| Global/shared and local Modular trees | Yes | `modular.mjs:73–76`; `screen.mjs:245–250,292–308`. |
| Modular group sizes 128/256/512/1024 | Yes | `channels.mjs:75–78,147–181`; explicit planar groups at all four dimensions. Existing graphics searches remain available. |

## VarDCT transforms

The following are the format's **27** strategy IDs, in the reference implementation's rows × columns convention.
Small transforms operate within an 8×8 strategy tile. There are no arbitrary rectangular powers-of-two beyond
the listed combinations. The optional `photo-advanced` entry writes all 27 strategies and mixed maps. Its
`transforms: 'auto'` planner considers 8×8 and 16×16; explicit names or arrays select other tilings, with
8×8 fallback at image/group boundaries. The ordinary photo and JPEG entry points retain their existing bytes.

| Strategy ID | Transform | Writes today | Source |
|---:|---|---|---|
| 0 | DCT 8×8 | Yes | `photo-dct.mjs:47–60`; optional generalized writer at `vardct-strategies.mjs:47–59,230–326`. |
| 1 | IDENTITY | Yes | `vardct-strategies.mjs:77–112,230–326`; IDs/geometry at `vardct-strategies.mjs:9–16`. |
| 2 | DCT 2×2 | Yes | `vardct-strategies.mjs:77–112,230–326`; IDs/geometry at `vardct-strategies.mjs:9–16`. |
| 3 | DCT 4×4 | Yes | `vardct-strategies.mjs:77–112,230–326`; IDs/geometry at `vardct-strategies.mjs:9–16`. |
| 4 | DCT 16×16 | Yes | `vardct-strategies.mjs:47–59,230–326`; IDs/geometry at `vardct-strategies.mjs:9–16`. |
| 5 | DCT 32×32 | Yes | `vardct-strategies.mjs:47–59,230–326`; IDs/geometry at `vardct-strategies.mjs:9–16`. |
| 6 | DCT 16×8 | Yes | `vardct-strategies.mjs:47–59,230–326`; IDs/geometry at `vardct-strategies.mjs:9–16`. |
| 7 | DCT 8×16 | Yes | `vardct-strategies.mjs:47–59,230–326`; IDs/geometry at `vardct-strategies.mjs:9–16`. |
| 8 | DCT 32×8 | Yes | `vardct-strategies.mjs:47–59,230–326`; IDs/geometry at `vardct-strategies.mjs:9–16`. |
| 9 | DCT 8×32 | Yes | `vardct-strategies.mjs:47–59,230–326`; IDs/geometry at `vardct-strategies.mjs:9–16`. |
| 10 | DCT 32×16 | Yes | `vardct-strategies.mjs:47–59,230–326`; IDs/geometry at `vardct-strategies.mjs:9–16`. |
| 11 | DCT 16×32 | Yes | `vardct-strategies.mjs:47–59,230–326`; IDs/geometry at `vardct-strategies.mjs:9–16`. |
| 12 | DCT 4×8 | Yes | `vardct-strategies.mjs:113–119,230–326`; IDs/geometry at `vardct-strategies.mjs:9–16`. |
| 13 | DCT 8×4 | Yes | `vardct-strategies.mjs:113–119,230–326`; IDs/geometry at `vardct-strategies.mjs:9–16`. |
| 14 | AFV0 | Yes | `vardct-strategies.mjs:120–133,230–326`; IDs/geometry at `vardct-strategies.mjs:9–16`. |
| 15 | AFV1 | Yes | `vardct-strategies.mjs:120–133,230–326`; IDs/geometry at `vardct-strategies.mjs:9–16`. |
| 16 | AFV2 | Yes | `vardct-strategies.mjs:120–133,230–326`; IDs/geometry at `vardct-strategies.mjs:9–16`. |
| 17 | AFV3 | Yes | `vardct-strategies.mjs:120–133,230–326`; IDs/geometry at `vardct-strategies.mjs:9–16`. |
| 18 | DCT 64×64 | Yes | `vardct-strategies.mjs:47–59,230–326`; IDs/geometry at `vardct-strategies.mjs:9–16`. |
| 19 | DCT 64×32 | Yes | `vardct-strategies.mjs:47–59,230–326`; IDs/geometry at `vardct-strategies.mjs:9–16`. |
| 20 | DCT 32×64 | Yes | `vardct-strategies.mjs:47–59,230–326`; IDs/geometry at `vardct-strategies.mjs:9–16`. |
| 21 | DCT 128×128 | Yes | `vardct-strategies.mjs:47–59,230–326`; IDs/geometry at `vardct-strategies.mjs:9–16`. |
| 22 | DCT 128×64 | Yes | `vardct-strategies.mjs:47–59,230–326`; IDs/geometry at `vardct-strategies.mjs:9–16`. |
| 23 | DCT 64×128 | Yes | `vardct-strategies.mjs:47–59,230–326`; IDs/geometry at `vardct-strategies.mjs:9–16`. |
| 24 | DCT 256×256 | Yes | `vardct-strategies.mjs:47–59,230–326`; IDs/geometry at `vardct-strategies.mjs:9–16`. |
| 25 | DCT 256×128 | Yes | `vardct-strategies.mjs:47–59,230–326`; IDs/geometry at `vardct-strategies.mjs:9–16`. |
| 26 | DCT 128×256 | Yes | `vardct-strategies.mjs:47–59,230–326`; IDs/geometry at `vardct-strategies.mjs:9–16`. |

| Other VarDCT capability | Writes today | Source and exact scope |
|---|---|---|
| Retained transforms and complete-file byte search | Yes, encoder API | `photo-plan.mjs:55–238`. Reuses fixed YCbCr layout/coefficients; highest tested fitting quality, with complete-file size and memory bounds. This is an encoding optimization, not an additional codestream feature. |
| Mixed-size transform map | Yes | `vardct-strategies.mjs:290–318`; `vardct.mjs:339–367`. Tiles remain within their 256-pixel AC group. Automatic selection considers 8×8/16×16; other strategies are explicit. |
| Custom raw DCT8 quantization matrices | Yes | `vardct.mjs:376–399` retains imported/generated tables; `vardct-strategies.mjs:187–218` admits public custom matrices. |
| Other custom quantization-table families | Yes | `vardct-strategies.mjs:187–218,240–243`; `vardct.mjs:376–399`. All 17 families accept Y/Cb/Cr raw matrices, with transposed strategies sharing a family. Positive steps are quantized to 1/16. |
| Parametric distance-band/IDENTITY/DCT2/DCT4/AFV table syntax | Yes | `quantization-params.mjs:14–182`; `quantization-defaults.mjs:4–24`; `vardct-strategies.mjs:187–218,240–243`. All standard modes 0–7: library, IDENTITY, DCT2, DCT4, DCT4×8, AFV, distance bands and raw. Parameters round to binary16 before coefficient planning. Pinned oxide discrepancies are listed below. |
| Custom LF quantization | Yes | `vardct.mjs:295–300`; public Y/Cb/Cr DC steps at `vardct-strategies.mjs:192–198,226`. |
| Per-block quantization fields | Partial | `vardct.mjs:309–314` accepts fields internally; the baseline photographic planner does not construct an adaptive field. |
| Chroma from luma | Yes | `photo-xyb.mjs:59–94`; `vardct.mjs:316–320`. Quality selection belongs to the photographic encoder. |
| Adaptive LF smoothing | No | `vardct.mjs:442` always sets skip-smoothing. |
| Custom coefficient ordering | Yes | `vardct.mjs:402–420`, DCT8 only. |
| Block-context model | Yes | `vardct.mjs:29–64,182–268`, DC buckets and chroma/luma separation. |
| YCbCr component subsampling | Partial | `vardct.mjs:156–167,445`; factors one or two per axis, JPEG path. |

## Progression, features and compositing

| Capability | Writes today | Source and exact scope |
|---|---|---|
| LF-before-HF section ordering | Yes | `frame.mjs:147–166`; `vardct.mjs:249–376`. |
| Multiple HF passes and successive approximation | Yes | `vardct-progressive.mjs:7–54`; `vardct.mjs:249–268,401–433`. Presets plus 2–11 custom passes; signed coefficient contributions sum to the original final coefficients. |
| Downsampled HF-pass milestones | Yes | `vardct-progressive.mjs:29–39`. Spectral preset declares 1/4 and 1/2 milestones. Truncated first-pass decoding is proved on four sources in `public/bench/format-results.json`. |
| Recursive LF frames | Yes, XYB/YCbCr and alpha | `lf-frames.mjs:14–17,29–142`; `framing.mjs:367–386`; `photo-advanced.mjs:31–59`. One through four successive 1/8 levels; exact final alpha; explicit transforms and raw/compact tables combine with HF progression and noise. Normal XYB DC units use a Modular deepest frame; YCbCr or subnormal units use fine VarDCT. Declares level 10. |
| Dedicated preview frame | Yes | `format-fields.mjs:15–35`; `channels.mjs:204–233`; authored planar preview or a generated bounded thumbnail. `/layers` accepts an authored preview of the finished composition. |
| TOC permutation and saliency/ROI ordering | Yes | `delivery.mjs:70–175`; `toc-permutation.mjs`. Region-first/pass-first or explicit section permutation preserves every encoded section; the reader accepts the authored prefix representation. |
| Exact patches for repeated glyphs and graphics | Yes | `screen-patches.mjs:13–134,169–198,207–257`; full RGBA comparisons validate a bounded glyph atlas. |
| Arbitrary patch dictionary input / lossy residual patches | Yes | `patches.mjs:34–83,157–186`; an exact authored RGBA atlas, repeated placements and optional bounded RGB quantization of the base. Atlas pixels, alpha and hidden RGB stay exact. |
| Patch blend modes | Yes | `patches.mjs:14,86–111`; all eight modes: none, replace, add, multiply, over/under and alpha-weighted add above/below. |
| Reference-only frame | Yes | `screen-patches.mjs:137–166`; `layers.mjs:42–75,115–126`; exact atlas and caller-authored references, before or after color conversion. |
| General four-slot reference-frame control | Yes | `layers.mjs:20–29,78–130`; independent source/save slots 0–3, with read-before-save validation. |
| Splines | Yes | `splines.mjs:46–60,62–150`; authored control points, XYB color and sigma DCT coefficients. Single-point splines are refused because pinned decoders disagree; automatic extraction from a raster is not implemented. |
| Noise synthesis and photon-noise LUT | Yes | `noise.mjs:16–40`; `vardct.mjs:285,442`; `photo-crop.mjs:8–28`. Explicit eight-point curve or full-frame photon model with ISO; 10-bit strengths. Complete 8-pixel coded tiles are cropped to the original canvas, preserving edge alpha. Noise synthesis does not estimate or remove source grain. |
| Source-grain estimation and bounded residual removal | Yes, bounded recipe | `photo-noise.mjs:11–37`; `noise-estimation.mjs:89–151`. Optional auto at quality 25–52 for eight-bit opaque-region sRGB analysis; clean/ineligible inputs retain ordinary bytes. Six matched-byte phone/film cases improve both measured perceptual metrics; broader-quality defaults remain unqualified. |
| Gaborish | No | `frame.mjs:89–92` fixes it off. |
| Edge-preserving filter | Partial | `frame.mjs:87–96`, one iteration with selected sigma; `photo-xyb.mjs:102–105`. |
| Color upsampling 2/4/8 | Yes | `channels.mjs:49–51`; `frame.mjs:82–89`; lower-resolution planar color with declared reconstruction scale. |
| Extra-channel upsampling | Yes | `channels.mjs:57–73`; independent frame upsampling and metadata dimension shift, with combined scale at most eight. |
| Custom upsampling weights | Yes | `format-fields.mjs:66–81`; `channels.mjs:87`; 15/55/210 F16 weights for 2×/4×/8× reconstruction. |
| Exact graphic regions over a lossy photo | Yes, encoder API | `hybrid.mjs:18–177`. Explicit block-aligned RGBA crops or complete-file-priced automatic candidates; outside YCbCr coefficients remain unchanged. Standard still-layer syntax. |
| Arbitrary layers/composite stills | Yes | `layers.mjs:42–136`; one to 256 authored planar or encoded still frames with shared color/channel metadata and optional preview. |
| Frame blend modes | Yes | `layers.mjs:11–29`; `framing.mjs:317–365`; replace, add, blend, alpha-weighted add and multiply, independently for color and extra channels. |
| Signed frame origins and reversible crops | Yes | `layers.mjs:53`; `framing.mjs:317–365`; negative/positive origins and cropped layers retain their original encoded samples. |
| Skip-progressive frame | Yes | `layers.mjs:54–57`; `framing.mjs:317–365`; explicit frame type for a layer that does not become an intermediate progressive display. |
| Frame names | Yes | `layers.mjs:59–60`; `framing.mjs:317–365`; up to 1071 UTF-8 bytes. |
| Animation, tick rate, duration, looping and timecodes | Partial, separate owner | `animation.mjs:9–28`; `animation-frames.mjs:24–140`; frame differencing, exact derived tick durations and loops. `framing.mjs:387–450` writes animation headers; explicit timecodes are not exposed. |

## Extra channels

| Capability | Writes today | Source and exact scope |
|---|---|---|
| Straight alpha | Yes | `frame.mjs:26–32`; `lossless.mjs:21–47`. |
| Associated/premultiplied alpha | Yes | `admit.mjs:47–54`; `frame.mjs:28–32`. |
| Multiple alpha channels | Yes | `format-fields.mjs:48–64`; `channels.mjs:57–74`; independent precision, association and sample planes. |
| Depth | Yes | `format-fields.mjs:8,48–64`; `channels.mjs:57–74`; named integer or floating-point planes. |
| Spot color with RGBA appearance | Yes | `format-fields.mjs:48–64`; `channels.mjs:65–68`; normalized RGB appearance and solidity accompany the plane. |
| Thermal | Yes | `format-fields.mjs:8,48–64`; `channels.mjs:57–74`; independent integer or floating-point precision. |
| Selection mask | Yes | `format-fields.mjs:8,48–64`; `channels.mjs:57–74`. |
| Black channel / CMYK | Yes | `channels.mjs:79–95`; a black extra plane plus a valid CMYK ICC profile requires level 10. Chrome needs the CMYK profile to interpret the four components. |
| CFA/Bayer channel | Yes | `format-fields.mjs:48–64`; `channels.mjs:69`; explicit CFA channel index. |
| Optional named or nonoptional unknown channels | Partial | `format-fields.mjs:8,43–64`; optional non-rendered channel type 16 is supported. Reserved/unknown nonoptional types are refused. |
| Per-extra-channel names | Yes | `channels.mjs:63–64`; `format-fields.mjs:48–64`; UTF-8 names up to 1071 bytes. |
| Per-extra-channel precision and reduced resolution | Yes | `channels.mjs:18–40,57–74`; independent integer/float precision, dimension shift and frame upsampling. |

## Entropy coding and file format

| Capability | Writes today | Source and exact scope |
|---|---|---|
| Prefix/Huffman coding | Yes | `prefix.mjs`; `modular.mjs:86–101`. |
| ANS coding | Yes | `ans.mjs`; `coefficient-ans.mjs`; `vardct.mjs:114–124`. |
| Hybrid integers and context-map clustering | Yes | `prefix.mjs`; `entropy.mjs`; `sampled.mjs:19–29`. |
| LZ77 repetition and 2D copies | Yes | `modular.mjs:15–18,104–156`; `screen-lz77.mjs`. |
| JPEG coefficients without generation loss | Yes | `jfif.mjs`; `vardct.mjs:130–134`. Input JPEG syntax has explicit admission limits. |
| Exact JPEG file reconstruction (`jbrd`) | Yes | `jpeg-reconstruction.mjs`; `container.mjs:79–123`; reconstruction stays exact with level-10 ICC containers and ordered fragments. |
| Signature, `ftyp`, complete codestream `jxlc` | Yes | `container.mjs:5–28,79–102`; `frame.mjs:159–177`. A required level box immediately follows the file-type box. |
| Partial codestream `jxlp` writing | Yes | `container-stream.mjs:35–112`: ordered complete-buffer and backpressured incremental writers; codestream bytes stay exact. |
| Automatic pass-aligned `jxlp` and metadata-last delivery | Yes | `progressive-container.mjs:40–153`; plans and complete boxes at preview, LF, pass and frame boundaries. Two native multi-group examples expose an incomplete picture before the rest arrives. This accepts already encoded input. |
| Out-of-order `jxlp` / file-format version 1 | Yes | `container-advanced.mjs:45,113,151`; complete fragment permutation, frame-start ordering barriers and default Chrome-compatible frame-end barriers. `reframeContainer` normalizes to ordered version 0 for oxide. |
| 64-bit box-size writing | Yes | `container.mjs:12–20`; `container-advanced.mjs:40,151`; header-only authoring and complete containers with extended headers. Arithmetic is checked through safe integers; a multi-gigabyte allocation is not claimed. |
| Unknown ancillary box preservation | Yes | `metadata.mjs:58–83`; `container-stream.mjs:58–69` carries untouched boxes verbatim. |
| Exif attach/replace/remove | Yes | `metadata.mjs:32–55,86`; TIFF bytes plus four-byte offset. |
| XMP/XML attach/replace/remove | Yes | `metadata.mjs:32–55,86`. |
| JUMBF writing | Yes | `metadata.mjs:45–55,86`: one or multiple JUMBF superbox payloads; replace/remove and owned-buffer readback. |
| `brob` compressed metadata writing | Yes | `metadata.mjs:116–198`; `brotli.mjs:106–135,204–248`. Native or portable compression, injected codecs, complete-payload size selection and bounded expansion. The portable reader supports its authored subset; other compressed payloads remain exact without expansion. |
| Animation keyframe index `jxli` | Yes | `container-advanced.mjs:187,205,250,256`; authored keyframe offsets, tick durations and displayed-frame counts; exact unsigned 63-bit integers. Keyframe independence is supplied by the author. |
| HDR gain-map `jhgm` (18181-2 third edition) | Yes, supplied gain maps | `container-advanced.mjs:265,284,288`; original ISO 21496-1 metadata, encoded gain image, alternate color encoding and ICC. Bundle parsing and both images are proved; deriving gain maps and browser HDR application are separate operations. |
| Level declaration `jxll` | Yes | `frame.mjs:159–177`; `container.mjs:23–28`; `channels.mjs:79–101`; `layers.mjs:115–132`; level 10 is selected when the emitted representation requires it. |
| Level 5 image limits | Partial | `channels.mjs:79–101`; `icc-write.mjs:105`; `patches.mjs:34–83`; `splines.mjs:62–105`; `layers.mjs:115–116`. Each new writer checks its applicable limits; no independent all-tools level validator is exposed. |
| Level 10 image limits | Partial | `channels.mjs:79–101`; `layers.mjs:115–132`; existing strict application dimensions/output-memory limits remain below format maxima. Explicit level 5 refuses data needing level 10. |
| Level precision/intermediate-buffer restriction | Yes for emitted paths | `frame.mjs:25`; `channels.mjs:85–87`; `layers.mjs:80–116`; `vardct.mjs:140–150,294–298,339–340`; LF-pyramid output declares level 10 when it clears the signed-16-bit buffer hint. |

## Format limits and verification

Level 5 permits a maximum dimension of 2^18, at most 2^28 pixels, four extra channels, and a 4 MiB ICC profile;
black/CMYK is not allowed. Level 10 permits a maximum dimension of 2^30, at most 2^40 pixels, 256 extra channels,
and a 256 MiB ICC profile. Precision, Modular intermediates, composite frames, animation and coding tools have
further constraints. Application memory limits are intentionally distinct from format maxima. Raw codestreams
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
| 256 extra channels | Both command-line decoders retain them. Chrome's transformed-channel limit includes color, so gray plus 256 extras exceeds its 256-total limit. |
| CMYK | A valid original CMYK profile plus the black plane passes. A bare black plane with an RGB declaration is not a native CMYK display path. |
| Preview on a wide main image | libjxl and Chrome pass. jxl-oxide 0.12.6 can use main-canvas group geometry for a small preview when the canvas exceeds 1024 pixels. |
| Floating-point display | Raw encoded words, including signed zero and NaN payloads, are exact. Decoder display conversion is a separate operation; the fixtures retain jxl-oxide's binary16 zero/display discrepancy. |
| Arithmetic alpha above one | `ImageDecoder` and `createImageBitmap` with `premultiplyAlpha: 'none'` agree. Default bitmap premultiplication can change color before clipping alpha; bounded-alpha controls pass all three routes. |
| Large splines/patches at explicit level 10 | Both command-line decoders pass legal level-10 examples. Chrome applies level-5 tool-area limits and refuses those examples; default level-5 admission remains bounded. |

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

The actual packed worker carries all 37 format actions in one graph. Forty-one requests, a real three-field
compressed-metadata roundtrip, cancellation, busy refusal, transfer ownership and recovery pass in offline
Chrome 155 with zero network requests. This worker proof is distinct from the final package and page receipts.

## Primary references

- [libjxl 0.12.0 format overview](https://github.com/libjxl/libjxl/blob/v0.12.0/doc/format_overview.md)
- [Transform IDs and geometry](https://github.com/libjxl/libjxl/blob/v0.12.0/lib/jxl/ac_strategy.h)
- [Frame, progression and blend syntax](https://github.com/libjxl/libjxl/blob/v0.12.0/lib/jxl/frame_header.cc)
- [Image metadata and extra channels](https://github.com/libjxl/libjxl/blob/v0.12.0/lib/jxl/image_metadata.cc)
- [Quantization-table families](https://github.com/libjxl/libjxl/blob/v0.12.0/lib/jxl/quant_weights.h)
- [Container writing and level checks](https://github.com/libjxl/libjxl/blob/v0.12.0/lib/jxl/encode.cc)
- [Codec authors' technical companion to ISO/IEC 18181](https://arxiv.org/html/2506.05987v1)

These references explain the inventory; the applicable edition of ISO/IEC 18181 remains normative.
