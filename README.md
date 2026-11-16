# rapier-jxl

[![npm](https://img.shields.io/npm/v/jpegxl)](https://www.npmjs.com/package/jpegxl)
[![downloads](https://img.shields.io/npm/dw/jpegxl)](https://www.npmjs.com/package/jpegxl)
[![license](https://img.shields.io/npm/l/jpegxl)](https://github.com/jackskip22/rapier-jxl/blob/main/LICENSE)
[![types](https://img.shields.io/npm/types/jpegxl)](https://www.npmjs.com/package/jpegxl)

JPEG XL in JavaScript and WebAssembly with WebGPU for high efforts.

rapier-jxl, published on npm as `jpegxl`.

Used by [SnapDOM's official JPEG XL plugin](https://snapdom.dev/plugins/jxl/) and the [EmDash JPEG XL Image Optimizer plugin](https://plugins.emdashcms.com/plugins/@rapier.website/jxl). [Try it in your browser](https://rapier.website/jxl).

rapier-jxl is the encoder inside [rapier.website](https://rapier.website), the free Markdown editor and painting app. Rapier is also a free [Android app](https://play.google.com/store/apps/details?id=app.rapier&referrer=utm_source%3Djxl-readme) that opens and converts JPEG XL pictures.

- Uploads over 2x faster than libvips.
- 61 KB Brotli exact capture.
- 293 KB Brotli complete capture.
- 331 KB Brotli upload.
- 485 KB Brotli full encoder with HDR and parallel workers. Used by [rapier.html](https://rapier.website)
- Lossless JPEG transcoding, decoding, verification, serving, metadata, animation, polyfill, CLI and resumable encoding
  for edge isolates. Modules are single files.
- Browsers, workers, Node, Deno, Bun, Cloudflare Workers.
- No dependencies.
- MIT.

```sh
npm install jpegxl
```

ESM. From CommonJS: `await import('jpegxl')`.

## Command line

```sh
npx jpegxl photo.png                  # photo.jxl beside it
npx jpegxl scan.jpg                   # scan.jxl, lossless; the original JPEG can be restored
npx jpegxl photos/ --out dist/        # every PNG, JPEG and GIF in the folder
npx jpegxl hero.png --max-bytes 100KB # lower quality to fit, keeping dimensions
npx jpegxl scan.jxl --out back/       # back/scan.jpg, the original JPEG
npx jpegxl photos/ --out dist/ --json  # one JSON line per file, then a summary
```

`--quality 1–100`, default 90, exact for a JPEG. `--effort 1–9`, default 7. `--exact`, `--jpeg-pixels`, `--max-bytes`, `--out`, `--jobs` for helpers.
Automatic output names never replace files.
`--json` names what each file kept: `jpeg-bytes` (the JPEG restores exactly), `pixels` (exact) or `lossy`. A rerun
leaves finished files untouched.
At efforts 6–9, a JPEG at a quality stays a JPEG when that is smaller.
`--jpeg-pixels` encodes a JPEG's pixels; the file does not restore the JPEG.

## Upload

```js
import {encode, fit} from 'jpegxl/upload';

// file: a File or Blob from an input, a drop or a fetch.
const compress = async file => {
  const result = await encode(file, {fidelity: {quality: 82}});
  if (!result.bytes) throw Object.assign(new Error(result.reason.message), {code: result.reason.code});
  return new Blob([result.bytes], {type: 'image/jxl'});
};
const small = file => fit(file, {maxBytes: 100_000}); // best quality under 100 KB; `meetsTarget` says whether it got there
```

`variants` makes several sizes from one upload. All calls accept `onProgress` and `signal`, for progress bars and
cancelling. On Node and Deno, pass pixels `{data, width, height}`, or a PNG file as `new Blob([bytes])`. A JPEG needs one
setup step first. In Node, Deno or Bun, import `configureDecoder` from `jpegxl`, `decode` from `jpegxl/decode` and
`recompress` from `jpegxl/jpeg`, then call `configureDecoder(decode, null, recompress)` once.
A page with no bundler needs an import map or a path: `import {encode} from '../dist/upload.mjs'`.

## Encode

```js
import {writeFile} from 'node:fs/promises';
import {encode} from 'jpegxl';

const picture = {data: new Uint8Array([240, 120, 40, 255]), width: 1, height: 1};
await writeFile('picture.jxl', (await encode(picture, {fidelity: {quality: 90}})).bytes);
```

Takes RGBA `{data, width, height}`, `ImageData`, a canvas (2D, WebGL or WebGPU), an `ImageBitmap`, a `VideoFrame`, a
`Blob`, a decoded image or a GPU texture `{texture, device}`, and returns a result record with the output in `result.bytes`. 8 or 16-bit, `Float16Array`
or `Float32Array` samples, including HDR. For animations, including an animated GIF `Blob`, use `jpegxl/animation`. Input `frames[i].duration` is milliseconds. `decode()` returns the frames in `result.frames`; each frame has `duration` in ticks and `durationSeconds` in seconds.

- `encode(jpeg, {fidelity: 'exact'})` keeps a JPEG so it restores exactly, as `recompress` does.
- At efforts 6–9, a JPEG at a quality stays a JPEG when that is smaller.
- A kept JPEG answers `kept: 'jpeg-bytes'`. `jpeg: 'pixels'` encodes its pixels, in `fit` and `variants` too.
- `originalBytes` is the input file's size. `largerThanOriginal` says the output is bigger.
- `jpegxl/hdr` reads OpenEXR and Radiance files.
- `fidelity`: `{quality: 1–100}`, default 90. `'exact'` is lossless.
- `effort`: 1–9, default 7. Lower is faster; 1–3 suit previews and uploads, 8–9 photography.
- Efforts 6–9 measure quality. Efforts 1–5 estimate it.
- `webgpu`: left out, efforts 7–9 use WebGPU where it helps; the result's `usedWebGPU` says whether it did. `'required'`
  fails without it, and at efforts 1–6 or exact, which run on WebAssembly; `false` turns it off.
- `maxPixels`: no default bound; set it to bound memory. A side is at most 2^30 (the JPEG XL size field); what the host cannot hold refuses `JXL_MEMORY`. Very large images can be passed in strips with `rows(y, count)`.
- `verify(original, result)` from `jpegxl/verify` checks a file against its source: the file the encoder wrote. A file edited afterwards, such as one given Exif or XMP, is another file and is refused.

## Screenshots

```js
import {capture} from 'jpegxl/capture';
import {capture as page} from 'jpegxl/capture-complete';

const screenshot = canvas => capture(canvas); // lossless
const smaller = (canvas, rects) => page(canvas, {fidelity: {quality: 92}, ...rects}); // lossy photos, lossless text
```

- Canvas (2D, WebGL or WebGPU), `ImageData`, an `ImageBitmap`, a `VideoFrame`, a `Blob` or 8-bit RGBA.
- `rects` is `{exactRects, photoRects}`: the areas to keep lossless, such as text, and where the photos are.
- `jpegxl/page-rects` finds both in a page element, for any library that draws one to a canvas: `const rects = pageRects(element, canvas, {area}); await capture(canvas, {...rects, fidelity: {quality: 85}})`.
- Tall pages in one file, as tall as the browser draws them; WebP stops at 16,383.
- Efforts 6–9 check photo quality with the browser's JPEG XL decoder. In Node, Deno, Bun and desktop apps, the one setup
  step is `configureDecoder(decode)`, with `decode` from `jpegxl/decode`.

| Effort | `capture-complete` |
|---|---|
| 1–3 | Fast. 3 is the default, 2 for quick saves, 1 for live previews. |
| 4–5 | Deeper search: smaller text, graphics and photos without quality loss. |
| 6–9 | Automatically finds the smallest file at the quality you choose. 7–9 also search block sizes. |

## JPEG, decoding, metadata

```js
import {recompress, restore} from 'jpegxl/jpeg';
import {decode} from 'jpegxl/decode';
import {header} from 'jpegxl/metadata';

// jpeg: a Uint8Array holding a JPEG file.
const roundTrip = async jpeg => (await restore((await recompress(jpeg)).bytes)).bytes;
const pixels = async file => decode(file); // {width, height, data}, RGBA
const forCanvas = async bytes => decode(bytes, {format: 'uint8', colorSpace: 'srgb'}); // data is a Uint8ClampedArray
const size = file => header(file); // synchronous, from a file or its first bytes
```

`inspect` also reads the first 64 KiB of a JPEG or PNG for its size, orientation and color as `encode` writes it.
`recompress` runs at effort 7 unless given one. `restore(...)` returns `{bytes, ...}`; the JPEG is `.bytes`.
When a JPEG's trailing data (such as a phone's motion-photo video) is longer than the format's reconstruction box holds, recompress's and verify's records carry `otherDecoders: {missing, reason: 'past-jbrd'}`: other decoders return the JPEG without its last `missing` bytes, while `restore` returns all of it.

`jpegxl/svg-jxl` converts the images inside any SVG to JPEG XL where that makes them smaller while automatically keeping shapes and text sharp.
`{fidelity: 'exact'}` keeps the images lossless.

## Serving

For recompressed JPEGs, `serve` sends JPEG XL to browsers that support it and the original JPEG to the rest, with
`Vary: Accept`, ETag, `304` and `HEAD`.

```js
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {serve} from 'jpegxl/serve';

// photo.jxl, made once: npx jpegxl photo.jpg
const stored = await readFile('photo.jxl');
createServer((req, res) => serve(stored, req, res)).listen(3000);
```

Cloudflare Workers, Deno and Bun: `return serve(stored, request)`. `cacheControl` sets `Cache-Control` (default
`private, no-cache`).

## Resumable encoding

For edge isolates with short time limits: an encode continues across requests in short steps and writes the same file
as one call.

```js
import {start, advance, finish} from 'jpegxl/resumable';
import {encode} from 'jpegxl/upload';
import {verify} from 'jpegxl/verify';

// store: the original and the job's parts (R2, KV, a database). input names the original:
// {generation, sha256, byteLength}, with kind: 'file' for an uploaded file.
const step = async (saved, store, input, memoryBytes) => {
  const job = {operation: encode, store, input, verify, memoryBytes};
  const {checkpoint, done} = await advance(saved ?? await start({...job, options: {fidelity: {quality: 82}}}), job);
  return done ? {result: await finish(checkpoint, job)} : {checkpoint}; // save checkpoint for the next request
};
```

- `capture`, `encode`, `fit`, `variants`, `recompress`, `restore` and `verify`.
- Each `advance` runs for about 30 ms (`budget: {ms}`) and writes its parts to the store before it returns. A host that allows few store calls a request passes `budget.reads`: the call ends before more reads than that.
- Pass `memoryBytes` with each call to require a measured memory estimate below that many bytes. Unmeasured sizes, source types, and verified jobs refuse with `JXL_MEMORY` before encoding. Your host must enforce the process limit.
- `verify` from `jpegxl/verify` in the job verifies in the advances. `finish` returns the whole-file verifier's
  receipt in `result.verification` (one per variant). A failed check rejects with `error.verification`; publish only a finished,
  verified result. The saved plan keeps this choice for every request.
- Pixel verification needs the browser's JPEG XL decoding or the host's configured decoder. On a server, call
  `configureDecoder(decode, restore)` from `jpegxl/verify` with `decode` from `jpegxl/decode` and `restore` from
  `jpegxl/jpeg` in each new isolate. The resumable module carries no decoder.
- Keep the original immutable for its `generation` and SHA-256. Save the returned checkpoint with a revision check
  after its parts are durable, and accept checkpoints only from your service. `finish` assembles the saved output;
  hashing, decoding and scoring have already finished in the advances.
- `workerAdmission({operation, options, width, height})` says whether a job fits a Cloudflare Workers isolate (128 MB), from measured memory per operation, effort and size. A size not measured is not admitted; convert it in the browser.
- `workerAdmission` answers for `rapier-jxl`, `jpegxl/upload` (efforts 1-3, default 3) and `jpegxl/jpeg`.
- `store` is `{readSource(offset, length), read(ref), write(ref, bytes)}`. `input` is `{generation, sha256, byteLength, kind: 'file'}`; `sha256` is 64 lowercase hex digits, without a `sha256:` prefix.

For a candidate uploaded separately, use the existing `verify` verb. Store the candidate as immutable, ordered parts
of at most 1 MiB, each named by its SHA-256. Pass its result metadata without `bytes` or a `verification` receipt:

```js
import {start, finish} from 'jpegxl/resumable';
import {verify} from 'jpegxl/verify';

const job = (store, input) => ({operation: verify, input, store});
const begin = (store, input, result, parts) => start({...job(store, input), options: {result, parts}});
// Persist and advance the checkpoint as above. When done, finish returns the receipt:
const done = (checkpoint, store, input) => finish(checkpoint, job(store, input));
```

`finish` returns the same receipt as `verify(original, result)` and reads neither image. A failed check rejects with
`error.verification`. The service verifies the original generation and candidate revision again before publication;
metadata supplied by the uploader is a claim to check.

## EmDash

Run in the site's folder:

```sh
npx jpegxl add emdash
```

For a coding agent: “Add rapier-jxl/emdash to this site, keeping its existing storage and EmDash options.”

For manual setup with EmDash 1.4, install the package and its matching Kumo version:

```sh
npm install jpegxl @cloudflare/kumo@2.6.0
```

Keep the existing imports and options; wrap `emdash({...})` with `jxl(emdash, {...})`:

```js
// astro.config.mjs
import emdash from 'emdash/astro';
import {jxl} from 'jpegxl/emdash';

export default defineConfig({
  integrations: [react(), jxl(emdash, {database: d1({binding: 'DB'}), storage: r2({binding: 'MEDIA'})})],
});
```

Originals stay in the site's `r2()` storage on Cloudflare or `local()` storage on Node. Browsers that accept JPEG XL
get verified copies; other browsers get the original. Open **Plugins → JPEG XL Image Optimizer** to choose the goal, effort
and widths or convert the existing library. Without `jxl()`, the site serves its originals.

## Astro

```sh
npx jpegxl add astro
```

Then `<Image src={photo} format="jxl" />`. Astro 6 and 7.

- [Photos average 24% smaller than Astro's default WebP.](https://github.com/jackskip22/rapier-jxl/blob/main/bench/README.md#astro)
- [JPEGs 18% smaller, lossless.](https://github.com/jackskip22/rapier-jxl/blob/main/bench/README.md#astro)

## Vite

```sh
npx jpegxl add vite
```

Then `import hero from './hero.jpg?jxl'`. Vite 6, 7 and 8.

- [Photos 39% smaller than WebP and 11% smaller than AVIF at the same look.](https://github.com/jackskip22/rapier-jxl/blob/main/bench/README.md#vite)
- [Camera JPEGs 17% smaller, lossless.](https://github.com/jackskip22/rapier-jxl/blob/main/bench/README.md#vite)

## Cloudflare Workers

```sh
npx jpegxl public/ --out public/
npx jpegxl add workers --route example.com/*
```

Serves JPEG XL to browsers that accept it and the original to the rest. Runs on Workers Free.

- [Phone JPEGs 18% smaller, lossless.](https://github.com/jackskip22/rapier-jxl/blob/main/bench/README.md#cloudflare-workers)

## Cloudflare R2

```sh
npx jpegxl add r2
```

Every JPEG or PNG put into the bucket gets a JPEG XL file beside it, made from the bucket's event notifications through a Queue. A JPEG's is lossless: `restore` gives the same JPEG back exactly. Large pictures convert as a Cloudflare Workflow. Reads answer JPEG XL to browsers that accept it and the original to the rest.

## Cloudflare Agents

```sh
npx jpegxl add agents
```

JPEG XL tools for agents in an Agents SDK project: convert, recompress, restore, verify and inspect, as an MCP server and for an Agent class. Pictures stay in R2; the agent gets keys, never bytes.

## Workers and queues

```js
import {encode, configure, close} from 'jpegxl/upload';

configure({helpers: {count: 3, memoryBytes: 1 << 30}});
const photo = (width, height) => ({data: new Uint8Array(width * height * 4).fill(200), width, height});
try {
  const files = await Promise.all([photo(1200, 900), photo(300, 225)].map(picture => encode(picture)));
} finally {
  await close();
}
```

- In browsers, each module's import runs it in its own worker (upload: 349 KB Brotli); no setup is
  needed. Imported inside a worker of your own, it runs there. Node, Deno, Bun and edge hosts run it in the calling thread.
- `configure` sets a module's queue before its first call: `helpers`, `maxPixels`, and in a browser `maxPendingBytes`,
  `maxPendingJobs` and `workerFactory`. `close()` ends its worker and helpers; the next call starts them again.
- `helpers` adds worker threads; `helpers: true` sizes them by the device.
- `transfer: true` on encode, fit, variants or capture hands the pixels' buffer to the call instead of copying it; the buffer is empty afterwards.
- Errors carry a `code`, such as `JXL_INPUT`, `JXL_OPTIONS`, `JXL_WASM` or `JXL_WEBGPU`.

### Error codes

Every package refusal has a `code`. The message gives the specific cause; use this table for the next step. Caller-thrown errors and cancellation reasons pass through unchanged.

| Code | What happened | What to do |
| --- | --- | --- |
| `JXL_INPUT` | The image, bytes or source record cannot be read as supplied. | Pass a supported image or the pixel shape named in the message; replace a damaged source file. |
| `JXL_OPTIONS` | An option name or value is not accepted. | Use the option name, allowed value or range given in the message. |
| `JXL_DIMENSIONS` | Picture width, height or pixel count exceeds the allowed size. | Use positive whole-pixel dimensions and reduce the size, or raise `maxPixels` when appropriate. |
| `JXL_JPEG` | The JPEG file is missing required data or contains malformed markers. | Pass a complete, valid JPEG file. |
| `JXL_DECODE` | The JPEG XL file cannot be decoded correctly. | Check that the input is a complete JPEG XL file and use a suitable decoder. |
| `JXL_RECONSTRUCTION` | The JPEG XL file does not contain an original JPEG to restore. | Restore from a file made with `recompress()`, or decode the JPEG XL image instead. |
| `JXL_TARGET` | The requested file size, image-quality target or verification claim cannot be met. | Reduce the requirement or keep the original; consult the result's target details. |
| `JXL_PLATFORM` | This environment lacks a required image or decoding capability. | Follow the message's setup instructions or use an environment with that capability. |
| `JXL_MEMORY` | Available memory or a configured queue budget is insufficient. | Use a smaller image, reduce concurrent jobs or increase the relevant memory budget. |
| `JXL_LIMIT` | An input, output or operation exceeds a permitted byte or work limit. | Reduce the input or output, or increase the named limit where supported. |
| `JXL_WASM` | WebAssembly is blocked, lacks SIMD, or its module failed to compile or start (the host's words are in the message and `cause`). | Allow WebAssembly, use a host with SIMD, or act on the host's words. |
| `JXL_WEBGPU` | A required GPU is unavailable, or this job does not use WebGPU. | Leave `webgpu` unset, or choose a supported GPU and a compatible effort. |
| `JXL_WORKER` | A worker could not start, communicate or finish. | Allow the required worker source and check the worker setup described in the message. |
| `JXL_IO` | An input, output or stored file could not be accessed. | Check the path, permissions and storage access, then retry. |
| `JXL_CLOSED` | A worker queue is closing or already closed. | Finish closing it before starting further work; create a new queue where required. |
| `JXL_UNSUPPORTED` | This operation does not offer the requested input or feature combination. | Use the supported module, input or settings named in the message. |
| `JXL_SETUP` | An `add` or `remove` command cannot safely change project files. | Follow the manual setup step in the message, or repair the package installation. |
| `JXL_INTERNAL` | The library encountered a problem it could not handle. | Report the operation, input type and options with a reproducible example. |


## Browsers

```html
<script type="module">
  import {encode} from 'https://cdn.jsdelivr.net/npm/jpegxl@8/dist/index.mjs';
  const {bytes} = await encode(document.querySelector('canvas'));
</script>
```

Content Security Policy: `'wasm-unsafe-eval'`, and by where the package is served:

| Served | The policy also allows |
| --- | --- |
| From the page's own origin | That origin in `script-src` and `worker-src`. No blob worker and no inline script. |
| A module from a CDN | `blob:` in `worker-src` and the CDN in `script-src`: the worker starts as a local `blob:` module that imports the CDN file, which the CDN serves with CORS. |
| The workerd and edge-light entries | Nothing more: they install their precompiled WebAssembly on import. |
| Under Trusted Types for worker URLs | Your policy, through `workerFactory`; the package installs none. |

- Every module needs WebAssembly with SIMD (`JXL_WASM` without it), except `restore` and `metadata`.
- Without native JPEG XL: `import {install} from 'jpegxl/polyfill'; await install();` shows the page's JPEG XL images, and those added later.
- Vite, webpack 5, Next.js, Parcel and Astro work as is. A Vite 7 workspace that installs rapier-jxl above the app's
  folder needs `optimizeDeps: {exclude: ['jpegxl']}`.
- Each module's file is also its own worker and helpers. Angular: add `{"glob": "index.mjs", "input":
  "node_modules/jpegxl/dist", "output": "/"}` to the build's `assets` in `angular.json` (the module's file, such as
  `upload.mjs`, for another module).
- Rollup and esbuild: copy the module's file (`jpegxl/dist/index.mjs`, or `upload.mjs` and so on) beside the bundle.

Node 20.16+ or 22.3+, Deno, Bun, Cloudflare Workers.

## License

MIT. Third-party notices: `THIRD_PARTY_NOTICES`.

## Contributing

Anybody is welcome to contribute to rapier-jxl, which is intended to be as universal as possible. You can also greatly assist the project by simply performing tests on your computer which is always turning up new edge cases to improve the encoder. Testing on every kind of device is essential for a universal encoder. Check the jobs/ folder in the repo root, open an issue with the job's name as its title if you've started work on it, then please submit your results by attaching them to that issue.

For feedback, requests or questions, feel free to join the discussion. The goal is to make rapier-jxl as easy, fast, small, powerful and reliable as possible for every use case, while keeping the architecture simple and general.

Examples and plugins can be added for very common use cases.
