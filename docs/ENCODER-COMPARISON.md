# Encoder comparisons

Rapier JXL embeds in one offline HTML file. The core uses 11,642 gzip bytes; optional entry points add compression search, WASM kernels, JPEG input, or photographic coding.

## Payload

Executable payload sizes. Rapier JXL uses this release; other rows use the pinned versions in [the measurement manifest](../bench/encoders.json).

| Encoder / entry | Version | Minified JS + WASM bytes | gzip bytes | Included capability |
| --- | --- | ---: | ---: | --- |
| Rapier JXL core | 3.0.0 | 27,557 | 11,642 | Lossless/lossy RGBA, native precision and HDR, exact alpha |
| Rapier JXL effort | 3.0.0 | 73,716 | 28,614 | Core plus lossless predictor, learned-tree, entropy, color, and screen search |
| Rapier JXL WASM | 3.0.0 | 87,139 | 34,838 | Effort with inlined kernels and JavaScript fallback |
| Rapier JXL JPEG | 3.0.0 | 33,297 | 13,851 | JPEG coefficients, orientation; no JPEG reconstruction |
| Rapier JXL photo | 3.0.0 | 38,928 | 15,811 | 8-bit photographic VarDCT, exact alpha; q100 lossless |
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

## Lossless files

Identical RGBA8 pixels, including RGB under transparent alpha. Rapier JXL uses effort 9; libjxl 0.12.0 receives decoded PNG pixels with `--keep_invisible=1`.

| Image | Rapier 2.6 | Rapier 3.0.0 | libjxl effort 3 | libjxl effort 9 |
| --- | ---: | ---: | ---: | ---: |
| Light UI | 11,515 | 11,515 | 34,589 | 12,634 |
| Labelled drawing | 1,644 | 1,644 | 8,316 | 2,184 |
| Painting | 150,434 | 128,668 | 140,833 | 120,979 |
| Photograph | 290,619 | 264,599 | 274,187 | 249,600 |
| Terminal | 7,814 | 7,814 | 40,961 | 11,686 |

Sizes are bytes. Effort 9 searches for smaller lossless files; higher effort changes compression, not image fidelity.

Across 24 images—20 photographs, three documents, and one painting—effort 9 uses **9.33% fewer bytes** than 2.6. All 20 photographs improve; the three document files are unchanged. Both libjxl and jxl-oxide reproduce exact source pixels for the corpus and three larger renditions. [Inputs, hashes, and results](../bench/lossless-results.json).

## Encoding time

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
