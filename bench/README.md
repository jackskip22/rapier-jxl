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
