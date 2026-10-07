# Imports and inlining

Choose one encoding import for the input and search required. `rapier-jxl` is the core; `/core` names it explicitly.
Effort and wasm contain the core's capabilities. JPEG coefficient carrying and photographic pixel encoding remain
separate imports. ANS is optional within those two paths.

Native precision shares the core's modular coding. File parsing is the optional `rapier-jxl/source` import;
applications already holding typed samples do not import PNG or OpenEXR parsing.

| Need | Readable import | One self-contained file |
| --- | --- | --- |
| RGBA, lossless or lossy | `rapier-jxl/core` | `dist/rapier-jxl.min.mjs` |
| Smaller exact streams through search | `rapier-jxl/effort` | `dist/effort.min.mjs` |
| Effort with integer WebAssembly kernels | `rapier-jxl/wasm` | `dist/wasm.min.mjs` |
| Existing JPEG coefficients | `rapier-jxl/jpeg` | `dist/jpeg.min.mjs` |
| Photographic RGBA | `rapier-jxl/photo` | `dist/photo.min.mjs` |
| JPEG with ANS search | `rapier-jxl/jpeg-ans` | `dist/jpeg-ans.min.mjs` |
| Photographic RGBA with ANS search | `rapier-jxl/photo-ans` | `dist/photo-ans.min.mjs` |

Append `/min` to any import in the table for its one-file build through npm. `rapier-jxl/min` also selects the core.
For a page without a build step, copy the selected file beside the app and import its exports:

```js
import {encode} from './rapier-jxl.min.mjs';
const bytes = encode(rgba, width, height);
```

Each minified file contains its dependencies and MIT notice. No runtime fetch, decoder, external WASM file or
initialisation download is needed. The wasm file contains its kernels and automatically uses JavaScript when
WebAssembly or SIMD is unavailable.

For an app contained in one HTML file, embed the selected module's source as text and import a Blob URL:

```js
const url = URL.createObjectURL(new Blob([encoderSource], {type: 'text/javascript'}));
const {encode} = await import(url);
URL.revokeObjectURL(url);
```

`encoderSource` is the complete selected minified file, including its exports and licence notice. The page's content
security policy must allow that module URL. The same module can run in a module worker; scheduling, cancellation and
input transfers belong to the app. [Worker example](../../examples/worker.mjs) and [job contract](API.md#progress-and-cancellation).

## Shared source

Use readable imports when bundling several capabilities: their ES module graph shares common code once. Separate
minified files are self-contained and repeat shared code. A wasm bundle's kernel controls affect its own encoder;
configure that same import. Readable imports share the controls in `rapier-jxl/kernels`. Set controls before an encode.

| Boundary | Modules and responsibility |
| --- | --- |
| Checked entry and jobs | `admit.mjs`, `index.mjs`, `effort-job.mjs`, `jpeg-job.mjs`, `photo-job.mjs`: inputs, limits, errors, progress and complete results. |
| Source files | `source.mjs`: exact PNG16/OpenEXR words, channel layout, colour declarations and alpha association. No compression-quality policy. |
| Shared format | `bits.mjs`, `prefix.mjs`, `frame.mjs`, `modular.mjs`: bit writing, entropy codes, headers and modular syntax. |
| Pixel core | `lossless.mjs`, `lossy.mjs`, `squeeze.mjs`: typed RGBA to modular codestreams. Native samples share the group planner, entropy writer and worker setup; source quantisation precedes reversible prediction. |
| Lossless search | Weighted, local, sampled, colour-transform and screen modules, reached through `effort.mjs`. The core does not import them. |
| JPEG and photo | JPEG parsing and photographic DCT feed shared coefficient and VarDCT writers. ANS has separate entries. |
| Acceleration | `kernel-hooks.mjs` isolates optional integer kernels; `wasm.mjs` configures them and uses the effort encoder. |

Keep these optional paths out of the core import graph. Share admission, format writing and coefficient handling
through their existing modules. Add codec-level extensions through the typed `rapier-jxl/writer` surface; use readable
modules because minified builds rename internal format fields. [API](API.md), [kernels](../KERNELS.md), [screen coding](../SCREENSHOTS.md).

## Complete candidates and exact pruning

Search retains only complete streams. Once a stream is kept, only a smaller complete candidate replaces it. Neither
a time estimate nor a partial stream decides which image bytes are kept. `hurry` finishes with a completed
representation; a candidate that exceeds a size or allocation limit leaves any retained stream available. Native
lossy search tries exact candidates first and can still complete a quantised candidate if no exact candidate fits.

Local modelling stops when the sum of already-written section lengths reaches the best complete stream's length.
Remaining sections, headers and the table of contents can only add bytes, so this lower bound cannot discard a
winner. The worker pool counts each accepted group once, independent of completion order. Candidate pruning has a
separate result from hurry: rejecting a local model does not cancel a later colour-transform candidate.

Context classification follows emitted tokens. A long zero-residual copy needs a context for its literal and its
length token; pixels skipped by that copy need no classification array. Palette inspection is shared within a
screen search, and prediction requested as raw residuals omits unused weighted-context lookup. These reductions
preserve the stream's tokens, candidate order, tie policy and final bytes.

## Precision and memory

The admitted source description owns bit depth, float representation, primaries, transfer, peak luminance and alpha
association. It travels with worker tasks. Byte inputs keep their existing typed planes and kernels; native direct
planes use signed 32-bit words. Palette indices remain small integer planes, while their colour table holds native
words. Floating samples use raw IEEE representations, with modular residual arithmetic wrapping at 32 bits.

Native planning counts hybrid tokens in bounded histograms instead of allocating a histogram indexed by every
possible 32-bit value. Pixel planes belong to one group; source-domain quantisation runs during plane filling and
does not allocate a second full quantised image. A worker owns a typed copy of its tiles, preserving offsets and IEEE
words. Input arrays remain caller-owned. Wide inputs and additional workers increase input/tile memory; dimension
limits are admission bounds, not a promise that every device can allocate the largest picture.

## Payload sizes

| File in `dist/` | Bytes | gzip | Brotli |
| --- | ---: | ---: | ---: |
| `rapier-jxl.min.mjs` | 26,997 | 11,408 | 10,145 |
| `effort.min.mjs` | 64,473 | 25,440 | 22,118 |
| `wasm.min.mjs` | 74,463 | 30,127 | 26,099 |
| `jpeg.min.mjs` | 33,019 | 13,762 | 12,167 |
| `photo.min.mjs` | 38,361 | 15,573 | 13,801 |
| `jpeg-ans.min.mjs` | 36,157 | 14,872 | 13,151 |
| `photo-ans.min.mjs` | 41,341 | 16,638 | 14,713 |
| Every encoding path in one bundle | 105,348 | 41,957 | 36,245 |
| All readable modules in `src/` | 305,654 | 93,276 | |

Release 2.6.0, Terser 5.51.2, Node v22.22.2, gzip 9 and Brotli 11. Byte counts, module graphs, hashes and
incremental bundle sizes are in [dist/sizes.json](../../dist/sizes.json). Each one-file build is checked against its readable
entry on the public encoded-byte fixtures and native integer/float cases with HDR and alpha declarations.
[Other encoders](../ENCODER-COMPARISON.md).
