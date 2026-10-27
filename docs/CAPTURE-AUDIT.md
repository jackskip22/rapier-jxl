# Capture encoder audit

**The capture worker and client ship 21,775 gzip bytes.** The snapdom adapter adds 400. No optional GPU download or WASM file is required. This is a different, capture-specific entry; the original native/HDR/photographic core and every advanced feature remain available.

On the opaque mixed DOM fixture, lossless capture produces **342,821 bytes at FHD** and **896,177 at 4K**, versus browser PNG's 804,840 and 2,404,437. PNG is much faster. WebP lossless and libjxl can produce smaller files. This is a small JavaScript encoder with explicit tradeoffs, not a universal compression or speed winner.

The original 28,920-byte core includes exact Modular, lossy Squeeze and effort 1 photographic coding, native samples/HDR/ICC/alpha. It excludes the expensive screen/photo searches. Its optional GPU import adds 6,080 bytes. On these exact captures it produces 513,838/1,490,811 bytes; the original effort 9 produces 275,041/692,029, costing about 60 seconds/342 seconds for the first encode on this host. The core is **86.8%/115.4% larger** than those best measured JavaScript lossless files. On the photo at the same decoded quality, core 30,112 bytes versus photo effort 7's 26,509 is **13.6% larger**.

## Measurement limits

Hosted Linux x86_64, AMD EPYC 9V74, Node 24 and Chrome 155. CPU quotas and exact versions are in the receipts. These are **not physical laptop or phone measurements**. Hardware latency/memory budgets remain unqualified. Product qualification targets are laptop FHD ≤1 s / 4K ≤3 s and phone FHD ≤2.5 s / 4K ≤8 s. These are targets, not hardware results or API guarantees. Browser GPU auto fell back to CPU because the default adapter was unavailable; software-GPU correctness is separate from hardware performance.

Cold JS includes module/worker initialization; warm is the median of recorded repeats. Native CLI timings also include process start, PNG decode and file write, and their repeats are fresh processes. Peak memory is whole-process RSS, including input/runtime/worker, not incremental codec allocation. Browser native/GPU peaks were not exposed and are left unmeasured. Some diagnostic/audit timings ran while other work shared the host; the headline Node codec run was serialized after build/browser work stopped. Inspect each row's run and timing field before comparing.

The photo is a pinned CC0 image, 500×500; all raw codecs receive the same sRGB samples. Native reference inputs strip source Exif/ICC/text metadata without changing RGBA. SSIMULACRA2 is measured on independently decoded 8-bit PNGs, so the comparison includes 8-bit output quantization. Alpha and RGB under zero alpha are included in exact native comparisons.

## Every original entry

6.1.1 at `3d36f51c36843a7d2965af2f525504047aa2f8a3`. Equivalent source/min aliases are grouped; [the machine inventory](../bench/capture/baseline-audit.json) lists all 67 export mappings, files, hashes and dependency closures. The old size manifest says 6.1.0, but these are the actual 6.1.1 files.

File/score and timing use the common 500×500 photo. Exact rows compare native cjxl 0.12.0 e7/e9 at score 100. Lossy comparisons show actual cjxl bytes and achieved score; **† means no match within +0.15**, so no matched-quality win is claimed. The JPEG rows compare byte-exact JPEG reconstruction, not a fresh lossy encode. One-frame animation/one-layer/one identical patch/zero-amplitude spline probes measure API overhead, not compression benefits of those features. Old worker rows reuse their engine's main-thread probe; they do not claim measured worker startup. Current worker round trips are measured below. Utilities cannot independently encode this input: N/A is deliberate.

