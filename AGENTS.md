# For an agent adding Rapier JXL to an app

1. Install: `npm install rapier-jxl`, or copy one file from this repository's root into the app: `rapier-jxl.min.mjs`
   (the core), `lossless.min.mjs`, `jpeg.min.mjs` or `photo.min.mjs` (one checked function each), or the readable
   `.mjs` files with `index.mjs` as the core entry and `photo.mjs` as the optional photo entry. No build needed.
2. Import `encode` and `transcode` from `rapier-jxl` (the readable modules), `rapier-jxl/min` (the one minified
   file), or `encodeLosslessRGBA` from `rapier-jxl/lossless` and `transcode` from `rapier-jxl/jpeg`.
3. Encode pixels: `encode(rgba, width, height, {quality})`, `rgba` being straight (not premultiplied) RGBA bytes
   row by row, as `CanvasRenderingContext2D.getImageData` gives them; `quality` 100 (the default) is lossless,
   1 to 99 lossy. Alpha is exact at every quality. For photographic VarDCT, import `encodePhotoRGBA` from
   `rapier-jxl/photo` and call `encodePhotoRGBA(rgba, width, height, {quality: 90})`. It defaults to 90; 100 is
   exact, including RGB beneath transparent pixels. Quality numbers across encoders are not equivalent PSNR.
   Each answer is a `Uint8Array` of JPEG XL codestream bytes: save it as `.jxl` or wrap it in a `Blob` of type `image/jxl`.
4. Carry a JPEG: `transcode(jpegBytes)` returns `{bytes, width, height, orientation}`; do not decode the JPEG
   first. If it throws `JXL_JPEG` (a form the carrier does not take, a colour profile other than sRGB, a file cut
   short), decode it (an `<img>` and a canvas) and call `encode` on the pixels.
5. Run it in a worker for anything larger than an icon. Calls are synchronous: cancel by terminating that worker,
   disregard obsolete request IDs and start a replacement worker. A transferred input buffer is no longer owned
   by the sender; keep a copy first if cancellation must retain the original pixels.
6. Handle the five error codes (`JXL_INPUT`, `JXL_DIMENSIONS`, `JXL_SIZE`, `JXL_MEMORY`, `JXL_JPEG`); there are no
   others from the checked entries. The committed conformance cases are decoded by jxl-oxide and native libjxl;
   this evidence does not prove every possible input. Keep original pixels until encoding and storage succeed.
7. Show the result only where the browser decodes JPEG XL (`image/jxl` in `<picture>` with a fallback, or a
   feature test on a one-pixel stream); keep the original where it does not.

Nothing here reads files, fetches, or touches the DOM; the module is safe to run in a worker, in Node and in
Deno alike. Do not vendor a minified copy under another name: publish the version you took and its licence.
