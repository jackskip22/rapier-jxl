# rapier-jxl in an Astro site: for coding agents

**Wire it:** run `npx jpegxl add astro` in the site folder (`--dry-run` first to see the plan, `--json` for one
JSON object). It installs `rapier-jxl` (and `sharp` if missing), writes the image service into `src/jxl/`, adds
`import jxl from './src/jxl/index.mjs'` and `jxl()` to `integrations`, and on `@astrojs/cloudflare` sets
`imageService: 'custom'`. Running it again updates only the `src/jxl/` files nobody edited.
Then add `format="jxl"` to `<Image>`, or `formats={['jxl', ...]}` with a `fallbackFormat` to `<Picture>`.

**Check it worked:** `astro build` logs each `….jxl (before: …kB, after: …kB)`; the built HTML has
`<source type="image/jxl">` before the other sources. In `astro dev`, `/_image?…&f=jxl` answers `image/jxl`.

**Do not:**
- edit `src/jxl/` to change a setting: pass options to `jxl({...})` in the config;
- replace a person's own `image.service` or Cloudflare `imageService`; `add astro` refuses and says why;
- use `<Image format="jxl">` alone where browsers without JPEG XL must see the picture: use `<Picture>` with a fallback;
- set `jpeg: 'exact'` to make pages small: it keeps the JPEG's bytes (about a fifth smaller), not a smaller look;
- count on on-demand images on Workers Free (10 ms of CPU): make them at build.

**Errors:** `JXL_SETUP` from `add astro` ends with "Fix:" and the step. A build error names the picture and the
`JXL_*` code. On Workers, a refusal is a warning in the log and the original file is served.
