# Entry points and embedding

Choose an entry point. The core encodes pixels; effort adds compression search; wasm adds optional kernels to effort.
JPEG coefficient carrying, photographic pixel encoding, source-file parsing and Exif/XMP metadata are optional modules.

| Need | Entry point | Self-contained file |
| --- | --- | --- |
| Complete Rapier encoder and worker installer | `rapier-jxl/rapier` | `dist/rapier.min.mjs` |
| Still-picture worker (no animation) | `rapier-jxl/rapier/still-worker` | `dist/rapier-still-worker.js` |
| Complete self-starting worker (still + animation) | `rapier-jxl/rapier/worker` | `dist/rapier-worker.js` |
| RGBA, lossless or lossy | `rapier-jxl` or `rapier-jxl/core` | `dist/rapier-jxl.min.mjs` |
| Lossless compression search | `rapier-jxl/effort` | `dist/effort.min.mjs` |
| Same search with optional WASM | `rapier-jxl/wasm` | `dist/wasm.min.mjs` |
| Existing JPEGs, with original-byte reconstruction | `rapier-jxl/jpeg` | `dist/jpeg.min.mjs` |
| Photographic RGBA | `rapier-jxl/photo` | `dist/photo.min.mjs` |
| JPEG with ANS search | `rapier-jxl/jpeg-ans` | `dist/jpeg-ans.min.mjs` |
| Photographic RGBA with ANS search | `rapier-jxl/photo-ans` | `dist/photo-ans.min.mjs` |
| One call from a page to an `image/jxl` Blob | `rapier-jxl/image` | `dist/image.min.mjs` |
| Attach, replace or remove Exif/XMP | `rapier-jxl/metadata` | `dist/metadata.min.mjs` |
| Animated JPEG XL from whole-canvas frames | `rapier-jxl/animation` | `dist/animation.min.mjs` |

Append `/min` to an encoding or metadata entry point for its self-contained build through npm. `rapier-jxl/min` and
`rapier-jxl/core/min` both select the core. `rapier-jxl/source` reads PNG16 and supported OpenEXR into typed samples;
source, writer, and kernel-control entry points have no `/min` entry.

Every minified file includes its dependencies and MIT notice. It performs no network or filesystem I/O, needs no
initialization download, and includes no JPEG XL pixel decoder. JPEG entry points include a coefficient reader for
reconstructing JPEGs carried by this encoder. The wasm file also contains its kernels: automatic SIMD
when available, otherwise JavaScript with identical output bytes. Explicit scalar WASM is available through
`configureKernels('scalar')`.

