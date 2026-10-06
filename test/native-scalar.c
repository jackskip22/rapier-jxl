// SPDX-License-Identifier: MIT
// Optional arithmetic diagnostic for libjxl 0.7 with Highway 1.0.3, not the normal oracle.
// cc -O2 native-scalar.c -ljxl -lhwy -o native-scalar
// JXL_FUZZ_NATIVE=./native-scalar node decoder-differences.mjs seeds/reconstruction-difference.json
// Highway's public test override selects HWY_SCALAR (detect_targets.h, bit 62).
#define main decoder_main
#include "native-decoder.c"
#undef main
extern void scalar_targets(int64_t) __asm__("_ZN3hwy26SetSupportedTargetsForTestEl");
int main(int argc, char **argv) {
  scalar_targets(1LL << 62);
  return decoder_main(argc, argv);
}
