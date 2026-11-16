# rapier-jxl in React Native and Expo

A hidden `react-native-webview` runs the browser encoder: no native JPEG XL codec to build or link, so Expo managed apps (and
Expo Go) work unchanged. It encodes a photo, recompresses a JPEG and restores the same bytes, turns a video or GIF into an
animated JPEG XL, cancels a call, and refuses bad input with the package's `JXL_` code. Nothing leaves the device: the page
has no network, and its policy allows only its own blob addresses.

The modules in `src/generated` are 3,277,018 bytes of text the app bundles. Brotli 11 module sizes, not install sizes: photos
331,953 B, JPEG 166,269 B, animation 495,809 B and its page file 19,648 B. Nothing here claims speed.

## Use

Built and typechecked on Expo SDK 58 (React Native 0.88, react-native-webview 14). iOS 16.4 or newer, Android 8.0 or newer.

```sh
npm install --no-save jpegxl
node prepare-assets.mjs          # copies the built modules into src/generated as strings the app bundles
```

For a local package build, set `JXL_PACKAGE` to its directory containing `package.json` and `dist/` first.
Copy `src/` into your app, add `react-native-webview`, and put the provider once, high in the tree.

```tsx
import {JXLProvider, useJXL} from './src/index.ts';

const App = () => <JXLProvider><Screen /></JXLProvider>;

function Screen() {
  const jxl = useJXL();
  const encode = async (uri: string) => {
    const photo = new Uint8Array(await (await fetch(uri)).arrayBuffer());
    const out = await jxl.encode(photo, {quality: 80, effort: 3});   // JPEG XL bytes
  };
}
```

```ts
await jxl.encode(photo, {quality: 80, effort: 3});     // photo in (JPEG, PNG, WebP...), JPEG XL out
await jxl.encodeExact(photo);                           // every pixel kept
const small = await jxl.recompress(jpeg);               // a JPEG's own bytes, smaller
const same = await jxl.restore(small);                  // the same JPEG, byte for byte
await jxl.animate(video, {onProgress: f => {}});        // every frame the video plays, each with its time; or a GIF
```

Calls take `Uint8Array` or `ArrayBuffer`, return `Promise<Uint8Array>`, and run one at a time. Cancel with an `AbortSignal`:
`{signal}` rejects with `JXLError` code `JXL_CANCELED`, and the next call runs normally. A refusal rejects with `JXLError`
and the package's own code. If the system ends the page, pending calls reject with `JXL_WEBVIEW_STOPPED` and the next call
starts a new page. `useJXL` needs a `JXLProvider` above it; calls made before the page is ready wait for it.

## What crosses the bridge

React Native's WebView carries strings only, so there is no binary path to use: no `ArrayBuffer` message, no local server in
Expo Go. Bytes cross as base64 in chunks of 196,608 bytes, in both directions.

- **Cost:** 4/3 of each input and each result as text, plus one decode in the page and one in JavaScript. Chunks yield between
  sends, so touches and frames go through. The module sources (3.3 MB, loaded on first use: photos and JPEGs first, animation when
  first asked) cross once per page.
- **Where it does not apply:** inside the page, the encoder gets raw bytes, and a worker gets them transferred, not copied.
  The [iOS](../ios/README.md) and [Android](../android/README.md) examples carry bytes without base64; use them if you can add native code.
- A video is read into JavaScript memory whole before it crosses. Keep clips short, or use the iOS and Android examples.

## Files

- `src/JXLProvider.tsx`: `JXLProvider` and `useJXL`, the hidden WebView.
- `src/codec.ts`: the calls, the queue, cancel, and the messages. No React in it.
- `src/base64.ts`: the two loops that carry bytes.
- `web/page.js` and `web/worker.js`: the page (animations, modules, chunks) and its worker (photos and JPEGs).
- `prepare-assets.mjs`: copies the built modules unchanged and writes the page with its content security policy.
- `App.tsx`: three buttons (Photo, JPEG, Video) and `src/selftest.ts`, the proof the CI reads.

## Check

`JXL_PACKAGE=<built package> node check.mjs` runs the same page and `src/codec.ts` in Chromium: photo, exact mode, JPEG
restore compared byte for byte, GIF and video read back by the package's decoder, bad input, cancel, two calls at once, and no
request outside the page. It needs `npm install --no-save playwright`.

`ci/react-native.yml` builds the release app with no INTERNET permission and runs the self-test on an Android emulator
(Linux, KVM) and an iPhone simulator (macOS). A phone checks the real picker with large photos and long videos.