For photographs, use `/jpeg` to carry coefficients from an existing JPEG, `/photo` for lossy RGBA encoding, or `/effort`
with `quality: 100` to preserve every pixel sample. `/source` reads supported PNG16/OpenEXR samples and their color
declarations. Attach caller-supplied Exif/XMP afterward with `/metadata`; it preserves image coding and does not
import ICC profiles or convert color. [Photography APIs](API.md#existing-jpegs) · [Metadata API](API.md#exif-and-xmp).

Agent skills: [Single-file apps](../../skills/rapier-jxl-single-file-app/SKILL.md) · [Photography](../../skills/rapier-jxl-photography/SKILL.md).

## One HTML file

Paste the complete selected module into the inert script below, keeping its exports and license. The Blob import
exposes public names such as `encode`, even though the minifier renames local functions. The complete HTML works
offline without a server, build tool or separate encoder file.

```html
<!doctype html>
<meta charset="utf-8">
<output id="result"></output>

<script type="text/plain" id="jxl-source">
/* Paste the complete dist/rapier-jxl.min.mjs here. */
</script>

<script type="module">
const source = document.getElementById('jxl-source').textContent;
const url = URL.createObjectURL(new Blob([source], {type: 'text/javascript'}));
const {encode} = await import(url);
URL.revokeObjectURL(url);

const rgba = new Uint8Array([255, 0, 0, 255]);
const bytes = encode(rgba, 1, 1, {quality: 100});
document.getElementById('result').textContent = `${bytes.length} JPEG XL bytes`;
</script>
```

No export removal or function renaming is needed. A page that sets a content security policy must permit its inline
script and Blob module. Displaying the encoded image requires JPEG XL browser support or a separate decoder.

## Separate module or worker

Copy one minified file beside a served page and import it directly:

```js
import {encode} from './rapier-jxl.min.mjs';
const bytes = encode(rgba, width, height);
```

Use HTTP for relative browser module imports; the embedded example above also works when opening a local HTML file.
Each encoder can run in a module worker. The [worker example](../../examples/worker.mjs) imports readable modules
from the package's `src/` directory; preserve those paths or adjust them when copying it.

Core calls and effort generator steps are synchronous. The complete Rapier factory returns promises. Workers keep encoding off the page thread; leaving a job's iteration
cancels it, while `job.hurry = true` requests a completed candidate. Transferring an input buffer detaches it from the
sender. [Jobs, inputs and cancellation](API.md#progress-and-cancellation).

## Shared code

Readable imports share common ES modules when bundled together. Separate minified files each include their own
copy. A minified wasm module owns its kernel controls: configure the same import that performs the encode.
Readable imports share `rapier-jxl/kernels`. Set controls before an encode. [Kernel controls](../KERNELS.md).

| Layer | Responsibility |
| --- | --- |
| Checked entry points and jobs | Typed input, options, limits, errors, progress and complete results. |
| Source reader | PNG16/OpenEXR sample words, channel layout and color/alpha declarations. |
| Metadata | Exif/XMP container boxes without changing the image codestream. |
| Format writer | Bits, prefix codes, frame headers and modular syntax. |
| Pixel core | Typed RGBA to lossless or lossy modular streams. |
| Lossless search | Weighted prediction, learned trees, local models, color transforms and screen matching. |
| JPEG and photo | JPEG parsing or photographic DCT feeding shared coefficient and VarDCT writers. Photo effort 5 adds ANS; separate ANS entry points start at effort 2. |
| Kernels | Optional integer operations and exact float64 SIMD DCT behind the same JavaScript encoding interface. |
| Worker scheduling | Lossless groups and candidates; photographic bands above 3 million pixels. Workers share no caller-owned mutable buffers. |

sRGB photographic pixels below quality 100 use the XYB color transform and the shared DCT8 writer when detail is
mostly in luminance. A bounded sample retains the existing color transform for strong color edges. XYB uses
64-pixel chroma-from-luma tiles. Other admitted color spaces keep their existing photographic transform; quality 100
uses exact modular coding. JPEG transcoding carries the original coefficients and does not use the photographic
color transform.

The photographic SIMD kernel batches up to 64 DCT blocks. It preserves the JavaScript operation order and every
float64 result bit before quantization; it uses no relaxed floating-point instructions. JavaScript remains the
fallback. The complete encoder selects optional kernels automatically; other entry points keep their existing
kernel controls. One optional edge-preserving filter improves the measured average XYB quality through quality 90;
`filter: 'off'` retains unfiltered output. This is separate from lossless coding and JPEG reconstruction.

The [complete-encoder benchmark protocol](../../bench/IDEAL.md) records source snapshots, real input provenance,
both perceptual metrics, independent decodes, actual helper use, and complete-API timing in Node and Chrome.
Choose effort by measured byte savings and time, and compare lossy settings at measured quality.

### Direction

Keep the small exact core and shared format writers. Search, photographic transforms, source parsing, metadata,
SIMD and worker scheduling remain optional layers. The complete encoder combines them with presets, progress and
cancellation; each preset supplies defaults that explicit options can override. The painting profile keeps its
separate exact save policy.

The next performance work is to measure each expensive lossless candidate's time and bytes won, then reduce repeated
work without changing retained results. Photographic workers currently distribute transform production; entropy
writing remains on the coordinator. Additional parallelism needs a measured gain after worker startup, messages,
copies and memory are included.

Preview-first output is the next format feature to investigate. A useful implementation must let independent
decoders display an early valid prefix and still meet the final quality or exactness contract. Numeric progress
callbacks do not provide that capability. Genuine streaming input separately needs row/tile admission, color and
sample declarations, backpressure, cancellation and bounded memory. Search that revisits pixels needs a replayable
source or an explicit storage policy. Neither streaming input nor progressive output is implemented yet.

Lossy Modular coding already exists. Further graphics work should improve measured quality around text, sharp edges
and transparency and choose photographic or graphics coding from evidence. Animation is an optional layer
(`rapier-jxl/animation`). Exact JPEG carrying remains separate from
future matched-quality JPEG recompression.

Reject changes that gain speed by altering exact coefficients, start helpers on every small image, or hide large
memory and search costs behind a preset. Retain JavaScript fallback, the photographic filter opt-out, per-image
regressions in benchmark reports, and independent decoding before accepting changed output bytes.

The core excludes the optional search, ANS, JPEG, photo, source-file parser, metadata and WASM modules. Native precision shares its
modular planner and writer. `rapier-jxl/writer` exposes typed format primitives in readable source; minified builds
rename internal format fields.

## Compression search

Only a smaller complete stream replaces the retained result; ties keep the earlier candidate. A completed result
survives a later candidate's size or allocation failure. Pruning stops a
candidate when its already-written sections reach the retained stream's length: remaining sections, headers and
the table of contents can only add bytes. Weighted search also uses exact Huffman data bounds. Pruning and hurry
are separate, so later candidates can still compete.

Ordinary 8-bit lossless efforts 5–9 add one learned tree per group to the predictor, palette and screen candidates.
The learner uses deterministic spatial samples and integer costs. Groups compare prefix and ANS coding, and each tree
leaf can choose gradient, average, or weighted prediction; neighbor differences, weighted errors and previous-channel
residuals select contexts. Groups are up to 1,024 pixels on a side. [Effort levels](API.md#lossless-effort).

From effort 6 the group model is learned under the reversible color transform that sampled gradient residuals rank
first: the 42 transforms share 15 distinct planes, each priced once with the search's integer entropy table. Efforts 7
and 8 add predictors, spatial coordinates, signed neighbor and previous-channel values and hybrid-integer training
costs; effort 9 also learns the model under the second-ranked transform. Histogram sharing keeps the learned predictors and tree
intact. Shared and separate histograms compete by complete prefix/ANS bytes. The fixed candidates remain eligible at
every level; the learned models use at most 65,536 training samples per group.

A group owns its model and token buffers. The selected model is written after sample-based decisions; full image
pixels do not enter the split search. Worker results are placed in group order, independent of completion order.
The explicit `treeLearning: 'sampled'` option selects the separate reduced search described in the API.

## Precision and memory

Typed input carries bit depth, float representation, primaries, transfer, peak luminance and alpha association.
Integer samples use unscaled code values; floats retain raw IEEE words. Encoding does not convert color, tone-map
or unpremultiply samples. Native lossy quantization occurs during group filling, before reversible prediction,
without allocating a second full quantized image. Integer RGB uses bin midpoints; floating-point RGB rounds mantissa
bits. Alpha remains exact. The 16-bit integer and floating-point formats use a container with a level 10 declaration;
integer formats up to 12 bits use a bare codestream.

Planes and token buffers belong to a group; learning uses bounded sample arrays. Larger groups, higher effort and
additional workers use more memory. A worker keeps typed copies of its tiles, preserving offsets and IEEE words.
The optional weighted-prediction WASM arena can retain about 17 MiB in each worker after a large group.
Input arrays remain caller-owned. Dimension limits are admission bounds, not a guarantee that every device can
allocate the largest image. [Precision, bounds and limits](API.md).

## Payload sizes

| File in `dist/` | Bytes | gzip | Brotli |
| --- | ---: | ---: | ---: |
| `rapier-still-worker.js` | 271,043 | 103,729 | 87,251 |
| `rapier-worker.js` | 477,295 | 175,226 | 143,039 |
| `rapier.min.mjs` | 477,636 | 175,292 | 143,131 |
| `rapier-jxl.min.mjs` | 63,250 | 25,527 | 22,596 |
| `effort.min.mjs` | 132,987 | 51,283 | 44,294 |
| `wasm.min.mjs` | 155,982 | 61,007 | 52,455 |
| `jpeg.min.mjs` | 78,052 | 30,781 | 26,815 |
| `photo.min.mjs` | 65,453 | 26,043 | 22,957 |
| `jpeg-ans.min.mjs` | 83,763 | 32,470 | 28,391 |
| `photo-ans.min.mjs` | 65,437 | 26,033 | 22,916 |
| `metadata.min.mjs` | 30,550 | 12,293 | 10,780 |
| `animation.min.mjs` | 155,894 | 59,625 | 51,436 |
| All self-contained entry points in one bundle | 485,506 | 176,801 | 144,172 |
| All readable modules in `src/` | 878,580 | 231,762 | |

Release 5.3.0, Terser 5.51.2, Node v22.23.3, gzip 9 and Brotli 11. Exact byte counts, import graphs, hashes
and incremental sizes are in [dist/sizes.json](../../dist/sizes.json). Encoding builds are checked against their
readable entries on encoded-byte fixtures and native integer/float cases with HDR and alpha declarations. The metadata
build is checked against its readable entry for identical container bytes.
[Measured encoder comparisons](../ENCODER-COMPARISON.md).

## Complete Rapier worker

`dist/rapier-still-worker.js` is the self-starting still-picture worker embedded by Rapier's page.
`dist/rapier-worker.js` is the complete worker: the same modules plus animation, downloaded by Rapier's JPEG XL
converter for animations and video. The package and app use one builder and the same MIT modules. Each worker's exact bytes, gzip size, source version and module graph are recorded in
[dist/sizes.json](../../dist/sizes.json); the app records the same worker SHA-256 in its build receipt.

Copy the file beside a served page and use `new Worker('./rapier-still-worker.js')` (or `rapier-worker.js`). For one offline HTML file:

```html
<script type="text/plain" id="rapier-jxl-worker">
/* Paste the complete dist/rapier-still-worker.js here, including its MIT notice. */
</script>
<script type="module">
const url = URL.createObjectURL(new Blob([
  document.getElementById('rapier-jxl-worker').textContent
], {type: 'text/javascript'}));
const worker = new Worker(url);
worker.onmessage = ({data}) => console.log(data);
worker.postMessage({id: 1, operation: 'encode', width: 1, height: 1,
  data: new Uint8Array([255, 0, 0, 255]), options: {lossless: true}});
// Keep the URL available while the worker can create helpers.
// After the final response: worker.terminate(); URL.revokeObjectURL(url);
</script>
```

To add your own module-worker behavior, import the complete module in that worker:

```js
import {installWorker} from 'rapier-jxl/rapier/min';
installWorker({spawn: () => new Worker(import.meta.url, {type: 'module'})});
```

Every helper must run the same worker bootstrap and build as its coordinator. Readable and independently minified
builds do not share a pool protocol. The published classic worker handles this itself.
[Requests, defaults, input custody and errors](API.md#complete-rapier-system).
