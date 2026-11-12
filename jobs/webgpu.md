# WebGPU on your graphics card

Why it helps: an identical file and its speed on every kind of GPU.

**Need:** a browser with hardware WebGPU (Chrome, Edge or Safari 26) on a desktop, laptop, tablet or phone. Software adapters do not qualify.

**Package:** `rapier-jxl@8.3.5` and the fixed [photo](pictures/README.md), loaded from jsDelivr with checked hashes. **Time:** up to 10 minutes; **Stop** keeps partial results.

1. [Open an issue](https://github.com/jackskip22/rapier-jxl/issues/new?template=job-result.yml&title=WebGPU%20on%20your%20graphics%20card) titled **WebGPU on your graphics card**, and name the GPU in its first line.
2. [Open the test page](https://rapier.website/docs/jxl-job.html?job=webgpu). Enter the browser, OS, device and GPU, and press **Run**. Keep the page in front and other GPU work idle.
3. Press **Download results** and attach the file to your issue, even if the GPU is slower or unavailable.

The page encodes the 768 × 512 photo at quality 90 and efforts 7 and 8, with `webgpu: false` and `webgpu: 'required'`: one warmup and three timed runs each, the order alternated. Every GPU file must be identical to its CPU file, and effort 7 must match this release's. GPU queue submissions are counted, so an adapter alone is not GPU work. `unqualified` means GPU work could not be established or the adapter is software or unknown.
