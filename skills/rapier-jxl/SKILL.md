---
name: rapier-jxl
description: Convert PNG, JPEG, GIF and other image files or folders to JPEG XL with npx jpegxl; JPEGs recompress losslessly and restore exactly. Node 20.16 or later.
---

# JPEG XL 8.4.0

The npm package and command are `jpegxl`. Use the smallest entry that does the job; each entry has its own browser worker. Operations return a result with `bytes`, `kept`, `meetsTarget` and `fidelity`.

| Entry | Use |
| --- | --- |
| `jpegxl/upload` | Fast still uploads: `encode`, `fit`, `variants` at efforts 1–3; `capture` for page photos at 1–3. |
| `jpegxl` | Full still `encode`, `fit`, `variants` at efforts 1–9, including HDR, measured fidelity and WebGPU where available. |
| `jpegxl/capture` | Exact or bounded-error 8-bit page screenshots, efforts 1–5; `capture` with `fidelity: 'exact'` or `{maxError: 0..8}`. |
| `jpegxl/capture-complete` | `capture` at efforts 1–9, including lossy photos with `exactRects` and `photoRects` to protect known text. |
| `jpegxl/animation` | `encode` animated GIFs, frame lists or browser-playable video to animated JPEG XL; outside a browser, supply decoded video frames. |
| `jpegxl/jpeg` | `recompress(jpeg)` saves the exact JPEG coefficients and reconstruction; `restore(jxl)` restores the original JPEG exactly. `recompress(jpeg, {gainMap: true})` also retains an Ultra HDR gain map. |
| `jpegxl/decode` | `decode` a JPEG XL to pixels or frames, optionally with a `region` or `partial: true`. |
| `jpegxl/verify` | `verify(original, result)` independently checks exact pixels, JPEG restoration or a declared lossy target. |
| `jpegxl/serve` | `serve` a recompressed JPEG as JPEG XL to clients that accept it, or its exact original JPEG otherwise; `acceptsJxl` tests an Accept header. |
| `jpegxl/resumable` | `start`, `advance`, `finish` with a durable `Checkpoint` and `ResumableStore` for work split across requests; `workerAdmission` checks measured memory admission. |
| `jpegxl/metadata` | `header`, `inspect`, `edit` without decoding pixels; `placeholder` and `slice` extract lower-resolution JPEG XL files. |
| `jpegxl/hdr` | `read` OpenEXR or Radiance images before encoding their samples. |

For stills, `fidelity: {quality: 90}` is the default; `100` or `'exact'` is lossless. `effort` runs 1 (fastest) to 9 (smallest); upload uses 1–3. To impose a byte budget, use `fit(input, {maxBytes: 100000})` (highest quality that fits); an unmet fit has `meetsTarget: false`, `bytes: null` and `reason.code: 'JXL_TARGET'`. `variants` makes independently sized outputs with per-output `maxBytes`. An exact input JPEG keeps its reconstruction unless `jpeg: 'pixels'` is chosen. In Node, configure the decoder for JPEG inputs when a module requires it.

For a lossy VarDCT still, `encode(input, {progressive: true})` adds 1:8, 1:4, 1:2 and full detail. `placeholder(bytes)` cuts the 1:8 image; `slice(bytes, {scale: 2})` cuts 1:2 when present. These calls do not decode pixels and refuse unsupported files. `serve` can choose a pass with `width`, `maxBytes` or `responsive: true`; `responsive` reads viewport width and DPR.

## CLI

```sh
npx jpegxl photo.png --json
npx jpegxl photos/ --out out/ --jobs 4 --json
npx jpegxl hero.png --max-bytes 100KB --json
npx jpegxl original.jpg --json
npx jpegxl photo.jxl --out photo.jpg --json
npx jpegxl verify photos/ out/ --json
npx jpegxl add --json
npx jpegxl add vite --json
npx jpegxl remove emdash --json
```

`add <place>` supports 16 places: `emdash`, `astro`, `vite`, `webpack`, `next`, `netlify`, `workers`, `r2`, `agents`, `android`, `ios`, `flutter`, `expo`, `capacitor`, `electron`, `tauri`. Run it inside the project folder. `remove` exists for `emdash`, `r2`, `agents`, `android`, `ios`, `flutter`, `expo`, `capacitor`, `electron`, `tauri`; it preserves files you edited. For normal conversion, options are `--quality 1-100` (default 90; JPEG default exact), `--effort 1-9` (default 7), `--exact`, `--jpeg-pixels`, `--max-bytes`, `--out`, `--jobs 0-16`, `--verify`, `--json`. `selftest` is also available.

With `--json`, conversions emit one `type: 'file'` object per input, then `type: 'summary'`; setup and verify commands emit their own JSON records. No other words go to stdout. File records include `kept` (`jpeg-bytes`, `pixels` or `lossy`), `skipped`, or `error` with `code`, `message` and `hint`. Originals are never changed; automatic names never overwrite; reruns skip finished files. One failed file does not stop a batch; any failure makes exit status 1.

## Refusals

Catch the error's `JXL_*` `code` to identify the kind; read its short `message` for the field and accepted value. In CLI JSON, read `error.hint` for the remedy. `JXL_OPTIONS` means an invalid option; `JXL_INPUT` an invalid source; `JXL_RECONSTRUCTION` means no restorable JPEG; `JXL_TARGET` means a target was not met; `JXL_PLATFORM` means a required host feature or decoder is missing. `JXL_SETUP` means a setup folder could not be recognized or prepared. Do not infer success from file size alone: check `meetsTarget` and use `verify` when proof is needed.
