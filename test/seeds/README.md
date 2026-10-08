# Encoder conformance seeds

These JPEG fixtures reproduce coefficient-reading failures. `cases.json` records whether a file
must be refused or decoded. `same` means the stored coefficients and tables are identical; `samePixels` permits
different unused edge padding while requiring identical decoded pixels. All files here use the repository's MIT
license. The color pair was generated with `../jpeg-writer.mjs`; the other JPEGs have deliberately minimal tables
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
| `display-p3.jpg` | The color pair's sequential JPEG with a Display P3 profile (`../icc.mjs`): carried and declared Display P3, its stream held in `bytes.json`. |
| `display-p3-table.jpg` | The same carrier samples and P3 colorants with table transfer curves: the whole table is recognized using deterministic arithmetic, and `bytes.json` requires the parametric profile's stream. |
| `profile-table-plateau.jpg` | The color pair's sequential JPEG with Display P3 colorants and a monotonic red transfer table that matches sRGB only at the old sampled knots. `malformed.test.mjs` refuses it: relabeling its changed transfer as sRGB would change the colors. |
| `rgba-1x257.rgba` | Squeeze's zero-width chroma channels in a one-pixel-wide image emit no group data. Histogram indices must exclude those channels. Retained at qualities 1, 80 and 99 in `pixels.json`. |

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
is tested automatically when present (the effort entry point at efforts 2 and 3).

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
and [native's floating color conversion](https://github.com/libjxl/libjxl/blob/v0.7.0/lib/jxl/render_pipeline/stage_ycbcr.cc).
The scale receipt distinguishes exact-half conversion ties from reconstruction-rounding cases. Every
nonzero stream gets a native float decode, counted separately from the two 8-bit oracle executions.

`../phone-benchmark.mjs` measures a photograph expanded to 4000 by 3000 before timing starts. `--node` reports
unthrottled Node results. `--browser` requires a real Playwright Chromium session and applies CDP's 4x CPU rate
to the page. The benchmark source shows the shared-lock command. Browser cancellation records the duration of
the worker termination call, not completion of worker memory reclamation; Node records the termination promise.
CPU timings are observations, never conformance gates or phone-performance claims.

## jxl-rs regression cases

`jxl-rs-subnormal.rgba` (2 × 1 black/white) and its photo-q90 stream
`jxl-rs-subnormal.jxl` retain an upstream decoder defect. At jxl-rs revision
`2e65fa59b43aebd13c0530d9dcfcf151b19567d3`, `jxl/src/util/float16.rs` reads binary16
subnormals at half value, so the raw AC quantization multiplier loses a factor of two.
The stream is valid: jxl-oxide 0.12.6, native libjxl and the separately named decoder
repair return the original pixels. Unmodified jxl-rs changes RGB by up to 111; alpha
stays exact. `jxl-rs-subnormal.json` records bytes, hashes and returned samples.
`../jxl-rs-half-subnormals.patch` corrects the decoder. `../JXL-RS.md` identifies the
unmodified and patched builds. The stored codestreams are unchanged.

`jxl-rs-default-squeeze.rgba` and its 66-byte core-q50 stream retain the default Squeeze
channel-slot defect in that same upstream pin: both initial chroma transforms belong even
when a residual is empty. Native and oxide agree on all samples; unmodified jxl-rs changes
15 RGB samples by up to 140. The decoder patch restores exact agreement.

`jxl-rs-squeeze-border.rgba.gz` and `.jxl.gz` retain the average-border crop defect: a coarse
average tile spans several output tiles, so its neighboring border needs the matching crop
origin along the unchanged axis. The deterministic 2049 × 257 input has 43 changed RGB
samples (maximum three) in upstream; the decoder patch restores every sample. The JSON
records the source formula, raw-byte hashes, and every changed coordinate. The fixtures use gzip to reduce file size;
tests decompress the original RGBA before encoding.

`../JXL-RS.md` describes the diagnostic CI build. Tests report a missing jxl-rs decoder;
a configured decoder must pass the pixel checks.

`local-palette.rgba` (600 × 19) and `wide-palette.rgba` (17 × 19) retain exact straight RGBA for the local-tree
search. Both include nonzero RGB under zero alpha. The first crosses three groups with different index distributions;
the second has palette metadata wider than its image. The effort tests decode both the palette
candidates and the selected streams. The byte cases retain the local palette and gradient streams and
the identical effort-4/5 answer. They are generated with the 32-bit recurrence `s = (1664525*s + 1013904223) mod 2^32`,
seed 20261001. For `local-palette`, advance once per pixel: `n` is 1 for x below 256, the state's top six bits for
x below 512, otherwise `(x+3*y) & 63`; RGBA is `[(73*n)&255, (151*n)&255, (199*n)&255, n%5 ? 255 : 0]`.
For `wide-palette`, make 257 colors from successive top bytes for R, G and B, then one more for alpha except
every ninth color has zero alpha without advancing; pixel (x,y) uses color `(7*x+13*y) % 257`.

`hurry-inner.rgba` is a deterministic 96 × 64 synthetic image, seed 3796584361,
RGBA SHA-256 `c205dcaad1f792296bd789964086ac1d4e2243e5d6b5a0aff268eb28df39fb42`. It writes a 9,665-byte
core stream; the two close weighted plans write 9,668 and 9,666 bytes, so neither improves on it, and effort 4's
color-transform candidate writes 9,413. Hurrying inside that candidate must return the previous completed stream.
The raw fixture fixes the input bytes independently of rasterizers.

`hurry-painting.rgba.gz` is a deterministic 512 × 384 painting in straight RGBA, compressed with gzip,
RGBA SHA-256 `ad9467838000b99434d7f7cb041111cd0bad8f64fe2511ce98d0d106ebd147a3`. It writes a 103,544-byte core
stream and effort 3's weighted plan writes 97,211, which effort 4's color-transform candidate does not improve.
Hurrying before the weighted plan completes must return effort 1's stream. Hurrying inside the later
color-transform candidate must return the completed weighted stream.

`bytes.json` records the current output hashes. All four authored RGBA fixtures use the MIT license.
