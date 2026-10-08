# Rapier JXL

A JavaScript JPEG XL encoder for single-file HTML apps and photography tools. Works offline with no runtime dependencies. [MIT license](LICENSE).
The core is 27,557 bytes minified, 11,642 bytes gzipped.

```sh
npm install rapier-jxl
```

```js
import {encode} from 'rapier-jxl/min';

const rgba = new Uint8Array([255, 0, 0, 255]);
const bytes = encode(rgba, 1, 1, {quality: 100});
const file = new Blob([bytes], {type: 'image/jxl'});
```

For one offline HTML file, embed the complete `node_modules/rapier-jxl/dist/rapier-jxl.min.mjs` module and import it
from a Blob URL. [Copy the HTML example](docs/reference/ARCHITECTURE.md#one-html-file), keeping the module's exports and license.

`rgba` contains four samples per pixel. Quality 100 is lossless, including RGB under transparent pixels; 1–99 is lossy. Alpha stays exact.

- **Shared modules:** use `rapier-jxl` when bundling several entry points so they share code.
- **Lossless photos and artwork:** `rapier-jxl/effort`, `{quality: 100, effort: 6}`; levels 1–9, default 1. Optional inlined WASM: `rapier-jxl/wasm`, with JavaScript fallback.
- **Lossy photographs:** `rapier-jxl/photo` encodes RGBA pixels with `encodePhoto`.
- **Existing JPEGs:** `rapier-jxl/jpeg` carries admitted JPEG coefficients with `transcode`.
- **Native precision:** 8/10/12/16-bit integers, binary16/32 floats, PQ/HLG and Rec. 2020. PNG16/OpenEXR input: `rapier-jxl/source`.
- **Exif and XMP:** `rapier-jxl/metadata` or `/metadata/min` attaches caller-supplied metadata without changing image samples. [Metadata API](docs/reference/API.md#exif-and-xmp).

Runs in browsers, workers, Node, and Deno. Encoding needs no decoder; displaying the result requires JPEG XL support.

Agent skills: [Single-file apps](skills/rapier-jxl-single-file-app/SKILL.md) · [Photography](skills/rapier-jxl-photography/SKILL.md).

[API](docs/reference/API.md) · [Entry points and embedding](docs/reference/ARCHITECTURE.md) · [Agent reference](llms.txt) ·
[Comparisons](docs/ENCODER-COMPARISON.md) · [Browser example](examples/browser.html)
