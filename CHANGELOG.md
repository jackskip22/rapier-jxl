# Changelog

## 7.1.0 (2026-10-28)

- New `rapier-jxl/snapdom`: a SnapDOM 3 plug-in that adds `result.toJxl()`.
- Loads from a CDN, such as jsDelivr. A Content Security Policy there needs `worker-src blob:`.
- If a helper cannot load, for example in a Next.js server route, the job finishes without it, with the same bytes.
- Faster first upload with `helpers`.
- Smaller screenshots, still exact: `rapier-jxl/capture`, and `encode` on screen content, write files 4–8% smaller
  than 7.0.0, and smaller than lossless WebP (`cwebp -lossless -m 4 -exact`) on every screenshot we measured.
- Faster effort 3 and effort 7, with the same files for photos.
- Faster decoding of pictures with a color profile, with the same pixels.
- Faster lossy encoding at efforts 1–3 of photos with a color profile, Display P3 included.
- Smaller JPEG recompression at efforts 2 to 6, and `recompress` now uses `acceleration: 'auto'` by default; pass
  `'js'` to keep it to JavaScript.
- Damaged or hostile files get a coded refusal within your limits: the decoder, JPEG recompression and metadata
  containers bound the memory and time they spend.
- Encoder inputs are bounded too: a PNG color profile over 16 MiB, a detached buffer or a record with too many fields is
  refused with a code.
- Fixed: white in a lossy photo no longer decodes black near quality 100.
- Fixed: a JPEG whose scan names a Huffman table above 3 is refused with `JXL_JPEG`.
- Fixed: `recompress` refuses a malformed JPEG (an empty Huffman table, an overfull code length, too many zero runs)
  with `JXL_JPEG` instead of hanging.
- `rapier-jxl/decode` refuses a file over 65,536 pixels a side, or over 536,870,912 samples across its frames and
  preview, with `JXL_DECODE`; raise `maxDimension` or `maxTotalSamples` to allow it.
- `rapier-jxl/worker` runs as a Node `worker_threads` worker.
- `rapier-jxl/offline` takes ImageData, a canvas or an ImageBitmap.
- `prepare()` on a queue starts its worker before the first job.
- `restore()` refuses an option it does not take.
- The encoder's own failures carry a `JXL_` code.
- README: Next.js `serverExternalPackages`, Angular CLI and Bun.

## 7.0.0 (2026-10-28)

- Breaking: a new API replaces 6.x.
- `encode(picture, options)`, and `createEncoder(limits)`: a queue with progress, cancel and byte, pixel and job limits.
- `helpers` in `createEncoder` encode in parallel, with the same bytes.
- New entries: `rapier-jxl/capture`, `/jpeg`, `/decode`, `/animation`, `/metadata`, `/format` and `/offline`.
- `rapier-jxl/decode` decodes JPEG XL in browsers that cannot.
- Node `^20.16.0 || >=22.3.0`, Deno and Bun.
