// SPDX-License-Identifier: MIT
import {BROTLI_TRANSFORMS} from './brotli-transforms.mjs';
export const INSERT_BITS = [0,0,0,0,0,0,1,1,2,2,3,3,4,4,5,5,6,7,8,9,10,12,14,24];
export const COPY_BITS = [0,0,0,0,0,0,0,0,1,1,2,2,3,3,4,4,5,5,6,7,8,9,10,24];
export const INSERT_GROUP = [0,0,0,0,8,8,0,16,8,16,16], COPY_GROUP = [0,8,0,8,0,8,16,0,16,8,16];
const bases = (bits, start) => bits.map(n => { const v = start; start += 1 << n; return v; });
export const INSERT_BASE = /* @__PURE__ */ bases(INSERT_BITS, 0), COPY_BASE = /* @__PURE__ */ bases(COPY_BITS, 2);
const COUNT_BITS = [2,2,2,2,3,3,3,3,4,4,4,4,5,5,5,5,6,6,7,8,9,10,11,12,13,24];
const COUNT_BASE = /* @__PURE__ */ bases(COUNT_BITS, 1);
const WORD_BITS = [0,0,0,0,10,10,11,11,10,10,10,10,10,9,9,8,7,7,8,7,7,6,6,5,5];
const WORD_BASE = /* @__PURE__ */ WORD_BITS.reduce((a, b, i) => [...a, a[i] + (i < 4 ? 0 : i << b)], [0]);
const UTF8_FIRST = /* @__PURE__ */ Uint8Array.from([0,0,0,0,0,0,0,0,0,4,4,0,0,4,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,8,12,16,12,12,20,12,16,24,28,12,12,32,12,36,12,44,44,44,44,44,44,44,44,44,44,32,32,24,40,28,12,12,48,52,52,52,48,52,52,52,48,52,52,52,52,52,48,52,52,52,52,52,48,52,52,52,52,52,24,12,28,12,12,12,56,60,60,60,56,60,60,60,56,60,60,60,60,60,56,60,60,60,60,60,56,60,60,60,60,60,24,12,28,12,0]);
const UTF8_PREVIOUS = /* @__PURE__ */ Uint8Array.from({length:256}, (_,v) => v < 33 || v >= 127 && v < 224 ? 0 :
  v >= 224 || v >= 48 && v <= 57 || v >= 65 && v <= 90 ? 2 : v >= 97 && v <= 122 ? 3 : 1);
const SIGNED = /* @__PURE__ */ Uint8Array.from({length:256}, (_,v) => !v ? 0 : v < 16 ? 1 : v < 64 ? 2 : v < 128 ? 3 : v < 192 ? 4 : v < 240 ? 5 : v < 255 ? 6 : 7);
export function literalContext(mode, previous, older) {
  if (mode === 0) return previous & 63;
  if (mode === 1) return previous >>> 2;
  if (mode === 3) return SIGNED[previous] * 8 + SIGNED[older];
  return (previous < 128 ? UTF8_FIRST[previous] : (previous >= 192 ? 2 : 0) + (previous & 1)) | UTF8_PREVIOUS[older];
}

