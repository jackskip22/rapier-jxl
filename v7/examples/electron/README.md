# rapier-jxl in Electron

The package's browser files run in Electron's Chromium as they are: no native codec, no rebuild, no `electron-rebuild`.
Drop or choose a photo to encode, recompress a JPEG and restore the same SHA-256, turn a video into an animated JPEG XL,
cancel a call, and save with the platform's save dialog. A refusal shows the package's `JXL_` code. The Node files run in the
main process too.

The files under `web/` are 3,358,892 bytes. Brotli 11 module sizes, not install sizes: photos 331,953 B, JPEG 166,269 B,
animation 495,809 B and its page file 19,719 B. Nothing here claims speed.

## Use

Node 22.12 or newer.

```sh
npm install
JXL_PACKAGE=/absolute/path/to/package npm run assets   # or: npm install --no-save jpegxl first, then npm run assets
npm start
```

## How it is built

- `main.mjs` serves `web/` at `app://rapier/` with a CSP (`'wasm-unsafe-eval'`, workers from `'self'`) and the cross-origin isolation
  headers. Photos, JPEGs and videos encode in the package's own workers; the page never leaves the window.
- `preload.cjs` gives the page one call, `rapierDesktop.save(bytes, name)`. `contextIsolation` and `sandbox` stay on; the page has no Node.
- `main-check.mjs` runs the Node files in a main process: `import {encode} from 'jpegxl/upload'`, `recompress` and `restore` from `jpegxl/jpeg`.
  Node reads no JPEG, as everywhere: a photo there is pixels.
- The page, `../desktop/`, is the one Tauri uses.

Found while building it:

- `file://` also works in Electron 45 (module workers and WebAssembly load). `app://` is for the CSP and isolation headers.
- An ES module main must not `await app.whenReady()` at its top level: Electron finishes loading it before `ready`, and the app hangs.

## Check

`npm run check` (`JXL_PACKAGE` set, `xvfb-run -a` on a headless Linux) drives the app with Playwright's Electron support: a dropped
photo, a chosen JPEG whose restored file has the same SHA-256, a video read back as 23 frames over 2 s, cancel and the next call,
a bad file's `JXL_` code, the Node files in a main process, no request outside the app. Save's dialog is answered by the test.
`ci/electron.yml` runs it on Linux, Windows and macOS runners. A person checks the real dialog.
