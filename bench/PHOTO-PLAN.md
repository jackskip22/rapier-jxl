# Retained photographic transforms and target byte budgets

`rapier-jxl/photo-plan` retains the main image’s unquantized YCbCr frequency coefficients once, then makes complete JPEG XL files at multiple qualities without repeating the main image’s color conversion or forward transforms. A target search measures actual complete files, including alpha, HF passes, LF frames, noise and container headers. It returns the highest quality **among the candidates it actually tested** that fits the byte budget.

This is the optional advanced YCbCr route. Its timings compare the same transform selection and entropy effort with and without retention. They do not compare against the package’s default perceptual XYB route, and they make no new perceptual quality claim.

## Calls and lifetime

```js
import {createPhotoPlan} from 'rapier-jxl/photo-plan';

const plan = createPhotoPlan(rgba, width, height, {
  quality: 87,
  transforms: 'auto',
  effort: 1,
  maxRetainedBytes: 256 * 1024 * 1024,
});
try {
  const preview = plan.encode(45);
  const result = plan.encodeTarget(50_000, {
    minQuality: 1,
    maxQuality: 99.9,
    maxProbes: 12,
  });
  // result.bytes is a complete file no larger than 50,000 bytes.
  // result.quality and result.probes describe the measured choice.
} finally {
  plan.dispose();
}
```

`createPhotoPlanSteps` exposes incremental preparation and puts the completed object on `job.plan`. The returned plan also has `encodeSteps(quality)` and `encodeTargetSteps(targetBytes, options)`. Encoding jobs keep the normal `bytes` result; target jobs expose both `bytes` and `result`. Set `job.hurry = true` to finish a target search once a complete fitting candidate is available. Search hurry never truncates a frame or silently lowers the candidate’s entropy effort. Calling `.return()` cancels an iterator without returning a partial file.

The immutable public plan reports `width`, `height`, `planningQuality`, `retainedBytes`, `blockCount`, `strategies` and `disposed`. `dispose()` releases the plan’s retained arrays. Subsequent encodes fail with `JXL_INPUT`. A normal encode admitted before disposal has its own reference and can finish. The plan never retains caller-owned pixel or quantization arrays; changing those arrays after preparation cannot change later encodes.

| Option or result | Behavior |
| --- | --- |
| `quality` | Planning quality; default 90, finite range 1 ≤ quality < 100. `encode()` defaults to this value. |
| `transforms` | The advanced transform selector, including all 27 standard strategies; default `auto` selects DCT8/DCT16. |
| Quantization and frame options | Existing raw/compact tables, custom DC, progressive passes, LF pyramids, explicit photon/LUT noise, alpha, orientation and sRGB/Display P3 admission are reused. LF pyramids currently require sRGB. |
| `maxRetainedBytes` | Default 256 MiB, positive integer up to 2 GiB. Conservative preflight rejects an excessive estimate before transforming pixels. |
| `targetBytes` | Positive integer no larger than the encoded-file limit. The limit applies to the final complete file. |
| `minQuality`, `maxQuality` | Search interval; defaults 1 and 99.9, with minimum no greater than maximum. |
| `initialQuality` | Optional previously measured quality inside the interval, probed after the maximum. Useful when a known candidate lies near a narrow size minimum. |
| `maxProbes` | Maximum complete entropy candidates, 2–32; default 12. The search can finish earlier. |
| `result.probes` | Ordered `{quality, bytes}` records. `bytes: null` means that candidate exceeded the encoded-file limit. |

Inputs are eight-bit RGB/RGBA with sRGB transfer and no arbitrary ICC profile. Native-depth, floating-point, ICC and quality-100 lossless calls continue through their existing entries. Automatic source-grain estimation is not part of this entry; an explicit noise LUT or photon model can be retained with the plan.

## What is retained

Planning selects and fixes a transform layout at `planningQuality`. Each selected block retains Float64 frequency coefficients and its unquantized LF samples. Later candidates regenerate integer coefficients, quantization tables and ordinary entropy sections. Small LF-pyramid intermediates are regenerated from each candidate’s quantized DC; their small transforms still run. The main image’s RGB conversion, forward DCT/AFV transforms and layout search do not run again.

