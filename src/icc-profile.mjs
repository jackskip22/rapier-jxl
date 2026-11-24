// SPDX-License-Identifier: MIT
import {fault} from './fault.mjs';
import {journaling, journalTool} from './step-journal.mjs';

function profileHeader(profile, level, expectedColorSpace) {
  if (expectedColorSpace !== undefined && !['rgb', 'gray', 'cmyk'].includes(expectedColorSpace))
    throw fault('JXL_INPUT', 'expectedColorSpace: rgb, gray or cmyk');
  if (!(profile instanceof Uint8Array) || profile.length < 132) throw fault('JXL_INPUT', 'icc: Uint8Array');
  if (level === 5 && profile.length > 4 * 1024 * 1024)
    throw fault('JXL_SIZE', 'level 5 icc: max 4 MiB');
  const head = profile.subarray(0, 132), view = new DataView(head.buffer, head.byteOffset, head.byteLength);
  const signature = at => String.fromCharCode(head[at], head[at + 1], head[at + 2], head[at + 3]);
  if (view.getUint32(0) !== profile.length || signature(36) !== 'acsp') throw fault('JXL_INPUT', 'icc header');
  const space = signature(16), connection = signature(20);
  if (!['RGB ', 'XYZ ', 'Lab ', 'Luv ', 'YCbr', 'Yxy ', 'HSV ', 'HLS ', 'CMY ', '3CLR', 'GRAY'].includes(space) &&
      !(space === 'CMYK' && expectedColorSpace === 'cmyk'))
    throw fault('JXL_INPUT', 'icc space: RGB, GRAY or planar CMYK');
  if (expectedColorSpace !== undefined && space !== {rgb: 'RGB ', gray: 'GRAY', cmyk: 'CMYK'}[expectedColorSpace])
    throw fault('JXL_INPUT', 'icc space: channel mismatch');
  if (space === 'CMYK' && level === 5) throw fault('JXL_INPUT', 'CMYK: needs level 10');
  if (connection !== 'XYZ ' && connection !== 'Lab ') throw fault('JXL_INPUT', 'icc PCS: XYZ or Lab');
  const count = view.getUint32(128);
  if (count > Math.floor((profile.length - 132) / 12)) throw fault('JXL_INPUT', 'icc tag table: truncated');
  return {count, end: 132 + count * 12, channels: space === 'GRAY' ? 1 : 3};
}
function profileTags(profile, head, first, last) {
  const bytes = profile.subarray(132 + first * 12, 132 + last * 12), view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < last - first; i++) {
    const at = i * 12, offset = view.getUint32(at + 4), length = view.getUint32(at + 8);
    if (offset < head.end || offset % 4 || length < 8 || offset > profile.length || length > profile.length - offset)
      throw fault('JXL_INPUT', 'icc tag extent');
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
  byte() { this.require(this.at < this.end, 'truncated ICC stream'); return this.read(this.at++); }
  integer() {
    let value = 0, factor = 1;
    for (let n = 0; n < 10; n++) {
      const byte = this.byte();
      if (n === 9) this.require(byte < 2, 'ICC varint');
      value += (byte & 127) * factor;
      this.require(Number.isSafeInteger(value), 'ICC varint: too large');
      if (!(byte & 128)) return value;
      factor *= 128;
    }
    this.require(false, 'ICC varint');
  }
  take(length) {
    this.require(length >= 0 && length <= this.end - this.at, 'truncated ICC payload');
    return Array.from({length}, () => this.byte());
  }
}

