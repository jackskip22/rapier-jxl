# JPEG XL images on Netlify

A Netlify build plug-in. After the site's build, every JPEG and PNG it publishes gets a JPEG XL copy beside it, and
browsers that show JPEG XL get that copy at the same address. Everyone else gets the original.

JPEGs come out about a fifth smaller and restore exactly. rapier-jxl is the encoder inside rapier.website, the free
Markdown editor and painting app.

```sh
npm install --save-dev jpegxl
npx jpegxl add netlify
```

`add netlify` copies the plug-in into `netlify/plugins/rapier-jxl/` and lists it in `netlify.toml`:

```toml
[[plugins]]
  package = "./netlify/plugins/rapier-jxl"
  # [plugins.inputs]
  # effort = 3       # 1 (fastest) to 9 (smallest)
  # quality = 90     # PNG files; JPEG files are kept exactly
  # exact = true     # PNG files exactly: screenshots, diagrams
```

## How it serves

Netlify's redirects cannot match a request header, so the plug-in also writes an edge function. For each picture it
converted, the edge function answers a request whose `Accept` header names `image/jxl` with `hero.jxl`, and every
other request with `hero.jpg`. The responses carry `Vary: Accept` and `Netlify-Vary: header=Accept`, so Netlify's cache
never hands a JPEG XL file to a browser that did not ask for one. A picture that has no `.jxl` is never touched.

Each conversion is kept in Netlify's build cache, so a deploy encodes only new or changed pictures.

## Errors

A picture the encoder refuses (such as a picture past the host's memory, `JXL_MEMORY`) is listed in the build log and left
as it is; the deploy goes on. `hero.jpg` and `hero.png` in one folder would share `hero.jxl`: the first keeps it.
