# Adding JPEG XL images to a Netlify site

## Wire it

In the folder with the site's `package.json`:

```sh
npm install --save-dev jpegxl
npx jpegxl add netlify --dry-run --json   # what it would change
npx jpegxl add netlify --json
```

It copies the plug-in to `netlify/plugins/rapier-jxl/` and adds a `[[plugins]]` entry to `netlify.toml`. Running it
again changes nothing. No page changes: the same picture addresses serve JPEG XL to browsers that ask for it.

## Check it worked

- `npx netlify build` (or a deploy log) shows `rapier-jxl: N pictures have a JPEG XL copy` and an edge function named
  `rapier-jxl`.
- `curl -H 'Accept: image/jxl' -I https://<site>/<picture>.jpg` answers `content-type: image/jxl`; without that header,
  `image/jpeg`.
- For a JPEG, `djxl hero.jxl out.jpg` gives a file identical to the original (`cmp`).

## Do not

- Do not add `_redirects` rules for `.jxl`: redirects cannot read `Accept`, and would send every browser the JPEG XL file.
- Do not edit the copied files to change options; set `[plugins.inputs]` in `netlify.toml`.
- Do not link `.jxl` files from pages directly: Edge and older browsers show nothing.
