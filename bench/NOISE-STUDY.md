# Bounded source-grain replacement

The optional `rapier-jxl/noise` entry estimates grain from opaque flat regions, removes part of that luminance residual before encoding, and writes the JPEG XL eight-point synthesis curve. It preserves the ordinary photo output when the evidence is insufficient or the requested quality falls outside its bounded range. Existing photo, screen, archive and lossless entry points are unchanged.

## Qualified scope

Automatic replacement is admitted only for eight-bit straight RGBA with ordinary sRGB color meaning, at quality 25 through 52. It needs at least four qualifying 16 by 16 patches and qualifying patches in at least one quarter of the image tiles. Other sample types, ICC profiles, other color/transfer declarations, premultiplied alpha, smaller images and qualities outside this interval take the ordinary encoding path. Quality 100 remains exact. Alpha samples are never denoised.

The evidence below consists of **two original, relatively small grain-bearing images at three byte budgets each**, plus nine clean controls. It establishes those six comparisons, not universal improvement throughout the admitted quality range or on modern phone RAW images. All measured photographic calls use effort 1 and the ordinary transform selection. Authored conformance cases additionally combine explicit transforms, progressive passes, LF frames and alpha.

## Public calls

```js
import {encodePhoto, encodePhotoSteps, photonNoise} from 'rapier-jxl/noise';
const bytes = encodePhoto(rgba, width, height, {quality: 35, noise: 'auto'});
const ordinary = encodePhoto(rgba, width, height, {quality: 35, noise: 'off'});
const cameraModel = encodePhoto(rgba, width, height, {quality: 80, noise: 1600});
```

`auto` is the default in this optional entry. Numeric ISO is an alias for the existing `{iso}` photon model; it adds modeled synthesis without estimating or removing source grain. Existing explicit eight-point arrays and `photon` remain accepted. Quality defaults to 90, where automatic source replacement is inactive. Incremental jobs retain eager input admission, progress reporting, cancellation and hurry completion.

## Matched-budget measurements

The source URLs, licenses, dimensions and original/decoded SHA-256 hashes are in [noise-corpus-sources.json](noise-corpus-sources.json). `phone-siemens-noise` is a Siemens C65 camera sample; `film-hp4-1600` is an original Ilford HP4 35 mm film crop exposed/developed at ISO 1600. Preparation decodes with Pillow 12.3.0 into straight RGBA8 without resizing. Both references are already JPEG-encoded source images.

Each ordinary file sets a byte budget. Ten binary-search probes over quality 1 through 99.9 select a candidate at or below that budget; the actual candidate quality and bytes are recorded, including quantization plateaus. Higher SSIMULACRA2 and lower Butteraugli are better. Timings include the whole synchronous call, including grain analysis, with ten warmups and seven samples pinned to CPU 0; the table shows medians.

| Source | Control quality | Bytes, off → auto | Auto quality | SSIMULACRA2, off → auto | Butteraugli, off → auto | Full encode ms, off → auto |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| phone-siemens-noise | 25 | 3763 → 3762 | 28.52588 | -4.15507 → -3.72188 | 6.57178 → 6.46023 | 12.59 → 31.95 |
| phone-siemens-noise | 35 | 5012 → 5000 | 43.01318 | 5.37200 → 6.15947 | 5.57164 → 5.52867 | 13.98 → 32.72 |
| phone-siemens-noise | 45 | 6324 → 6229 | 51.89873 | 13.69986 → 14.22917 | 5.35620 → 5.30288 | 13.53 → 32.87 |
| film-hp4-1600 | 25 | 6226 → 6217 | 27.65664 | 0.34091 → 1.00063 | 7.50850 → 7.30011 | 26.04 → 58.39 |
| film-hp4-1600 | 35 | 7995 → 7994 | 40.88838 | 13.64163 → 14.06692 | 6.95076 → 6.71799 | 24.04 → 58.26 |
| film-hp4-1600 | 45 | 9676 → 9676 | 50.54658 | 23.26505 → 23.43069 | 6.00883 → 5.43623 | 22.88 → 58.05 |

All six comparisons improve both metrics. The phone quality-45 candidate is 95 bytes below its 6324-byte budget; the table does not imply exact equal lengths. Low absolute scores also matter: these are deliberately constrained byte budgets, with substantial remaining distortion. Automatic analysis takes about 2–2.6 times the ordinary encode time on these two inputs.

### Clean controls

At quality 35, automatic analysis rejected grain on every control below. Each resulting file is **byte-identical** to the ordinary file, including transparent pixels. Analysis still costs time; the receipt preserves every timing sample rather than treating these identities as zero-cost.

