# JPEG XL images for Vite

A Vite 6, 7 or 8 plug-in. An image import becomes a JPEG XL file at build; the original stays for browsers that do not
show JPEG XL.

Photographs come out 39% smaller than WebP and 11% smaller than AVIF at the same look, in the time WebP takes. JPEGs
come out 17% smaller and restore exactly. rapier-jxl is the encoder inside rapier.website, the free Markdown editor
and painting app.

```sh
npm install --save-dev jpegxl
npx jpegxl add vite
```

`add vite` copies `rapier-jxl-vite.mjs` into the project and adds `jxl()` to `plugins` in the Vite config. By hand:

```js
// vite.config.js
import {defineConfig} from 'vite';
import {jxl} from './rapier-jxl-vite.mjs';

export default defineConfig({plugins: [jxl()]});
```

```js
import hero, {original} from './hero.jpg?jxl';

element.innerHTML = `<picture>
  <source srcset="${hero}" type="image/jxl">
  <img src="${original}" alt="">
</picture>`;
```

The browser takes the first `<source>` whose type it shows and falls back to the `<img>`. `hero` is the JPEG XL
file's URL and `original` the original's, both as Vite writes asset URLs (with `base`).

## What each file becomes

- **JPEG**: kept exactly. The JPEG XL file restores the JPEG exactly, about a fifth smaller, and needs no decoder at
  build time.
- **PNG**: encoded at `fidelity` (default `{quality: 90}`), or `'exact'` for screenshots and diagrams.
- **JPEG at a quality**: pass `read`, your own decoder returning 8-bit RGBA; Node has no JPEG decoder of its own.

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `fidelity` | `{quality: 90}` | As rapier-jxl's `encode`: `'exact'` or `{quality}` from 1 to 100. JPEGs without `read` stay exact. |
| `effort` | `3` | 1 (fastest) to 9 (smallest). 3 takes about as long as sharp's WebP; 7 writes photographs about 12% smaller in about 20 times the time. |
| `folder` | none | Folders whose JPEG and PNG files each get a `.jxl` beside them, named as Vite names the original (`hero-B2x.jpg` gets `hero-B2x.jxl`); the public folder too. |
| `read` | none | `(bytes, file) => ({width, height, data})`: decodes any source; JPEGs are then encoded at `fidelity`. |
| `cache` | `true` | Keeps each file in Vite's cache folder, keyed by the source, these options and the rapier-jxl version. |

`folder` suits a server that picks the file by the browser's `Accept: image/jxl` header, or a `<picture>` whose
source is the original's URL with `.jxl`. Use either `folder` or `?jxl` for a given file; both write a copy each.

In dev, `?jxl` and `folder` files are written on first request and served as `image/jxl`.

## TypeScript

`add vite` writes `rapier-jxl-vite.d.mts` beside the plug-in and `src/rapier-jxl-images.d.ts`, which types `?jxl`
imports. By hand, copy `index.d.ts` as `rapier-jxl-vite.d.mts` and `client.d.ts` into a folder the app's tsconfig
includes.

## Errors

A `?jxl` file the encoder refuses stops the build with the file's name, the code and the fix, such as `JXL_MEMORY`
for a picture past the host's memory. A `folder` file that fails is left as it is, with a warning; its
original still serves.

## Encoding in the browser

rapier-jxl's workers start in Vite 6, 7 and 8 as installed, in dev and in build, with no Vite setting.
