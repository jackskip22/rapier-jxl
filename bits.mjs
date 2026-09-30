// Rapier's JPEG XL encoder: the bit writer. MIT (LICENSE).
// JPEG XL packs bits least-significant first; `write` takes up to 32 bits at a time.

export class BitWriter {
  constructor(capacity = 4096) {
    this.bytes = new Uint8Array(capacity);
    this.at = 0;       // whole bytes written
    this.acc = 0;      // the pending bits, as a number below 2^40
    this.pending = 0;  // how many bits `acc` holds, always below 8 between calls
  }
  write(count, value) {
    if (count > 32 || value < 0 || value >= 2 ** count) throw new Error('bit write out of range: ' + count + ' bits, ' + value);
    let acc = this.acc + value * 2 ** this.pending, pending = this.pending + count;
    if (this.at + 5 >= this.bytes.length) this.grow();
    const bytes = this.bytes;
    while (pending >= 8) { bytes[this.at++] = acc & 255; acc = Math.floor(acc / 256); pending -= 8; }
    this.acc = acc; this.pending = pending;
  }
  // The U32 field of the specification: a two-bit selector, then that choice's bits (`offset` plus the bits).
  writeU32(choices, value) {
    for (let selector = 0; selector < 4; selector++) {
      const [bits, offset] = choices[selector];
      if (value >= offset && value - offset < 2 ** bits) { this.write(2, selector); if (bits) this.write(bits, value - offset); return; }
    }
    throw new Error('U32 value out of range: ' + value);
  }
  zeroPadToByte() {
    if (!this.pending) return;
    if (this.at + 1 >= this.bytes.length) this.grow();
    this.bytes[this.at++] = this.acc; this.acc = 0; this.pending = 0;
  }
  get bitLength() { return this.at * 8 + this.pending; }
  grow(need = 0) {
    const next = new Uint8Array(Math.max(this.bytes.length * 2, this.at + need + 16));
    next.set(this.bytes.subarray(0, this.at)); this.bytes = next;
  }
  // Appends another writer's bits at the current bit position.
  append(other) {
    if (this.at + other.at + 8 >= this.bytes.length) this.grow(other.at + 8);
    if (!this.pending) { this.bytes.set(other.bytes.subarray(0, other.at), this.at); this.at += other.at; }
    else for (let i = 0; i < other.at; i++) this.write(8, other.bytes[i]);
    if (other.pending) this.write(other.pending, other.acc);
  }
  // The bytes so far, the last partial byte zero-padded.
  finish() {
    const length = this.at + (this.pending ? 1 : 0), out = new Uint8Array(length);
    out.set(this.bytes.subarray(0, this.at));
    if (this.pending) out[this.at] = this.acc;
    return out;
  }
}

// Residuals travel unsigned: 0, -1, 1, -2, 2 ... become 0, 1, 2, 3, 4 ...
export function packSigned(value) { return value >= 0 ? value * 2 : -value * 2 - 1; }

export function floorLog2(value) { return 31 - Math.clz32(value); }
export function ceilLog2(value) { return value <= 1 ? 0 : 32 - Math.clz32(value - 1); }

// IEEE half precision, round to nearest even, as the specification's F16 fields.
export function float16Bits(value) {
  if (value === 0) return 0;
  const sign = value < 0 ? 0x8000 : 0;
  value = Math.abs(value);
  if (!(value < 65520)) throw new Error('half float out of range: ' + value);
  let exponent = Math.floor(Math.log2(value));
  let mantissa = value / 2 ** exponent - 1;
  if (exponent < -14) { mantissa = value / 2 ** -14; exponent = -15; }
  let m = Math.round(mantissa * 1024);
  if (m === 1024) { m = 0; exponent++; }
  return sign | ((exponent + 15) << 10) | m;
}
