# SnapDOM → JPEG XL

Exact pixels, smaller and faster than SnapDOM's default WebP export on real pages: 82 KB against 137 KB for a
GitHub page, 148 ms against 200 ms.

`jxl-export.mjs` is a SnapDOM 3 plug-in. It adds `result.toJxl()` on `rapier-jxl/capture`.

```js
import { snapdom } from '@zumer/snapdom';
import { encode } from 'rapier-jxl/capture';
import { jxlExport } from './jxl-export.mjs';

const jxl = jxlExport({ encode });
jxl.prepare().catch(() => {}); // optional: start the worker now; a failure still rejects the first export
const result = await snapdom(element, { plugins: [jxl] });
const blob = await result.toJxl(); // image/jxl, exact pixels
```

`encode` runs in a module worker that starts on the first call. To own the worker and close it, pass
`encoder.capture` from `createEncoder()` (`rapier-jxl`) instead.

## Measured

Five 1920×1080 pages (GitHub, MDN light and dark, a shadcn dashboard, Hacker News) through SnapDOM 3.4.0 in
Chrome 155 on a 2.2 GHz Xeon, warm, median of five. Every JPEG XL file decodes to the source pixels with libjxl
0.12.0's `djxl`.

| Page | `toWebp()` | `toJxl()` |
| --- | --- | --- |
| GitHub | 136,572 B, 200 ms | 81,531 B, 148 ms |
| MDN | 162,858 B, 216 ms | 87,122 B, 185 ms |
| Dashboard | 97,198 B, 207 ms | 79,025 B, 184 ms |
| MDN dark | 156,824 B, 211 ms | 85,070 B, 177 ms |
| Hacker News | 176,532 B, 218 ms | 70,321 B, 155 ms |

The first export on a fresh page takes 228–282 ms there, against WebP's 241–257 ms: faster on Hacker News, even on
GitHub, slower on the others by 8–39 ms. SnapDOM's WebP is lossy (quality 0.92). Lossless WebP (`cwebp -lossless -m 4`)
is smaller than `toJxl()` on four of these five pages, by 0.2–4%.

## Options

`result.toJxl({ maxError, signal, onProgress })`. `maxError` 1–8 lets each RGB sample move by at most that many
levels; alpha stays exact. `toJxl()` encodes SnapDOM's canvas export, so size, scale and background stay SnapDOM's.
Encoder and rasterization errors reject the export; canceling ends the running job.

## Offline demo

In the installed package, run `node examples/snapdom/serve.mjs` and open the printed URL. Every asset is local; module
workers need a local HTTP origin. `node examples/snapdom/smoke.mjs` (Playwright) captures, cancels a 4K capture and
captures again, and checks each file against SnapDOM's canvas with `rapier-jxl/decode`.

`vendor/README.md` lists the demo assets and their licenses. This is a reference plug-in, not a separate npm package.