export function brotliReader(readCode, readSymbol, requireValue, limit, readerAt, settings) {
  const count8 = r => r.read(1) ? (n => (1 << n) + r.read(n) + 1)(r.read(3)) : 1;
  const codeCount = (r, code) => { const n = readSymbol(r, code); return COUNT_BASE[n] + r.read(COUNT_BITS[n]); };
  function blockTypes(r) {
    const block = {count: count8(r), current: 0, previous: 1, remaining: Infinity};
    if (block.count > 1) {
      block.types = readCode(r, block.count + 2); block.lengths = readCode(r, 26);
      block.remaining = codeCount(r, block.lengths);
    }
    return block;
  }
  function nextBlock(r, block) {
    if (!block.remaining) {
      const code = readSymbol(r, block.types);
      const type = code === 0 ? block.previous : code === 1 ? (block.current + 1) % block.count : code - 2;
      requireValue(type < block.count, 'Invalid Brotli block type.', r);
      block.previous = block.current; block.current = type; block.remaining = codeCount(r, block.lengths);
    }
    block.remaining--; return block.current;
  }

  function contextMap(r, size) {
    const count = count8(r), map = new Uint8Array(size);
    if (count === 1) return {count, map};
    const runBits = r.read(1) ? r.read(4) + 1 : 0, tree = readCode(r, count + runBits);
    for (let at = 0; at < size;) {
      const symbol = readSymbol(r, tree);
      if (symbol > 0 && symbol <= runBits) {
        const run = (1 << symbol) + r.read(symbol);
        requireValue(run <= size - at, 'Brotli context run exceeds its map.', r); at += run;
      } else { requireValue(symbol - runBits < count, 'Invalid Brotli context map.', r); map[at++] = symbol ? symbol - runBits : 0; }
    }
    if (r.read(1)) {
      const order = Uint8Array.from({length: 256}, (_, i) => i);
      for (let i = 0; i < size; i++) {
        const rank = map[i], value = order[rank];
        order.copyWithin(1, 0, rank); order[0] = value; map[i] = value;
      }
    }
    return {count, map};
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

  function dictionaryWord(length, wordId, d, r, dictionary, remaining) {
    requireValue(d <= 0x7ffffffc && length >= 4 && length <= 24, 'Invalid Brotli dictionary word length.', r);
    const words = 1 << WORD_BITS[length], transform = BROTLI_TRANSFORMS[Math.floor(wordId / words)];
    requireValue(transform, 'Invalid Brotli dictionary transformation.', r);
    const [prefix, action, suffix] = transform, start = action >= 3 && action <= 11 ? Math.min(length, action - 2) : 0;
    const stop = action >= 12 ? Math.max(0, length - (action - 11)) : length, wordLength = Math.max(0, stop - start);
    const total = prefix.length + wordLength + suffix.length;
    requireValue(total <= remaining && !(total === 0 && d <= 120), 'Brotli dictionary word exceeds its meta-block.', r);
    const dict = dictionary(), output = new Uint8Array(total); let at = 0;
    for (let i = 0; i < prefix.length; i++) output[at++] = prefix.charCodeAt(i);
    const wordStart = at, base = WORD_BASE[length] + (wordId % words) * length + start;
    if (wordLength) output.set(dict.subarray(base, base + wordLength), at);
    at += wordLength;
    if (action === 1 || action === 2) {
      for (let i = wordStart; i < at;) {
        const byte = output[i], width = byte < 192 ? 1 : byte < 224 ? 2 : 3;
        if (width === 1) { if (byte >= 97 && byte <= 122) output[i] ^= 32; }
        else if (i + width <= at) output[i + width - 1] ^= width === 2 ? 32 : 5;
        if (action === 1) break;
        i += width;
      }
    }
    for (let i = 0; i < suffix.length; i++) output[at++] = suffix.charCodeAt(i);
    return output;
  }

  function streamStart(bytes) {
    const r = readerAt(bytes); let windowBits = 16;
    if (r.read(1)) {
      const high = r.read(3);
      if (high) windowBits = high + 17;
      else { const low = r.read(3); requireValue(low !== 1, 'Invalid Brotli window size.', r); windowBits = low ? low + 8 : 17; }
    }
    return {window: (1 << windowBits) - 16, history: [4, 11, 15, 16], at: 0, last: false, blocks: 0, bit: r.bit};
  }
  function metaHeader(bytes, previous, limits) {
    const state = {...previous}, r = readerAt(bytes, state.bit);
    if (++state.blocks > limits.maxBlocks) limit(true);
    state.last = !!r.read(1);
    if (state.last && r.read(1)) { state.bit = r.bit; return {state, kind: 'end'}; }
    const nibbles = r.read(2) + 4;
    if (nibbles === 7) {
      requireValue(!r.read(1), 'Invalid Brotli metadata reserved bit.', r);
      const n = r.read(2), size = r.read(n * 8);
      requireValue(n <= 1 || size >= 1 << (8 * (n - 1)), 'Noncanonical Brotli metadata length.', r);
      r.align(); r.skip((n ? size + 1 : 0) * 8); state.bit = r.bit; return {state, kind: 'skip'};
    }
    const size = r.read(nibbles * 4) + 1, end = state.at + size;
    requireValue(nibbles === 4 || size > 1 << (4 * (nibbles - 1)), 'Noncanonical Brotli meta-block length.', r);
    if (end > limits.maxOutput) limit(false);
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
  const readTrees = (r, count, alphabet) => Array.from({length: count}, () => readCode(r, alphabet));
  const blockCursor = block => ({current: block.current, previous: block.previous, remaining: block.remaining});
  function outputPart(bytes, head, model, previous, history, dictionary, maxWork = 4096) {
    const state = {...previous, history: [...previous.history], run: previous.run && {...previous.run}}, from = state.at;
    const count = Math.min(65536, head.end - from), out = new Uint8Array(count);
    if (head.kind === 'stored') {
      const at = head.body + from - head.state.at; state.at += count;
      out.set(bytes.subarray(at, at + count));
      return {bytes: out, state};
    }
    const get = at => at < from ? history(at) : out[at - from], r = readerAt(bytes, state.bit);
    const literal = {...head.literalBlocks, ...state.literal}, command = {...head.commandBlocks, ...state.command}, distance = {...head.distanceBlocks, ...state.distance};
    const [literalTrees, commandTrees, distanceTrees] = model.trees; let work = 0;
    while (state.at < head.end && work < maxWork) {
      if (!state.run) {
        const started = state.at, bit = r.bit, value = readSymbol(r, commandTrees[nextBlock(r, command)]), group = value >>> 6;
        const insertCode = INSERT_GROUP[group] + ((value >>> 3) & 7), copyCode = COPY_GROUP[group] + (value & 7);
        const insert = INSERT_BASE[insertCode] + r.read(INSERT_BITS[insertCode]), copy = COPY_BASE[copyCode] + r.read(COPY_BITS[copyCode]);
        requireValue(insert <= head.end - state.at, 'Brotli literals exceed their meta-block.', r);
        state.run = {phase: 'insert', left: insert, copy, value, started, bit}; work++;
      }
      const run = state.run;
      if (run.phase === 'insert') {
        const n = Math.min(run.left, out.length - (state.at - from));
        for (let i = 0; i < n; i++) {
          const type = nextBlock(r, literal), context = literalContext(head.modes[type], state.at ? get(state.at - 1) : 0, state.at > 1 ? get(state.at - 2) : 0);
          out[state.at++ - from] = readSymbol(r, literalTrees[head.literals.map[type * 64 + context]]);
        }
        run.left -= n; if (run.left) break;
        if (state.at === head.end) { state.run = null; break; }
        run.phase = 'distance';
      }
      if (run.phase === 'distance') {
        const symbol = run.value < 128 ? 0 : readSymbol(r, distanceTrees[head.distances.map[nextBlock(r, distance) * 4 + Math.min(3, run.copy - 2)]]);
        const d = distanceValue(r, symbol, head.postfix, head.direct, state.history), available = Math.min(state.at, state.window);
        requireValue(d > 0, 'Invalid Brotli backward distance.', r);
        if (d > available) { run.word = dictionaryWord(run.copy, d - available - 1, d, r, dictionary, head.end - state.at); run.index = 0; run.left = run.word.length; }
        else {
          requireValue(run.copy <= head.end - state.at, 'Brotli copy exceeds its meta-block.', r);
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
      requireValue(state.at > run.started || r.bit > run.bit, 'Brotli command does not advance.', r); state.run = null;
    }
    state.bit = r.bit; state.literal = blockCursor(literal); state.command = blockCursor(command); state.distance = blockCursor(distance);
    return {bytes: out.length === state.at - from ? out : out.subarray(0, state.at - from), state};
  }
  function metaEnd(state) { const {literal, command, distance, run, ...next} = state; return next; }
  function streamEnd(bytes, state) { readerAt(bytes, state.bit).end(); }

  function read(bytes, options) {
    const limits = settings(bytes, options); let state = streamStart(bytes); const parts = [];
    let cached;
    const history = at => {
      if (!cached || at < cached.from || at >= cached.at) {
        let lo = 0, hi = parts.length;
        while (lo < hi) { const mid = (lo + hi) >>> 1; if (parts[mid].at <= at) lo = mid + 1; else hi = mid; }
        cached = parts[lo];
      }
      return cached.bytes[at - cached.from];
    };
    while (!state.last) {
      const head = metaHeader(bytes, state, limits); state = head.state;
      if (head.kind === 'end' || head.kind === 'skip') continue;
      let model = null;
      if (head.kind === 'compressed') {
        const r = readerAt(bytes, state.bit);
        model = {trees: treeGroups(head).map(([c, a]) => readTrees(r, c, a)), bit: r.bit}; state.bit = r.bit;
      }
      while (state.at < head.end) {
        const from = state.at, next = outputPart(bytes, head, model, state, history, limits.dictionary, Infinity);
        state = next.state; parts.push({bytes: next.bytes, from, at: state.at});
      }
      state = metaEnd(state);
    }
    streamEnd(bytes, state);
    if (parts.length === 1) return parts[0].bytes;
    const out = new Uint8Array(state.at);
    for (const p of parts) out.set(p.bytes, p.from);
    return out;
  }

  return {read, owner: {limits: settings, start: streamStart, header: metaHeader, groups: treeGroups, reader: readerAt,
    trees: readTrees, part: outputPart, metaEnd, end: streamEnd, require: requireValue}};
}
