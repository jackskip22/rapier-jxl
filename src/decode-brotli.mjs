// SPDX-License-Identifier: MIT
import {JxlBits, requireDecode} from './decode-bits.mjs';
import {journaling, journalTool, sliceBytes} from './step-journal.mjs';
import {readPrefixCode, readPrefixSymbol} from './decode-entropy.mjs';
import {BROTLI_TRANSFORMS} from './brotli-transforms.mjs';
import {brotliReader} from './brotli-read.mjs';

const INSERT_BITS = [0,0,0,0,0,0,1,1,2,2,3,3,4,4,5,5,6,7,8,9,10,12,14,24];
const COPY_BITS = [0,0,0,0,0,0,0,0,1,1,2,2,3,3,4,4,5,5,6,7,8,9,10,24];
const INSERT_GROUP = [0,0,0,0,8,8,0,16,8,16,16], COPY_GROUP = [0,8,0,8,0,8,16,0,16,8,16];
const INSERT_BASE = [0], COPY_BASE = [2];
for (let i = 0; i < 23; i++) {
  INSERT_BASE.push(INSERT_BASE[i] + (1 << INSERT_BITS[i]));
  COPY_BASE.push(COPY_BASE[i] + (1 << COPY_BITS[i]));
}
const COUNT_BITS = [2,2,2,2,3,3,3,3,4,4,4,4,5,5,5,5,6,6,7,8,9,10,11,12,13,24];
const COUNT_BASE = [];
for (let value = 1, i = 0; i < COUNT_BITS.length; i++) { COUNT_BASE.push(value); value += 1 << COUNT_BITS[i]; }
const WORD_BITS = [0,0,0,0,10,10,11,11,10,10,10,10,10,9,9,8,7,7,8,7,7,6,6,5,5], WORD_BASE = [0];
for (let i = 0; i < 24; i++) WORD_BASE.push(WORD_BASE[i] + (i < 4 ? 0 : i * (1 << WORD_BITS[i])));

const UTF8_FIRST = Uint8Array.from([0,0,0,0,0,0,0,0,0,4,4,0,0,4,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,8,12,16,12,12,20,12,16,24,28,12,12,32,12,36,12,44,44,44,44,44,44,44,44,44,44,32,32,24,40,28,12,12,48,52,52,52,48,52,52,52,48,52,52,52,52,52,48,52,52,52,52,52,48,52,52,52,52,52,24,12,28,12,12,12,56,60,60,60,56,60,60,60,56,60,60,60,60,60,56,60,60,60,60,60,56,60,60,60,60,60,24,12,28,12,0]);
const UTF8_PREVIOUS = Uint8Array.from({length:256}, (_,v) => v < 33 || v >= 127 && v < 224 ? 0 :
  v >= 224 || v >= 48 && v <= 57 || v >= 65 && v <= 90 ? 2 : v >= 97 && v <= 122 ? 3 : 1);
const SIGNED = Uint8Array.from({length:256}, (_,v) => !v ? 0 : v < 16 ? 1 : v < 64 ? 2 : v < 128 ? 3 : v < 192 ? 4 : v < 240 ? 5 : v < 255 ? 6 : 7);
function literalContext(mode, previous, older) {
  if (mode === 0) return previous & 63;
  if (mode === 1) return previous >>> 2;
  if (mode === 3) return SIGNED[previous] * 8 + SIGNED[older];
  return (previous < 128 ? UTF8_FIRST[previous] : (previous >= 192 ? 2 : 0) + (previous & 1)) | UTF8_PREVIOUS[older];
}

const count8 = r => r.read(1) ? (n => (1 << n) + r.read(n) + 1)(r.read(3)) : 1;
const codeCount = (r, code) => { const n = readPrefixSymbol(r, code); return COUNT_BASE[n] + r.read(COUNT_BITS[n]); };
function blockTypes(r) {
  const block = {count: count8(r), current: 0, previous: 1, remaining: Infinity};
  if (block.count > 1) {
    block.types = readPrefixCode(r, block.count + 2); block.lengths = readPrefixCode(r, 26);
    block.remaining = codeCount(r, block.lengths);
  }
  return block;
}
function nextBlock(r, block) {
  if (!block.remaining) {
    const code = readPrefixSymbol(r, block.types);
    const type = code === 0 ? block.previous : code === 1 ? (block.current + 1) % block.count : code - 2;
    requireDecode(type < block.count, 'Invalid Brotli block type.', r);
    block.previous = block.current; block.current = type; block.remaining = codeCount(r, block.lengths);
  }
  block.remaining--; return block.current;
}

