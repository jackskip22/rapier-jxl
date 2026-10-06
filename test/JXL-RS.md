# Optional jxl-rs oracle

The suite uses jxl-oxide 0.12.6, native libjxl, and optionally `libjxl/jxl-rs`.
The third oracle is an independent upstream decoder, not a runtime dependency of the encoder.
The workflow attempts a pinned build with the three explicitly named owner repairs below and
reports its absence explicitly. The ordinary build instructions first reproduce the unmodified pin. A configured binary
that refuses a stream, exits abnormally or changes exact pixels fails the check.

Build revision `2e65fa59b43aebd13c0530d9dcfcf151b19567d3` (jxl-rs 0.7.4) with Rust 1.98.1:

```sh
git clone https://github.com/libjxl/jxl-rs /tmp/jxl-rs
git -C /tmp/jxl-rs checkout 2e65fa59b43aebd13c0530d9dcfcf151b19567d3
mkdir -p /tmp/jxl-rs/jxl_cli/src/bin
cp test/jxl-rs-decoder.rs /tmp/jxl-rs/jxl_cli/src/bin/rapier_oracle.rs
RAPIER_JXL_RS_REVISION=2e65fa59b43aebd13c0530d9dcfcf151b19567d3 \
  cargo +1.98.1 build --locked --release --manifest-path /tmp/jxl-rs/Cargo.toml \
  --bin jxl_cli --bin rapier_oracle
JXL_FUZZ_JXL_RS=/tmp/jxl-rs/target/release/rapier_oracle \
  JXL_FUZZ_REQUIRE_JXL_RS=1 node --test 'test/*.test.mjs'
```

`jxl-rs-decoder.rs` transports bounded requests into the unchanged upstream public API. It
requests straight RGBA8, normal precision and applied orientation, checks nonlinear sRGB, and requires one
complete still frame; unsupported output profiles are refused. The persistent interface reuses
the native oracle's bounded framing but creates a fresh upstream decoder for every stream.
No browser is involved, so these results do not claim a particular browser binary was tested.

The unmodified pin has three retained upstream defects. First, `jxl/src/util/float16.rs` decodes every
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

The three minimal decoder-owner patches are `jxl-rs-half-subnormals.patch`,
`jxl-rs-default-squeeze.patch` and `jxl-rs-squeeze-border.patch`. The first also strengthens the
existing subnormal test; every nonzero signed subnormal is checked. They change
[jxl-rs's F16 utility](https://github.com/libjxl/jxl-rs/blob/2e65fa59b43aebd13c0530d9dcfcf151b19567d3/jxl/src/util/float16.rs),
[default Squeeze](https://github.com/libjxl/jxl-rs/blob/2e65fa59b43aebd13c0530d9dcfcf151b19567d3/jxl/src/frame/modular/transforms/squeeze.rs), and
[Squeeze border input](https://github.com/libjxl/jxl-rs/blob/2e65fa59b43aebd13c0530d9dcfcf151b19567d3/jxl/src/frame/modular/transforms/step.rs).
The upstream BSD-3-Clause notice is in `jxl-rs-LICENSE`.

To reproduce the repaired diagnostic oracle, apply all three patches in the pinned source,
then repeat the build with `RAPIER_JXL_RS_PATCH=half-subnormals-squeeze` alongside the revision
variable. Point `JXL_FUZZ_JXL_RS` at that binary. Its version reports the
`+half-subnormals-squeeze` suffix; the CI step names the repairs, prints their hashes and sets
this same explicit identity. The unchanged upstream build remains reproducible by omitting
the patches and patch variable. A half-only build uses `+half-subnormals`; the two-repair
isolation build uses `+half-subnormals-default-squeeze`.

These local diagnostic patches are not a released upstream decoder. The upstream-main pin
has not been established as a particular browser's vendored revision, and no browser binary
was tested. The encoder streams themselves are unchanged.

Lossless RGB and all alpha samples must match exactly. A lossy RGB difference of one unit is
counted and reported; a larger difference fails. The pin, public transport and optional status
are part of resumable scale receipts, so an absent third oracle cannot reuse third-oracle proof.
