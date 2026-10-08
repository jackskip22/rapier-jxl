# Exact coding for screenshots, text and drawings

`rapier-jxl/effort` and `rapier-jxl/wasm` search lossless screen models at effort 3 and above. Each candidate must
produce a smaller complete codestream to replace the current result. The core entry point excludes these modules;
effort 1 skips the screen search.

## Routing

At efforts 3–4, screen admission requires the core's palette of at most 2,048 colors. A fixed 256-sample grid tests
whether at least 192 centre/right/lower RGBA triples are flat. Images smaller than 32 pixels in either dimension do
not enter this route. The admission test allocates no image-sized buffers.

At effort 5 and above, the same flatness test also admits images without that palette. A second fixed sample admits
some screens with gradients or antialiased text: at least 112 horizontal pairs must match exactly, with a bounded
fraction of gradually changing pairs. These tests select candidates without changing input pixels.

## Candidates

`screen.mjs` writes exact global palettes, sparse channel palettes and modular groups. Global palettes hold at most
4,096 colors and include zero only when present. Palette entries use numeric ordering or, in the deeper search,
frequency ordering with numeric tie breaks. Sparse channel palettes reduce the range of stored values.
Predictor choices are 0, 1, 2, and 5, priced with prefix headers and payload bits.

`screen-lz77.mjs` matches packed modular residuals. Its fast matcher uses a 65,536-bucket hash and up to four chain
probes per position. Every copied value is compared, including overlaps; history resets per plane and group.
Distance histograms and the modular format's spatial-distance codes are part of the complete byte price.

`screen-patches.mjs` finds repeated connected components against an exact sampled background. Dimensions and hashes
find candidates; full RGBA rectangle equality verifies reuse. Repeated components form a reference-only frame and a
standard patch dictionary with replacement blending. Alpha and RGB under transparency are preserved. The complete
stream includes the atlas, dictionary, body and headers.

The patch scan is limited to four million pixels, 32,768 eligible components, 2,048 repeated component classes and
an atlas height of 16,384. Reused components are at most 64 by 64 pixels and occur at least three times. Exceeding
these bounds abandons that candidate and retains the completed stream.

The first candidates are global-palette LZ77, glyph patches with LZ77, channel-palette LZ77 and the two palette forms
without matching. At effort 3, the search can stop after the first two when the best stream is at most three quarters
of effort 1's size. Effort 4 continues through those candidates and the broader lossless searches.

Effort 5 and above also price numeric and frequency palettes, patch atlases, channel palettes, and direct channels
with 1,024-pixel groups. Each group selects its predictor after matching, including row matches, and writes its own
model. Complete streams decide whether any of these candidates replaces the current result.

## Progress and exactness

A hurry observed between steps retains a completed stream. An incomplete atlas or body is never returned. Search
choices are deterministic; hashes identify candidates, and full pixel comparisons establish equality.
Readable and minified entry points produce the same bytes. See [progress and cancellation](reference/API.md#progress-and-cancellation).

The worker pool distributes group counting, writing, and predictor search. Each task preserves the full format
group and its match history. Workers replace their tiles when the frame or group dimensions change, including
transitions between a patch atlas and its image body. The coordinator combines histograms and sections in group order.

The public checks cover decoded pixels, alpha, malformed streams and byte equality:

```sh
node --test test/screen.test.mjs test/screen-lz77.test.mjs test/screen-patches.test.mjs
```

The format uses ISO/IEC 18181 modular frames, LZ77 and patch dictionaries. These modules are MIT-licensed JavaScript;
no fonts, OCR model or additional runtime dependency is required.
