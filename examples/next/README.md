# JPEG XL for next/image

For Next.js 15 and 16. `<Image>` serves JPEG XL to browsers that show it and Next's own image to the rest. No
component changes.

At the look of Next's default WebP, photographs come out 24% smaller (21% at 640 px to 30% at full size). rapier-jxl
is the encoder inside rapier.website, the free Markdown editor and painting app.

```sh
npm install --save-dev jpegxl
npx jpegxl add next
```

`add next` copies four files into the project and changes two:

- `package.json`: `"postbuild": "node rapier-jxl-next.mjs"`. After `npm run build`, it writes one JPEG XL file per width
  next/image asks for, for every JPEG and PNG in `public/` and every image the app imports, under `public/_jxl/`.
  Rapier-jxl reads and resizes each width itself, in linear light. A full-size JPEG restores exactly.
- `proxy.js` (Next 16) or `middleware.js` (Next 15): next/image's requests from a browser that sends
  `Accept: image/jxl` get the JPEG XL file. Every other request goes on to Next's optimizer, as before.

```js
// proxy.js
export {jxlProxy as proxy} from './rapier-jxl-next-proxy.mjs';
export const config = {matcher: '/_next/image'};
```

Options go on the postbuild line: `node rapier-jxl-next.mjs --quality 80 --effort 5`. The default, quality 64
at effort 3, gives the look of Next's default WebP on the median photograph. At the look of Next's AVIF
(`images.formats`), JPEG XL files are about 11% larger.

## Where it runs

- **`next start` (Node):** `proxy.js`. A picture with no JPEG XL file (one the step could not write, added later, or
  removed) goes on to Next.
- **Edge middleware:** `middleware.js` works the same. With no file system it asks for the JPEG XL file with a `HEAD`
  request first, so a picture without one goes on to Next there too.
- **Static export (`output: 'export'`):** no server chooses by `Accept`. Use a `<picture>`:

```jsx
import {getImageProps} from 'next/image';
import jxlLoader from '../rapier-jxl-next-loader.mjs';

function Picture(common) {
  const {props: {srcSet}} = getImageProps({...common, loader: jxlLoader});
  const {props} = getImageProps({...common, unoptimized: true});
  return <picture><source type="image/jxl" srcSet={srcSet} sizes={common.sizes} /><img {...props} /></picture>;
}
```

Do not set `images.unoptimized` in `next.config` for this: it makes `getImageProps` ignore the loader.

## Limits

- Remote pictures (`images.remotePatterns`) are not converted. They go to Next as before.
- A picture added to `public/` after the build has no JPEG XL file until the next build.
- Each build writes every width up to the picture's own: about 4 seconds per 5-megapixel photograph at effort 3.
  Next's optimizer instead spends 0.3 to 0.7 seconds on a WebP, 0.7 to 3.7 on an AVIF, at each width's first request.
  The files are kept in `.next/cache/rapier-jxl`, so a rebuild encodes only new or changed pictures.
