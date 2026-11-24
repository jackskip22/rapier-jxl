---
name: rapier-jxl
description: Convert PNG, JPEG, GIF and other image files or folders to JPEG XL with npx jpegxl. Make a WordPress site's images smaller. JPEGs recompress losslessly and restore exactly. Node 22.3+.
---

# JPEG XL

The npm package and command are `jpegxl`. Use the smallest entry that does the job. Each entry has its own browser worker. Operations return a result with `bytes`, `kept`, `meetsTarget` and `fidelity`.

| Entry | Use |
| --- | --- |
| `jpegxl/upload` | Fast still uploads: `encode`, `fit`, `variants` at efforts 1–3. `capture` for page photos at 1–3. |
| `jpegxl` | Full still `encode`, `fit` and `variants` at efforts 1–9 (default 7). HDR, measured fidelity and WebGPU where available. |
| `jpegxl/max` | Full still `encode` at efforts 1–10 (default 10). `fit` and `variants` stay at 1–9 (default 7). |
| `jpegxl/capture` | Exact or bounded-error 8-bit page screenshots, efforts 1–5. `capture` with `fidelity: 'exact'` or `{maxError: 0..8}`. |
| `jpegxl/capture-complete` | `capture` at efforts 1–9, including lossy photos with `exactRects` and `photoRects` to protect known text. |
| `jpegxl/animation` | `encode` animated GIFs, frame lists or browser-playable video to animated JPEG XL. Video frames stream through encoding windows. Outside a browser, supply decoded video frames. |
| `jpegxl/jpeg` | `recompress(jpeg)` saves the exact JPEG coefficients and reconstruction. `restore(jxl)` restores the original JPEG exactly. Ultra HDR gain maps stay in `jhgm` by default (`{gainMap: false}` keeps them only in `jbrd`). |
| `jpegxl/decode` | `decode` a JPEG XL to pixels or frames, optionally with a `region` or `partial: true`. |
| `jpegxl/verify` | `verify(original, result)` independently checks exact pixels, JPEG restoration or a declared lossy target. |
| `jpegxl/serve` | `serve` chooses JPEG XL, a restorable JPEG or a supplied `fallback` from the Accept header. `acceptsJxl` tests an Accept header. |
| `jpegxl/resumable` | `start`, `advance`, `finish` with a durable `Checkpoint` and `ResumableStore` for work split across requests. `workerAdmission` checks measured memory admission. |
| `jpegxl/metadata` | `header`, `inspect`, `edit` without decoding pixels. `sourceMetadata` reads Exif and XMP from JPEG, PNG or WebP for upright pixels. `placeholder` and `slice` extract lower-resolution JPEG XL files. |
| `jpegxl/hdr` | `read` OpenEXR or Radiance images before encoding their samples. |

For stills, `fidelity: {quality: 90}` is the default. `100` or `'exact'` is lossless. `encode` takes efforts 1 (fastest) to 9 in `jpegxl` (default 7) and 1 to 10 in `jpegxl/max` (default 10), for lossy or lossless stills. `fit` and `variants` take 1–9. Upload uses 1–3. To impose a byte budget, use `fit(input, {maxBytes: 100000})` (highest quality that fits). An unmet fit has `meetsTarget: false`, `bytes: null` and `reason.code: 'JXL_TARGET'`. `variants` makes independently sized outputs with per-output `maxBytes`. An output only enlarges the source when it sets `upscale: true`. An exact input JPEG keeps its reconstruction unless `jpeg: 'pixels'` is chosen. In Node, Deno, Bun and Workers a JPEG Blob at a quality needs `configureDecoder(decode, null, recompress)` first, with `decode` from `jpegxl/decode` and `recompress` from `jpegxl/jpeg`. `recompress` itself takes JPEG bytes and needs nothing.

For a lossy VarDCT still, `encode(input, {progressive: true})` adds 1:8, 1:4, 1:2 and full detail. `placeholder(bytes)` cuts the 1:8 image. `slice(bytes, {scale: 2})` cuts 1:2 when present. These calls do not decode pixels and refuse unsupported files. `serve` can choose a pass with `width`, `maxBytes` or `responsive: true`. `responsive` reads viewport width and DPR.

An animation's `unproved` lists frames that needed its final quality repair and whether it raised quality or returned an exact file.

## Mistakes

