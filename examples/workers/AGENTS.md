# JPEG XL for a site on Cloudflare: for coding agents

## Wire it

On Workers Free (the default), make the JPEG XL files with the site, then add the Worker in the folder of the site's
Worker project (or an empty folder, with `--route`):

```sh
npx jpegxl public/        # photo.jxl beside each photo.jpg and PNG
npx jpegxl add workers --route example.com/*
npm install
```

It writes `jxl-worker.mjs`, the wrangler config's `main` and the dependency. On Workers Paid, `--paid` also adds an R2
binding `JXL`, `JXL_CONVERT = "on"`, `JXL_CPU_MS` and `limits.cpu_ms`, so missing files are made in the Worker; then
`npx wrangler r2 bucket create <the bucket it names>`. Run it again at any time: it says `kept` for what is already
right and never overwrites an edited file. `--dry-run` prints the changes without writing; `--json` prints them as one
object.

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
first request says `converting` and a later one `stored`; use GET, since a HEAD request never starts a conversion.
`npx wrangler tail` shows each line, and each conversion's result: `rapier-jxl /photo.jpg: stored … B of … B,
effort 3, try 1, … ms` or `not stored: <reason>`. A picture that keeps saying `skipped: converting` for over a minute
was cut off by the host; the next request tries it once more, then it says `skipped: cut short`.

A JPEG's JPEG XL restores exactly: `djxl photo.jxl back.jpg && cmp back.jpg photo.jpg`.

## Do not

- Do not set `JXL_CONVERT` on Workers Free: 10 ms of CPU converts no picture (a 1 MP JPEG takes about 0.7 s).
- Do not set `JXL_CPU_MS` above the Worker's `limits.cpu_ms`: Cloudflare stops a conversion past it. The Worker
  starts only a conversion whose measured CPU (`CPU` in the file) fits `JXL_CPU_MS` twice.
- Do not raise the sizes in `FITS`: past them a conversion needs more than the isolate's 128 MB, and an isolate over
  its memory is replaced.
- Do not change the cache keys or the records: they make each picture convert once.
- Do not answer range requests or other formats from the store: they pass through on purpose.