export function iccInverse(requireValue, limit) {
  function start(bytes, maxBytes = 268435456, read = windowBytes(bytes)) {
    requireValue(bytes instanceof Uint8Array && bytes.length >= 2, 'ICC bytes');
    const preamble = new IccCursor(bytes, requireValue, 0, bytes.length, read), size = preamble.integer(), commandSize = preamble.integer();
    limit(size, maxBytes);
    requireValue(commandSize <= bytes.length - preamble.at, 'ICC command size');
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
      'ICC stream length');
    state.done = true;
  }
  function part(bytes, previous, history, input = windowBytes(bytes)) {
    const state = {...previous, run: previous.run && {...previous.run}}, from = state.at;
    const out = new Uint8Array(Math.min(65536, state.size - from)), get = at => at < from ? history(at) : out[at - from];
    const commands = new IccCursor(bytes, requireValue, state.commandAt, state.commandEnd, input), data = new IccCursor(bytes, requireValue, state.dataAt, bytes.length, input);
    const pending = (values, next) => { state.pending = Uint8Array.from(values); state.pendingAt = 0; state.next = next; state.phase = 'pending'; };
    const fields = () => {
      const values = [];
      const append = p => { requireValue(p.length <= state.size - state.at - values.length, 'ICC command: over output size'); values.push(...p); };
      const text = name => append(Array.from(name, c => c.charCodeAt(0)));
      const word = value => {
        requireValue(Number.isInteger(value) && value >= 0 && value <= 0xffffffff, 'ICC field: over 32 bits');
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
          requireValue(tag <= 20, 'ICC tag command');
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
            requireValue(width !== 3 && order !== 3, 'ICC predictor');
            stride = flags & 16 ? commands.integer() : width;
            requireValue(stride >= width && state.at && ((state.at - 1) >>> 2) >= stride && commands.at < commands.end, 'ICC prediction stride');
          }
          const length = commands.integer();
          if (command === 4) requireValue(length <= state.size - state.at, 'ICC predictor: over output size');
          requireValue(length >= 0 && length <= bytes.length - data.at, 'truncated ICC payload');
          if (command !== 4) requireValue(length <= state.size - state.at, 'ICC command: over output size');
          state.run = {source: data.at, length, width, order, stride, predict: command === 4, i: 0, shuffled: 0, column: 0, height: Math.ceil(length / width)};
          data.at += length; state.phase = 'run';
        } else {
          const f = fields();
          if (command === 10) { f.text('XYZ '); f.word(0); f.append(data.take(12)); }
          else if (command >= 16 && command < 24) { f.text(TYPES[command - 16]); f.word(0); }
          else requireValue(false, 'ICC command');
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

const ICC_PART = 65536;
function iccVarint(out, value) {
  do { const byte = value % 128; value = Math.floor(value / 128); out.push(byte + (value ? 128 : 0)); } while (value);
}
function iccWord(read, at, width = 4) {
  let value = 0;
  for (let b = 0; b < width; b++) value = value * 256 + read(at + b);
  return value;
}
function iccPlan(size, commands, header, runs) {
  const preamble = [];
  iccVarint(preamble, size); iccVarint(preamble, commands.length);
  const prefix = new Uint8Array(preamble.length + commands.length + header.length);
  prefix.set(preamble); prefix.set(commands, preamble.length); prefix.set(header, preamble.length + commands.length);
  return {prefix, runs, length: prefix.length + runs.reduce((n, run) => n + run.length, 0)};
}
function rawICCPlan(size, header) {
  const commands = [0, 1]; iccVarint(commands, size - 128);
  return iccPlan(size, commands, header, [{at: 128, length: size - 128, width: 1, order: -1}]);
}
const iccResidualCost = value => value === 0 ? 1 : value === 1 || value === 255 ? 3 : value < 16 || value > 240 ? 6 : 9;
function iccCurveOrder(read, at, length) {
  const scores = [0, 0, 0];
  let a = iccWord(read, at - 2, 2), b = iccWord(read, at - 4, 2), c = iccWord(read, at - 6, 2);
  for (let i = 0; i < length; i += 2) {
    const value = iccWord(read, at + i, 2);
    for (let order = 0; order < 3; order++) {
      const prediction = order === 0 ? a : order === 1 ? 2 * a - b : 3 * (a - b) + c;
      scores[order] += iccResidualCost(((value >>> 8) - (prediction >>> 8)) & 255) + iccResidualCost((value - prediction) & 255);
    }
    c = b; b = a; a = value;
  }
  let order = 1;
  if (scores[2] < scores[order]) order = 2;
  if (scores[0] < scores[order]) order = 0;
  return order;
}

function iccNumericOrder(read, at, length, width, stride) {
  const scores = [0, 0, 0];
  for (let i = 0; i < length; i += width) {
    const pos = at + i, value = iccWord(read, pos, width);
    const a = iccWord(read, pos - stride, width), b = iccWord(read, pos - stride * 2, width), c = iccWord(read, pos - stride * 3, width);
    for (let order = 0; order < 3; order++) {
      const prediction = (order === 0 ? a : order === 1 ? 2 * a - b : 3 * (a - b) + c) >>> 0;
      for (let j = 0; j < width; j++) {
        const shift = 8 * (width - 1 - j);
        scores[order] += iccResidualCost(((value >>> shift) - (prediction >>> shift)) & 255);
      }
    }
  }
  let order = 1;
  if (scores[2] < scores[order]) order = 2;
  if (scores[0] < scores[order]) order = 0;
  return order;
}
function iccLutSpans(read, at, end, width) {
  const header = width === 2 ? 52 : 48;
  if (end - at < header) return null;
  const inputs = read(at + 8), outputs = read(at + 9), grid = read(at + 10);
  if (!inputs || inputs > 15 || !outputs || outputs > 15 || grid < 2) return null;
  const inputEntries = width === 2 ? iccWord(read, at + 48, 2) : 256;
  const outputEntries = width === 2 ? iccWord(read, at + 50, 2) : 256;
  if (!inputEntries || !outputEntries) return null;
  const inputBytes = width * inputs * inputEntries, outputBytes = width * outputs * outputEntries;
  const limit = Math.floor((end - at - header - inputBytes - outputBytes) / (width * outputs));
  let points = 1;
  for (let i = 0; i < inputs; i++) { if (points > Math.floor(limit / grid)) return null; points *= grid; }
  const tableBytes = points * outputs * width, start = at + header;
  return [{at: start, length: inputBytes, stride: width},
    {at: start + inputBytes, length: tableBytes, stride: width * outputs},
    {at: start + inputBytes + tableBytes, length: outputBytes, stride: width}];
}

export function predictICCPlan(profile, structured = true, tables = false) {
  const size = profile.length, read = windowBytes(profile), prediction = new Uint8Array(128), header = new Uint8Array(Math.min(size, 128));
  prediction[0] = size >>> 24; prediction[1] = size >>> 16; prediction[2] = size >>> 8; prediction[3] = size;
  prediction[8] = 4;
  prediction.set(Uint8Array.from('mntrRGB XYZ ', c => c.charCodeAt(0)), 12);
  prediction.set(Uint8Array.from('acsp', c => c.charCodeAt(0)), 36);
  prediction.set([0, 0, 246, 214, 0, 1, 0, 0, 0, 0, 211, 45], 68);
  for (let at = 0; at < header.length; at++) {
    if (at === 8) for (let b = 0; b < 4; b++) prediction[80 + b] = read(4 + b);
    if (at === 41 && (read(40) === 65 || read(40) === 77)) prediction.set(read(40) === 65 ? [80, 80, 76] : [83, 70, 84], 41);
    if (at === 42 && read(40) === 83 && (read(41) === 71 || read(41) === 85)) prediction.set(read(41) === 71 ? [73, 32] : [78, 87], 42);
    header[at] = (read(at) - prediction[at]) & 255;
  }
  const raw = () => rawICCPlan(size, header);
  if (!structured || size <= 132) return raw();
  const count = iccWord(read, 128), bodyStart = 132 + count * 12;
  if (count > 4096 || bodyStart > size) return raw();
  const sig = at => String.fromCharCode(read(at), read(at + 1), read(at + 2), read(at + 3));
  const commands = [], data = new Uint8Array(128 + count * 4), entries = [], runs = [];
  data.set(header); let dataAt = header.length;
  for (let i = 0; i < count; i++) {
    const at = 132 + i * 12;
    entries.push({name: sig(at), offset: iccWord(read, at + 4), length: iccWord(read, at + 8)});
  }
  iccVarint(commands, count + 1);
  let prevStart = 128 + count * 12, prevSize = 0;
  for (let i = 0; i < count; i++) {
    const {name, offset, length} = entries[i];
    let tag = 0, step = 1;
    if (i + 2 < count && name === 'rTRC' && entries[i + 1].name === 'gTRC' && entries[i + 2].name === 'bTRC' &&
        entries[i + 1].offset === offset && entries[i + 1].length === length && entries[i + 2].offset === offset && entries[i + 2].length === length) {
      tag = 2; step = 3;
    } else if (i + 2 < count && name === 'rXYZ' && entries[i + 1].name === 'gXYZ' && entries[i + 2].name === 'bXYZ' &&
        entries[i + 1].length === length && entries[i + 2].length === length &&
        entries[i + 1].offset === offset + length && entries[i + 2].offset === offset + 2 * length && offset + 2 * length <= 0xffffffff) {
      tag = 3; step = 3;
    } else {
      const idx = TAGS.indexOf(name, 2);
      if (idx >= 2) tag = idx + 2;
      else { tag = 1; for (let k = 0; k < 4; k++) data[dataAt++] = name.charCodeAt(k); }
    }
    const offBit = offset !== prevStart + prevSize ? 64 : 0;
    const lenBit = length !== (XYZ_TAGS.has(name) ? 20 : prevSize) ? 128 : 0;
    commands.push(tag | offBit | lenBit);
    if (offBit) iccVarint(commands, offset);
    if (lenBit) iccVarint(commands, length);
    prevStart = offset; prevSize = length; i += step - 1;
  }
  commands.push(0);
  const spans = entries.map(e => [e.offset, Math.min(size, e.offset + e.length)])
    .filter(([s, e]) => s >= bodyStart && e - s >= 8)
    .sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  let cursor = bodyStart, rawStart = bodyStart;
  const span = (at, length, width = 1, order = -1, stride = width) => runs.push({at, length, width, order, stride});
  const flushRaw = to => {
    if (to <= rawStart) return;
    commands.push(1); iccVarint(commands, to - rawStart); span(rawStart, to - rawStart); rawStart = to;
  };
  const shuffle = (at, length, width) => {
    commands.push(width === 2 ? 2 : 3); iccVarint(commands, length); span(at, length, width); rawStart = at + length;
  };
  for (const [s, e] of spans) {
    if (s < cursor || e > size) continue;
    cursor = e;
    const typeSig = sig(s), reserved = iccWord(read, s + 4);
    if (typeSig === 'XYZ ' && reserved === 0 && e - s === 20) {
      flushRaw(s); commands.push(10); span(s + 8, 12); rawStart = s + 20; continue;
    }
    if (tables && reserved === 0 && (typeSig === 'mft1' || typeSig === 'mft2')) {
      const width = typeSig === 'mft2' ? 2 : 1, tables = iccLutSpans(read, s, e, width);
      if (tables) for (const {at, length, stride} of tables) {
        if (length < 8 * width || at <= stride * 4) continue;
        flushRaw(at);
        const order = iccNumericOrder(read, at, length, width, stride);
        commands.push(4, (width - 1) | (order << 2) | (stride !== width ? 16 : 0));
        if (stride !== width) iccVarint(commands, stride);
        iccVarint(commands, length); span(at, length, width, order, stride); rawStart = at + length;
      }
      continue;
    }
    const tIdx = reserved === 0 ? TYPES.indexOf(typeSig) : -1;
    if (tIdx < 0) continue;
    flushRaw(s); commands.push(16 + tIdx); rawStart = s + 8;
    if (typeSig === 'curv' && e - s >= 28) {
      const n = iccWord(read, s + 8);
      if (n >= 8 && 12 + 2 * n <= e - s && ((s + 18 - 1) >>> 2) >= 2) {
        flushRaw(s + 18);
        const at = s + 18, length = (n - 3) * 2, order = iccCurveOrder(read, at, length);
        commands.push(4, 1 | (order << 2)); iccVarint(commands, length); span(at, length, 2, order); rawStart = at + length;
      }
    } else if (typeSig === 'mluc' && e - s >= 28) {
      const numNames = iccWord(read, s + 8), recSize = iccWord(read, s + 12), hdrEnd = s + 16 + numNames * recSize;
      const strLen = (e - hdrEnd) & ~1;
      if (recSize === 12 && hdrEnd <= e && strLen >= 8) { flushRaw(hdrEnd); shuffle(hdrEnd, strLen, 2); }
    } else if (typeSig === 'sf32' && e - (s + 8) >= 16) {
      const arrLen = (e - (s + 8)) & ~3;
      if (arrLen >= 16) { flushRaw(s + 8); shuffle(s + 8, arrLen, 4); }
    }
  }
  flushRaw(size);
  return iccPlan(size, commands, data.subarray(0, dataAt), runs);
}
export function predictICCPart(profile, run, from = 0, count = Math.min(ICC_PART, run.length - from)) {
  count = Math.min(count, ICC_PART, run.length - from);
  if (run.width === 1 && run.order < 0) return profile.subarray(run.at + from, run.at + from + count);
  const out = new Uint8Array(count), read = windowBytes(profile), {at, length, width, order} = run;
  const height = Math.ceil(length / width), rows = Math.floor(length / height), remainder = length % height;
  for (let n = 0; n < count; n++) {
    const slot = from + n, column = slot % height, i = rows * column + Math.min(column, remainder) + Math.floor(slot / height);
    let predicted = 0;
    if (order >= 0) {
      const pos = at + i - i % width, stride = run.stride ?? width, a = iccWord(read, pos - stride, width);
      const b = order >= 1 ? iccWord(read, pos - stride * 2, width) : 0, c = order === 2 ? iccWord(read, pos - stride * 3, width) : 0;
      const value = (order === 0 ? a : order === 1 ? 2 * a - b : 3 * (a - b) + c) >>> 0;
      predicted = value >>> (8 * (width - 1 - i % width));
    }
    out[n] = read(at + i) - predicted;
  }
  return out;
}
export function* predictICCParts(profile, plan = predictICCPlan(profile)) {
  for (let from = 0; from < plan.prefix.length; from += ICC_PART) yield plan.prefix.subarray(from, from + ICC_PART);
  for (const run of plan.runs) for (let from = 0; from < run.length; from += ICC_PART)
    yield predictICCPart(profile, run, from);
}
export function predictICC(profile, tables = false) {
  const plan = predictICCPlan(profile, true, tables), out = new Uint8Array(plan.length);
  let at = 0;
  for (const part of predictICCParts(profile, plan)) { out.set(part, at); at += part.length; }
  return out;
}
