# Offline demo assets

`snapdom.mjs`: SnapDOM 3.4.0, MIT, compiled from [f7bb642d](https://github.com/zumerlab/snapdom/tree/f7bb642d83ece9f6efdca0825ab87bb7b2274650).
`LICENSE` is its upstream license. These demo assets are not part of the encoder download.

Built with esbuild 0.28.1: entry `src/index.js`, bundle, minify, ESM, target `es2022`, no splitting;
defines `__SNAPDOM_CANVAS_ENGINE__=false`, `__SNAPDOM_VERSION__="3.4.0"`.

`nested.html` is the same commit's `demos/d8-nested-elements.html`. The fixture generator removes its scripts,
sets a 960×540 layout and explicit theme colours, then captures it with the real SnapDOM bundle.

`photo.png`: [Wesaturate CC0 sample via libjxl/testdata](https://github.com/libjxl/testdata/blob/73695d303670c90e4d506ea89d9901b081385089/external/wesaturate/500px/cvo9xd_keong_macan_srgb8.png).
[License](https://github.com/libjxl/testdata/blob/73695d303670c90e4d506ea89d9901b081385089/external/wesaturate/README.md).
SHA-256: `eb9189de8004dd0e56c5ccd8312567ae325bcef42861e2bfc86b064f4c4861b6`.
