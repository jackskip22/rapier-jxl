# Encoder comparisons

The complete Rapier worker uses 213,491 gzip bytes: core encoding, effort search, optional WASM, Photo, JPEG transcoding and parallel workers. The separate core uses 28,604 gzip bytes. Both embed in one offline HTML file.

## Payload

Executable payload sizes. Rapier JXL uses this release; other rows use the pinned versions in [the measurement manifest](../bench/encoders.json).

| Encoder / entry | Version | Minified JS + WASM bytes | gzip bytes | Included capability |
| --- | --- | ---: | ---: | --- |
| Rapier JXL complete worker | 6.0.0 | 576,318 | 213,491 | Core + effort 1–9, optional WASM, Photo, JPEG transcoding and parallel workers |
| Rapier JXL core | 6.0.0 | 70,742 | 28,604 | Lossless/lossy RGBA, native precision and HDR, exact alpha |
| Rapier JXL effort | 6.0.0 | 204,440 | 78,134 | Core plus lossless predictor, learned-tree, entropy, color, and screen search |
| Rapier JXL WASM | 6.0.0 | 227,437 | 88,025 | Effort with inlined kernels and JavaScript fallback |
| Rapier JXL JPEG | 6.0.0 | 83,068 | 32,866 | JPEG coefficients, orientation and original-byte reconstruction |
| Rapier JXL photo | 6.0.0 | 157,813 | 60,786 | 8-bit photographic VarDCT, exact alpha; q100 lossless |
| [jSquash](https://github.com/jamsinclair/jSquash/tree/main/packages/jxl) | 1.3.0 | 1,388,572 | 525,782 | 8-bit lossless/lossy RGBA |
| [Discourse's jSquash package](https://www.npmjs.com/package/@discourse/jxl) | 1.3.0 | 1,388,572 | 525,782 | The same encoder bytes as jSquash |
| [Lacinak's jSquash fork](https://github.com/kelaci/jSquash) | 1.3.0-kelaci.0 | 2,071,514 | 844,866 | High bit-depth input options |
| [squoosh-kit](https://github.com/bnowak008/squoosh-kit/tree/main/packages/jxl) | 0.2.10 | 1,371,789 | 511,927 | 8-bit lossless/lossy RGBA |
| [icodec](https://github.com/Kaciras/icodec) | 0.6.0 | 2,474,954 | 900,957 | 8 to 16-bit lossless/lossy pixels |
| [Cornerstone libjxl](https://github.com/cornerstonejs/codecs/tree/main/packages/libjxl) | 1.1.1 | 2,575,008 | 936,242 | 1 to 16-bit grayscale/RGB; DICOM-oriented API |
| [jxl-wasm](https://github.com/saschanaz/jxl-wasm) | 0.7.0 | 2,533,758 | 961,538 | libjxl CLI, pixels and reversible JPEG |
| [jpeg-to-jxl](https://github.com/ChefJulio/jpeg-to-jxl) | 0.2.0 | 2,732,858 | 1,063,406 | Reversible JPEG recompression, with decode |
| [Squoosh library](https://github.com/GoogleChromeLabs/squoosh/tree/dev/libsquoosh) | 0.5.3 | 1,615,596 | 539,210 | Shared multi-codec JavaScript and one JXL encoder WASM |


JavaScript is minified with Terser 5.51.2. Each JS/WASM resource is gzipped separately at level 9, then summed.
[Files, versions, integrity, and hashes](../bench/encoder-sizes.json).

## Lossless effort cost

Recorded 2026-10-10 with the Rapier 3.3.0 worker, SHA-256 `389d3860b751eebf096c7744ca3f82a2eb6177bcdb01a4546db356f6b3e6c2fb`: 71 RGBA8 images, efforts 7, 8 and 9, one observed call per image/effort, zero warmups. All 213 calls completed sequentially in one reused worker, without restart, on Node 22.23.3, AMD EPYC 9V74, CPU 0, with helper workers disabled.

| Effort | Output bytes | Fewer bytes than effort 7 | Sum of observed handler seconds | Observed cost relative to effort 7 |
| ---: | ---: | ---: | ---: | ---: |
| 7 | 23,089,718 | 0.000% | 295.336 | 1.000× |
| 8 | 22,608,675 | 2.083% | 1,254.247 | 4.247× |
| 9 | 22,536,753 | 2.395% | 2,819.409 | 9.546× |

Effort 8 provides most of the size reduction in this corpus. Effort 9 is another **0.318% smaller than effort 8** at **2.248× its observed time**. This is a measured size/time trade-off, not a universal recommendation.

Times sum public worker-handler durations, including validation/admission and response construction. They exclude worker construction and packed-script loading/evaluation before handler readiness, input I/O, input hashing and request/result transport. Lazy encoder/kernel initialization inside the first handler is included, together with first-call/JIT effects. Each setting has one observation: these are observed totals and ratios, with no median, repeatability or variance claim. They do not predict browser or phone performance.

All 213 outputs match the retained earlier streams in SHA-256 and length. That identity reuses the established two-decoder exact-RGBA proof, including hidden RGB; no new decodes were performed in this timing run. No image or group grows with effort.

[Per-image/group bytes, observed costs, output hashes and receipt identities](../bench/lossless-effort-costs.json). Milliseconds per megapixel normalize only this measured corpus; they do not predict unmeasured image sizes. No native libjxl comparison was rerun for this corpus.

## Photographs

Every picture through Rapier JXL 6.0.0 and libjxl 0.12.0's `cjxl`, mozjpeg 4.1.5, WebP (`cwebp -m 6 -sharp_yuv`) and
AVIF (`avifenc -s 6`) at 11 to 13 settings each. libjxl's `ssimulacra2` and `butteraugli_main` (3-norm) score the pixels each
file decodes to; bytes at the same score are interpolated per picture and summed. Every JPEG XL file decodes in djxl,
jxl-oxide 0.12.6 and Chrome 155 to the same pixels (within 1/255). Encoders run one thread each.

**Kodak 24**: bytes against libjxl at the same score (below 0 is smaller).

| Score | Effort 7 vs `cjxl -e 7` | Effort 7 vs `cjxl -e 9` | Effort 9 vs `cjxl -e 9` |
| --- | ---: | ---: | ---: |
| SSIMULACRA2 60 | −5.9% | −5.4% | −5.3% |
| SSIMULACRA2 70 | −7.0% | −5.4% | −5.2% |
| SSIMULACRA2 80 | −7.9% | −6.7% | −6.6% |
| SSIMULACRA2 85 | −7.6% | −6.3% | −6.0% |
| SSIMULACRA2 90 | −7.8% | −7.1% | −5.8% |
| Butteraugli 3-norm 2 | −4.2% | −3.9% | −5.2% |
| Butteraugli 3-norm 1.5 | −4.8% | −3.2% | −4.5% |
| Butteraugli 3-norm 1 | −2.2% | +0.2% | −2.3% |
| Butteraugli 3-norm 0.7 | +1.0% | +3.8% | −0.3% |

Encode to a score, against `cjxl -e 9` at the score libjxl's tool gives each file:

| Target | Bytes | Pictures |
| --- | ---: | ---: |
| Butteraugli 3-norm 0.7 | −0.5% | 24 |
| Butteraugli 3-norm 1 | −2.5% | 24 |
| Butteraugli 3-norm 1.5 | −4.5% | 24 |
| SSIMULACRA2 70 | −6.3% | 24 |
| SSIMULACRA2 80 | −7.6% | 24 |
| SSIMULACRA2 90 | −7.6% | 24 |

JPEG XL (effort 7) against other formats at the same SSIMULACRA2:

| SSIMULACRA2 | AVIF | JPEG (mozjpeg) | WebP |
| --- | ---: | ---: | ---: |
| 60 | −4.9% | −19.2% | −16.6% |
| 70 | −7.0% | −20.2% | −15.6% |
| 80 | −10.9% | −27.9% | −18.1% |
| 85 | −14.0% | −35.7% | −20.1% |
| 90 | −21.0% | −43.4% | −23.8% |

Exact JPEG: each JPEG converts with `rapier-jxl/jpeg-ans` and restores byte for byte in djxl and `reconstructJPEG`.

Reproduce: `node bench/v6-proof.mjs out.json --corpus kodak=<dir of PNG> --jpeg kodak=<dir of JPEG> --chrome <Chrome 155>`,
then `node bench/v6-wins.mjs wins.json out.json`. Results: [Kodak](../bench/v6-proof-kodak.json),
[phone photos](../bench/v6-proof-phone.json) ([sources](../bench/phone-photos-sources.json)).

## Animation

`rapier-jxl/animation` against the formats people use for the same frames, measured on 2026-10-21 on one host,
one thread per encoder. Bytes in kB (1,000 bytes); time is milliseconds per frame. The corpus is three Wikimedia
Commons GIFs, the first 30 frames of the Xiph `akiyo` and `foreman` CIF camera sequences, and two 800 × 500 screen
recordings of an editor page rendered in Chromium (typing; a menu, hovers and a scroll). GIF is the original file, or
a 256-color GIF made by ffmpeg (which is lossy for the camera and screen sources). APNG and WebP are written by
Pillow 12.3.0 (libwebp 1.6.0, method 6, smallest-size search); cjxl and djxl are libjxl 0.12.0.
[Raw results](../bench/animation-results.json), [corpus](../bench/animation-sources.json), [harness](../bench/animation.mjs).

Lossless (every frame exact):

| Animation | Frames | GIF | APNG | WebP | cjxl e7 | cjxl e9 | Rapier e1 | Rapier e3 | Rapier e7 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| akiyo (still camera) | 30 | 1,280* | 3,714 | 1,600 | 1,978 | 1,926 | 2,072 | 1,837 | **1,578** |
| foreman (moving camera) | 30 | 2,175* | 4,768 | 2,820 | 2,261 | **2,206** | 2,728 | 2,337 | 2,237 |
| Newton's cradle GIF | 36 | 308 | 1,078 | **267** | 575 | 556 | 424 | 353 | 284 |
| Rotating earth GIF | 44 | 1,002 | 1,566 | 767 | 746 | **720** | 934 | 934 | 904 |
| Muybridge horse GIF | 15 | 568 | 804 | 423 | 402 | **397** | 482 | 465 | 419 |
| Screen: typing | 60 | 21* | 49 | **15.8** | 23.6 | 23.3 | 17.6 | 16.9 | 16.1 |
| Screen: menu, hover, scroll | 40 | 498* | 744 | **95** | 102 | 98 | 414 | 132 | 112 |

\* lossy 256-color GIF. Time per frame (akiyo / screen typing): Rapier e1 40 / 8, e3 321 / 26, e7 5,435 / 173;
cjxl e7 152 / 3.7; WebP 11,350 / 64.

Lossy, bytes in kB at the mean SSIMULACRA2 reached (higher is better):

| Animation | Rapier q90 e7 | Rapier q95 e7 | cjxl d1 e7 | WebP q90 |
| --- | ---: | ---: | ---: | ---: |
| akiyo | 312 at 84.7 | 481 at 89.4 | 501 at 88.7 | 302 at 83.6 |
| foreman | 537 at 82.8 | 794 at 88.7 | 766 at 88.5 | 634 at 86.2 |
| Newton's cradle | 216 at 86.7 | 334 at 89.7 | 333 at 89.9 | 193 at 87.0 |
| Rotating earth | 454 at 76.5 | 680 at 85.0 | 566 at 86.1 | 415 at 82.7 |
| Muybridge horse | 125 at 84.6 | 181 at 89.5 | 174 at 89.1 | 158 at 88.3 |
| Screen: typing | 16.1 exact | 16.1 exact | 33.0 at 91.0 | 25.2 at 90.0 |
| Screen: menu, hover, scroll | 112 exact | 112 exact | 212 | 415 |

Rapier keeps a lossy request exact when the exact first frame is smaller, as on both screen recordings. The rotating
earth's dithered palette is where Rapier's single-frame coding trails libjxl most (a still frame: 32.5 kB against
cjxl's 26.2 kB lossless). The scrolling screen recording is 15–18% larger than WebP's and cjxl's.

## Reproduce

```sh
npm install --ignore-scripts
node bench/measure-encoders.mjs .encoder-size-cache encoder-sizes.json
node bench/lossless.mjs --inputs corpus.json --out results.json \
  --entry ./dist/effort.min.mjs --efforts 1,3,6,9 --warmups 2 --repeats 5
```

`corpus.json` lists `{id, pixels, width, height, rgbaHash?}`. Each `pixels` path is raw RGBA8, optionally gzipped, relative to the manifest.

Native lossless command:

```sh
cjxl input.png output.jxl -d 0 -e 9 --num_threads=0 --keep_invisible=1 --num_reps=5
```
