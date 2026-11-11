# Jobs

Each job runs rapier-jxl on a device we do not have and writes one results file. Pick a job, open an issue with its name as the title, run it, and attach the file to that issue. You can give a job to your agent. [What testing has found](FOUND.md).

| Job | Machine | Minutes | Why it helps | Run |
| --- | --- | --- | --- | --- |
| [Safari on a Mac](safari-mac.md) | Mac, Safari 26 or later | 1 | Safari's own JPEG XL decoder and WebAssembly on macOS | [test page](https://rapier.website/docs/jxl-job.html?job=selftest) |
| [iPhone or iPad](iphone-ipad.md) | iOS or iPadOS 26 or later, Safari | 2 | Phone memory and Safari's decoder on iOS | [test page](https://rapier.website/docs/jxl-job.html?job=selftest) |
| [Android phone in Chrome](android-chrome.md) | Android phone, Chrome | 2-5 | ARM phones, especially older and low-memory ones | [test page](https://rapier.website/docs/jxl-job.html?job=selftest) |
| [Edge on Windows](edge-windows.md) | Windows PC, Edge | 1 | Windows on x64 and ARM, where the browser has no JPEG XL decoder | [test page](https://rapier.website/docs/jxl-job.html?job=selftest) |
| [WebGPU on your graphics card](webgpu.md) | Any GPU with hardware WebGPU | up to 10 | An identical file and its speed on every kind of GPU | [test page](https://rapier.website/docs/jxl-job.html?job=webgpu) |
| [Deno](deno.md) | Deno 2, any OS | 1 | Deno on your OS and CPU | `deno run -A npm:rapier-jxl@8.3.3 selftest` |
| [Bun](bun.md) | Bun 1.2 or later, any OS | 1 | Bun on your OS and CPU | `bunx rapier-jxl@8.3.3 selftest` |
| [Cloudflare Workers](cloudflare-workers.md) | Node 20 or later | 3-5 | Cloudflare's runtime, run locally with `wrangler dev` | [cloudflare-workers/](cloudflare-workers/) |

On Node, `npx rapier-jxl@8.3.3 selftest` runs the same test on any computer.

Every job uses the fixed [pictures](pictures/README.md), a real screenshot, photo and camera JPEG, and this release's package. Each picture is encoded at efforts 1, 3 and 7, lossless and lossy, decoded and verified; the camera JPEG is recompressed and restored. Every output's SHA-256 must match this release's. Nothing is installed by the test pages, no files or screen content are read, and no results are sent: you attach them yourself. Results are unchecked until repeated. Answered jobs are removed.

## Results file

One JSON file: `schema`, `kind` (`rapier-jxl-selftest` or `rapier-jxl-webgpu`), `version`, `status` (`pass`, `fail`, `canceled` or `timed-out`), `elapsedMs`, and:

| Field | Value |
| --- | --- |
| `machine` | Runtime and version, OS, CPU model, cores and memory where the host tells them, the WebGPU adapter where present. In browsers also the user agent, screen and what you entered. Never a name, account or path. |
| `pictures[]` | Each picture's file, bytes, SHA-256, and for PNGs the size and the SHA-256 of its pixels |
| `rows[]` | `id`, `status` (`pass`, `fail`, `unavailable`, `unqualified`), `operation`, `fidelity`, `effort`, output `bytes`, `sha256`, `expectedSha256`, `sameBytes`, `exact`, the `verification` kind and score, `encodeMs`, `decodeMs` or `restoreMs`, `verifyMs`, and `native` (the browser's own decode) where there is one; failures include `error` |
| `summary` | Rows, passed, failed, compared with this release, and native decodes checked and mismatched |

WebGPU rows hold `effort`, `webgpu`, `runs[]` (warmup, milliseconds, bytes, SHA-256, GPU submissions), `medianMs`, `sameBytes`, `gpuObserved`, `softwareAdapter` and `speedup` (CPU median / GPU median, `null` without matching bytes, observed GPU work and identified hardware). Times exclude loading. An unavailable adapter or native decoder is reported, never substituted. Stopped runs keep their finished rows.
