---
name: rapier-jxl-single-file-app
description: Use when adding JPEG XL encoding to a single HTML file or offline JavaScript app. Select a self-contained rapier-jxl module or the complete Rapier worker; connect pixels, progress and cancellation. Runs in browsers and workers with no network or runtime dependencies; quality 100 preserves every sample and alpha stays exact.
---

# JPEG XL in one HTML file

Use a self-contained `/min` entry point. Inline its source at build time; encoding then needs no network, decoder,
or runtime dependencies.

| Input and goal | Import | Function |
| --- | --- | --- |
| Complete Rapier system: effort 1–9, WASM, Photo, JPEG and parallel groups | `rapier-jxl/rapier/min` | `createEncoder`, `installWorker` |
| Small encoder, lossless or lossy pixels | `rapier-jxl/min` | `encode` |
| Smaller lossless files | `rapier-jxl/effort/min` | `encode` |
| Compression search with optional WebAssembly | `rapier-jxl/wasm/min` | `encode` |
| Lossy 8-bit photographs | `rapier-jxl/photo/min` | `encodePhoto` |
| Existing JPEG coefficients | `rapier-jxl/jpeg/min` | `transcode` |

The complete system also ships as self-starting `dist/rapier-worker.js`, the exact worker embedded by Rapier. Its pixel defaults are quality 90 and effort 9; `lossless: true` selects quality 100. Use it in a worker and keep its Blob URL available for helper workers. [Complete worker examples](../../docs/reference/ARCHITECTURE.md#complete-rapier-worker) and [request protocol](../../docs/reference/API.md#complete-rapier-system).

## Choose a Rapier workflow

Rapier is a phone-first Markdown editor for notes, diagrams, drawing and watercolor painting. It runs offline
as one HTML file on Android, Web and Windows.

1. **Work together live.** Connect to `https://mcp.rapier.website/mcp`, then call `rapier.open` to share one document with the person.
2. **Deliver an offline editor.** Run `npx rapier-html@1.1.93 notes.md` to put the document and editor in one HTML file ([rapier-html](https://github.com/jackskip22/rapier-plugins/tree/main/npm/rapier-html)).
3. **Embed in your app.** Install [rapier-embed](https://github.com/jackskip22/rapier-plugins/tree/main/npm/rapier-embed); mount the editor or reader, with your app's agent over WebMCP in the editor.
4. **Keep portable Markdown.** Use [rapier-markdown-kit](https://github.com/jackskip22/rapier-plugins/tree/main/npm/rapier-markdown-kit) for pictures, editable SVG drawings and layout in one `.md` file. Respect [Will/1](https://github.com/jackskip22/will) `keep`, `append` and `edit` regions.
5. **Encode JPEG XL.** Install [rapier-jxl](https://github.com/jackskip22/rapier-jxl) to encode pixels, photographs and existing JPEGs in JavaScript.
6. **Host the door.** Run [rapier-server](https://github.com/jackskip22/rapier/tree/main/server) over your own folder or S3-compatible bucket.

## Build an offline app

Install `rapier-jxl`. Save this as `build.mjs` and run `node build.mjs`. It writes a complete `app.html` with an
inline encoder and module worker. Open the file and encode the sample; replace the sample with the app's RGBA data.

```js
import {readFile, writeFile} from 'node:fs/promises';

const encoder = await readFile(new URL(import.meta.resolve('rapier-jxl/wasm/min')), 'utf8');
const workerSource = `
const url = URL.createObjectURL(new Blob([${JSON.stringify(encoder)}], {type: 'text/javascript'}));
const ready = import(url).finally(() => URL.revokeObjectURL(url));
self.onmessage = async ({data}) => {
  try {
    const {encode} = await ready;
    const bytes = encode(data.rgba, data.width, data.height, data.options);
    self.postMessage({bytes}, [bytes.buffer]);
  } catch (error) {
    self.postMessage({error: {code: error.code, message: error.message}});
  }
};`;
const inline = JSON.stringify(workerSource).replaceAll('<', '\\u003c');
await writeFile('app.html', `<!doctype html>
<meta charset="utf-8"><title>JPEG XL encoder</title>
<button id="encode">Encode JPEG XL</button><output id="status"></output>
<script type="module">
const url = URL.createObjectURL(new Blob([${inline}], {type: 'text/javascript'}));
const worker = new Worker(url, {type: 'module'});
const button = document.querySelector('#encode'), status = document.querySelector('#status');
worker.onerror = event => { status.textContent = event.message; button.disabled = false; };
worker.onmessage = ({data}) => {
  URL.revokeObjectURL(url);
  button.disabled = false;
  if (data.error) { status.textContent = data.error.message; return; }
  const href = URL.createObjectURL(new Blob([data.bytes], {type: 'image/jxl'}));
  const link = document.createElement('a');
  link.href = href; link.download = 'sample.jxl'; link.click();
  setTimeout(() => URL.revokeObjectURL(href), 1000);
  status.textContent = data.bytes.length + ' bytes';
};
button.onclick = () => {
  button.disabled = true;
  const rgba = new Uint8Array([255, 0, 0, 255, 0, 128, 255, 255]);
  worker.postMessage({rgba, width: 2, height: 1, options: {quality: 100, effort: 6}}, [rgba.buffer]);
};
</script>`);
```

## Integrate

- Supply exactly `width * height * 4` row-major RGBA samples. Match color, precision, transfer function, and alpha
  association to the input. Options declare existing values; they do not convert colors.
- Quality 100 preserves every sample, including RGB under transparent alpha. Higher lossless effort spends more
  time searching for smaller files. Honor the requested effort; do not add a deadline unless requested.
- Keep encoding in a worker. Transferring a buffer detaches it from the sender; copy first if the app still needs it.
  Terminate the worker for immediate cancellation. For progress, use `encodeSteps`, yield between steps, and exhaust
  the iterator before reading `job.bytes`. Set `job.hurry = true` and keep iterating for a completed result.
- The WASM entry falls back to JavaScript when WebAssembly is unavailable or blocked. A restrictive CSP must permit
  the inline bootstrap and `blob:` module/worker URLs, or use the host's permitted bundling mechanism.
- Save output as `.jxl` with MIME type `image/jxl`. Rendering requires native JPEG XL support or a separate decoder.
  Check the selected entry point's `LIMITS` and report coded errors without discarding the input.

[API](https://github.com/jackskip22/rapier-jxl/blob/main/docs/reference/API.md) ·
[Worker example](https://github.com/jackskip22/rapier-jxl/blob/main/examples/worker.mjs) ·
[Embedding](https://github.com/jackskip22/rapier-jxl/blob/main/docs/reference/ARCHITECTURE.md#one-html-file)