function contextMap(r, size) {
  const count = count8(r), map = new Uint8Array(size);
  if (count === 1) return {count,map};
  const runBits = r.read(1) ? r.read(4) + 1 : 0, tree = readPrefixCode(r, count + runBits);
  for (let at = 0; at < size;) {
    const symbol = readPrefixSymbol(r, tree);
    if (symbol > 0 && symbol <= runBits) {
      const run = (1 << symbol) + r.read(symbol);
      requireDecode(run <= size - at, 'Brotli context run exceeds its map.', r); at += run;
    } else map[at++] = symbol ? symbol - runBits : 0;
  }
  if (r.read(1)) {
    const order = Uint8Array.from({length:256}, (_,i)=>i);
    for (let i = 0; i < size; i++) {
      const rank = map[i], value = order[rank];
      order.copyWithin(1,0,rank); order[0] = value; map[i] = value;
    }
  }
  const seen = new Uint8Array(count);
  for (const value of map) seen[value] = 1;
  requireDecode(seen.every(v => v), 'Brotli context map has a hole.', r);
  return {count,map};
}

function distanceValue(r, symbol, postfix, direct, history) {
  if (symbol < 4) return history[symbol];
  if (symbol < 16) {
    const rank = symbol < 10 ? 0 : 1, offset = symbol < 10 ? symbol - 4 : symbol - 10;
    return history[rank] + (offset & 1 ? 1 : -1) * ((offset >>> 1) + 1);
  }
  if (symbol < 16 + direct) return symbol - 15;
  const code = symbol - 16 - direct, high = code >>> postfix, low = code & ((1 << postfix) - 1), bits = 1 + (high >>> 1);
  return (((2 + (high & 1)) * (1 << bits) - 4 + r.read(bits)) * (1 << postfix)) + low + direct + 1;
}

function dictionaryWord(length, wordId, r, dictionary, remaining) {
  requireDecode(length >= 4 && length <= 24, 'Invalid Brotli dictionary word length.', r);
  const words = 1 << WORD_BITS[length], transform = BROTLI_TRANSFORMS[Math.floor(wordId / words)];
  requireDecode(transform, 'Invalid Brotli dictionary transformation.', r);
  const [prefix, action, suffix] = transform, start = action >= 3 && action <= 11 ? Math.min(length,action-2) : 0;
  const stop = action >= 12 ? Math.max(0,length-(action-11)) : length, wordLength = Math.max(0,stop-start);
  const total = prefix.length + wordLength + suffix.length;
  requireDecode(total <= remaining, 'Brotli dictionary word exceeds its meta-block.', r);
  const output = new Uint8Array(total); let at = 0;
  for (let i = 0; i < prefix.length; i++) output[at++] = prefix.charCodeAt(i);
  const wordStart = at, base = WORD_BASE[length] + (wordId % words) * length + start;
  if (wordLength) output.set(dictionary().subarray(base,base+wordLength),at);
  at += wordLength;
  if (action === 1 || action === 2) {
    for (let i = wordStart; i < at;) {
      const byte = output[i], width = byte < 192 ? 1 : byte < 224 ? 2 : 3;
      if (width === 1) { if (byte >= 97 && byte <= 122) output[i] ^= 32; }
      else if (i+width <= at) output[i+width-1] ^= width === 2 ? 32 : 5;
      if (action === 1) break;
      i += width;
    }
  }
  for (let i = 0; i < suffix.length; i++) output[at++] = suffix.charCodeAt(i);
  return output;
}

