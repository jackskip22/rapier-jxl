# Rapier JXL

JPEG XL encoder for single-file HTML apps and photography tools. Pure JavaScript, offline in browsers, Node and
Deno. Lossless, lossy, native precision, HDR, exact alpha and JPEG transcoding. [MIT license](LICENSE), no runtime
dependencies. Use it in an app or an agent's image workflow.

The complete worker used by [Rapier](https://rapier.website) is **58,698 gzip bytes**, with optional
WebAssembly and parallel workers. The separate core is **11,674 gzip bytes**. Both fit in one HTML file.

```sh
npm install rapier-jxl
```

## Choose a Rapier workflow

Rapier is a phone-first Markdown editor for notes, diagrams, drawing and watercolor painting. It runs offline
as one HTML file on Android, Web and Windows.

1. **Work together live.** Connect to `https://mcp.rapier.website/mcp`, then call `rapier.open` to share one document with the person.
2. **Deliver an offline editor.** Run `npx rapier-html notes.md` to put the document and editor in one HTML file ([rapier-html](https://github.com/jackskip22/rapier-plugins/tree/main/npm/rapier-html)).
3. **Embed in your app.** Install [rapier-embed](https://github.com/jackskip22/rapier-plugins/tree/main/npm/rapier-embed); mount the editor or reader, with your app's agent over WebMCP in the editor.
4. **Keep portable Markdown.** Use [rapier-markdown-kit](https://github.com/jackskip22/rapier-plugins/tree/main/npm/rapier-markdown-kit) for pictures, editable SVG drawings and layout in one `.md` file. Respect [Will/1](https://github.com/jackskip22/will) `keep`, `append` and `edit` regions.
5. **Encode JPEG XL.** Install [rapier-jxl](https://github.com/jackskip22/rapier-jxl) to encode pixels, photographs and existing JPEGs in JavaScript.
6. **Host the door.** Run [rapier-server](https://github.com/jackskip22/rapier/tree/main/server) over your own folder or S3-compatible bucket.

## Builds

| Build / import | Gzip bytes | Capabilities |
| --- | ---: | --- |
| **Rapier worker** · `rapier-jxl/rapier/worker` | 58,698 | Core + effort 1–9, optional WASM, Photo, JPEG transcoding and parallel lossless groups. |
| Rapier module · `rapier-jxl/rapier/min` | 58,751 | The same system with an encoder factory and worker installer. |
| Core · `rapier-jxl/min` | 11,674 | Lossless or lossy typed RGBA, native precision, HDR and exact alpha. |
| Effort · `rapier-jxl/effort/min` | 35,515 | Core with lossless compression search, efforts 1–9. |
| WASM · `rapier-jxl/wasm/min` | 43,885 | Effort with inlined WASM and JavaScript fallback. |
| Photo · `rapier-jxl/photo/min` | 15,926 | Lossy photographs from RGBA pixels. |
| JPEG · `rapier-jxl/jpeg/min` | 14,702 | Existing JPEGs, preserving admitted coefficients and orientation. |
| Metadata · `rapier-jxl/metadata/min` | 2,560 | Attach, replace or remove caller-supplied Exif/XMP. |

Each size measures a complete standalone file at gzip level 9. Readable imports such as `rapier-jxl/rapier` share
dependencies when bundled together; separate minified files each include theirs. Optional JPEG and Photo ANS builds,
combined sizes and file hashes are listed in [Entry points and embedding](docs/reference/ARCHITECTURE.md).

**Used by Rapier:** the app embeds the exact published Rapier worker bytes. Pixel encoding defaults to effort 7 and
quality 90; `lossless: true` selects quality 100. JPEG transcoding uses effort 7. WASM falls back to JavaScript;
larger lossless images use available helper workers. [Complete API](docs/reference/API.md#complete-rapier-system).

## Complete worker versus libjxl

Lossless RGBA8, including hidden RGB, through the **complete published Rapier worker**, compared with native **libjxl 0.11.2**. Effort numbers are each encoder's search budgets. Bpp means bits per pixel. Rapier ms is one call per configuration without warmup; libjxl ms is the median of three calls after one warmup.

| Input | Effort | Rapier bytes / bpp / ms (single) | libjxl bytes / bpp / ms (median) |
| --- | ---: | ---: | ---: |
| Light UI | 3 | 13,852 / 0.361 / 286.4 | 34,595 / 0.901 / 41.6 |
| Light UI | 9 | 11,515 / 0.300 / 13937.6 | 12,687 / 0.330 / 406.9 |
| Labelled drawing | 3 | 3,554 / 0.145 / 98.9 | 8,324 / 0.339 / 21.8 |
| Labelled drawing | 9 | 1,644 / 0.067 / 7716.8 | 2,208 / 0.090 / 188.2 |
| Painting | 3 | 150,434 / 6.121 / 135.4 | 140,851 / 5.731 / 44.1 |
| Painting | 9 | 119,700 / 4.871 / 28956.9 | 121,901 / 4.960 / 1320.4 |
| Photograph | 3 | 290,619 / 7.568 / 159.1 | 274,218 / 7.141 / 62.8 |
| Photograph | 9 | 258,681 / 6.736 / 32734.2 | 254,579 / 6.630 / 2132.3 |
| Terminal | 3 | 9,799 / 0.399 / 148.7 | 40,983 / 1.668 / 28.2 |
| Terminal | 9 | 7,814 / 0.318 / 13108.0 | 11,729 / 0.477 / 246.3 |

Node 22.23.3 on Linux x64, AMD EPYC 9V74, CPU 0. One encoding thread per implementation. Rapier reports one call per configuration without warmup; libjxl reports the median of three calls after one warmup. Rapier uses automatic WASM; libjxl is native C++. The two implementations were measured separately on the same idle host. Timing includes each encode and output, excluding input transport/loading and decoding. Worker startup was 38.3 ms, measured separately. Every result preserves exact source RGBA; Rapier outputs also pass two independent decoders.

At effort 9, Rapier produces smaller files on these three document images and the painting; libjxl produces the smaller photograph. Native libjxl is faster in every measured row. Rapier's extra effort-9 search trades encoding time for smaller files and retains every earlier candidate. These desktop measurements do not predict browser or phone performance.

[All four efforts, individual samples and reproduction](docs/ENCODER-COMPARISON.md#complete-worker-versus-libjxl).

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

Each level retains the earlier candidates. Extra search costs depend on the picture; no level has a deadline.

| Effort | What it adds and costs |
| ---: | --- |
| 1 | Channel prediction and zero runs; shortest search. |
| 2 | Weighted prediction; another prediction family. |
| 3 | Error contexts, screen palettes and repeated regions; additional image passes. |
| 4 | Color transforms and local palettes; several candidates. |
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
