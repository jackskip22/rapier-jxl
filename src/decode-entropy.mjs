// SPDX-License-Identifier: MIT
import {requireDecode} from './decode-bits.mjs';
import {ceilLog2, canonicalCodes, LOG_LENGTHS, LOG_CODES, reverseAlias, SCREEN_SPECIAL_DISTANCES, COEFF_NUM_NONZERO_CONTEXT, COEFF_FREQ_CONTEXT} from './decode-tables.mjs';

const WINDOW = 1048576, MASK = WINDOW - 1;
const HISTORY_POOL = [new Uint32Array(WINDOW)];
const LENGTH_ORDER = [1, 2, 3, 4, 0, 5, 17, 6, 16, 7, 8, 9, 10, 11, 12, 13, 14, 15];
const var8 = r => r.read(1) ? (n => (1 << n) + r.read(n))(r.read(3)) : 0;

function prefixTable(lengths, explicit) {
  let max = 0, count = 0, only = 0, space = 0;
  for (let i = 0; i < lengths.length; i++) if (lengths[i]) {
    const n = lengths[i];
    requireDecode(n <= 15, 'Invalid JPEG XL prefix length.');
    max = Math.max(max, n); count++; only = i; space += 32768 >>> n;
  }
  requireDecode(count > 0 && (count === 1 || space === 32768), 'Invalid JPEG XL prefix tree.');
  if (count === 1) return {single: only, bits: 0, mask: 0, table: null};
  const codes = explicit || canonicalCodes(lengths), table = new Uint32Array(1 << max);
  for (let i = 0; i < lengths.length; i++) if (lengths[i]) {
    const n = lengths[i], entry = i * 32 + n;
    for (let at = codes[i]; at < table.length; at += 1 << n) table[at] = entry;
  }
  return {single: -1, bits: max, mask: (1 << max) - 1, table};
}

function prefixToken(r, code) {
  if (code.single >= 0) return code.single;
  const bit = r.bit, at = bit < 4294967296 ? bit >>> 3 : Math.floor(bit / 8), shift = bit & 7, b = r.buf;
  const word = (b[at] >>> shift) | (b[at + 1] << (8 - shift)) | (b[at + 2] << (16 - shift));
  const entry = code.table[word & code.mask], len = entry & 31;
  if (!len || bit + len > r.bytes.length * 8) {
    requireDecode(len !== 0, 'Invalid JPEG XL prefix symbol.', r);
    requireDecode(false, 'Truncated JPEG XL data.', r);
  }
  r.bit = bit + len;
  return entry >>> 5;
}
export {prefixToken as readPrefixSymbol};

const LENGTH_CODE = prefixTable([2, 4, 3, 2, 2, 4], [0, 7, 3, 2, 1, 15]);
const ANS_LOG_CODE = prefixTable([...LOG_LENGTHS, 7], [...LOG_CODES, 65]);

