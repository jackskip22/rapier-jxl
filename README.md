# rapier-jxl

[![npm](https://img.shields.io/npm/v/jpegxl)](https://www.npmjs.com/package/jpegxl)
[![downloads](https://img.shields.io/npm/dw/jpegxl)](https://www.npmjs.com/package/jpegxl)
[![license](https://img.shields.io/npm/l/jpegxl)](https://github.com/jackskip22/rapier-jxl/blob/main/LICENSE)
[![types](https://img.shields.io/npm/types/jpegxl)](https://www.npmjs.com/package/jpegxl)

JPEG XL in WebAssembly + JS with optional WebGPU & parallel workers. Brotli: ~64 KB exact capture, ~320 KB complete capture, ~353 KB upload, ~545 KB full encoder. HDR, metadata, lossless JPEG, video/GIF to animation, resumable edge encoding, serve, polyfill, decode. Auto quality, exact text. CLI & npx jpegxl add: 22 platforms. No dependencies. MIT.

rapier-jxl is the encoder inside [rapier.website](https://rapier.website), the free Markdown editor, drawing and painting app. Rapier is also a free [Android app](https://play.google.com/store/apps/details?id=app.rapier&referrer=utm_source%3Djxl-readme) that opens and converts JPEG XL pictures.

It is also used by [SnapDOM's official JPEG XL plugin](https://snapdom.dev/plugins/jxl/) and the [EmDash JPEG XL Image Optimizer plugin](https://plugins.emdashcms.com/plugins/@rapier.website/jxl). [Try rapier-jxl in your browser](https://rapier.website/jxl).

```sh
npm install jpegxl
```

ESM, Node 22.3+. From CommonJS: `await import('jpegxl')`.

## Modules

| Module | For | Brotli |
| --- | --- | --- |
| `jpegxl` | Still image encoder, efforts 1–9 | about 545 KB |
| `jpegxl/max` | Effort 10, very slow for smallest files | 580 KB |
| `jpegxl/upload` | Fast uploads in the browser, efforts 1–3 | 353 KB |
| `jpegxl/capture` | Exact screenshots | 64 KB |
| `jpegxl/capture-complete` | Screenshots with lossy photos and automatically exact text | 320 KB |
| `jpegxl/animation` | Videos, GIFs and frames to animated JPEG XL | 569 KB |
| `jpegxl/format` | Codestream features | 583 KB |
| `jpegxl/jpeg` | JPEG recompression that restores exactly | 188 KB |
| `jpegxl/decode` | Pixels and animation frames | 122 KB |
| `jpegxl/verify` | A file checked against its source | 77 KB |
| `jpegxl/serve` | JPEG XL served by `Accept` | 75 KB |
| `jpegxl/resumable` | Encodes across short edge requests | 63 KB |
| `jpegxl/metadata` | Headers, Exif, XMP and smaller sizes from a progressive file | 41 KB |
| `jpegxl/polyfill` | JPEG XL and animated JPEG XL in every browser | 28 KB |
| `jpegxl/hdr` | OpenEXR and Radiance files | 14 KB |

## Efforts

| Effort | Use it for |
| --- | --- |
| 1 | Live previews, fastest |
| 2–3 | Uploads in the browser |
| 4–5 | Quick batch jobs, landing on the look you ask for, with the built-in visual lexer |
| 6 | Fast photos with variable block sizes |
| 7 (default) | Photos and screenshots, the best balance of size and time, GPU accelerated where possible |
| 8–9 | Smaller files from a build step or server |
| 10 | The smallest possible files, made very slowly, best on a computer (`jpegxl/max`) |

For lossless photos, effort 10 writes files about 1% smaller than libjxl's effort 11, about 15 times faster on the same computer, with a fifth of the memory. It doesn't need a GPU.

## Visual lexer

A small model trained on many photos reads the image and predicts how Effort 9's slow search would encode it. Efforts 4 to 6 use this built-in lexer to get a similar look with no slow search.

## Command line

```sh
npx jpegxl photo.png                   # photo.jxl alongside
npx jpegxl scan.jpg                    # lossless: JPEG restores exactly
npx jpegxl photos/ --out dist/         # every PNG, JPEG, GIF, HDR and EXR in the folder
npx jpegxl hero.png --max-bytes 100KB  # best quality that fits
npx jpegxl scan.jxl --out back/        # back/scan.jpg, original JPEG
npx jpegxl site dist/                  # static site: .jxl files and <picture> in HTML
```

Options: `--quality 1–100` (default 90, and a JPEG without it stays exact), `--effort 1–10` (default 7), `--max-bytes`, `--out`, `--keep-extension`, `--exact`, `--jpeg-pixels`, `--jobs`, `--verify`, `--json`. `--keep-extension` writes names such as `photo.jpg.jxl`. Effort 10 searches still pixels and cannot be combined with `--max-bytes`. Exact JPEG recompression uses at most effort 9. A different file is never replaced. WebP and AVIF need a runtime with `createImageBitmap` and `OffscreenCanvas`. Elsewhere, convert them to PNG first.

## Add it to your project

```sh
npx jpegxl add <place>
```

Places: `emdash`, `wordpress`, `payload`, `astro`, `vite`, `void`, `webpack`, `next`, `netlify`, `workers`, `r2`, `agents`, `apache`, `nginx`, `caddy`, `android`, `ios`, `flutter`, `expo`, `capacitor`, `electron`, `tauri`. It works from the installed package (EmDash and Astro install what they lack), `--dry-run` shows what it would change, and `npx jpegxl remove <place>` undoes it.

## No code required

- [rapier.website/jxl](https://rapier.website/jxl) converts pictures in the browser, offline, on your device.
- [JPEG XL Converter for VS Code](https://marketplace.visualstudio.com/items?itemName=rapier.jxl) converts files in a workspace.
- [Rapier for Android](https://play.google.com/store/apps/details?id=app.rapier&referrer=utm_source%3Djxl-readme) opens, converts and shares JPEG XL images.

## Android

```sh
npx jpegxl add android
```

The same files run in an Android app with no native code. A hidden WebView runs the encoder in a worker, offline from the app's assets, and Kotlin passes files over a binary message port. Works for every processor with no NDK and no Internet permission. The encoder's files add about 1.2 MB to the APK.

```js
// assets/encoder.mjs, the WebView's worker
import {encode} from './jpegxl/upload.mjs';
import {recompress, restore} from './jpegxl/jpeg.mjs';

onmessage = async ({data: {bytes, mime, jpegBytes}}) => { // from Kotlin's message port
  const photo = await encode(new Blob([bytes], {type: mime}), {fidelity: {quality: 80}});
  const smaller = await recompress(jpegBytes);
  const original = await restore(smaller.bytes); // the exact same JPEG
};
```

The [Android example](https://github.com/jackskip22/rapier-jxl/tree/main/examples/android) is one activity: pick or share a photo, save or share the `.jxl`, and recompress a JPEG with the restored file's SHA-256 checked in Kotlin. Android 8.0 or newer, WebView 116 or newer. The [Capacitor example](https://github.com/jackskip22/rapier-jxl/tree/main/examples/capacitor) uses the same modules unchanged.

## iOS and macOS

```sh
npx jpegxl add ios
```

The same files run on macOS or iOS with no native code. A Swift package runs the encoder in a hidden WKWebView offline, with cancellable async calls. Nothing to compile, no libjxl, no binary frameworks.

The [iOS example](https://github.com/jackskip22/rapier-jxl/tree/main/examples/ios) encodes photos, recompresses JPEGs losslessly and turns videos into animated JPEG XL.

```swift
import RapierJXL

let codec = JXLCodec()
let jxl = try await codec.encode(photo, quality: 80, effort: 3)   // Data (or UIImage on iOS) in, JPEG XL out
let small = try await codec.recompress(jpeg: jpegData)            // the same JPEG back with restore
let clip = try await codec.animate(video: movieURL)               // every frame, each with its time
```

## Upload

```ts
import {encode, fit} from 'jpegxl/upload';

async function compress(file: File): Promise<Blob> {
  const result = await encode(file, {fidelity: {quality: 82}});
  if (!result.meetsTarget) throw new Error(result.reason.message);
  return new Blob([result.bytes], {type: 'image/jxl'});
}
const small = (file: File) => fit(file, {maxBytes: 100_000}); // `meetsTarget` says whether it fit
```

Efforts 1 to 3 (default 3). `variants` makes multiple sizes from one picture and never grows one past the source unless the output says `upscale: true`. Every encoding call takes `onProgress` and `signal`. On Node, Deno, Bun and Workers a JPEG needs `configureDecoder(decode, null, recompress)` first. Pixels and PNG work normally.

## Encode

```ts
import {writeFile} from 'node:fs/promises';
import {encode} from 'jpegxl';

const picture = {data: new Uint8Array([240, 120, 40, 255]), width: 1, height: 1};
const {bytes} = await encode(picture, {fidelity: {quality: 90}});
await writeFile('picture.jxl', bytes);
```

Takes RGBA `{data, width, height}`, `ImageData`, a canvas, an `ImageBitmap`, a `VideoFrame`, a `Blob` or a GPU texture as `{texture, device}`, in 8 or 16 bits, `Float16Array` or `Float32Array` (HDR).

- `fidelity`: `{quality: 1–100}`, default 90, or `'exact'`.
- `effort`: 1–9, default 7 (`jpegxl/max` adds effort 10, its default, for a longer search on still pictures). Efforts 4 and up measure the look.
- `webgpu`: lossy efforts 7–9 (`jpegxl/max` also lossy and 8-bit lossless effort 10) use WebGPU where it can. Phones use the CPU unless `'required'`. `'required'` refuses without a supported device path. `false` turns it off.
- `progressive: true`: the first bytes show the whole picture, which sharpens as more of the file arrives (about 2 to 5% larger files).
- `onPreview` receives better files while efforts 6–9 (`6–10` in `jpegxl/max`) search.
- The host's memory is the limit.
- A JPEG stays JPEG and restores exactly with `fidelity: 'exact'` or at a quality level when that can be smaller (efforts 6–9, and 10 in `jpegxl/max`). `jpeg: 'pixels'` encodes its pixels.
- `jpegxl/animation` takes frames, an animated GIF or browser video, `jpegxl/hdr` reads OpenEXR and Radiance files, and `jpegxl/verify` checks a file against its source.

## Screenshots

```ts
import {capture} from 'jpegxl/capture';
import {capture as capturePage} from 'jpegxl/capture-complete';
import {pageRects} from 'jpegxl/page-rects';

const lossless = (canvas: HTMLCanvasElement) => capture(canvas);
// Lossy photos, exact text. `element` is what a library drew to the canvas.
const screenshot = (element: HTMLElement, canvas: HTMLCanvasElement) =>
  capturePage(canvas, {...pageRects(element, canvas), fidelity: {quality: 92}});
```

`pageRects` finds the text and photos in an element. `exactRects` and `photoRects` take the boxes by hand. Text is exact at every effort.

## SnapDOM

```js
import {snapdom} from '@zumer/snapdom';
import {jxl} from '@zumer/snapdom-plugins/jxl';

const result = await snapdom(document.querySelector('#card'), {plugins: [jxl()]});
await result.download({format: 'jxl', filename: 'card'});
```

[SnapDOM's official JPEG XL plugin](https://snapdom.dev/plugins/jxl/) captures any element as one file. It compresses images inside screenshots while automatically keeping text exact.

## Animation

```js
import {encode} from 'jpegxl/animation';

const gif = await (await fetch('cat.gif')).blob();
const {bytes} = await encode(gif);
```

Upload a video or GIF to make it a much smaller animated JPEG XL without losing its quality. It keeps every frame's timing and the loop count. Frames can also be pixels: `{width, height, loops, frames: [{data, duration}]}`. Give `frames` as an async iterable and each frame is read as the encoder takes it, so an animation of any length converts on a phone. Long animated GIF, PNG and WebP files are read frame by frame the same way.

Animated JPEG XL plays in every browser with `jpegxl/polyfill`, with no GIF, PNG or WebP stored beside it. A long animation plays frame by frame with flat memory.

## JPEG, decoding, metadata

```ts
import {recompress, restore} from 'jpegxl/jpeg';
import {decode} from 'jpegxl/decode';
import {header} from 'jpegxl/metadata';

async function roundTrip(jpeg: Uint8Array) {
  const packed = await recompress(jpeg);
  if (!packed.meetsTarget) throw new Error(packed.reason.message);
  return (await restore(packed.bytes)).bytes; // the original JPEG
}
const pixels = async (file: Uint8Array) => (await decode(file)).data; // RGBA
const size = (file: Uint8Array) => header(file); // synchronous
```

`decode(file, {onFrame})` hands over each frame of an animation as it is decoded, so memory stays flat for any length.

`recompress(jpeg)` keeps a phone photo's HDR gain map inside `jbrd`, so every decoder restores the JPEG exactly. `{gainMap: true}` also stores it as a JPEG XL gain map in `jhgm`, a little smaller, and libjxl then restores the JPEG without it. `sourceMetadata(file)` from `jpegxl/metadata` reads a JPEG, PNG or WebP file's Exif and XMP, with Exif orientation set to normal, for `edit(bytes, await sourceMetadata(file))`. `slice` and `placeholder` from `jpegxl/metadata` cut a smaller size (1:2, 1:4 or 1:8) from a progressive file in milliseconds, without decoding.

`jpegxl/svg-jxl` converts the pictures inside an SVG and keeps shapes and text sharp.

## Serving

```ts
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {serve} from 'jpegxl/serve';

const stored = await readFile('photo.jxl'); // made once: npx jpegxl photo.jpg
createServer((req, res) => serve(stored, req, res).catch(console.error)).listen(3000);
```

`serve` ranks JPEG XL, a restorable JPEG and any supplied fallback by `Accept`, with `Vary: Accept`, ETag, `304` and `HEAD`. Workers, Deno and Bun: `return serve(stored, request)`. A file with no JPEG inside refuses clients without JPEG XL unless you pass `fallback: {type: 'image/webp', bytes}` (bytes, or a function that returns them).

`width`, `maxBytes` or `responsive: true` send smaller screens a smaller size cut from the same progressive file.

## Workers and queues

```ts
import {encode, configure, close} from 'jpegxl/upload';

configure({helpers: {count: 3, memoryBytes: 1 << 30}});
try {
  const photo = {data: new Uint8Array(1200 * 900 * 4).fill(200), width: 1200, height: 900};
  const {bytes} = await encode(photo);
} finally {
  await close();
}
```

In browsers the module runs in its own worker. Node, Deno and Bun run it in the calling thread alongside `helpers`. `configure` sets a module's queue before its first call and `close()` ends its worker. Canceled calls reject with the signal's reason. Any number of helpers writes the same file as none.

## Resumable encoding

For edge isolates with short time limits: an encode continues across requests in steps and writes the same file as one call.

```ts
import {start, advance, finish, type ResumableStore} from 'jpegxl/resumable';
import {encode} from 'jpegxl/upload';

// A Map and store. In production: R2, KV or a database.
const memoryStore = (original: Uint8Array): ResumableStore => {
  const parts = new Map<string, Uint8Array>();
  return {
    readSource: (offset, length) => original.subarray(offset, offset + length),
    read: ref => parts.get(ref.hash)!,
    write: (ref, bytes) => void parts.set(ref.hash, bytes),
  };
};

async function run(original: Uint8Array, sha256: string) {
  const input = {generation: '1', sha256, byteLength: original.length, kind: 'file' as const};
  const job = {operation: encode, store: memoryStore(original), input};
  let state = await advance(await start({...job, options: {fidelity: {quality: 82}}}), job);
  while (!state.done) state = await advance(state.checkpoint, job); // one request each: save the checkpoint
  return finish(state.checkpoint, job);
}
```

`capture`, `encode`, `fit`, `variants`, `recompress`, `restore` and `verify` all resume. An advance runs about 30 ms (`budget: {ms}`) and at least one step, which can take longer. `workerAdmission({operation: encode, width, height})` says whether a job fits a Workers isolate. Accept checkpoints only from your own service.

## Browsers

```html
<script type="module">
  import {encode} from 'https://cdn.jsdelivr.net/npm/jpegxl@8/dist/index.browser.mjs';
  const canvas = document.querySelector('canvas');
  if (canvas) await encode(canvas);
</script>
```

- The Content Security Policy needs `'wasm-unsafe-eval'`, and from a CDN `blob:` in `worker-src`.
- WebAssembly with SIMD is needed.
- Without native JPEG XL, `install()` from `jpegxl/polyfill` shows `.jxl` and `data:image/jxl` images, and `verify` needs `configureDecoder(decode, restore)` first.
- Each module's file is its own worker. With esbuild, Rollup or Angular, copy it beside the bundle.

## EmDash

```sh
npx jpegxl add emdash
```

Originals stay in the site's storage. Browsers that accept JPEG XL get verified copies and the rest get the original. **Plugins → JPEG XL Image Optimizer** sets the goal, effort and widths, and converts the library. The package's `examples/emdash/astro.config.mjs` is a whole config.

## WordPress

```sh
npx jpegxl add wordpress
```

Run it in the folder with `wp-config.php`, or add `--path <dir>`. Activate **JPEG XL Images** in **Plugins**. You can also upload the plugin ZIP from the [latest release](https://github.com/jackskip22/rapier-jxl/releases/latest) in **Plugins → Add New → Upload**.

Each upload gets a JPEG XL copy. Browsers without JPEG XL get the original. **Space saver** keeps only JPEG XL. JPEGs restore exactly, and PNG and WebP come back as a JPEG, or a PNG where they need transparency or every pixel kept. **Restore originals** writes every removed file back from its JPEG XL.

## Payload

```sh
npx jpegxl add payload
```

Writes a JPEG XL beside every uploaded image and each `imageSizes` size, on local disk or through Payload's storage adapters (S3, R2, Vercel Blob). JPEGs recompress losslessly and restore the original JPEG exactly. `<Picture>` renders `<picture>` with a `<source type="image/jxl">` for each size and the original as fallback, and Payload's file route sends `Vary: Accept`. `jxl({spaceSaver: true})` keeps JPEGs only as JPEG XL: after each upload is saved, a job in Payload's queue checks the stored JPEG against its JPEG XL and only then removes it. `restoreOriginals(payload)` puts every original back.

## Astro

```sh
npx jpegxl add astro
```

Then `<Picture src={photo} formats={['jxl', 'webp']} alt="" />`: a browser without JPEG XL takes the WebP. Astro 6 and 7. `jxl({jpeg: 'exact'})` keeps each JPEG restorable exactly.

- [Photos average 24% smaller than Astro's default WebP.](https://github.com/jackskip22/rapier-jxl/blob/main/bench/README.md#astro)
- [JPEGs 18% smaller, lossless.](https://github.com/jackskip22/rapier-jxl/blob/main/bench/README.md#astro)

## Vite

```sh
npx jpegxl add vite
```

Then `import hero from './hero.jpg?jxl'`. Add `?w=640&jxl` for one width or `?w=480;960;1440&jxl` for a `srcset`. Widths re-encode the picture at the selected quality. Vite 6, 7, 8 and Vite+.

- [Photos 39% smaller than WebP and 11% smaller than AVIF at the same look.](https://github.com/jackskip22/rapier-jxl/blob/main/bench/README.md#vite)
- [Camera JPEGs 17% smaller, lossless.](https://github.com/jackskip22/rapier-jxl/blob/main/bench/README.md#vite)

## webpack

```sh
npx jpegxl add webpack
```

Then `import hero from './hero.jpg?jxl'`. webpack 5 and Rspack.

## Next.js

```sh
npx jpegxl add next
```

`<Image>` serves JPEG XL to browsers that show it and Next's own image to the rest, with no component changes. After `next build`, each width next/image asks for is written once. Next.js 15 and 16.

- Photos 24% smaller than Next's default WebP at the same look.

## Netlify

```sh
npx jpegxl add netlify
```

After each build, every JPEG and PNG the site publishes gets a JPEG XL copy beside it, and browsers that show JPEG XL get that copy at the same address. Everyone else gets the original.

- JPEGs about a fifth smaller, lossless.

## Static sites (GitHub Pages, S3, any static host)

```sh
npx jpegxl site dist/
npx jpegxl site dist/ --dry-run
```

Converts the folder's images with `--keep-extension` and rewrites each HTML file's `<img>` (with its `srcset` and `sizes`) to `<picture>` with `<source type="image/jxl">`, only where every candidate has its `.jxl`. Existing `<picture>` elements with a JPEG XL source stay untouched, and images inside `<script>`, `<template>`, comments or attribute text are never changed. A second run changes nothing. `--dry-run` lists what it would change.

## Apache, nginx and Caddy

```sh
npx jpegxl public/ --keep-extension
npx jpegxl add apache public/
npx jpegxl add nginx public/
npx jpegxl add caddy public/
```

Serves `.jxl` beside JPEG, PNG, WebP and GIF to browsers that send `Accept: image/jxl`, and the original to everyone else, with `Vary: Accept`. `add apache` updates `.htaccess` between `# BEGIN jpegxl` and `# END jpegxl` markers and works on LiteSpeed too. `add nginx` writes `jpegxl.conf` and `add caddy` writes `jpegxl.caddy`, printing the one `include` or `import` line and reload command. Add `--url https://example.com` to check whether a CDN in front of the site honors `Vary: Accept`.

## Cloudflare Workers

```sh
npx jpegxl public/ --keep-extension
npx jpegxl add workers --route example.com/*
npx jpegxl add workers --paid --space-saver --route example.com/*
```

On Workers Free, the Worker serves the JPEG XL files to compatible browsers and the original to the rest. A request with a cookie or `Authorization` gets the site's own answer. `--paid` also encodes missing ones in the Worker and keeps them in R2. With `--space-saver` on Workers Paid, JPEGs are stored only as exact JPEG XL after restoring with `jpegxl/jpeg` and checking the SHA-256 against the stored JPEG (any mismatch keeps the original, and other formats keep their originals). The Worker rebuilds the original JPEG for browsers without JPEG XL and for share previews, with `Cache-Control` and `Vary: Accept`. Run `node jxl-space-saver.mjs public/` to retire JPEGs in a static folder and `node jxl-space-saver.mjs --restore public/` (or `restoreOriginals(env)` in R2) to rebuild every removed original.

- [Phone JPEGs 18% smaller, lossless.](https://github.com/jackskip22/rapier-jxl/blob/main/bench/README.md#cloudflare-workers)

## Cloudflare R2

```sh
npx jpegxl add r2 --bucket photos
npx jpegxl add r2 --bucket photos --space-saver
```

Every JPEG and PNG put in the bucket gets a JPEG XL beside it: a JPEG's restores the original JPEG, a PNG's keeps every pixel. A picture too large for one Worker call runs as a Workflow, step by step from resumable checkpoints. Reads get the JPEG XL when the browser accepts it and the original otherwise. With `--space-saver` (`JXL_SPACE_SAVER="on"`), each JPEG is restored and its SHA-256 compared with the stored JPEG before removing the original, while PNGs and other formats keep their originals. Browsers without JPEG XL and share previews receive the rebuilt original JPEG with `Cache-Control` and `Vary: Accept`. Call `restoreOriginals(env)` or send `{"action":"RestoreOriginals"}` to the queue to rebuild every removed original.

## Cloudflare Agents

```sh
npx jpegxl add agents
```

In an Agents SDK project: an MCP server with five JPEG XL tools, `jxl_convert`, `jxl_recompress`, `jxl_restore`, `jxl_verify` and `jxl_inspect`, and the same tools for an Agent class. Pictures stay in R2 and the tools pass their keys, never the bytes, through the conversation.

## Flutter

```sh
npx jpegxl add flutter
```

A Dart package runs the encoder in a hidden web view, offline, with no native codec. Android 8.0, iOS 16.4 and macOS 13.3 or newer.

```dart
import 'package:rapier_jxl/rapier_jxl.dart';

final codec = JXLCodec();
final jxl = await codec.encode(photoBytes, quality: 80, effort: 3);
final clip = await codec.animateVideo(mp4Bytes, type: 'video/mp4');
```

## React Native and Expo

```sh
npx jpegxl add expo
```

A hidden WebView runs the encoder, so Expo managed apps and Expo Go work unchanged. Nothing leaves the device.

```tsx
const App = () => <JXLProvider><Screen /></JXLProvider>;
const jxl = useJXL(); // in Screen
const out = await jxl.encode(photo, {quality: 80, effort: 3});
```

## Capacitor

```sh
npx jpegxl add capacitor
```

The encoder runs in web workers inside the app. Capacitor's Filesystem plug-in saves the file. There is no codec bridge.

## Electron

```sh
npx jpegxl add electron
```

The browser files run in Electron's window as they are: no native codec and no rebuild. The Node files run in the main process too.

## Tauri

```sh
npx jpegxl add tauri
```

The browser files run in Tauri 2's web view: WebView2 on Windows, WebKit on macOS, WebKitGTK on Linux. No Rust codec crate. The Rust side stays yours.

Native code is faster. rapier-jxl doesn't need any and brings everything above to the phone: quality measured visually, text kept exact in screenshots and the same files as on the web.

## Errors

Every refusal carries a `code`:

| Code | Meaning |
| --- | --- |
| `JXL_OPTIONS` | An option is unknown or not allowed. |
| `JXL_INPUT` | The input is missing, empty, wrong for the call, or changed while read. |
| `JXL_DIMENSIONS` | The picture is larger than the format or the host allows. |
| `JXL_JPEG`, `JXL_DECODE` | Not a JPEG, or not a valid JPEG XL file. |
| `JXL_RECONSTRUCTION` | No JPEG reconstruction data in the file. |
| `JXL_TARGET` | The fidelity asked for cannot be reached. |
| `JXL_PLATFORM` | This host cannot decode the input or lacks an API. |
| `JXL_MEMORY`, `JXL_LIMIT` | Not enough memory, or a byte or queue bound you set. |
| `JXL_WASM`, `JXL_WEBGPU` | No WebAssembly with SIMD, or `webgpu: 'required'` with no device. |
| `JXL_WORKER`, `JXL_IO` | A worker would not start, or a Blob or image could not be read. |
| `JXL_CLOSED` | The codec is closed. |
| `JXL_SETUP` | `npx jpegxl add` or `remove` cannot recognize or safely change the project. Nothing was changed. |
| `JXL_UNSUPPORTED` | A valid request this version does not do. |
| `JXL_INTERNAL` | A fault in rapier-jxl. |

## License

MIT. Third-party notices: `THIRD_PARTY_NOTICES`.

## Agents

```sh
npx jpegxl photos/ --out out/ --json
```

The package contains an agent skill, `skills/rapier-jxl/SKILL.md` with files and folders, byte budgets and JPEGs restored exactly. With `--json` there is one JSON object per file and a summary, and nothing else on stdout. `npx jpegxl add <place>` sets up any of the 22 places above. In a chat, [Rapier's MCP server](https://rapier.website/agents) converts pictures to JPEG XL.

## Help by testing on your phone

It is very complicated to optimize encoder speed for every phone's GPU and rapier-jxl is meant to be great on every device. Open [rapier.website/docs/jxl-job.html](https://rapier.website/docs/jxl-job.html) on your phone and tap **Start**. It encodes a photo and a camera picture with and without WebGPU, checks that every file is the same, and logs the times automatically when it's done. All you have to do is leave the browser open for about 10 minutes on your iPhone or Android phone.

## Contributing

Anybody is welcome to contribute to rapier-jxl, which is intended to be as universal as possible. You can also greatly assist the project by simply performing tests on your computer or phone which is always turning up new edge cases to improve the encoder. Testing on every kind of device is essential for a universal encoder. Check the jobs/ folder in the repo root, open an issue with the job's name as its title if you've started work on it, then please submit your results by attaching them to that issue.

For feedback, requests or questions, feel free to join the discussion. The goal is to make rapier-jxl as easy, fast, small, powerful and reliable as possible for every use case, while keeping the architecture simple and general.

Examples and plugins can be added for very common use cases.
