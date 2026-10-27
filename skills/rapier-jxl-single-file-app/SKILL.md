---
name: rapier-jxl-single-file-app
description: Add JPEG XL encoding to an offline HTML app. Choose capture, photo or full, embed a self-contained worker, and use the stable image client for borrowed inputs, progress and cancellation.
---

# JPEG XL in an offline app

Choose the workload first:

| Need | Import | Embed |
| --- | --- | --- |
| Exact screenshots or bounded RGB error | `rapier-jxl/capture` | `dist/capture-worker.js` |
| High-quality photographs and target search | `rapier-jxl/photo` | `dist/photo-worker.js` |
| Animation, JPEG reconstruction, native/HDR, metadata and all format tools | `rapier-jxl/full` | `dist/full-worker.js` |
| Page client | `rapier-jxl/image/min` | `dist/image.min.mjs` |
| General low-level RGBA | `rapier-jxl/core/min` | `dist/core.min.mjs` |

Read the [integration contract](../../docs/INTEGRATION.md). Every generated encoder includes its dependencies and optional GPU code; no secondary request is needed. Keep MIT and any included third-party notices with the embedded code.

Use a persistent client for a page:

```js
import {createEncoder} from 'rapier-jxl/image';
const encoder = createEncoder({worker: '/assets/capture-worker.js'});
const bytes = await encoder.encode(canvas, {signal, onProgress});
const blob = new Blob([bytes], {type: 'image/jxl'});
// Keep encoder for more exports; encoder.close() when the host finishes.
```

Copy the chosen worker to a host-resolved URL. For one HTML file, embed the complete worker and client as inert text, create Blob module/worker URLs, and revoke them after closing the encoder. Do not pass a bare npm specifier to new URL() and expect browser package resolution. Preserve the worker URL while any helper workers may still use it. Permit the relevant inline/blob sources in the host CSP.

Already inside a host worker queue: import the selected encode function directly. Do not nest another worker. Supply exactly width×height×4 straight RGBA samples with the correct existing color/precision declaration. The image client never detaches caller inputs; do not mutate them before settlement. Respect queue and pixel bounds. Aborting active work terminates its private worker; no partial file resolves.

Keep capture exact by default. maxError1–8 bounds visible RGB sample differences; it is not a promise of visual equivalence. Alpha and RGB under zero alpha remain exact. Browser rasterization may already have changed pixels through premultiplication, orientation or color conversion.

Save .jxl with MIME image/jxl. Encoding needs no native JPEG XL decoder; display does. Use the [offline SnapDOM example](../../examples/snapdom/README.md) for a complete tested host integration. For authored layers, patches, progressive containers, metadata or HDR, use the [specialist API](../../docs/reference/API.md). Keep the source/master and verify required decoded samples before replacing it.
