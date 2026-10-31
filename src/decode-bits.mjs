// SPDX-License-Identifier: MIT
export function requireDecode(condition, message = 'Invalid JPEG XL data.', reader) {
  if (condition) return;
  const error = Object.assign(new Error(message), {code: 'JXL_DECODE'});
  if (reader) error.bitOffset = reader.bit;
  throw error;
}

export const unpackSigned = value => (value >>> 1) ^ -(value & 1);

export class JxlBits {
  constructor(bytes) {
    if (!(bytes instanceof Uint8Array)) throw new TypeError('JPEG XL bytes must be a Uint8Array.');
    this.bytes = bytes;
    const buf = bytes.length <= 67108864 ? new Uint8Array(bytes.length + 8) : bytes;
    if (buf !== bytes) buf.set(bytes);
    this.buf = buf;
    this.bit = 0;
  }
  get remaining() { return this.bytes.length * 8 - this.bit; }
  peek(n) {
    if (!((n | 0) === n && n >= 0 && n <= 32)) requireDecode(false, 'Invalid JPEG XL bit count.', this);
    if (!n) return 0;
    const at = this.bit < 4294967296 ? this.bit >>> 3 : Math.floor(this.bit / 8), shift = this.bit & 7, b = this.buf;
    let word = (b[at] >>> shift) | (b[at + 1] << (8 - shift)) |
      (b[at + 2] << (16 - shift)) | (b[at + 3] << (24 - shift));
    if (shift) word |= b[at + 4] << (32 - shift);
    return n === 32 ? word >>> 0 : word & ((1 << n) - 1);
  }
  skip(n) {
    if (!(Number.isSafeInteger(n) && n >= 0 && n <= this.bytes.length * 8 - this.bit)) requireDecode(false, 'Truncated JPEG XL data.', this);
    this.bit += n;
  }
  read(n) {
    if (!((n | 0) === n && n >= 0 && n <= 32)) requireDecode(false, 'Invalid JPEG XL bit count.', this);
    if (!n) return 0;
    const bit = this.bit;
    if (n > this.bytes.length * 8 - bit) requireDecode(false, 'Truncated JPEG XL data.', this);
    const at = bit < 4294967296 ? bit >>> 3 : Math.floor(bit / 8), shift = bit & 7, b = this.buf;
    let word = (b[at] >>> shift) | (b[at + 1] << (8 - shift)) | (b[at + 2] << (16 - shift)) | (b[at + 3] << (24 - shift));
    if (shift) word |= b[at + 4] << (32 - shift);
    this.bit = bit + n;
    return n === 32 ? word >>> 0 : word & ((1 << n) - 1);
  }
  expect(n, value) { requireDecode(this.read(n) === value, 'Invalid JPEG XL field.', this); }
  u32(choices) {
    const [bits, offset] = choices[this.read(2)];
    const value = this.read(bits) + offset;
    requireDecode(value <= 0xffffffff, 'JPEG XL integer exceeds 32 bits.', this);
    return value;
  }
  u64BigInt() {
    const form = this.read(2);
    if (form === 0) return 0n;
    if (form === 1) return BigInt(this.read(4) + 1);
    if (form === 2) return BigInt(this.read(8) + 17);
    let value = BigInt(this.read(12));
    for (let shift = 12; this.read(1); shift += 8) {
      value |= BigInt(this.read(shift === 60 ? 4 : 8)) << BigInt(shift);
      if (shift === 60) break;
    }
    return value;
  }
  u64() {
    const value = this.u64BigInt();
    if (value > 9007199254740991n) throw Object.assign(new RangeError('JPEG XL integer exceeds the safe range.'),
      {code: 'JXL_LIMIT', bitOffset: this.bit});
    return Number(value);
  }
  f16() {
    const bits = this.read(16), exponent = (bits >>> 10) & 31, mantissa = bits & 1023;
    requireDecode(exponent !== 31, 'Nonfinite JPEG XL half float.', this);
    const value = exponent ? (1024 + mantissa) * ((1 << exponent) >>> 0) / 33554432 : mantissa / 16777216;
    return bits & 32768 ? -value : value;
  }
  enum() { return this.u32([[0, 0], [0, 1], [4, 2], [6, 18]]); }
  align() { this.expect((-this.bit) & 7, 0); }
  end() { this.align(); requireDecode(this.remaining === 0, 'Trailing JPEG XL section data.', this); }
  endSection() { this.align(); while (this.remaining) requireDecode(this.read(8) === 0, 'Trailing JPEG XL section data.', this); }
}

{
  const warm = new JxlBits(new Uint8Array(8));
  for (let i = 0; i < 20; i++) {
    warm.bit = 0;
    warm.peek(0); warm.peek(1); warm.peek(32);
    warm.read(0); warm.read(1); warm.read(32);
  }
}
