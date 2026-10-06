# Encoder payloads

Rapier JXL is the smallest JavaScript or WebAssembly JPEG XL encoder among the published payloads measured here.
A bounded survey, not proof of a global minimum; the encoders differ in what they cover.

| Encoder / entry | Version | Minified JS + WASM bytes | gzip bytes | Included capability |
| --- | --- | ---: | ---: | --- |
| Rapier JXL core | 2.3.0 | 21,326 | 9,271 | 8-bit lossless RGBA, lossy modular with exact alpha |
| Rapier JXL effort door | 2.3.0 | 43,792 | 17,571 | The core, and the weighted predictor searched for lossless |
| Rapier JXL JPEG door | 2.3.0 | 32,354 | 13,505 | JPEG coefficients, orientation; no JPEG reconstruction |
| Rapier JXL photo door | 2.3.0 | 33,011 | 13,616 | 8-bit photographic VarDCT, exact alpha; q100 lossless |
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
sizes. Every file, URL, npm integrity and SHA-256 is in [`bench/encoder-sizes.json`](../bench/encoder-sizes.json).
The jSquash, fork, squoosh-kit and icodec rows count the encoder factory and its WASM only, without wrappers,
workers or decoders, which favours them. Size says nothing about correctness or compression quality.

## Reproduce

```sh
npm install --ignore-scripts
node bench/measure-encoders.mjs .encoder-size-cache encoder-sizes.json
```

The script fetches the pinned npm archives in `bench/encoders.json`, checks their integrity, reads the listed
members in memory and minifies them. It never runs downloaded code. Rapier JXL's own bytes are in [`dist/sizes.json`](../dist/sizes.json).

## Quality at matched bytes

A small encoder does not mean small or good pictures. This compares Rapier JXL's readable source with the
[libjxl v0.12.0 reference](https://github.com/libjxl/libjxl/releases/tag/v0.12.0) (`cjxl`, `djxl` and
`butteraugli_main` from the official Linux x86-64 static archive) on eleven inputs: four synthetic textures, a
public-domain photograph (Grace Hopper), three generated drawings and three generated paintings. It is not a
representative collection. Each Rapier JXL stream sets a byte budget; `cjxl` at effort 7, its mode left to the
encoder, is searched over distances for the largest stream within that budget (a gap of at most 0.5% counts as
matched). Where distance 0 already fits, the row is marked **†**: an exact stream in fewer bytes, not a match. Both
outputs are decoded by the same `djxl` to 8-bit sRGB; alpha is byte-exact in every decode. PSNR and RGB SSIM are
computed over the three RGB channels (single-scale SSIM, 11 × 11 Gaussian, no downsampling); inputs with alpha are
matted on white. Butteraugli is the reference tool at 80 nits. Higher PSNR and SSIM and lower Butteraugli are that
metric's preference, not a human verdict. **R / N** is Rapier JXL / native.

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

On the six drawings and paintings, at four qualities each, native is better on SSIM and Butteraugli in all 24 rows.
Native matches the byte budget within 0.127% in 14 rows; in the other ten (**†**) an exact native stream fits in 3% to
51% fewer bytes. PSNR favours Rapier JXL on two of the paintings at quality 80 and 90.

### The JPEG carrier against reversible recompression

`transcode` against `cjxl --lossless_jpeg=1`. The contracts differ: Rapier carries the coefficients and the
orientation and cannot rebuild the JPEG file; native also stores the reconstruction data and rebuilt every
accepted original exactly. So a smaller Rapier row is not a like-for-like win. Seven inputs are tiny conformance fixtures;
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

### Commands

```sh
cjxl INPUT.pam OUTPUT.jxl --distance=D --effort=7 --num_threads=0 \
  --alpha_distance=0 --resampling=1 --ec_resampling=1 --keep_invisible=1 --premultiply=0 --container=0 \
  -x color_space=RGB_D65_SRG_Per_SRG --quiet
djxl INPUT.jxl OUTPUT.pam --bits_per_sample=8 --color_space=RGB_D65_SRG_Per_SRG --num_threads=0 --quiet
butteraugli_main REFERENCE.ppm DECODED.ppm --intensity_target 80
cjxl INPUT.jpg OUTPUT.jxl --lossless_jpeg=1 --effort=7 --num_threads=0 --quiet
djxl OUTPUT.jxl RECONSTRUCTED.jpg --reconstruct_jpeg --num_threads=0 --quiet
```

The Grace Hopper photograph is `test/photo-corpus/grace-hopper.jpg`.

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

Searched: npm's `jpeg-xl`, `jpegxl`, `jxl` and `jixel` results and the encoders' upstream repositories.
