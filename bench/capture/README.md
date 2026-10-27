# Capture measurements

[Read the audit](../../docs/CAPTURE-AUDIT.md). The JSON files are the measurements; the Markdown tables are generated from them.

The corpus contains actual snapdom output at 1920×1080 and 3840×2160, with opaque and transparent UI, text, gradients, shadows and a real photo. It also includes a pinned upstream snapdom demo and a CC0 500×500 photo. Sources, hashes and native browser PNG/WebP measurements are in [the fixture manifest](fixtures/manifest.json).

## Scope

These results came from hosted Linux on an AMD EPYC 9V74, Node 24 and Chrome 155. A physical midrange laptop, phone and hardware GPU were unavailable. Proposed product targets are **FHD ≤1 s / 4K ≤3 s on a laptop**, and **FHD ≤2.5 s / 4K ≤8 s on a phone**. They are qualification targets, not measured hardware claims or API guarantees. Keep one worker job active; queued inputs still consume memory.

Cold includes JS import, worker startup and encoder initialization. Warm excludes input PNG decoding and output writing. Native CLI results include startup, PNG decoding and writing; repeated native runs are separate processes. Headline Node timings ran serially after browser/build work stopped. Supplementary entry/alpha diagnostics shared the host with development work and should not establish latency budgets.

Peak RSS is the whole fresh process, including runtime, input and worker, not incremental codec memory. Browser native/GPU memory was unavailable and is unmeasured. The browser's default GPU adapter was unavailable, so auto mode used CPU fallback. Software GPU correctness does not establish hardware GPU performance.

Every exact result is compared against all decoded RGBA bytes through pinned `djxl`, including RGB under zero alpha. Chrome canvas readback additionally passes opaque equality; partial-alpha RGB has premultiplication rounding, recorded separately in [browser-alpha-results.json](browser-alpha-results.json). Lossy quality comes from native SSIMULACRA2 on decoded 8-bit pixels. Equal quality-slider values are not matched-quality comparisons.

## Reproduce

Linux x86_64, Node, Python 3 and tar are required. Pillow is needed only for the JPEG probe. The setup script downloads public tools and verifies every SHA-256 before extracting them. Keep baseline checkout and generated images outside the repository.

```sh
npm install --ignore-scripts --package-lock=false
npm run build
node bench/capture/setup.mjs /tmp/rapier-capture-tools
mkdir -p /tmp/rapier-before
git archive 3d36f51c36843a7d2965af2f525504047aa2f8a3 src dist package.json | tar -x -C /tmp/rapier-before

node bench/capture/run.mjs --tools /tmp/rapier-capture-tools --baseline /tmp/rapier-before --out /tmp/capture-results --timeout 900000
node bench/capture/module-probes.mjs --tools /tmp/rapier-capture-tools --baseline /tmp/rapier-before --out /tmp/module-probes
node bench/capture/match.mjs /tmp/module-probes/module-probes.json --tools /tmp/rapier-capture-tools --out /tmp/module-matched --all-modules
node bench/capture/vips-queue.mjs /tmp/rapier-capture-tools /tmp/vips-queue.json
```

The full matrix includes expensive original effort-9 searches: 4K can take minutes. Use `--only 'opaque.*(capture-lossless|jsquash|vips)'` for the focused comparison. `--resume` retains completed rows; a new output directory gives a fresh run. Reference assets and generated native outputs are not committed.

`snapdom-fixtures.mjs`, `browser.mjs` and `browser-alpha.mjs` use Playwright/Chromium. See the [snapdom example](../../examples/snapdom/README.md) for serving and browser setup. Existing fixture hashes permit comparison without regenerating browser-dependent text rasterization.

## Evidence

| File | Contents |
|---|---|
| `baseline-audit.json` / `baseline-sizes.json` | Every original export, physical build and optional download closure |
| `final-audit.json` / `build-sizes.json` | Every final export/build and its gzip bytes |
| `results.json` | Native/Node codecs, first/warm times, peak RSS, exactness and native quality |
| `browser-results.json` | Public capture API in the browser, main/worker/auto |
| `module-probes.json` | Every pixel-encoding entry on the common photo; utility entries are N/A |
| `module-matched.json` / `capture-matched.json` | Actual cjxl e7/e9 distances, files and native scores; match gaps remain visible |
| `score-baseline.json` / `score-current.json` | Original target discrepancy and the corrected search result |
| `vips-queue.json` | Repeated 4K effort-7 queue diagnostic, including errors |
| `toolchain.json` | Download provenance, hashes, versions and comparator payload sizes |

Regenerate inventories with `audit.mjs ROOT OUTPUT.json`; combine runs with `collect.mjs RUN_DIR... --out bench/capture/results.json` (later duplicate keys win). `report.mjs` writes the audit from checked-in receipts. Source/min aliases are grouped in prose, but their exact mappings remain in the inventory.
