# FilePond example: guidance for agents

Photographs become JPEG XL on the person's device before FilePond uploads them.

## Wire it

1. Copy `shrink.mjs` and `filepond.mjs` from this folder into the app (for example `src/rapier-jxl/`), with
   `rapier-jxl` installed.
2. Where the app creates the widget: `import jxl from './rapier-jxl/filepond.mjs'` and `FilePond.registerPlugin(jxl)`.
   Leave `filepond-plugin-image-transform` out unless the app crops or resizes. With it, rapier-jxl encodes its output.
3. The page's Content Security Policy must allow `'wasm-unsafe-eval'` and workers from the app's own origin.

## Check it worked

- Pick a JPEG photo: the uploaded file is `image/jxl`, named `.jxl`, and smaller than the photo.
- The server must accept `image/jxl`. Edge does not display JPEG XL: serve those visitors another file
  (`jpegxl/serve` serves an exact JPEG back when `quality: 100` kept the JPEG), or keep the original as well.

## Do not

- Do not catch or retry rapier-jxl's errors around the plug-in: a refused file (any `JXL_*` code) already goes up as
  it was picked, and the upload never fails because of rapier-jxl.
- Do not raise `imageJxlEffort` above 3: `jpegxl/upload` takes efforts 1 to 3.
