// SPDX-License-Identifier: MIT
import {fault} from './fault.mjs';
import {journaling, journalTool} from './step-journal.mjs';

function profileHeader(profile, level, expectedColorSpace) {
  if (expectedColorSpace !== undefined && !['rgb', 'gray', 'cmyk'].includes(expectedColorSpace))
    throw fault('JXL_INPUT', 'The expected ICC source space is rgb, gray or cmyk.');
  if (!(profile instanceof Uint8Array) || profile.length < 132) throw fault('JXL_INPUT', 'ICC is a Uint8Array of the complete profile.');
  if (level === 5 && profile.length > 4 * 1024 * 1024)
    throw fault('JXL_SIZE', 'Level 5 ICC profiles are at most 4 MiB.');
  const head = profile.subarray(0, 132), view = new DataView(head.buffer, head.byteOffset, head.byteLength);
  const signature = at => String.fromCharCode(head[at], head[at + 1], head[at + 2], head[at + 3]);
  if (view.getUint32(0) !== profile.length || signature(36) !== 'acsp') throw fault('JXL_INPUT', 'ICC size or profile signature is invalid.');
  const space = signature(16), connection = signature(20);
  if (!['RGB ', 'XYZ ', 'Lab ', 'Luv ', 'YCbr', 'Yxy ', 'HSV ', 'HLS ', 'CMY ', '3CLR', 'GRAY'].includes(space) &&
      !(space === 'CMYK' && expectedColorSpace === 'cmyk'))
    throw fault('JXL_INPUT', 'ICC needs RGB, GRAY, or CMYK with a planar-channel context.');
  if (expectedColorSpace !== undefined && space !== {rgb: 'RGB ', gray: 'GRAY', cmyk: 'CMYK'}[expectedColorSpace])
    throw fault('JXL_INPUT', 'The ICC space does not match the channels.');
  if (space === 'CMYK' && level === 5) throw fault('JXL_INPUT', 'CMYK and black channels need level 10.');
  if (connection !== 'XYZ ' && connection !== 'Lab ') throw fault('JXL_INPUT', 'ICC profile connection space must be XYZ or Lab.');
  const count = view.getUint32(128);
  if (count > Math.floor((profile.length - 132) / 12)) throw fault('JXL_INPUT', 'ICC tag table exceeds the profile.');
  return {count, end: 132 + count * 12, channels: space === 'GRAY' ? 1 : 3};
}
function profileTags(profile, head, first, last) {
  const bytes = profile.subarray(132 + first * 12, 132 + last * 12), view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < last - first; i++) {
    const at = i * 12, offset = view.getUint32(at + 4), length = view.getUint32(at + 8);
    if (offset < head.end || offset % 4 || length < 8 || offset > profile.length || length > profile.length - offset)
      throw fault('JXL_INPUT', 'ICC tag data is unaligned or outside the profile.');
  }
}
export function inspectICC(profile, level, expectedColorSpace) {
  const head = profileHeader(profile, level, expectedColorSpace);
  for (let first = 0; first < head.count; first += 4096) profileTags(profile, head, first, Math.min(head.count, first + 4096));
  return head.channels;
}
export function* inspectICCSteps(profile, level, expectedColorSpace) {
  if (!journaling()) return inspectICC(profile, level, expectedColorSpace);
  return yield* journalTool('inspectICC')(profile, level, expectedColorSpace, {header: profileHeader, tags: profileTags});
}

const TAGS = ['rTRC', 'rXYZ', 'cprt', 'wtpt', 'bkpt', 'rXYZ', 'gXYZ', 'bXYZ', 'kXYZ',
  'rTRC', 'gTRC', 'bTRC', 'kTRC', 'chad', 'desc', 'chrm', 'dmnd', 'dmdd', 'lumi'];
const TYPES = ['XYZ ', 'desc', 'text', 'mluc', 'para', 'curv', 'sf32', 'gbd '];
const XYZ_TAGS = /* @__PURE__ */ new Set(['rXYZ', 'gXYZ', 'bXYZ', 'kXYZ', 'wtpt', 'bkpt', 'lumi']);

function windowBytes(bytes) {
  const windows = new Map();
  return at => {
    if (at < 0 || at >= bytes.length) return undefined;
    const from = Math.floor(at / 65536) * 65536; let part = windows.get(from);
    if (!part) { part = bytes.subarray(from, Math.min(bytes.length, from + 65536)); windows.set(from, part); if (windows.size > 8) windows.delete(windows.keys().next().value); }
    return part[at - from];
  };
}

export class IccCursor {
  constructor(bytes, requireValue, at = 0, end = bytes.length, read = windowBytes(bytes)) {
    this.bytes = bytes; this.require = requireValue; this.at = at; this.end = end; this.read = read;
  }
  byte() { this.require(this.at < this.end, 'Truncated JPEG XL ICC stream.'); return this.read(this.at++); }
  integer() {
    let value = 0, factor = 1;
    for (let n = 0; n < 10; n++) {
      const byte = this.byte();
      if (n === 9) this.require(byte < 2, 'Invalid JPEG XL ICC integer.');
      value += (byte & 127) * factor;
      this.require(Number.isSafeInteger(value), 'JPEG XL ICC integer exceeds the safe range.');
      if (!(byte & 128)) return value;
      factor *= 128;
    }
    this.require(false, 'Invalid JPEG XL ICC integer.');
  }
  take(length) {
    this.require(length >= 0 && length <= this.end - this.at, 'Truncated JPEG XL ICC payload.');
    return Array.from({length}, () => this.byte());
  }
}

