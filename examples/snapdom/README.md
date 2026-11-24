# JPEG XL exports for SnapDOM 3

This example uses rapier-jxl 8.4.0 or later. Copy `jxl.js` and `jxl.d.ts` together, then use SnapDOM's plug-in interface:

```js
import {snapdom} from '@zumer/snapdom';
import {jxl} from './jxl.js';

const result = await snapdom(document.querySelector('#card'), {plugins: [jxl()]});
const file = await result.toBlob({format: 'jxl'});
const image = await result.toJxl({quality: 0.8, effort: 3});
await result.download({format: 'jxl', filename: 'card'});
```

`capture-complete` writes one JPEG XL file with lossy photos and exact text. For every pixel exact, export with
`quality: 1`, or ship the smaller exact-only module:

```js
import * as capture from 'jpegxl/capture';
jxl({module: 'rapier-jxl/capture', codec: capture});
```

A build holds only the module you choose. The plug-in imports `capture-complete` itself. `capture` and `upload` come
only as the `codec` you import. Transparent samples (a card's rounded corners) stay transparent, as in SnapDOM's PNG,
unless you set `backgroundColor`. Crop a capture with SnapDOM's `clip`.

## Options and defaults

The port uses these names throughout 8.x. The runtime and TypeScript checks beside the source protect this boundary.

| `jxl()` option | Default | Meaning |
| --- | --- | --- |
| `module` | `'rapier-jxl/capture-complete'` | Capture-complete carries efforts 1–9. `'rapier-jxl/capture'` carries exact capture at 1–5. `'rapier-jxl/upload'` carries photographic capture at 1–3. The last two need their `codec`. |
| `codec` | `jpegxl/capture-complete`, imported on the first export | The capture module you imported, or any object with its `prepare` and `capture`. |
| `effort` | The module's default, 3 | Default for each export. That export's `effort` overrides it. |
| `webgpu` | Omitted | `jpegxl/capture-complete` only: left out, it uses a device where it helps. `false` turns it off. `'required'` refuses without one. `jpegxl/capture` and `jpegxl/upload` run on WebAssembly and refuse it. |

Helpers are the module's own setting: `import {configure} from 'jpegxl/capture-complete'; configure({helpers: true});`.

| Export option | Default or handling |
| --- | --- |
| `quality` | `0.92`. Values below 1 become `fidelity: {quality: Math.max(1, quality * 100)}`. `1` is exact. The exact module stays exact at every quality. A card with no photograph stays exact too: quality changes nothing there. |
| `scale` | `1`. Forwarded to SnapDOM. An explicit `width` or `height` takes precedence. |
| `width`, `height` | Unset. Forwarded to SnapDOM. Setting only one keeps the aspect ratio. |
| `dpr` | `window.devicePixelRatio` through SnapDOM. The returned image takes the drawn canvas's CSS size. A direct hook call with no `dpr` uses 1. Downloads use `dpr: 1`. |
| `backgroundColor` | SnapDOM's own: transparent, as its PNG. Set a color to fill. |
| `effort` | The `jxl()` preset, otherwise 3. Read from the export's options (a `beforeExport` plug-in may change them), then its request. |
| `signal` | None. Cancellation preserves `signal.reason`, including while drawing and preparing the image. |
| `onProgress` | None. Receives an encoding fraction from 0 to 1, after drawing. |
| `onEncoded` | None. Receives `{exact: boolean, textMarks?: 'skipped'}` once for the selected file. A callback exception rejects the export. |
| `format` | `toJxl()` selects JPEG XL. `toBlob({format: 'jxl'})` selects it case-insensitively, as does SnapDOM's older `type: 'jxl'` when no format is set. Other blob formats delegate to SnapDOM. The download hook defaults to PNG. |
| `filename` | `'snapDOM'` through SnapDOM. A direct call to the download hook falls back to `'snapdom'`. A missing recognized image extension gets the selected format's extension. |

## rapier-jxl calls the port consumes

| Module and name | Arguments | Return fields used |
| --- | --- | --- |
| `jpegxl/capture-complete` | The only module the plug-in imports, on the first export. With your own `codec` it imports none. In a browser it runs in its own worker. | `prepare(): Promise<void>` and `capture(input, options): Promise<ImageResult>`. Preparation is a warm-up. Its failure is handled by the capture. |
| Encoder: `capture` | The drawn canvas. `{fidelity, effort?, webgpu?, signal?, onProgress?, exactRects?, photoRects?, textComplete?}` | `meetsTarget: boolean`, `bytes: Uint8Array` and `kept` on success. `reason: {code, message}` on a miss. A miss rejects the export with that code and message. The Blob contains only the returned byte view. |
| `jpegxl/page-rects`: `measure` | The captured element. `{edges, keep}`: edges except for the upload module, and `keep`, the nodes SnapDOM cloned. | A measurement with `box: {left, top, width, height}`, `text`, `photos`, `textComplete: true`, and optional `edges`. The example reads `box.width` and `box.height` and passes the measurement to `pageRects`. |
| `jpegxl/page-rects`: `pageRects` | The measurement, `{width, height}` canvas, and `{area: {x?, y?, width?, height?}, edges}`. Area is in CSS pixels. Defaults cover the measured element. | `{exactRects, photoRects}` arrays in whole canvas pixels, plus `textComplete: true` when carried by the measurement. Rectangles have `{x, y, width, height}`. Exact rectangles may also have `solidText` or `edge`. |
| Display decoder: `jpegxl/decode` | Imported only if a lossy file cannot display natively. In a browser it runs in its own worker. | `decode(blob, options): Promise<DecodedImage>`. |
| Decoder: `decode` | The JXL Blob. `{format: 'uint8', colorSpace: 'srgb', maxPixels: 268435456, signal?}` | `{data, width, height}`. Build the RGBA view with `new Uint8ClampedArray(data.buffer as ArrayBuffer, data.byteOffset, data.byteLength)`. |

Measurements are taken in `afterClone`, before the page can change. The export maps them through the capture's viewBox,
clip and scale. Below 1:1, text boxes round outward. When photos remain, the smaller of photographic and whole-exact
capture wins. Without a measurement, the whole capture stays exact.

The plug-in carries measurement completion automatically. Custom integrations forward the whole `pageRects` result,
including `textComplete` and an empty `exactRects` array. The marker comes from `measure`. A hand-built or partial
measurement leaves it absent. A solid-text box over a region coded as a photo stays exact in full, including its background.

Efforts 6–9 need no JPEG XL decoder: with text and photo rectangles, rapier-jxl measures photos on the encoder's own
reconstruction.

## SnapDOM calls and return shapes

`jxl()` returns `{name: 'jxl', pure: true, afterClone?, defineExports}`. Equal options return the same plug-in. Exact
capture has no `afterClone` hook. The hook reads `context.element`, `context.nodeMap` and `context.outerTransforms`.
Exports read `context.meta`'s `contentX`, `contentY`, `vbW`, `vbH`, `clip`, `targetW` and `targetH`, `context.width` and
`context.height`, and `context.export.requestedOptions`. `pure: true` keeps SnapDOM's memoization: the measurement depends on the DOM alone.

`defineExports({exports})` uses `exports.canvas(options): Promise<HTMLCanvasElement>` and
`exports.blob(options): Promise<Blob>`. It returns:

| Hook | SnapDOM result method | Return |
| --- | --- | --- |
| `jxl(context, options = {})` | `toJxl(options)` | `Promise<HTMLImageElement>` |
| `blob(context, options = {})` | `toBlob(options)` | `Promise<Blob>`. JPEG XL has MIME type `'image/jxl'` |
| `download(context, options = {})` | `download(options)` | `Promise<void>` |

`toJxl()` first displays the JPEG XL file. Where the browser cannot show JPEG XL, the image is a PNG preview, not the
file: of the drawn canvas for an exact capture, of the decoded file for a lossy one. The saved Blob remains JPEG XL. Downloads use a file
share sheet where supported on iOS, otherwise a browser download.

`jxl.d.ts` exports `jxl`, `JxlOptions`, `JxlExportOptions`, `JxlContext`, `JxlPlugin`, `SnapDOMExports`,
`CaptureEncoder`, `CaptureHelpers`, `CaptureModule`, `LeanCaptureModule`, `CompleteCaptureModule`, `CaptureEffort`,
`UploadEffort`, and `Effort`. It adds the three JPEG XL result methods to SnapDOM's `CaptureResult` type.