With an explicit single transform strategy, a given quality produces the exact same bytes as an uncached advanced encode with that strategy. An automatic layout reproduces the uncached encoder at its planning quality. At another quality it deliberately keeps the planned layout; a fresh automatic encode could select different blocks.

`retainedBytes` counts unique reachable typed-array buffers, including frequency coefficients, LF samples, scan arrays, block maps, optional alpha snapshots and custom typed tables. It excludes JavaScript object overhead, shared global transform bases and transient candidate/output buffers. For opaque sources, the main retained storage is approximately 24.44 bytes per padded pixel plus scan/table data; alpha adds a copied four-byte-per-pixel source buffer. Preflight conservatively includes possible alpha even when the source is opaque. Caller input and temporary working memory are additional to the retained-byte limit.

## Search behavior and limits

JPEG XL size is not guaranteed to decrease at every lower quality. Quantization table encodings, entropy choices, alpha and LF overhead can produce local minima. The search probes the maximum, an optional known quality, the minimum, then several points across the interval before refining near the highest fitting sample. If no sampled file fits, it refines near the smallest measured file.

A regression fixture has 1,456 bytes at quality 1, 1,307 at quality 45, 1,346 at quality 50 and 1,263 at quality 80. Assuming monotonic size would miss useful choices. Another LF/alpha fixture has a particularly narrow minimum near quality 45; supplying `initialQuality: 45` preserves that known feasible candidate. A finite probe budget still cannot guarantee global optimality or find every feasible narrow minimum. `JXL_SIZE` therefore says **no probed quality fits**, and reports the smallest measured file; it does not claim that no possible quality could fit.

All target results are deterministic for the same plan, search options and hurry behavior. There is no hidden prior-search state. A target search keeps its best measured complete file while exploring; a later unsuccessful candidate cannot replace it.

## Complete Corpus v1 measurements

The five original-size inputs come from the pinned [complete-corpus manifest](../test/complete-corpus/manifest.json). Both DCT8 and DCT16 are measured at effort 1, planning quality 87. Four-quality encoding uses 35, 55, 75 and 90. Target budgets equal the corresponding ordinary quality-55 files, with `initialQuality: 55` and at most 12 probes. All ten searches select quality 55 and exactly match those complete-file budgets.

Node 22.23.3 on an AMD EPYC 9V74 measured each full call on CPU 0 with three warmups and five samples after an initial shared-code warmup. The table reports medians. The [raw receipt](photo-plan-results.json) records every sample, source/input/output SHA-256, candidate quality/size, retained byte count and independent decoder result.

| Input | Size | Transform | Target bytes | Retained MiB | Plan ms | Four qualities cached / rebuilt ms |
| --- | --- | --- | ---: | ---: | ---: | ---: |
| ui-light | 640×480 | dct8 | 14,832 | 7.16 | 271.18 | 329.16 / 746.72 |
| ui-light | 640×480 | dct16 | 17,566 | 7.16 | 99.21 | 202.27 / 394.75 |
| drawing-labels | 512×384 | dct8 | 8,867 | 4.58 | 94.42 | 197.30 / 408.73 |
| drawing-labels | 512×384 | dct16 | 12,720 | 4.58 | 66.76 | 155.63 / 269.71 |
| control-paint-0001-512x384 | 512×384 | dct8 | 52,812 | 5.33 | 104.47 | 236.06 / 452.96 |
| control-paint-0001-512x384 | 512×384 | dct16 | 54,432 | 5.33 | 66.68 | 209.36 / 325.03 |
| grace-hopper | 512×600 | dct8 | 18,467 | 7.16 | 194.94 | 316.94 / 854.74 |
| grace-hopper | 512×600 | dct16 | 19,325 | 7.16 | 101.85 | 196.81 / 458.66 |
| terminal-code | 512×384 | dct8 | 16,985 | 4.58 | 104.35 | 214.80 / 421.49 |
| terminal-code | 512×384 | dct16 | 18,694 | 4.58 | 65.40 | 134.70 / 283.45 |

