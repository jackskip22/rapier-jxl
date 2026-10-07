# Rapier JXL

JPEG XL encoder for 8-bit RGBA pixels and JPEG coefficients. JavaScript, optional inlined WebAssembly,
no runtime dependencies. [MIT](LICENSE).

```sh
npm install rapier-jxl
```

```js
import {encode} from 'rapier-jxl';

const {data, width, height} = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
const bytes = encode(data, width, height, {quality: 100});
const jxl = new Blob([bytes], {type: 'image/jxl'}); // save as image.jxl
```

`quality: 100` (default) is lossless; `1–99` is lossy. Alpha stays exact.
For smaller lossless files, import `encode` from `rapier-jxl/effort` and set `effort: 1–9` (default `1`).
`rapier-jxl/wasm` runs that search with optional integer kernels and identical output bytes.

| Encoder payload | Minified JS + WASM bytes | gzip bytes |
| --- | ---: | ---: |
| Rapier JXL core | 21,326 | 9,271 |
| libjxl via `jxl-wasm` 0.7.0 | 2,533,758 | 961,538 |
| `@jsquash/jxl` 1.3.0 | 1,388,572 | 525,782 |
| `@squoosh-kit/jxl` 0.2.10 | 1,371,789 | 511,927 |

Executable payloads, gzip 9; external packages measured 2026-09-30. These are encoder download sizes.
[All comparisons, capabilities and measurement method](docs/ENCODER-COMPARISON.md).

[API, options and errors](docs/reference/API.md) · [Imports, sizes and inlining](docs/reference/ARCHITECTURE.md) ·
[Machine-readable facts](llms.txt) · [Browser example](examples/browser.html) ·
[Worker example](examples/worker.mjs) · [Contributing](.github/CONTRIBUTING.md)
