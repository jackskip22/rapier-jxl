// SPDX-License-Identifier: MIT
const HALVES = /* @__PURE__ */ Array.from({length: 32}, (_, e) => 2 ** -e);
export function entropyLog2(x) {
  let exponent = 0;
  if (x >= 2 && x < 4294967296) { exponent = 31 - Math.clz32(x); x *= HALVES[exponent]; }
  while (x >= 1.4142135623730951) { x /= 2; exponent++; }
  while (x < 0.7071067811865476) { x *= 2; exponent--; }
  const z = (x - 1) / (x + 1), z2 = z * z;
  let term = z, sum = z;
  for (let k = 3; k < 30; k += 2) sum += (term *= z2) / k;
  return exponent + sum * 2.885390081777927;
}
