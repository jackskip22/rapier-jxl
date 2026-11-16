# JPEG XL for a site on Cloudflare

A Worker in front of a site. Browsers that send `Accept: image/jxl` get a picture's JPEG XL file where one exists;
every other browser, and every picture without one, gets the site's own response untouched. Never an error, never a
time-out.

## Workers Free

Make the JPEG XL files with the site, then put the Worker in front:

```sh
npx jpegxl public/            # photo.jxl beside each photo.jpg and PNG; a JPEG restores exactly
npx jpegxl add workers --route example.com/*
npm install
npx wrangler deploy
```

For `photo.jpg` the Worker serves the site's `photo.jxl` when it answers with a JPEG XL file smaller than the photo
(`x-jxl: beside`). It does no image work, so a request needs almost no CPU. A picture without one says
`x-jxl: skipped: no JPEG XL file for it`.

`add workers` writes this folder's `jxl-worker.mjs` and a `wrangler.jsonc` (or adds `main` to yours). In a site served
from Workers static assets, it names the `assets` binding `ASSETS` and sets `run_worker_first`, so the Worker reads the
pictures from there. In a project with its own Worker, wrap its handler: `export default jxl(handler)`.

## Workers Paid: converting in the Worker

`npx jpegxl add workers --paid` also makes the missing files in the Worker and keeps them in R2:

```jsonc
{
  "name": "jxl",
  "main": "jxl-worker.mjs",
  "compatibility_date": "2026-10-01",
  "routes": [{"pattern": "example.com/*", "zone_name": "example.com"}],
  "r2_buckets": [{"binding": "JXL", "bucket_name": "jxl"}],
  "vars": {"JXL_CONVERT": "on", "JXL_CPU_MS": "30000"},
  "limits": {"cpu_ms": 30000}
}
```

Each picture converts once, after the first such request has had the original: JPEGs recompressed without loss, PNGs
exact. Run `npx wrangler r2 bucket create <the bucket it names>` before deploying.

- `JXL_CPU_MS`: the Worker's `limits.cpu_ms`. A picture converts only when twice its CPU meetsTarget: a JPEG at effort 3 takes
  about 0.6 s and 0.26 s more per million pixels (a 12 MP photograph: 3.8 s). Otherwise it says
  `skipped: over the CPU this Worker allows`, before any work.
- `JXL_EFFORT`: 1 to 9, default 3.
- `JXL_QUALITY`: a look from 1 to 100 for PNGs; unset keeps every sample. JPEGs always stay exact.
- A Worker has 128 MB: JPEGs over 4.2 MP convert at effort 3 at most and over 12.6 MP not at all; PNGs convert at
  effort 1 up to 2.7 MP. A picture that does not convert, or any `JXL_*` refusal, keeps the original.
- One picture converts at a time in each isolate: two would share its 128 MB.
- The `x-jxl` header and the Worker's log say what happened: `stored`, `beside`, `converting`, or `skipped:` and the
  reason (the size, the CPU, a `JXL_*` code, `no smaller`, that the store failed, `cut short`).
- Without the `JXL` binding, each Cloudflare location keeps its own copy in the Cache API.

These CPU and memory numbers were measured in Cloudflare's local dev server (`wrangler dev`), not yet on a deployed
Worker.

A 12 MP phone photograph's JPEG goes out 17% smaller and restores exactly. A screenshot of a page of text
goes out at a fifth of its PNG, every pixel kept.

rapier-jxl is the encoder inside rapier.website, the free Markdown editor and painting app.
