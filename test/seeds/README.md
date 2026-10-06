# Encoder conformance seeds

These small, authored JPEGs keep reproduced coefficient-reading failures. `cases.json` records whether a file
must be refused or decoded. `same` means the stored coefficients and tables are identical; `samePixels` permits
different unused edge padding while requiring identical decoded pixels. All files here use the repository's MIT
license. The colour pair was authored with `../jpeg-writer.mjs`; the other JPEGs have deliberately minimal tables
and scan bitstrings.

| Case | Corruption prevented |
| --- | --- |
| `sequential-reserved-eob`, `sequential-zrl-overflow` | A sequential scan cannot borrow progressive end-of-band symbols or skip past its block. |
| `progressive-band-overflow`, `progressive-zrl-overflow`, `progressive-refinement-overflow` | A coefficient or zero run must fit the declared spectral band, including refinements. |
| `progressive-eob-overflow`, `eob-across-restart` | An end-of-band run cannot extend past the scan or the restart interval. |
| `progressive-dc-overflow` | Successive approximation must be range-checked before storing into an `Int16Array`. |
| `quant-before-scan`, `quant-after-scan` | A later table definition cannot replace the table that decoded an earlier component. |
| `quant-between-scans`, `quant-only-after-scan` | Quantization must exist when used and remain fixed during a component's progressive scans. |
| `huffman-all-ones`, `bad-padding`, `trailing-restarts` | Padding cannot become a Huffman symbol, and scan boundaries cannot hide omitted or extra data. |
| `huffman-dc-symbol-16` | A DC table naming a symbol above 15 is refused when a scan first reads DC through it, as libjpeg refuses it, even when no coefficient uses the symbol. |
| `rgba-2049x1.rgba` | Squeeze's zero-height chroma channels must not introduce unused histogram headers. Retained at qualities 1, 80 and 99 in `pixels.json`. |
| `display-p3.jpg` | The colour pair's sequential JPEG with a Display P3 profile (`../icc.mjs`): carried and declared Display P3, its stream held in `bytes.json`. |
| `display-p3-table.jpg` | The same carrier samples and P3 colorants with table transfer curves: the whole table is recognised using deterministic arithmetic, and `bytes.json` requires the parametric profile's stream. |
| `profile-table-plateau.jpg` | The colour pair's sequential JPEG with Display P3 colorants and a monotonic red transfer table that matches sRGB only at the old sampled knots. `malformed.test.mjs` refuses it: relabelling its changed transfer as sRGB would change the colours. |
| `rgba-1x257.rgba` | Squeeze's zero-width chroma channels of a one-wide picture own no group piece; the histograms are numbered over the channels that do, or the decoder finds a hole. Retained at qualities 1, 80 and 99 in `pixels.json`. |

Run the public tests from the repository root:

```sh
npm install
JXL_FUZZ_REQUIRE_NATIVE=1 node --test "test/*.test.mjs"
```

The required development decoder is `jxl-oxide-wasm@0.12.6`. The second oracle is ffmpeg built with `libjxl`;
without it, tests print `nativeUnavailable: true`, unless `JXL_FUZZ_REQUIRE_NATIVE=1` requires a failure. GitHub
Actions installs both. Native decoder output is bounded by the encoded dimensions; JPEG mutation allocations
are guarded before allocation, and admitted mutation dimensions remain small.

`JXL_FUZZ_SEED`, `JXL_FUZZ_JPEGS` and `JXL_FUZZ_PIXELS` choose a reproducible run. There are no timing or size
assertions in these tests. `JXL_FUZZ_FAILURE_DIR` saves a failing input and its reproduction coordinates.
Retained pixel cases run even when the generated pixel-case count is zero. An optional `photo.mjs` or `effort.mjs`
is included automatically when present (the effort door at efforts 2 and 3).

The scale runner uses one persistent native libjxl process per worker. Install a C compiler and the libjxl
development package (for example `apt-get install build-essential libjxl-dev`), then run:

```sh
node test/fuzz-shards.mjs --out fuzz-scale --workers 4 --jpegs 2000000 --pixels 32768 --seed 20260930
```