export function readPrefixCode(r, size) {
  requireDecode(Number.isInteger(size) && size >= 1 && size <= 32768, 'Invalid JPEG XL alphabet.', r);
  if (size === 1) return {single: 0, bits: 0, mask: 0, table: null};
  const form = r.read(2), lengths = new Uint8Array(size);
  if (form === 1) {
    const count = r.read(2) + 1, symbols = [];
    for (let i = 0; i < count; i++) {
      const symbol = r.read(ceilLog2(size));
      requireDecode(symbol < size && !symbols.includes(symbol), 'Invalid JPEG XL simple prefix tree.', r);
      symbols.push(symbol);
    }
    if (count === 1) return {single: symbols[0], bits: 0, mask: 0, table: null};
    const depths = count === 2 ? [1, 1] : count === 3 ? [1, 2, 2] : r.read(1) ? [1, 2, 3, 3] : [2, 2, 2, 2];
    for (let i = 0; i < count; i++) lengths[symbols[i]] = depths[i];
  } else {
    const codeLengths = new Uint8Array(18);
    let space = 32, used = 0;
    for (let i = form; i < LENGTH_ORDER.length && space > 0; i++) {
      const n = prefixToken(r, LENGTH_CODE);
      codeLengths[LENGTH_ORDER[i]] = n;
      if (n) { used++; space -= 32 >>> n; }
    }
    requireDecode(used === 1 || space === 0, 'Invalid JPEG XL prefix-length tree.', r);
    const code = prefixTable(codeLengths);
    let at = 0, previous = 8, run = 0, repeated = -1;
    space = 32768;
    while (at < size && space > 0) {
      const token = prefixToken(r, code);
      if (token < 16) {
        lengths[at++] = token;
        if (token) { previous = token; space -= 32768 >>> token; }
        run = 0; repeated = -1;
      } else {
        const value = token === 16 ? previous : 0, extra = token === 16 ? 2 : 3;
        if (repeated !== value) run = 0;
        const old = run;
        run = (run ? (run - 2) * (1 << extra) : 0) + r.read(extra) + 3;
        const count = run - old;
        requireDecode(count >= 0 && count <= size - at, 'JPEG XL prefix run exceeds the alphabet.', r);
        lengths.fill(value, at, at + count); at += count; repeated = value;
        if (value) space -= count * (32768 >>> value);
      }
      requireDecode(space >= 0, 'Oversubscribed JPEG XL prefix tree.', r);
    }
    requireDecode(space === 0, 'Incomplete JPEG XL prefix tree.', r);
  }
  return prefixTable(lengths);
}

export function readUintConfig(r, logAlphabet) {
  const split = r.read(ceilLog2(logAlphabet + 1));
  requireDecode(split <= logAlphabet, 'Invalid JPEG XL integer split.', r);
  const msb = split === logAlphabet ? 0 : r.read(ceilLog2(split + 1));
  requireDecode(msb <= split, 'Invalid JPEG XL integer high bits.', r);
  const lsb = split === logAlphabet ? 0 : r.read(ceilLog2(split - msb + 1));
  requireDecode(msb + lsb <= split, 'Invalid JPEG XL integer low bits.', r);
  const splitToken = 1 << split;
  return {split, msb, lsb, splitToken, fastLimit: splitToken};
}

export function readHybridUint(r, token, {split, msb, lsb}) {
  const splitToken = 1 << split;
  if (token < splitToken) return token;
  token -= splitToken;
  const msbLsb = msb + lsb;
  const bits = (token >>> msbLsb) + split - msbLsb;
  if (!(bits >= 0 && bits + msbLsb <= 31)) requireDecode(false, 'JPEG XL integer exceeds 32 bits.', r);
  const high = (1 << msb) | ((token >>> lsb) & ((1 << msb) - 1));
  let extra = 0;
  if (bits > 0) {
    const bit = r.bit;
    if (bit + bits > r.bytes.length * 8) requireDecode(false, 'Truncated JPEG XL data.', r);
    const at = bit < 4294967296 ? bit >>> 3 : Math.floor(bit / 8), shift = bit & 7, b = r.buf;
    let word = (b[at] >>> shift) | (b[at + 1] << (8 - shift)) | (b[at + 2] << (16 - shift)) | (b[at + 3] << (24 - shift));
    if (shift) word |= b[at + 4] << (32 - shift);
    r.bit = bit + bits;
    extra = word & ((1 << bits) - 1);
  }
  return ((((high << bits) | extra) << lsb) | (token & ((1 << lsb) - 1))) >>> 0;
}

