# Bun

Why it helps: Bun on your OS and CPU.

**Need:** Bun 1.2 or later on any OS.

**Package:** `rapier-jxl@8.3.4`. The fixed [pictures](pictures/README.md) download from jsDelivr with checked hashes. **Time:** under a minute on a desktop.

1. [Open an issue](https://github.com/jackskip22/rapier-jxl/issues/new?template=job-result.yml&title=Bun) titled **Bun**, so others know it is taken.
2. In an empty folder, run:

   ```sh
   bunx rapier-jxl@8.3.4 selftest
   ```

3. Attach the file it writes, `rapier-jxl-selftest-bun.json`, to your issue, including failures.

The command encodes a screenshot, a photo and a camera JPEG at efforts 1, 3 and 7, decodes and verifies each, and compares every file's SHA-256 with this release's. The file records the OS, CPU, cores, memory, runtime version, the WebGPU adapter where present, the times and every pass or failure. It writes one file and sends nothing.
