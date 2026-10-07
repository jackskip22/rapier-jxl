# Rapier JXL

JPEG XL encoder for integer and floating-point RGBA samples and JPEG coefficients. JavaScript, optional inlined
WebAssembly, no runtime dependencies. Native 8-, 10-, 12- and 16-bit integers, IEEE binary16 and binary32,
PQ and HLG transfer functions, and Rec. 2020 primaries. [MIT](LICENSE).

```sh
npm install rapier-jxl
```

```js
import {encode} from 'rapier-jxl';

const {data, width, height} = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
const bytes = encode(data, width, height, {quality: 100});
const jxl = new Blob([bytes], {type: 'image/jxl'}); // save as image.jxl
```

`quality: 100` (default) is lossless; `1–99` is lossy. Alpha stays exact.
For smaller lossless files, import `encode` from `rapier-jxl/effort` and set `effort: 1–9` (default `1`).
`rapier-jxl/wasm` runs that search with optional integer kernels and identical output bytes.

## Native precision and HDR

| Source | Input | Declaration |
| --- | --- | --- |
| 8-bit RGBA | `Uint8Array` or `Uint8ClampedArray` | Inferred |
| 10- or 12-bit RGBA | `Uint16Array`, unscaled code values | `bitDepth: 10` or `12` |
| 16-bit RGBA | `Uint16Array` | Inferred |
| IEEE binary16 | `Uint16Array`, raw half-float words | `sampleFormat: 'float16'` |
| IEEE binary32 | `Float32Array` | Inferred; linear transfer by default |
| PNG16 or scanline OpenEXR | File bytes through `rapier-jxl/source` | Samples and supported colour declarations read together |

```js
import {readSource} from 'rapier-jxl/source';
import {encode} from 'rapier-jxl';

const {data, width, height, ...source} = await readSource(fileBytes);
const bytes = encode(data, width, height, {...source, quality: 100});
```

Colour and alpha declarations describe the supplied samples. Encoding does not convert colour, tone-map, clamp HDR
values or unpremultiply RGB. The optional source reader supports PNG16, including Adam7, and uniform HALF/FLOAT
OpenEXR scanlines with NONE, RLE, ZIPS or ZIP compression. [Source formats, error bounds and decoder qualifications](docs/reference/API.md#native-precision).

## Encoding under a CPU budget

The fixed-work benchmark uses Node 22.23.3 on an AMD EPYC 9V74 x86-64 host, with affinity to four virtual CPUs and an aggregate limit of 0.5 process CPU seconds per wall second. Four original-size inputs total 1,157,120 pixels: 640 × 448 text, 640 × 432 screen, 640 × 448 drawing and a 512 × 600 photograph. The text, screen and drawing inputs are authored corpus rasters. Every call uses quality 100.

Each table entry is the sum of four per-image medians, with one warmup and three measured repetitions per image. The worker count is additional threads; the caller also codes groups. Worker startup belongs to each job. These results describe this constrained x86 host; phone latency, browser scheduling, thermal performance and energy require target-device measurements.

### Caller-thread CPU, milliseconds

| Effort | Caller only | +1 worker | +2 workers | +4 workers |
|---:|---:|---:|---:|---:|
| 1 | 174.4 | 159.7 | 154.1 | 140.3 |
| 2 | 418.2 | 498.0 | 422.4 | 416.0 |
| 3 | 574.0 | 615.4 | 487.6 | 542.7 |
| 4 | 1045.2 | 1024.3 | 1031.2 | 1071.5 |
| 5 | 1959.1 | 1972.8 | 1940.1 | 2040.7 |
| 6 | 2501.9 | 2566.1 | 2553.3 | 2591.2 |
| 7 | 2640.9 | 2629.1 | 2621.1 | 2639.0 |
| 8 | 2577.1 | 2489.5 | 2540.6 | 2525.6 |
| 9 | 2507.5 | 2574.5 | 2583.5 | 2556.7 |

### Aggregate process CPU, milliseconds

| Effort | Caller only | +1 worker | +2 workers | +4 workers |
|---:|---:|---:|---:|---:|
| 1 | 205.2 | 192.6 | 171.6 | 147.2 |
| 2 | 439.4 | 523.5 | 454.7 | 434.9 |
| 3 | 615.3 | 696.6 | 563.2 | 621.0 |
| 4 | 1294.5 | 1190.4 | 1265.7 | 1298.2 |
| 5 | 2471.2 | 2437.1 | 2490.8 | 2631.1 |
| 6 | 3202.8 | 3201.1 | 3141.1 | 3262.8 |
| 7 | 3347.2 | 3287.2 | 3261.1 | 3340.6 |
| 8 | 3279.4 | 3151.4 | 3224.3 | 3211.4 |
| 9 | 3130.4 | 3252.4 | 3197.0 | 3239.7 |

### Elapsed time under the CPU budget, milliseconds

| Effort | Caller only | +1 worker | +2 workers | +4 workers |
|---:|---:|---:|---:|---:|
| 1 | 390.0 | 390.4 | 328.9 | 303.7 |
| 2 | 900.8 | 1031.8 | 915.5 | 886.3 |
| 3 | 1244.0 | 1421.6 | 1141.1 | 1231.8 |
| 4 | 2603.3 | 2364.8 | 2526.8 | 2604.0 |
| 5 | 4962.4 | 4864.6 | 4976.5 | 5240.9 |
| 6 | 6511.4 | 6392.1 | 6330.9 | 6517.5 |
| 7 | 6631.9 | 6573.8 | 6509.2 | 6669.3 |
| 8 | 6569.0 | 6313.8 | 6456.1 | 6431.7 |
| 9 | 6246.5 | 6495.5 | 6365.1 | 6443.9 |

The benchmark records complete stream hashes, source module hashes, input hashes, individual CPU and wall samples, caller profiles and actual governor accounting. `node bench/phone-budget.mjs --inputs=inputs.json --out=results --max-pixels=1157120 --efforts=1,2,3,4,5,6,7,8,9 --workers=0,1,2,4 --rounds=3 --cpu-share=0.5 --cpus=0-3 --profile` runs the same declared work. The manifest is a JSON array; each entry names an `id`, a `kind`, `width`, `height`, the `rgbaHash` (SHA-256 of the raw RGBA bytes) and `pixels`, the path of those bytes relative to the manifest. Split the efforts into smaller invocations when limiting individual command duration.

## Encoder payload

| Encoder payload | Minified JS + WASM bytes | gzip bytes |
| --- | ---: | ---: |
| Rapier JXL core | 26,997 | 11,408 |
| libjxl via `jxl-wasm` 0.7.0 | 2,533,758 | 961,538 |
| `@jsquash/jxl` 1.3.0 | 1,388,572 | 525,782 |
| `@squoosh-kit/jxl` 0.2.10 | 1,371,789 | 511,927 |

Executable payloads, gzip 9; external packages measured 2026-09-30. These are encoder download sizes.
[All comparisons, capabilities and measurement method](docs/ENCODER-COMPARISON.md).

[API, options and errors](docs/reference/API.md) · [Imports, sizes and inlining](docs/reference/ARCHITECTURE.md) ·
[Machine-readable facts](llms.txt) · [Browser example](examples/browser.html) ·
[Worker example](examples/worker.mjs) · [Contributing](.github/CONTRIBUTING.md)
