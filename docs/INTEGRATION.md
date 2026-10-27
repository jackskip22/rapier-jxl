# The integration contract

Import `createEncoder` from `rapier-jxl/image`, give it a private worker URL or factory, and call `encode(source, options)` for a `Promise<Uint8Array>`. `close()` ends the worker. We keep that surface, its input ownership, errors, exact default and cancellation behavior stable while improving encoding internals. Source and built-worker contract tests run during every build; changing these promises requires an explicit contract-version decision.

```js
import {createEncoder} from 'rapier-jxl/image';
const encoder = createEncoder({worker: '/assets/capture-worker.js'});
try {
  const bytes = await encoder.encode(canvas, {signal: controller.signal});
  return new Blob([bytes], {type: 'image/jxl'});
} finally {
  encoder.close(); // When this host is done; reuse it across ordinary exports.
}
```

Copy the selected `dist/*-worker.js` to that URL. Each worker is one self-contained file. A factory may create a module worker with a host-resolved URL. A bare package name passed to `new URL()` does not resolve npm exports in a native browser.

## Inputs and ownership

- Straight RGBA in `{data, width, height}`, ImageData, canvas, OffscreenCanvas, ImageBitmap, image element, or Blob/File. There is no URL fetching.
- Capture uses 8-bit samples. Photo and full retain their native-precision APIs. Raw arrays may be views with nonzero offsets.
- Inputs are borrowed until settlement; do not change them while pending. The client copies an active raw buffer before transfer. It never detaches the caller's array or bitmap.
- Only one image is active. Two may wait by default; `maxQueue` changes that count. Waiting work holds references and does not make extra pixel copies.
- Default decoded-image limit: 24 million pixels, 16,384 on either edge. `maxPixels` may lower it; a photo client can raise it to 40 million. A per-call bound cannot exceed its client bound.
- The browser applies image orientation/color conversion and canvas premultiplication. Byte-exact promises concern the supplied straight samples, or the browser's resulting raster. Raw alpha and hidden RGB are preserved exactly in capture mode.

## Options

| Option | Meaning |
| --- | --- |
| `maxError` | Capture: integer 0–8. Zero is exact. Higher values bound visible RGB error only. |
| `gpu` | `auto` (default) or `cpu`. GPU failure selects CPU; lossless coding stays on CPU. |
| `signal` | AbortSignal. A queued request is removed; an active request terminates its private worker. Later requests use a fresh worker. No partial file resolves. |
| `onProgress` | Monotonic fraction 0–1. Throwing rejects that request. |
| `colorSpace` | Declare raw samples' existing space. Contradicting a source declaration rejects. No relabelling or conversion. |
| `maxPixels` | Bound decoded pixels before the encoder workspace is allocated. |
| `quality`, `effort`, `target` | Photo options. See the photographic API and benchmark caveats. |
| `transcode` | Full worker: false decodes JPEG pixels instead of carrying the original JPEG. |

The output is always bytes. Blob creation is one host-side line; download and object-URL lifetime remain with the host. Invalid input/options reject. Queue overflow rejects with `JXL_QUEUE_FULL`; closed clients use `JXL_CLOSED`; worker startup/crash uses `JXL_WORKER`; a mismatched worker contract uses `JXL_PROTOCOL`. Abort rejects with `signal.reason`, including a non-Error reason. `close()` is idempotent.

## Existing worker queues

A Gutenberg-style queue already owns its worker and buffers. Import `encode` from `rapier-jxl/capture` or `rapier-jxl/photo` there and pass its RGBA directly. Do not start another worker. Node and Deno use the same direct API; browser-only image decoding is not required for raw pixels.

```js
import {encode} from 'rapier-jxl/photo';
const bytes = await encode({data: rgba, width, height}, {quality: 90, effort: 9});
postMessage(bytes, [bytes.buffer]);
```

For full format operations, `rapier-jxl/full` exposes `createEncoder()` inside a worker/Node and the typed `format` protocol. `capture` and `photoTarget` are included alongside every existing format action. Full also retains animation, JPEG reconstruction, HDR, ICC, metadata, layers and progressive/container tools.
