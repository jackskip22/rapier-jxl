# Safari lossy native-decode rows

One row per Kodak lossy JPEG XL file: page and dedicated-worker `createImageBitmap(Blob, image/jxl)`, 8-bit `OffscreenCanvas` readback, largest sample difference against rapier-jxl `decode({format:'uint8', colorSpace:'srgb'})`. Evidence for capture margin — not a product fallback decoder.

## Fixture origins

| path | origin |
|---|---|
| files/kodimNN-qQQ-eE.jxl | Kodak PhotoCD PCD0992 (public-domain test images), encoded with rapier-jxl `encode()` quality 80/92 × effort 3/5/7 from an 8.3.0 development build (the same files as the Chrome and Firefox rows) |

No Gutenberg material.

## Subset switch

Default: all 144 files. For CI time risk set `SUBSET=24` (env) or open `index.html?subset=24` — the 24 stems `kodim01..24-q80-e3`.
