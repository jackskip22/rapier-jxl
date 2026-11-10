# Self-test pictures

The fixed pictures `npx rapier-jxl selftest`, [run.html](../run.html) and the [Cloudflare Workers job](../cloudflare-workers.md) encode. [manifest.json](manifest.json) holds each file's SHA-256, its decoded pixels' SHA-256 and the SHA-256 every row must produce in this release.

| File | Picture | Author | License |
| --- | --- | --- | --- |
| `screenshot-mdn.png` | [MDN Web Docs, Canvas API](https://developer.mozilla.org/en-US/docs/Web/API/Canvas_API), 1920 × 1080, captured in Chrome | Mozilla Contributors | [CC BY-SA 2.5](https://creativecommons.org/licenses/by-sa/2.5/) |
| `photo-kodim23.png` | [Kodak](https://r0k.us/graphics/kodak/) kodim23, 768 × 512 | Eastman Kodak | Released for unrestricted use |
| `camera-iphone16.jpg` | [Juvenile Atlantic Ghost Crab, Kitty Hawk](https://commons.wikimedia.org/wiki/File:2026-09-10_0953_Juvenile_Atlantic_Ghost_Crab_along_the_beach_in_Kitty_Hawk,_North_Carolina.jpg), iPhone 16 original, 4032 × 3024 | TheDetroitGeographer | [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) |

The PNGs are 8-bit RGB with no color chunks; their pixels are the originals'. The JPEG is the camera's file, unchanged.