The target comparison rebuilds the exact same recorded probe qualities through the ordinary advanced encoder and checks the selected bytes. “One shot” measures creating a fresh plan plus its full search; it includes initial planning rather than adding separately measured medians.

| Input | Transform | Cached search ms | Rebuilt search ms | One shot ms | Cached speedup | One-shot speedup |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| ui-light | dct8 | 915.60 | 2144.02 | 1316.71 | 2.34× | 1.63× |
| ui-light | dct16 | 577.70 | 1242.16 | 756.97 | 2.15× | 1.64× |
| drawing-labels | dct8 | 650.26 | 1283.79 | 851.93 | 1.97× | 1.51× |
| drawing-labels | dct16 | 375.00 | 795.04 | 517.50 | 2.12× | 1.54× |
| control-paint-0001-512x384 | dct8 | 762.05 | 1494.46 | 931.28 | 1.96× | 1.60× |
| control-paint-0001-512x384 | dct16 | 543.47 | 979.01 | 661.04 | 1.80× | 1.48× |
| grace-hopper | dct8 | 1264.08 | 2300.80 | 1347.75 | 1.82× | 1.71× |
| grace-hopper | dct16 | 691.02 | 1345.34 | 860.47 | 1.95× | 1.56× |
| terminal-code | dct8 | 636.60 | 1256.23 | 777.97 | 1.97× | 1.61× |
| terminal-code | dct16 | 405.74 | 825.79 | 533.12 | 2.04× | 1.55× |

Across these ten configurations, four-quality reuse is 1.55–2.70× faster, cached target searches are 1.80–2.34× faster, and complete one-shot plan-plus-search calls are 1.48–1.71× faster than rebuilding the same candidate trace. Retained typed buffers range from 4.58 to 7.16 MiB. These five small inputs establish the benefit of avoiding repeated transforms; they do not establish throughput or memory behavior for every image size, machine, strategy or entropy effort.

## Proof and reproduction

The 39-case fixture set includes all 27 strategies, automatic layout, rectangular raw tables, compact DCT/AFV tables, custom DC, wide signed coefficients, effort-3 ANS selection, alpha across group boundaries, spectral/successive passes, LF pyramids, explicit noise with cropping, and Display P3. The combined alpha/noise/progressive/LF case checks composed whole-file budgeting.

The direct source suite passes five named tests. Every final fixture decodes with libjxl `djxl` 0.12.0 and jxl-oxide 0.12.6, with RGB disagreement no greater than one eight-bit level and exact alpha. Chrome 155.0.8059.39 performs 78 native decodes through `createImageBitmap` and `ImageDecoder`, and reproduces all 39 Node encoder byte strings. Display P3 compares in a matching P3 canvas. [Native evidence](photo-plan-native.json) records command-line switches and per-case pixel/output hashes.

The canonical minifier reproduces all 39 readable outputs and public methods/results. The isolated measurement graph is 94,588 minified bytes and 34,741 gzip bytes. After merging the optional TOC-permutation reader, the standalone entry is 95,171 minified bytes and 34,964 gzip bytes; all 39 minified outputs remain identical. The common strategy refactor also preserves all 39 uncached pre-refactor ordinary outputs; [the baseline receipt](photo-plan-baseline.json) records both strategy-source hashes and all output hashes. The baseline test covers the affected uncached advanced path; package byte-pin checks remain part of the integration gate.

Run from the repository root with the documented independent-decoder environment:

```sh
node repo/images/jxl/test/photo-plan.test.mjs
node repo/tools/check-jxl-photo-plan.mjs
JXL_NATIVE_CHROME=/path/to/chrome-155 JXL_NATIVE_PLAYWRIGHT=/path/to/playwright-core/index.mjs \
  node repo/images/jxl/test/native-photo-plan.test.mjs
JXL_DJXL=/path/to/libjxl-0.12.0/tools/djxl taskset -c 0 \
  node repo/images/jxl/bench/photo-plan.mjs photo-plan-results.json
```

The source and native tests also require `JXL_DJXL`; jxl-oxide uses the repository’s pinned decoder. Final package-stage and combined-worker receipts cover integration separately from this standalone feature measurement.
