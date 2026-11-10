// SPDX-License-Identifier: MIT
const primes = [];
for (let n = 2; primes.length < 64; n++) if (primes.every(p => n % p)) primes.push(n);
const H0 = primes.slice(0, 8).map(p => (p ** .5 % 1) * 2 ** 32 | 0);
// SPDX-License-Identifier: MIT
const K = Int32Array.from(primes, p => (Math.cbrt(p) % 1) * 2 ** 32 | 0), W = new Int32Array(64);

function blocks(h, bytes, from, end) {
  let [a0, b0, c0, d0, e0, f0, g0, h0] = h;
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
  h.set([a0, b0, c0, d0, e0, f0, g0, h0]);
}

export const sha256Start = () => ({h: [...H0], length: 0, tail: []});
export function sha256Update(state, bytes) {
  const h = Int32Array.from(state.h), tail = state.tail;
  let at = 0;
  if (tail.length) {
    const first = Uint8Array.from([...tail, ...bytes.subarray(0, 64 - tail.length)]);
    if (first.length < 64) return {h: state.h, length: state.length + bytes.length, tail: [...first]};
    blocks(h, first, 0, 64); at = 64 - tail.length;
  }
  const whole = at + ((bytes.length - at) & ~63);
  blocks(h, bytes, at, whole);
  return {h: [...h], length: state.length + bytes.length, tail: [...bytes.subarray(whole)]};
}
export function sha256Finish(state) {
  const bits = state.length * 8, pad = new Uint8Array(state.tail.length + 72 & ~63);
  pad.set(state.tail); pad[state.tail.length] = 0x80;
  const view = new DataView(pad.buffer);
  view.setUint32(pad.length - 8, Math.floor(bits / 2 ** 32)); view.setUint32(pad.length - 4, bits >>> 0);
  const h = Int32Array.from(state.h);
  blocks(h, pad, 0, pad.length);
  return Array.from(h, x => (x >>> 0).toString(16).padStart(8, '0')).join('');
}
