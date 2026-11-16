# rapier-jxl in Tauri

The package's browser files run in Tauri 2's system web view as they are: WebView2 on Windows, WebKit on macOS, WebKitGTK on Linux.
No native codec, no Rust codec crate. Drop or choose a photo to encode, recompress a JPEG and restore the same SHA-256, turn a video
into an animated JPEG XL, cancel a call, and save with the platform's save dialog. A refusal shows the package's `JXL_` code.

The files under `web/` are 3,358,892 bytes. Brotli 11 module sizes, not install sizes: photos 331,953 B, JPEG 166,269 B,
animation 495,809 B and its page file 19,719 B. The release binary on Linux x64 is 6,193,864 bytes with the web files inside
(`tauri build --no-bundle`, Rust 1.97, Tauri 2.x as `Cargo.lock` pins it). Nothing here claims speed.

## Use

Node 22.12 or newer, Rust, and [Tauri's system libraries](https://v2.tauri.app/start/prerequisites/).

```sh
npm install
JXL_PACKAGE=/absolute/path/to/package npm run assets   # or: npm install --no-save jpegxl first, then npm run assets
npm run dev
npm run build                                          # src-tauri/target/release
```

## How it is built

- `src-tauri/src/main.rs` has one command, `save`: the platform's save dialog, then the file's bytes. The page sends them as the raw body
  of `invoke`; no base64. The capability is `core:default`: no `fs` plug-in, no path the page can name.
- `tauri.conf.json` sets a CSP (`'wasm-unsafe-eval'`, workers from `'self'` and `blob:`) and the cross-origin isolation headers.
- The page, `../desktop/`, is the one Electron uses.

Found while building it, on WebKitGTK 2.52:

- WebKitGTK is not cross-origin isolated (no `SharedArrayBuffer`), and nothing here needs it.
- WebKitGTK stamps a video frame with the position sought, not its own time, so reading a 2 s clip walked millisecond by millisecond and
  took minutes. `jpegxl/animation` now tells the two apart and samples by seeking: seconds.
- Which videos play is the system's: on the Linux box here WebKitGTK plays WebM and not H.264. A video the web view cannot play is refused with `JXL_INPUT`.
- A `<script type="module">` runs about a second after the page is ready to drive; a test waits for `load`.
- `__TAURI_INTERNALS__.invoke` cannot be replaced, so a test cannot answer the dialog from the page: the check build (`--features check`) writes Save's file
  into `RAPIER_JXL_CHECK_SAVE_DIR` instead. The shipped build has no such path.

## Check

`npm run build-check`, then `npm run check` (`JXL_PACKAGE` set). The scenario runs in the app's own web view: a dropped photo,
a chosen JPEG whose restored file has the same SHA-256, a video read back as 23 frames over 2 s, cancel and the next call, a bad
file's `JXL_` code. On Linux and Windows `tauri-driver` drives it (WebKitWebDriver, msedgedriver); WKWebView has no WebDriver,
so on macOS the check build runs the same scenario itself. `ci/tauri.yml` runs all three. A person checks the real dialog.