| Entry/build | Gzip shipped B | Modes | Output B / native score | Cold / warm ms | cjxl e7 / e9 comparison |
|---|---:|---|---:|---:|---|
| index | 28,920 + 6,080 GPU | Exact Modular; lossy Squeeze or photographic effort 1; native/HDR/ICC/alpha | 312,610 / 100.00 | 132 / 77 | +21.5% / +23.6% |
| jpeg | 32,866 | Reversible JPEG coefficient transcode/reconstruction | 62,392 / 86.24 | 347 / 214 | +9.5% / +10.3% (JPEG exact) |
| photo | 60,943 | Photographic quality/entropy search; exact alpha; quality100 exact | 26,074 / 77.21 | 30,947 / 29,963 | 30,156 B @77.33 / 29,360 B @77.25 |
| photo-advanced | 70,042 | Explicit transforms, progressive passes and coefficient orders | 26,509 / 77.83 | 1,095 / 566 | 31,185 B @77.90 / 30,199 B @77.96 |
| photo-plan | 45,479 | Retained transform plan; encode quality or target bytes | 35,527 / 79.70 | 901 / 604 | 33,685 B @79.71 / 33,227 B @79.76 |
| photo-noise | 82,737 | Photo + optional grain estimation/synthesis | 26,509 / 77.83 | 1,185 / 534 | 31,185 B @77.90 / 30,199 B @77.96 |
| hybrid | 63,835 | Exact regions over a photographic base | 34,007 / 80.66 | 1,102 / 693 | 35,531 B @80.69 / 34,602 B @80.73 |
| graphics | 40,663 | Exact or bounded-error palettes/undither | 312,610 / 100.00 | 1,556 / 1,085 | +21.5% / +23.6% |
| icc | 14,780 | Profile/color metadata with exact/native samples | 318,563 / 100.00 | 118 / 77 | +23.8% / +25.9% |
| opsin | 28,782 | Opsin header/transform composition | N/A | N/A | N/A |
| delta-palette | 34,040 | Exact or authored delta palettes | 312,610 / 100.00 | 1,266 / 1,153 | +21.5% / +23.6% |
| splines | 35,847 | Authored XYB curves over a photographic base | 37,215 / 81.24 | 195 / 97 | 36,295 B @81.28 / 36,388 B @81.25 |
| channels | 31,704 | Planar native samples + typed extra channels | 312,635 / 100.00 | 323 / 188 | +21.5% / +23.6% |
| layers | 35,140 | Layered sample/frame composition | 312,635 / 100.00 | 225 / 147 | +21.5% / +23.6% |
| patches | 53,730 | Authored atlas and patch dictionaries | 321,640 / 100.00 | 147 / 63 | +25.0% / +27.2% |
| jpeg-ans | 44,543 | Same JPEG custody with ANS search | 58,132 / 86.24 | 838 / 359 | +2.0% / +2.8% (JPEG exact) |
| photo-ans | 60,898 | Photographic ANS search | 26,509 / 77.83 | 1,274 / 694 | 31,185 B @77.90 / 30,199 B @77.96 |
| animation | 86,778 | Timed frames and changed rectangles | 312,613 / 100.00 | 154 / 74 | +21.5% / +23.6% |
| animation-atlas | 102,380 + 6,080 GPU | Animation with shared patch atlas | 312,613 / 100.00 | 201 / 97 | +21.5% / +23.6% |
| effort | 78,503 + 6,080 GPU | Core + effort 1–9, screen/palette/patch and photo searches | 250,908 / 100.00 | 39,474 / 32,624 | -2.5% / -0.8% |
| metadata | 12,592 | Read/write metadata boxes | N/A | N/A | N/A |
| brotli | 5,484 | Metadata compression | N/A | N/A | N/A |
| container-stream | 3,358 | Container framing/streaming | N/A | N/A | N/A |
| container-advanced | 15,778 | Container inspection, frame index and gain maps | N/A | N/A | N/A |
| progressive-container | 20,337 | Progressive container delivery | N/A | N/A | N/A |
| delivery | 17,920 | Group order/region delivery | N/A | N/A | N/A |
| wasm | 88,190 | Effort + embedded scalar/SIMD kernels | 250,908 / 100.00 | 30,647 / 29,947 | -2.5% / -0.8% |
| image | 1,184 | Input/worker adapter; an encoder is still required | N/A | N/A | N/A |
| rapier | 214,402 + 6,080 GPU | Complete still/animation/JPEG/metadata/GPU engine | 26,509 / 77.83 | 893 / 373 | 31,185 B @77.90 / 30,199 B @77.96 |
| rapier-worker | 214,332 + 6,080 GPU | Complete worker | 26,509 / 77.83 | engine main: 893 / 373 | 31,185 B @77.90 / 30,199 B @77.96 |
| gpu-core | 6,080 | Optional photographic GPU kernels | N/A | N/A | N/A |
| rapier-still-worker | 149,572 + 6,080 GPU | Still/JPEG/metadata worker | 26,509 / 77.83 | engine main: 708 / 455 | 31,185 B @77.90 / 30,199 B @77.96 |
| score (source graph) | 133,531* | Search candidate/quality against a perceptual target | 38,962 / 84.12 | 76,091 / — | 43,835 B @84.18 / 42,396 B @84.19 |
| writer (source graph) | 49,662* | Low-level format writer and lossless/lossy/VarDCT kernels | 312,610 / 100.00 | 100 / 50 | +21.5% / +23.6% |
| source (source graph) | 25,634* | Source sample/color preparation | N/A | N/A | N/A |
| kernels (source graph) | 27,526* | Optional arithmetic kernels | N/A | N/A | N/A |

