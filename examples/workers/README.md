# JPEG XL for a site on Cloudflare

A Worker in front of a site. Browsers that send `Accept: image/jxl` get a picture's JPEG XL file where one exists.
Every other browser, and every picture without one, gets the site's own response untouched. Never an error, never a
time-out.

## Workers Free

Make the JPEG XL files with the site, then put the Worker in front:

```sh
npx jpegxl public/ --keep-extension  # photo.jpg.jxl and photo.png.jxl. A JPEG restores the original JPEG
npx jpegxl add workers --route example.com/*
npm install
npx wrangler deploy
```

For `photo.jpg` the Worker serves the site's `photo.jpg.jxl` when it answers with a JPEG XL file smaller than the photo
(`x-jxl: beside`). It does no image work, so a request needs almost no CPU. A picture without one says
`x-jxl: skipped: no JPEG XL file for it`.

`--keep-extension` keeps each source's complete name, including its extension and case, even for a single file.
The Worker asks only for that name plus `.jxl`: `photo.jpg.jxl` for `photo.jpg`, and `photo.png.jxl` for `photo.png`.
It does not use a shared `photo.jxl`, which might belong to another source. A missing or invalid qualified file
keeps the original response. No requests to other source names are needed.

If the site already has common-name files such as `photo.jxl`, regenerate them with `--keep-extension` and deploy the
qualified files with the updated Worker. Existing common-name files can stay: the Worker ignores them. For one file,
`npx jpegxl photo.jpg --out photo.jpg.jxl` also writes the required name. The CLI's default names stay unchanged
when `--keep-extension` is omitted.

`add workers` writes `jxl-worker.mjs`, `jxl-space-saver.mjs` and a `wrangler.jsonc` (or adds `main` to yours). In a site
served from Workers static assets, it names the `assets` binding `ASSETS` and sets `run_worker_first`, so the Worker
reads the pictures from there. In a project with its own Worker, wrap its handler: `export default jxl(handler)`.

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

Wrangler selects rapier-jxl's `workerd` exports, which import the package's precompiled `.wasm` files. The Workers
and R2 examples use them automatically. Keep the package imports as written so runtime compilation is not needed.

- `JXL_CPU_MS`: the Worker's `limits.cpu_ms`. A picture converts only when twice its estimated CPU fits: a JPEG at effort 3 takes
  about 0.6 s and 0.26 s more per million pixels (a 12 MP photograph: 3.8 s). Otherwise it says
  `skipped: over the CPU this Worker allows`, before any work.
- `JXL_EFFORT`: 1 to 9, default 3.
- `JXL_QUALITY`: a look from 1 to 100 for PNGs. Unset keeps every sample. JPEGs always stay exact.
- A Worker has 128 MB: JPEGs over 4.2 MP convert at effort 3 at most and over 12.6 MP not at all. PNGs convert at
  effort 1 up to 2.7 MP. A picture that does not convert, or any `JXL_*` refusal, keeps the original.
- One picture converts at a time in each isolate: two would share its 128 MB.
- The `x-jxl` header and the Worker's log say what happened: `stored`, `beside`, `restored`, `converting`, or `skipped:`
  and the reason (the size, the CPU, a `JXL_*` code, `no smaller`, `restore mismatch`, that the store failed, `cut short`).
- Without the `JXL` binding, each Cloudflare location keeps its own copy in the Cache API.

## Space saver on Workers Paid

Add `--space-saver` (or set `"JXL_SPACE_SAVER": "on"` in `vars`) to store JPEGs only as exact JPEG XL:

```sh
npx jpegxl add workers --paid --space-saver --route example.com/*
node jxl-space-saver.mjs public/
```

Before an original JPEG is removed, its JPEG XL file is restored with `jpegxl/jpeg` and its SHA-256 is checked against
the stored JPEG. Any mismatch keeps the original. PNGs and all other formats keep their originals.

When a browser without JPEG XL or a share preview asks for `/photo.jpg`, the Worker rebuilds the original JPEG from
`photo.jpg.jxl` (or from R2 when `JXL_ORIGINALS` or `JXL` holds it) and serves it with `Cache-Control`, `Vary: Accept`
and representation ETags, caching rebuilt JPEGs in Cloudflare's Cache API.

To put every removed original JPEG back at any time:

```sh
node jxl-space-saver.mjs --restore public/
```

For originals stored in an R2 bucket, call `await restoreOriginals(env)` from `jxl-worker.mjs`.

These CPU and memory numbers were measured in Cloudflare's local dev server (`wrangler dev`), not yet on a deployed
Worker.

A 12 MP phone photograph's JPEG goes out 17% smaller and restores the original JPEG. A screenshot of a page of text
goes out at a fifth of its PNG, every pixel kept.

rapier-jxl is the encoder inside rapier.website, the free Markdown editor and painting app.