function readDistribution(r, logAlphabet) {
  const limit = 1 << logAlphabet;
  let counts;
  if (r.read(1)) {
    const two = r.read(1), a = var8(r), b = two ? var8(r) : a;
    requireDecode(a < limit && b < limit && (!two || a !== b), 'Invalid JPEG XL ANS symbols.', r);
    counts = new Uint16Array(Math.max(a, b) + 1);
    counts[a] = two ? r.read(12) : 4096;
    if (two) counts[b] = 4096 - counts[a];
  } else if (r.read(1)) {
    const size = var8(r) + 1;
    requireDecode(size <= limit, 'Invalid JPEG XL flat ANS alphabet.', r);
    const each = Math.floor(4096 / size), extra = 4096 % size;
    counts = new Uint16Array(size).fill(each); counts.fill(each + 1, 0, extra);
  } else {
    let log = 0;
    while (log < 3 && r.read(1)) log++;
    const precision = r.read(log) + (1 << log) - 1, size = var8(r) + 3;
    requireDecode(precision <= 13 && size <= limit, 'Invalid JPEG XL ANS histogram.', r);
    const logs = new Uint8Array(size), repeats = new Uint16Array(size + 1);
    let omit = -1, highest = -1;
    for (let i = 0; i < size;) {
      const value = prefixToken(r, ANS_LOG_CODE);
      logs[i] = value;
      if (value === 13) {
        const n = var8(r) + 4;
        requireDecode(n <= size - i, 'JPEG XL ANS run exceeds the alphabet.', r);
        repeats[i] = n; i += n;
      } else {
        if (value > highest) { highest = value; omit = i; }
        i++;
      }
    }
    requireDecode(omit >= 0 && !repeats[omit + 1], 'Invalid omitted JPEG XL ANS count.', r);
    counts = new Uint16Array(size);
    let total = 0;
    for (let i = 0; i < size;) {
      if (repeats[i]) {
        const value = i ? counts[i - 1] : 0, n = repeats[i];
        counts.fill(value, i, i + n); total += value * n; i += n;
      } else {
        const code = logs[i] - 1;
        if (i !== omit && code >= 0) {
          const bits = Math.max(0, Math.min(code, precision - ((12 - code) >> 1)));
          counts[i] = (1 << code) + (r.read(bits) << (code - bits));
          total += counts[i];
        }
        i++;
      }
    }
    requireDecode(total < 4096, 'Invalid JPEG XL ANS population.', r);
    counts[omit] = 4096 - total;
  }
  const {starts, reverse} = reverseAlias(counts, logAlphabet);
  const symbols = new Uint8Array(4096), offsets = new Uint16Array(4096);
  let single = -1;
  for (let s = 0; s < counts.length; s++) {
    if (counts[s] === 4096) single = s;
    for (let i = 0; i < counts[s]; i++) {
      const at = reverse[starts[s] + i]; symbols[at] = s; offsets[at] = i;
    }
  }
  return {counts, symbols, offsets, single};
}

export function readContextMap(r, contexts, maxContexts = 268435457) {
  requireDecode(Number.isInteger(contexts) && contexts >= 1 && contexts <= maxContexts,
    'Invalid JPEG XL context count.', r);
  const map = new Uint8Array(contexts);
  if (contexts === 1) return map;
  if (r.read(1)) {
    const n = r.read(2);
    if (!n) return map;
    for (let i = 0; i < contexts; i++) map[i] = r.read(n);
  } else {
    const mtf = r.read(1), code = readEntropy(r, 1, {values: contexts, noLZ77: contexts <= 2});
    code.begin();
    for (let i = 0; i < contexts; i++) {
      const value = code.read(0);
      requireDecode(value < 256, 'JPEG XL context exceeds 255.', r);
      map[i] = value;
    }
    code.finish();
    if (mtf) {
      const order = Uint8Array.from({length: 256}, (_, i) => i);
      for (let i = 0; i < contexts; i++) {
        const rank = map[i], value = order[rank];
        order.copyWithin(1, 0, rank); order[0] = value; map[i] = value;
      }
    }
  }
  const seen = new Uint8Array(256);
  let max = 0, count = 0;
  for (const value of map) { max = Math.max(max, value); if (!seen[value]) { seen[value] = 1; count++; } }
  requireDecode(count === max + 1, 'JPEG XL context map has a hole.', r);
  return map;
}

