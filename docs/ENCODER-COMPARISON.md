# Encoder comparisons

The complete Rapier worker uses 174,450 gzip bytes: core encoding, effort search, optional WASM, Photo, JPEG transcoding and parallel workers. The separate core uses 24,831 gzip bytes. Both embed in one offline HTML file.

## Payload

Executable payload sizes. Rapier JXL uses this release; other rows use the pinned versions in [the measurement manifest](../bench/encoders.json).

| Encoder / entry | Version | Minified JS + WASM bytes | gzip bytes | Included capability |
| --- | --- | ---: | ---: | --- |
| Rapier JXL complete worker | 5.2.1 | 475,402 | 174,450 | Core + effort 1–9, optional WASM, Photo, JPEG transcoding and parallel workers |
| Rapier JXL core | 5.2.1 | 61,771 | 24,831 | Lossless/lossy RGBA, native precision and HDR, exact alpha |
| Rapier JXL effort | 5.2.1 | 131,101 | 50,419 | Core plus lossless predictor, learned-tree, entropy, color, and screen search |
| Rapier JXL WASM | 5.2.1 | 154,096 | 60,129 | Effort with inlined kernels and JavaScript fallback |
| Rapier JXL JPEG | 5.2.1 | 77,649 | 30,616 | JPEG coefficients, orientation and original-byte reconstruction |
| Rapier JXL photo | 5.2.1 | 63,498 | 25,190 | 8-bit photographic VarDCT, exact alpha; q100 lossless |
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

## Complete worker versus libjxl

**Historical measurement: 2026-10-08, Rapier 3.1.0.** The raw receipt identifies worker SHA-256 `c8c328dbe1498903da0cfed5bd70b8e9212225d149ee8aa6ea4be1f97fb6276e` (50,021 gzip bytes). All rows below belong to that frozen worker. They do not measure the current effort search; the payload table above describes the current package separately.

Lossless RGBA8, including hidden RGB, through the **recorded Rapier 3.1.0 worker**, compared with native **libjxl 0.11.2**. Effort numbers are each encoder's search budgets. Bpp means bits per pixel. Rapier ms is one call per configuration without warmup; libjxl ms is the median of three calls after one warmup.

| Input | Effort | Rapier bytes / bpp / ms (single) | libjxl bytes / bpp / ms (median) |
| --- | ---: | ---: | ---: |
| Light UI | 1 | 26,612 / 0.693 / 63.8 | 40,313 / 1.050 / 0.8 |
| Light UI | 3 | 13,852 / 0.361 / 286.4 | 34,595 / 0.901 / 41.6 |
| Light UI | 6 | 11,515 / 0.300 / 1826.3 | 13,986 / 0.364 / 136.8 |
| Light UI | 9 | 11,515 / 0.300 / 13937.6 | 12,687 / 0.330 / 406.9 |
| Labeled drawing | 1 | 6,083 / 0.248 / 16.6 | 7,541 / 0.307 / 1.1 |
| Labeled drawing | 3 | 3,554 / 0.145 / 98.9 | 8,324 / 0.339 / 21.8 |
| Labeled drawing | 6 | 1,644 / 0.067 / 528.1 | 2,275 / 0.093 / 67.3 |
| Labeled drawing | 9 | 1,644 / 0.067 / 7716.8 | 2,208 / 0.090 / 188.2 |
| Painting | 1 | 162,479 / 6.611 / 23.5 | 176,744 / 7.192 / 0.9 |
| Painting | 3 | 150,434 / 6.121 / 135.4 | 140,851 / 5.731 / 44.1 |
| Painting | 6 | 135,430 / 5.511 / 758.2 | 127,932 / 5.206 / 243.7 |
| Painting | 9 | 119,700 / 4.871 / 28956.9 | 121,901 / 4.960 / 1320.4 |
| Photograph | 1 | 297,182 / 7.739 / 26.9 | 313,938 / 8.175 / 1.5 |
| Photograph | 3 | 290,619 / 7.568 / 159.1 | 274,218 / 7.141 / 62.8 |
| Photograph | 6 | 269,774 / 7.025 / 1158.2 | 256,427 / 6.678 / 353.3 |
| Photograph | 9 | 258,681 / 6.736 / 32734.2 | 254,579 / 6.630 / 2132.3 |
| Terminal | 1 | 35,952 / 1.463 / 19.3 | 70,175 / 2.855 / 1.0 |
| Terminal | 3 | 9,799 / 0.399 / 148.7 | 40,983 / 1.668 / 28.2 |
| Terminal | 6 | 7,814 / 0.318 / 529.8 | 12,470 / 0.507 / 81.0 |
| Terminal | 9 | 7,814 / 0.318 / 13108.0 | 11,729 / 0.477 / 246.3 |

