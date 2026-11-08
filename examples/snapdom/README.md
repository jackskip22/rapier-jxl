# JPEG XL exports for SnapDOM 3

This example uses rapier-jxl 8.3.1. Copy `jxl.js` and `jxl.d.ts` together, then use SnapDOM's plug-in interface:

```js
import {snapdom} from '@zumer/snapdom';
import {jxl} from './jxl.js';

const result = await snapdom(document.querySelector('#card'), {plugins: [jxl()]});
const file = await result.toBlob({format: 'jxl'});
const image = await result.toJxl({quality: 0.8, effort: 3});
await result.download({format: 'jxl', filename: 'card'});
```

`capture-complete` writes one JPEG XL file with lossy photos and exact text. For every pixel exact, use
`jxl({module: 'rapier-jxl/capture'})` or export with `quality: 1`.

## Options and defaults

The port uses these names throughout 8.x. The runtime and TypeScript checks beside the source protect this boundary.

| `jxl()` option | Default | Meaning |
| --- | --- | --- |
| `module` | `'rapier-jxl/capture-complete'` | Capture-complete carries efforts 1–9; `'rapier-jxl/capture'` carries exact capture at 1–5; `'rapier-jxl/upload'` carries photographic capture at 1–3. |
| `codec` | Created on the first export | Supply an object with `prepare` and `capture`: a codec or a directly imported capture module. |
| `effort` | The module's default, 3 | Default for each export; that export's `effort` overrides it. |
| `webgpu` | Omitted | Use the module's normal device selection. `false` disables it; `'required'` requires a device for a job with GPU work. There is no `'auto'` value. |
| `helpers` | None | `true`, or `{count, memoryBytes}`; `count: 0` may omit `memoryBytes`. Passed to a codec the example creates. With your own `codec`, ignored. Exact capture takes no helpers. |

Helper settings are copied when `jxl()` is called. Exports reuse a codec for the same module and helper settings.

| Export option | Default or handling |
| --- | --- |
| `quality` | `0.92`. Values below 1 become `fidelity: {quality: Math.max(1, quality * 100)}`. `1` is exact. The exact module stays exact at every quality. |
| `scale` | `1`. Forwarded to SnapDOM; an explicit `width` or `height` takes precedence. |
| `width`, `height` | Unset. Forwarded to SnapDOM; setting only one keeps the aspect ratio. |
| `dpr` | `window.devicePixelRatio` through SnapDOM. The returned image's CSS size is its pixel size divided by the normalized `dpr`; a direct hook call with no `dpr` uses 1. Downloads use `dpr: 1`. |
| `backgroundColor` | `'#ffffff'` when absent or null. |
| `effort` | The `jxl()` preset, otherwise 3. Read from this export's `requestedOptions`. |
| `signal` | None. Cancellation preserves `signal.reason`, including while drawing and preparing the image. |
| `onProgress` | None. Receives an encoding fraction from 0 to 1, after drawing. |
| `onEncoded` | None. Receives `{exact: boolean, bands: number}` once for the selected file. A callback exception rejects the export. |
| `format` | `toJxl()` selects JPEG XL. `toBlob({format: 'jxl'})` selects it case-insensitively; other blob formats delegate to SnapDOM. The download hook defaults to PNG. |
| `filename` | `'snapDOM'` through SnapDOM; a direct call to the download hook falls back to `'snapdom'`. A missing recognized image extension gets the selected format's extension. |

In 8.3.1 the declaration accepts `backgroundColor: null`, matching the existing runtime's white-background default.

## rapier-jxl calls the port consumes

| Module and name | Arguments | Return fields used |
| --- | --- | --- |
| `rapier-jxl/codec`: `createCodec` | `{module, maxPixels: 268435456, helpers?}` | An encoder with `prepare('capture'): Promise<void>` and `capture(input, options): Promise<ImageResult>`. Preparation is a warm-up; its failure is handled by the capture. |
| Encoder: `capture` | The drawn canvas; `{fidelity, effort?, webgpu?, signal?, onProgress?, onEncoded, exactRects?, photoRects?}` | `fits: boolean`, `bytes: Uint8Array` on success; `reason: {code, message}` on a miss. A miss rejects the export with that code and message. The Blob contains only the returned byte view. |
| `rapier-jxl/page-rects`: `measure` | The cloned element; `{edges: boolean}` (default false). The example requests edges for preset efforts 4–9. | A measurement with `box: {left, top, width, height}`, `text`, `photos`, and optional `edges`. The example reads `box.width` and `box.height` and passes the measurement to `pageRects`. |
| `rapier-jxl/page-rects`: `pageRects` | The measurement, `{width, height}` canvas, and `{area: {x?, y?, width?, height?}, edges}`. Area is in CSS pixels; defaults cover the measured element. | `{exactRects, photoRects}` arrays in whole canvas pixels. Rectangles have `{x, y, width, height}`; exact rectangles may also have `solidText` or `edge`. |
| Display decoder: `createCodec` | `{module: 'rapier-jxl/decode', maxPixels: 268435456}`; created only if a lossy file cannot display natively. | A decoder with `decode(blob, options): Promise<DecodedImage>`. |
| Decoder: `decode` | The JXL Blob; `{format: 'uint8', colorSpace: 'srgb', maxPixels: 268435456, signal?}` | `{data, width, height}`; `data.buffer`, `data.byteOffset`, and `data.byteLength` build the RGBA canvas view. |

Measurements are taken in `afterClone`, before the page can change. The export maps them through the capture's clip
and scale. Below 1:1, text boxes round outward; when photos remain, the smaller of photographic and whole-exact
capture wins. Without a measurement, the whole capture stays exact.

Measured capture needs a JPEG XL decoder where the codec runs. A browser's native decoder or a decoder configured
on a directly supplied capture module provides it. The later display fallback does not configure measured capture.

## SnapDOM calls and return shapes

`jxl()` returns `{name: 'jxl', afterClone?, defineExports}`. Exact capture has no `afterClone` hook. The hook reads
`context.element`; exports read `context.meta.clip.{x,y,width,height}`, `context.meta.w0`, `context.meta.h0`, and
`context.export.requestedOptions`. Capturing `<html>` also accounts for the body's top offset.

`defineExports({exports})` uses `exports.canvas(options): Promise<HTMLCanvasElement>` and
`exports.blob(options): Promise<Blob>`. It returns:

| Hook | SnapDOM result method | Return |
| --- | --- | --- |
| `jxl(context, options = {})` | `toJxl(options)` | `Promise<HTMLImageElement>` |
| `blob(context, options = {})` | `toBlob(options)` | `Promise<Blob>`; JPEG XL has MIME type `'image/jxl'` |
| `download(context, options = {})` | `download(options)` | `Promise<void>` |

`toJxl()` first displays the JPEG XL file. If that fails, an exact capture displays its existing canvas as PNG;
a lossy capture displays a PNG made from the decoded file. The saved Blob remains JPEG XL. Downloads use a file
share sheet where supported on iOS, otherwise a browser download.

`jxl.d.ts` exports `jxl`, `JxlOptions`, `JxlExportOptions`, `JxlContext`, `JxlPlugin`, `SnapDOMExports`,
`CaptureEncoder`, `CaptureHelpers`, `CaptureModule`, `LeanCaptureModule`, `CompleteCaptureModule`, `CaptureEffort`,
`UploadEffort`, and `Effort`. It adds the three JPEG XL result methods to SnapDOM's `CaptureResult` type.
