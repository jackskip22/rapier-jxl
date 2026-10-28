# SnapDOM → JPEG XL

An offline demo of `rapier-jxl/snapdom`, the SnapDOM 3 plug-in in this package. It adds `result.toJxl()`:

```js
import { snapdom } from '@zumer/snapdom';
import { jxl } from 'rapier-jxl/snapdom';

const result = await snapdom(element, { plugins: [jxl()] });
const blob = await result.toJxl(); // image/jxl, exact pixels
```

The package README's SnapDOM section has the options and the measurements.

## Offline demo

[Open it in StackBlitz](https://stackblitz.com/github/jackskip22/rapier-jxl/tree/main/examples/snapdom): with this
folder alone, the page loads `rapier-jxl` from jsDelivr, so nothing is installed.

In the installed package, run `node examples/snapdom/serve.mjs` and open the printed URL. Every asset is local; module
workers need a local HTTP origin. `node examples/snapdom/smoke.mjs` (Playwright) captures, cancels a 4K capture and
captures again, and checks each file against SnapDOM's canvas with `rapier-jxl/decode`.

`vendor/README.md` lists the demo assets and their licenses.
