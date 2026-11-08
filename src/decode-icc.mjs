// SPDX-License-Identifier: MIT
import {requireDecode} from './decode-bits.mjs';
import {readEntropy, readEntropyModelSteps, entropyStream} from './decode-entropy.mjs';
import {journaling, journalTool} from './step-journal.mjs';

const TAGS = ['rTRC', 'rXYZ', 'cprt', 'wtpt', 'bkpt', 'rXYZ', 'gXYZ', 'bXYZ', 'kXYZ',
  'rTRC', 'gTRC', 'bTRC', 'kTRC', 'chad', 'desc', 'chrm', 'dmnd', 'dmdd', 'lumi'];
const TYPES = ['XYZ ', 'desc', 'text', 'mluc', 'para', 'curv', 'sf32', 'gbd '];
const XYZ_TAGS = new Set(['rXYZ', 'gXYZ', 'bXYZ', 'kXYZ', 'wtpt', 'bkpt', 'lumi']);

function limit(value, maxBytes) {
  if (!Number.isSafeInteger(value) || value < 0 || value > maxBytes)
    throw Object.assign(new RangeError('JPEG XL ICC profile exceeds its allocation limit.'), {code: 'JXL_LIMIT'});
}

class Cursor {
  constructor(bytes, at = 0, end = bytes.length, read = at => bytes[at]) { this.bytes = bytes; this.at = at; this.end = end; this.read = read; }
  byte() { requireDecode(this.at < this.end, 'Truncated JPEG XL ICC stream.'); return this.read(this.at++); }
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

function iccLength(reader, maxBytes, maxProfileBytes) {
  limit(maxBytes, 0xffffffff);
  limit(maxProfileBytes, 0xffffffff);
  const start = reader.bit, size = reader.u64();
  limit(size, Math.min(maxBytes, maxProfileBytes + 65536));
  return {start, size, bit: reader.bit};
}
function entropyPart(reader, code, from, count, state, start) {
  const bytes = new Uint8Array(count); let {a, b} = state;
  for (let n = 0, i = from; n < count; n++, i++) {
    if (i >= 20 && (i & 65535) === 0) requireDecode(i <= (reader.bit - start) * 32, 'Invalid JPEG XL ICC expansion.', reader);
    const value = code.read(context(i, a, b)); requireDecode(value < 256, 'JPEG XL ICC entropy value exceeds one byte.', reader);
    bytes[n] = value; b = a; a = value;
  }
  return {bytes, a, b, bit: reader.bit};
}
function entropyPrefix(reader, code, head, maximum) {
  code.begin();
  const first = entropyPart(reader, code, 0, Math.min(head.size, 20), {a: 0, b: 0}, head.start);
  const preamble = new Cursor(first.bytes), outputSize = preamble.integer(), commandSize = preamble.integer();
  limit(outputSize, maximum);
  requireDecode(commandSize <= head.size - preamble.at && head.size <= outputSize + 65536,
    'Invalid JPEG XL ICC preamble.', reader);
  return first;
}
export function readICC(reader, {maxBytes = 268435456, maxProfileBytes = maxBytes} = {}) {
  const head = iccLength(reader, maxBytes, maxProfileBytes), code = readEntropy(reader, 41, {values: head.size, byteHistory: true});
  let part = entropyPrefix(reader, code, head, maxProfileBytes);
  const bytes = new Uint8Array(head.size); bytes.set(part.bytes);
  for (let from = part.bytes.length; from < head.size; from += 65536) {
    part = entropyPart(reader, code, from, Math.min(65536, head.size - from), part, head.start); bytes.set(part.bytes, from);
  }
  code.finish();
  return decodeICC(bytes, {maxBytes: maxProfileBytes});
}
export function* readICCSteps(reader, {maxBytes = 268435456, maxProfileBytes = maxBytes} = {}) {
  if (!journaling()) return readICC(reader, {maxBytes, maxProfileBytes});
  return yield* journalTool('readICC')(reader, {maxBytes, maxProfileBytes}, {length: iccLength, model: readEntropyModelSteps,
    stream: entropyStream, prefix: entropyPrefix, part: entropyPart, decode: decodeICCSteps});
}

function inverseStart(bytes, maxBytes, read) {
  requireDecode(bytes instanceof Uint8Array, 'Invalid JPEG XL ICC bytes.');
  const preamble = new Cursor(bytes, 0, bytes.length, read), size = preamble.integer(), commandSize = preamble.integer();
  limit(size, maxBytes);
  requireDecode(commandSize <= bytes.length - preamble.at, 'Invalid JPEG XL ICC command size.');
  const state = {size, at: 0, commandAt: preamble.at, commandEnd: preamble.at + commandSize,
    dataAt: preamble.at + commandSize, phase: 'count', done: false};
  const data = new Cursor(bytes, state.dataAt, bytes.length, read), out = new Uint8Array(Math.min(size, 128)), prediction = new Uint8Array(128);
  prediction[0] = size >>> 24; prediction[1] = size >>> 16; prediction[2] = size >>> 8; prediction[3] = size;
  prediction[8] = 4;
  prediction.set(Uint8Array.from('mntrRGB XYZ ', c => c.charCodeAt(0)), 12);
  prediction.set(Uint8Array.from('acsp', c => c.charCodeAt(0)), 36);
  prediction.set([0, 0, 246, 214, 0, 1, 0, 0, 0, 0, 211, 45], 68);
  for (; state.at < out.length; state.at++) {
    const at = state.at;
    if (at === 8) prediction.set(out.subarray(4, 8), 80);
    if (at === 41 && (out[40] === 65 || out[40] === 77)) prediction.set(out[40] === 65 ? [80, 80, 76] : [83, 70, 84], 41);
    if (at === 42 && out[40] === 83 && (out[41] === 71 || out[41] === 85)) prediction.set(out[41] === 71 ? [73, 32] : [78, 87], 42);
    out[at] = data.byte() + prediction[at];
  }
  state.dataAt = data.at;
  if (size <= 128) inverseEnd(state, bytes.length);
  return {bytes: out, state};
}
function inverseEnd(state, length) {
  requireDecode(state.at === state.size && state.commandAt === state.commandEnd && state.dataAt === length,
    'JPEG XL ICC stream has trailing or missing bytes.');
  state.done = true;
}
function inversePart(bytes, previous, history, input = at => bytes[at]) {
  const state = {...previous, run: previous.run && {...previous.run}}, from = state.at;
  const out = new Uint8Array(Math.min(65536, state.size - from)), get = at => at < from ? history(at) : out[at - from];
  const commands = new Cursor(bytes, state.commandAt, state.commandEnd, input), data = new Cursor(bytes, state.dataAt, bytes.length, input);
  const pending = (values, next) => { state.pending = Uint8Array.from(values); state.pendingAt = 0; state.next = next; state.phase = 'pending'; };
  const fields = () => {
    const values = [];
    const append = part => { requireDecode(part.length <= state.size - state.at - values.length, 'JPEG XL ICC command exceeds output size.'); values.push(...part); };
    const text = name => append(Array.from(name, c => c.charCodeAt(0)));
    const word = value => {
      requireDecode(Number.isInteger(value) && value >= 0 && value <= 0xffffffff, 'JPEG XL ICC field exceeds 32 bits.');
      append([value >>> 24, value >>> 16, value >>> 8, value]);
    };
    return {values, append, text, word};
  };
  let work = 0;
  while (!state.done && work < 4096) {
    if (state.phase === 'pending') {
      const count = Math.min(state.pending.length - state.pendingAt, out.length - (state.at - from));
      out.set(state.pending.subarray(state.pendingAt, state.pendingAt + count), state.at - from); state.at += count; state.pendingAt += count;
      if (state.pendingAt < state.pending.length) break;
      state.pending = null; state.phase = state.next;
    } else if (state.phase === 'run') {
      const run = state.run, count = Math.min(run.length - run.i, out.length - (state.at - from));
      for (let n = 0; n < count; n++, run.i++) {
        if (run.predict && run.i % run.width === 0) {
          const previous = [];
          for (let k = 1; k <= run.order + 1; k++) {
            let value = 0;
            for (let b = 0; b < run.width; b++) value = value * 256 + get(state.at - run.stride * k + b);
            previous.push(value);
          }
          run.predicted = (run.order === 0 ? previous[0] : run.order === 1 ? 2 * previous[0] - previous[1] : 3 * (previous[0] - previous[1]) + previous[2]) >>> 0;
        }
        const prediction = run.predict ? run.predicted >>> (8 * (run.width - 1 - run.i % run.width)) : 0;
        out[state.at++ - from] = input(run.source + run.shuffled) + prediction;
        run.shuffled += run.height; if (run.shuffled >= run.length) run.shuffled = ++run.column;
      }
      if (run.i < run.length) break;
      state.run = null; state.phase = 'commands';
    } else if (state.phase === 'count') {
      work++; const tags = commands.integer();
      if (!tags) { state.phase = 'commands'; continue; }
      const f = fields(); f.word(tags - 1); state.previousStart = 128 + (tags - 1) * 12; state.previousSize = 0;
      pending(f.values, 'tags');
    } else {
      if (commands.at === commands.end) { state.commandAt = commands.at; state.dataAt = data.at; inverseEnd(state, bytes.length); break; }
      const command = commands.byte(); work++;
      if (state.phase === 'tags') {
        const tag = command & 63;
        if (!tag) { state.phase = 'commands'; continue; }
        requireDecode(tag <= 20, 'Invalid JPEG XL ICC tag command.');
        const name = tag === 1 ? String.fromCharCode(...data.take(4)) : TAGS[tag - 2];
        const offset = command & 64 ? commands.integer() : state.previousStart + state.previousSize;
        const length = command & 128 ? commands.integer() : XYZ_TAGS.has(name) ? 20 : state.previousSize;
        const f = fields(); f.text(name); f.word(offset); f.word(length);
        if (tag === 2) { f.text('gTRC'); f.word(offset); f.word(length); f.text('bTRC'); f.word(offset); f.word(length); }
        if (tag === 3) { f.text('gXYZ'); f.word(offset + length); f.word(length); f.text('bXYZ'); f.word(offset + length * 2); f.word(length); }
        state.previousStart = offset; state.previousSize = length; pending(f.values, 'tags');
      } else if (command >= 1 && command <= 4) {
        let width = command === 2 ? 2 : command === 3 ? 4 : 1, order = 0, stride = 0;
        if (command === 4) {
          const flags = commands.byte(); width = (flags & 3) + 1; order = (flags >>> 2) & 3;
          requireDecode(width !== 3 && order !== 3, 'Invalid JPEG XL ICC predictor.');
          stride = flags & 16 ? commands.integer() : width;
          requireDecode(stride >= width && stride <= Math.floor((state.at - 1) / 4), 'Invalid JPEG XL ICC prediction stride.');
        }
        const length = commands.integer();
        if (command === 4) requireDecode(length <= state.size - state.at, 'JPEG XL ICC predictor exceeds output size.');
        requireDecode(length >= 0 && length <= bytes.length - data.at, 'Truncated JPEG XL ICC payload.');
        if (command !== 4) requireDecode(length <= state.size - state.at, 'JPEG XL ICC command exceeds output size.');
        state.run = {source: data.at, length, width, order, stride, predict: command === 4, i: 0, shuffled: 0, column: 0, height: Math.ceil(length / width)};
        data.at += length; state.phase = 'run';
      } else {
        const f = fields();
        if (command === 10) { f.text('XYZ '); f.word(0); f.append(data.take(12)); }
        else if (command >= 16 && command < 24) { f.text(TYPES[command - 16]); f.word(0); }
        else requireDecode(false, 'Invalid JPEG XL ICC command.');
        pending(f.values, 'commands');
      }
    }
  }
  state.commandAt = commands.at; state.dataAt = data.at;
  return {bytes: out.subarray(0, state.at - from), state};
}
export function decodeICC(bytes, {maxBytes = 268435456} = {}) {
  const first = inverseStart(bytes, maxBytes), out = new Uint8Array(first.state.size); out.set(first.bytes);
  const history = at => out[at]; let state = first.state;
  while (!state.done) { const from = state.at, part = inversePart(bytes, state, history); state = part.state; out.set(part.bytes, from); }
  return out;
}
export function* decodeICCSteps(bytes, {maxBytes = 268435456} = {}) {
  if (!journaling()) return decodeICC(bytes, {maxBytes});
  return yield* journalTool('decodeICC')(bytes, {maxBytes}, {start: inverseStart, part: inversePart, require: requireDecode});
}
