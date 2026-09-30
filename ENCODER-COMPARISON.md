# Encoder payloads measured on 30 September 2026

Rapier JXL is the smallest JavaScript or WebAssembly JPEG XL encoder among the published payloads measured here.
A bounded survey, not proof of a global minimum; the encoders differ in what they cover.

| Encoder / entry | Version | Minified JS + WASM bytes | gzip bytes | Included capability |
| --- | --- | ---: | ---: | --- |
| Rapier JXL core | 2.0.0 | 19,495 | 8,475 | 8-bit lossless RGBA, lossy modular with exact alpha |
| Rapier JXL effort door | 2.0.0 | 25,229 | 10,606 | The core, and the weighted predictor searched for lossless |
| Rapier JXL JPEG door | 2.0.0 | 29,592 | 12,533 | JPEG coefficients, orientation; no JPEG reconstruction |
| Rapier JXL photo door | 2.0.0 | 25,646 | 10,804 | 8-bit photographic VarDCT, exact alpha; q100 lossless |
| [jSquash](https://github.com/jamsinclair/jSquash/tree/main/packages/jxl) | 1.3.0 | 1,388,572 | 525,782 | 8-bit lossless/lossy RGBA |
| [Discourse's jSquash package](https://www.npmjs.com/package/@discourse/jxl) | 1.3.0 | 1,388,572 | 525,782 | The same encoder bytes as jSquash |
| [Lacinak's jSquash fork](https://github.com/kelaci/jSquash) | 1.3.0-kelaci.0 | 2,071,514 | 844,866 | High bit-depth input options |
| [squoosh-kit](https://github.com/bnowak008/squoosh-kit/tree/main/packages/jxl) | 0.2.10 | 1,371,789 | 511,927 | 8-bit lossless/lossy RGBA |
| [icodec](https://github.com/Kaciras/icodec) | 0.6.0 | 2,474,954 | 900,957 | 8 to 16-bit lossless/lossy pixels |
| [Cornerstone libjxl](https://github.com/cornerstonejs/codecs/tree/main/packages/libjxl) | 1.1.1 | 2,575,008 | 936,242 | 1 to 16-bit grayscale/RGB; DICOM-oriented API |
| [jxl-wasm](https://github.com/saschanaz/jxl-wasm) | 0.7.0 | 2,533,758 | 961,538 | libjxl CLI, pixels and reversible JPEG |
| [jpeg-to-jxl](https://github.com/ChefJulio/jpeg-to-jxl) | 0.2.0 | 2,732,858 | 1,063,406 | Reversible JPEG recompression, with decode |
| [Squoosh library](https://github.com/GoogleChromeLabs/squoosh/tree/dev/libsquoosh) | 0.5.3 | 1,615,596 | 539,210 | Shared multi-codec JavaScript and one JXL encoder WASM |

Bytes are decimal. JavaScript is minified with Terser 5.51.2 (two compress passes, mangling, licence comments
kept), WASM is unchanged, each resource is gzipped alone at level 9, then summed: delivery bytes, not tarball
sizes. Every file, URL, npm integrity and SHA-256 is in [`public/encoder-sizes.json`](public/encoder-sizes.json).
The jSquash, fork, squoosh-kit and icodec rows count the encoder factory and its WASM only, without wrappers,
workers or decoders, which favours them. Size says nothing about correctness or compression quality.

## Reproduce

```sh
npm install --ignore-scripts
node public/measure-encoders.mjs .encoder-size-cache encoder-sizes.json
```

The script fetches the pinned npm archives in `public/encoders.json`, checks their integrity, reads the listed
members in memory and minifies them. It never runs downloaded code. Rapier's own bytes come from its stager.

## Quality at matched bytes, 30 September 2026

A small encoder does not mean small or good pictures. This measures Rapier's readable source against the
[libjxl v0.12.0 reference](https://github.com/libjxl/libjxl/releases/tag/v0.12.0) (`cjxl`, `djxl` and
`butteraugli_main` from the official Linux x86-64 static archive, SHA-256
`5318a1ea40adad76d023e0c17a03d4627f8282f83cb2b575e69be8e74f1ff456`) on eleven inputs: four synthetic
textures, the bundled Grace Hopper JPEG, three generated drawings and three generated paintings. It is not a
representative collection. Each Rapier stream sets a byte budget; the native encoder, at effort 7 with its mode
left to `cjxl`, is searched over distances for the largest stream within that budget (a gap of at most 0.5%
counts as matched). Where native distance 0 already fits, the row is marked **†**: an exact stream in fewer
bytes, not a match. Both outputs are decoded by the same pinned `djxl` to 8-bit sRGB; alpha is byte-exact in
every selected decode. PSNR and RGB SSIM are computed over the three RGB channels (single-scale SSIM, 11 × 11
Gaussian, no downsampling); alpha-bearing inputs are matted on white for the table. Butteraugli is the
reference tool at 80 nits, the worse of the white and black mattes for alpha inputs. Higher PSNR and SSIM and
lower Butteraugli are that metric's preference, not a human verdict. **R / N** is Rapier / native.

### The photo door

Native is within 0.402% of the budget in all 20 rows, and better on PSNR and SSIM in 19 of 20 and on
Butteraugli in 19 of 20; the exceptions are Grace q99 (Rapier's PSNR and SSIM) and lit surface q99 (Rapier's
Butteraugli).

| Input · Rapier q | Rapier bytes | Native bytes | Native d | PSNR dB R / N ↑ | RGB SSIM R / N ↑ | Butteraugli R / N ↓ |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Wood grain · 50 | 6,351 | 6,335 | 5.061 | 33.459 / 37.501 | 0.833394 / 0.920358 | 7.9959 / 3.8476 |
| Wood grain · 80 | 11,640 | 11,632 | 2.246 | 36.866 / 39.628 | 0.900685 / 0.942440 | 4.0035 / 1.8251 |
| Wood grain · 90 | 18,713 | 18,713 | 1.226 | 38.910 / 40.727 | 0.929675 / 0.953458 | 2.3318 / 1.5172 |
| Wood grain · 99 | 76,863 | 76,842 | 0.327 | 45.530 / 47.954 | 0.983684 / 0.991316 | 0.9762 / 0.6128 |
| Landscape · 50 | 4,729 | 4,710 | 4.944 | 34.594 / 38.053 | 0.852275 / 0.908469 | 8.5642 / 3.4545 |
| Landscape · 80 | 7,932 | 7,921 | 2.438 | 37.305 / 39.502 | 0.891356 / 0.921732 | 4.1410 / 2.1015 |
| Landscape · 90 | 12,725 | 12,723 | 1.508 | 39.050 / 40.389 | 0.912417 / 0.931579 | 3.1272 / 1.6892 |
| Landscape · 99 | 64,221 | 64,192 | 0.377 | 45.545 / 47.492 | 0.977931 / 0.986445 | 1.0067 / 0.6164 |
| Folded texture · 50 | 3,563 | 3,552 | 5.427 | 35.334 / 38.643 | 0.839685 / 0.908679 | 7.2341 / 4.0082 |
| Folded texture · 80 | 6,525 | 6,514 | 2.468 | 38.175 / 40.176 | 0.894762 / 0.927122 | 3.6812 / 2.2637 |
| Folded texture · 90 | 10,046 | 10,046 | 1.668 | 39.618 / 40.820 | 0.917830 / 0.934923 | 2.2918 / 1.6726 |
| Folded texture · 99 | 57,111 | 57,111 | 0.412 | 45.611 / 47.539 | 0.979148 / 0.986739 | 0.9172 / 0.7164 |
| Lit surface · 50 | 2,825 | 2,825 | 2.909 | 38.241 / 40.292 | 0.891825 / 0.915090 | 4.4182 / 2.4656 |
| Lit surface · 80 | 4,107 | 4,107 | 2.314 | 39.474 / 40.530 | 0.903290 / 0.918372 | 3.1575 / 2.1072 |
| Lit surface · 90 | 5,465 | 5,453 | 1.988 | 40.214 / 40.738 | 0.912497 / 0.921402 | 2.2827 / 1.9999 |
| Lit surface · 99 | 47,155 | 47,152 | 0.466 | 45.664 / 46.636 | 0.975682 / 0.980349 | 0.9476 / 1.1255 |
| Grace Hopper · 50 | 15,990 | 15,982 | 5.451 | 29.546 / 30.676 | 0.778970 / 0.807254 | 6.6973 / 4.5990 |
| Grace Hopper · 80 | 34,419 | 34,409 | 2.338 | 33.675 / 34.477 | 0.862229 / 0.899859 | 3.8410 / 3.0344 |
| Grace Hopper · 90 | 56,543 | 56,519 | 1.110 | 38.605 / 38.944 | 0.950222 / 0.970007 | 2.3300 / 1.4546 |
| Grace Hopper · 99 | 110,542 | 110,533 | 0.173 | 49.948 / 47.182 | 0.996348 / 0.995977 | 0.4889 / 0.3406 |

### The core's lossy modular on drawings and paintings

Fourteen rows are matched within 0.127%. In the ten **†** rows an exact native stream fits in 3.052% to
51.144% fewer bytes. Native SSIM and Butteraugli are better in all 24 rows; PSNR favours Rapier for paint-0001
and paint-0002 at q80 and q90.

| Input · Rapier q | Rapier bytes | Native bytes | Native d | PSNR dB R / N ↑ | RGB SSIM R / N ↑ | Butteraugli R / N ↓ |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| recipe-0000 · 50 | 14,972 | 14,953 | 1.102 | 37.276 / 45.992 | 0.989901 / 0.996956 | 3.9870 / 1.0352 |
| recipe-0000 · 80 | 20,051 | 19,439† | 0 | 42.493 / ∞ | 0.995389 / 1.000000 | 2.6508 / 0.0000 |
| recipe-0000 · 90 | 25,232 | 19,439† | 0 | 46.614 / ∞ | 0.997777 / 1.000000 | 1.4840 / 0.0000 |
| recipe-0000 · 99 | 39,788 | 19,439† | 0 | 58.188 / ∞ | 0.999803 / 1.000000 | 0.5505 / 0.0000 |
| recipe-0001 · 50 | 31,284 | 31,279 | 1.642 | 44.663 / 51.571 | 0.998111 / 0.999252 | 3.6761 / 0.9379 |
| recipe-0001 · 80 | 37,226 | 35,491† | 0 | 49.928 / ∞ | 0.999293 / 1.000000 | 2.1718 / 0.0000 |
| recipe-0001 · 90 | 43,439 | 35,491† | 0 | 53.998 / ∞ | 0.999699 / 1.000000 | 0.7681 / 0.0000 |
| recipe-0001 · 99 | 60,225 | 35,491† | 0 | 63.163 / ∞ | 0.999953 / 1.000000 | 0.2608 / 0.0000 |
| recipe-0002 · 50 | 18,746 | 18,736 | 1.651 | 34.484 / 40.065 | 0.978619 / 0.992176 | 5.0667 / 1.4144 |
| recipe-0002 · 80 | 27,036 | 27,025 | 0.749 | 39.856 / 43.976 | 0.990765 / 0.995802 | 2.5048 / 1.0876 |
| recipe-0002 · 90 | 35,330 | 35,306 | 0.425 | 44.044 / 46.482 | 0.995583 / 0.997393 | 1.7128 / 0.6129 |
| recipe-0002 · 99 | 59,624 | 36,102† | 0 | 55.523 / ∞ | 0.999602 / 1.000000 | 0.5762 / 0.0000 |
| paint-0000 · 50 | 45,505 | 45,498 | 1.336 | 36.020 / 40.143 | 0.975668 / 0.991663 | 4.7640 / 1.5576 |
| paint-0000 · 80 | 54,652 | 54,618 | 0.684 | 39.900 / 43.518 | 0.988270 / 0.995770 | 2.7126 / 0.9569 |
| paint-0000 · 90 | 65,877 | 65,843 | 0.289 | 43.809 / 47.922 | 0.994447 / 0.998212 | 1.5637 / 0.6630 |
| paint-0000 · 99 | 97,769 | 74,658† | 0 | 54.474 / ∞ | 0.999312 / 1.000000 | 0.5388 / 0.0000 |
| paint-0001 · 50 | 61,462 | 61,442 | 1.680 | 33.606 / 34.830 | 0.956089 / 0.972432 | 7.1021 / 1.8314 |
| paint-0001 · 80 | 75,929 | 75,926 | 0.830 | 37.751 / 37.312 | 0.980393 / 0.982498 | 3.5325 / 1.1308 |
| paint-0001 · 90 | 93,451 | 93,451 | 0.343 | 41.285 / 40.730 | 0.990186 / 0.990973 | 1.9406 / 0.8474 |
| paint-0001 · 99 | 143,736 | 124,100† | 0 | 51.793 / ∞ | 0.998622 / 1.000000 | 0.6179 / 0.0000 |
| paint-0002 · 50 | 81,312 | 81,304 | 2.020 | 32.334 / 34.083 | 0.937986 / 0.962754 | 5.7590 / 2.1400 |
| paint-0002 · 80 | 98,676 | 98,622 | 1.055 | 36.749 / 36.598 | 0.972358 / 0.976745 | 3.1658 / 1.3790 |
| paint-0002 · 90 | 119,652 | 119,651 | 0.472 | 40.420 / 39.711 | 0.986313 / 0.987143 | 1.8052 / 1.1247 |
| paint-0002 · 99 | 187,934 | 170,069† | 0 | 50.304 / ∞ | 0.997853 / 1.000000 | 0.5696 / 0.0000 |

### The JPEG carrier against reversible recompression

`transcode` against `cjxl --lossless_jpeg=1`. The contracts differ: Rapier carries the coefficients and the
orientation and cannot rebuild the JPEG file; native also stores the reconstruction data and rebuilt every
original exactly. So a smaller Rapier row is not a like-for-like win. Six inputs are tiny conformance fixtures;
Grace is the one photograph.

| JPEG input | Original bytes | Rapier carrier | Native reversible | JPEG rebuilt by native |
| --- | ---: | ---: | ---: | --- |
| grey-sequential.jpg | 141 | 117 | 177 | yes |
| quant-before-scan.jpg | 141 | 120 | 181 | yes |
| quant-after-scan.jpg | 210 | 120 | refused | no reconstruction data possible |
| colour-sequential.jpg | 925 | 499 | 662 | yes |
| colour-progressive-restarts.jpg | 1,367 | 464 | 820 | yes |
| decoder-difference.jpg | 925 | 499 | 662 | yes |
| reconstruction-difference.jpg | 925 | 510 | 676 | yes |
| grace-hopper.jpg | 86,089 | 60,543 | 58,773 | yes |

### Inputs and commands

Textures are the first four `synthetic-photo` seeds of `tools/corpus/jxl-images.mjs` at 512 × 384; drawings and
paintings the first three seeds of each kind at the same size, through the real Draw and Paint owners with the
bundled Geist fonts and pinned `@napi-rs/canvas` 0.1.100. Grace is the public-domain fixture in
`public/test/photo-corpus/`, decoded once with `ffmpeg -pix_fmt rgba` at its native size.

| Input | Dimensions | Seed | Pixels with alpha < 255 | RGBA SHA-256 |
| --- | ---: | ---: | ---: | --- |
| Wood grain | 512 × 384 | 3399228925 | 0 | `cfc2495231eb53c4d423ab5ea7692e3cafce6160f07cc51942b910a89d5ffab7` |
| Landscape | 512 × 384 | 1351084136 | 0 | `c6c33cc695b19538ec6780647e32fd4f22b24872292d22707f26ab9ad1a0cef2` |
| Folded texture | 512 × 384 | 3597906643 | 0 | `57a0f40e8e14eb0b9fe5286dbfec7bc7783b1e748c6888ea44791f088b0ea106` |
| Lit surface | 512 × 384 | 1549761854 | 0 | `d998747e1c427144424c4d59f6795f88a2d2983a341dcba54b5a6b346e4f0a0d` |
| Grace Hopper | 512 × 600 | — | 0 | `af6a4dc548da3797b814f4be1b4489effe658ad13ba842d839628d01ba3ee39f` |
| recipe-0000 | 512 × 384 | 2385324683 | 23,538 | `6d8240cac5db3c3db509125658ba32cb919537b113ae9f0877856fe6c091e67f` |
| recipe-0001 | 512 × 384 | 337179894 | 163,701 | `7a5acaf7274bbadfabaa351f0dd3a7931818a438424d17ae555a2c2f72338b9f` |
| recipe-0002 | 512 × 384 | 2584002401 | 20,928 | `08ce520f30a10897b4acbb630e8d39aeeb97d53e02b50ac721ad80260fd2484c` |
| paint-0000 | 512 × 384 | 744793156 | 194,804 | `ad9467838000b99434d7f7cb041111cd0bad8f64fe2511ce98d0d106ebd147a3` |
| paint-0001 | 512 × 384 | 2991615663 | 193,919 | `a3af498e21cade0969d0b3fa63118316a18601aa23bd1b35ffc561e70a123237` |
| paint-0002 | 512 × 384 | 943470874 | 191,708 | `d2c586460a91e5bcb4c213080f46e4945d674ed6920230f50b2ab396076ea3c1` |

```sh
cjxl INPUT.pam OUTPUT.jxl --distance=D --effort=7 --num_threads=0 \
  --alpha_distance=0 --keep_invisible=1 --premultiply=0 --container=0 \
  -x color_space=RGB_D65_SRG_Per_SRG --quiet
djxl INPUT.jxl OUTPUT.pam --bits_per_sample=8 --color_space=RGB_D65_SRG_Per_SRG --num_threads=0 --quiet
butteraugli_main REFERENCE.ppm DECODED.ppm --intensity_target 80
cjxl INPUT.jpg OUTPUT.jxl --lossless_jpeg=1 --effort=7 --num_threads=0 --quiet
djxl OUTPUT.jxl RECONSTRUCTED.jpg --reconstruct_jpeg --num_threads=0 --quiet
```

From `repo/` in the development checkout, `tools/probes/jxl-quality.mjs --section=photo|modular|jpeg` makes
the inputs, encodes, runs the bracket search and writes `photo.json`, `modular.json` and `jpeg.json`;
`tools/probes/jxl-quality-metrics.py` computes the metrics (Python 3.12, NumPy 2.3, SciPy 1.17). The full
candidate pools, byte brackets, hashes and metric components are in the development receipts.

## Found but not ranked

| Project | Why not |
| --- | --- |
| [jxl-oxide-wasm](https://github.com/tirr-c/jxl-oxide-wasm) 0.12.6 (1,707,757 bytes, 612,548 gzip) | Decoder only |
| [jxl.js](https://github.com/niutech/jxl.js), jxl-rs-polyfill, TurboJXL, PureJsImage's codec | Decoders |
| [libjxl](https://github.com/libjxl/libjxl/blob/main/doc/building_wasm.md) WASM build | No published encoder payload; the libjxl-based packages above stand for it |
| [jixel](https://github.com/awxkee/jixel) `d84b45ff` | No published WASM |
| [libjxl-tiny](https://github.com/libjxl/libjxl-tiny) `8eae1817` | No published WASM |
| [Hydrium](https://github.com/Traneptora/hydrium) `45227f35` | Native executables only |
| [Imazen jxl-encoder](https://github.com/imazen/jxl-encoder) `0d79a23e` | No published WASM |
| webcvt's jsquash-jxl adapter | The jSquash encoder, already measured |
| sharp, libvips, the `cjxl` npm wrapper | Native binaries |

Searched: npm's `jpeg-xl`, `jpegxl`, `jxl` and `jixel` results, upstream repositories, the web. A smaller usable
encoder published later belongs in this table, and the claim changes with it.
