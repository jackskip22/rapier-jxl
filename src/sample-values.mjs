// SPDX-License-Identifier: MIT
export function float16Sample(bits) {
  const exponent = bits >>> 10 & 31, mantissa = bits & 1023, sign = bits & 32768 ? -1 : 1;
  return exponent === 0 ? sign * mantissa * 2 ** -24 : exponent === 31
    ? mantissa ? NaN : sign * Infinity : sign * (1024 + mantissa) * 2 ** (exponent - 25);
}
