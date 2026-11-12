# Edge on Windows

Why it helps: Windows on x64 and ARM, where the browser has no JPEG XL decoder.

**Need:** a Windows PC with a current Edge.

**Package:** `rapier-jxl@8.3.5` and the fixed [pictures](pictures/README.md), loaded from jsDelivr with checked hashes. **Time:** about a minute.

1. [Open an issue](https://github.com/jackskip22/rapier-jxl/issues/new?template=job-result.yml&title=Edge%20on%20Windows) titled **Edge on Windows**, so others know it is taken.
2. [Open the test page](https://rapier.website/docs/jxl-job.html?job=selftest) in that browser. Enter the browser, OS and device, and press **Run**. Keep the page in front.
3. Press **Download results** and attach the file to your issue, including failures.

The page encodes a screenshot, a photo and a camera JPEG at efforts 1, 3 and 7, decodes and verifies each, and compares every file's SHA-256 with this release's. Where the browser decodes JPEG XL itself, it also checks that its pixels match. It reads no files and sends nothing.
