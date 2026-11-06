// SPDX-License-Identifier: MIT
const K = Int32Array.from([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2]);
const W = new Int32Array(64);

function blocks(h, bytes, from, end) {
  let a0 = h[0], b0 = h[1], c0 = h[2], d0 = h[3], e0 = h[4], f0 = h[5], g0 = h[6], h0 = h[7];
  for (let p = from; p + 64 <= end; p += 64) {
    for (let i = 0; i < 16; i++) { const q = p + i * 4; W[i] = bytes[q] << 24 | bytes[q + 1] << 16 | bytes[q + 2] << 8 | bytes[q + 3]; }
    for (let i = 16; i < 64; i++) {
      const x = W[i - 15], y = W[i - 2];
      W[i] = ((x >>> 7 | x << 25) ^ (x >>> 18 | x << 14) ^ x >>> 3) + W[i - 7] + ((y >>> 17 | y << 15) ^ (y >>> 19 | y << 13) ^ y >>> 10) + W[i - 16] | 0;
    }
    let a = a0, b = b0, c = c0, d = d0, e = e0, f = f0, g = g0, hh = h0;
    for (let i = 0; i < 64; i++) {
      const t1 = hh + ((e >>> 6 | e << 26) ^ (e >>> 11 | e << 21) ^ (e >>> 25 | e << 7)) + (e & f ^ ~e & g) + K[i] + W[i] | 0;
      const t2 = ((a >>> 2 | a << 30) ^ (a >>> 13 | a << 19) ^ (a >>> 22 | a << 10)) + (a & b ^ a & c ^ b & c) | 0;
      hh = g; g = f; f = e; e = d + t1 | 0; d = c; c = b; b = a; a = t1 + t2 | 0;
    }
    a0 = a0 + a | 0; b0 = b0 + b | 0; c0 = c0 + c | 0; d0 = d0 + d | 0; e0 = e0 + e | 0; f0 = f0 + f | 0; g0 = g0 + g | 0; h0 = h0 + hh | 0;
  }
  h[0] = a0; h[1] = b0; h[2] = c0; h[3] = d0; h[4] = e0; h[5] = f0; h[6] = g0; h[7] = h0;
}

export const sha256Start = () => ({h: [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19].map(x => x | 0), length: 0, tail: []});
export function sha256Update(state, bytes) {
  const h = Int32Array.from(state.h), tail = state.tail;
  let at = 0;
  if (tail.length) {
    const first = Uint8Array.from(tail.concat(Array.from(bytes.subarray(0, 64 - tail.length))));
    if (first.length < 64) return {h: state.h, length: state.length + bytes.length, tail: Array.from(first)};
    blocks(h, first, 0, 64); at = 64 - tail.length;
  }
  const whole = at + ((bytes.length - at) & ~63);
  blocks(h, bytes, at, whole);
  return {h: Array.from(h), length: state.length + bytes.length, tail: Array.from(bytes.subarray(whole))};
}
export function sha256Finish(state) {
  const bits = state.length * 8, pad = new Uint8Array((state.tail.length + 9 + 63 & ~63));
  pad.set(state.tail); pad[state.tail.length] = 0x80;
  const view = new DataView(pad.buffer);
  view.setUint32(pad.length - 8, Math.floor(bits / 0x100000000)); view.setUint32(pad.length - 4, bits >>> 0);
  const h = Int32Array.from(state.h);
  blocks(h, pad, 0, pad.length);
  return Array.from(h, x => (x >>> 0).toString(16).padStart(8, '0')).join('');
}
