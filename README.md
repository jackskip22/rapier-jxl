# ci/safari

Safari native JPEG XL decode of the staged rapier-jxl 8.2.0 package, plus capture encode round-trip on real Safari (macos-15 + safaridriver).

Package: `rapier-jxl-8.2.0.tgz` sha256 `c966e53f402fc1811670517635d1410b712632d15df5bae969c3bb128cc4c89c`.

Fixtures are NASA public-domain photographs or pixels generated for this check.

Canvas text on `capture.html` is copied from NASA's public-domain article
[Apollo 12: The Pinpoint Mission](https://www.nasa.gov/missions/apollo/apollo-12-the-pinpoint-mission/)
(US government work).

`control.html` diagnoses canvas-read vs package capture: plain `getImageData` / `createImageBitmap` on an attached visible canvas (after `requestAnimationFrame`) and on a detached canvas, then `capture(canvas)`. Live pages heartbeat `window.__result` after each step (`done: true` at end) so a hang names its step. `capture.mjs` attaches canvases and runs every pixel read inside a stepped probe (no bare top-level `getImageData`).

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

NASA sources live under the public-domain Apollo / Gemini stills used by the team's phone bench (image ids in the table). Lossy references are djxl 0.12.0 8-bit RGBA; exact references are source pixels. Live pages (`control.mjs`, `capture.mjs`, `p3.mjs`, `stress.mjs`) draw their own pixels or load `photo.jpg` at check time.

Capture/control open 2D contexts with `willReadFrequently: true` (same as `check.mjs`); control also keeps a bare-context probe. `drive.mjs` inserts `about:blank` between pages, maximizes the window, and skips capture/p3 when control `wrf:getImageData` fails.
