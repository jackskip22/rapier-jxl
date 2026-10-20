# Rapier JXL

Tiny JPEG XL encoder, great for single-file HTML apps and photography tools. Pure JavaScript, offline in browsers, Node and
Deno. Lossless, lossy, native precision, HDR, exact alpha and JPEG transcoding. [MIT license](LICENSE), no runtime
dependencies. Use it in an app or an agent's image workflow.

The complete worker for [Rapier](https://rapier.website) is **73,183 gzip bytes**, with optional
WebAssembly and parallel workers. The separate core is **11,945 gzip bytes**.

```sh
npm install rapier-jxl
```

## Builds

| Build / import | Gzip bytes | Capabilities |
| --- | ---: | --- |
| **Rapier worker** · `rapier-jxl/rapier/worker` | 73,183 | Core + effort 1–9, optional WASM, Photo, JPEG transcoding and parallel lossless groups. |
| Rapier module · `rapier-jxl/rapier/min` | 73,238 | The same system with an encoder factory and worker installer. |
| Core · `rapier-jxl/min` | 11,945 | Lossless or lossy typed RGBA, native precision, HDR and exact alpha. |
| Effort · `rapier-jxl/effort/min` | 37,304 | Core with lossless compression search, efforts 1–9. |
| WASM · `rapier-jxl/wasm/min` | 46,431 | Effort with inlined WASM and JavaScript fallback. |
| Photo · `rapier-jxl/photo/min` | 19,493 | Lossy photographs from RGBA pixels. |
| JPEG · `rapier-jxl/jpeg/min` | 25,706 | Existing JPEGs, preserving admitted coefficients and orientation. |
| Metadata · `rapier-jxl/metadata/min` | 2,573 | Attach, replace or remove caller-supplied Exif/XMP. |

Each size measures a complete standalone file at gzip level 9. Readable imports such as `rapier-jxl/rapier` share
dependencies when bundled together; separate minified files each include theirs. Optional JPEG and Photo ANS builds,
combined sizes and file hashes are listed in [Entry points and embedding](docs/reference/ARCHITECTURE.md).

**Used by Rapier:** each app release embeds its own worker build; standalone package versions can differ.
Pixel encoding defaults to effort 7 and
quality 90; `lossless: true` selects quality 100. JPEG transcoding takes effort 1 to 9, 7 by default. WASM falls back to JavaScript;
larger lossless images use available helper workers. Painting saves add `losslessProfile: 'painting'` for core
lossless coding without the effort ladder, with helper workers from four groups. [Complete API](docs/reference/API.md#complete-rapier-system).

## Compression measurements

On a 71-image lossless corpus, effort 8 used **2.083% fewer bytes** than effort 7 at **4.247×** its summed observed handler time; effort 9 used **2.395% fewer bytes** at **9.546×**. These are single observations on one host, not phone timings. [Times, protocol and per-image/group results](docs/ENCODER-COMPARISON.md#lossless-effort-cost).

The [five-image comparison with libjxl](docs/ENCODER-COMPARISON.md#complete-worker-versus-libjxl) records Rapier 3.1.0 on 2026-10-08. Its bytes and times apply to that frozen worker, not the current search.

## Use the complete worker

Copy `node_modules/rapier-jxl/dist/rapier-worker.js` beside your page:

```js
const worker = new Worker('./rapier-worker.js');
worker.onmessage = ({data}) => {
  if (data.ok) console.log(new Blob([data.bytes], {type: 'image/jxl'}));
  else console.error(data.error.message);
};
worker.postMessage({
  id: 1, operation: 'encode', width: 1, height: 1,
  data: new Uint8Array([255, 0, 0, 255]), options: {lossless: true}
});
```

For one offline HTML file, embed that complete worker as text and create it through a Blob URL.
[Copyable worker and module examples](docs/reference/ARCHITECTURE.md#complete-rapier-worker).
Keep the MIT notice. No network download or decoder is needed for encoding.

The core and effort modules expose `encode(rgba, width, height, options)`. Quality 100 preserves every sample,
including RGB under transparent pixels; 1–99 is lossy. Alpha stays exact. Core/effort default to quality 100,
and the separate effort entry defaults to effort 1. [API and options](docs/reference/API.md).

### Lossless efforts

For painting saves, use `{quality: 100, losslessProfile: 'painting'}` with the effort or wasm entry point,
or `{lossless: true, losslessProfile: 'painting'}` with the complete encoder. This separate RGBA8 profile keeps
every pixel exact and may produce larger files. Omit it to use the effort search below.

Each level retains the earlier candidates, except that 3 replaces 2's weighted search. Extra search costs depend on the picture; no level has a deadline.

| Effort | What it adds and costs |
| ---: | --- |
| 1 | Channel prediction and zero runs; shortest search. |
| 2 | Weighted prediction; another prediction family. |
| 3 | A small learned tree per group with ANS coding; for a screen, error contexts, palettes and repeated regions instead; additional image passes. |
| 4 | Error contexts, color transforms and local palettes; several candidates. |
| 5 | Learned group trees and entropy-model selection; tree-learning work. |
| 6 | The first-ranked color transform; another learned candidate. |
| 7 | Broader predictor and context search; the complete worker default. |
| 8 | Denser samples, wider trees and local screen transforms; more learned candidates. |
| 9 | Another color transform and deeper trees; the longest search. |

JPEG entry points also add order and entropy-model combinations at efforts 8 and 9, retaining the smaller complete
stream without changing pixels. The complete worker's JPEG route remains at effort 7. [Effort details](docs/reference/API.md#lossless-effort).

Native inputs include 8/10/12/16-bit integers, binary16/32 floats, PQ/HLG and Rec. 2020. `rapier-jxl/source` reads
supported PNG16/OpenEXR files. Displaying encoded output requires JPEG XL support.

Agent skills: [Single-file apps](skills/rapier-jxl-single-file-app/SKILL.md) · [Photography](skills/rapier-jxl-photography/SKILL.md).

[API](docs/reference/API.md) · [Entry points and embedding](docs/reference/ARCHITECTURE.md) · [Agent reference](llms.txt) ·
[Comparisons](docs/ENCODER-COMPARISON.md) · [Browser example](examples/browser.html)
