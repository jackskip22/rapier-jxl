# Encoder comparisons

The complete Rapier worker uses 50,021 gzip bytes: core encoding, effort search, optional WASM, Photo, JPEG transcoding and parallel workers. The separate core uses 11,670 gzip bytes. Both embed in one offline HTML file.

## Payload

Executable payload sizes. Rapier JXL uses this release; other rows use the pinned versions in [the measurement manifest](../bench/encoders.json).

| Encoder / entry | Version | Minified JS + WASM bytes | gzip bytes | Included capability |
| --- | --- | ---: | ---: | --- |
| Rapier JXL complete worker | 3.1.0 | 126,743 | 50,021 | Core + effort 1–9, optional WASM, Photo, JPEG transcoding and parallel workers |
| Rapier JXL core | 3.1.0 | 27,603 | 11,670 | Lossless/lossy RGBA, native precision and HDR, exact alpha |
| Rapier JXL effort | 3.1.0 | 77,117 | 30,013 | Core plus lossless predictor, learned-tree, entropy, color, and screen search |
| Rapier JXL WASM | 3.1.0 | 90,861 | 36,336 | Effort with inlined kernels and JavaScript fallback |
| Rapier JXL JPEG | 3.1.0 | 33,343 | 13,882 | JPEG coefficients, orientation; no JPEG reconstruction |
| Rapier JXL photo | 3.1.0 | 38,974 | 15,837 | 8-bit photographic VarDCT, exact alpha; q100 lossless |
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

## Complete worker versus libjxl

Lossless RGBA8, including hidden RGB, through the **complete published Rapier worker**, compared with native **libjxl 0.11.2**. Effort numbers are each encoder's search budgets. Bpp means bits per pixel. Rapier ms is one call per configuration without warmup; libjxl ms is the median of three calls after one warmup.

| Input | Effort | Rapier bytes / bpp / ms (single) | libjxl bytes / bpp / ms (median) |
| --- | ---: | ---: | ---: |
| Light UI | 1 | 26,612 / 0.693 / 63.8 | 40,313 / 1.050 / 0.8 |
| Light UI | 3 | 13,852 / 0.361 / 286.4 | 34,595 / 0.901 / 41.6 |
| Light UI | 6 | 11,515 / 0.300 / 1826.3 | 13,986 / 0.364 / 136.8 |
| Light UI | 9 | 11,515 / 0.300 / 13937.6 | 12,687 / 0.330 / 406.9 |
| Labelled drawing | 1 | 6,083 / 0.248 / 16.6 | 7,541 / 0.307 / 1.1 |
| Labelled drawing | 3 | 3,554 / 0.145 / 98.9 | 8,324 / 0.339 / 21.8 |
| Labelled drawing | 6 | 1,644 / 0.067 / 528.1 | 2,275 / 0.093 / 67.3 |
| Labelled drawing | 9 | 1,644 / 0.067 / 7716.8 | 2,208 / 0.090 / 188.2 |
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

At effort 9, Rapier produces smaller files on these three document images and the painting; libjxl produces the smaller photograph. Native libjxl is faster in every measured row. Rapier's extra effort-9 search trades encoding time for smaller files and retains every earlier candidate. These desktop measurements do not predict browser or phone performance.

[Raw samples, settings and hashes](../bench/complete-worker-results.json) · [Reproduce both encoders](../bench/README.md). The public repository includes the five exact RGBA inputs in `test/complete-corpus/`; they are excluded from the npm runtime package. The earlier 0.12.0 comparison below used another libjxl build and has no shared timing baseline.

## Earlier libjxl 0.12.0 size comparison

This earlier 24-image measurement used Rapier 3.0.0. Identical RGBA8 pixels include RGB under transparent alpha; libjxl 0.12.0 receives decoded PNG pixels with `--keep_invisible=1`.

| Image | Rapier 2.6 | Rapier 3.0 | libjxl effort 3 | libjxl effort 9 |
| --- | ---: | ---: | ---: | ---: |
| Light UI | 11,515 | 11,515 | 34,589 | 12,634 |
| Labelled drawing | 1,644 | 1,644 | 8,316 | 2,184 |
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

The JPEG entry point preserves admitted coefficients and orientation. It does not store JPEG reconstruction data; libjxl's reversible JPEG mode does. Their file sizes measure different outputs.

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
