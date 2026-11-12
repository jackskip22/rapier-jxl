# rapier-jxl

[![npm](https://img.shields.io/npm/v/jpegxl)](https://www.npmjs.com/package/jpegxl)
[![downloads](https://img.shields.io/npm/dw/jpegxl)](https://www.npmjs.com/package/jpegxl)
[![license](https://img.shields.io/npm/l/jpegxl)](https://github.com/jackskip22/rapier-jxl/blob/main/LICENSE)
[![types](https://img.shields.io/npm/types/jpegxl)](https://www.npmjs.com/package/jpegxl)

JPEG XL in JavaScript and WebAssembly with WebGPU for high efforts.

Used by [SnapDOM's official JPEG XL plugin](https://snapdom.dev/plugins/jxl/) and the [EmDash image optimizer](https://plugins.emdashcms.com/plugins/@rapier.website/jxl). [Try it in your browser](https://rapier.website/jxl).

- Uploads over 2x faster than libvips.
- 52 KB Brotli exact capture.
- 244 KB Brotli complete capture.
- 277 KB Brotli upload.
- 361 KB Brotli full encoder with HDR and parallel workers. Used by [rapier.html](https://rapier.website)
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

`--quality 1–100` (default 90), `--effort 1–9` (default 7), `--lossless`, `--max-bytes`, `--out`, `--jobs` (helpers).
Automatic output names never replace files.
`--json` names what each file kept: `jpeg-bytes` (the JPEG restores exactly), `pixels` (exact) or `lossy`. A rerun
leaves finished files untouched.

## Upload

```js
import {encode, fit} from 'jpegxl/upload';

// file: a File or Blob from an input, a drop or a fetch.
const compress = async file => {
  const result = await encode(file, {fidelity: {quality: 82}});
  if (!result.bytes) throw Object.assign(new Error(result.reason.message), {code: result.reason.code});
  return new Blob([result.bytes], {type: 'image/jxl'});
};
const small = file => fit(file, {maxBytes: 100_000}); // best quality under 100 KB; `fits` says whether it got there
```

`variants` makes several sizes from one upload. All calls accept `onProgress` and `signal`, for progress bars and
cancelling. On Node and Deno, pass decoded pixels `{data, width, height}`; only JPEGs with `fidelity: 'exact'` and
PNGs with transparency or 16 bits can be passed as files.

## Encode

```js
import {writeFile} from 'node:fs/promises';
import {encode} from 'jpegxl';

const picture = {data: new Uint8Array([240, 120, 40, 255]), width: 1, height: 1};
await writeFile('picture.jxl', (await encode(picture, {fidelity: {quality: 90}})).bytes);
```

Takes RGBA `{data, width, height}`, `ImageData`, a canvas (2D, WebGL or WebGPU), an `ImageBitmap`, a `VideoFrame`, a
`Blob`, a decoded image or a GPU texture `{texture, device}`, and returns a result record with the output in `result.bytes`. 8 or 16-bit, `Float16Array`
or `Float32Array` samples, including HDR. For animations, including an animated GIF `Blob`, use `rapier-jxl/animation`.

- Lossless JPEG recompression is `recompress` from `jpegxl/jpeg`; in `rapier-jxl/upload`, `encode(jpegFile, {fidelity: 'exact'})` does the same. The full `encode` takes pixels.
- `fidelity`: `{quality: 1–100}`, default 90. `'exact'` is lossless.
- `effort`: 1–9, default 7. Lower is faster; 1–3 suit previews and uploads, 8–9 photography.
- `webgpu`: efforts 7–9 use WebGPU when available. `'required'` fails without it; `false` turns it off.
- `maxPixels`: default 40 MP, up to 268,435,456 pixels with neither side over 32,767. Very large images can be passed in strips with `rows(y, count)`.
- `verify(original, result)` from `jpegxl/verify` checks a file against its source.

## Screenshots

```js
import {capture} from 'jpegxl/capture';
import {capture as page} from 'jpegxl/capture-complete';

const screenshot = canvas => capture(canvas); // lossless
const smaller = (canvas, rects) => page(canvas, {fidelity: {quality: 92}, ...rects}); // lossy photos, lossless text
```

- Canvas (2D, WebGL or WebGPU), `ImageData`, an `ImageBitmap`, a `VideoFrame`, a `Blob` or 8-bit RGBA.
- `rects` is `{exactRects, photoRects}`: the areas to keep lossless, such as text, and where the photos are.
- `rapier-jxl/page-rects` finds both in a page element, for any library that draws one to a canvas.
- Pages up to 32,767 pixels tall in one file; WebP stops at 16,383. Above 40 MP, raise `maxPixels`.
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

// jpeg: a Uint8Array holding a JPEG file, up to 64 MP.
const roundTrip = async jpeg => (await restore((await recompress(jpeg)).bytes)).bytes;
const pixels = async file => decode(file); // {width, height, data}, RGBA
const size = file => header(file); // synchronous, from a file or its first bytes
```

`rapier-jxl/svg-jxl` converts the images inside any SVG to JPEG XL where that makes them smaller while automatically keeping shapes and text sharp.
`{exact: true}` keeps the images lossless.

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
const step = async (saved, store, input) => {
  const job = {operation: encode, store, input, verify};
  const {checkpoint, done} = await advance(saved ?? await start({...job, options: {fidelity: {quality: 82}}}), job);
  return done ? {result: await finish(checkpoint, job)} : {checkpoint}; // save checkpoint for the next request
};
```

- `capture`, `encode`, `fit`, `variants`, `recompress`, `restore` and `verify`.
- Each `advance` runs for about 30 ms (`budget: {ms}`) and writes its parts to the store before it returns. A host that allows few store calls a request passes `budget.reads`: the call ends before more reads than that.
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

## Workers and queues

```js
import {createCodec} from 'jpegxl/codec';

const queue = createCodec({module: 'rapier-jxl/upload', helpers: {count: 3, memoryBytes: 1 << 30}});
const photo = (width, height) => ({data: new Uint8Array(width * height * 4).fill(200), width, height});
try {
  const files = await Promise.all([photo(1200, 900), photo(300, 225)].map(picture => queue.encode(picture)));
} finally {
  await queue.close();
}
```

- In browsers, the module runs in a worker (upload: 301 KB Brotli). Node, Deno and Bun run it in the calling thread.
- With one module, import its codec from `jpegxl/codec/<module>`; bundlers then ship only that module's files.
- `helpers` adds up to 16 worker threads; `helpers: true` sizes them by the device.
- Errors carry a `code`, such as `JXL_INPUT`, `JXL_OPTIONS`, `JXL_WASM` or `JXL_WEBGPU`.

## Browsers

```html
<script type="module">
  import {encode} from 'https://cdn.jsdelivr.net/npm/jpegxl@8/dist/index.mjs';
  const {bytes} = await encode(document.querySelector('canvas'));
</script>
```

- Content Security Policy: `'wasm-unsafe-eval'`; `worker-src blob:` for `rapier-jxl/codec` from a CDN.
- Every module needs WebAssembly with SIMD (`JXL_WASM` without it), except `restore` and `metadata`.
- Without native JPEG XL: `import 'jpegxl/polyfill'`.
- Vite, webpack 5, Next.js, Parcel and Astro work as is. A Vite 7 workspace that installs rapier-jxl above the app's
  folder needs `optimizeDeps: {exclude: ['rapier-jxl']}`. Next.js edge routes: import modules directly, not
  `rapier-jxl/codec`.
- Angular: add `{"glob": "*.{worker,helper}.mjs", "input": "node_modules/jpegxl/dist", "output": "/"}` to the
  build's `assets` in `angular.json`; with one module, the glob `<module>.*{worker,helper}.mjs`.
- Rollup: `@web/rollup-plugin-import-meta-assets` with `assetFileNames: 'assets/[name][extname]'`.
- esbuild: copy `rapier-jxl/dist/*.worker.mjs` and `*.helper.mjs` beside the bundle; with one module, its
  `<module>.*{worker,helper}.mjs`.

Node 20.16+ or 22.3+, Deno, Bun, Cloudflare Workers.

## License

MIT. Third-party notices: `THIRD_PARTY_NOTICES`.

## Contributing

Anybody is welcome to contribute to rapier-jxl, which is intended to be as universal as possible. You can also greatly assist the project by simply performing tests on your computer which is always turning up new edge cases to improve the encoder. Testing on every kind of device is essential for a universal encoder. Check the jobs/ folder in the repo root, open an issue with the job's name as its title if you've started work on it, then please submit your results by attaching them to that issue.

For feedback, requests or questions, feel free to join the discussion. The goal is to make rapier-jxl as easy, fast, small, powerful and reliable as possible for every use case, while keeping the architecture simple and general.

Examples and plugins can be added for very common use cases.
