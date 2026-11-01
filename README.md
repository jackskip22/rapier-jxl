# Rapier JXL

JPEG XL encoder in JavaScript and WebAssembly, with WebGPU acceleration at higher effort levels.

- 39 KB gzip capture encoder for screenshots and canvas.
- 182 KB gzip upload encoder, includes capture.
- 308 KB gzip full still image encoder with lossless, lossy, HDR and exact alpha. Used by [rapier.html](https://rapier.website)
- Separate modules for animation, JPEG transcoding, serving and decoding. Modules are single files.
- Browsers, workers, Node, Deno, Bun, Cloudflare Workers.
- No dependencies.
- MIT.

## Stats

- About 15% smaller files than libjxl and libvips at the same quality (effort 7, 2,560px photos).
- Compared to libvips: about 11% smaller uploads at the same quality (effort 3, 2,560px photos) and half the memory for a 12 MP upload.
- Large photo uploads are about 3× faster with 3 helpers.

Size and memory: 8.0.0 photo benchmarks.

```sh
npm install rapier-jxl
```

## Command line

```sh
npx rapier-jxl photo.png                  # photo.jxl beside it
npx rapier-jxl photo.jpg                  # exact, restorable byte for byte
npx rapier-jxl photos/ --out dist/        # every PNG, JPEG and GIF in the folder
npx rapier-jxl hero.png --max-bytes 100KB # lower quality to fit, keeping dimensions
npx rapier-jxl photo.jxl                  # back to photo.jpg, or photo.png
```

`--quality 1–100` (default 90), `--effort 1–9` (default 7), `--lossless`, `--max-bytes`, `--out`, `--jobs` (helpers).
Automatic output names never replace files; `--out` can replace the named output. Exact encoding refuses if the size limit cannot be met.

## Upload

```js
import {encode} from 'rapier-jxl/upload';

// file: a File or Blob from an input, a drop or a fetch.
const compress = file => encode(file, {fidelity: {quality: 82}});
```

With `createCodec`, `helpers` can split pictures across worker threads (see Workers and queues).

## Encode

```js
import {writeFile} from 'node:fs/promises';
import {encode} from 'rapier-jxl';

const picture = {data: new Uint8Array([240, 120, 40, 255]), width: 1, height: 1};
await writeFile('picture.jxl', await encode(picture, {fidelity: {quality: 90}}));
```

Takes RGBA `{data, width, height}`, `ImageData`, a canvas (2D, WebGL or WebGPU), an `ImageBitmap`, a `VideoFrame`, a
`Blob` or a decoded image, and returns a `Uint8Array`. Samples are 8 or 16-bit integers, `Float16Array` or
`Float32Array`; HDR floats compress lossy too. For animations, `rapier-jxl/animation`'s `encode` also takes
`{width, height, frames}`.

- `fidelity`: `{quality: 1–100}`, default 90. `'exact'` is lossless.
- `effort`: 1–9, default 7.
- `webgpu`: efforts 7–9 use WebGPU when available. `'required'` fails without it; `false` turns it off.
- `features: {firstRegion: {x, y, width, height}}`: that part comes first in the file, so a page shows it first while the
  rest loads. Same pixels.
- `maxPixels`: default 40 MP. Raise it, to 16,384 × 16,384, for larger pictures; they are coded in bands, and `decode`
  reopens them with the same option.

WebGPU texture input: `encode({texture, device})` (rgba8unorm, bgra8unorm, rgba16float, rgba32float; it
needs `COPY_SRC`). Colors are sRGB and linear for float formats by default. To save a WebGPU canvas, pass
`{texture: context.getCurrentTexture(), device}`. A snapshot of the canvas right after drawing can be blank.

`rapier-jxl/upload` takes every input except GPU textures and has no lossy HDR or `features`.

Huge pictures can load a band of rows at a time, in every encoder and through `createCodec`:

```js
import {encode} from 'rapier-jxl';

// Each band: rows y to y + count - 1, as {data} (RGBA) or a canvas. Here, a flat test picture.
const rows = (y, count) => ({data: new Uint8Array(16384 * count * 4).fill(128)});
const panorama = await encode({width: 16384, height: 8192, rows}, {maxPixels: 16384 * 8192});
```

| Effort | Use |
| ---: | --- |
| 1 | Previews, screenshots |
| 2 | Phone uploads |
| 3 | Upload queues |
| 4 | Server encoding |
| 5 | App exports |
| 6 | Batch publishing |
| 7 | Compact saves, default |
| 8–9 | Photography |

## Screenshots

```js
import {capture} from 'rapier-jxl/capture';

const screenshot = await capture({data: new Uint8Array([10, 20, 30, 0]), width: 1, height: 1});
```

- Canvas (2D, WebGL or WebGPU), `ImageData`, an `ImageBitmap`, a `VideoFrame`, a `Blob` or 8-bit RGBA. Exact by
  default.
- `fidelity: {maxError: 1–8}`: lossy, each sample within that error.

## JPEG, decoding, metadata

```js
import {recompress, restore} from 'rapier-jxl/jpeg';
import {decode} from 'rapier-jxl/decode';
import {header} from 'rapier-jxl/metadata';

// jpeg: a Uint8Array holding a JPEG file.
const roundTrip = async jpeg => restore(await recompress(jpeg));
const pixels = async file => decode(file);
const size = file => header(file); // synchronous, from a file or its first bytes
```

## Serving

For recompressed JPEGs, `serve` answers `image/jxl` to compatible browsers and the exact original JPEG to others, with `Vary: Accept`, ETag, `304` and `HEAD`. `Cache-Control` defaults to `private, no-cache`;
pass `cacheControl: 'public, max-age=31536000, immutable'` for public, content-addressed URLs.

```js
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {serve} from 'rapier-jxl/serve';

// photo.jxl, made once: npx rapier-jxl photo.jpg
const stored = await readFile('photo.jxl');
createServer((req, res) => serve(stored, req, res)).listen(3000);
```

Cloudflare Workers, Deno and Bun pass the `Request` and return the `Response`:

```javascript
import {serve} from 'rapier-jxl/serve';

// Cloudflare Workers, the file in R2 under a hashed key, so it may be cached publicly
export default {async fetch(request, env) {
  const object = await env.IMAGES.get('photo.3f9a2c.jxl');
  if (!object) return new Response('Not found', {status: 404});
  return serve(new Uint8Array(await object.arrayBuffer()), request, {cacheControl: 'public, max-age=31536000, immutable'});
}};
// Deno and Bun
Deno.serve(request => serve(stored, request));
Bun.serve({fetch: request => serve(stored, request)});
```

## Workers and queues

```js
import {createCodec} from 'rapier-jxl/codec';

const queue = createCodec({module: 'rapier-jxl/upload', helpers: {count: 3, memoryBytes: 1 << 30}});
const photo = (width, height) => ({data: new Uint8Array(width * height * 4).fill(200), width, height});
try {
  const files = await Promise.all([photo(1200, 900), photo(300, 225)].map(picture => queue.encode(picture)));
} finally {
  await queue.close();
}
```

- In browsers, the module runs in a worker (upload: 207 KB). Node, Deno and Bun run it in the calling thread.
- `helpers` adds up to 16 worker threads.
- Errors carry a `code`, such as `JXL_INPUT`, `JXL_OPTIONS`, `JXL_WASM` or `JXL_WEBGPU`.

## Browsers

```html
<script type="module">
  import {encode} from 'https://cdn.jsdelivr.net/npm/rapier-jxl@8/dist/index.mjs';
  const bytes = await encode(document.querySelector('canvas'));
</script>
```

- Content Security Policy: `'wasm-unsafe-eval'`; `worker-src blob:` for `rapier-jxl/codec` from a CDN.
- Every module needs WebAssembly with SIMD (`JXL_WASM` without it), except `restore` and `metadata`.
- Without native JPEG XL: `import 'rapier-jxl/polyfill'`.
- Vite: `worker: {format: 'es'}`. webpack 5, Parcel, Angular and Next.js work as is. Next.js edge routes: import
  modules directly, not `rapier-jxl/codec`.
- Rollup: `@web/rollup-plugin-import-meta-assets` with `assetFileNames: 'assets/[name][extname]'`.
- esbuild: copy `rapier-jxl/dist/*.worker.mjs` and `*.helper.mjs` beside the bundle.

Node 20.16+, Deno, Bun, Cloudflare Workers. ESM.

## License

MIT. Third-party notices: `THIRD_PARTY_NOTICES`.
