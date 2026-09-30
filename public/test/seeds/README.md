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
| `rgba-1x257.rgba` | Squeeze's zero-width chroma channels of a one-wide picture own no group piece; the histograms are numbered over the channels that do, or the decoder finds a hole. Retained at qualities 1, 80 and 99 in `pixels.json`. |

Run the public tests from the repository root:

```sh
npm install
JXL_FUZZ_REQUIRE_NATIVE=1 node --test "public/test/*.test.mjs"
```

The required development decoder is `jxl-oxide-wasm@0.12.6`. The second oracle is ffmpeg built with `libjxl`;
without it, tests print `nativeUnavailable: true`, unless `JXL_FUZZ_REQUIRE_NATIVE=1` requires a failure. GitHub
Actions installs both. Native decoder output is bounded by the encoded dimensions; JPEG mutation allocations
are guarded before allocation, and admitted mutation dimensions remain small.

`JXL_FUZZ_SEED`, `JXL_FUZZ_JPEGS` and `JXL_FUZZ_PIXELS` choose a reproducible run. There are no timing or size
assertions in these tests. `JXL_FUZZ_FAILURE_DIR` saves a failing input and its reproduction coordinates.
Retained pixel cases run even when the generated pixel-case count is zero. An optional `photo.mjs` is included
automatically when present.

The scale runner uses one persistent native libjxl process per worker. Install a C compiler and the libjxl
development package (for example `apt-get install build-essential libjxl-dev`), then run:

```sh
node public/test/fuzz-shards.mjs --out fuzz-scale --workers 4 --jpegs 2000000 --pixels 32768 --seed 20260930
```

The ranges are disjoint deterministic indices. Repeating the same command resumes completed chunks; it does
not credit a repeated index again. Every mutation executes the encoder. Only byte-identical returned streams
reuse decoder evidence. `summary.json` separates mutations, unique inputs, returned streams, unique streams,
actual new decoder executions, duplicate executions across workers, and cache hits. The per-input
`outcomes.jsonl` journals retain named refusals and exact output hashes. `--against /path/to/baseline/modules`
compares every input's result with that source, memoizing the baseline result for identical inputs; `--reuse
/path/to/prior-run` admits only hash-identical codestream proofs from the same two decoder versions. A prior
single-worker run supplies that cache; `node public/test/fuzz-cache.mjs completed-shards new-cache` also
consolidates a completed shard run after checking its receipt and journal hashes, without decoding again.
Source-module hashes, input-seed hashes, proof-cache hashes and the
partition are recorded. `--lock /path/to/bench.lock` holds a shared `flock` lease only while a bounded chunk
runs. Pixel mutations use compact block-edge cases, with the full group/strip dimensions every 256th case.

`decoder-difference.jpg` retains a one-sample VarDCT decoder difference. The native float sample scaled to
8-bit is exactly `140.5` in float32; native libjxl 0.7.0 returns 140 and jxl-oxide 0.12.6 returns 141. Their
output conversion rules differ: [native uses `NearestInt`](https://github.com/libjxl/libjxl/blob/v0.7.0/lib/jxl/render_pipeline/stage_write.cc#L113-L133),
while [oxide adds 0.5 before converting to an integer](https://github.com/tirr-c/jxl-oxide/blob/0.12.6/crates/jxl-oxide/src/fb.rs#L537-L568).
`node public/test/decoder-differences.mjs` reproduces the actual byte and float outputs. Nonzero VarDCT
differences are retained and counted for investigation, not hidden as exact agreement. Lossless, alpha and
integer modular differences stop the run; a VarDCT difference greater than one sample also stops it.
`photo-decoder-difference.rgba` is a 256-byte, 8-by-8 crop from the deterministic synthetic photograph
`synthetic-photo-0005` (seed 1748439572, crop origin 72,24). Its quality-90 photo stream gives the same
conversion discrepancy in blue: the float32 scaled value is 184.5, native returns 184 and oxide returns 185.
Pass `public/test/seeds/photo-decoder-difference.json` to that diagnostic to reproduce it. Both examples
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
