# Complete worker and native JPEG XL comparison

The helper measures libjxl in one persistent process. Each encode creates a fresh encoder and uses one calling thread, with no worker pool. It encodes straight sRGB RGBA8 at distance 0 with lossless mode and hidden-color preservation enabled. Every result is decoded and compared with every input byte.

Build on Linux against installed libjxl headers and library. The build script records compiler flags and hashes of the helper, source, and linked library in `libjxl-build.json`:

```sh
node bench/libjxl-build.mjs
./bench/libjxl --version
```

For nonstandard installations, pass the include directory and shared-library path to `libjxl-build.mjs`. The `CXX` environment variable selects the compiler.

Run with a manifest of `{id, kind, width, height, rgbaHash, pixels}` records. Pixel paths are relative to the manifest. Hashes are SHA-256 over RGBA bytes.

```sh
node bench/libjxl.mjs /path/to/manifest.json results 1,3,6,9 1 3
```

The last two arguments select untimed warmups and measured runs per image and effort. The default is one warmup and three measured runs. Effort order rotates between images. Output files, individual timings, medians, input/output hashes, version, processor and CPU affinity are recorded in `results/receipt.json`.

Timing includes encoder construction, settings, allocations and compressed output generation. It excludes process startup, input I/O and verification. Keep the host idle and use the same CPU affinity for both encoders. Compare equivalent lossless RGBA results; effort numbers are encoder-specific search budgets, not matching quality levels. Native SIMD and JavaScript/WASM execution are different runtimes and must be identified in reported results.

## Complete Rapier worker

From the public repository, unpack the five exact inputs and measure the published worker on the same CPU:

```sh
gzip -dk test/complete-corpus/*.rgba.gz
mkdir -p results/rapier-output
taskset -c 0 node bench/rapier-worker.mjs --inputs test/complete-corpus/manifest.json --entry dist/rapier-worker.js --out results/rapier.json --efforts 1,3,6,9 --warmups 0 --repeats 1 --encoded results/rapier-output
taskset -c 0 node bench/libjxl.mjs test/complete-corpus/manifest.json results/libjxl 1,3,6,9 1 3
```

Use an allowed CPU on the test host, and run the commands sequentially while other workloads are idle. The worker harness times admission, each encode job and output production inside one actual worker. It excludes input transport and decoder work, and records startup separately. Automatic WASM is enabled; no helper workers are available in this Node harness. The benchmark compares one encoding thread per implementation; it does not measure browser or phone responsiveness. The published Rapier result records one call per configuration without warmup. The native result records three calls after one warmup and their median. Set `--warmups 1 --repeats 3` to collect repeated warm Rapier measurements.

The complete system's default quality is 90. These comparisons explicitly use `lossless: true` (quality 100) at efforts 1, 3, 6 and 9. Equal effort numbers are distinct search budgets. These lossless results do not compare photographic quality or reversible JPEG reconstruction.

## Corpus and conformance benchmark

`corpus.mjs`, `compare.mjs` and `report.mjs` measure the encoder on a standard corpus against libjxl, and decode every Rapier output with two independent decoders.

### Tools

| Tool | Use | Where to get it |
| --- | --- | --- |
| `cjxl`, `djxl`, `ssimulacra2`, `butteraugli_main` | Reference decoder and quality metrics | The `jxl-linux-x86_64-static` archive of a libjxl release |
| `jxl-oxide` | Second, independent decoder | `cargo install jxl-oxide-cli --locked` |
| `libjxl` (this folder) | Persistent single-thread libjxl encoder used for timing | `node bench/libjxl-build.mjs INCLUDE_DIR LIBRARY --out DIR` |

`djxl --version` and `jxl-oxide --version` are recorded in every result. Set `LD_LIBRARY_PATH` (or `JXL_BENCH_LIBRARY_PATH`) when `libjxl` links a shared library outside the system paths.

### Build the corpus

```sh
NODE_USE_ENV_PROXY=1 node bench/corpus.mjs --dir ~/jxl-corpus
```

The script downloads each source named in `corpus-sources.json`, stops when a SHA-256 differs, and writes raw RGBA, a canonical PNG and `manifest.json` for each image. The corpus has 71 images in seven groups:

| Group | Images | Content |
| --- | ---: | --- |
| `kodak` | 24 | Kodak Lossless True Color Image Suite, 768 by 512 |
| `large` | 5 | Photographs from the CLIC 2020 professional validation set, up to 2048 by 1365 |
| `rapier` | 5 | Light UI, labelled drawing, painting, photograph and terminal, stored beside the tests |
| `ui` | 12 | Application and editor screenshots, up to 2160 by 932 |
| `pixel` | 9 | Pixel art, sprite sheets and tile sheets; three store colour under zero alpha |
| `icons` | 8 | Small icons and emoji with soft alpha |
| `alpha` | 8 | Images with partial alpha and colour under zero alpha, with generated variants |

`--groups kodak,ui` builds a subset. `--pin` fills missing hashes in `corpus-sources.json`.

### Run the comparison

```sh
taskset -c 3 node --expose-gc bench/compare.mjs --corpus ~/jxl-corpus --out ~/jxl-results \
  --libjxl-tools ~/libjxl/tools --oxide ~/oxide/bin/jxl-oxide --helper ~/libjxl-bench/libjxl
node bench/report.mjs ~/jxl-results
```

For every image the script encodes losslessly at efforts 1, 3, 7 and 9 with Rapier and with libjxl at the same effort, and lossily with Rapier's photo path at qualities 90, 75 and 50 against libjxl at the matching distance and at a distance that matches Rapier's size. It records bytes, bits per pixel and the median wall and CPU time. Rapier and libjxl runs alternate within each setting, so a change in machine load reaches both. Each setting takes about 90 seconds of timed runs at most; `--budget-seconds`, `--max-repeats`, `--warmup-seconds`, `--efforts`, `--qualities`, `--groups` and `--ids` change that.

Every Rapier output is decoded with `djxl` and `jxl-oxide`. A lossless output must equal the source RGBA exactly, including colour under zero alpha. A lossy output must decode in both decoders, differ between them by at most one level, and keep alpha exact. Failures go to `failures.jsonl` and make the script exit with status 2. Lossy output is scored with `ssimulacra2` and `butteraugli_main` on opaque images.

Run on an idle machine with one CPU allowed to the process. `--max-load N` waits for the one-minute load average to fall to `N` before timing each setting, and every row records the load average. `--quick` encodes each Rapier setting once, without timing, to compare output bytes between two builds; `report.mjs RESULTS --before OTHER_RESULTS` lists the settings whose bytes differ.

The `results` folder holds the tables of a complete run: `report.md` (conformance first, then the lossless, lossy and build-to-build tables), `per-image.md`, the raw rows in `results.jsonl` and the tool versions in `environment.json`. Rapier and libjxl sizes cover all 71 images; times cover the images listed as timed in `report.md`.
