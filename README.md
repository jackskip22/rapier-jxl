# Rapier JXL

JPEG XL encoder in JavaScript, WebGPU accelerated at high effort levels. Screenshot encoder about 30 KB
gzipped, upload encoder about 170 KB, full image encoder about 273 KB with lossless, lossy, HDR, exact
alpha and WebAssembly. Separate modules for animation, JPEG transcoding and decoding. Each module is one file.
Browsers, workers, Node, Deno, Bun, Cloudflare Workers. MIT, no dependencies.

| | Rapier JXL | jSquash | WebP |
| --- | ---: | ---: | ---: |
| Download, gzip | 273 KB | 526 KB | built in |
| WebGPU | ✓ | | |
| Lossless JPEG recompression | ✓ | | |

```sh
npm install rapier-jxl
```

## Modules

| | For | Gzip |
| --- | --- | ---: |
| `rapier-jxl/capture` | Exact screenshots | 30 KB |
| `rapier-jxl/upload` | Photos before upload, effort 1–3 | 170 KB |
| `rapier-jxl` | Full still encoder, WebGPU at effort 7–9 | 273 KB |
| `rapier-jxl/animation` | Animations, with the full encoder | 279 KB |
| `rapier-jxl/format` | Layers, patches, splines, extra channels | 298 KB |
| `rapier-jxl/decode` | Decoder | 143 KB |
| `rapier-jxl/jpeg` | Lossless JPEG recompression | 175 KB |
| `rapier-jxl/metadata` | Header, Exif, XMP and boxes | 27 KB |
| `rapier-jxl/codec` | A worker and queue over any module | 13 KB |
| `rapier-jxl/polyfill` | Display without native support | 22 KB |

One file each; nothing loads after the import. `upload` contains `capture`; `rapier-jxl` contains both.

## Upload

```js
import {encode} from 'rapier-jxl/upload';

// file: a File or Blob from an input, a drop or a fetch.
const compress = file => encode(file, {fidelity: {quality: 82}});
```

With `createCodec`, `helpers` splits each picture across worker threads (see Workers and queues).

## Encode

```js
import {writeFile} from 'node:fs/promises';
import {encode} from 'rapier-jxl';

const picture = {data: new Uint8Array([240, 120, 40, 255]), width: 1, height: 1};
await writeFile('picture.jxl', await encode(picture, {fidelity: {quality: 90}}));
```

Takes RGBA `{data, width, height}`, `ImageData`, a canvas, an `ImageBitmap`, a `Blob` or a decoded image, and returns a
`Uint8Array`. For animations, `rapier-jxl/animation`'s `encode` also takes `{width, height, frames}`.

- `fidelity`: `{quality: 1–100}`, default 90. `'exact'` is lossless.
- `effort`: 1–9, default 7.
- `webgpu`: efforts 7–9 use WebGPU when available. `'required'` fails without it; `false` turns it off.

| Effort | Use |
| ---: | --- |
| 1 | Live previews |
| 3 | Upload queues |
| 7 | Default, WebGPU accelerated |
| 8–9 | Smallest files |

Efforts 8–9 currently apply to pictures up to 1 MP; larger pictures are encoded as at effort 7. Updates will raise
this limit.

## Screenshots

```js
import {capture} from 'rapier-jxl/capture';

const screenshot = await capture({data: new Uint8Array([10, 20, 30, 0]), width: 1, height: 1});
```

- Takes a canvas, `ImageData`, an `ImageBitmap`, a `Blob` or RGBA. Exact by default.
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

- In browsers the module runs in a worker (upload: 192 KB). Node, Deno and Bun run it in the calling thread.
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
- Without native JPEG XL: `import 'rapier-jxl/polyfill'`.
- Vite: `worker: {format: 'es'}`. webpack 5, Parcel, Angular and Next.js work as is. Next.js edge routes: import
  modules directly, not `rapier-jxl/codec`.
- Rollup: `@web/rollup-plugin-import-meta-assets` with `assetFileNames: 'assets/[name][extname]'`.
- esbuild: copy `rapier-jxl/dist/*.worker.mjs` and `*.helper.mjs` beside the bundle.

Node 20.16+, Deno, Bun, Cloudflare Workers. ESM.

## Compatibility

8.x keeps every import, export, option, default and error code, and may add new ones. Output is deterministic within a
version; a later version may write smaller files at the same fidelity. Recompressed JPEGs restore exactly in every
later version.

## License

MIT. Third-party notices: `THIRD_PARTY_NOTICES`.
