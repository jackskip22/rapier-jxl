# Rapier JXL

JPEG XL encoder in pure JavaScript. Great for single-file HTML apps, photography tools and agent image workflows. Runs
offline in browsers, Node and Deno. MIT license, no dependencies.

- **20× smaller than other JPEG XL encoders.** The core is 25 KB gzipped; the smallest
  WebAssembly encoder ([@squoosh-kit/jxl](docs/ENCODER-COMPARISON.md#payload)) is 512 KB, libjxl's
  `jxl-wasm` is 962 KB (38×).
- **Exact JPEGs in 34× less code.** A JPEG restores byte for byte (24 of 24 photos), 11.6% smaller. The JPEG
  entry is 31 KB; `jpeg-to-jxl` is 1,063 KB.
- **Animations up to 2× smaller than libjxl**, lossless, against `cjxl` at its highest effort: a GIF 284 KB vs 556 KB, a
  screen recording 16 KB vs 23 KB, a camera clip 1.6 MB vs 1.9 MB ([results](docs/ENCODER-COMPARISON.md#animation)).
- **No WebAssembly needed.** Lossless and lossy, 8-bit to 32-bit float, HDR (PQ, HLG), exact alpha, color profiles, animation.

```sh
npm install rapier-jxl
```

## Convert a file in a page

Copy `node_modules/rapier-jxl/dist/rapier-still-worker.js` beside your page (`rapier-worker.js` adds animation), then:

```js
import {toJXL} from 'rapier-jxl/image';
const jxl = await toJXL(file, {worker: './rapier-still-worker.js'}); // an image/jxl Blob
```

For one offline HTML file, embed the worker as text and start it from a Blob URL
([example](docs/reference/ARCHITECTURE.md#complete-rapier-worker)).

## Encode pixels

```js
import {encode} from 'rapier-jxl';
const bytes = encode(rgba, width, height, {quality: 100}); // 100 is lossless; 1 to 99 is lossy
```

Alpha stays exact at every quality. [API and options](docs/reference/API.md).

## Builds

| Build / import | Gzip bytes | Capabilities |
| --- | ---: | --- |
| **Still worker** · `rapier-jxl/rapier/still-worker` | 102,931 | Core + effort 1–9, optional WASM, Photo, JPEG transcoding and parallel lossless groups. No animation. |
| **Complete worker** · `rapier-jxl/rapier/worker` | 174,450 | Everything in the still worker, plus animation and the other format writers. |
| Complete module · `rapier-jxl/rapier/min` | 174,517 | The complete system with an encoder factory and worker installer. |
| Image · `rapier-jxl/image/min` | 1,184 | One call from a page: a file, bitmap, image data or canvas in, an `image/jxl` Blob out, through either worker. |
| Core · `rapier-jxl/min` | 24,831 | Lossless or lossy typed RGBA, native precision, HDR and exact alpha. |
| Effort · `rapier-jxl/effort/min` | 50,419 | Core with lossless compression search, efforts 1–9. |
| WASM · `rapier-jxl/wasm/min` | 60,129 | Effort with inlined WASM and JavaScript fallback. |
| Photo · `rapier-jxl/photo/min` | 25,190 | Lossy photographs from RGBA pixels. |
| JPEG · `rapier-jxl/jpeg/min` | 30,616 | Existing JPEGs, preserving admitted coefficients and orientation. |
| Metadata · `rapier-jxl/metadata/min` | 12,292 | Attach, replace or remove caller-supplied Exif/XMP. |
| Animation · `rapier-jxl/animation/min` | 58,816 | Animated JPEG XL from frames: only changed rectangles stored, exact timing, lossless or lossy. |

Sizes are standalone files gzipped at level 9. [Entry points and embedding](docs/reference/ARCHITECTURE.md).

## Effort

Effort 1 to 9 trades time for size; 7 is the default. On 71 lossless images:

| Effort | Size | Time |
| ---: | --- | ---: |
| 7 | baseline | 1× |
| 8 | 2.1% smaller | 4.2× |
| 9 | 2.4% smaller | 9.5× |

[What each effort adds](docs/reference/API.md#lossless-effort) · [Measurements](docs/ENCODER-COMPARISON.md#lossless-effort-cost)

[API](docs/reference/API.md) · [Comparisons](docs/ENCODER-COMPARISON.md) · [Agent reference](llms.txt) ·
[Agent skills](skills/rapier-jxl-photography/SKILL.md) · [Browser example](examples/browser.html)