The ranges are disjoint deterministic indices. Repeating the same command resumes completed chunks; it does
not credit a repeated index again. Every mutation executes the encoder. Only byte-identical returned streams
reuse decoder evidence. `summary.json` separates mutations, unique inputs, returned streams, unique streams,
actual new decoder executions, duplicate executions across workers, and cache hits. The per-input
`outcomes.jsonl` journals retain named refusals and exact output hashes. `--against /path/to/baseline/modules`
compares every input's result with that source, memoizing the baseline result for identical inputs; `--reuse
/path/to/prior-run` admits only hash-identical codestream proofs from identical decoder identities and optional-oracle availability. A prior
single-worker run supplies that cache; `node test/fuzz-cache.mjs completed-shards new-cache` also
consolidates a completed shard run after checking its receipt and journal hashes, without decoding again.
Source-module hashes, input-seed hashes, proof-cache hashes and the
partition are recorded. `--lock /path/to/bench.lock` holds a shared `flock` lease only while a bounded chunk
runs. Pixel mutations use compact block-edge cases, with the full group/strip dimensions every 256th case.

`decoder-difference.jpg` retains a one-sample VarDCT decoder difference. The native float sample scaled to
8-bit is exactly `140.5` in float32; native libjxl 0.7.0 returns 140 and jxl-oxide 0.12.6 returns 141. Their
output conversion rules differ: [native uses `NearestInt`](https://github.com/libjxl/libjxl/blob/v0.7.0/lib/jxl/render_pipeline/stage_write.cc#L113-L133),
while [oxide adds 0.5 before converting to an integer](https://github.com/tirr-c/jxl-oxide/blob/0.12.6/crates/jxl-oxide/src/fb.rs#L537-L568).
`node test/decoder-differences.mjs` reproduces the actual byte and float outputs. Nonzero VarDCT
differences are retained and counted for investigation, not hidden as exact agreement. Lossless, alpha and
integer modular differences stop the run; a VarDCT difference greater than one sample also stops it.
`photo-decoder-difference.rgba` is a 256-byte, 8-by-8 crop from the deterministic synthetic photograph
`synthetic-photo-0005` (seed 1748439572, crop origin 72,24). Its quality-90 photo stream gives the same
conversion discrepancy in blue: the float32 scaled value is 184.5, native returns 184 and oxide returns 185.
Pass `test/seeds/photo-decoder-difference.json` to that diagnostic to reproduce it. Both examples
remain in the ordinary retained conformance cases; their byte outputs are not described as identical.

`reconstruction-difference.jpg` retains a distinct arithmetic case (seed 20260930, index 1008294).
At pixel 16,23, blue is 7 in oxide and 6 in libjxl's normal CPU dispatch; the native float32 value scaled
to bytes is 6.49999475479126. The same libjxl 0.7.0 library forced to Highway's scalar path returns 7,
matching oxide. `../native-scalar.c` is an optional diagnostic wrapper to reproduce that CPU-path
difference (its build needs the Highway development library too); it is never the normal batch oracle.
The decoders use distinct floating reconstruction implementations: [oxide's inverse DCT](https://github.com/tirr-c/jxl-oxide/blob/0.12.6/crates/jxl-render/src/vardct/wasm32/dct.rs)
and [native's floating colour conversion](https://github.com/libjxl/libjxl/blob/v0.7.0/lib/jxl/render_pipeline/stage_ycbcr.cc).
The scale receipt distinguishes exact-half conversion ties from reconstruction-rounding cases. Every
nonzero stream gets a native float decode, counted separately from the two 8-bit oracle executions.

`../phone-benchmark.mjs` measures a photograph expanded to 4000 by 3000 before timing starts. `--node` reports
unthrottled Node results. `--browser` requires a real Playwright Chromium session and applies CDP's 4x CPU rate
to the page. The benchmark source shows the shared-lock command. Browser cancellation records the duration of
the worker termination call, not completion of worker memory reclamation; Node records the termination promise.
CPU timings are observations, never conformance gates or phone-performance claims.
# Third decoder's subnormal multiplier

`jxl-rs-subnormal.rgba` (2 × 1 black/white) and its photo-q90 stream
`jxl-rs-subnormal.jxl` retain an upstream decoder defect. At jxl-rs revision
`2e65fa59b43aebd13c0530d9dcfcf151b19567d3`, `jxl/src/util/float16.rs` reads binary16
subnormals at half value, so the raw AC quantization multiplier loses a factor of two.
The stream is valid: jxl-oxide 0.12.6, native libjxl and the separately named decoder
repair return the original pixels. Unmodified jxl-rs changes RGB by up to 111; alpha
stays exact. `jxl-rs-subnormal.json` records bytes, hashes and returned samples.
`../jxl-rs-half-subnormals.patch` repairs that owner, and `../JXL-RS.md` keeps the
unmodified and repaired oracle builds distinct. No encoder workaround is used.


`jxl-rs-default-squeeze.rgba` and its 66-byte core-q50 stream retain the default Squeeze
channel-slot defect in that same upstream pin: both initial chroma transforms belong even
when a residual is empty. Native and oxide agree on all samples; unmodified jxl-rs changes
15 RGB samples by up to 140. The separate owner repair restores exact agreement.

`jxl-rs-squeeze-border.rgba.gz` and `.jxl.gz` retain the average-border crop defect: a coarse
average tile spans several output tiles, so its neighboring border needs the matching crop
origin along the unchanged axis. The deterministic 2049 × 257 input has 43 changed RGB
samples (maximum three) in upstream; the owner repair makes all samples exact. The JSON
records the source formula, raw-byte hashes and every changed coordinate. Gzip only keeps
these retained artifacts compact; the public check decodes the original RGBA before encoding.

`../JXL-RS.md` explains optional availability and the explicitly patched diagnostic CI build.
An unavailable third decoder is reported as unavailable; a configured broken decoder fails.

`local-palette.rgba` (600 × 19) and `wide-palette.rgba` (17 × 19) retain exact straight RGBA for the local-tree
search. Both include nonzero RGB under zero alpha. The first crosses three groups with different index distributions;
the second has palette metadata wider than its picture. The effort row decodes the independently written palette
candidates as well as the door's selected streams. The byte cases retain the local palette and gradient streams and
the identical effort-4/5 answer. They are generated with the 32-bit recurrence `s = (1664525*s + 1013904223) mod 2^32`,
seed 20261001. For `local-palette`, advance once per pixel: `n` is 1 for x below 256, the state's top six bits for
x below 512, otherwise `(x+3*y) & 63`; RGBA is `[(73*n)&255, (151*n)&255, (199*n)&255, n%5 ? 255 : 0]`.
For `wide-palette`, make 257 colours from successive top bytes for R, G and B, then one more for alpha except
every ninth colour has zero alpha without advancing; pixel (x,y) uses colour `(7*x+13*y) % 257`.

`hurry-inner.rgba` is synthetic-photo-0004 from `tools/corpus/jxl-images.mjs`: 96 × 64, seed 3796584361,
RGBA SHA-256 `c205dcaad1f792296bd789964086ac1d4e2243e5d6b5a0aff268eb28df39fb42`. It writes a 9,665-byte
core stream; the two close weighted plans write 9,668 and 9,666 bytes, so neither improves on it, and effort 4's
colour-transform candidate writes 9,413. Hurrying inside that candidate must answer what was complete before it.
(Before the lossless revision below the core wrote 9,956 bytes and the weighted plans improved on it.) The raw
fixture pins the generated bytes independently of rasterizers.

`hurry-painting.rgba.gz` is paint-0000 of the same corpus: 512 × 384, straight RGBA, a gzip wrapper without metadata,
RGBA SHA-256 `ad9467838000b99434d7f7cb041111cd0bad8f64fe2511ce98d0d106ebd147a3`. It writes a 103,544-byte core
stream and effort 3's weighted plan writes 97,211, which effort 4's colour-transform candidate does not improve.
The hurried-search rows need a search that genuinely improves on effort 1: a gradient picture's no longer does
once the core prices its hybrid-integer codes, and a hurry then answers effort 1's stream whether or not the search
was cut short. Hurrying before the plan completes must answer effort 1's stream; hurrying inside the later
colour-transform candidate must answer the completed weighted stream.
These four authored fixtures are under this directory's MIT licence.

## Lossless byte revision

Exact hybrid-integer selection (`lossless-coding.mjs`) and the effort door's colour-transform search (`rct-search.mjs`,
effort 4 and above) change 27 of the 154 streams in `bytes.json`: 16 core, 10 effort and one hurried-floor case (the
hurried job answers effort 1's stream, which moved). None grows; the other 127 hashes, every photographic and
JPEG-carrier case among them, are unchanged. The hybrid selection alone changes the same 27; the colour search changes
two of them further (seed 20260930 index 169 at effort 9, 24,602 to 5,018 bytes, and the 300 × 259 border picture at
effort 6, 66,825 to 54,330). Case 69 (a quality-90 request on the 2,049 × 1 picture) answered a 1,526-byte lossy stream
and now answers the exact 1,122-byte stream, which is smaller. Every new stream decodes to the exact input pixels
through jxl-oxide 0.12.6 and native libjxl, and through Chrome 154's decoder where alpha is 255 (a Display P3 stream in a
Display P3 canvas).

Old byte-manifest SHA-256: `bc2899b85d08efd1ed34b3684d4e56223e2970b92db9ac21492e56baa5cf06aa`.
New byte-manifest SHA-256: `e9c9dadbfbc1290d470a891e461764a0696c44e1a3a86e11be27f35f8d280fc5`.
