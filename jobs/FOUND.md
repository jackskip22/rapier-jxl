# Found

What testing on each machine has found, and what changed. Answered jobs add their findings here.

## Safari (WebKit)

- Page captures through SnapDOM missed exact text in two places: a clipped area and a drop cap. Fixed: every text pixel is now covered in WebKit, Firefox and Chromium.
- Open: some WebKit builds before Safari 26.2 miscompiled the encoder's WebAssembly calls. Safari 26.2 and later are clean; 26.0 and 26.1 are untested. The [Safari](safari-mac.md) and [iPhone or iPad](iphone-ipad.md) jobs settle it.

## Firefox

- Firefox 158 decodes JPEG XL itself, with no settings changed. The test page checks its pixels against ours.

## Chrome and Firefox

- Both decode our lossy files to within one or two levels of rapier-jxl's own decoder.

## Node, Deno, Bun, Chromium and Cloudflare Workers

- The self-test writes 15 identical files in all five on Linux x64.