export function readEntropy(r, contexts, options = {}) {
  const maxContexts = options.maxContexts ?? 268435456;
  requireDecode(Number.isSafeInteger(maxContexts) && maxContexts >= 1 && Number.isInteger(contexts) && contexts >= 1 && contexts <= maxContexts,
    'Invalid JPEG XL entropy context count.', r);
  const lz = !!r.read(1);
  requireDecode(!lz || !options.noLZ77, 'LZ77 is forbidden in this JPEG XL stream.', r);
  const minimum = lz ? r.u32([[0, 224], [0, 512], [0, 4096], [15, 8]]) : 0;
  const minLength = lz ? r.u32([[0, 3], [0, 4], [2, 5], [8, 9]]) : 0;
  const lengthConfig = lz ? readUintConfig(r, 8) : null;
  const map = readContextMap(r, contexts + Number(lz), maxContexts + 1);
  let count = 0;
  for (const value of map) count = Math.max(count, value + 1);
  const prefix = !!r.read(1), logAlphabet = prefix ? 15 : r.read(2) + 5;
  const configs = Array.from({length: count}, () => {
    const cfg = readUintConfig(r, logAlphabet);
    if (lz && minimum < cfg.fastLimit) cfg.fastLimit = minimum;
    return cfg;
  });
  let codes;
  if (prefix) {
    const sizes = configs.map(() => r.read(1) ? (n => 1 + (1 << n) + r.read(n))(r.read(4)) : 1);
    codes = sizes.map(size => readPrefixCode(r, size));
  } else codes = configs.map(() => readDistribution(r, logAlphabet));
  return new EntropyStream(r, {lz, minimum, minLength, lengthConfig, map, contexts, configs, prefix, codes}, options);
}

class EntropyStream {
  constructor(reader, model, {values = Number.MAX_SAFE_INTEGER, distanceMultiplier = 0} = {}) {
    requireDecode(Number.isSafeInteger(values) && values >= 0, 'Invalid JPEG XL entropy length.', reader);
    this.reader = reader;
    this.model = model;
    this.map = model.map;
    this.remaining = values;
    this.distanceMultiplier = distanceMultiplier;
    this.state = null;
    this.position = 0;
    this.left = 0;
    this.distance = 0;
    this.history = null;
    this.finished = false;
  }
  start(reader, options) { return new EntropyStream(reader, this.model, options); }
  begin() {
    requireDecode(!this.finished, 'JPEG XL entropy stream is finished.', this.reader);
    if (!this.model.prefix && this.state === null) this.state = this.reader.read(32);
    if (this.model.lz) this.history ??= HISTORY_POOL.pop() ?? new Uint32Array(WINDOW);
    return this;
  }
  token(cluster) {
    const code = this.model.codes[cluster];
    if (this.model.prefix) return prefixToken(this.reader, code);
    if (this.state === null || this.finished) this.begin();
    const at = this.state & 4095, symbol = code.symbols[at];
    this.state = code.counts[symbol] * (this.state >>> 12) + code.offsets[at];
    if (this.state < 65536) this.state = ((this.state << 16) | this.reader.read(16)) >>> 0;
    return symbol;
  }
  lzRun(r, m, token, distanceMultiplier) {
    this.left = readHybridUint(r, token - m.minimum, m.lengthConfig) + m.minLength - 1;
    requireDecode(this.position > 0 && this.left <= this.remaining && this.left < 0xffffffff,
      'Invalid JPEG XL LZ77 run.', r);
    const dc = m.map[m.contexts], raw = readHybridUint(r, this.token(dc), m.configs[dc]);
    let distance = raw + 1;
    if (distanceMultiplier) {
      requireDecode(Number.isSafeInteger(distanceMultiplier) && distanceMultiplier > 0,
        'Invalid JPEG XL spatial distance.', r);
      distance = raw < 120 ? Math.max(1, SCREEN_SPECIAL_DISTANCES[2 * raw] +
        distanceMultiplier * SCREEN_SPECIAL_DISTANCES[2 * raw + 1]) : raw - 119;
    }
    this.distance = Math.min(distance, this.position, WINDOW);
    return this.history[(this.position - this.distance) & MASK];
  }
  read(context, distanceMultiplier = this.distanceMultiplier) {
    const m = this.model, r = this.reader;
    if (!(!this.finished && (context | 0) === context && context >= 0 && context < m.contexts && this.remaining > 0))
      requireDecode(false, 'Invalid JPEG XL entropy read.', r);
    this.remaining--;
    if (!m.lz) {
      const cluster = m.map[context], token = this.token(cluster), cfg = m.configs[cluster];
      this.position++;
      return token < cfg.splitToken ? token : readHybridUint(r, token, cfg);
    }
    this.history ??= HISTORY_POOL.pop() ?? new Uint32Array(WINDOW);
    let value;
    if (this.left) {
      this.left--;
      value = this.history[(this.position - this.distance) & MASK];
    } else {
      const cluster = m.map[context], token = this.token(cluster), cfg = m.configs[cluster];
      if (token < cfg.fastLimit) value = token;
      else if (token >= m.minimum) value = this.lzRun(r, m, token, distanceMultiplier);
      else value = token < cfg.splitToken ? token : readHybridUint(r, token, cfg);
    }
    this.history[this.position & MASK] = value;
    this.position++;
    return value;
  }
  blockCoefficients(values, order, area, base, remaining, previous, scale) {
    const m = this.model, r = this.reader;
    if (m.lz || m.prefix) return -1;
    const map = m.map, codes = m.codes, configs = m.configs, contexts = m.contexts, size = values.length, logArea = 31 - Math.clz32(area);
    if (this.state === null) this.begin();
    let state = this.state;
    for (let k = area; k < size && remaining; k++) {
      const context = base + (COEFF_NUM_NONZERO_CONTEXT[((remaining - 1) >> logArea) + 1] + COEFF_FREQ_CONTEXT[((k - area) >> logArea) + 1]) * 2 + previous;
      if (!(!this.finished && context < contexts && this.remaining > 0)) { this.state = state; requireDecode(false, 'Invalid JPEG XL entropy read.', r); }
      this.remaining--; this.position++;
      const cluster = map[context], code = codes[cluster], at = state & 4095, symbol = code.symbols[at];
      state = code.counts[symbol] * (state >>> 12) + code.offsets[at];
      if (state < 65536) state = ((state << 16) | r.read(16)) >>> 0;
      const cfg = configs[cluster], token = symbol < cfg.splitToken ? symbol : readHybridUint(r, symbol, cfg);
      const value = (token >>> 1) ^ -(token & 1);
      const index = order[k], sum = values[index] + value * scale;
      if (!(sum >= -2147483648 && sum <= 2147483647)) { this.state = state; requireDecode(false, 'JPEG XL coefficient overflows its range.'); }
      values[index] = sum; previous = value !== 0 ? 1 : 0; remaining -= previous;
    }
    this.state = state;
    return remaining;
  }
  finish() {
    this.begin();
    requireDecode(this.left === 0 && (this.model.prefix || this.state === 0x130000),
      'Invalid JPEG XL entropy final state.', this.reader);
    this.finished = true;
    if (this.history && this.history.length === WINDOW && HISTORY_POOL.length < 4) {
      HISTORY_POOL.push(this.history);
      this.history = null;
    }
  }
}

