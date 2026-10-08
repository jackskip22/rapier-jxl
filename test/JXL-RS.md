# jxl-rs decoder verification

The test suite uses jxl-oxide 0.12.6 and native libjxl. You can also configure jxl-rs as a third,
independent decoder. These decoders are development dependencies.

CI attempts to build the pinned jxl-rs revision with the four patches described below and reports
whether it is available. A configured decoder fails verification if it rejects a stream, exits
abnormally, or changes lossless pixels. The following instructions build the unmodified revision.

## Build the decoder

Build the [jxl-rs v0.7.4 release](https://github.com/libjxl/jxl-rs/releases/tag/v0.7.4),
revision `624ce908afcf8eb0dc2585a671535eaabb5d88cc`, with Rust 1.98.1. The Cargo package
version alone does not identify a decoder revision, so the adapter records its source revision.

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

## Adapter behavior

`jxl-rs-decoder.rs` sends bounded requests to the upstream public API. It
requests RGBA8, normal precision, and applied orientation, checks nonlinear sRGB, and requires one
complete still frame; unsupported output profiles are refused. The persistent interface reuses
the native oracle's bounded framing but creates a fresh upstream decoder for every stream.

For source-precision checks, the persistent adapter also accepts
`{format: 'uint16' | 'float16' | 'float32', source: true, metadata: true}`.
It requests the upstream public API's native sample format and original color encoding.
Integer output uses the codestream's declared depth, so a 10-bit value is returned as its original
0–1023 code rather than rescaled to 0–65535. Floating output is copied as raw IEEE words;
the transport performs no float conversion, quantization, or unpremultiplication. Original alpha
association is reported separately. The default RGBA8 interface remains available.

Metadata includes source depth, exponent bits, primaries, white point, transfer function,
intensity target, alpha association, and original-profile status. The current upstream public
`JxlBasicInfo` does not expose alpha depth or alpha exponent bits: those two JSON fields are
`null`, and the native libjxl adapter checks them independently. Both decoders still compare
every alpha sample exactly. `high-depth.test.mjs` covers 10/12/16-bit integers, raw binary16,
binary32, Rec. 2020 PQ/HLG, signed zero, subnormals, and hidden or emissive RGB under zero alpha.
The source reader tests also cover PNG16 and OpenEXR files with NONE, RLE, ZIPS, and ZIP compression.

Run that focused check with the recorded binary identities:

```sh
JXL_FUZZ_NATIVE=/path/to/native-decoder \
  JXL_FUZZ_JXL_RS=/path/to/rapier_oracle \
  JXL_FUZZ_REQUIRE_JXL_RS=1 node --test test/high-depth.test.mjs
```

## Decoder defects and patches

The unmodified revision has four defects covered by stored test cases.

### Binary16 subnormal input

`jxl/src/util/float16.rs` decodes every nonzero binary16 subnormal at half its specified value.
The photo regression stream uses a subnormal raw quantization multiplier. `seeds/jxl-rs-subnormal.jxl` is a 298-byte, 2 × 1 black/white example:
jxl-oxide and native libjxl return the original pixels, whereas the unmodified revision changes
RGB by as much as 111 units. `seeds/jxl-rs-subnormal.json` names the exact stream and samples.
This pixel difference fails conformance checks.

### Default Squeeze channel slots

`default_squeeze` skips initial chroma transforms for a one-pixel dimension, dropping
empty residual channel slots that still belong to the transform. `seeds/jxl-rs-default-squeeze.jxl`
is a 66-byte, 1 × 8 core-q50 example: native and oxide agree; upstream changes 15 RGB samples
by up to 140. The [native reference's default transform](https://github.com/libjxl/libjxl/blob/v0.12.0/lib/jxl/modular/transform/squeeze.cc)
includes both chroma transforms unconditionally.

### Squeeze border coordinates

A Squeeze average tile can span several output tiles. Its next border must be cropped
along the unchanged axis using the current average rectangle's origin. Upstream takes the
whole neighboring border instead. `seeds/jxl-rs-squeeze-border.jxl.gz` is a 2049 × 257 core-q90
example with 43 wrong RGB samples, by up to three units. Its compressed pixel source, exact
coordinates, and reconstruction formula are retained beside it. This also explains the original
4000 × 3000 recipe discrepancies at the 2048-pixel tile boundary. All three defects preserve
alpha in these examples; the assertions still require exact alpha and lossless RGB.

### Binary16 subnormal output

`float16.rs::from_f32` shifts the subnormal significand one extra bit when the decoder
writes F16 output. Raw `0x0001` becomes `0x0000`, and `0x03ff` becomes `0x01ff`. This is a
separate conversion from the first defect: with the first three repairs alone, F16 output still
loses all 2,046 nonzero signed subnormals. Requesting F32 from the same unmodified decoder
returns every finite half value exactly, locating the error in output conversion. The public
test compares all 63,488 finite binary16 values, including both signed zeros and all signed
subnormals, against their exact binary32 representations. That test passes on the unmodified
v0.7.4 release. The separate F16 test keeps its original words and fails until this fourth
patch is applied. The defect affects alpha as well as RGB. Integer and native binary32 source paths do not use it.

## Build with the diagnostic patches

The four decoder patches are `jxl-rs-half-subnormals.patch`,
`jxl-rs-default-squeeze.patch`, `jxl-rs-squeeze-border.patch`, and
`jxl-rs-f16-output-subnormals.patch`. Both half patches check all 2,046 nonzero signed
subnormals using their independently computed binary32 values. They change
[jxl-rs's F16 utility](https://github.com/libjxl/jxl-rs/blob/624ce908afcf8eb0dc2585a671535eaabb5d88cc/jxl/src/util/float16.rs),
[default Squeeze](https://github.com/libjxl/jxl-rs/blob/624ce908afcf8eb0dc2585a671535eaabb5d88cc/jxl/src/frame/modular/transforms/squeeze.rs), and
[Squeeze border input](https://github.com/libjxl/jxl-rs/blob/624ce908afcf8eb0dc2585a671535eaabb5d88cc/jxl/src/frame/modular/transforms/step.rs).
The upstream BSD-3-Clause notice is in `jxl-rs-LICENSE`.

To build the patched decoder, apply all four patches to the pinned source,
then repeat the build with `RAPIER_JXL_RS_PATCH=half-subnormals-squeeze-f16-output` alongside the revision
variable. Point `JXL_FUZZ_JXL_RS` at that binary. Its version reports the
`+half-subnormals-squeeze-f16-output` suffix; the CI step names the repairs, prints their hashes, and sets
this identity. To build the unmodified revision, omit the patches and patch variable.

A half-only build uses `+half-subnormals`; the two-repair
build uses `+half-subnormals-default-squeeze`; the three-repair build uses
`+half-subnormals-squeeze` and still exposes the F16 output defect.

## NaN output behavior

Exceptional binary16 values depend on the requested output format. Libjxl 0.12.0 F32 output retains the
exact embedded IEEE representation of all 65,536 binary16 words. Its F16 output quiets
signaling NaNs. jxl-rs 0.7.4 quiets signaling NaNs on the half-to-F32 path and canonicalizes
NaN payloads in F16 output. The four patches do not change this behavior. Exact results for finite
inputs do not establish NaN payload preservation.

## Verification scope

The patched decoder is a local diagnostic build, not an upstream release. These checks cover
standalone decoders; they do not verify browser builds. The patches do not change encoder output.

Lossless RGB and all alpha samples must match exactly. Tests report lossy RGB differences of
one unit and reject larger differences. Saved scale-test results record the decoder revision,
adapter identity, and availability. Results obtained without jxl-rs cannot supply jxl-rs verification.
