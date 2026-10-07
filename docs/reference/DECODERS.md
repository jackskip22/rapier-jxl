# Optional jxl-rs oracle

The suite uses jxl-oxide 0.12.6, native libjxl, and optionally `libjxl/jxl-rs`.
The third oracle is an independent upstream decoder, not a runtime dependency of the encoder.
The workflow attempts a pinned build with the four explicitly named owner repairs below and
reports its absence explicitly. The ordinary build instructions first reproduce the unmodified pin. A configured binary
that refuses a stream, exits abnormally or changes exact pixels fails the check.

Build the [jxl-rs v0.7.4 release](https://github.com/libjxl/jxl-rs/releases/tag/v0.7.4),
revision `624ce908afcf8eb0dc2585a671535eaabb5d88cc`, with Rust 1.98.1. The Cargo package
version alone does not identify a decoder revision, so the transport records the revision it
was built from.

```sh
git clone https://github.com/libjxl/jxl-rs /tmp/jxl-rs
git -C /tmp/jxl-rs checkout 624ce908afcf8eb0dc2585a671535eaabb5d88cc
mkdir -p /tmp/jxl-rs/jxl_cli/src/bin
cp test/jxl-rs-decoder.rs /tmp/jxl-rs/jxl_cli/src/bin/rapier_oracle.rs
RAPIER_JXL_RS_REVISION=624ce908afcf8eb0dc2585a671535eaabb5d88cc \
  cargo +1.98.1 build --locked --release --manifest-path /tmp/jxl-rs/Cargo.toml \
  --bin jxl_cli --bin rapier_oracle
JXL_FUZZ_JXL_RS=/tmp/jxl-rs/target/release/rapier_oracle \
  JXL_FUZZ_REQUIRE_JXL_RS=1 node --test 'test/*.test.mjs'
```

`jxl-rs-decoder.rs` transports bounded requests into the unchanged upstream public API. It
requests RGBA8, normal precision and applied orientation, checks nonlinear sRGB, and requires one
complete still frame; unsupported output profiles are refused. The persistent interface reuses
the native oracle's bounded framing but creates a fresh upstream decoder for every stream.
No browser is involved, so these results do not claim a particular browser binary was tested.

For source-precision checks, the persistent adapter also accepts
`{format: 'uint16' | 'float16' | 'float32', source: true, metadata: true}`.
It requests the upstream public API's native sample format and original colour encoding.
Integer output uses the codestream's declared depth, so a 10-bit value is returned as its original
0–1023 code rather than rescaled to 0–65535. Floating output is copied as raw IEEE words;
the transport performs no float conversion, quantization or unpremultiplication. Original alpha
association is reported separately. The default RGBA8 interface remains available.

Metadata includes source depth, exponent bits, primaries, white point, transfer function,
intensity target, alpha association and original-profile status. The current upstream public
`JxlBasicInfo` does not expose alpha depth or alpha exponent bits: those two JSON fields are
`null`, and the native libjxl adapter checks them independently. Both decoders still compare
every alpha sample exactly. `high-depth.test.mjs` covers 10/12/16-bit integers, raw binary16,
binary32, Rec. 2020 PQ/HLG, signed zero, subnormals and hidden or emissive RGB under zero alpha.
Real PNG16 and OpenEXR NONE/RLE/ZIPS/ZIP recipes also enter through the optional source reader.

Run that focused check with the recorded binary identities:

```sh
JXL_FUZZ_NATIVE=/path/to/native-decoder \
  JXL_FUZZ_JXL_RS=/path/to/rapier_oracle \
  JXL_FUZZ_REQUIRE_JXL_RS=1 node --test test/high-depth.test.mjs
```

The unmodified pin has four retained upstream defects. First, `jxl/src/util/float16.rs` decodes every
nonzero binary16 subnormal at half its specified value. Photo streams use a subnormal raw
quantization multiplier. `seeds/jxl-rs-subnormal.jxl` is a 298-byte, 2 × 1 black/white example:
jxl-oxide and native libjxl return the original pixels, whereas this unmodified pin changes
RGB by as much as 111 units. `seeds/jxl-rs-subnormal.json` names the exact stream and samples.
The public checks expose this unmodified decoder difference as a failure; they do not relax the
pixel invariant or label that upstream build compatible.

Second, `default_squeeze` skips initial chroma transforms for a one-pixel dimension, dropping
empty residual channel slots that still belong to the transform. `seeds/jxl-rs-default-squeeze.jxl`
is a 66-byte, 1 × 8 core-q50 example: native and oxide agree; upstream changes 15 RGB samples
by up to 140. The [native reference's default transform](https://github.com/libjxl/libjxl/blob/v0.12.0/lib/jxl/modular/transform/squeeze.cc)
includes both chroma transforms unconditionally.

Third, the Squeeze average tile can span several output tiles. Its next border must be cropped
along the unchanged axis using the current average rectangle's origin. Upstream takes the
whole neighboring border instead. `seeds/jxl-rs-squeeze-border.jxl.gz` is a 2049 × 257 core-q90
example with 43 wrong RGB samples, by up to three units. Its compressed pixel source, exact
coordinates and reconstruction formula are retained beside it. This also explains the original
4000 × 3000 recipe discrepancies at the 2048-pixel tile boundary. All three defects preserve
alpha in these examples; the assertions still require exact alpha and lossless RGB.

Fourth, `float16.rs::from_f32` shifts the subnormal significand one extra bit when the decoder
writes F16 output. Raw `0x0001` becomes `0x0000`, and `0x03ff` becomes `0x01ff`. This is a
separate conversion from the first defect: with the first three repairs alone, F16 output still
loses all 2,046 nonzero signed subnormals. Requesting F32 from the same unmodified decoder
returns every finite half value exactly, locating the error in output conversion. The public
test compares all 63,488 finite binary16 values, including both signed zeros and all signed
subnormals, against their exact binary32 representations. That test passes on the unmodified
v0.7.4 release. The separate F16 test keeps its original words and fails until this fourth
decoder-owner repair is applied.
It affects alpha as well as RGB. Integer and native binary32 source paths do not use it.

The four minimal decoder-owner patches are `jxl-rs-half-subnormals.patch`,
`jxl-rs-default-squeeze.patch`, `jxl-rs-squeeze-border.patch` and
`jxl-rs-f16-output-subnormals.patch`. Both half patches check all 2,046 nonzero signed
subnormals using their independently computed binary32 values. They change
[jxl-rs's F16 utility](https://github.com/libjxl/jxl-rs/blob/624ce908afcf8eb0dc2585a671535eaabb5d88cc/jxl/src/util/float16.rs),
[default Squeeze](https://github.com/libjxl/jxl-rs/blob/624ce908afcf8eb0dc2585a671535eaabb5d88cc/jxl/src/frame/modular/transforms/squeeze.rs), and
[Squeeze border input](https://github.com/libjxl/jxl-rs/blob/624ce908afcf8eb0dc2585a671535eaabb5d88cc/jxl/src/frame/modular/transforms/step.rs).
The upstream BSD-3-Clause notice is in `jxl-rs-LICENSE`.

To reproduce the repaired diagnostic oracle, apply all four patches in the pinned source,
then repeat the build with `RAPIER_JXL_RS_PATCH=half-subnormals-squeeze-f16-output` alongside the revision
variable. Point `JXL_FUZZ_JXL_RS` at that binary. Its version reports the
`+half-subnormals-squeeze-f16-output` suffix; the CI step names the repairs, prints their hashes and sets
this same explicit identity. The unchanged upstream build remains reproducible by omitting
the patches and patch variable. A half-only build uses `+half-subnormals`; the two-repair
build uses `+half-subnormals-default-squeeze`; the three-repair build uses
`+half-subnormals-squeeze` and still exposes the F16 output defect.

Exceptional half values have a separate API boundary. Libjxl 0.12.0 F32 output retains the
exact embedded IEEE representation of all 65,536 binary16 words. Its F16 output quiets
signaling NaNs. jxl-rs 0.7.4 quiets signaling NaNs on the half-to-F32 path and canonicalizes
NaN payloads in F16 output. The four diagnostic patches do not change that behavior, and a
finite-source conformance pass does not claim exact NaN payloads through those output formats.

These local diagnostic patches are not a released upstream decoder. The release has not been
established as a particular browser's vendored revision, and no browser binary was tested.
The encoder streams themselves are unchanged.

Lossless RGB and all alpha samples must match exactly. A lossy RGB difference of one unit is
counted and reported; a larger difference fails. The pin, public transport and optional status
are part of resumable scale receipts, so an absent third oracle cannot reuse third-oracle proof.
