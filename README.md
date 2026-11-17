# rapier-jxl

[![npm](https://img.shields.io/npm/v/jpegxl)](https://www.npmjs.com/package/jpegxl)
[![downloads](https://img.shields.io/npm/dw/jpegxl)](https://www.npmjs.com/package/jpegxl)
[![license](https://img.shields.io/npm/l/jpegxl)](https://github.com/jackskip22/rapier-jxl/blob/main/LICENSE)
[![types](https://img.shields.io/npm/types/jpegxl)](https://www.npmjs.com/package/jpegxl)

JPEG XL in WebAssembly + JS with optional WebGPU & parallel workers. Brotli: ~60 KB exact capture, ~290 KB complete capture, ~330 KB upload, ~485 KB full encoder. HDR, metadata, lossless JPEG, video/GIF to animation, resumable edge encoding, serve, polyfill, decode. Auto quality, exact text. CLI & npx jpegxl add: 16 platforms. No dependencies. MIT.

rapier-jxl is the encoder inside [rapier.website](https://rapier.website), the free Markdown editor, drawing and painting app. Rapier is also a free [Android app](https://play.google.com/store/apps/details?id=app.rapier&referrer=utm_source%3Djxl-readme) that opens and converts JPEG XL pictures.

It is also used by [SnapDOM's official JPEG XL plugin](https://snapdom.dev/plugins/jxl/) and the [EmDash JPEG XL Image Optimizer plugin](https://plugins.emdashcms.com/plugins/@rapier.website/jxl). [Try rapier-jxl in your browser](https://rapier.website/jxl).

```sh
npm install jpegxl
```

ESM, Node 20.16+ or 22.3+. From CommonJS: `await import('jpegxl')`.

## Command line

```sh
npx jpegxl photo.png                   # photo.jxl alongside
npx jpegxl scan.jpg                    # lossless: JPEG restores exactly
npx jpegxl photos/ --out dist/         # every PNG, JPEG, WebP, AVIF, GIF, HDR and EXR in the folder
npx jpegxl hero.png --max-bytes 100KB  # best quality that fits
npx jpegxl scan.jxl --out back/        # back/scan.jpg, original JPEG
```

Options: `--quality 1–100` (default 90; a JPEG stays exact), `--effort 1–9` (default 7), `--max-bytes`, `--out`, `--exact`, `--jpeg-pixels`, `--jobs`, `--verify`, `--json`. A different file is never replaced.

## Add it to your project

```sh
npx jpegxl add <place>
```

Places: `emdash`, `astro`, `vite`, `webpack`, `next`, `netlify`, `workers`, `r2`, `agents`, `android`, `ios`, `flutter`, `expo`, `capacitor`, `electron`, `tauri`. It works from the installed package (EmDash and Astro install what they lack), `--dry-run` shows what it would change, and `npx jpegxl remove <place>` undoes exactly what it wrote.

## No code required

- [rapier.website/jxl](https://rapier.website/jxl) converts pictures in the browser, offline, on your device.
- [JPEG XL Converter for VS Code](https://marketplace.visualstudio.com/items?itemName=rapier.jxl) converts files in a workspace.
- [Rapier for Android](https://play.google.com/store/apps/details?id=app.rapier&referrer=utm_source%3Djxl-readme) opens, converts and shares JPEG XL images.

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

Efforts 1 to 3 (default 3). `variants` makes multiple sizes from one picture. Every encoding call takes `onProgress` and `signal`. On Node, Deno and Bun a JPEG needs `configureDecoder(decode, null, recompress)` first. Pixels and PNG work normally.

## Encode

```ts
import {writeFile} from 'node:fs/promises';
import {encode} from 'jpegxl';

const picture = {data: new Uint8Array([240, 120, 40, 255]), width: 1, height: 1};
const {bytes} = await encode(picture, {fidelity: {quality: 90}});
if (bytes) await writeFile('picture.jxl', bytes);
```

Takes RGBA `{data, width, height}`, `ImageData`, a canvas, an `ImageBitmap`, a `VideoFrame`, a `Blob` or a GPU texture, in 8 or 16 bits, `Float16Array` or `Float32Array` (HDR).

- `fidelity`: `{quality: 1–100}`, default 90, or `'exact'`.
- `effort`: 1–9, default 7. Efforts 6–9 measure the look; 1–5 predict it.
- `webgpu`: efforts 7–9 use WebGPU where it can. `'required'` refuses without it. `false` turns it off.
- `progressive: true`: the first bytes show the whole picture, which sharpens as the rest arrives (about 2 to 5% more bytes).
- `onPreview` receives each better file while efforts 6–9 search, to show the picture forming.
- The host's memory is the limit.
- A JPEG stays JPEG and restores exactly with `fidelity: 'exact'` or at a quality level when that can be smaller (efforts 6–9). `jpeg: 'pixels'` encodes its pixels.
- `jpegxl/animation` takes frames or an animated GIF, `jpegxl/hdr` reads OpenEXR and Radiance files, `jpegxl/verify` checks a file against its source.

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

`pageRects` finds the text and photos in an element; `exactRects` and `photoRects` take the boxes by hand. Text is exact at every effort.

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

Upload a video or GIF to make it a much smaller animated JPEG XL without losing its quality. It keeps every frame's timing and the loop count. Frames can also be pixels: `{width, height, loops, frames: [{data, duration}]}`.

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

`recompress(jpeg, {gainMap: true})` keeps a phone photo's HDR gain map and still restores the JPEG exactly. `slice` and `placeholder` from `jpegxl/metadata` cut a smaller size (1:2, 1:4 or 1:8) from a progressive file in milliseconds, without decoding.

`jpegxl/svg-jxl` converts the pictures inside an SVG and keeps shapes and text sharp.

## Serving

```ts
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {serve} from 'jpegxl/serve';

const stored = await readFile('photo.jxl'); // made once: npx jpegxl photo.jpg
createServer((req, res) => void serve(stored, req, res)).listen(3000);
```

JPEG XL to browsers that accept it, the original JPEG to the rest, with `Vary: Accept`, ETag, `304` and `HEAD`. Workers, Deno and Bun: `return serve(stored, request)`.

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

In browsers the module runs in its own worker. Node, Deno and Bun run it in the calling thread alongside `helpers`. `configure` sets a module's queue before its first call and `close()` ends its worker. Canceled calls reject with the signal's reason.

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
- Each module's file is its own worker. With esbuild or Angular, copy it beside the bundle.

## EmDash

```sh
npx jpegxl add emdash
```

Originals stay in the site's storage. Browsers that accept JPEG XL get verified copies and the rest get the original. **Plugins → JPEG XL Image Optimizer** sets the goal, effort and widths, and converts the library. The package's `examples/emdash/astro.config.mjs` is a whole config.

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

Then `import hero from './hero.jpg?jxl'`. Vite 6, 7 and 8.

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

## Cloudflare Workers

```sh
npx jpegxl public/ --out public/
npx jpegxl add workers --route example.com/*
```

On Workers Free, the Worker serves the JPEG XL files to compatible browsers and the original to the rest. `--paid` also encodes missing ones in the Worker and keeps them in R2.

- [Phone JPEGs 18% smaller, lossless.](https://github.com/jackskip22/rapier-jxl/blob/main/bench/README.md#cloudflare-workers)

## Cloudflare R2

```sh
npx jpegxl add r2 --bucket photos
```

Every JPEG and PNG put in the bucket gets a JPEG XL beside it: a JPEG's restores the original exactly, a PNG's keeps every pixel. A picture too large for one Worker call runs as a Workflow, step by step from resumable checkpoints. Reads get the JPEG XL when the browser accepts it and the original otherwise.

## Cloudflare Agents

```sh
npx jpegxl add agents
```

In an Agents SDK project: an MCP server with five JPEG XL tools, `jxl_convert`, `jxl_recompress`, `jxl_restore`, `jxl_verify` and `jxl_inspect`, and the same tools for an Agent class. Pictures stay in R2 and the tools pass their keys, never the bytes, through the conversation.

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

The encoder runs in web workers inside the app. Capacitor's Filesystem plug-in saves the file; there is no codec bridge.

## Electron

```sh
npx jpegxl add electron
```

The browser files run in Electron's window as they are: no native codec and no rebuild. The Node files run in the main process too.

## Tauri

```sh
npx jpegxl add tauri
```

The browser files run in Tauri 2's web view: WebView2 on Windows, WebKit on macOS, WebKitGTK on Linux. No Rust codec crate; the Rust side stays yours.

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
| `JXL_SETUP` | `npx jpegxl add` does not recognize the folder; nothing was changed. |
| `JXL_UNSUPPORTED` | A valid request this version does not do. |
| `JXL_INTERNAL` | A fault in rapier-jxl. |

## Modules

Brotli 11 size of each module's file: `jpegxl` about 485 KB, `upload` 330, `capture` 60, `capture-complete` 290, `animation` 505, `format` 525 (codestream features), `jpeg` 170, `decode` 115, `verify` 85, `serve` 75, `resumable` 70, `metadata` 40, `polyfill` 23, `hdr` 13.

## License

MIT. Third-party notices: `THIRD_PARTY_NOTICES`.

## Agents

```sh
npx jpegxl photos/ --out out/ --json
```

The package contains an agent skill, `skills/rapier-jxl/SKILL.md` with files and folders, byte budgets and JPEGs restored exactly. With `--json` there is one JSON object per file and a summary, and nothing else on stdout. `npx jpegxl add <place>` sets up any of the 16 places above. In a chat, [Rapier's MCP server](https://rapier.website/agents) converts pictures to JPEG XL.

## Help by testing on your phone

It is very complicated to optimize encoder speed for every phone's GPU and rapier-jxl is meant to be great on every device. Open [rapier.website/docs/jxl-job.html](https://rapier.website/docs/jxl-job.html) on your phone and tap **Start**. It encodes a photo and a camera picture with and without WebGPU, checks that every file is the same, and logs the times automatically when it's done. All you have to do is leave the browser open for about 10 minutes on your iPhone or Android phone.

## Contributing

Anybody is welcome to contribute to rapier-jxl, which is intended to be as universal as possible. You can also greatly assist the project by simply performing tests on your computer or phone which is always turning up new edge cases to improve the encoder. Testing on every kind of device is essential for a universal encoder. Check the jobs/ folder in the repo root, open an issue with the job's name as its title if you've started work on it, then please submit your results by attaching them to that issue.

For feedback, requests or questions, feel free to join the discussion. The goal is to make rapier-jxl as easy, fast, small, powerful and reliable as possible for every use case, while keeping the architecture simple and general.

Examples and plugins can be added for very common use cases.
