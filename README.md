# Rapier JXL

JPEG XL in JavaScript. Exact captures, high-quality photographs, and a complete format toolkit. MIT. No runtime dependencies.

**Start with capture.** It preserves every RGBA sample, including alpha and RGB beneath transparency. A small optional error bound trades fidelity for size; exact is the default.

```js
import {createEncoder} from 'rapier-jxl/image';

// Copy dist/capture-worker.js to your own /assets/ directory.
const encoder = createEncoder({worker: '/assets/capture-worker.js'});
const bytes = await encoder.encode(canvas);
const file = new Blob([bytes], {type: 'image/jxl'});
// Reuse encoder for later captures. Call encoder.close() when finished.
```

Already inside a worker, Node or Deno:

```js
import {encode} from 'rapier-jxl/capture';
const bytes = await encode({data: rgba, width, height});
```

## Choose the job

| Need | Import | Worker |
| --- | --- | --- |
| Screenshots, DOM captures, drawings | `rapier-jxl/capture` (also the package root) | `capture-worker.js` |
| Photographs, effort search, perceptual targets | `rapier-jxl/photo` | `photo-worker.js` |
| Animation, original-JPEG reconstruction, HDR, metadata, format tools | `rapier-jxl/full` | `full-worker.js` |
| Persistent private worker and bounded queue | `rapier-jxl/image` | Your selected worker |
| Low-level RGBA encoder | `rapier-jxl/core` | Import it into your existing worker |

Each generated file includes its GPU code and dependencies. Nothing else downloads. CPU encoding always works. Specialist entries remain available for hosts that need exact control.

[Complete measured sizes and comparisons](docs/CAPTURE-AUDIT.md) · [Integrator contract](docs/INTEGRATION.md) · [All APIs](docs/reference/API.md)

## Capture options

```js
await encoder.encode(canvas, {maxError: 1, signal, onProgress});
```

`maxError` is an integer from 0 to 8, measured in 8-bit RGB sample values. Alpha and fully transparent RGB stay exact. A bound is **not** a visual-quality guarantee; compare the supplied SSIMULACRA2 results. `gpu: 'cpu'` disables optional GPU work.

Canvas and bitmap inputs preserve the browser's rasterized pixels. Browser premultiplication and color conversion can already have changed those pixels; use straight RGBA or ImageData for byte-level custody.

## Photographs

```js
import {encode} from 'rapier-jxl/photo';
const bytes = await encode({data: rgba, width, height}, {quality: 90, effort: 9});
```

Use the photo worker through the same image client in a page. `target: {ssimulacra2: 85}` searches candidates against the encoder's reconstructed-image metric. Validate external delivery thresholds with an independent decoder. JPEG input decoding uses the browser; reversible original-JPEG carrying belongs to `full` or `jpeg`.

## SnapDOM

The [reference plugin and offline demo](examples/snapdom/README.md) use SnapDOM's real `defineExports` hook:

```js
const result = await snapdom(element, {plugins: [jxlExport({encoder})]});
const file = await result.toJxl();
```

The plugin adds `result.toJxl()` and borrows the already captured canvas. Its tests run against the pinned upstream SnapDOM implementation.

## Build and verify

```sh
npm install
npm run build
npm test
npx playwright install chromium
npm run test:snapdom
```

The build enforces the JavaScript and TypeScript integration contracts and writes exact gzip/Brotli sizes to `dist/sizes.json`. Native decoder checks use `DJXL` or `djxl` on PATH. [Reproduce the measurements](bench/capture/README.md).

Encoding does not require browser JPEG XL support. Display and browser-side decoding do. This package does not include a JPEG XL pixel decoder.
