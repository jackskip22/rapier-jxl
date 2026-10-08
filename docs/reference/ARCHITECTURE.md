# Entry points and embedding

Choose an entry point. The core encodes pixels; effort adds compression search; wasm adds optional kernels to effort.
JPEG coefficient carrying, photographic pixel encoding, source-file parsing and Exif/XMP metadata are optional modules.

| Need | Entry point | Self-contained file |
| --- | --- | --- |
| RGBA, lossless or lossy | `rapier-jxl` or `rapier-jxl/core` | `dist/rapier-jxl.min.mjs` |
| Lossless compression search | `rapier-jxl/effort` | `dist/effort.min.mjs` |
| Same search with optional WASM | `rapier-jxl/wasm` | `dist/wasm.min.mjs` |
| Existing JPEGs, preserving coefficients | `rapier-jxl/jpeg` | `dist/jpeg.min.mjs` |
| Photographic RGBA | `rapier-jxl/photo` | `dist/photo.min.mjs` |
| JPEG with ANS search | `rapier-jxl/jpeg-ans` | `dist/jpeg-ans.min.mjs` |
| Photographic RGBA with ANS search | `rapier-jxl/photo-ans` | `dist/photo-ans.min.mjs` |
| Attach, replace or remove Exif/XMP | `rapier-jxl/metadata` | `dist/metadata.min.mjs` |

Append `/min` to an encoding or metadata entry point for its self-contained build through npm. `rapier-jxl/min` and
`rapier-jxl/core/min` both select the core. `rapier-jxl/source` reads PNG16 and supported OpenEXR into typed samples;
source, writer, and kernel-control entry points have no `/min` entry.

Every minified file includes its dependencies and MIT notice. It performs no network or filesystem I/O, needs no
initialization download, and includes no JPEG XL decoder. The wasm file also contains its kernels: automatic SIMD
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

Calls and generator steps are synchronous. Workers keep encoding off the page thread; leaving a job's iteration
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
| JPEG and photo | JPEG parsing or photographic DCT feeding shared coefficient and VarDCT writers. JPEG/photo ANS uses separate entry points. |
| Kernels | Optional integer operations behind the same JavaScript encoding interface. |

The core excludes the optional search, ANS, JPEG, photo, source-file parser, metadata and WASM modules. Native precision shares its
modular planner and writer. `rapier-jxl/writer` exposes typed format primitives in readable source; minified builds
rename internal format fields.

## Compression search

Only a smaller complete stream replaces the retained result; ties keep the earlier candidate. A completed result
survives a later candidate's size or allocation failure. Pruning stops a
candidate when its already-written sections reach the retained stream's length: remaining sections, headers and
the table of contents can only add bytes. Weighted search also uses exact Huffman data bounds. Pruning and hurry
are separate, so later candidates can still compete.

Ordinary 8-bit lossless efforts 4–9 add learned trees to the predictor, palette and screen candidates. The learner
uses deterministic spatial samples and integer costs. From effort 6, groups compare prefix and ANS coding, and each tree leaf can choose gradient, average,
or weighted prediction; neighbor differences, weighted errors and previous-channel residuals select contexts.
Groups are up to 1,024 pixels on a side. Increasing effort adds larger sample and leaf budgets while retaining all
lower-level candidates. [Effort levels](API.md#lossless-effort).

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
Input arrays remain caller-owned. Dimension limits are admission bounds, not a guarantee that every device can
allocate the largest image. [Precision, bounds and limits](API.md).

## Payload sizes

| File in `dist/` | Bytes | gzip | Brotli |
| --- | ---: | ---: | ---: |
| `rapier-jxl.min.mjs` | 27,557 | 11,642 | 10,376 |
| `effort.min.mjs` | 73,716 | 28,614 | 24,921 |
| `wasm.min.mjs` | 87,139 | 34,838 | 30,294 |
| `jpeg.min.mjs` | 33,297 | 13,851 | 12,250 |
| `photo.min.mjs` | 38,928 | 15,811 | 13,998 |
| `jpeg-ans.min.mjs` | 36,636 | 15,046 | 13,319 |
| `photo-ans.min.mjs` | 42,111 | 16,963 | 15,010 |
| `metadata.min.mjs` | 4,964 | 2,560 | 2,147 |
| All self-contained entry points in one bundle | 119,721 | 47,462 | 40,976 |
| All readable modules in `src/` | 324,498 | 98,010 | |

Release 3.0.0, Terser 5.51.2, Node v22.23.3, gzip 9 and Brotli 11. Exact byte counts, import graphs, hashes
and incremental sizes are in [dist/sizes.json](../../dist/sizes.json). Encoding builds are checked against their
readable entries on encoded-byte fixtures and native integer/float cases with HDR and alpha declarations. The metadata
build is checked against its readable entry for identical container bytes.
[Measured encoder comparisons](../ENCODER-COMPARISON.md).