Node 22.23.3 on Linux x64, AMD EPYC 9V74, CPU 0. One encoding thread per implementation. Rapier reports one call per configuration without warmup; libjxl reports the median of three calls after one warmup. Rapier uses automatic WASM; libjxl is native C++. The two implementations were measured separately on the same idle host. Timing includes each encode and output, excluding input transport/loading and decoding. Worker startup was 38.3 ms, measured separately. Every result preserves exact source RGBA; Rapier outputs also pass two independent decoders.

In this recorded run at effort 9, Rapier produced smaller files on the three document images and the painting; libjxl produced the smaller photograph. Native libjxl was faster in every measured row. These results describe only the recorded versions and inputs; they do not predict current, browser or phone performance.

[Raw samples, settings and hashes](../bench/complete-worker-results.json) · [Benchmark commands](../bench/README.md). Reproducing these rows requires the recorded worker and libjxl build; a newer worker produces a new comparison. The public repository includes the five exact RGBA inputs in `test/complete-corpus/`; they are excluded from the npm runtime package. The earlier 0.12.0 comparison below used another libjxl build and has no shared timing baseline.

## Earlier libjxl 0.12.0 size comparison

This earlier 24-image measurement used Rapier 3.0.0. Identical RGBA8 pixels include RGB under transparent alpha; libjxl 0.12.0 receives decoded PNG pixels with `--keep_invisible=1`.

| Image | Rapier 2.6 | Rapier 3.0 | libjxl effort 3 | libjxl effort 9 |
| --- | ---: | ---: | ---: | ---: |
| Light UI | 11,515 | 11,515 | 34,589 | 12,634 |
| Labeled drawing | 1,644 | 1,644 | 8,316 | 2,184 |
| Painting | 150,434 | 128,668 | 140,833 | 120,979 |
| Photograph | 290,619 | 264,599 | 274,187 | 249,600 |
| Terminal | 7,814 | 7,814 | 40,961 | 11,686 |

Sizes are bytes. Effort 9 searches for smaller lossless files; higher effort changes compression, not image fidelity.

Across 24 images—20 photographs, three documents, and one painting—3.0 effort 9 used **9.33% fewer bytes** than 2.6. All 20 photographs improved; the three document files were unchanged. Both libjxl and jxl-oxide reproduced exact source pixels for the corpus and three larger renditions. [Inputs, hashes, and results](../bench/lossless-results.json).

## Earlier 2.6.0 / 3.0.0 encoding time

Paired 2.6.0 and 3.0.0 runs on the five images above. Ratios compare 3.0.0 with 2.6.0; below 1 is faster.

| Effort | Wall time | CPU time | Output bytes |
| --- | ---: | ---: | ---: |
| 1 | 0.94× | 0.94× | 0.00% |
| 3 | 1.04× | 1.06× | 0.00% |
| 9 | 4.05× | 4.04× | -10.34% |

Node 22.23.3, Linux x64, Xeon Platinum 8573C, CPU 0 affinity, SIMD, no encoding workers. Two reversed passes each
use two warmups and three measured calls per image and encoder. The table uses geometric means of per-image
median time ratios and total output bytes. Timings exclude input loading; all measured calls remain in the results.
[Raw samples, environment, and hashes](../bench/lossless-results.json).

## Lossy pixels and JPEG input

The photo entry point uses VarDCT with exact alpha. In the matched-size Rapier JXL 2.6.0 comparison, libjxl has higher SSIM in 19 of 20 rows and lower Butteraugli error in 19 of 20. [Metrics and input details](../bench/quality-comparison.json).

The JPEG entry point now stores standard `jbrd` reconstruction data and restores original JPEG bytes. Older JPEG
measurements made before that addition omit its metadata cost and must not be compared with reversible libjxl output.

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