*Source-only entries show separately-gzipped source dependencies, not a minified bundle. The score wrapper alone is 1,271 bytes but its complete source graph is 133,531; writer/source/kernels have the same accounting rule. The image wrapper's 1,184 bytes exclude its required encoder. Package JSON is metadata, not encoder code. The old manifest's hypothetical combined-all build was 215,724 gzip bytes, not a shipped entry.

### High quality and the score correction

The audit found an inflated internal SSIMULACRA2 result. At a target of 85 the original search returned 38,962 bytes and reported 85.04924; native decoding scored 84.26455 directly from JXL and 84.12127 after 8-bit PNG quantization. The metric now agrees with native libjxl on identical reference/distorted pixels, including alpha's two-background policy. Candidate choice compares completed stream lengths, and an unmet internal target is an explicit error.

The corrected target-85 search returns **41,005 bytes**, internal 85.00270, native JXL 85.00051, and decoded 8-bit 84.83830. Direct JXL and 8-bit PNG are different measurement conventions; the table consistently matches the latter. This is a search over supported candidates, not proof of the global smallest possible file or an external-decoder quality guarantee. This one photo is evidence, not a general photo-corpus win.

| Current path / reference | File B | Native SSIMULACRA2, decoded 8-bit | Cold encode ms |
|---|---:|---:|---:|
| Photo target 85, corrected search | 41,005 | 84.84 | 61,173 |
| cjxl e7, matched decoded pixels | 45,700 | 84.88 | 164 |
| cjxl e9, matched decoded pixels | 45,186 | 84.92 | 850 |

The corrected result is 10.3%/9.3% smaller than those matched e7/e9 files, but the search takes about 61 seconds on this 500×500 fixture. The fixed-quality photo effort-9 path remains 26,074 bytes at 77.21, measured again after the search changes. Use the worker for photo work and measure the quality/speed tradeoff on the host's actual corpus.

## Size delta for every new build

Before is the old complete download closure, including optional GPU imports. After is one eager, self-contained bundle. This compares released files with the new reproducible esbuild/terser build; it is **not** a same-minifier attribution of source savings. Source-only entries compare their old unminified import graphs with the new bundle. The new photo entry includes score search, async input and GPU integration that were separate before. License notices are included in the measured bundles. Old `rapier` becomes `full`; the broad still worker is replaced by focused capture/photo workers while full retains its advanced features. No sum of the table is a normal integrator download.

| Build | Before gzip B | After gzip B | Delta B |
|---|---:|---:|---:|
| capture.min.mjs | — | 18,662 | new |
| image.min.mjs | 1,184 | 2,755 | 1,571 |
| capture-worker.js | — | 19,020 | new |
| core.min.mjs | 35,000 | 33,998 | -1,002 |
| jpeg.min.mjs | 32,866 | 33,185 | 319 |
| photo.min.mjs | 60,943 | 84,352 | 23,409 |
| score.min.mjs | 133,531 | 71,704 | -61,827 |
| photo-advanced.min.mjs | 70,042 | 70,585 | 543 |
| photo-plan.min.mjs | 45,479 | 44,799 | -680 |
| noise.min.mjs | 82,737 | 72,450 | -10,287 |
| hybrid.min.mjs | 63,835 | 56,049 | -7,786 |
| graphics.min.mjs | 40,663 | 36,692 | -3,971 |
| icc.min.mjs | 14,780 | 15,001 | 221 |
| opsin.min.mjs | 28,782 | 10,666 | -18,116 |
| delta-palette.min.mjs | 34,040 | 34,669 | 629 |
| splines.min.mjs | 35,847 | 35,818 | -29 |
| channels.min.mjs | 31,704 | 29,565 | -2,139 |
| layers.min.mjs | 35,140 | 32,981 | -2,159 |
| patches.min.mjs | 53,730 | 42,748 | -10,982 |
| jpeg-ans.min.mjs | 44,543 | 44,984 | 441 |
| photo-ans.min.mjs | 60,898 | 63,711 | 2,813 |
| animation.min.mjs | 86,778 | 89,889 | 3,111 |
| animation-atlas.min.mjs | 108,460 | 94,948 | -13,512 |
| effort.min.mjs | 84,583 | 86,716 | 2,133 |
| writer.min.mjs | 49,662 | 28,849 | -20,813 |
| source.min.mjs | 25,634 | 8,392 | -17,242 |
| metadata.min.mjs | 12,592 | 8,686 | -3,906 |
| brotli.min.mjs | 5,484 | 5,442 | -42 |
| container.min.mjs | 3,358 | 2,966 | -392 |
| container-advanced.min.mjs | 15,778 | 14,629 | -1,149 |
| progressive-container.min.mjs | 20,337 | 14,952 | -5,385 |
| delivery.min.mjs | 17,920 | 13,194 | -4,726 |
| kernels.min.mjs | 27,526 | 11,137 | -16,389 |
| wasm.min.mjs | 88,190 | 91,387 | 3,197 |
| full.min.mjs | 220,482 | 213,027 | -7,455 |
| photo-worker.js | — | 84,664 | new |
| full-worker.js | 220,412 | 213,150 | -7,262 |

