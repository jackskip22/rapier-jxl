// Rapier's JPEG XL encoder: the bit writer, and the limits every part keeps. MIT (LICENSE).
// JPEG XL packs bits least-significant first; `write` takes up to 32 bits at a time.

// What one call takes at most, door by door: the 16 MiB codestream, 16,384 pixels on a side, and as many pixels as the
// door's memory allows within what the core's lossy path needs at its 24 million (a measured peak of 15.7 bytes a
// pixel besides the input). The core and the effort door take 24 million; the photo door, 6.5 bytes a pixel at its
// limit, 40 million; the JPEG carrier, 6.4 bytes a pixel at 4:4:4 and 3.3 at 4:2:0, 64 million. The checked API
// refuses a larger ask before any work, the JPEG reader before it allocates a plane, and a writer that would grow past
// the stream's bound stops there instead of filling memory first.
export const LIMITS = Object.freeze({bytes: 16 * 1024 * 1024, pixels: 24_000_000, edge: 16384});
export const PHOTO_LIMITS = /*#__PURE__*/ Object.freeze({bytes: 16 * 1024 * 1024, pixels: 40_000_000, edge: 16384});
export const JPEG_LIMITS = /*#__PURE__*/ Object.freeze({bytes: 16 * 1024 * 1024, pixels: 64_000_000, edge: 16384});

// The hot writer's powers of two, made by doubling (`**` is not exact in every engine); a count outside 0 to 32 finds
// none, so its value is out of range.
const POWERS = [1];
for (let count = 1; count <= 32; count++) POWERS.push(POWERS[count - 1] * 2);

export class BitWriter {
  constructor(capacity = 4096) {
    this.bytes = new Uint8Array(capacity);
    this.at = 0;       // whole bytes written
    this.acc = 0;      // the pending bits, as a number below 2^40
    this.pending = 0;  // how many bits `acc` holds, always below 8 between calls
  }
  write(count, value) {
    if (!(value >= 0 && value < POWERS[count])) throw new Error('bit write out of range: ' + count + ' bits, ' + value);
    let acc = this.acc + value * (1 << this.pending), pending = this.pending + count;
    if (this.at + 5 >= this.bytes.length) this.grow();
    const bytes = this.bytes;
    while (pending >= 8) { bytes[this.at++] = acc & 255; acc = Math.floor(acc / 256); pending -= 8; }
    this.acc = acc; this.pending = pending;
  }
  // The U32 field of the specification: a two-bit selector, then that choice's bits (`offset` plus the bits).
  writeU32(choices, value) {
    for (let selector = 0; selector < 4; selector++) {
      const [bits, offset] = choices[selector];
      if (value >= offset && value - offset < POWERS[bits]) { this.write(2, selector); if (bits) this.write(bits, value - offset); return; }
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
    const cap = LIMITS.bytes + 64;
    if (this.at + need + 16 > cap) throw Object.assign(new Error('The encoded picture exceeds 16 MiB.'), {code: 'JXL_SIZE'});
    const next = new Uint8Array(Math.min(cap, Math.max(this.bytes.length * 2, this.at + need + 16)));
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
    const length = this.at + (this.pending ? 1 : 0), out = this.bytes.slice(0, length);
    if (this.pending) out[this.at] = this.acc;
    return out;
  }
}

// The work as steps: a stepped writer yields the fraction of its work done, counted in whole steps so the last is
// exactly 1, receives whether its caller is in a hurry, and returns its bytes. `complete` runs one to the end; `part`
// makes a nested one's fractions the index-th of `count` equal shares of its caller's.
export function complete(steps) { let step; while (!(step = steps.next()).done); return step.value; }
export function* part(steps, index, count) {
  let step, reply;
  while (!(step = steps.next(reply)).done) reply = yield scaled(step.value, done => (index + done) / count);
  return step.value;
}
// A step's fraction mapped by `f`. A pass handed to a pool (frame.mjs, groupPass) is one step carrying its fractions as
// `at`, mapped alike; its reply passes back unchanged.
export const scaled = (value, f) => typeof value === 'number' ? f(value) : {...value, at: g => f(value.at(g))};

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
  // The exponent by halving and doubling, both exact (Math.log2 rounds differently in each engine).
  let exponent = 0, mantissa = value;
  while (mantissa >= 2) { mantissa /= 2; exponent++; }
  while (mantissa < 1) { mantissa *= 2; exponent--; }
  if (exponent < -14) { mantissa = value * 16384; exponent = -15; }
  else mantissa -= 1;
  let m = Math.round(mantissa * 1024);
  if (m === 1024) { m = 0; exponent++; }
  return sign | ((exponent + 15) << 10) | m;
}
