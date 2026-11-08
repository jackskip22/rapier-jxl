// SPDX-License-Identifier: MIT
import {fault} from './admit.mjs';

export const invalidJPEGData = () => fault('JXL_RECONSTRUCTION', 'Invalid or unsupported JPEG reconstruction data.');
export function requireJPEG(condition) { if (!condition) throw invalidJPEGData(); }
export class JxlBits {
  constructor(bytes) { this.bytes = bytes; this.bit = 0; this.offset = 0; this.input = null; this.part = null; }
  window(at) {
    if (this.input !== this.bytes || at < this.offset || at + 5 > this.offset + this.part.length) {
      this.input = this.bytes; this.offset = at; this.part = this.bytes.subarray(at, Math.min(this.bytes.length, at + 65536));
    }
    return this.part;
  }
  read(n) {
    const bit = this.bit;
    requireJPEG(n >= 0 && n <= 32 && bit + n <= this.bytes.length * 8);
    const bytes = this.window(bit >>> 3);
    if (n <= 24) {
      const at = (bit >>> 3) - this.offset;
      this.bit = bit + n;
      return ((bytes[at] | bytes[at + 1] << 8 | bytes[at + 2] << 16 | bytes[at + 3] << 24) >>> (bit & 7)) & ((1 << n) - 1);
    }
    let value = 0, shift = 0;
    while (n) {
      const take = Math.min(n, 8 - (this.bit & 7));
      value += ((bytes[(this.bit >>> 3) - this.offset] >>> (this.bit & 7)) & ((1 << take) - 1)) * ((1 << shift) >>> 0);
      this.bit += take; shift += take; n -= take;
    }
    return value;
  }
  peek(n) {
    const bytes = this.window(this.bit >>> 3), at = (this.bit >>> 3) - this.offset;
    return ((bytes[at] | bytes[at + 1] << 8 | bytes[at + 2] << 16 | bytes[at + 3] << 24) >>> (this.bit & 7)) & ((1 << n) - 1);
  }
  skip(n) { requireJPEG(this.bit + n <= this.bytes.length * 8); this.bit += n; }
  expect(n, value) { requireJPEG(this.read(n) === value); }
  u32(choices) { const [bits, offset] = choices[this.read(2)]; return this.read(bits) + offset; }
  align() { this.expect((-this.bit) & 7, 0); }
  end() { this.align(); requireJPEG(this.bit === this.bytes.length * 8); }
}
const SIZE = [[9, 1], [13, 1], [18, 1], [30, 1]], RATIOS = [null, [1, 1], [12, 10], [4, 3], [3, 2], [16, 9], [5, 4], [2, 1]];
export function readSize(r) {
  r.expect(16, 0x0aff);
  const small = !!r.read(1), height = small ? (r.read(5) + 1) * 8 : r.u32(SIZE), ratio = r.read(3);
  return {height, width: ratio ? Math.floor(height * RATIOS[ratio][0] / RATIOS[ratio][1]) : small ? (r.read(5) + 1) * 8 : r.u32(SIZE)};
}
