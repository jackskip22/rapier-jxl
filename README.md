# Rapier JXL

JPEG XL encoder in JavaScript. Browsers, workers, Node and Deno. MIT, no dependencies.

The core and the search are different encoders. The core is the 29 KB one. The files that beat libjxl come from the effort search.

| Entry | Gzip | What the bytes are |
| --- | ---: | --- |
| Core · `rapier-jxl` | 28,920 | Fast lossless, and lossy photographs at effort 1. On 24 Kodak photos at SSIMULACRA2 80 this entry is about **1.3% larger** than `cjxl -e 7`. |
| Effort · `rapier-jxl/effort` | 78,503 | The search in the table below. Effort 7 on those Kodak photos is about **8.2% smaller** than `cjxl -e 7` at SSIMULACRA2 80. At 12 MP that same effort is about **4.5% larger**. |
| Capture · `rapier-jxl/capture` | screen coder, not a second core | Lossless screen captures, with an optional near-lossless setting. One SIMD context-model pass. It does not run the effort 7 ladder. |

| Same visual quality, 24 Kodak photos | Entry | Against |
| --- | --- | --- |
| `cjxl -e 9`, across the SSIMULACRA2 range | effort 7 | 5–7% smaller |
| `cjxl -e 9`, by Butteraugli | effort 9 | up to 5% smaller |
| AVIF | effort 7 | 4–20% smaller |
| WebP | effort 7 | 15–23% smaller |
| JPEG (mozjpeg) | effort 7 | 19–43% smaller |
| JPEG carried in, restored byte for byte (24 of 24) | effort 9 | 15% smaller |
| libjxl in WebAssembly | | 962 KB gzipped |

The Kodak percentages above are the effort entry. They are not a claim about the 29 KB core. Method and the older sweep: [docs/ENCODER-COMPARISON.md](docs/ENCODER-COMPARISON.md). The 1.3%, 8.2% and 12 MP figures are the independent October 2026 measurements.

```sh
npm install rapier-jxl
```

## Capture a screen

```js
import {encodeCapture} from 'rapier-jxl/capture';
const bytes = await encodeCapture(rgba, width, height); // lossless JPEG XL
```

On a document this runs in a module worker, one capture at a time. `worker: false` encodes on the caller. The result is exact unless `nearLossless: true`. A page of up to 16,384 colours uses a palette and the SIMD context model. A flat gradient above that uses the same model on the colour channels. A photograph uses the core exact encode. The exact encode is skipped when a coarse residual estimate already shows the screen file is smaller.

Antialiased text was the mixed-page loss. Hacker News, GitHub, MDN and the chart page each have 4,300–10,400 colours, over the old 4,096-colour palette, so the previous capture wrote three residual channels and landed around 210 KB. The capture palette now holds 16,384 colours. Those pages encode as one index plane.

`nearLossless` moves only high-contrast samples, by at most `maxColorError` (default 6). Flat colour and gradients stay exact. The smaller of the two files is returned. On the pages below that score is about 87–93 SSIMULACRA2.

Times are a warm Node process on this machine. A fresh process spends about 140–160 ms on the first full-HD frame, including the kernel compile. The worker encodes a blank 64×64 frame at load. WebP quality 90 below is the file size; the 135 ms figure is the earlier Chrome encode of a different dashboard, not a fresh timing of each of these pages.

| Full HD | PNG | WebP q90 | Lossless | Warm | Near-lossless | Warm | Score |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Drawn dashboard | 145 KB | 86 KB | 34,641 | 99 ms | 28,672 | 0.41 s | 89.7 |
| Dense text | 196 KB | 203 KB | 38,311 | 85 ms | 34,529 | 0.38 s | 90.4 |
| example.com | 91 KB | 56 KB | 52,599 | 71 ms | 39,833 | 0.31 s | 92.5 |
| Hacker News | 244 KB | 139 KB | 98,752 | 78 ms | 86,679 | 0.33 s | 89.7 |
| GitHub | 232 KB | 138 KB | 124,464 | 81 ms | 93,071 | 0.33 s | 89.9 |
| GitHub, dark | 232 KB | 130 KB | 126,565 | 83 ms | 96,381 | 0.33 s | 92.8 |
| MDN | 251 KB | 163 KB | 146,913 | 82 ms | 120,288 | 0.33 s | 90.3 |
| Chart.js docs | 214 KB | 160 KB | 111,485 | 76 ms | 96,785 | 0.35 s | 90.4 |
| Drawn gradient | 214 KB | 62 KB | 149,331 | 108 ms | 126,805 | 0.41 s | 87.4 |

djxl restored every lossless file to the same pixels. The drawn dashboard is 5.5% larger than its effort 7 screen file (32,843 bytes, 7.5 s). Dense text is 38,311 bytes; the patch pass that reached 19,186 bytes took about a second and is not on this path. The drawn gradient has 27,263 colours, so it misses the palette. Lossy WebP is smaller there, and the near-lossless file is still larger than that WebP. A 4K version of the same gradient was 469,991 bytes in 0.36 s, against a 740 KB PNG.

