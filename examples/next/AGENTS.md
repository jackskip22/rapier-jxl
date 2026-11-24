# Adding JPEG XL images to a Next.js project

## Wire it

In the folder with the project's `package.json` (Next.js 15 or 16):

```sh
npm install --save-dev jpegxl
npx jpegxl add next --dry-run --json   # what it would change
npx jpegxl add next --json
```

It copies `rapier-jxl-next.mjs`, `rapier-jxl-next-proxy.mjs`, `rapier-jxl-next-loader.mjs` and `rapier-jxl-files.mjs`,
adds `"postbuild": "node rapier-jxl-next.mjs"` to `package.json`, and writes `proxy.js` (Next 16) or `middleware.js`
(Next 15). No `<Image>` changes. Running it again changes nothing.

- If the project already has a `proxy` or `middleware` file, `add next` leaves it: call `jxlProxy(request)` at its top
  and return its response when it gives one, and add `'/_next/image'` to its `matcher`.
- If `package.json` already has a `postbuild` script, append `&& node rapier-jxl-next.mjs` to it.
- With `output: 'export'` there is no server to choose by `Accept`: use `rapier-jxl-next-loader.mjs` in a `<picture>`
  as its first lines show (`getImageProps` twice: once with the loader, once with `unoptimized`).

## Check it worked

- `npm run build` ends with `rapier-jxl: N pictures, M JPEG XL files in public/_jxl`.
- With `npx next start`: `curl -H 'Accept: image/jxl' -I 'localhost:3000/_next/image?url=/<picture>.jpg&w=640&q=75'`
  answers `content-type: image/jxl`. With `Accept: image/webp`, `image/webp` as before.

## Do not

- Do not set `images.loader` or `images.unoptimized` for this: the proxy works with Next's own loader.
- Do not commit `public/_jxl/`: the build writes it (`add next` puts it in `.gitignore`).
- Do not put `export const config` in a re-export line: Next reads a proxy's `config` only where it is declared.
- Do not edit the copied files to change options. Pass them in the postbuild script: `node rapier-jxl-next.mjs --quality 80 --effort 5`.