| Wrong | Right |
| --- | --- |
| `encode(x, {quality: 85})` | `encode(x, {fidelity: {quality: 85}})` |
| `encode(x, {lossless: true})` | `encode(x, {fidelity: 'exact'})` |
| `encode(await readFile('a.png'))` or `{data: pngBytes}` | `encode(new Blob([await readFile('a.png')]))` |
| `effort: 10` on `jpegxl` or by habit | the default: 7 in `jpegxl`, 3 in `jpegxl/upload`. Effort 10 lives in `jpegxl/max` and is a much longer search. |
| `jpegxl` at effort 7 in a Cloudflare Worker | `jpegxl/upload` or `recompress` from `jpegxl/jpeg`, checked with `workerAdmission`: effort 7 needs more than the 128 MB isolate |
| `--quality 90` on a JPEG for the default | no `--quality`: a JPEG stays exact. With it, the smaller of exact and that quality at efforts 6–10. |
| `void serve(stored, req, res)` | `serve(stored, req, res).catch(console.error)`: a refusal rejects after answering 500 |

## CLI

```sh
npx jpegxl photo.png --json
npx jpegxl photos/ --out out/ --jobs 4 --json
npx jpegxl public/ --keep-extension --json
npx jpegxl site dist/ --json
npx jpegxl hero.png --max-bytes 100KB --json
npx jpegxl original.jpg --json
npx jpegxl photo.jxl --out photo.jpg --json
npx jpegxl verify photos/ out/ --json
npx jpegxl add --json
npx jpegxl add payload --json
npx jpegxl add vite --json
npx jpegxl add void --json
npx jpegxl remove emdash --json
```

`add` lists 22 places: `emdash`, `wordpress`, `payload`, `astro`, `vite`, `webpack`, `next`, `netlify`, `workers`, `r2`, `agents`, `apache`, `nginx`, `caddy`, `void`, `android`, `ios`, `flutter`, `expo`, `capacitor`, `electron`, `tauri`. Run it inside the project folder. `add vite` recognizes `vite` and `vite-plus`. `add void` installs browser upload and Worker storage helpers. `remove <place>` supports every listed place and preserves files you edited. For normal conversion, options are `--quality 1-100` (default 90, JPEG default exact), `--effort 1-10` (default 7, and effort 10 cannot use `--max-bytes`), `--exact`, `--jpeg-pixels`, `--max-bytes`, `--out`, `--keep-extension`, `--jobs` (a nonnegative helper count, default 0), `--verify`, `--json`. `selftest` is also available.

To make a WordPress site's images smaller, run `npx jpegxl add wordpress` in the folder with `wp-config.php`, or pass `--path <dir>`. Then activate **JPEG XL Images** in **Plugins**.

To add JPEG XL uploads and `<Picture>` serving to a Payload CMS project, run `npx jpegxl add payload` in the folder with `payload.config.ts` or `src/payload.config.ts`.

For automatic JPEG XL output names, `--keep-extension` keeps the source extension: `photo.jpg.jxl` and `photo.png.jxl`. Use it when preparing files for Apache, nginx, Caddy or the Workers example. For static hosts with no server config (GitHub Pages, S3), `npx jpegxl site <folder>` converts images with `--keep-extension` and rewrites HTML `<img>` tags to `<picture>` with `<source type="image/jxl">` wherever every candidate has its `.jxl` (`--dry-run` previews changes). An explicit output filename stays as given.

## `--json`

With `--json`, conversions emit one record per input, then `type: 'summary'`. A normal record has `type: 'file'`. A folder image this host cannot decode has `type: 'unread'`, its input path and a reason, and increments the summary's `unread` count without failing the batch. Naming that image directly is a failure. Setup and verify commands emit their own JSON records. No other words go to stdout. File records include `kept` (`jpeg-bytes`, `pixels` or `lossy`), `skipped`, or `error` with `code`, `message` and `hint`. Originals are never changed. Automatic names never overwrite. Reruns skip finished files. One failed file does not stop a batch. Any failure makes exit status 1.

## Refusals

Catch the error's `JXL_*` `code` to identify the kind. Read its short `message` for the field and accepted value. In CLI JSON, read `error.hint` for the remedy. `JXL_OPTIONS` means an invalid option. `JXL_INPUT` an invalid source. `JXL_RECONSTRUCTION` means no restorable JPEG. `JXL_TARGET` means a target was not met. `JXL_PLATFORM` means a required host feature or decoder is missing. `JXL_SETUP` means a setup folder could not be recognized or prepared. Do not infer success from file size alone: check `meetsTarget` and use `verify` when proof is needed.
