# For an agent adding Rapier JXL to an app

1. Install: `npm install rapier-jxl`, or copy one file from this repository's root into the app: `rapier-jxl.min.mjs`
   (everything), `lossless.min.mjs` or `jpeg.min.mjs` (one function each), or the eleven readable `.mjs` files with
   `index.mjs` as the entry. No build needed.
2. Import `encode` and `transcode` from `rapier-jxl` (the readable modules), `rapier-jxl/min` (the one minified
   file), or `encodeLosslessRGBA` from `rapier-jxl/lossless` and `transcode` from `rapier-jxl/jpeg`.
3. Encode pixels: `encode(rgba, width, height, {quality})`, `rgba` being straight (not premultiplied) RGBA bytes
   row by row, as `CanvasRenderingContext2D.getImageData` gives them; `quality` 100 (the default) is lossless,
   1 to 99 lossy. The answer is a `Uint8Array` of JPEG XL codestream bytes: save it as `.jxl` or wrap it in a
   `Blob` of type `image/jxl`.
4. Carry a JPEG: `transcode(jpegBytes)` returns `{bytes, width, height, orientation}`; do not decode the JPEG
   first. If it throws `JXL_JPEG` (a form the carrier does not take, a colour profile other than sRGB, a file cut
   short), decode it (an `<img>` and a canvas) and call `encode` on the pixels.
5. Run it in a worker for anything larger than an icon; the README shows a complete one in eight lines.
6. Handle the five error codes (`JXL_INPUT`, `JXL_DIMENSIONS`, `JXL_SIZE`, `JXL_MEMORY`, `JXL_JPEG`); there are no
   others from the checked entries, and a call that returns has returned a stream a conformant JPEG XL decoder
   reads (checked against jxl-oxide and libjxl at each release).
7. Show the result only where the browser decodes JPEG XL (`image/jxl` in `<picture>` with a fallback, or a
   feature test on a one-pixel stream); keep the original where it does not.

Nothing here reads files, fetches, or touches the DOM; the module is safe to run in a worker, in Node and in
Deno alike. Do not vendor a minified copy under another name: publish the version you took and its licence.
