# Rapier JXL

JPEG XL encoder in JavaScript. Smaller files than libjxl at the same quality, a quality search that runs on WebGPU,
68 KB gzipped. Runs in browsers, workers, Node and Deno. MIT license, no dependencies.

```sh
npm install rapier-jxl
```

Use ESM imports in Node 20.16 or later on 20.x, or 22.3 or later, in Deno and in Bun. On Node 20, Brotli-compressed
metadata uses the portable reader; streams it cannot read are refused. Use Node 22.23.4 or supply the metadata API's
`decompress` function for those streams.

## What each call keeps

| Import | Call | Keeps |
| --- | --- | --- |
| `rapier-jxl` | `encode(picture, options)` | Your pixels, at `quality` (default 90) or `lossless: true`. Effort 1–9, default 7. |
| `rapier-jxl` | `createEncoder(limits)` | An owned queue: jobs in order, within your byte, pixel and job limits. |
| `rapier-jxl/capture` | `encode(pixels, {maxError})` | Every RGBA sample at `maxError: 0`. At 1–8, each RGB sample moves by at most that much; alpha stays exact. |
| `rapier-jxl/jpeg` | `recompress(jpeg)`, `restore(jxl)` | The original JPEG file, byte for byte. |
| `rapier-jxl/decode` | `decode(jxl)`, `inspect(jxl)` | Pixels and header from any JPEG XL file, within your limits. |
| `rapier-jxl/animation` | `encode({width, height, loops, frames})` | Every frame and its duration in milliseconds. |
| `rapier-jxl/metadata` | `read`, `write`, `inspect`, `repack`, `stream` | The codestream, while Exif, XMP and boxes change. |
| `rapier-jxl/format` | `encode({kind, image})` | Extra channels, layers, patches, splines and other specialist features. |
| `rapier-jxl/offline` | `encode(picture, options)` | The same bytes as `encode`, from one file with no imports. |

A picture is `{data, width, height}` RGBA pixels, ImageData, a canvas, an ImageBitmap or an image Blob. Inputs are
copied when you call, so later changes to your buffers never reach the file. Encoding calls return a promise of a
`Uint8Array`. A Blob is one line: `new Blob([bytes], {type: 'image/jxl'})`. Errors carry a `code`, and an option a call
does not take is refused, never ignored.

Chrome 155 and Firefox 158 decode JPEG XL themselves (`<img>`, `createImageBitmap`); `rapier-jxl/decode` is for the
browsers and runtimes that don't.

A canvas is read in its own color space. An ImageBitmap shows none, so it is read in sRGB; name
`colorSpace: 'display-p3'` to read either one in Display P3. A canvas stores colors premultiplied by alpha, so where
alpha is below 255 the browser may round them by a step or two, and the file keeps what the browser gives. For exact
colors under partial alpha, pass `{data, width, height}` or ImageData. A canvas that has lost its 2D context (after a
GPU reset) reads back black, so it is refused with `JXL_INPUT`; draw it again. An ImageBitmap made from such a canvas
looks like black pixels and cannot be told apart.

## Sizes

Each import costs a few kilobytes. A call loads its codec the first time it runs, and only that codec.

| | Gzip |
| --- | ---: |
| `rapier-jxl` import | 6.0 KB |
| Capture, first call | +31.7 KB |
| Instant encode (effort 1), first call | +61.8 KB |
| Encode at efforts 2–7, first call | +91.8 KB |
| An upload queue's first call: 3 helpers, sizes at once, effort 3, `acceleration: 'wasm'` | +192.3 KB |
| Lossy encode at efforts 8–9, first call | +141.3 KB |
| JPEG recompress, first call | +90.6 KB |
| JPEG restore, first call | +66.7 KB |
| Decode, first call | +67.3 KB |
| Animation, first call | +103.7 KB |
| Offline single file | 144.4 KB |

A first-call size is every file a page loads for that call, each once, measured by running it, the worker that runs
it included. 5.0 KB of each is common to every call: the worker, its runtime and shared code. Each helper
loads the same encoder files; a server that lets browsers cache them sends them once. The Brotli dictionary
(61.0 KB) loads only for a file from another encoder whose compressed data uses it; files this
package writes never need it.

## Examples

```js
import {encode} from 'rapier-jxl';
const bytes = await encode({data: new Uint8Array([240, 120, 40, 255]), width: 1, height: 1}, {quality: 90});
```

```js
import {encode as capture} from 'rapier-jxl/capture';
import {decode} from 'rapier-jxl/decode';
const screenshot = await capture({data: new Uint8Array([10, 20, 30, 0]), width: 1, height: 1}, {maxError: 0});
const pixels = await decode(screenshot);
```

```js
import {createEncoder} from 'rapier-jxl';
// One queue for the page's life: 3 helper workers inside 1 GiB, kept between uploads.
const queue = createEncoder({helpers: {count: 3, memoryBytes: 1024 * 1024 * 1024}});
const cancel = new AbortController();
// An upload: every size at once. The queue runs up to 4 together, with the same bytes as one at a time.
function upload(sizes) {
  return Promise.all(sizes.map(picture =>
    queue.encode(picture, {quality: 82, effort: 3, acceleration: 'wasm', signal: cancel.signal})));
}
const photo = (width, height) => ({data: new Uint8Array(width * height * 4).fill(200), width, height});
const files = await upload([photo(1200, 900), photo(768, 576), photo(300, 225), photo(150, 150)]);
console.log(files.map(bytes => bytes.length));
queue.close();
```

```js
import {recompress, restore} from 'rapier-jxl/jpeg';
// originalJPEG: a Uint8Array holding a complete JPEG file.
async function roundTrip(originalJPEG) {
  return restore(await recompress(originalJPEG));
}
```

