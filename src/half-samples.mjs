// SPDX-License-Identifier: MIT
export function halfWords(data) {
  const words = new Uint32Array(data.buffer, data.byteOffset, data.length), half = new Uint16Array(words.length);
  for (let i = 0; i < words.length; i++) {
    const bits = words[i], sign = bits >>> 16 & 0x8000, magnitude = bits & 0x7fffffff, exponent = magnitude >>> 23;
    if (magnitude === 0) half[i] = sign;
    else if (exponent >= 113 && exponent <= 142) { if (bits & 0x1fff) return null; half[i] = sign | (exponent - 112) << 10 | magnitude >>> 13 & 0x3ff; }
    else if (exponent >= 102 && exponent <= 112) {
      const steps = new Float32Array(words.buffer, words.byteOffset + i * 4, 1)[0] * 16777216 * (sign ? -1 : 1);
      if (!Number.isInteger(steps)) return null; half[i] = sign | steps;
    } else if (magnitude === 0x7f800000) half[i] = sign | 0x7c00;
    else return null;
  }
  return half;
}