## Full HD and 4K comparisons

Opaque real snapdom scene: text/table UI, gradients, shadows and an embedded CC0 photo. Native libjxl 0.12.0 and wasm-vips 0.0.19 are versioned explicitly; jSquash 1.3.0 uses its own bundled libjxl. The optimized PNG is native oxipng 9.1.5, not a claimed browser download. Browser PNG/WebP incur no extra encoder payload. Native WebP lossless uses `-lossless -exact -z6`; canvas does not expose an explicit lossless WebP setting.

| Input | Codec | File B | Main cold / warm ms | Worker cold / warm ms | Peak RSS MiB main / worker | Native score |
|---|---|---:|---:|---:|---:|---:|
| FHD | core-lossless | 513,838 | 251 / 208 | — | 74 | 100.00 |
| FHD | capture-lossless | 342,821 | 1,009 / 880 | 1,161 / 1,139 | 370 / 426 | 100.00 |
| FHD | jsquash-e7-lossless | 284,949 | 4,242 / 3,587 | 4,788 / 3,614 | 443 / 487 | 100.00 |
| FHD | vips-e3-lossless | 425,715 | 947 / 530 | 1,013 / 564 | 279 / 345 | 100.00 |
| FHD | vips-e7-lossless | 299,968 | 2,268 / 1,456 | 1,658 / 1,468 | 270 / 337 | 100.00 |
| FHD | cjxl-e7-lossless | 299,968 | 1,081 / 1,217 | — | 103 | 100.00 |
| FHD | cjxl-e9-lossless | 276,709 | 4,852 / 4,973 | — | 103 | 100.00 |
| FHD | webp-lossless | 277,078 | 430 / 460 | — | 51 | 100.00 |
| FHD | webp-q90 | 96,666 | 137 / 144 | — | 13 | 84.49 |
| FHD | png-oxipng4 | 376,634 | 2,419 / 2,464 | — | 71 | 100.00 |
| FHD | browser-png | 804,840 | 33 / 22 | — | unmeasured | 100 (exact samples) |
| FHD | browser-webp-q90 | 96,958 | 136 / 130 | — | unmeasured | not scored here |
| 4K | core-lossless | 1,490,811 | 987 / 850 | — | 192 | 100.00 |
| 4K | capture-lossless | 896,177 | 3,333 / 2,742 | 3,357 / 3,116 | 434 / 621 | 100.00 |
| 4K | jsquash-e7-lossless | 708,933 | 11,277 / 9,933 | 12,808 / 10,207 | 1,510 / 1,627 | 100.00 |
| 4K | vips-e3-lossless | 1,178,553 | 2,721 / 2,126 | 2,534 / 2,121 | 685 / 848 | 100.00 |
| 4K | vips-e7-lossless | 707,526 | 5,465 / 4,892 | 4,985 / 4,564 | 707 / 865 | 100.00 |
| 4K | cjxl-e7-lossless | 707,526 | 3,630 / 3,632 | — | 267 | 100.00 |
| 4K | cjxl-e9-lossless | 618,691 | 16,756 / 17,513 | — | 271 | 100.00 |
| 4K | webp-lossless | 688,474 | 2,138 / 1,854 | — | 193 | 100.00 |
| 4K | webp-q90 | 204,354 | 567 / 540 | — | 48 | 82.97 |
| 4K | png-oxipng4 | 1,090,309 | 7,885 / 8,667 | — | 184 | 100.00 |
| 4K | browser-png | 2,404,437 | 92 / 71 | — | unmeasured | 100 (exact samples) |
| 4K | browser-webp-q90 | 204,828 | 531 / 509 | — | unmeasured | not scored here |

Browser-format rows and Node rows are separate runtimes; use them as environment-specific observations, not a pure language comparison. wasm-vips uses one thread and Cache.max(0). The 4K effort 7 row has one warm repeat: a separate repeated-queue diagnostic failed on its third encode with JxlEncoderAddImageFrame, even after cached operation graphs were released. Cold/first-warm successes and that limitation are both retained.

