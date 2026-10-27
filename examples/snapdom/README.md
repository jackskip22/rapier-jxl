# SnapDOM → JPEG XL

Copy `jxl-export.mjs` into a SnapDOM 3 plugin. The host supplies one encoder and closes it when finished.

```js
import { snapdom } from '@zumer/snapdom';
import { createEncoder } from 'rapier-jxl/image';
import { jxlExport } from './jxl-export.mjs';

const encoder = createEncoder({
  worker: () => new Worker('/assets/capture-worker.js', { type: 'module' }),
});
const result = await snapdom(element, { plugins: [jxlExport({ encoder })] });
const blob = await result.toJxl(); // image/jxl, exact pixels
// await result.toJxl({ maxError: 1, signal }); // optional bounded RGB error
// Upload blob, or download it using an object URL. Revoke that URL afterwards.
encoder.close();
```

Serve the package's `dist/capture-worker.js` at that local asset URL. Bundlers may instead supply their own worker factory.

`result.toJxl()` follows SnapDOM's custom-export convention. The plugin uses its captured canvas facade;
it never recaptures the live element. Export sizing, transparency, and export hooks remain SnapDOM's job.
`maxError`, `gpu`, `signal`, and `onProgress` go to the encoder. Encoder and rasterization errors reject the export.
No internal Rapier module or worker message is part of the adapter.

## Offline demo

Run `npm run build`, then `node examples/snapdom/serve.mjs`. Open the printed local URL.
All demo assets are included; the server needs no internet. A local HTTP origin is needed for module workers.

## Tests and corpus

`node --test test/snapdom-plugin.test.mjs` tests the adapter without a browser.
`npm run build && npm run test:snapdom` checks the real pinned SnapDOM bundle and all three built workers.
Set `CHROMIUM` to a local Chrome executable if Playwright's browser is not installed.
`WEBGPU_SOFTWARE=1` validates shader correctness using SwiftShader; its timings are not hardware GPU results.
`node examples/snapdom/smoke.mjs` checks the offline demo, cancels a running 4K job, and verifies the next capture succeeds.
`node bench/capture/snapdom-fixtures.mjs` regenerates five captures and browser PNG/WebP timings.

Source studied: [plugin spec](https://github.com/zumerlab/snapdom/blob/f7bb642d83ece9f6efdca0825ab87bb7b2274650/PLUGIN_SPEC.md),
[`defineExports` implementation](https://github.com/zumerlab/snapdom/blob/f7bb642d83ece9f6efdca0825ab87bb7b2274650/src/api/snapdom.js),
and the upstream GIF/video exporters. See `vendor/README.md` for offline asset pins and licenses.
This is a reference plugin, not a separately published npm package.
