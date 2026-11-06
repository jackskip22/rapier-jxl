# Safari 26.0 / 26.1

**Need:** shipped Safari 26.0 or 26.1 on a Mac, iPhone, or iPad. Use the actual browser, with its normal settings.

**Package:** `rapier-jxl@8.3.0`, loaded from jsDelivr with checked hashes. **Time:** about a minute; stops after two minutes.

1. [Open the check](https://rapier.website/docs/jxl-job.html?job=safari) in Safari.
2. Check the full browser version, enter the OS version and device model, and press **Run**. Keep the page in front.
3. **Copy JSON** into a [job result issue](https://github.com/jackskip22/rapier-jxl/issues/new?template=job-result.yml). Include failures or partial results.

The fixed 64 × 48 image checks a known JPEG XL file, exact capture, and full exact encoding at effort 3. Encoded hashes must match the pinned release. Both the package decoder and Safari's native decoder must reproduce the source pixels exactly. This checks WebAssembly execution as well as native decoding.

The [result format](README.md#result-format) includes package and module hashes, input/output hashes, bytes, and times. The same page is [run.html](run.html); it generates its inputs locally and sends no results.