Reference payload: jSquash single-thread factory+WASM **529,987 gzip bytes**. wasm-vips JXL side module **798,402**; browser JS+base WASM+JXL **2,853,610**. These exclude unrelated decoders/HEIF modules. Tarball hashes, actual file sizes and versions are in [toolchain.json](../bench/capture/toolchain.json).

### Browser capture path

Fresh page, first encode plus three repeats. No hardware GPU speed claim. Exact opaque captures also round-trip byte-for-byte through Chrome's native JXL decoder. On alpha captures, the codec preserves all source samples in djxl; canvas's native decode/readback rounds RGB at partial alpha. Alpha, opaque RGB and fully transparent RGB remain exact in the browser diagnostic. Do not describe that readback as universal byte equality.

| Input | Execution | JXL B | Cold / warm ms | Browser decode |
|---|---|---:|---:|---|
| snapdom-opaque-1920x1080 | main | 342,821 | 940 / 854 | exact RGBA |
| snapdom-opaque-1920x1080 | worker | 342,821 | 1,102 / 995 | exact RGBA |
| snapdom-opaque-3840x2160 | main | 896,177 | 4,303 / 3,404 | exact RGBA |
| snapdom-opaque-3840x2160 | worker | 896,177 | 3,010 / 2,603 | exact RGBA |
| snapdom-alpha-1920x1080 | main | 351,207 | 1,036 / 974 | native decoded; alpha readback rounding |
| snapdom-alpha-1920x1080 | worker | 351,207 | 1,217 / 959 | native decoded; alpha readback rounding |
| snapdom-alpha-3840x2160 | main | 919,699 | 3,125 / 2,910 | native decoded; alpha readback rounding |
| snapdom-alpha-3840x2160 | worker | 919,699 | 3,352 / 2,792 | native decoded; alpha readback rounding |
| snapdom-nested-demo-1920x1080 | main | 16,152 | 391 / 336 | native decoded; alpha readback rounding |
| snapdom-nested-demo-1920x1080 | worker | 16,152 | 444 / 374 | native decoded; alpha readback rounding |

### Bounded loss is explicit

`maxError:2` keeps alpha and fully transparent RGB exact and bounds every other RGB sample's change to 2. On the mixed scene it produces 188,133/491,250 bytes, with native scores 81.69/80.98. That is **not a visually-lossless promise**. FHD cjxl e7 matched 81.70 in 88,803 bytes and e9 matched 81.74 in 93,068. Lossless remains the default.

## Evidence and reproduction

[Node/native results](../bench/capture/results.json), [browser results](../bench/capture/browser-results.json), [module probes](../bench/capture/module-probes.json), [matched-quality probes](../bench/capture/module-matched.json), [capture matches](../bench/capture/capture-matched.json), [source fixtures](../bench/capture/fixtures/manifest.json). Every delivered exact file checked by the harness matches all decoded RGBA samples. JPEG probes reconstruct the original JPEG byte-for-byte through djxl and the JavaScript reconstruction API.

```sh
npm install --ignore-scripts --package-lock=false
npm run build
node bench/capture/setup.mjs /tmp/rapier-capture-tools
mkdir -p /tmp/rapier-before
git archive 3d36f51c36843a7d2965af2f525504047aa2f8a3 src dist package.json | tar -x -C /tmp/rapier-before
node bench/capture/run.mjs --tools /tmp/rapier-capture-tools --baseline /tmp/rapier-before --out /tmp/capture-results --timeout 900000
node bench/capture/module-probes.mjs --tools /tmp/rapier-capture-tools --baseline /tmp/rapier-before --out /tmp/module-probes
node bench/capture/match.mjs /tmp/module-probes/module-probes.json --tools /tmp/rapier-capture-tools --out /tmp/module-matched --all-modules
node bench/capture/browser.mjs
```

The original effort 9 searches take minutes at 4K. Browser scripts use Playwright/Chromium; see the snapdom example README for local serving and fixture regeneration. Sources: [snapdom pinned API](https://github.com/zumerlab/snapdom/tree/f7bb642d83ece9f6efdca0825ab87bb7b2274650), [libjxl 0.12.0](https://github.com/libjxl/libjxl/releases/tag/v0.12.0), [wasm-vips 0.0.19](https://www.npmjs.com/package/wasm-vips/v/0.0.19), [jSquash 1.3.0](https://www.npmjs.com/package/@jsquash/jxl/v/1.3.0).
