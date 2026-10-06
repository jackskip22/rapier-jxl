# Exact coding for screenshots, text and drawings

The effort door tries screen candidates at effort 3 and above. The core,
JPEG carrier and photograph doors are unchanged; no new option or runtime
library is required. All accepted candidates compete as complete JPEG XL
codestreams against the existing effort-1 floor and the older effort searches.

## Routing and scope

`screenEligible` first checks the palette already found by `inspectPixels`.
Without that palette it does not read any additional image pixels or allocate
scratch buffers. With one, it samples at most 256 fixed RGBA triples in a
stratified grid. A triple is flat only when its centre, right and lower pixels
agree in all four channels; at least 192 must be flat. A rejection preserves the
old effort route. This is deliberately conservative: the default route does not
handle more than the core's 2048 palette entries, noisy scanned paper, or every
mixed screenshot. The standalone global planner supports at most 4096 entries.

## Candidates

`screen.mjs` supplies exact global palettes without a gratuitous zero entry,
sparse scalar channel palettes, and a reusable modular group writer. Palette
values are numerically sorted, with exact RGBA membership; no quantization is
performed. Scalar palettes with more than 192 values, or no gaps in their range,
are skipped. Predictor selection samples the integer predictors 0, 1, 2 and 5
and prices prefix headers plus payload bits. A candidate is accepted only on its
actual complete byte length, not the sample price.

`screen-lz77.mjs` matches packed modular residual values, not Huffman symbols.
A 65536-bucket integer hash and a maximum of four collision-chain probes find
matches of at least seven values. Every copy is verified by full value equality.
History resets per plane and per group; overlap is allowed. General distances
use the modular stream's 120 spatial-distance-code convention. A dedicated
distance histogram is included in the byte price. No inter-group dependency is
introduced.

`screen-patches.mjs` finds 8-connected components against a sampled exact
background. Width, height and an integer hash identify candidates; full RGBA
rectangle equality proves every reuse. Components no larger than 64 by 64,
repeated at least three times and clearing a fixed area threshold, are packed
into a 256-pixel-wide atlas. That atlas is a real JPEG XL reference-only frame,
saved before colour conversion. A standard patch dictionary places the original
rectangles with replacement blending, including alpha and invisible RGB.
The body is encoded after those rectangles are cleared. No image semantics,
OCR, font recognition, private sidecar, or lossy background replacement is used.
The total stream includes the atlas, dictionary, body and all headers.

The patch scan is capped at four million pixels, 32768 eligible components,
2048 reused component classes and a 16384-pixel atlas height. Hash collisions
always undergo full equality checks; excessive collision bookkeeping abandons
the candidate. Detection and atlas work allocate image-sized buffers only after
screen admission. Very large or unusual screenshots fall back rather than
changing pixel values.

The measured order is global-palette LZ77, glyph patches with LZ77, scalar
palette LZ77, global palette only, scalar palettes only. At effort 3, after the
first two trials, a completed candidate at most three quarters of the effort-1
size ends the search. This deterministic actual-byte threshold avoids spending
more time on low-value alternatives after a strong win. Smaller wins continue
through all screen candidates and the old search. Efforts 4 and above always
retain the broader search. The early exit kept the same bytes on all 21 measured
fixtures; it is not a guarantee of matching an exhaustive search on every
possible screenshot. The universal size floor is effort 1, as before.

## Progress, exactness and packaging

Effort 1 never imports or calls this route. An immediate hurry returns the
original effort-1 bytes. Later hurry retains the smallest completed candidate,
as required by the existing public `steps.test.mjs`; an incomplete atlas or body
can never be published. No clock, randomness, transcendental function or
engine-dependent sort comparison chooses a byte in the new modules.

The four modules are separate from the small core. `codec-build.mjs` places
them in dependency order in Rapier's flattened image worker. The normal package
stager also follows them from the effort door. Reproduce the corpus, ablations,
two-decoder checks and packaged/readable equality with
`repo/tools/probes/jxl-screenshots/README.md`.

These are original MIT-licensed JavaScript implementations. Format grammar was
checked against libjxl's BSD-3-Clause sources (`dec_ans.h`, `frame_header.cc`,
`dec_patch_dictionary.cc`, `patch_dictionary_internal.h`, `dec_frame.cc`). No
libjxl runtime code, fonts or new runtime dependency is shipped.
