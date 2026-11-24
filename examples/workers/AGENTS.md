# JPEG XL for a site on Cloudflare: for coding agents

## Wire it

On Workers Free (the default), make the JPEG XL files with the site, then add the Worker in the folder of the site's
Worker project (or an empty folder, with `--route`):

```sh
npx jpegxl public/ --keep-extension  # photo.jpg.jxl and photo.png.jxl beside their originals
npx jpegxl add workers --route example.com/*
npm install
```

It writes `jxl-worker.mjs`, `jxl-space-saver.mjs`, the wrangler config's `main` and the dependency. On Workers Paid,
`--paid` also adds an R2 binding `JXL`, `JXL_CONVERT = "on"`, `JXL_CPU_MS` and `limits.cpu_ms`, so missing files are
made in the Worker. Add `--space-saver` with `--paid` to set `JXL_SPACE_SAVER = "on"` and store JPEGs only as exact
JPEG XL after restoring and checking the SHA-256 against the stored JPEG. Other formats keep their originals. Run
`node jxl-space-saver.mjs public/` to retire JPEGs in a static folder, and `node jxl-space-saver.mjs --restore public/`
(or `restoreOriginals(env)` in R2) to rebuild every removed original JPEG. Then run
`npx wrangler r2 bucket create <the bucket it names>`. Run `add workers` again at any time: it says `kept` for what is
already right and never overwrites an edited file. `--dry-run` prints the changes without writing. `--json` prints them
as one object.

When the project already has a Worker (`main` names another file), wrap its handler instead of replacing it:

```js
import {jxl} from './jxl-worker.mjs';
export default jxl(handler); // handler: the object the file exported before
```

## Check it worked

```sh
npx wrangler dev
curl -s -o /dev/null -D - -H 'Accept: image/jxl' http://localhost:8787/photo.jpg  # image/jxl, x-jxl: beside
curl -s -o /dev/null -D - http://localhost:8787/photo.jpg                         # always the site's own response
```

A picture without a file says `x-jxl: skipped: no JPEG XL file for it` and gets the original. With `--paid`, the
first request says `converting` and a later one `stored`. With `--space-saver`, a browser without JPEG XL or a share
preview asking for a removed JPEG gets the rebuilt original JPEG with `x-jxl: restored`, `Cache-Control` and
`Vary: Accept`. Use GET, since a HEAD request never starts a conversion.
`npx wrangler tail` shows each line, and each conversion's result: `rapier-jxl /photo.jpg: stored … B of … B,
effort 3, try 1, … ms` or `not stored: <reason>`. A picture that keeps saying `skipped: converting` for over a minute
was cut off by the host. The next request tries it once more, then it says `skipped: cut short`.

A JPEG's JPEG XL restores the original JPEG: `djxl photo.jpg.jxl back.jpg && cmp back.jpg photo.jpg`.

The Worker serves only the exact original name plus `.jxl`. A common `photo.jxl` has no source identity and is
ignored, even when the qualified file is missing or invalid. Regenerate older common-name outputs with
`--keep-extension` before deploying the updated Worker. For one file, `--out photo.jpg.jxl` also works. The CLI's
names without this flag stay unchanged. Do not add origin probes or infer ownership from a common name.

## Do not

- Do not set `JXL_CONVERT` or `JXL_SPACE_SAVER` on Workers Free: 10 ms of CPU cannot convert or rebuild a picture.
- Do not set `JXL_CPU_MS` above the Worker's `limits.cpu_ms`: Cloudflare stops a conversion past it. The Worker
  starts only a conversion whose measured CPU (`CPU` in the file) fits `JXL_CPU_MS` twice.
- Do not raise the sizes in `FITS`: past them a conversion needs more than the isolate's 128 MB, and an isolate over
  its memory is replaced.
- Do not change the cache keys or the records: they make each picture convert once.
- Do not remove non-JPEG originals: PNGs and other formats always keep their originals.
