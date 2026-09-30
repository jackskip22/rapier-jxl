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
| `rgba-2049x1.rgba` | Squeeze's zero-height chroma channels must not introduce unused histogram headers. Retained at qualities 1, 80 and 99 in `pixels.json`. |

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

`../phone-benchmark.mjs` measures a photograph expanded to 4000 by 3000 before timing starts. `--node` reports
unthrottled Node results. `--browser` requires a real Playwright Chromium session and applies CDP's 4x CPU rate
to the page. The benchmark source shows the shared-lock command. Browser cancellation records the duration of
the worker termination call, not completion of worker memory reclamation; Node records the termination promise.
CPU timings are observations, never conformance gates or phone-performance claims.