export function iccInverse(requireValue, limit) {
  function start(bytes, maxBytes = 268435456, read = windowBytes(bytes)) {
    requireValue(bytes instanceof Uint8Array && bytes.length >= 2, 'Invalid JPEG XL ICC bytes.');
    const preamble = new IccCursor(bytes, requireValue, 0, bytes.length, read), size = preamble.integer(), commandSize = preamble.integer();
    limit(size, maxBytes);
    requireValue(commandSize <= bytes.length - preamble.at, 'Invalid JPEG XL ICC command size.');
    const state = {size, at: 0, commandAt: preamble.at, commandEnd: preamble.at + commandSize,
      dataAt: preamble.at + commandSize, phase: 'count', done: false};
    const data = new IccCursor(bytes, requireValue, state.dataAt, bytes.length, read), out = new Uint8Array(Math.min(size, 128)), prediction = new Uint8Array(128);
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
    if (size <= 128) end(state, bytes.length);
    return {bytes: out, state};
  }
  function end(state, length) {
    requireValue(state.at === state.size && state.commandAt === state.commandEnd && state.dataAt === length,
      'JPEG XL ICC stream has trailing or missing bytes.');
    state.done = true;
  }
  function part(bytes, previous, history, input = windowBytes(bytes)) {
    const state = {...previous, run: previous.run && {...previous.run}}, from = state.at;
    const out = new Uint8Array(Math.min(65536, state.size - from)), get = at => at < from ? history(at) : out[at - from];
    const commands = new IccCursor(bytes, requireValue, state.commandAt, state.commandEnd, input), data = new IccCursor(bytes, requireValue, state.dataAt, bytes.length, input);
    const pending = (values, next) => { state.pending = Uint8Array.from(values); state.pendingAt = 0; state.next = next; state.phase = 'pending'; };
    const fields = () => {
      const values = [];
      const append = p => { requireValue(p.length <= state.size - state.at - values.length, 'JPEG XL ICC command exceeds output size.'); values.push(...p); };
      const text = name => append(Array.from(name, c => c.charCodeAt(0)));
      const word = value => {
        requireValue(Number.isInteger(value) && value >= 0 && value <= 0xffffffff, 'JPEG XL ICC field exceeds 32 bits.');
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
            const prev = [];
            for (let k = 1; k <= run.order + 1; k++) {
              let value = 0;
              for (let b = 0; b < run.width; b++) value = value * 256 + get(state.at - run.stride * k + b);
              prev.push(value);
            }
            run.predicted = (run.order === 0 ? prev[0] : run.order === 1 ? 2 * prev[0] - prev[1] : 3 * (prev[0] - prev[1]) + prev[2]) >>> 0;
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
        if (commands.at === commands.end) { state.commandAt = commands.at; state.dataAt = data.at; end(state, bytes.length); break; }
        const command = commands.byte(); work++;
        if (state.phase === 'tags') {
          const tag = command & 63;
          if (!tag) { state.phase = 'commands'; continue; }
          requireValue(tag <= 20, 'Invalid JPEG XL ICC tag command.');
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
            requireValue(width !== 3 && order !== 3, 'Invalid JPEG XL ICC predictor.');
            stride = flags & 16 ? commands.integer() : width;
            requireValue(stride >= width && state.at && ((state.at - 1) >>> 2) >= stride && commands.at < commands.end, 'Invalid JPEG XL ICC prediction stride.');
          }
          const length = commands.integer();
          if (command === 4) requireValue(length <= state.size - state.at, 'JPEG XL ICC predictor exceeds output size.');
          requireValue(length >= 0 && length <= bytes.length - data.at, 'Truncated JPEG XL ICC payload.');
          if (command !== 4) requireValue(length <= state.size - state.at, 'JPEG XL ICC command exceeds output size.');
          state.run = {source: data.at, length, width, order, stride, predict: command === 4, i: 0, shuffled: 0, column: 0, height: Math.ceil(length / width)};
          data.at += length; state.phase = 'run';
        } else {
          const f = fields();
          if (command === 10) { f.text('XYZ '); f.word(0); f.append(data.take(12)); }
          else if (command >= 16 && command < 24) { f.text(TYPES[command - 16]); f.word(0); }
          else requireValue(false, 'Invalid JPEG XL ICC command.');
          pending(f.values, 'commands');
        }
      }
    }
    state.commandAt = commands.at; state.dataAt = data.at;
    return {bytes: out.subarray(0, state.at - from), state};
  }
  function decode(bytes, maxBytes = 268435456) {
    const read = windowBytes(bytes), first = start(bytes, maxBytes, read), out = new Uint8Array(first.state.size); out.set(first.bytes);
    const history = at => out[at]; let state = first.state;
    while (!state.done) { const from = state.at, next = part(bytes, state, history, read); state = next.state; out.set(next.bytes, from); }
    return out;
  }
  return {decode, owner: {start, part, require: requireValue}};
}
