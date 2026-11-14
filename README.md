# ci/safari

Safari native JPEG XL decode, plus rapier-jxl capture, worker and display rows on real Safari (macos-15 + safaridriver), for two packages side by side.

| package | tarball | sha256 |
|---|---|---|
| 8.2.0 (published) | `rapier-jxl-8.2.0.tgz` | `c966e53f402fc1811670517635d1410b712632d15df5bae969c3bb128cc4c89c` |
| candidate (unreleased, packed from the root's build) | `rapier-jxl-candidate.tgz` | `43d4ff7918cd17556c3cc7e1636c1980fc021ef981346c4d969c19bb3f65e567` |

The workflow extracts them to `p/820/` and `p/cand/`. Each live page exists once per package (`control-820.html`, `control-cand.html`, …); the import map is the only difference.

Fixtures are NASA public-domain photographs or pixels generated for this check.

Canvas text on `capture.html` is copied from NASA's public-domain article
[Apollo 12: The Pinpoint Mission](https://www.nasa.gov/missions/apollo/apollo-12-the-pinpoint-mission/)
(US government work).

Pages, in drive order per package:

- `control`: plain `getImageData` / `createImageBitmap` on a bare and a `willReadFrequently` canvas, attached and detached; `capture(bareCanvas)`; the bare canvas copied with `drawImage` onto a fresh `willReadFrequently` canvas, read and captured there.
- `capture`: 2D and WebGL capture rows. WebGL in page must give exact pixels or refuse with `JXL_INPUT`, never a wrong file; a lost WebGL context must refuse with `JXL_INPUT`; a harness-only `drawImage` copy of the WebGL canvas is compared with `readPixels`.
- `p3`: `readAs: 'display-p3'`.
- `codecprobe`: which value reaches a worker. A plain harness worker (`probe-worker.mjs`, module and `blob:` URL) receives an ImageBitmap (transferred, cloned), ImageData and a `{data, width, height}` record and reports its shape and a pixel read. Then `createCodec({workerFactory})` loads rapier-jxl's own worker file through `shim-<pkg>-<module>.mjs`, which adds `probe-listen.mjs` (a passive listener posting each job's input shape to a BroadcastChannel) before importing the unchanged worker. Last, the default `createCodec()` route.
- `stress`: decode ×200.

Pages heartbeat `window.__result` after each step (`done: true` at end) so a hang names its step.

## Fixture origins

| file | origin |
|---|---|
| photo.jpg | NASA AS12-46-6832 (Apollo 12), public domain; center-cropped and resized to 512×600 for capture.mjs |
| capture.mjs canvas text | NASA article paragraphs from https://www.nasa.gov/missions/apollo/apollo-12-the-pinpoint-mission/ |
| files/glyph-exact | Check-authored words "rapier jxl" / "ok encode" drawn on a synthetic canvas; exact encode |
| files/glyph-q80 | Same glyph canvas; lossy q80 |
| files/nasa-e3 | NASA AS12-46-6832 crop 640×480; encode q90 effort 3 |
| files/nasa-e7 | NASA AS12-46-6832 crop 640×480; encode q90 effort 7 |
| files/nasa-e9 | NASA AS12-46-6832 crop 640×480; encode q90 effort 9 |
| files/nasa-q80 | NASA AS12-46-6832 crop 640×480; encode q80 |
| files/nasa-upload | NASA AS12-46-6832 crop 640×480; encode q82 effort 3 |
| files/nasa-fit | NASA AS12-46-6832 crop 640×480; encode q70 |
| files/nasa-capture-exact | NASA AS12-47-6949 crop 640×400 with check-authored glyph panel; exact encode |
| files/nasa-capture-q80 | Same NASA+glyph hybrid; capture-complete q80 |
| files/nasa-96-q90 | NASA S68-26890 crop 96×64; encode q90 |
| files/nasa-96-exact | NASA S68-26890 crop 96×64; exact encode |
| files/nasa-320-q90 | NASA S68-26668 crop 320×240; encode q90 |
| files/nasa-300-exact | NASA S67-50903 crop 300×200; exact encode |
| files/nasa-300-q80 | NASA S67-50903 crop 300×200; encode q80 |
| files/node-bands-exact | Synthetic colour bands; exact encode |
| files/node-bands-q90 | Synthetic colour bands; lossy q90 |
| files/node-efforts-e1 | Synthetic 320×240; encode effort 1 |
| files/node-efforts-e3 | Synthetic 320×240; encode effort 3 |
| files/node-efforts-e5 | Synthetic 320×240; encode effort 5 |
| files/node-efforts-e7 | Synthetic 320×240; encode effort 7 |
| files/node-efforts-e8 | Synthetic 320×240; encode effort 8 |
| files/node-efforts-e9 | Synthetic 320×240; encode effort 9 |
| files/node-encode-exact | Synthetic 200×150; exact encode |
| files/node-capture-maxError-1 | Synthetic 64×48; maxError 1 |
| files/node-capture-maxError-2 | Synthetic 64×48; maxError 2 |
| files/node-capture-maxError-8 | Synthetic 64×48; maxError 8 |
| files/node-format-graphics | Synthetic 48×32 graphics format; exact |
| files/node-format-hybrid | Synthetic 48×32 hybrid format; exact |
| files/node-format-palette | Synthetic 48×32 palette format; exact |
| files/node-format-photo | Synthetic 48×32 photo format; exact |
| files/node-first-region-exact | Synthetic 320×240 region; exact |
| files/node-first-region-q90 | Synthetic 320×240 region; lossy q90 |
| files/node-grey-q80-noise-640 | Synthetic grey noise 640×480; q80 |
| files/node-grey-q80-grey-640 | Synthetic grey 640×480; q80 |
| files/node-grey-q80-dim-640 | Synthetic dim grey 640×480; q80 |
| files/node-grey-q80-dark-640 | Synthetic dark grey 640×480; q80 |
| files/node-grey-q80-grey-960 | Synthetic grey 960×720; q80 |
| files/node-grey-q80-dim-960 | Synthetic dim grey 960×720; q80 |
| files/node-grey-q80-dark-960 | Synthetic dark grey 960×720; q80 |
| files/node-variants-root-0 | Synthetic variant 320×240; lossy |
| files/node-variants-root-1 | Synthetic variant 160×120; lossy |
| files/node-variants-root-2 | Synthetic variant 64×48; lossy |
| files/node-variants-upload-0 | Synthetic upload variant 320×240; lossy |
| files/node-variants-upload-1 | Synthetic upload variant 160×120; lossy |
| files/node-variants-upload-2 | Synthetic upload variant 64×48; lossy |
| files/node-readme-capture | Synthetic 1×1; exact |

NASA sources are public-domain Apollo / Gemini stills (image ids in the table). Lossy references are djxl 0.12.0 8-bit RGBA; exact references are source pixels. Live pages (`control.mjs`, `capture.mjs`, `p3.mjs`, `codecprobe.mjs`, `stress.mjs`) draw their own pixels or load `photo.jpg` at check time.

Capture/control open 2D contexts with `willReadFrequently: true` (same as `check.mjs`); control also keeps a bare-context probe. `drive.mjs` inserts `about:blank` between pages, maximizes the window, and skips a package's capture/p3 when its control `wrf: getImageData` fails. The summary has one row per step with an 8.2.0 and a candidate column.

## SnapDOM jxl plug-in

The `safari-snapdom` job applies `snapdom-tip/plugins-jxl.patch` to SnapDOM 5eb0d80 (`snapdom/`) and runs, in real Safari, the plug-in's tests and the 32 SnapDOM demos (JPEG XL against `toWebp`, identity against the Chromium baselines in `snapdom-harness/baselines/`). Playwright WebKit on the same host runs the lifecycle tests and SnapDOM's own suite (labelled, not Safari). The package check above is unchanged.
