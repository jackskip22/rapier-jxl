# Optional integer kernels

`rapier-jxl/wasm` is the `effort` entry point with WebAssembly kernels under the lossless hot loops. It has the same API and
writes the same bytes. It tries SIMD, and falls back to JavaScript if WebAssembly or SIMD is absent or blocked. The
core and `effort` do not initialise WebAssembly. `dist/wasm.min.mjs` is the same entry point as one self-contained file. Both entry modules
are marked side-effectful in `package.json`, so bundlers keep their automatic backend configuration.

Readable modules share controls through `rapier-jxl/kernels`:

```js
import {encode, configureKernels, kernelMode} from 'rapier-jxl/wasm';
configureKernels('auto'); // 'off', 'scalar' or 'simd' are explicit alternatives
const bytes = encode(rgba, width, height, {effort: 3, quality: 100});
console.log(kernelMode()); // the backend actually running, not the one requested
```

Configure once before an encode, not inside a progress callback. Readable modules share controls within a JavaScript
realm; workers and separately bundled modules have independent arenas and hooks. Configure a minified encoder through
that same import. A
second argument selects kernels for benchmarks, for example `{channel: true, weighted: false, fill: false}`; it moves
where arithmetic runs, never its result.

## What is in them

`kernels/kernels-scalar.wat` implements prediction, weighted prediction and property extraction, token histograms, a
bulk bit writer and exact screen-row matching. `kernels/kernels-simd.wat` implements four-pixel average and gradient
prediction, RGBA-to-planar conversion and four-value screen-match comparisons; rows and odd tails take a scalar path.
Weighted prediction stays scalar because its west-error state is
sequential. Both use bounded integer arithmetic. There is no floating-point WebAssembly, relaxed SIMD, import other than
private memory, shared memory, threads or network access.

The private arena is allocated at the first enable: 3 MiB per realm, growing on demand to at most 17 MiB for screen groups.
It remains available for later encodes in that realm and is reused synchronously across candidates; no views escape and
no full-image cache is retained. Ordinary channel and weighted kernels admit groups of at most 65,536 samples with Int16
planes, unit multipliers and bounded offsets.
The screen kernel admits Int16 planes of up to 1,048,576 samples with edges at most 16,384, retaining the whole format
group's residual history, exact row hints and nearest-distance ties. Its input region becomes chain storage after
prediction. Native Int32 planes, unsupported operations, custom writers and big-endian hosts keep the JavaScript path;
screen arena allocation failure also returns to JavaScript. Input and output limits are unchanged. SIMD support is
detected by validating
`kernels/kernels-probe.wat`; failure never disables the encoder.

## Rebuild

`src/kernels-bytes.mjs` holds the generated base64 modules; edit the `.wat` files, never that file. Install
**wabt 1.0.39** as a build tool (`WABT_MODULE` may point to its `index.js`), then:

```sh
npm run build:kernels            # regenerate src/kernels-bytes.mjs
npm run build:kernels -- --check # fail if it differs from the sources
```
