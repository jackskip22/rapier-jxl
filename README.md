# Rapier JXL

JPEG XL encoder in JavaScript, WebGPU accelerated at high effort levels. Screenshot encoder about 34 KB
gzipped. Full image encoder about 158 KB, with lossless, lossy, HDR, exact alpha, WebAssembly and parallel
workers. Separate modules for JPEG transcoding and decoding. Browsers, workers, Node, Deno and Bun. MIT, no dependencies.

Smaller than WebP at the same quality, for screenshots and photos. Faster uploads than wasm-vips, in smaller files.

```sh
npm install rapier-jxl
```

## Modules

Gzipped, worker included. Each loads on first use.

| Import | For | Size |
| --- | --- | ---: |
| `rapier-jxl` | Photos and graphics, efforts 1–9 | 158 KB |
| `rapier-jxl`, effort 1 | Live previews | 71 KB |
| `rapier-jxl/capture` | Exact screenshots | 34 KB |
| `rapier-jxl/snapdom` | SnapDOM plug-in | 35 KB |
| `rapier-jxl/jpeg` | Lossless JPEG recompression | 132 KB |
| `rapier-jxl/decode` | Decoder | 74 KB |
| `rapier-jxl/animation` | Animation | 116 KB |
| `rapier-jxl/offline` | Encoder in one file | 152 KB |
| `rapier-jxl/metadata` | Exif, XMP and boxes | |
| `rapier-jxl/format` | Layers, patches, splines, extra channels | |

| | rapier-jxl | Smallest other |
| --- | ---: | ---: |
| Still encoder | 158 KB | 512 KB, `@squoosh-kit/jxl` 0.2.10 |
| Lossless JPEG recompression | 132 KB | 962 KB, `jxl-wasm` 0.7.0 |
| Decoder | 74 KB | 613 KB, `jxl-oxide-wasm` 0.12.6 |

## Screenshots

Exact, and smaller than lossless WebP. SnapDOM 3.5, 1920×1080 pages, `cwebp -lossless -m 4 -exact`.

| Page | Lossless WebP | `toJxl()` | |
| --- | ---: | ---: | ---: |
| GitHub | 78,778 B | 76,015 B | −3.5% |
| MDN | 85,088 B | 82,673 B | −2.8% |
| MDN dark | 84,044 B | 81,241 B | −3.3% |
| Dashboard | 75,752 B | 75,062 B | −0.9% |
| Hacker News | 82,122 B | 64,470 B | −21.5% |

## Encode

```js
import {writeFile} from 'node:fs/promises';
import {encode} from 'rapier-jxl';

const picture = {data: new Uint8Array([240, 120, 40, 255]), width: 1, height: 1};
await writeFile('picture.jxl', await encode(picture, {quality: 90}));
```

Takes RGBA `{data, width, height}`, `ImageData`, a canvas, an `ImageBitmap` or a `Blob`. Returns a `Uint8Array`.

- `quality`: 1–100, default 90. 100 is lossless.
- `effort`: 1–9, default 7.
- `acceleration`: `'wasm'`, `'webgpu'` or `'auto'`. Same bytes on every backend.

| Effort | Use |
| ---: | --- |
| 1 | Live previews |
| 3 | Upload queues |
| 4–7 | WebGPU accelerated |
| 7 | Default |
| 8–9 | Smallest files |

Node 20.16+ or 22.3+, Deno, Bun. ESM.

## Screenshots, JPEG, decoding

```js
import {encode as capture} from 'rapier-jxl/capture';
import {decode} from 'rapier-jxl/decode';

const screenshot = await capture({data: new Uint8Array([10, 20, 30, 0]), width: 1, height: 1}, {maxError: 0});
const pixels = await decode(screenshot);
```

`maxError` 1–8 makes smaller files within that error per sample.

```js
import {recompress, restore} from 'rapier-jxl/jpeg';

// jpeg: a Uint8Array holding a JPEG file.
const roundTrip = async jpeg => restore(await recompress(jpeg));
```

## Queues and workers

```js
import {createEncoder} from 'rapier-jxl';

const queue = createEncoder({helpers: {count: 3, memoryBytes: 1024 * 1024 * 1024}});
const photo = (width, height) => ({data: new Uint8Array(width * height * 4).fill(200), width, height});
// An upload's sizes, submitted together, encode at once.
const sizes = [photo(1200, 900), photo(768, 576), photo(300, 225), photo(150, 150)];
const files = await Promise.all(sizes.map(picture => queue.encode(picture, {quality: 82, effort: 3, acceleration: 'wasm'})));
console.log(files.map(bytes => bytes.length));
queue.close();
```

- In browsers, calls run in a module worker; in Node, Deno and workers, in place. `worker: false` runs in place.
- Jobs run in order, with progress and cancel. `queue.prepare()` starts the worker early.
- `helpers` adds up to 16 workers, with the same bytes.
- Errors carry a `code`, such as `JXL_INPUT`, `JXL_OPTIONS`, `JXL_DECODE` or `JXL_MEMORY`.

## Browsers

```html
<script type="module">
  import {createEncoder} from 'https://cdn.jsdelivr.net/npm/rapier-jxl@7/dist/index.mjs';
  const encoder = createEncoder({worker: false});
  const bytes = await encoder.encode({data: new Uint8Array([240, 120, 40, 255]), width: 1, height: 1}, {quality: 90});
</script>
```

- Save: `new Blob([bytes], {type: 'image/jxl'})`.
- Display P3: `colorSpace: 'display-p3'`.
- Content Security Policy: `'wasm-unsafe-eval'` for WebAssembly; `worker-src blob:` from a CDN.

## Bundlers

webpack 5 and Next.js work as is. Next.js server routes with `helpers` (`next.config.mjs`):

```js
export default {serverExternalPackages: ['rapier-jxl']};
```

Vite:

```js
export default {worker: {format: 'es'}};
```

Angular CLI (`build.options.assets`):

```json
{"glob": "*.mjs", "input": "node_modules/rapier-jxl/dist", "output": "/"}
```

Bun:

```sh
bun build app.mjs node_modules/rapier-jxl/dist/worker.mjs node_modules/rapier-jxl/dist/parallel-worker.mjs \
  --production --splitting --entry-naming '[name].mjs' --chunk-naming '[name]-[hash].mjs' --outdir dist
```

esbuild:

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

Rollup:

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

Parcel 2.16.4:

```json
{
  "@parcel/resolver-default": {"packageExports": true},
  "scripts": {"build": "parcel build index.html --no-scope-hoist"}
}
```

## SnapDOM

```sh
npm install @zumer/snapdom@3 rapier-jxl
```

```js
import {snapdom} from '@zumer/snapdom';
import {jxl} from 'rapier-jxl/snapdom';

const result = await snapdom(document.body, {plugins: [jxl()]});
const blob = await result.toJxl();
```

- Exact by default. `toJxl({quality: 0.9})` for photographic pages.
- `snapdom.plugins(jxl())` registers it for every capture.
- `jxl({encode: encoder.capture, encodeLossy: encoder.encode})` uses your own queue.

[Demo on StackBlitz](https://stackblitz.com/github/jackskip22/rapier-jxl/tree/main/examples/snapdom)

## html2canvas and html-to-image

```js
import html2canvas from 'html2canvas';
import {encode} from 'rapier-jxl/capture';

const jxl = await encode(await html2canvas(document.body));
```

```js
import {toCanvas} from 'html-to-image';
import {encode} from 'rapier-jxl/capture';

const jxl = await encode(await toCanvas(document.body));
```

## License

MIT. Third-party notices: `THIRD_PARTY_NOTICES`.
