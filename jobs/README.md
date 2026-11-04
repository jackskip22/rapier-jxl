# Hardware checks

Have [Safari 26](safari.md) or a [desktop GPU](desktop-gpu.md)? Open a request and run its page. You can give the request to your agent.

The page uses fixed images and a pinned public package. Nothing is installed; no files or screen content are read, and no results are sent. Copy its JSON into a [job result issue](https://github.com/jackskip22/rapier-jxl/issues/new?template=job-result.yml), including failures. Results are unchecked until independently repeated. Answered requests are removed.

## Result format

Both checks return this JSON contract. Fields for operations that did not run are absent or `null`.

| Field | Value |
| --- | --- |
| `schema`, `job`, `verification` | `1`; `safari` or `desktop-gpu`; `unchecked` |
| `status`, `elapsedMs` | `running`, `complete`, `failed`, `canceled`, or `timed-out`; total milliseconds when stopped |
| `package` | `name`, exact `version`, pinned npm `tarballSha256`, and executed `modules[]` with `path`, `url`, `bytes`, and measured `sha256` |
| `environment` | Entered `browser`, `os`, and `device`; `userAgent`; `screen` width, height, and device pixel ratio; `gpuAdapters[]`; measured `nativeJxl` (`true`, `false`, or `null` on error) |
| `rows[]` | `id`, `status` (`pass`, `fail`, `unavailable`, `unqualified`), dimensions, `inputSha256`, output `bytes` and `sha256`, `timesMs`; failures include `error` |
| Exact rows | `expectedSha256`, `decodedSha256`, `exact`, `decodeMs`; `nativeDecode` contains `available`, `status`, dimensions, pixel `sha256`, `exact`, and `ms`, or an error |
| GPU rows | `effort`, `quality`, `webgpu`, `runs[]` (warmup, milliseconds, bytes, SHA-256, GPU submissions), `medianMs`, `sameBytes`, `gpuObserved`, `softwareAdapter`, and `speedup` |

`timesMs` excludes module loading and hashing. GPU warmups are recorded separately. `speedup` is CPU median / GPU median and stays `null` without matching bytes, observed GPU work, and identified hardware. `softwareAdapter: null` means the hardware could not be identified. `complete` means the page finished; it does not verify the device or the result. An unavailable adapter or native decoder is reported, never substituted. Errors and interrupted runs keep their completed rows and `currentStep`.
