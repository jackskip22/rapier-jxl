// SPDX-License-Identifier: MIT
import {requireDecode} from './decode-bits.mjs';
import {readEntropy} from './decode-entropy.mjs';

const TAGS = ['rTRC', 'rXYZ', 'cprt', 'wtpt', 'bkpt', 'rXYZ', 'gXYZ', 'bXYZ', 'kXYZ',
  'rTRC', 'gTRC', 'bTRC', 'kTRC', 'chad', 'desc', 'chrm', 'dmnd', 'dmdd', 'lumi'];
const TYPES = ['XYZ ', 'desc', 'text', 'mluc', 'para', 'curv', 'sf32', 'gbd '];
const XYZ_TAGS = new Set(['rXYZ', 'gXYZ', 'bXYZ', 'kXYZ', 'wtpt', 'bkpt', 'lumi']);

function limit(value, maxBytes) {
  if (!Number.isSafeInteger(value) || value < 0 || value > maxBytes)
    throw Object.assign(new RangeError('JPEG XL ICC profile exceeds its allocation limit.'), {code: 'JXL_LIMIT'});
}

class Cursor {
  constructor(bytes, at = 0, end = bytes.length) { this.bytes = bytes; this.at = at; this.end = end; }
  byte() { requireDecode(this.at < this.end, 'Truncated JPEG XL ICC stream.'); return this.bytes[this.at++]; }
  integer() {
    let value = 0, factor = 1;
    for (let n = 0; n < 10; n++) {
      const byte = this.byte();
      if (n === 9) requireDecode(byte < 2, 'Invalid JPEG XL ICC integer.');
      value += (byte & 127) * factor;
      requireDecode(Number.isSafeInteger(value), 'JPEG XL ICC integer exceeds the safe range.');
      if (!(byte & 128)) return value;
      factor *= 128;
    }
    requireDecode(false, 'Invalid JPEG XL ICC integer.');
  }
  take(length) {
    requireDecode(length >= 0 && length <= this.end - this.at, 'Truncated JPEG XL ICC payload.');
    const part = this.bytes.subarray(this.at, this.at + length); this.at += length; return part;
  }
}

function context(i, a, b) {
  if (i <= 128) return 0;
  const alpha = v => v >= 65 && v <= 90 || v >= 97 && v <= 122;
  const digit = v => v >= 48 && v <= 57 || v === 44 || v === 46;
  const first = alpha(a) ? 0 : digit(a) ? 1 : a < 2 ? 2 + a : a < 16 ? 4 : a === 255 ? 6 : a > 240 ? 5 : 7;
  const second = alpha(b) ? 0 : digit(b) ? 1 : b < 16 ? 2 : b > 240 ? 3 : 4;
  return 1 + first + 8 * second;
}

export function readICC(reader, {maxBytes = 268435456} = {}) {
  limit(maxBytes, 0xffffffff);
  const start = reader.bit, size = reader.u64();
  limit(size, maxBytes);
  const code = readEntropy(reader, 41, {values: size}), prefix = new Uint8Array(Math.min(size, 20));
  code.begin();
  let a = 0, b = 0;
  const next = i => {
    const value = code.read(context(i, a, b));
    requireDecode(value < 256, 'JPEG XL ICC entropy value exceeds one byte.', reader);
    b = a; a = value; return value;
  };
  for (let i = 0; i < prefix.length; i++) prefix[i] = next(i);
  const preamble = new Cursor(prefix), outputSize = preamble.integer(), commandSize = preamble.integer();
  limit(outputSize, maxBytes);
  requireDecode(commandSize <= size - preamble.at && size <= outputSize + 65536,
    'Invalid JPEG XL ICC preamble.', reader);
  const bytes = new Uint8Array(size); bytes.set(prefix);
  for (let i = prefix.length; i < size; i++) {
    if ((i & 65535) === 0) requireDecode(i <= (reader.bit - start) * 32, 'Invalid JPEG XL ICC expansion.', reader);
    bytes[i] = next(i);
  }
  code.finish();
  return decodeICC(bytes, {maxBytes});
}

function unshuffle(bytes, width) {
  if (width === 1) return bytes;
  const out = new Uint8Array(bytes.length), stride = Math.ceil(bytes.length / width);
  let at = 0;
  for (let column = 0; column < stride; column++)
    for (let row = column; row < bytes.length; row += stride) out[at++] = bytes[row];
  return out;
}

