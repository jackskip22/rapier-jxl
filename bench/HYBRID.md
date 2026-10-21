# Exact regions over photographs

`rapier-jxl/hybrid` uses standard JPEG XL layers to retain exact RGBA rectangles over a YCbCr DCT8 photograph.
Authored regions expand to 8×8 blocks; all samples in those blocks are exact. Outside them, photographic
coefficients remain identical to the same YCbCr control. Alpha is exact throughout, including hidden RGB
inside the retained regions. Automatic detection is an optional heuristic; it keeps only a smaller complete file.

## Measured sources and method

Complete Corpus v1 supplies Grace Hopper, Light interface, Drawing labels, Terminal and Control Paint 0001 at
their original dimensions. A sixth source replaces the top 512×96 rows of Grace Hopper with the corresponding
original Drawing labels crop. No source is resampled. `hybrid-results.json` records original input hashes,
composition, all 30 output hashes and all timing samples. The mixed source is a constructed use case and is
identified separately from the five original images.

Node 22.23.3, exclusively leased CPU 0, three warmups and five full synchronous calls per row. Quality 85 and
effort 3 are fixed. Input decoding and independent validation are outside the timed interval. The ordinary XYB
photo is contextual information; equal quality numbers do not establish equal perceptual quality across paths.

| Source | Encoding | Complete bytes | Median ms | Frames | Exact source samples checked |
|---|---|---:|---:|---:|---:|
| grace-hopper | ycbcr-photo-control | 45,732 | 63.616 | 1 | 0 |
| grace-hopper | ordinary-xyb-photo | 45,969 | 62.323 | 1 | 0 |
| grace-hopper | hybrid-auto | 45,732 | 133.170 | 1 | 0 |
| grace-hopper | hybrid-authored | 62,492 | 84.462 | 20 | 113664 |
| grace-hopper | ordinary-lossless | 297,027 | 47.371 | 1 | 921600 |
| ui-light | ycbcr-photo-control | 24,766 | 46.504 | 1 | 0 |
| ui-light | ordinary-xyb-photo | 24,125 | 49.044 | 1 | 0 |
| ui-light | hybrid-auto | 24,766 | 259.570 | 1 | 0 |
| ui-light | hybrid-authored | 27,026 | 101.981 | 31 | 734208 |
| ui-light | ordinary-lossless | 26,592 | 38.300 | 1 | 921600 |
| drawing-labels | ycbcr-photo-control | 13,855 | 32.408 | 1 | 0 |
| drawing-labels | ordinary-xyb-photo | 12,048 | 38.333 | 1 | 0 |
| drawing-labels | hybrid-auto | 6,063 | 177.057 | 1 | 589824 |
| drawing-labels | hybrid-authored | 8,378 | 60.045 | 17 | 534528 |
| drawing-labels | ordinary-lossless | 6,063 | 23.491 | 1 | 589824 |
| terminal-code | ycbcr-photo-control | 32,136 | 35.520 | 1 | 0 |
| terminal-code | ordinary-xyb-photo | 32,226 | 37.945 | 1 | 0 |
| terminal-code | hybrid-auto | 32,136 | 151.553 | 1 | 0 |
| terminal-code | hybrid-authored | 32,798 | 70.028 | 11 | 334848 |
| terminal-code | ordinary-lossless | 35,881 | 28.408 | 1 | 589824 |
| control-paint-0001-512x384 | ycbcr-photo-control | 68,511 | 64.737 | 1 | 196608 |
| control-paint-0001-512x384 | ordinary-xyb-photo | 64,449 | 59.663 | 1 | 196608 |
| control-paint-0001-512x384 | hybrid-auto | 68,511 | 198.861 | 1 | 196608 |
| control-paint-0001-512x384 | hybrid-authored | 70,136 | 83.334 | 25 | 466944 |
| control-paint-0001-512x384 | ordinary-lossless | 162,348 | 29.234 | 1 | 786432 |
| grace-hopper-with-drawing-labels | ycbcr-photo-control | 41,626 | 49.118 | 1 | 0 |
| grace-hopper-with-drawing-labels | ordinary-xyb-photo | 41,102 | 60.665 | 1 | 0 |
| grace-hopper-with-drawing-labels | hybrid-auto | 39,488 | 189.614 | 7 | 129024 |
| grace-hopper-with-drawing-labels | hybrid-authored | 39,325 | 64.698 | 2 | 147456 |
| grace-hopper-with-drawing-labels | ordinary-lossless | 246,604 | 45.316 | 1 | 921600 |

The mixed photo/text source changes from 41,626 B to 39,325 B with the authored banner (5.53% smaller), at
49.118 ms versus 64.698 ms. Its 147,456 selected RGB samples are exact and outside-region difference is zero.
Automatic selection writes 39,488 B (5.14% smaller), at 189.614 ms, with 129,024 exact selected RGB samples.
Automatic Drawing labels selects the 6,063 B whole-image lossless candidate instead of the 13,855 B photo.
The other four automatic rows keep their original YCbCr bytes. The automatic analysis still costs 2–5 ordinary
encodes on this small corpus; no general speed or matched-quality compression claim follows.

## Proof and limits

Three named source tests pass with stock libjxl 0.12.0 and jxl-oxide 0.12.6. They check exact selected samples,
unchanged outside samples, all alpha, hidden RGB, full-canvas exactness, auto complete-file selection, progression,
cancellation/hurry, input custody and invalid options. The 15 native fixtures cover opaque and transparent
sources, matching Display P3 canvases, orientations, explicit/auto/full regions, and a 513×271 multi-group image
with successive passes. All 45 Chrome 155 native decodes pass and every browser encode matches Node bytes.
Native display is compared with independent decoded output using the recorded one-code-value tolerance.

Explicit regions may grow a file; automatic detection may miss a letter or select a non-text region. There is
no claim that a color-count heuristic recognizes arbitrary text. Use authored geometry for required exactness.
The accepted input is eight-bit straight RGBA with sRGB transfer and sRGB or Display P3 primaries. Other color
declarations and precision use the corresponding ordinary or planar encoder instead.
