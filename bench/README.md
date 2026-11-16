# Benchmarks behind the README

Each measured line in the README has its script here. Install the tools a script names beside `jpegxl`, and set
`JXL_DJXL` and `JXL_SSIMULACRA2` to libjxl's `djxl` and `ssimulacra2` (libjxl 0.13.0) for the look.

## Astro

```sh
node bench/astro.mjs node_modules pictures/ out/astro
node bench/jpeg-exact.mjs node_modules pictures/
```

`astro.mjs` builds one page of every picture at 600 and 1200 px, with Astro's default WebP and with `format="jxl"`,
then compares each pair. Photos are the files that are not exact. Pictures: Kodak's 24 and 76 openly licensed
photographs, charts and screenshots, 200 files. Astro 7, sharp 0.35.

| Measured | Result |
| --- | --- |
| Photos, 150 files | 23.8% smaller than WebP on average. Look 75.3 against WebP's 74.4, lower on 64 of 150. |
| JPEGs, exact | 17.9% smaller. Every file restores exactly. |

## Vite

```sh
node bench/vite.mjs node_modules pictures/
node bench/jpeg-exact.mjs node_modules jpegs/
```

Each PNG at the plug-in's default, quality 90, against sharp's WebP and AVIF at the smallest quality with the same
SSIMULACRA 2. Pictures: Kodak 23 and 11 phone photographs at 2,560 px.

| Measured | Result |
| --- | --- |
| Photos | 39.2% smaller than WebP, 11.4% smaller than AVIF, at the same look. |
| Camera JPEGs, exact | 17.3% smaller. Every file restores exactly. |

## Cloudflare Workers

```sh
node bench/jpeg-exact.mjs node_modules phone-jpegs/
```

What `npx jpegxl public/ --out public/` writes for each JPEG, at effort 3. Phone photographs of 12 to 46.5 MP.

| Measured | Result |
| --- | --- |
| Phone JPEGs, exact | 17.9% smaller (median). Every file restores exactly. |