export function decodeICC(bytes, {maxBytes = 268435456} = {}) {
  requireDecode(bytes instanceof Uint8Array, 'Invalid JPEG XL ICC bytes.');
  const preamble = new Cursor(bytes), size = preamble.integer(), commandSize = preamble.integer();
  limit(size, maxBytes);
  requireDecode(commandSize <= bytes.length - preamble.at, 'Invalid JPEG XL ICC command size.');
  const commands = new Cursor(bytes, preamble.at, preamble.at + commandSize), data = new Cursor(bytes, commands.end);
  const out = new Uint8Array(size);
  let at = 0;
  const append = part => {
    requireDecode(part.length <= out.length - at, 'JPEG XL ICC command exceeds output size.');
    out.set(part, at); at += part.length;
  };
  const text = value => append(Uint8Array.from(value, c => c.charCodeAt(0)));
  const word = value => {
    requireDecode(Number.isInteger(value) && value >= 0 && value <= 0xffffffff,
      'JPEG XL ICC field exceeds 32 bits.');
    append(Uint8Array.of(value >>> 24, value >>> 16, value >>> 8, value));
  };
  const prediction = new Uint8Array(128);
  prediction[0] = size >>> 24; prediction[1] = size >>> 16; prediction[2] = size >>> 8; prediction[3] = size;
  prediction[8] = 4;
  prediction.set(Uint8Array.from('mntrRGB XYZ ', c => c.charCodeAt(0)), 12);
  prediction.set(Uint8Array.from('acsp', c => c.charCodeAt(0)), 36);
  prediction.set([0, 0, 246, 214, 0, 1, 0, 0, 0, 0, 211, 45], 68);
  const header = Math.min(size, 128);
  for (; at < header; at++) {
    if (at === 8) prediction.set(out.subarray(4, 8), 80);
    if (at === 41 && (out[40] === 65 || out[40] === 77))
      prediction.set(out[40] === 65 ? [80, 80, 76] : [83, 70, 84], 41);
    if (at === 42 && out[40] === 83 && (out[41] === 71 || out[41] === 85))
      prediction.set(out[41] === 71 ? [73, 32] : [78, 87], 42);
    out[at] = data.byte() + prediction[at];
  }
  if (size > 128) {
    const tags = commands.integer();
    if (tags) {
      word(tags - 1);
      let previousStart = 128 + (tags - 1) * 12, previousSize = 0;
      while (commands.at < commands.end) {
        const command = commands.byte(), tag = command & 63;
        if (!tag) break;
        requireDecode(tag <= 20, 'Invalid JPEG XL ICC tag command.');
        const name = tag === 1 ? String.fromCharCode(...data.take(4)) : TAGS[tag - 2];
        const offset = command & 64 ? commands.integer() : previousStart + previousSize;
        const length = command & 128 ? commands.integer() : XYZ_TAGS.has(name) ? 20 : previousSize;
        text(name); word(offset); word(length);
        if (tag === 2) { text('gTRC'); word(offset); word(length); text('bTRC'); word(offset); word(length); }
        if (tag === 3) { text('gXYZ'); word(offset + length); word(length); text('bXYZ'); word(offset + length * 2); word(length); }
        previousStart = offset; previousSize = length;
      }
    }
    while (commands.at < commands.end) {
      const command = commands.byte();
      if (command >= 1 && command <= 3) {
        const part = data.take(commands.integer());
        append(command === 1 ? part : unshuffle(part, command === 2 ? 2 : 4));
      } else if (command === 4) {
        const flags = commands.byte(), width = (flags & 3) + 1, order = (flags >>> 2) & 3;
        requireDecode(width !== 3 && order !== 3, 'Invalid JPEG XL ICC predictor.');
        const stride = flags & 16 ? commands.integer() : width;
        requireDecode(stride >= width && stride <= Math.floor((at - 1) / 4), 'Invalid JPEG XL ICC prediction stride.');
        const length = commands.integer();
        requireDecode(length <= out.length - at, 'JPEG XL ICC predictor exceeds output size.');
        const part = unshuffle(data.take(length), width);
        for (let i = 0; i < part.length; i += width) {
          const previous = [];
          for (let k = 1; k <= order + 1; k++) {
            let value = 0;
            for (let b = 0; b < width; b++) value = value * 256 + out[at - stride * k + b];
            previous.push(value);
          }
          const predicted = (order === 0 ? previous[0] : order === 1 ? 2 * previous[0] - previous[1] :
            3 * (previous[0] - previous[1]) + previous[2]) >>> 0;
          for (let b = 0; b < width && i + b < part.length; b++) out[at++] = part[i + b] + (predicted >>> (8 * (width - 1 - b)));
        }
      } else if (command === 10) {
        text('XYZ '); word(0); append(data.take(12));
      } else if (command >= 16 && command < 24) {
        text(TYPES[command - 16]); word(0);
      } else requireDecode(false, 'Invalid JPEG XL ICC command.');
    }
  }
  requireDecode(at === out.length && commands.at === commands.end && data.at === data.end,
    'JPEG XL ICC stream has trailing or missing bytes.');
  return out;
}