Eight complete examples, one for each kind of work, are in the repository's `examples/` folder (they are not in the
npm package):

1. A saved offline page, with the self-contained encoder.
2. A DOM capture, exact and bounded.
3. An upload queue with progress and cancel.
4. Exact JPEG recompression, and restoring a JPEG another encoder made.
5. 16-bit and float pixels on a server, and a depth channel.
6. Animation with exact durations.
7. Decoding, with limits for untrusted files.
8. Metadata and container editing.

## Queues and workers

In a browser, `encode` and `createEncoder` run in a module worker that starts on the first call. In Node, Deno and
workers, calls run in place. `worker: false` runs in place anywhere, and `workerFactory` supplies your own worker
(`rapier-jxl/worker` or the classic `rapier-jxl/worker-classic`).

- **Order.** Jobs start in the order you submit them. Without helpers, one runs at a time.
- **Cancel.** Canceling a waiting job removes it. Canceling a running job ends it; if it runs alone in its worker,
  that worker ends and the next job starts a fresh one.
- **Crashes.** A crash fails only the jobs running in the worker that crashed.
- **Progress** only rises, and reaches 1 only with a result.
- **Limits.** The defaults are 256 MiB of input and options held by the running and waiting jobs, 40 million pixels
  per picture and 32 jobs, running jobs included. A worker that does not start within 15 seconds is refused
  (`workerStartupTimeout`).
- **Helpers.** `createEncoder({helpers: {count: 3, memoryBytes: 1024 * 1024 * 1024}})` reserves up to `count` helper
  workers (0–16) inside `memoryBytes`, kept from their first job until `close()`. Jobs
  waiting together run at once, up to `count + 1`: one in the queue and the others whole on the helpers, while they fit
  in `memoryBytes`. A lossy job alone uses every helper for itself only at effort 7 and above on half a megapixel or more,
  where that measured faster; otherwise a job that arrives while it runs starts beside it. There are none by default,
  and the CPU count grants none. The bytes are the same with any number of helpers.
  Submit an upload's sizes together to run them at once.

These limits bound what you hand the queue, not the encoder's working memory. Pick effort and concurrency for your
devices.

Neither the package nor its workers need `blob:` URLs, `eval`, SharedArrayBuffer or cross-origin isolation. A bundler
must include the worker and its imports in the deployed files.

## Bundlers

webpack 5 (including `@wordpress/scripts`) and Next.js recognize the package's module worker. In Next.js, import it
inside a client component for browser work or a Node server route for server work. The same API runs in place in your
own worker.

Vite recognizes the worker too. Keep its codecs lazy with this setting in `vite.config.mjs`; the default worker
format combines them into one larger script:

```js
export default {worker: {format: 'es'}};
```

esbuild and Rollup need the workers as extra entries: the codec worker, and the helper worker for `helpers`. Keep
the generated client chunks beside `worker.mjs` and `parallel-worker.mjs` so the package's relative worker URLs
resolve. These configurations leave the application imports above unchanged.

For esbuild, run this build script and load `dist/app.mjs` from your HTML:

```js
import {build} from 'esbuild';
import {createRequire} from 'node:module';
const require = createRequire(import.meta.url);
await build({
  entryPoints: {app: 'app.mjs', worker: require.resolve('rapier-jxl/worker'),
    'parallel-worker': require.resolve('rapier-jxl/parallel-worker')},
  bundle: true, format: 'esm', splitting: true, platform: 'browser',
  outdir: 'dist', outExtension: {'.js': '.mjs'},
});
```

For Rollup, use `@rollup/plugin-node-resolve` and this `rollup.config.mjs`, then load `dist/app.mjs`:

```js
import {nodeResolve} from '@rollup/plugin-node-resolve';
import {createRequire} from 'node:module';
const require = createRequire(import.meta.url);
export default {
  input: {app: 'app.mjs', worker: require.resolve('rapier-jxl/worker'),
    'parallel-worker': require.resolve('rapier-jxl/parallel-worker')},
  plugins: [nodeResolve()],
  output: {dir: 'dist', format: 'es', entryFileNames: '[name].mjs', chunkFileNames: 'chunk-[hash].mjs'},
};
```

Deploy the complete build output, including dynamically loaded chunks. Measure both deployed files and the files
loaded by the first call: a bundler can emit separate page and worker copies of a shared module.

For Parcel 2.16.4, enable package exports and use its non-hoisted build for the worker's shared modules. Add these
settings to your application's `package.json`:

```json
{
  "@parcel/resolver-default": {"packageExports": true},
  "scripts": {"build": "parcel build index.html --no-scope-hoist"}
}
```

Parcel generates an inline import map. Under a strict Content-Security-Policy, authorize that map with a nonce or
the SHA-256 hash of its exact contents in `script-src`.


## Acceleration

JavaScript is the default, so a page that never asks makes no WebAssembly attempt and needs no `'wasm-unsafe-eval'`.
`acceleration: 'wasm'` runs the WebAssembly kernels (SIMD where the browser has it), `'webgpu'` the GPU and `'auto'`
both; each loads on first use and falls back to JavaScript when it is unavailable or your page's Content-Security-Policy
lacks `'wasm-unsafe-eval'`.
WebGPU serves photographs at efforts 4–6, and at effort 7 below 8 megapixels. The bytes are the same on every backend.

## Offline documents

`rapier-jxl/offline` is the still encoder in one file with no imports, for a page saved to disk. It writes the same
bytes as `encode` and runs in place, yielding between steps.

The package ships minified ESM, declarations, this README, LICENSE and the required third-party notices.