| Source | Dimensions | Encoded bytes | Full encode ms, off → auto |
| --- | ---: | ---: | ---: |
| phone-flower | 2268 × 1512 | 128557 | 420.70 → 641.13 |
| phone-flower-crop | 1024 × 1024 | 47169 | 114.41 → 196.36 |
| photo-keong | 500 × 500 | 9846 | 31.62 → 42.17 |
| photo-ria | 500 × 500 | 8423 | 27.93 → 51.15 |
| photo-bliznaca | 500 × 500 | 11388 | 29.21 → 50.41 |
| ui-gd-paint | 1275 × 717 | 19043 | 101.91 → 114.04 |
| ui-editor | 1853 × 1016 | 47963 | 199.21 → 247.08 |
| alpha-globe | 512 × 512 | 14641 | 26.56 → 34.19 |
| alpha-isotiles | 1153 × 588 | 43603 | 98.13 → 89.80 |

The controls come from the existing [ideal corpus manifest](ideal-corpus-sources.json), including the original Pixel 6 flower image, its dependent crop, three Wesaturate photographs, two Godot screenshots and two alpha graphics. Full measurement values, source fingerprints and encoded SHA-256 hashes are in [noise-results.json](noise-results.json).

## Rejected broader synthesis

A preceding experiment removed a stronger residual (gain 0.8) and synthesized the full estimated removed variance. It regressed both metrics in all eight moderate/high-quality matched-budget comparisons. Those results are retained in [noise-rejected-results.json](noise-rejected-results.json). They are historical exploratory observations of the rejected precursor, not results produced by the bounded public `auto` option. Uncontrolled exploratory timings were discarded.

| Source | Control quality | SSIMULACRA2, ordinary → rejected | Butteraugli, ordinary → rejected |
| --- | ---: | ---: | ---: |
| phone-siemens-noise | 65 | 38.737 → 27.679 | 4.078 → 4.754 |
| phone-siemens-noise | 80 | 62.521 → 43.546 | 2.724 → 4.226 |
| phone-siemens-noise | 90 | 82.990 → 53.776 | 1.416 → 3.489 |
| phone-siemens-noise | 95 | 90.153 → 56.048 | 0.841 → 3.350 |
| film-hp4-1600 | 65 | 47.234 → 41.175 | 3.979 → 4.237 |
| film-hp4-1600 | 80 | 67.059 → 56.833 | 2.761 → 3.664 |
| film-hp4-1600 | 90 | 81.892 → 67.090 | 1.792 → 2.882 |
| film-hp4-1600 | 95 | 88.945 → 70.530 | 1.243 → 2.862 |

The shipped optional estimator uses gain 0.5 and one tenth of the fitted synthesis amplitude. This is intentionally weaker than variance-preserving grain reconstruction. It is not evidence for turning automatic grain synthesis on at moderate or high quality, or across all photo/web presets.

## Method and decoder proof

Patch admission uses a robust centered MAD of nonoverlapping 2 by 2 Haar high-frequency differences, detrended variance, clipping and level-diversity checks. A 5 by 5 local Wiener residual modifies only opaque RGB neighborhoods. The before/after patch variance and standard opsin derivative determine the eight-point curve. The curve uses a regularized fit without imposing monotonicity; values round to the actual ten-bit synthesis fields. The work uses bounded row accumulators and reuses its luminance allocation. Input buffers remain unchanged.

The normative synthesis stage is independently described by [libjxl 0.12.0 stage_noise.cc](https://github.com/libjxl/libjxl/blob/v0.12.0/lib/jxl/render_pipeline/stage_noise.cc), the random source by [dec_noise.cc](https://github.com/libjxl/libjxl/blob/v0.12.0/lib/jxl/dec_noise.cc), and the reference encoder estimator by [enc_noise.cc](https://github.com/libjxl/libjxl/blob/v0.12.0/lib/jxl/enc_noise.cc). These are format/algorithm references, not claims that the reference encoder enables synthesis by default. Its [enc_params.h](https://github.com/libjxl/libjxl/blob/v0.12.0/lib/jxl/enc_params.h) uses a minimum automatic-noise Butteraugli threshold of 99.

Three named source tests cover fourteen authored cases. jxl-oxide 0.12.6 and libjxl `djxl` 0.12.0 decode them with color agreement within one 8-bit code value and exact alpha. Chrome 155.0.8059.39 passes both native APIs for every case: 28 decodes, with 14 identical Node/browser encoded byte streams. The [native receipt](noise-native.json) records versions, launch flags and hashes. A separate canonical scoped-bundle test confirms all fourteen readable/minified byte identities.

## Reproduce

```sh
python bench/prepare-noise-corpus.py /tmp/noise-corpus
JXL_NOISE_CORPUS=/tmp/noise-corpus \
JXL_TOOLS=/path/to/libjxl-0.12.0/tools \
JXL_IDEAL_CORPUS=/path/to/prepared-ideal-corpus \
node bench/noise-rate-distortion.mjs
```

`JXL_NOISE_OUTPUT` selects the directory containing encoded and decoded candidates. `JXL_NOISE_RECEIPT` selects the JSON receipt. Preparation rejects any changed source or decoded-pixel hash. A broader original phone/film corpus and visual assessment remain necessary before considering automatic preset defaults.
