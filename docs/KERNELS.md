# Optional integer kernels

`rapier-jxl/wasm` is the `effort` entry point with WebAssembly kernels under the lossless hot loops. It has the same API and
writes the same bytes. Automatic mode uses SIMD and falls back to JavaScript if WebAssembly or SIMD is absent or blocked. Scalar WebAssembly is an explicit mode. The
core and `effort` do not initialize WebAssembly. `dist/wasm.min.mjs` is the same entry point as one self-contained file. Both entry modules
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
bulk bit writer, exact screen-row matching and sampled-tree count-and-sweep split search. `kernels/kernels-simd.wat` implements four-pixel average and gradient
prediction, RGBA-to-planar conversion, four-value screen-match comparisons and independent low/high split-price lanes; rows and odd tails take a scalar path.
Weighted prediction stays scalar because its west-error state is
sequential. Sampled split prices use f64 for exact integers below 2^37; their lookup table reaches 2^32. All other kernels use bounded integer arithmetic. There is no rounded price arithmetic, relaxed SIMD, import other than
private memory, shared memory, threads or network access.

The private arena is allocated at the first enable: 3 MiB per realm, growing on demand to at most 17 MiB for screen groups.
Sampled search admits nodes of at most 65,536 of up to 1,048,576 samples, 16 predictors and 256 symbols; it reuses the arena per node and keeps strict predictor and cut ties.
It remains available for later encodes in that realm and is reused synchronously across candidates; no views escape and
no full-image cache is retained. Ordinary channel and weighted kernels admit groups of at most 65,536 samples with Int16
planes, unit multipliers and bounded offsets.
The screen kernel admits Int16 planes of up to 1,048,576 samples with edges at most 16,384, retaining the whole format
group's residual history, exact row hints and nearest-distance ties. Its input region becomes chain storage after
prediction. Native Int32 planes, unsupported operations, custom writers and big-endian hosts keep the JavaScript path;
screen arena allocation failure also returns to JavaScript. Input and output limits are unchanged. SIMD support is
detected by validating
`kernels/kernels-probe.wat`; failure never disables the encoder.

## Resident lossless groups

The direct RGBA8 core keeps each 256 × 256 or smaller group's planes in the arena through raw counting or selected-code
writing. `planGroup` uses the same operation in the coordinator, helpers and local fallback. Predictor sampling and the
two complete image passes remain unchanged. Unsupported palette, native-sample and alternate-transform plans keep the original
fallback closure and its fill-before-write order. Eligible direct plans create that closure only after an absent or refusing
hook; any private rejected section is discarded before the original fallback starts. Count and write own separate closures.
The operation requires both the `fill` and `channel` parts; disabling either keeps that part's existing JavaScript route.

The group supports the core's YCoCg, gray and alpha channels, predictors 0–5, unit multipliers and the existing bounded
integer configurations. Palette and explicit alternate-transform plans, native samples, custom writers, overlapping
histogram windows and other unsupported setups keep the existing route. Refusal precedes changes to histograms or writer
bits. Counting stages all histograms and commits after the last channel; a writer allocation error restores its incoming
bit position and accumulator and retains the original error.

Every range below is a byte offset with an exclusive end, for a maximum-sized group:

| Live storage | Range |
| --- | --- |
| First plane | 65,536–327,680 |
| Residual scratch | 327,680–589,824 |
| Second plane | 589,824–851,968 |
| Third plane | 851,968–1,114,112 |
| Token accumulator and output | 1,114,120–1,642,496 |
| Raw histogram staging, at most four 4,129-bin rows | 1,642,496–1,708,560 |
| Selected-code table, reusing the histogram region | 1,642,496–1,644,552 |
| RGBA source rows | 1,769,472–2,031,616 |
| Fourth plane, borrowing weighted state | 2,097,152–2,359,296 |

Each channel writes only the separate residual scratch and token regions. Later planes remain intact, and channel order
does not change. No callback or yield occurs while group planes are live. Weighted, screen and sampled work can reuse or
grow the arena between group calls; the next call takes current views and fills fresh planes. No arena view or prepared
group escapes. The initial 3 MiB and maximum 17 MiB arena, WAT modules and public APIs are unchanged.

## Rebuild

`src/kernels-bytes.mjs` holds the generated base64 modules; edit the `.wat` files, never that file. Install
**wabt 1.0.39** as a build tool (`WABT_MODULE` may point to its `index.js`), then:

```sh
npm run build:kernels            # regenerate src/kernels-bytes.mjs
npm run build:kernels -- --check # fail if it differs from the sources
```