The reference from snapdom 3.4.0, a different full-HD dashboard: PNG 402 KB in 41 ms, WebP 135 KB in 135 ms, lossless effort 1 at 221 KB in 76 ms, effort 3 at 177 KB in 518 ms, effort 7 at 49 KB in 4.0 s. Those pixels were not in this run. Kodak kodim01 stays on the core exact encode: 531,645 bytes either way.

## Encode pixels to a score

```js
import {encodeToScore} from 'rapier-jxl/score';
const {bytes} = await encodeToScore(rgba, width, height, {target: {ssimulacra2: 80}, gpu: device});
```

Returns the smallest file that meets the score. `gpu` is an optional `GPUDevice`; without it the search runs on the CPU.
For a fixed quality, `encode(rgba, width, height, {quality: 90})` from `rapier-jxl` is the core, effort 1 (100 is lossless). The same quality from `rapier-jxl/effort` or `rapier-jxl/photo` can pass `effort`.

## Encode on the GPU

`encodeAsync(rgba, width, height, options)` from `rapier-jxl` writes the same file as `encode`, on WebGPU when the page has a
hardware adapter. Software fallback adapters (SwiftShader and the like) are skipped; they measured slower than the CPU.
A 12 MP phone photo took about 2.1 s instead of 6.7 s (24 phone photos, median, NVIDIA T4).

## Convert a file in a page

Copy `node_modules/rapier-jxl/dist/rapier-still-worker.js` beside your page (`rapier-worker.js` adds animation), then:

```js
import {toJXL} from 'rapier-jxl/image';
const jxl = await toJXL(file, {worker: './rapier-still-worker.js'}); // an image/jxl Blob
```

JPEG files are transcoded and restore byte for byte; other images are lossless unless you pass `quality`.
Calls that share one `Worker` run one after another. Browsers only: Deno and Node have no classic workers.

For one offline HTML file, embed the worker as text ([example](docs/reference/ARCHITECTURE.md#complete-rapier-worker)).

## Builds

| Build / import | Gzip bytes | Capabilities |
| --- | ---: | --- |
| **Still worker** · `rapier-jxl/rapier/still-worker` | 141,078 | Core + effort 1–9, optional WASM, Photo, JPEG transcoding and parallel lossless groups. No animation. |
| **Complete worker** · `rapier-jxl/rapier/worker` | 201,953 | Everything in the still worker, plus animation and the other format writers. |
| Complete module · `rapier-jxl/rapier/min` | 201,807 | The complete system with an encoder factory and worker installer. |
| Image · `rapier-jxl/image/min` | 1,253 | One call from a page: a file, bitmap, image data or canvas in, an `image/jxl` Blob out, through either worker. |
| Core · `rapier-jxl/min` | 28,920 | Lossless or lossy typed RGBA, native precision, HDR and exact alpha. Effort 1. |
| Effort · `rapier-jxl/effort/min` | 78,503 | Core with lossless compression search, efforts 1–9. Default effort 1. |
| WASM · `rapier-jxl/wasm/min` | 88,190 | Effort with inlined WASM and JavaScript fallback. |
| Photo · `rapier-jxl/photo/min` | 60,943 | Lossy photographs from RGBA pixels. Default effort 1: the same picture as higher efforts, a larger file. |
| JPEG · `rapier-jxl/jpeg/min` | 32,909 | Existing JPEGs, preserving admitted coefficients and orientation. Default effort 1. |
| Metadata · `rapier-jxl/metadata/min` | 12,592 | Attach, replace or remove caller-supplied Exif/XMP. |
| Animation · `rapier-jxl/animation/min` | 86,778 | Animated JPEG XL from frames: only changed rectangles stored, exact timing, lossless or lossy. |

`transcode()` and the worker both default JPEG to effort 1. The worker's pixel default is still quality 90 and effort 7. On a 12 MP JPEG made by upscaling Kodak, ANS effort 1 took 0.59 s and effort 7 took 2.0 s, for a 4% smaller file. libjxl on a harder 12 MP JPEG was reported at 0.36 s against Rapier's 3.0 s at effort 7. That gap is not closed. The prebuilt workers are rebuilt from this source: JPEG effort 1, no software WebGPU adapter, and `toJXL` calls on one worker run in turn. Gzip deltas are in the pull request.

Peak resident set on the full-HD dashboard, one Node process: capture 118 MB, effort 7 lossless 231 MB. The 778–876 MB figure against vips at 577 MB was a 12 MP encode and was not improved here.

Sizes of the minified builds are standalone files gzipped at level 9. [Entry points and embedding](docs/reference/ARCHITECTURE.md).

[API](docs/reference/API.md) · [Comparisons](docs/ENCODER-COMPARISON.md) · [Agent reference](llms.txt) ·
[Agent skills](skills/rapier-jxl-photography/SKILL.md) · [Browser example](examples/browser.html) ·
[snapdom plugin](examples/snapdom/plugin.mjs)
