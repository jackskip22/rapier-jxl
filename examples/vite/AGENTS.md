# Adding JPEG XL images to a Vite project

## Wire it

In the folder with the project's `package.json`:

```sh
npm install --save-dev jpegxl
npx jpegxl add vite --dry-run --json   # what it would change
npx jpegxl add vite --json
```

It copies `rapier-jxl-vite.mjs` (and, with a tsconfig, its `.d.mts` and `src/rapier-jxl-images.d.ts`) and adds
`jxl()` to `plugins` in `vite.config.*`. A project that lists only `vite-plus` uses the same command. Running it again
changes nothing. If it stops with `JXL_SETUP`, make the edit its `Fix:` names. The config was left as it was.

Then change an image import where the page shows a photograph:

```js
import hero, {original} from './hero.jpg?jxl';
// <picture><source srcset={hero} type="image/jxl"><img src={original} alt="..."></picture>
```

Keep the `<img>` with the original: browsers without JPEG XL show it.

## Check it worked

- `npx vite build` lists a `.jxl` asset for each `?jxl` import, beside the original.
- For a JPEG source without a width or `read`, `djxl hero.jxl out.jpg` gives a file identical to the original (`cmp`).
- In dev, the `?jxl` URL answers `Content-Type: image/jxl`.

## Do not

- Do not replace the `<img>` original with the `.jxl` URL: Edge and older browsers show nothing.
- Do not add `optimizeDeps`, `worker` or `assetsInclude` settings for rapier-jxl: Vite 6, 7 and 8 need none.
- Do not edit `rapier-jxl-vite.mjs` to change options. Pass them: `jxl({effort: 5, fidelity: {quality: 85}})`.
  An edited copy is never updated by `add vite`.
- Do not use both `folder` and `?jxl` for the same file: each writes its own copy.
