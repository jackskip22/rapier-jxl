# For an agent adding Rapier JXL to an app

1. `npm install rapier-jxl`, or copy one file from this repository's root: `rapier-jxl.min.mjs` (the core),
   `effort.min.mjs`, `jpeg.min.mjs` or `photo.min.mjs`. No build.
2. `import {encode} from 'rapier-jxl'` (or `rapier-jxl/min`), `transcode` from `rapier-jxl/jpeg`, `encodePhoto`
   from `rapier-jxl/photo`. For smaller lossless files at more time, `encode` from `rapier-jxl/effort` with
   `{effort: 3}`.
3. Pixels: `encode(rgba, width, height, {quality})`, straight RGBA row by row as `getImageData` gives it; from a
   Display P3 canvas, add `colorSpace: 'display-p3'`. Quality 100 (the default) is lossless, 1 to 99 lossy, alpha
   exact at every quality. Photographs:
   `encodePhoto(rgba, width, height, {quality: 90})`. The answer is a `Uint8Array` of codestream bytes: save it
   as `.jxl` or in a `Blob` of type `image/jxl`.
4. A JPEG: `transcode(jpegBytes)` gives `{bytes, width, height, orientation}` without decoding. On `JXL_JPEG`,
   decode it and call `encodePhoto` on the pixels. Both doors accept `{effort: 4}` to try a smaller entropy
   representation with identical reconstructed pixels; the default is 1.
   For an additional ANS candidate, use the same API from `rapier-jxl/jpeg-ans` or `rapier-jxl/photo-ans` with
   `{effort: 2}`. These optional imports cost about 1.1 kB gzip more than their ordinary door and keep the smaller
   complete stream; benchmark the extra encode work for your use. Default effort 1 stays prefix-coded.
5. Anything larger than an icon runs in a worker. Calls are synchronous, so cancel by terminating the worker, or
   loop over the door's twin (`encodeSteps`, `transcodeSteps`, `encodePhotoSteps`) and leave the loop. A
   transferred buffer is gone from the sender: copy first if you may retry.
6. The error codes are `JXL_INPUT`, `JXL_DIMENSIONS`, `JXL_SIZE`, `JXL_MEMORY` and `JXL_JPEG`, no others;
   `JXL_DIMENSIONS` is past the door's own `LIMITS` (24 million pixels for the core and `effort`, 40 million for
   `photo`, 64 million for a carried JPEG). Keep the original pixels until the encode and its storage succeed.
7. Show the result only where the browser decodes JPEG XL (`<picture>` with a fallback, or a one-pixel feature test).

Nothing here reads files, fetches or touches the DOM: it runs in a worker, Node or Deno alike. Publish the version
you took and its licence; do not vendor a minified copy under another name.
