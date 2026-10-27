---
name: rapier-jxl-photography
description: Encode photographs as JPEG XL with rapier-jxl while preserving required native precision, ICC/HDR color, alpha and metadata. Choose exact masters, quality-targeted derivatives, reversible JPEG carrying or specialized format tools.
---

# JPEG XL photography

Choose according to what must survive:

| Goal | Use |
| --- | --- |
| Exact decoded samples | `rapier-jxl/effort`, quality100 |
| High-quality derivative in an existing queue | async encode from `rapier-jxl/photo` |
| Explicit perceptual target | encodeToScore from `rapier-jxl/score` |
| Original JPEG reconstruction | transcode/reconstructJPEG from `rapier-jxl/jpeg` or `jpeg-ans` |
| Native PNG16/OpenEXR source | `rapier-jxl/source` |
| ICC/custom primaries/HDR | `rapier-jxl/icc` and native typed-sample declarations |
| Exif/XMP/JUMBF | `rapier-jxl/metadata` |
| Progression, transforms, grain, channels or layers | [specialist API](../../docs/reference/API.md) |

```js
import {encode} from 'rapier-jxl/photo';
const bytes = await encode({data: rgba, width, height}, {quality: 90, effort: 9});
```

In a page, use createEncoder from `rapier-jxl/image` with the host-served photo-worker.js. Reuse it across exports and close it when finished. Inside an existing upload worker, call encode directly; do not start another queue. See the [stable integration contract](../../docs/INTEGRATION.md).

For a target, use `{target: {ssimulacra2: 85}}` or encodeToScore. The search measures its reconstructed picture; validate strict delivery thresholds using an independent decoder. It searches a defined candidate set, not every possible JPEG XL file. Compare actual complete file sizes at matched measured quality. Never compare quality-slider numbers across codecs or describe a bounded RGB error as visually lossless.

Preserve native precision before using a browser canvas: declare Uint16Array integer depth10/12/16, float16 bit patterns, or Float32Array samples. Carry the source transfer function, primaries, intensity and alpha association. Keep ICC bytes with their original pixels; do not relabel them as sRGB. An 8-bit canvas cannot preserve a high-precision master.

Keep exact originals when generating lossy derivatives. Preserve admitted JPEGs with coefficient carrying and check byte-exact reconstruction before replacing originals. Metadata edits are refused for carried JPEGs because they would invalidate reconstruction. Exif is the TIFF payload; keep orientation consistent with the pixels. Exif/XMP helpers do not automatically extract source metadata or convert color.

For repeated quality choices, createPhotoPlan reuses a transform plan and must be disposed. Its byte target selects the highest tested fitting quality, not a global optimum. Use authored exact hybrid regions for text that must remain exact, and authored layers/patches when the application already owns their geometry. Consult the API for resource limits and decoder qualifications.

Bound concurrency by memory. Honor requested effort without adding an implicit deadline. Keep outputs separate, check dimensions/sample identity or measured quality, and report only measurements from the actual tested codec, corpus and machine. [Audit and reproducible benchmarks](../../docs/CAPTURE-AUDIT.md).
