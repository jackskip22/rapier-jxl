# Rapier JXL

JPEG XL encoder in JavaScript. Smaller files than libjxl at the same quality, a quality search that runs on WebGPU,
29 KB gzipped. Runs in browsers, workers, Node and Deno. MIT license, no dependencies.

| Same visual quality (SSIMULACRA2), 24 Kodak photos | Effort | Rapier JXL |
| --- | :---: | ---: |
| libjxl, `cjxl -e 9` | 7 | 5–7% smaller |
| libjxl, `cjxl -e 9`, by Butteraugli | 9 | up to 5% smaller |
| AVIF | 7 | 4–20% smaller |
| WebP | 7 | 15–23% smaller |
| JPEG (mozjpeg) | 7 | 19–43% smaller |
| JPEG to JPEG XL, restored byte for byte (24 of 24) | 9 | 15% smaller |
| Encoder size, gzipped | | 29 KB (libjxl in WebAssembly: 962 KB) |

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

## Encode on the GPU

`encodeAsync(rgba, width, height, options)` writes the same file as `encode`, on WebGPU when the page has it:
a 12 MP phone photo in about 2.1 s instead of 6.7 s (24 phone photos, median, NVIDIA T4).

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
| **Still worker** · `rapier-jxl/rapier/still-worker` | 149,572 | Core + effort 1–9, optional WASM, Photo, JPEG transcoding and parallel lossless groups. No animation. |
| **Complete worker** · `rapier-jxl/rapier/worker` | 214,332 | Everything in the still worker, plus animation and the other format writers. |
| Complete module · `rapier-jxl/rapier/min` | 214,402 | The complete system with an encoder factory and worker installer. |
| Image · `rapier-jxl/image/min` | 1,184 | One call from a page: a file, bitmap, image data or canvas in, an `image/jxl` Blob out, through either worker. |
| Core · `rapier-jxl/min` | 28,920 | Lossless or lossy typed RGBA, native precision, HDR and exact alpha. |
| Effort · `rapier-jxl/effort/min` | 78,503 | Core with lossless compression search, efforts 1–9. |
| WASM · `rapier-jxl/wasm/min` | 88,190 | Effort with inlined WASM and JavaScript fallback. |
| Photo · `rapier-jxl/photo/min` | 60,943 | Lossy photographs from RGBA pixels. |
| JPEG · `rapier-jxl/jpeg/min` | 32,866 | Existing JPEGs, preserving admitted coefficients and orientation. |
| Metadata · `rapier-jxl/metadata/min` | 12,592 | Attach, replace or remove caller-supplied Exif/XMP. |
| Animation · `rapier-jxl/animation/min` | 86,778 | Animated JPEG XL from frames: only changed rectangles stored, exact timing, lossless or lossy. |

Sizes are standalone files gzipped at level 9. [Entry points and embedding](docs/reference/ARCHITECTURE.md).

[API](docs/reference/API.md) · [Comparisons](docs/ENCODER-COMPARISON.md) · [Agent reference](llms.txt) ·
[Agent skills](skills/rapier-jxl-photography/SKILL.md) · [Browser example](examples/browser.html)
