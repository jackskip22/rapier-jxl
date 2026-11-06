# Desktop WebGPU

**Need:** a desktop graphics card and a browser with hardware WebGPU enabled. Any OS. Enter the GPU model; software adapters do not qualify.

**Package:** `rapier-jxl@8.3.0`, loaded from jsDelivr with checked hashes. **Time:** allow up to 10 minutes; **Stop** keeps partial results.

1. [Open the check](https://rapier.website/docs/jxl-job.html?job=desktop-gpu).
2. Enter the browser, OS, device, and GPU versions/model, and press **Run**. Keep the page in front and other GPU work idle.
3. **Copy JSON** into a [job result issue](https://github.com/jackskip22/rapier-jxl/issues/new?template=job-result.yml), even if the GPU is slower or unavailable.

The full encoder runs one fixed 512 × 384 image at quality 82 and efforts 7, 8, and 9, with `webgpu: false` and `webgpu: 'required'`. Each route has one warmup and three timed runs, with the order alternated. Every output hash must match its CPU pair. GPU queue submissions are counted; an available adapter alone does not establish GPU work.

The [result format](README.md#result-format) records adapter details, bytes, hashes, every time, and median speedup for this fixture. `unqualified` means GPU activity could not be established or the adapter is software or unidentified. The same page is [run.html](run.html); it reads no files and sends no results.
