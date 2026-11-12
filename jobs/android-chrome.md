# Android phone in Chrome

Why it helps: ARM phones, especially older and low-memory ones.

**Need:** an Android phone with a current Chrome. Older and low-memory phones help most.

**Package:** `rapier-jxl@8.3.4` and the fixed [pictures](pictures/README.md), loaded from jsDelivr with checked hashes. **Time:** 2 to 5 minutes.

1. [Open an issue](https://github.com/jackskip22/rapier-jxl/issues/new?template=job-result.yml&title=Android%20phone%20in%20Chrome) titled **Android phone in Chrome**, so others know it is taken.
2. [Open the test page](https://rapier.website/docs/jxl-job.html?job=selftest) in that browser. Enter the browser, OS and device, and press **Run**. Keep the page in front.
3. Press **Download results** and attach the file to your issue, including failures.

The page encodes a screenshot, a photo and a camera JPEG at efforts 1, 3 and 7, decodes and verifies each, and compares every file's SHA-256 with this release's. Where the browser decodes JPEG XL itself, it also checks that its pixels match. It reads no files and sends nothing.
