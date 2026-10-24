# Rapier JXL

JPEG XL encoder in JavaScript. Smaller files than libjxl at the same quality, a quality search that runs on WebGPU,
29 KB gzipped. Runs in browsers, workers, Node and Deno. MIT license, no dependencies.

| Same visual quality (SSIMULACRA2), 24 Kodak photos | Rapier JXL |
| --- | ---: |
| libjxl, `cjxl -e 9` | 5–7% smaller |
| AVIF | 4–20% smaller |
| WebP | 15–23% smaller |
| JPEG (mozjpeg) | 19–43% smaller |
| JPEG to JPEG XL, restored byte for byte (24 of 24) | 14% smaller |
| Encoder size, gzipped | 29 KB (libjxl in WebAssembly: 962 KB) |

[Method, every score and how to reproduce](docs/ENCODER-COMPARISON.md).

```sh
npm install rapier-jxl
```

## Encode pixels to a score

```js
import {encodeToScore} from 'rapier-jxl/score';
const {bytes} = await encodeToScore(rgba, width, height, {target: {ssimulacra2: 80}, gpu: device});
```

Returns the smallest file that meets the score. `gpu` is an optional `GPUDevice`; without it the search runs on the CPU.
For a fixed quality, `encode(rgba, width, height, {quality: 90})` from `rapier-jxl` (100 is lossless).

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
| **Still worker** · `rapier-jxl/rapier/still-worker` | 149,050 | Core + effort 1–9, optional WASM, Photo, JPEG transcoding and parallel lossless groups. No animation. |
| **Complete worker** · `rapier-jxl/rapier/worker` | 213,491 | Everything in the still worker, plus animation and the other format writers. |
| Complete module · `rapier-jxl/rapier/min` | 213,564 | The complete system with an encoder factory and worker installer. |
| Image · `rapier-jxl/image/min` | 1,183 | One call from a page: a file, bitmap, image data or canvas in, an `image/jxl` Blob out, through either worker. |
| Core · `rapier-jxl/min` | 28,604 | Lossless or lossy typed RGBA, native precision, HDR and exact alpha. |
| Effort · `rapier-jxl/effort/min` | 78,134 | Core with lossless compression search, efforts 1–9. |
| WASM · `rapier-jxl/wasm/min` | 88,025 | Effort with inlined WASM and JavaScript fallback. |
| Photo · `rapier-jxl/photo/min` | 60,786 | Lossy photographs from RGBA pixels. |
| JPEG · `rapier-jxl/jpeg/min` | 32,866 | Existing JPEGs, preserving admitted coefficients and orientation. |
| Metadata · `rapier-jxl/metadata/min` | 12,293 | Attach, replace or remove caller-supplied Exif/XMP. |
| Animation · `rapier-jxl/animation/min` | 86,616 | Animated JPEG XL from frames: only changed rectangles stored, exact timing, lossless or lossy. |

Sizes are standalone files gzipped at level 9. [Entry points and embedding](docs/reference/ARCHITECTURE.md).

[API](docs/reference/API.md) · [Comparisons](docs/ENCODER-COMPARISON.md) · [Agent reference](llms.txt) ·
[Agent skills](skills/rapier-jxl-photography/SKILL.md) · [Browser example](examples/browser.html)
