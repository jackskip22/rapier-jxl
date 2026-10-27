# Drafts for Jack

Drafts only. Jack posts them.

## SnapDOM #541

Thanks for the link! I’ve made a reference plugin using your `defineExports` API, with an offline demo and tests against SnapDOM 3.4.0.
It adds `result.toJxl()` through one reusable worker. The encoder, worker client and adapter total **22,175 bytes gzip**, with no WASM or extra GPU download. Exact pixels are the default; bounded RGB error is optional, and alpha stays exact.

```js
const encoder = createEncoder({
  worker: () => new Worker('/assets/capture-worker.js', { type: 'module' }),
});
const result = await snapdom(element, { plugins: [jxlExport({ encoder })] });
const blob = await result.toJxl(); // image/jxl
// Keep encoder for the next capture; encoder.close() when finished.
```

On the included full-HD scene with text, shadows and a photo, the exact JXL is 342,821 bytes versus the browser PNG's 804,840; at 4K it is 896,177 versus 2,404,437. The browser worker's warm medians were 995 ms and 2,603 ms on hosted Linux/Chrome 155. PNG was much faster; WebP lossless also beat this path on size and speed in the native comparison. Laptop and phone qualification is still outstanding.

[Implementation and offline demo](https://github.com/jackskip22/rapier-jxl/tree/task/astra-capture-encoder-20261027/examples/snapdom), [full measurements](https://github.com/jackskip22/rapier-jxl/blob/task/astra-capture-encoder-20261027/docs/CAPTURE-AUDIT.md). The adapter itself is 400 gzip bytes and only uses the small, tested public encoder contract, so it can live in your plugin repo. This is an unpublished comparison branch.

## Gutenberg #76981 — two lines

`await encode({ data: rgba, width, height }, options)` from `rapier-jxl/capture` fits your existing upload worker queue: 18,662 gzip bytes, no WASM, and exact RGBA by default.
[The comparison](https://github.com/jackskip22/rapier-jxl/blob/task/astra-capture-encoder-20261027/docs/CAPTURE-AUDIT.md) includes wasm-vips 0.0.19 at effort 3: this FHD capture is smaller (342,821 vs 425,715 bytes), but slower (880 vs 530 ms warm) and uses more whole-process peak RSS (370 vs 279 MiB); decoding existing JXL still needs native support or vips.

## Source context

- [SnapDOM #541](https://github.com/zumerlab/snapdom/issues/541)
- [Gutenberg #76981](https://github.com/WordPress/gutenberg/issues/76981)
- [Gutenberg #77584](https://github.com/WordPress/gutenberg/pull/77584)
- Capture output sizes: final capture-kernel measurements, checked against native decoder; PNG bytes: `bench/capture/fixtures/manifest.json`.
- Timings and memory are environment-specific; the linked audit records versions, cold/warm runs, worker measurements and remaining qualification limits.
