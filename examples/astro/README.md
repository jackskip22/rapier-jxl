# JPEG XL for Astro

`format="jxl"` on Astro's `<Image>` and `<Picture>`, for Astro 6 and 7.

```sh
npx jpegxl add astro
```

It installs `rapier-jxl`, writes the image service into `src/jxl/` (the four `.mjs` files beside this README) and
sets `astro.config.mjs`:

```js
import {defineConfig} from 'astro/config';
import jxl from './src/jxl/index.mjs';

export default defineConfig({integrations: [jxl()]});
```

Running it again updates the files it wrote, and keeps any file you edited.

```astro
---
import {Image, Picture} from 'astro:assets';
import photo from '../assets/photo.jpg';
---
<Image src={photo} width={1200} format="jxl" alt="" />
<Picture src={photo} widths={[600, 1200]} formats={['jxl', 'avif']} fallbackFormat="webp" alt="" />
```

`<Picture>` lists JPEG XL first. A browser that does not show JPEG XL takes the next format. Every other format is
Astro's own sharp service, unchanged.

## Options

| `jxl()` option | Default | Meaning |
| --- | --- | --- |
| `effort` | `3` | 1 (fastest) to 9 (smallest). |
| `quality` | `72` | Used when the component asks none. 72 is at least the look of Astro's default WebP. |
| `jpeg` | `'pixels'` | `'exact'`: a JPEG shown at its own size with no `quality` keeps every byte. The file restores the original JPEG. |
| `maxPixels` | `12600000` on Workers | The largest picture a Worker reads on demand. Larger ones are served as they are. |

Astro's build cache keeps each file. A new rapier-jxl version or a changed option makes new files.

## Cloudflare Workers

With `@astrojs/cloudflare`, set `imageService: 'custom'` (`add astro` does it). Prerendered pages are made at build.
On-demand pages make each picture inside the Worker:

- a JPEG at its own size with `jpeg: 'exact'`, by recompression.
- A resized JPEG, PNG or other format, through the Images binding (`"images": {"binding": "IMAGES"}` in the Wrangler
  config).
- Without the binding, a PNG is resized by rapier-jxl itself.

Anything else, or any refusal, serves the original file. Each picture takes from about 0.2 s (1 MP) to 1.5 s (12 MP)
of CPU time: on the Free plan's 10 ms, make pictures at build.

## What breaks

| Where | What happens |
| --- | --- |
| A config that is not plain JavaScript | `add astro` stops with `JXL_SETUP` and the two lines to add by hand. |
| Cloudflare with another `imageService` | `add astro` keeps it and says so. `format="jxl"` then works on prerendered pages only. |
| No `sharp` at build | Astro's own error. `add astro` installs it. |
| A Worker on the Free plan | The request exceeds 10 ms of CPU. |

On 200 open photographs and screenshots, the files are 23% smaller than Astro's default WebP with at least its look, and the build takes 1.8 times as long. With `jpeg: 'exact'`, JPEGs are 17% smaller and restore exactly.

rapier-jxl is the encoder inside rapier.website, the free Markdown editor and painting app.
