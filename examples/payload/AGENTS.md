# Payload CMS + JPEG XL

Set up a Payload CMS 3 project in one command:

```sh
npx jpegxl add payload --json
```

What `add payload` writes:

- `src/jxl/index.mjs` (or `jxl/index.mjs` beside a root `payload.config.ts`): the `jxl()` Payload plug-in, `restoreOriginals(payload)` and `restoreLocalOriginals(staticDir)`.
- `src/jxl/picture.mjs` (or `jxl/picture.mjs`): `<Picture>`, `pictureProps` and `pictureHtml` for Next.js pages and components.
- `payload.config.ts`: imports `{jxl}` and appends `jxl()` to `plugins`.

Options on `jxl({...})`:

- `effort`: `1` to `9`.
- `fidelity`: `'exact'` or `{quality: 1..100}` for non-JPEG formats. JPEGs always recompress losslessly and restore the original JPEG exactly.
- `spaceSaver`: `true` queues a `jxl-space-saver` job in Payload's job queue (enabling `payload-jobs` if needed) after verifying the written `.jxl`. Running Payload's jobs (`await payload.jobs.run()`) after commit verifies the stored original and `.jxl` against the recorded upload SHA-256 and length, removes the main JPEG, and sets `doc.jxl.spaceSaved = true`. Any failure keeps the original and sets `doc.jxl.spaceSaverError`. Non-JPEG uploads and `imageSizes` renditions keep their originals in this version. Undo it at any time with `await restoreOriginals(payload)` (requires `handleUploadIfAbsent` on cloud adapters) or `await restoreLocalOriginals(staticDir)` for a local folder.
- `collections`: array of upload collection slugs or per-slug options map.

New main and rendition metadata records archive `sha256` and `filesize`. JPEG records also identify the original using `originalSha256` and `originalFilesize`. The main record includes `originalFilesize` for every supported upload.

Local publication is exclusive and accepts identical retries. A different existing companion is `JXL_INPUT`. Cloud companion uploads check existing contents before staging, but generic upload hooks do not provide atomic reservation against concurrent writers. Old recovery files are retained while a database transaction can still roll back, and a `spaceSaved` row must be restored before its image is replaced.

Payload file responses preserve native access checks, document ownership and adapter privacy policies. Original URLs keep the original representation for previews and GET byte ranges (rebuilding a Space-saver JPEG from `.jxl` when removed), while direct `.jxl` URLs remain explicit. The response varies on all selection headers and applies representation ETags, conditional requests and GET byte ranges after verification. HEAD has no body and ignores Range. Adapter-provided external URLs are governed by the provider's access and cache configuration.
