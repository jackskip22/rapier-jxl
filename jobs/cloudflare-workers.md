# Cloudflare Workers

Why it helps: Cloudflare's runtime, run locally with `wrangler dev`.

**Need:** Node 20 or later, to run `wrangler dev` (Cloudflare's local Workers runtime). No account is needed.

**Package:** `rapier-jxl@8.3.4` from npm; the fixed [pictures](pictures/README.md) are bundled into the Worker. **Time:** a few minutes, most of it the install; the test itself takes under a minute on a desktop.

1. [Open an issue](https://github.com/jackskip22/rapier-jxl/issues/new?template=job-result.yml&title=Cloudflare%20Workers) titled **Cloudflare Workers**, so others know it is taken.
2. Copy the [cloudflare-workers](cloudflare-workers/) and [pictures](pictures/) folders side by side, then in `cloudflare-workers/` run:

   ```sh
   npm install
   npx wrangler dev
   ```

3. Open http://localhost:8787. It runs the test and downloads `rapier-jxl-selftest-workerd.json`. Attach it to your issue, including failures.

The Worker encodes a screenshot, a photo and a camera JPEG at efforts 1, 3 and 7, decodes and verifies each, and compares every file's SHA-256 with this release's. It sends nothing.
