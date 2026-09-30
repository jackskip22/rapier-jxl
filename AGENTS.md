# For an agent adding Rapier JXL to an app

1. `npm install rapier-jxl`, or copy one file from this repository's root: `rapier-jxl.min.mjs` (the core),
   `lossless.min.mjs`, `jpeg.min.mjs` or `photo.min.mjs`. No build.
2. `import {encode, transcode} from 'rapier-jxl'` (or `rapier-jxl/min`); `encodeLosslessRGBA` from
   `rapier-jxl/lossless`, `transcode` from `rapier-jxl/jpeg`, `encodePhotoRGBA` from `rapier-jxl/photo`.
3. Pixels: `encode(rgba, width, height, {quality})`, straight RGBA row by row as `getImageData` gives it. Quality 100
   (the default) is lossless, 1 to 99 lossy, alpha exact at every quality. Photographs:
   `encodePhotoRGBA(rgba, width, height, {quality: 90})`. The answer is a `Uint8Array` of codestream bytes: save it
   as `.jxl` or in a `Blob` of type `image/jxl`.
4. A JPEG: `transcode(jpegBytes)` gives `{bytes, width, height, orientation}` without decoding. On `JXL_JPEG`,
   decode it and call `encode` on the pixels.
5. Anything larger than an icon runs in a worker. Calls are synchronous, so cancel by terminating the worker. A
   transferred buffer is gone from the sender: copy first if you may retry.
6. The error codes are `JXL_INPUT`, `JXL_DIMENSIONS`, `JXL_SIZE`, `JXL_MEMORY` and `JXL_JPEG`, no others. Keep the
   original pixels until the encode and its storage succeed.
7. Show the result only where the browser decodes JPEG XL (`<picture>` with a fallback, or a one-pixel feature test).

Nothing here reads files, fetches or touches the DOM: it runs in a worker, Node or Deno alike. Publish the version
you took and its licence; do not vendor a minified copy under another name.
