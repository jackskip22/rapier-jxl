# Rapier JXL

JPEG XL encoder in JavaScript with optional WebGPU quality search. 34 KB gzipped.
Runs in browsers, workers, Node and Deno. MIT license, no dependencies.

Private integration candidate 6.2.0-integration.20261026.1. Current full-corpus quality comparisons, requested-score acceptance,
12 MP CPU/GPU performance and the complete 1 GiB memory target are **NOT PROVEN**. Historical benchmark reports
retain their original source identities; they do not qualify this candidate. Build sizes below measure this package.

One bounded local exact comparison attempted Kodak01 at effort 8, quality 85: the immutable reference completed,
but this candidate reached the 90-second limit without a complete result. No output equality was established;
the 196-cell final matrix remains incomplete. This is a scoped timeout, not a hardware memory result or a speed claim.

[Historical results, their limits and how to reproduce](docs/ENCODER-COMPARISON.md).

```sh
npm install rapier-jxl
```

## Encode pixels to a score

```js
import {encodeToScore} from 'rapier-jxl/score';
const {bytes} = await encodeToScore(rgba, width, height, {target: {ssimulacra2: 80}, gpu: device});
```

Searches the configured candidates for the smallest file that meets the score, or refuses when no candidate qualifies.
`gpu` is an optional `GPUDevice`; without it the search runs on the CPU.
For a fixed quality, `encode(rgba, width, height, {quality: 90})` from `rapier-jxl` (100 is lossless).

## Encode on the GPU

`encodeAsync(rgba, width, height, options)` provides an optional WebGPU path. Its byte equality and performance on
this candidate require current source and actual-device evidence; the retained historical effort-1 timings do not
qualify effort 7 or 9, requested scores, or whole-product memory.

## Convert a file in a page

Copy `node_modules/rapier-jxl/dist/rapier-still-worker.js` beside your page (`rapier-worker.js` adds animation), then:

```js
import {toJXL} from 'rapier-jxl/image';
const jxl = await toJXL(file, {worker: './rapier-still-worker.js'}); // an image/jxl Blob
```

For one offline HTML file, embed the worker as text ([example](docs/reference/ARCHITECTURE.md#complete-rapier-worker)).

## Builds

| Build / import | Gzip bytes | Capabilities |
| --- | ---: | --- |
| **Still worker** · `rapier-jxl/rapier/still-worker` | 190,373 | Core + effort 1–9, optional WASM, Photo and JPEG transcoding. No animation. |
| **Complete worker** · `rapier-jxl/rapier/worker` | 255,146 | Everything in the still worker, plus animation and the other format writers. |
| Complete module · `rapier-jxl/rapier/min` | 255,240 | The complete system with an encoder factory and worker installer. |
| Image · `rapier-jxl/image/min` | 1,200 | One call from a page: a file, bitmap, image data or canvas in, an `image/jxl` Blob out, through either worker. |
| Core · `rapier-jxl/min` | 33,598 | Lossless or lossy typed RGBA, native precision, HDR and exact alpha. |
| Effort · `rapier-jxl/effort/min` | 105,365 | Core with lossless compression search, efforts 1–9. |
| WASM · `rapier-jxl/wasm/min` | 115,068 | Effort with inlined WASM and JavaScript fallback. |
| Photo · `rapier-jxl/photo/min` | 87,308 | Lossy photographs from RGBA pixels. |
| JPEG · `rapier-jxl/jpeg/min` | 35,232 | Existing JPEGs, preserving admitted coefficients and orientation. |
| Metadata · `rapier-jxl/metadata/min` | 12,774 | Attach, replace or remove caller-supplied Exif/XMP. |
| Animation · `rapier-jxl/animation/min` | 113,580 | Animated JPEG XL from frames: only changed rectangles stored, exact timing, lossless or lossy. |

Sizes are standalone files gzipped at level 9. [Entry points and embedding](docs/reference/ARCHITECTURE.md).

Helper workers require admission by the encoder's memory coordinator. The legacy photo, lossless and animation
pools default to zero; a requested worker count alone does not authorize extra allocations.

[API](docs/reference/API.md) · [Comparisons](docs/ENCODER-COMPARISON.md) · [Agent reference](llms.txt) ·
[Agent skills](skills/rapier-jxl-photography/SKILL.md) · [Browser example](examples/browser.html)
