# Adding Rapier JXL to an app

1. `npm install rapier-jxl`, or copy one file from `dist/`: `rapier-jxl.min.mjs` (the core), `effort.min.mjs`,
   `jpeg.min.mjs` or `photo.min.mjs`. No build.
2. `import {encode} from 'rapier-jxl'`, `transcode` from `rapier-jxl/jpeg`, `encodePhoto` from `rapier-jxl/photo`.
   Smaller lossless files at more time: `encode` from `rapier-jxl/effort` with `{effort: 3}`.
3. Pixels: `encode(rgba, width, height, {quality})`, straight RGBA row by row as `getImageData` gives it; from a
   Display P3 canvas add `colorSpace: 'display-p3'`. Quality 100 (the default) is lossless, 1 to 99 lossy, alpha exact
   at every quality. Photographs: `encodePhoto(rgba, width, height, {quality: 90})`. The result is a `Uint8Array`:
   save it as `.jxl` or in a `Blob` of type `image/jxl`.
4. A JPEG: `transcode(jpegBytes)` gives `{bytes, width, height, orientation}` without decoding. On `JXL_JPEG`, decode
   it and call `encodePhoto` on the pixels. `{effort: 4}` tries a smaller entropy representation with identical
   pixels (default 1); `rapier-jxl/jpeg-ans` and `rapier-jxl/photo-ans` take `{effort: 2}` to also try ANS, for about
   1.1 kB gzip more.
5. Run anything larger than an icon in a worker. Calls are synchronous: cancel by terminating the worker, or loop over
   the door's twin (`encodeSteps`, `transcodeSteps`, `encodePhotoSteps`) and leave the loop. A transferred buffer is
   gone from the sender: copy first if you may retry.
6. Errors have `code` `JXL_INPUT`, `JXL_DIMENSIONS`, `JXL_SIZE`, `JXL_MEMORY` or `JXL_JPEG`. `JXL_DIMENSIONS` is past
   the door's `LIMITS` (24 million pixels for the core and `effort`, 40 million for `photo`, 64 million for a
   carried JPEG). Keep the original pixels until the encode and its storage succeed.
7. Show the result only where the browser decodes JPEG XL (`<picture>` with a fallback, or a one-pixel feature test).

Nothing here reads files, fetches or touches the DOM: it runs in a worker, Node or Deno alike. Keep the licence with
the file you take; do not vendor a minified copy under another name.

Acceleration with unchanged bytes: use `rapier-jxl/wasm` (or `dist/wasm.min.mjs`) in place of `effort`. It falls back
to JavaScript when SIMD is missing or blocked. Use that one file; do not combine separate minified bundles to share
kernel controls. See `docs/KERNELS.md`.
