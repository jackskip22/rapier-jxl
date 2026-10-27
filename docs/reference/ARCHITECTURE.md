# Entries and embedding

Choose by workload: **capture**, **photo**, **full**. The same `image` client owns a persistent private worker for any of them. A host with an existing queue imports an encoder directly.

| Job | Source entry | Self-contained build |
| --- | --- | --- |
| Exact and bounded-error captures | `rapier-jxl/capture` or `rapier-jxl` | `capture.min.mjs`, `capture-worker.js` |
| High-quality photographs and target search | `rapier-jxl/photo` | `photo.min.mjs`, `photo-worker.js` |
| Complete format toolkit | `rapier-jxl/full` | `full.min.mjs`, `full-worker.js` |
| Worker queue, cancellation, borrowed inputs | `rapier-jxl/image` | `image.min.mjs` |
| Minimal general RGBA engine | `rapier-jxl/core` | `core.min.mjs` |

[Stable integration contract](../INTEGRATION.md) · [Every entry, mode and measured size](../CAPTURE-AUDIT.md) · [Detailed API](API.md)

## One encoder, several jobs

Capture enters the existing screen modular/LZ77 models directly. It shares group framing, palette admission, predictors, bit writing and entropy coding with the general effort encoder. It chooses a representation per group, retains the four-predictor search, and avoids the effort ladder's redundant whole-image candidates. No second encoder or entropy implementation is introduced.

Photo combines fixed-quality encoding and target search with the same image reader and async lifecycle. Full reuses those paths and retains the specialist writers. The old mixed still-worker distribution is replaced by the focused photo worker and the complete full worker. The per-call image helper is replaced by the persistent client; there are no adapter aliases or migration paths.

Specialist entries remain deliberate, tree-shakeable surfaces: `effort`, `wasm`, `jpeg`, `score`, `photo-plan`, `photo-advanced`, `photo-ans`, `noise`, `hybrid`, `graphics`, `icc`, `opsin`, `delta-palette`, `splines`, `channels`, `layers`, `patches`, `jpeg-ans`, `animation`, `animation-atlas`, `writer`, `source`, `metadata`, `brotli`, `container`, `container-advanced`, `progressive-container`, `delivery`, and `kernels`. Their format features are retained; callers need not load them for screenshots.

`build.mjs` bundles the actual import graph once per entry. All GPU code is included; there are no external chunks or runtime downloads. Optional Node Brotli uses the host's built-in `node:zlib`. WASM kernels, when selected, are inlined and retain the JavaScript fallback. No property-name mangling crosses public interfaces.

## Worker ownership

The page client holds a bounded queue and sends only one active image. It creates its own worker, waits for a version handshake, transfers only owned copies, and closes resources on failure or cancellation. Terminating an active request cannot cancel a later queued request. Host-owned upload queues call the direct API instead of nesting workers.

The browser rasterizes canvas/bitmap/Blob input. Node and Deno can supply raw RGBA. The codec does not fetch image URLs and does not include a JPEG XL pixel decoder.

## One offline HTML file

The [SnapDOM demo](../../examples/snapdom/README.md) uses only local assets. For a single HTML file, embed the complete chosen worker and image module as inert script text, keep their MIT notices, then create Blob URLs. Revoke those URLs after `encoder.close()`. No secondary file is fetched by a generated encoder.

A CSP must permit the chosen module and worker sources. The host controls downloads and object-URL lifetime. Encoding works without native JPEG XL display support; display requires the browser decoder or a separate decoder.
