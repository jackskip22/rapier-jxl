# rapier-jxl tester

Open the page on a phone and tap Start. Results are kept anonymously in this Worker's database: `GET /api/jxl-results`.

## GPU test

Tap "GPU test only". It encodes a 1,280 px photo and a 12 MP camera photo at efforts 7, 8 and 9 and quality 80 with WebGPU off, required and default. It shows each encode's milliseconds, GPU use, bytes, SHA-256, adapter, GPU call times (device, pipeline, upload, read-back) and stage times. Tap "Copy results" to paste them in the chat. Allow about an hour with the page open. The 12 MP effort 9 rows come last: tap Stop at any time and Copy results keeps what finished.

Tap "Cold and second encode" for the GPU route's start-up cost: the first encode in a fresh tab, a second in the same tab, then required and off. Close the tab and open the page again before each cold run.
