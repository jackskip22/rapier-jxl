# Rapier JXL

JPEG XL encoder in pure JavaScript, for single-file HTML apps, photography tools and agent image workflows. Offline in
browsers, Node and Deno. [MIT license](LICENSE), no runtime dependencies.

- **Still encoder: 102,931 gzip bytes.** This is what [Rapier](https://rapier.website) itself carries:
  lossless and lossy pictures, photographs, JPEG carrying and exact restore, native precision, HDR and exact alpha.
- **Complete encoder: 174,450 gzip bytes.** The still encoder plus animated JPEG XL and the other format writers.
- **Core: 24,831 gzip bytes.** Lossless or lossy RGBA and nothing else.

```sh
npm install rapier-jxl
```

**New in 5.2.0.** A picture with its own matrix/TRC color profile (Display P3, Adobe RGB, ProPhoto, Rec. 2020, gray) is coded lossy through that profile's primaries and curves and keeps the profile; lossless is the same samples in a smaller file.

**New in 5.1.0.**
- No 16 MiB output limit: pictures, animations, JPEG carrying and metadata use available memory. Byte budgets you
  pass still apply.
- A carried RGB JPEG now restores byte for byte through libjxl's `djxl` as well as through this package.
- `rapier-jxl/graphics`: screenshots and flat art within an error you set. `rapier-jxl/animation-atlas`: repeated
  glyphs and tiles stored once across an animation's frames.
- More of the format: progressive Modular, Squeeze, custom weighted prediction, high bit-depth color transforms and
  palettes, more ICC and original color spaces, typed extra channels beside photos, patches from several sources and
  coefficient orders for every VarDCT strategy. See [format coverage](docs/reference/FORMAT-COVERAGE.md).
- The still worker answers five format actions: `photo`, `profile`, `readSource`, `encodeSource` and `opsin`.

**New in 5.0.0.** Lossy pictures use the photo coding unless you pass `photo: false`. Animated JPEG XL
(`rapier-jxl/animation`) stores only changed rectangles, with exact timing. The still worker is a separate file,
`rapier-jxl/rapier/still-worker`. Version 5 does not keep 4.x callers working.

## Builds

| Build / import | Gzip bytes | Capabilities |
| --- | ---: | --- |
| **Still worker** · `rapier-jxl/rapier/still-worker` | 102,931 | Core + effort 1–9, optional WASM, Photo, JPEG transcoding and parallel lossless groups. No animation. |
| **Complete worker** · `rapier-jxl/rapier/worker` | 174,450 | Everything in the still worker, plus animation and the other format writers. |
| Complete module · `rapier-jxl/rapier/min` | 174,517 | The complete system with an encoder factory and worker installer. |
| Image · `rapier-jxl/image/min` | 1,184 | One call from a page: a file, bitmap, image data or canvas in, an `image/jxl` Blob out, through either worker. |
| Core · `rapier-jxl/min` | 24,831 | Lossless or lossy typed RGBA, native precision, HDR and exact alpha. |
| Effort · `rapier-jxl/effort/min` | 50,419 | Core with lossless compression search, efforts 1–9. |
| WASM · `rapier-jxl/wasm/min` | 60,129 | Effort with inlined WASM and JavaScript fallback. |
| Photo · `rapier-jxl/photo/min` | 25,190 | Lossy photographs from RGBA pixels. |
| JPEG · `rapier-jxl/jpeg/min` | 30,616 | Existing JPEGs, preserving admitted coefficients and orientation. |
| Metadata · `rapier-jxl/metadata/min` | 12,293 | Attach, replace or remove caller-supplied Exif/XMP. |
| Animation · `rapier-jxl/animation/min` | 58,816 | Animated JPEG XL from frames: only changed rectangles stored, exact timing, lossless or lossy. |

Each size measures a complete standalone file at gzip level 9. Readable imports such as `rapier-jxl/rapier` share
dependencies when bundled together; separate minified files each include theirs. Optional JPEG and Photo ANS builds,
combined sizes and file hashes are listed in [Entry points and embedding](docs/reference/ARCHITECTURE.md).

**Used by Rapier:** each app release embeds its own still worker; Rapier's JPEG XL converter downloads the complete
worker once, for animations and video. Standalone package versions can differ.
Pixel encoding defaults to effort 7 and
quality 90; `lossless: true` selects quality 100. JPEG transcoding takes effort 1 to 9, 7 by default. WASM falls back to JavaScript;
larger lossless images use available helper workers. Painting saves add `losslessProfile: 'painting'` for core
lossless coding without the effort ladder, with helper workers from 32 groups. [Complete API](docs/reference/API.md#complete-rapier-system).

## Compression measurements

On a 71-image lossless corpus, effort 8 used **2.083% fewer bytes** than effort 7 at **4.247×** its summed observed handler time; effort 9 used **2.395% fewer bytes** at **9.546×**. These are single observations on one host, not phone timings. [Times, protocol and per-image/group results](docs/ENCODER-COMPARISON.md#lossless-effort-cost).

The [five-image comparison with libjxl](docs/ENCODER-COMPARISON.md#complete-worker-versus-libjxl) records Rapier 3.1.0 on 2026-10-08. Its bytes and times apply to that frozen worker, not the current search.

## Use a worker

Copy `node_modules/rapier-jxl/dist/rapier-still-worker.js` (or `rapier-worker.js` for animation) beside your page:

```js
const worker = new Worker('./rapier-still-worker.js');
worker.onmessage = ({data}) => {
  if (data.ok) console.log(new Blob([data.bytes], {type: 'image/jxl'}));
  else console.error(data.error.message);
};
worker.postMessage({
  id: 1, operation: 'encode', width: 1, height: 1,
  data: new Uint8Array([255, 0, 0, 255]), options: {lossless: true}
});
```

For one offline HTML file, embed the worker as text and create it through a Blob URL.
[Copyable worker and module examples](docs/reference/ARCHITECTURE.md#complete-rapier-worker).
Keep the MIT notice. No network download or decoder is needed for encoding.

From a page, `await toJXL(file, {worker: './rapier-still-worker.js'})` (`rapier-jxl/image`) returns an `image/jxl` Blob. A JPEG is carried and rebuilds to its exact bytes. [Image API](docs/reference/API.md#one-call-from-a-page)

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
| 7 | Broader predictor and context search; the worker default. |
| 8 | Denser samples, wider trees and local screen transforms; more learned candidates. |
| 9 | Another color transform and deeper trees; the longest search. |

JPEG entry points also add order and entropy-model combinations at efforts 8 and 9, retaining the smaller complete
stream without changing pixels. The workers' JPEG route remains at effort 7. [Effort details](docs/reference/API.md#lossless-effort).

Native inputs include 8/10/12/16-bit integers, binary16/32 floats, PQ/HLG and Rec. 2020. `rapier-jxl/source` reads
supported PNG16/OpenEXR files. Displaying encoded output requires JPEG XL support.

Agent skills: [Single-file apps](skills/rapier-jxl-single-file-app/SKILL.md) · [Photography](skills/rapier-jxl-photography/SKILL.md).

[API](docs/reference/API.md) · [Entry points and embedding](docs/reference/ARCHITECTURE.md) · [Agent reference](llms.txt) ·
[Comparisons](docs/ENCODER-COMPARISON.md) · [Browser example](examples/browser.html)