const readerAt = (bytes, bit = 0) => { const r = new JxlBits(sliceBytes(bytes, 0), true); r.bit = bit; return r; };
function settings(bytes, {maxOutput = 268435456, maxBlocks = 65536, dictionary} = {}) {
  requireDecode(bytes instanceof Uint8Array && Number.isSafeInteger(maxOutput) && maxOutput >= 0 &&
    Number.isSafeInteger(maxBlocks) && maxBlocks > 0, 'Invalid Brotli input or resource limit.');
  let words;
  return {maxOutput, maxBlocks, dictionary() {
    if (words) return words;
    if (dictionary === undefined) throw Object.assign(new Error('This Brotli stream requires the RFC 7932 dictionary.'), {code: 'JXL_DICTIONARY'});
    words = typeof dictionary === 'function' ? dictionary() : dictionary;
    requireDecode(words instanceof Uint8Array && words.length === 122784, 'Invalid Brotli dictionary bytes.');
    return words;
  }};
}
function streamStart(bytes) {
  const r = readerAt(bytes); let windowBits = 16;
  if (r.read(1)) {
    const high = r.read(3);
    if (high) windowBits = high + 17;
    else { const low = r.read(3); requireDecode(low !== 1, 'Invalid Brotli window size.', r); windowBits = low ? low + 8 : 17; }
  }
  return {window: (1 << windowBits) - 16, history: [4, 11, 15, 16], at: 0, last: false, blocks: 0, bit: r.bit};
}
function metaHeader(bytes, previous, limits) {
  const state = {...previous}, r = readerAt(bytes, state.bit);
  if (++state.blocks > limits.maxBlocks) throw Object.assign(new RangeError('Brotli meta-block count exceeds the limit.'), {code: 'JXL_LIMIT'});
  state.last = !!r.read(1);
  if (state.last && r.read(1)) { state.bit = r.bit; return {state, kind: 'end'}; }
  const nibbles = r.read(2) + 4;
  if (nibbles === 7) {
    requireDecode(!r.read(1), 'Invalid Brotli metadata reserved bit.', r);
    const n = r.read(2), size = r.read(n * 8);
    requireDecode(n <= 1 || size >= 1 << (8 * (n - 1)), 'Noncanonical Brotli metadata length.', r);
    r.align(); r.skip((n ? size + 1 : 0) * 8); state.bit = r.bit; return {state, kind: 'skip'};
  }
  const size = r.read(nibbles * 4) + 1, end = state.at + size;
  requireDecode(nibbles === 4 || size > 1 << (4 * (nibbles - 1)), 'Noncanonical Brotli meta-block length.', r);
  if (end > limits.maxOutput) throw Object.assign(new Error('Brotli result exceeds maxOutput.'), {code: 'JXL_LIMIT'});
  if (!state.last && r.read(1)) {
    r.align(); const body = r.bit / 8; r.skip(size * 8); state.bit = r.bit; return {state, kind: 'stored', end, body};
  }
  const literalBlocks = blockTypes(r), commandBlocks = blockTypes(r), distanceBlocks = blockTypes(r);
  const postfix = r.read(2), direct = r.read(4) << postfix;
  const modes = Uint8Array.from({length: literalBlocks.count}, () => r.read(2));
  const literals = contextMap(r, literalBlocks.count * 64), distances = contextMap(r, distanceBlocks.count * 4);
  state.bit = r.bit;
  return {state, kind: 'compressed', end, literalBlocks, commandBlocks, distanceBlocks, postfix, direct, modes, literals, distances};
}
const treeGroups = head => [[head.literals.count, 256], [head.commandBlocks.count, 704], [head.distances.count, 16 + head.direct + (48 << head.postfix)]];
const readTrees = (r, count, alphabet) => Array.from({length: count}, () => readPrefixCode(r, alphabet));
function models(bytes, head) {
  const r = readerAt(bytes, head.state.bit), trees = treeGroups(head).map(([count, alphabet]) => readTrees(r, count, alphabet));
  return {trees, bit: r.bit};
}
const blockCursor = block => ({current: block.current, previous: block.previous, remaining: block.remaining});
function outputPart(bytes, head, model, previous, history, dictionary) {
  const state = {...previous, history: [...previous.history], run: previous.run && {...previous.run}}, from = state.at;
  const count = Math.min(65536, head.end - from);
  if (head.kind === 'stored') {
    const at = head.body + from - head.state.at; state.at += count;
    return {bytes: bytes.subarray(at, at + count), state};
  }
  const out = new Uint8Array(count), get = at => at < from ? history(at) : out[at - from], r = readerAt(bytes, state.bit);
  const literal = {...head.literalBlocks, ...state.literal}, command = {...head.commandBlocks, ...state.command}, distance = {...head.distanceBlocks, ...state.distance};
  const [literalTrees, commandTrees, distanceTrees] = model.trees; let work = 0;
  while (state.at < head.end && work < 4096) {
    if (!state.run) {
      const started = state.at, bit = r.bit, value = readPrefixSymbol(r, commandTrees[nextBlock(r, command)]), group = value >>> 6;
      const insertCode = INSERT_GROUP[group] + ((value >>> 3) & 7), copyCode = COPY_GROUP[group] + (value & 7);
      const insert = INSERT_BASE[insertCode] + r.read(INSERT_BITS[insertCode]), copy = COPY_BASE[copyCode] + r.read(COPY_BITS[copyCode]);
      requireDecode(insert <= head.end - state.at, 'Brotli literals exceed their meta-block.', r);
      state.run = {phase: 'insert', left: insert, copy, value, started, bit}; work++;
    }
    const run = state.run;
    if (run.phase === 'insert') {
      const n = Math.min(run.left, out.length - (state.at - from));
      for (let i = 0; i < n; i++) {
        const type = nextBlock(r, literal), context = literalContext(head.modes[type], state.at ? get(state.at - 1) : 0, state.at > 1 ? get(state.at - 2) : 0);
        out[state.at++ - from] = readPrefixSymbol(r, literalTrees[head.literals.map[type * 64 + context]]);
      }
      run.left -= n; if (run.left) break;
      if (state.at === head.end) { state.run = null; break; }
      run.phase = 'distance';
    }
    if (run.phase === 'distance') {
      const symbol = run.value < 128 ? 0 : readPrefixSymbol(r, distanceTrees[head.distances.map[nextBlock(r, distance) * 4 + Math.min(3, run.copy - 2)]]);
      const d = distanceValue(r, symbol, head.postfix, head.direct, state.history), available = Math.min(state.at, state.window);
      requireDecode(d > 0, 'Invalid Brotli backward distance.', r);
      if (d > available) { run.word = dictionaryWord(run.copy, d - available - 1, r, dictionary, head.end - state.at); run.index = 0; run.left = run.word.length; }
      else {
        requireDecode(run.copy <= head.end - state.at, 'Brotli copy exceeds its meta-block.', r);
        if (symbol) { state.history.pop(); state.history.unshift(d); }
        run.distance = d; run.left = run.copy;
      }
      run.phase = 'copy';
    }
    const n = Math.min(run.left, out.length - (state.at - from));
    if (run.word) { out.set(run.word.subarray(run.index, run.index + n), state.at - from); run.index += n; state.at += n; }
    else if (run.distance === 1) { out.fill(get(state.at - 1), state.at - from, state.at - from + n); state.at += n; }
    else for (let i = 0; i < n; i++) { out[state.at - from] = get(state.at - run.distance); state.at++; }
    run.left -= n; if (run.left) break;
    requireDecode(state.at > run.started || r.bit > run.bit, 'Brotli command does not advance.', r); state.run = null;
  }
  state.bit = r.bit; state.literal = blockCursor(literal); state.command = blockCursor(command); state.distance = blockCursor(distance);
  return {bytes: out.subarray(0, state.at - from), state};
}
function metaEnd(state) { const {literal, command, distance, run, ...next} = state; return next; }
function streamEnd(bytes, state) { readerAt(bytes, state.bit).end(); }
const sharedBrotli = /* @__PURE__ */ brotliReader(readPrefixCode, readPrefixSymbol, requireDecode, blocks => {
  throw Object.assign(blocks ? new RangeError('Brotli meta-block count exceeds the limit.') : new Error('Brotli result exceeds maxOutput.'), {code: 'JXL_LIMIT'});
});
export function decompressBrotli(bytes, {maxOutput = 268435456, maxBlocks = 65536, dictionary} = {}) {
  requireDecode(bytes instanceof Uint8Array && Number.isSafeInteger(maxOutput) && maxOutput >= 0 &&
    Number.isSafeInteger(maxBlocks) && maxBlocks > 0, 'Invalid Brotli input or resource limit.');
  return sharedBrotli(new JxlBits(bytes), maxOutput, maxBlocks, () => {
    if (dictionary === undefined) throw Object.assign(new Error('This Brotli stream requires the RFC 7932 dictionary.'), {code: 'JXL_DICTIONARY'});
    return typeof dictionary === 'function' ? dictionary() : dictionary;
  });
}
export function* decompressBrotliSteps(bytes, options = {}) {
  if (!journaling()) return decompressBrotli(bytes, options);
  return yield* journalTool('decodeBrotli')(bytes, options, {limits: settings, start: streamStart, header: metaHeader,
    groups: treeGroups, reader: readerAt, trees: readTrees, part: outputPart, metaEnd, end: streamEnd, require: requireDecode});
}