export function readPermutation(code, size, skip = 0) {
  requireDecode(Number.isInteger(size) && size >= 0 && size <= 1 << 20 && Number.isInteger(skip) && skip >= 0 && skip <= size,
    'Invalid JPEG XL permutation size.');
  const context = value => Math.min(7, ceilLog2(value + 1));
  const end = code.read(context(size));
  requireDecode(end <= size - skip, 'Invalid JPEG XL permutation length.');
  const pool = size - skip, tree = new Uint32Array(pool + 1), out = new Uint32Array(size);
  for (let i = 1; i <= pool; i++) tree[i] = i & -i;
  for (let i = 0; i < skip; i++) out[i] = i;
  let previous = 0;
  const topBit = pool ? 1 << (31 - Math.clz32(pool)) : 0;
  for (let i = 0; i < pool; i++) {
    let rank = i < end ? code.read(context(previous)) : 0;
    requireDecode(rank < pool - i, 'Invalid JPEG XL permutation digit.');
    previous = rank;
    let at = 0;
    for (let bit = topBit; bit; bit >>= 1) {
      const next = at + bit;
      if (next <= pool && tree[next] <= rank) { rank -= tree[next]; at = next; }
    }
    out[skip + i] = skip + at;
    for (let next = at + 1; next <= pool; next += next & -next) tree[next]--;
  }
  return out;
}
