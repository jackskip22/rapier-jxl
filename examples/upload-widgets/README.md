# JPEG XL for FilePond (an example)

Photographs become JPEG XL on the person's device before they are uploaded. A 12 MP phone photo goes up at about a
sixth of its size.

rapier-jxl is the encoder inside rapier.website, the free Markdown editor and painting app.

## Use it

Copy `shrink.mjs` and `filepond.mjs` into the app (for example `src/rapier-jxl/`), with `rapier-jxl` installed, then:

```js
import * as FilePond from 'filepond';
import jxl from './rapier-jxl/filepond.mjs';

FilePond.registerPlugin(jxl);
FilePond.create(input, {imageJxlQuality: 70});
```

Options: `allowImageJxl` (`true`), `imageJxlQuality` (`70`, and `100` keeps a JPEG so it restores exactly), `imageJxlEffort` (`3`),
`imageJxlRetainExif` (`false`). With a server, files are made smaller when their upload starts. For a form post,
when they are added.

A runnable example is in `filepond-example/`. In a folder with this package and `filepond` installed, run
`node node_modules/jpegxl/examples/upload-widgets/filepond-example/server.mjs`, open the address it prints and pick
photographs. It is a local demo on 127.0.0.1, not a production server. It keeps each upload in `uploads/` under its own
numbered name and lists them at `/uploads`. A still JPEG or PNG arrives as `photo.jxl`, `image/jxl`. With `?jxl=off`,
or for a file the plug-in keeps, the file arrives as picked. Its test sends a GIF and a broken JPEG for those.

The server must accept `image/jxl` files, store them under their `.jxl` name and serve them with that type. A thumbnail
made on the server needs a JPEG XL decoder there. FilePond's preview shows the picked file: the JPEG XL file is made when
the upload starts.

### Any other widget

```js
import {shrinker} from './rapier-jxl/shrink.mjs';

const {shrink} = shrinker();
const {file, code} = await shrink(picked); // file: the JPEG XL file, or the original when code says why
```

## What goes up

- A JPEG, PNG, WebP or HEIC still that rapier-jxl makes smaller goes up as `image/jxl`, named `.jxl`.
- Everything else goes up as it was picked: other types, GIFs and animated PNG or WebP, a file JPEG XL would not make
  smaller, and any file rapier-jxl refuses. The upload never fails because of rapier-jxl. `shrink` says why in `code`:

| Code | When |
| --- | --- |
| `JXL_INPUT` | The browser cannot decode the file: HEIC in Chrome. |
| `JXL_DIMENSIONS` | Over `maxPixels`. |
| `JXL_JPEG` | A damaged JPEG. |
| `animated`, `type`, `larger` | Kept by the plug-in itself. |

A Content Security Policy must allow `'wasm-unsafe-eval'`.

The photo is turned upright by its Exif orientation, as the browser shows it. Exif is dropped unless kept by the
option. Color profiles such as Display P3 are converted to sRGB.
