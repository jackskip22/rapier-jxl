# Rapier JXL

JPEG XL encoder in JavaScript. Browsers, workers, Node and Deno. MIT, no dependencies.

The core and the search are different encoders. The core is the 29 KB one. The files that beat libjxl come from the effort search.

| Entry | Gzip | What the bytes are |
| --- | ---: | --- |
| Core · `rapier-jxl` | 28,920 | Fast lossless, and lossy photographs at effort 1. On 24 Kodak photos at SSIMULACRA2 80 this entry is about **1.3% larger** than `cjxl -e 7`. |
| Effort · `rapier-jxl/effort` | 78,503 | The search in the table below. Effort 7 on those Kodak photos is about **8.2% smaller** than `cjxl -e 7` at SSIMULACRA2 80. At 12 MP that same effort is about **4.5% larger**. |
| Capture · `rapier-jxl/capture` | screen coder, not a second core | Lossless screen captures. One context-model pass and a patch pass, then the smaller file. It does not run the effort 7 ladder. |

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

On a document this runs in a module worker, one capture at a time. `worker: false` encodes on the caller. The result is exact. Flat UI takes the fast context model; repeated text takes patch matching; a photograph, or anything those passes do not shrink, takes the core exact encode.

Lossy quality 90 is the wrong tool for a screenshot: on the measured dashboard it was larger than lossless. Capture does not use it.

A full-HD dashboard drawn here (PNG 145 KB, WebP quality 90 at 86 KB):

| Encode | Bytes | Time |
| --- | ---: | ---: |
| Core lossless, effort 1 | 90,082 | 290 ms |
| Capture | 32,942 | about 0.9 s |
| Effort 7 lossless | 32,843 | 7.5 s |

Capture matched the effort 7 file. The 0.9 s includes the exact encode it compares against, so the result is never larger than effort 1. WebP was 86 KB. djxl decoded the capture back to the same pixels. A denser text page (PNG 196 KB, WebP 203 KB) was 23,847 bytes in 0.8 s, against effort 7 at 19,186 bytes in 7.7 s: about 24% larger than effort 7, and still far under WebP. A text-heavy browser screenshot does not always beat WebP. Hacker News was 213 KB lossless against a 139 KB WebP, and effort 7 was 186 KB, so lossless JPEG XL does not win that page.

The reference from snapdom 3.4.0, a different full-HD dashboard: PNG 402 KB in 41 ms, WebP 135 KB in 135 ms, lossless effort 1 at 221 KB in 76 ms, effort 3 at 177 KB in 518 ms, effort 7 at 49 KB in 4.0 s. Capture is aimed at that effort 7 size without the 4 second ladder. It was not re-run on those exact pixels.

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
| **Still worker** · `rapier-jxl/rapier/still-worker` | 149,572 | Core + effort 1–9, optional WASM, Photo, JPEG transcoding and parallel lossless groups. No animation. |
| **Complete worker** · `rapier-jxl/rapier/worker` | 214,332 | Everything in the still worker, plus animation and the other format writers. |
| Complete module · `rapier-jxl/rapier/min` | 214,402 | The complete system with an encoder factory and worker installer. |
| Image · `rapier-jxl/image/min` | 1,184 | One call from a page: a file, bitmap, image data or canvas in, an `image/jxl` Blob out, through either worker. |
| Core · `rapier-jxl/min` | 28,920 | Lossless or lossy typed RGBA, native precision, HDR and exact alpha. Effort 1. |
| Effort · `rapier-jxl/effort/min` | 78,503 | Core with lossless compression search, efforts 1–9. Default effort 1. |
| WASM · `rapier-jxl/wasm/min` | 88,190 | Effort with inlined WASM and JavaScript fallback. |
| Photo · `rapier-jxl/photo/min` | 60,943 | Lossy photographs from RGBA pixels. Default effort 1: the same picture as higher efforts, a larger file. |
| JPEG · `rapier-jxl/jpeg/min` | 32,866 | Existing JPEGs, preserving admitted coefficients and orientation. Default effort 1. |
| Metadata · `rapier-jxl/metadata/min` | 12,592 | Attach, replace or remove caller-supplied Exif/XMP. |
| Animation · `rapier-jxl/animation/min` | 86,778 | Animated JPEG XL from frames: only changed rectangles stored, exact timing, lossless or lossy. |

`transcode()` and, from source, the worker both default JPEG to effort 1. The worker's pixel default is still quality 90 and effort 7. On a 12 MP JPEG made by upscaling Kodak, ANS effort 1 took 0.59 s and effort 7 took 2.0 s, for a 4% smaller file. libjxl on a harder 12 MP JPEG was reported at 0.36 s against Rapier's 3.0 s at effort 7. That gap is not closed. The prebuilt `dist/rapier-still-worker.js` and `dist/rapier-worker.js` are the previous bundles: they still default JPEG to effort 7, and they still accept a software WebGPU adapter. Both are fixed in source (`src/worker.mjs`, `src/rapier-still.mjs`, `src/gpu-core.mjs`), not by editing those bundles.

Peak resident set on the full-HD dashboard, one Node process: capture 118 MB, effort 7 lossless 231 MB. The 778–876 MB figure against vips at 577 MB was a 12 MP encode and was not improved here.

Sizes of the minified builds are standalone files gzipped at level 9. [Entry points and embedding](docs/reference/ARCHITECTURE.md).

[API](docs/reference/API.md) · [Comparisons](docs/ENCODER-COMPARISON.md) · [Agent reference](llms.txt) ·
[Agent skills](skills/rapier-jxl-photography/SKILL.md) · [Browser example](examples/browser.html) ·
[snapdom plugin](examples/snapdom/plugin.mjs)
