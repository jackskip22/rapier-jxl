// SPDX-License-Identifier: MIT
import {JPEG_LIMITS} from './limits.mjs';
import {ceilLog2} from './bits.mjs';
import {canonicalCodes} from './prefix.mjs';
import {LOG_LENGTHS, LOG_CODES, reverseAlias} from './ans.mjs';
import {ZIGZAG} from './jpeg-tables.mjs';
import {zeroDensityContext} from './vardct.mjs';
import {fault} from './admit.mjs';

const invalidJPEGData = () => fault('JXL_RECONSTRUCTION', 'Invalid or unsupported JPEG reconstruction data.');
export function requireJPEG(condition) { if (!condition) throw invalidJPEGData(); }
export class JxlBits {
  constructor(bytes) { this.bytes = bytes; this.bit = 0; }
  read(n) {
    const bit = this.bit, bytes = this.bytes;
    requireJPEG(n >= 0 && n <= 32 && bit + n <= bytes.length * 8);
    if (n <= 24) {
      const at = bit >>> 3;
      this.bit = bit + n;
      return ((bytes[at] | bytes[at + 1] << 8 | bytes[at + 2] << 16 | bytes[at + 3] << 24) >>> (bit & 7)) & ((1 << n) - 1);
    }
    let value = 0, shift = 0;
    while (n) {
      const take = Math.min(n, 8 - (this.bit & 7));
      value += ((bytes[this.bit >>> 3] >>> (this.bit & 7)) & ((1 << take) - 1)) * ((1 << shift) >>> 0);
      this.bit += take; shift += take; n -= take;
    }
    return value;
  }
  peek(n) {
    const bytes = this.bytes, at = this.bit >>> 3;
    return ((bytes[at] | bytes[at + 1] << 8 | bytes[at + 2] << 16 | bytes[at + 3] << 24) >>> (this.bit & 7)) & ((1 << n) - 1);
  }
  skip(n) { requireJPEG(this.bit + n <= this.bytes.length * 8); this.bit += n; }
  expect(n, value) { requireJPEG(this.read(n) === value); }
  u32(choices) { const [bits, offset] = choices[this.read(2)]; return this.read(bits) + offset; }
  align() { this.expect((-this.bit) & 7, 0); }
  end() { this.align(); requireJPEG(this.bit === this.bytes.length * 8); }
}
const signed = n => n & 1 ? -(n + 1) / 2 : n / 2;
const DENSITY = Int32Array.from({length: 64 * 64}, (_, i) => zeroDensityContext(i >> 6, i & 63, 0));
const var8 = r => r.read(1) ? (n => (1 << n) + r.read(n))(r.read(3)) : 0;
const PRIMARY = 10, LONG = 0x40000000;
function prefixDecoder(lengths, explicit) {
  const codes = explicit || canonicalCodes(lengths);
  let count = 0, last = 0, max = 0;
  for (let i = 0; i < lengths.length; i++) if (lengths[i]) { count++; last = i; max = Math.max(max, lengths[i]); }
  requireJPEG(count > 0);
  if (count === 1) return constant(last);
  const table = new Int32Array(1 << max).fill(-1), size = 1 << max;
  for (let n = 1; n <= max; n++) for (let i = 0; i < lengths.length; i++) {
    if (lengths[i] !== n || codes[i] >= 1 << n) continue;
    for (let j = codes[i]; j < size; j += 1 << n) if (table[j] < 0 || (table[j] & 31) === n) table[j] = i << 5 | n;
  }
  if (max <= PRIMARY) return {table, bits: max};
  const second = size >> PRIMARY, split = [];
  let offset = 1 << PRIMARY;
  const primary = new Int32Array(offset);
  for (let p = 0; p < 1 << PRIMARY; p++) {
    const entry = table[p];
    if (entry >= 0 && (entry & 31) <= PRIMARY) { primary[p] = entry; continue; }
    let used = false;
    for (let i = 0; i < second; i++) if (table[p + (i << PRIMARY)] >= 0) used = true;
    if (!used) { primary[p] = -1; continue; }
    primary[p] = LONG + offset; split.push(p); offset += second;
  }
  const twoLevel = new Int32Array(offset);
  twoLevel.set(primary);
  for (const p of split) for (let i = 0; i < second; i++) twoLevel[(primary[p] - LONG) + i] = table[p + (i << PRIMARY)];
  return {table: twoLevel, bits: max};
}
const constant = symbol => ({table: Int32Array.of(symbol << 5), bits: 0});
const lookup = (table, window, bits) => {
  const entry = table[window & ((1 << Math.min(bits, PRIMARY)) - 1)];
  return entry >= LONG ? table[entry - LONG + ((window >>> PRIMARY) & ((1 << (bits - PRIMARY)) - 1))] : entry;
};
function decode(r, {table, bits}) {
  const entry = lookup(table, r.peek(bits), bits);
  if (entry < 0) throw invalidJPEGData();
  r.skip(entry & 31); return entry >> 5;
}
function readPrefixCode(r, size) {
  if (size === 1) return constant(0);
  const lengths = new Uint8Array(size), form = r.read(2);
  if (form === 1) {
    const count = r.read(2) + 1, symbols = Array.from({length: count}, () => r.read(ceilLog2(size)));
    requireJPEG(new Set(symbols).size === count && symbols.every(s => s < size));
    if (count === 1) return constant(symbols[0]);
    const depths = count === 2 ? [1, 1] : count === 3 ? [1, 2, 2] : r.read(1) ? [1, 2, 3, 3] : [2, 2, 2, 2];
    symbols.forEach((s, i) => { lengths[s] = depths[i]; });
  } else {
    const order = [1, 2, 3, 4, 0, 5, 17, 6, 16, 7, 8, 9, 10, 11, 12, 13, 14, 15];
    const fixed = prefixDecoder([2, 4, 3, 2, 2, 4], [0, 7, 3, 2, 1, 15]), codeLengths = new Uint8Array(18);
    let space = 32;
    for (let i = form; i < order.length && space; i++) { const n = decode(r, fixed); codeLengths[order[i]] = n; if (n) space -= 32 >>> n; }
    requireJPEG(space === 0);
    const lengthCode = prefixDecoder(codeLengths);
    let at = 0, previous = 8, repeat = 0, repeated = -1;
    space = 32768;
    while (space && at < size) {
      const token = decode(r, lengthCode);
      if (token < 16) {
        lengths[at++] = token; if (token) { previous = token; space -= 32768 >>> token; }
        repeat = 0; repeated = -1;
      } else {
        const value = token === 16 ? previous : 0, bits = token === 16 ? 2 : 3;
        if (value !== repeated) repeat = 0;
        const old = repeat;
        repeat = (repeat ? (repeat - 2) * (1 << bits) : 0) + r.read(bits) + 3; repeated = value;
        const count = repeat - old;
        requireJPEG(count >= 0 && at + count <= size);
        lengths.fill(value, at, at + count); at += count;
        if (value) space -= count * (32768 >>> value);
      }
      requireJPEG(space >= 0);
    }
    requireJPEG(space === 0);
  }
  return prefixDecoder(lengths);
}
function config(r, log) {
  const split = r.read(ceilLog2(log + 1)); requireJPEG(split <= log);
  const msb = split === log ? 0 : r.read(ceilLog2(split + 1));
  const lsb = split === log ? 0 : r.read(ceilLog2(split - msb + 1));
  requireJPEG(msb + lsb <= split);
  return {split, msb, lsb};
}
function hybrid(r, token, {split, msb, lsb}) {
  if (token < (1 << split)) return token;
  token -= (1 << split);
  const bits = (token >>> (msb + lsb)) + split - msb - lsb;
  requireJPEG(bits + msb + lsb <= 31);
  return ((((1 << msb) + ((token >>> lsb) & ((1 << msb) - 1))) * ((1 << bits) >>> 0) + r.read(bits)) * (1 << lsb)) + (token & ((1 << lsb) - 1));
}
function distribution(r) {
  if (r.read(1)) {
    const count = r.read(1) + 1, symbols = Array.from({length: count}, () => var8(r));
    requireJPEG(count === 1 || symbols[0] !== symbols[1]);
    const counts = new Uint16Array(Math.max(...symbols) + 1);
    counts[symbols[0]] = count === 1 ? 4096 : r.read(12);
    if (count === 2) counts[symbols[1]] = 4096 - counts[symbols[0]];
    return counts;
  }
  if (r.read(1)) {
    const alphabet = var8(r) + 1;
    requireJPEG(alphabet >= 1 && alphabet <= 4096);
    const counts = new Uint16Array(alphabet), each = Math.floor(4096 / alphabet), extra = 4096 % alphabet;
    counts.fill(each);
    for (let i = 0; i < extra; i++) counts[i]++;
    return counts;
  }
  let log = 0;
  while (log < 3 && r.read(1)) log++;
  const shift = (r.read(log) | (1 << log)) - 1;
  requireJPEG(shift <= 13);
  const size = var8(r) + 3, lengths = new Uint8Array(size), repeats = new Uint16Array(size);
  requireJPEG(size <= 256);
  const logCode = prefixDecoder([...LOG_LENGTHS, 7], [...LOG_CODES, 65]);
  let omit = 0;
  for (let i = 0; i < size; i++) {
    const n = decode(r, logCode);
    if (n === 13) {
      const count = var8(r) + 4;
      requireJPEG(i > 0 && i + count <= size);
      lengths.fill(lengths[i - 1], i, i + count); repeats[i - 1] = count + 1; i += count - 1;
    } else { lengths[i] = n; if (n > lengths[omit]) omit = i; }
  }
  const counts = new Uint16Array(size);
  let total = 0;
  for (let i = 0; i < size; i++) {
    if (i !== omit && lengths[i]) {
      const code = lengths[i] - 1, bits = shift === 0 || code === 0 ? 0 : Math.max(0, Math.min(code, shift - ((12 - code) >> 1)));
      counts[i] = (1 << code) + (bits ? r.read(bits) << (code - bits) : 0);
    }
    const count = repeats[i] || 1;
    requireJPEG(i === omit || i + count <= omit || i > omit);
    counts.fill(counts[i], i, i + count); total += count * counts[i]; i += count - 1;
  }
  requireJPEG(total < 4096); counts[omit] = 4096 - total;
  return counts;
}
function contextMap(r, count, depth = 0) {
  requireJPEG(count <= 50000 && depth < 3);
  const map = new Uint8Array(count);
  if (r.read(1)) { const bits = r.read(2); if (bits) for (let i = 0; i < count; i++) map[i] = r.read(bits); }
  else {
    const order = r.read(1) ? Uint8Array.from({length: 256}, (_, i) => i) : null;
    const code = entropy(r, 1, {depth: depth + 1, values: count, byteHistory: true});
    for (let i = 0; i < count; i++) {
      const value = code.read(0); requireJPEG(value < 256);
      if (!order) { map[i] = value; continue; }
      const index = order[value]; map[i] = index;
      order.copyWithin(1, 0, value); order[0] = index;
    }
    code.finish();
  }
  if (count) {
    let widest = 0, seen = 0;
    const have = new Uint8Array(256);
    for (const value of map) { requireJPEG(value < 256); if (!have[value]) { have[value] = 1; seen++; } widest = Math.max(widest, value); }
    requireJPEG(seen === widest + 1);
  }
  return map;
}
function entropyModel(r, contexts, {depth = 0, byteHistory = false, history = false} = {}) {
  const lz = r.read(1), minimum = lz ? r.u32([[0, 224], [0, 512], [0, 4096], [15, 8]]) : 0;
  const minLength = lz ? r.u32([[0, 3], [0, 4], [2, 5], [8, 9]]) : 0, lengthConfig = lz ? config(r, 8) : null;
  const map = contexts + lz > 1 ? contextMap(r, contexts + lz, depth) : new Uint8Array(1);
  if (byteHistory) requireJPEG(map.subarray(0, contexts).every(value => value === map[0]));
  byteHistory ||= history;
  const count = 1 + Math.max(...map), prefix = r.read(1), log = prefix ? 15 : r.read(2) + 5;
  const configs = Array.from({length: count}, () => config(r, log));
  let decoders, aliases;
  if (prefix) {
    const sizes = configs.map(() => r.read(1) ? (n => (1 << n) + r.read(n) + 1)(r.read(4)) : 1);
    decoders = sizes.map(size => readPrefixCode(r, size));
  } else aliases = configs.map(() => {
    const counts = distribution(r), {starts, reverse} = reverseAlias(counts, log), symbols = new Uint16Array(4096), offsets = new Uint16Array(4096);
    for (let s = 0; s < counts.length; s++) for (let i = 0; i < counts[s]; i++) { const at = reverse[starts[s] + i]; symbols[at] = s; offsets[at] = i; }
    return {counts, symbols, offsets};
  });
  return {contexts, lz, minimum, minLength, lengthConfig, map, prefix, configs, decoders, aliases, byteHistory};
}
function entropyReader(model, r, values, spatial = false) {
  requireJPEG(Number.isSafeInteger(values) && values >= 0);
  const {contexts, lz, minimum, minLength, lengthConfig, map, prefix, configs, decoders, aliases, byteHistory} = model;
  let remaining = values, state = null, left = 0, previous = 0, produced = false, position = 0, distance = 1;
  const history = byteHistory ? new Uint8Array(1048576) : null;
  const direct = Int32Array.from(configs, c => 1 << c.split), tables = prefix && decoders.map(d => d.table), widths = prefix && Int32Array.from(decoders, d => d.bits);
  const remember = value => {
    if (history) { requireJPEG(value < 256); history[position++ & 1048575] = value; }
    return previous = value;
  };
  const token = h => {
    if (prefix) {
      const entry = lookup(tables[h], r.peek(widths[h]), widths[h]);
      if (entry < 0) throw invalidJPEGData();
      r.skip(entry & 31); return entry >> 5;
    }
    state ??= r.read(32);
    const a = aliases[h], at = state & 4095, s = a.symbols[at];
    state = a.counts[s] * Math.floor(state / 4096) + a.offsets[at];
    if (state < 65536) state = state * 65536 + r.read(16);
    return s;
  };
  const plain = lz || history ? null : prefix ? ctx => {
    requireJPEG(ctx >= 0 && ctx < contexts && remaining > 0); remaining--;
    const h = map[ctx], bit = r.bit, bytes = r.bytes, at = bit >>> 3;
    const entry = lookup(tables[h], (bytes[at] | bytes[at + 1] << 8 | bytes[at + 2] << 16 | bytes[at + 3] << 24) >>> (bit & 7), widths[h]);
    if (entry < 0) throw invalidJPEGData();
    requireJPEG(bit + (entry & 31) <= bytes.length * 8); r.bit = bit + (entry & 31);
    const t = entry >> 5;
    return t < direct[h] ? t : hybrid(r, t, configs[h]);
  } : ctx => {
    requireJPEG(ctx >= 0 && ctx < contexts && remaining > 0); remaining--;
    const h = map[ctx];
    state ??= r.read(32);
    const a = aliases[h], at = state & 4095, s = a.symbols[at];
    state = a.counts[s] * Math.floor(state / 4096) + a.offsets[at];
    if (state < 65536) state = state * 65536 + r.read(16);
    return s < direct[h] ? s : hybrid(r, s, configs[h]);
  };
  return {
    read: plain || (ctx => {
      requireJPEG(ctx >= 0 && ctx < contexts && remaining > 0); remaining--;
      if (left) { left--; return remember(history ? history[(position - distance) & 1048575] : previous); }
      const h = map[ctx], t = token(h);
      if (lz && t >= minimum) {
        left = hybrid(r, t - minimum, lengthConfig) + minLength - 1;
        requireJPEG(left <= remaining);
        const histogram = map[contexts], d = hybrid(r, token(histogram), configs[histogram]);
        if (history) { distance = d + 1; requireJPEG(distance <= Math.min(position, 1048576)); }
        else requireJPEG(produced && d === (spatial ? 1 : 0));
        return remember(history ? history[(position - distance) & 1048575] : previous);
      }
      produced = true; return remember(t < direct[h] ? t : hybrid(r, t, configs[h]));
    }),
    finish() { requireJPEG(!left && (prefix || state === 0x130000 || values === 0)); state = null; produced = false; },
  };
}
function entropy(r, contexts, options) { return entropyReader(entropyModel(r, contexts, options), r, options.values, options.spatial); }

const iccKind1 = b => (b >= 97 && b <= 122) || (b >= 65 && b <= 90) ? 0 : (b >= 48 && b <= 57) || b === 46 || b === 44 ? 1 : b === 0 ? 2 : b === 1 ? 3 : b < 16 ? 4 : b === 255 ? 6 : b > 240 ? 5 : 7;
const iccKind2 = b => (b >= 97 && b <= 122) || (b >= 65 && b <= 90) ? 0 : (b >= 48 && b <= 57) || b === 46 || b === 44 ? 1 : b < 16 ? 2 : b > 240 ? 3 : 4;
export function readEncodedICC(r) {
  const start = r.bit, form = r.read(2);
  let size = form === 1 ? r.read(4) + 1 : form === 2 ? r.read(8) + 17 : form === 3 ? r.read(12) : 0;
  if (form === 3) for (let shift = 12; r.read(1); shift += 8) {
    requireJPEG(shift <= 28); size += r.read(8) * ((1 << shift) >>> 0);
  }
  requireJPEG(size >= 132 && size <= 0xffffffff + 16 && size <= Math.max(65536, (r.bytes.length * 8 - start) * 32));
  const code = entropy(r, 41, {history: true, values: size}), bytes = new Uint8Array(size);
  let previous = 0, older = 0;
  for (let i = 0; i < size; i++) {
    if (i && i % 65536 === 0) requireJPEG(i <= (r.bit - start) * 32);
    const value = code.read(i <= 128 ? 0 : 1 + iccKind1(previous) + iccKind2(older) * 8);
    requireJPEG(value < 256); bytes[i] = value; older = previous; previous = value;
  }
  code.finish(); return bytes;
}
export function skipICC(r) { readEncodedICC(r); }
const WP_DIVISORS = Int32Array.from({length: 64}, (_, i) => Math.floor(16777216 / (i + 1)));
const wpWeight = (sum, most) => { const shift = Math.max(0, 26 - Math.clz32(sum + 1)); return 4 + ((most * WP_DIVISORS[sum >> shift]) >> shift); };
function weightedReader(width) {
  const stride = width + 2, e0 = new Int32Array(2 * stride), e1 = new Int32Array(2 * stride), e2 = new Int32Array(2 * stride), e3 = new Int32Array(2 * stride), error = new Int32Array(2 * stride);
  let cur = 0, prev = 0, x = 0, p0 = 0, p1 = 0, p2 = 0, p3 = 0, pred = 0, most = 0;
  return {
    predict(px, py, left, top, topright) {
      x = px; cur = py & 1 ? 0 : stride; prev = py & 1 ? stride : 0;
      const n = prev + x, ne = x < width - 1 ? n + 1 : n, nw = x ? n - 1 : n;
      let w0 = wpWeight(e0[n] + e0[ne] + e0[nw], 13), w1 = wpWeight(e1[n] + e1[ne] + e1[nw], 12);
      let w2 = wpWeight(e2[n] + e2[ne] + e2[nw], 12), w3 = wpWeight(e3[n] + e3[ne] + e3[nw], 12);
      const N = top * 8, W = left * 8, NE = topright * 8;
      const teW = x ? error[cur + x - 1] : 0, teN = error[n], teNW = error[nw], teNE = error[ne], sumWN = teN + teW;
      most = teW;
      if (Math.abs(teN) > Math.abs(most)) most = teN;
      if (Math.abs(teNW) > Math.abs(most)) most = teNW;
      if (Math.abs(teNE) > Math.abs(most)) most = teNE;
      p0 = W + NE - N; p1 = N - (((sumWN + teNE) * 16) >> 5); p2 = W - (((sumWN + teNW) * 10) >> 5); p3 = N - (((teNW + teN + teNE) * 7) >> 5);
      const shift = 27 - Math.clz32(w0 + w1 + w2 + w3);
      w0 >>= shift; w1 >>= shift; w2 >>= shift; w3 >>= shift;
      const sum = w0 + w1 + w2 + w3;
      pred = Math.floor(((sum >> 1) - 1 + p0 * w0 + p1 * w1 + p2 * w2 + p3 * w3) * WP_DIVISORS[sum - 1] / 16777216);
      if (((teN ^ teW) | (teN ^ teNW)) <= 0) { const lo = Math.min(W, NE, N), hi = Math.max(W, NE, N); pred = pred < lo ? lo : pred > hi ? hi : pred; }
      return (pred + 3) >> 3;
    },
    get most() { return most; },
    update(value) {
      const v = value * 8, a0 = (Math.abs(p0 - v) + 3) >> 3, a1 = (Math.abs(p1 - v) + 3) >> 3, a2 = (Math.abs(p2 - v) + 3) >> 3, a3 = (Math.abs(p3 - v) + 3) >> 3;
      error[cur + x] = pred - v;
      e0[cur + x] = a0; e1[cur + x] = a1; e2[cur + x] = a2; e3[cur + x] = a3;
      e0[prev + x + 1] += a0; e1[prev + x + 1] += a1; e2[prev + x + 1] += a2; e3[prev + x + 1] += a3;
    },
  };
}
const clampedGradient = (w, n, nw) => Math.max(Math.min(w, n), Math.min(Math.max(w, n), w + n - nw));

function readMaTree(r, channels) {
  const treeCode = entropy(r, 6, {values: 6 * 65536}), nodes = [{}], leaves = [];
  for (const node of nodes) {
    requireJPEG(nodes.length <= 65536);
    const property = treeCode.read(1);
    if (property) {
      node.property = property - 1; requireJPEG(node.property >= 0 && node.property < 16 + 4 * channels);
      node.cut = signed(treeCode.read(0)); node.left = {}; node.right = {}; nodes.push(node.left, node.right);
    } else {
      node.predictor = treeCode.read(2); node.offset = signed(treeCode.read(3));
      const shift = treeCode.read(4), bits = treeCode.read(5);
      requireJPEG(node.predictor <= 13 && shift <= 31 && bits < 65536);
      node.multiplier = (bits + 1) * (shift < 31 ? 1 << shift : 2147483648);
      node.ctx = leaves.length; leaves.push(node);
    }
  }
  treeCode.finish();
  return {root: nodes[0], leaves};
}
function modular(r, shapes, shared, stream = 0) {
  const useGlobal = !!r.read(1), wpDefault = !!r.read(1);
  requireJPEG(wpDefault && r.u32([[0, 0], [0, 1], [4, 2], [8, 18]]) === 0);
  const pixels = shapes.reduce((n, [width, height]) => n + width * height, 0);
  let root, leaves, code;
  if (useGlobal) { requireJPEG(shared); ({root, leaves} = shared.tree); code = entropyReader(shared.model, r, pixels, true); }
  else { ({root, leaves} = readMaTree(r, shapes.length)); code = entropy(r, leaves.length, {spatial: true, values: pixels}); }
  const planes = [];
  let weighted = false;
  for (const pending = [root]; pending.length;) {
    const node = pending.pop();
    if (node.left) { if (node.property === 15) weighted = true; pending.push(node.left, node.right); } else if (node.predictor === 6) weighted = true;
  }
  for (let c = 0; c < shapes.length; c++) {
    const [width, height] = shapes[c], data = new Int32Array(width * height), wp = weighted ? weightedReader(width) : null;
    const refs = [];
    for (let j = c - 1; j >= 0; j--) if (shapes[j][0] === width && shapes[j][1] === height) refs.push(planes[j]);
    for (let y = 0, i = 0; y < height; y++) for (let x = 0; x < width; x++, i++) {
      const w = x ? data[i - 1] : y ? data[i - width] : 0, n = y ? data[i - width] : w, nw = x && y ? data[i - width - 1] : w;
      const ne = y && x + 1 < width ? data[i - width + 1] : n, nn = y > 1 ? data[i - 2 * width] : n, ww = x > 1 ? data[i - 2] : w;
      const prediction = wp ? wp.predict(x, y, w, n, ne) : 0;
      let leaf = root;
      while (leaf.left) {
        const p = leaf.property;
        let value;
        if (p >= 16) {
          requireJPEG(refs.length > (p - 16) >> 2);
          const ref = refs[(p - 16) >> 2], kind = (p - 16) & 3, v = ref[i];
          if (kind < 2) value = kind ? v : Math.abs(v);
          else {
            const rw = x ? ref[i - 1] : 0, rn = y ? ref[i - width] : rw, rnw = x && y ? ref[i - width - 1] : rw, d = v - clampedGradient(rw, rn, rnw);
            value = kind === 2 ? Math.abs(d) : d;
          }
        } else switch (p) {
          case 0: value = c; break;
          case 1: value = stream; break;
          case 2: value = y; break;
          case 3: value = x; break;
          case 4: value = Math.abs(n); break;
          case 5: value = Math.abs(w); break;
          case 6: value = n; break;
          case 7: value = w; break;
          case 8: {
            if (!x) { value = w; break; }
            const pw = x > 1 ? data[i - 2] : y ? data[i - width - 1] : 0, pn = y ? data[i - width - 1] : pw, pnw = x > 1 && y ? data[i - width - 2] : pw;
            value = w - (pw + pn - pnw); break;
          }
          case 9: value = w + n - nw; break;
          case 10: value = w - nw; break;
          case 11: value = nw - n; break;
          case 12: value = n - ne; break;
          case 13: value = n - nn; break;
          case 14: value = w - ww; break;
          default: value = wp.most;
        }
        leaf = value > leaf.cut ? leaf.left : leaf.right;
      }
      let predicted;
      switch (leaf.predictor) {
        case 0: predicted = 0; break;
        case 1: predicted = w; break;
        case 2: predicted = n; break;
        case 3: predicted = Math.trunc((w + n) / 2); break;
        case 4: { const g = w + n - nw; predicted = Math.abs(g - w) < Math.abs(g - n) ? w : n; break; }
        case 5: predicted = clampedGradient(w, n, nw); break;
        case 6: predicted = prediction; break;
        case 7: predicted = ne; break;
        case 8: predicted = nw; break;
        case 9: predicted = ww; break;
        case 10: predicted = Math.trunc((w + nw) / 2); break;
        case 11: predicted = Math.trunc((nw + n) / 2); break;
        case 12: predicted = Math.trunc((n + ne) / 2); break;
        default: { const nee = y && x + 2 < width ? data[i - width + 2] : ne; predicted = Math.trunc((6 * n - 2 * nn + 7 * w + ww + nee + 3 * ne + 8) / 16); }
      }
      const residual = code.read(leaf.ctx);
      const value = predicted + signed(residual) * leaf.multiplier + leaf.offset;
      requireJPEG(Number.isSafeInteger(value));
      data[i] = value;
      wp?.update(data[i]);
    }
    planes.push(data);
  }
  code.finish(); return planes;
}

export function readJPEGCoefficients(bytes, {reconstruction = false} = {}) {
  requireJPEG(bytes instanceof Uint8Array && bytes.length > 0);
  const r = new JxlBits(bytes), size = [[9, 1], [13, 1], [18, 1], [30, 1]];
  r.expect(16, 0x0aff);
  const small = !!r.read(1), ratios = [null, [1, 1], [12, 10], [4, 3], [3, 2], [16, 9], [5, 4], [2, 1]];
  const height = small ? (r.read(5) + 1) * 8 : r.u32(size), ratio = r.read(3);
  const width = ratio ? Math.floor(height * ratios[ratio][0] / ratios[ratio][1]) : small ? (r.read(5) + 1) * 8 : r.u32(size);
  requireJPEG(width <= JPEG_LIMITS.edge && height <= JPEG_LIMITS.edge && width * height <= JPEG_LIMITS.pixels);
  r.expect(1, 0); const extra = r.read(1), orientation = extra ? r.read(3) + 1 : 1;
  if (extra) r.expect(3, 0);
  r.expect(3, 0); r.read(1); r.expect(2, 0); r.expect(1, 0);
  let grey = false, icc = false;
  if (!r.read(1)) {
    icc = !!r.read(1); const color = r.u32([[0, 0], [0, 1], [4, 2], [6, 18]]);
    requireJPEG(color <= 1); grey = color === 1;
    if (!icc) {
      r.expect(2, 1);
      if (!grey) { const primaries = r.u32([[0, 0], [0, 1], [4, 2], [6, 18]]); requireJPEG(primaries === 1 || primaries === 11); }
      r.expect(1, 0); requireJPEG(r.u32([[0, 0], [0, 1], [4, 2], [6, 18]]) === 13); r.expect(2, 1);
    }
  }
  if (extra) r.expect(1, 1);
  r.expect(3, 4); const profile = icc ? readEncodedICC(r) : null; r.align(); r.expect(4, 0); r.expect(2, 2); r.expect(8, 111);
  const ycbcr = !!r.read(1), sampling = ycbcr ? [r.read(2), r.read(2), r.read(2)] : [0, 0, 0];
  const hs = sampling.map(v => v === 1 || v === 2 ? 1 : 0), vs = sampling.map(v => v === 1 || v === 3 ? 1 : 0);
  const mh = Math.max(...hs), mv = Math.max(...vs), hshift = hs.map(v => mh - v), vshift = vs.map(v => mv - v);
  r.expect(7, 0); r.expect(11, 1); r.expect(1, 0); r.align();
  const blocksW = Math.ceil(width / (8 << mh)) << mh, blocksH = Math.ceil(height / (8 << mv)) << mv;
  const groupsX = Math.ceil(width / 256), groups = groupsX * Math.ceil(height / 256), dcX = Math.ceil(blocksW / 256), dcs = dcX * Math.ceil(blocksH / 256);
  const sizes = Array.from({length: groups === 1 ? 1 : 2 + groups + dcs}, () => r.u32([[10, 0], [14, 1024], [22, 17408], [30, 4211712]]));
  r.align(); let at = r.bit / 8;
  const sections = sizes.map(n => { const part = bytes.subarray(at, at += n); requireJPEG(part.length === n); return new JxlBits(part); });
  requireJPEG(at === bytes.length);
  const section = i => sections[groups === 1 ? 0 : i], end = reader => { if (groups !== 1) reader.end(); };
  const tilesW = (blocksW + 7) >> 3, tilesH = (blocksH + 7) >> 3, toX = new Int32Array(tilesW * tilesH), toB = new Int32Array(tilesW * tilesH);
  const planes = [0, 1, 2].map(c => ({h: 1 << hs[c], v: 1 << vs[c], stride: blocksW >> hshift[c], rows: blocksH >> vshift[c], dc: new Int32Array((blocksW >> hshift[c]) * (blocksH >> vshift[c])), coeffs: new Int16Array((blocksW >> hshift[c]) * (blocksH >> vshift[c]) * 64)}));
  const dc = section(0); dc.expect(1, 0); dc.read(16); dc.read(16); dc.read(16);
  dc.u32([[11, 1], [11, 2049], [12, 4097], [16, 8193]]);
  dc.u32([[0, 16], [5, 1], [8, 1], [16, 1]]);
  const dcDist = [[4, 0], [8, 16], [16, 272], [32, 65808]], qfDist = [[2, 0], [3, 4], [5, 12], [8, 44]];
  const defaultMap = Uint8Array.of(0, 1, 2, 2, 3, 3, 4, 5, 6, 6, 6, 6, 6, 7, 8, 9, 9, 10, 11, 12, 13, 14, 14, 14, 14, 14, 7, 8, 9, 9, 10, 11, 12, 13, 14, 14, 14, 14, 14);
  let dcThresholds, qfThresholds, numDc, map, contexts;
  if (dc.read(1)) { dcThresholds = [[], [], []]; qfThresholds = []; numDc = 1; map = defaultMap; contexts = 15; }
  else {
    dcThresholds = [0, 1, 2].map(() => Array.from({length: dc.read(4)}, () => signed(dc.u32(dcDist))));
    numDc = dcThresholds.reduce((n, list) => n * (list.length + 1), 1);
    qfThresholds = Array.from({length: dc.read(4)}, () => dc.u32(qfDist) + 1);
    requireJPEG(numDc * (qfThresholds.length + 1) <= 64);
    map = contextMap(dc, 3 * 13 * numDc * (qfThresholds.length + 1)); contexts = Math.max(...map) + 1;
    requireJPEG(contexts <= 16);
  }
  if (!dc.read(1)) {
    requireJPEG(dc.u32([[0, 84], [0, 256], [8, 2], [16, 258]]) === 84);
    const zero = half => (half & 0x7fff) === 0;
    requireJPEG(zero(dc.read(16)) && zero(dc.read(16)) && dc.read(8) === 128 && dc.read(8) === 128);
  }
  let shared = null;
  if (dc.read(1)) { const tree = readMaTree(dc, 256); shared = {tree, model: entropyModel(dc, tree.leaves.length)}; }
  end(dc);
  for (let g = 0; g < dcs; g++) {
    const reader = section(1 + g), x0 = g % dcX * 256, y0 = Math.floor(g / dcX) * 256, rw = Math.min(256, blocksW - x0), rh = Math.min(256, blocksH - y0);
    reader.expect(2, 0);
    const values = modular(reader, [1, 0, 2].map(c => [rw >> hshift[c], rh >> vshift[c]]), shared, 1 + g);
    for (const [i, c] of [1, 0, 2].entries()) {
      const p = planes[c], w = rw >> hshift[c], h = rh >> vshift[c];
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) p.dc[(y + (y0 >> vshift[c])) * p.stride + x + (x0 >> hshift[c])] = values[i][y * w + x];
    }
    const n = rw * rh; reader.expect(ceilLog2(n), n - 1);
    const cw = (rw + 7) >> 3, ch = (rh + 7) >> 3;
    const [ytox, ytob, blocks] = modular(reader, [[cw, ch], [cw, ch], [n, 2], [rw, rh]], shared, 1 + 2 * dcs + g);
    requireJPEG(blocks.subarray(0, n).every(strategy => strategy === 0));
    for (let ty = 0; ty < ch; ty++) for (let tx = 0; tx < cw; tx++) {
      const at = ((y0 >> 3) + ty) * tilesW + (x0 >> 3) + tx;
      toX[at] = ytox[ty * cw + tx]; toB[at] = ytob[ty * cw + tx];
    }
    end(reader);
  }
  const ac = section(1 + dcs); ac.expect(1, 0); ac.expect(3, 7); ac.read(16);
  const matrices = modular(ac, [[8, 8], [8, 8], [8, 8]], shared, 1 + 3 * dcs);
  for (let c = 0; c < 3; c++) {
    const p = planes[c]; p.quant = Int32Array.from({length: 64}, (_, k) => matrices[c][(k % 8) * 8 + (k >> 3)]);
    requireJPEG(p.quant.every(q => q > 0 && q < 65536));
  }
  ac.expect(32, 0); ac.expect(16, 0);
  if (groups > 1) ac.expect(ceilLog2(groups), 0);
  const natural = ZIGZAG.map(k => (k % 8) * 8 + (k >> 3)), orders = [natural, natural, natural];
  const orderBits = ac.u32([[0, 95], [0, 19], [0, 0], [13, 0]]);
  requireJPEG(orderBits === 0 || orderBits === 1);
  const orderContext = value => Math.min(32 - Math.clz32(value), 7);
  if (orderBits) {
    const code = entropy(ac, 8, {values: 3 * 64});
    for (let c = 0; c < 3; c++) {
      const length = code.read(orderContext(64)) + 1, available = natural.slice(1), order = [0]; requireJPEG(length <= 64);
      let last = 0;
      for (let k = 1; k < length; k++) {
        const index = code.read(orderContext(last)); requireJPEG(index < available.length);
        last = index; order.push(available.splice(index, 1)[0]);
      }
      orders[c] = order.concat(available);
    }
    code.finish();
  }
  const code = entropy(ac, contexts * 495, {values: planes.reduce((n, plane) => n + plane.coeffs.length, 0)}); end(ac);
  const zigzag = orders.map(order => Int32Array.from(order)), zeroBase = contexts * 37;
  const qfRow = (qfThresholds.length + 1) * numDc * 13, flat = dcThresholds.every(list => !list.length);
  const bucketOf = (value, list) => { let n = 0; for (const t of list) n += value > t; return n; };
  const sample = (c, x, y) => { const p = planes[c]; return p.dc[(y >> vshift[c]) * p.stride + (x >> hshift[c])]; };
  const nonzero = [0, 1, 2].map(() => new Uint8Array(1024)), read = code.read;
  for (let g = 0; g < groups; g++) {
    const reader = section(2 + dcs + g);
    if (groups !== 1) { ac.bytes = reader.bytes; ac.bit = 0; }
    const x0 = g % groupsX * 32, y0 = Math.floor(g / groupsX) * 32, bw = Math.min(32, blocksW - x0), bh = Math.min(32, blocksH - y0);
    for (const row of nonzero) row.fill(0);
    for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) for (let i = 0; i < 3; i++) {
      const c = i === 0 ? 1 : i === 1 ? 0 : 2;
      const sx = x >> hshift[c], sy = y >> vshift[c]; if ((sx << hshift[c]) !== x || (sy << vshift[c]) !== y) continue;
      const p = planes[c], coeffs = p.coeffs, order = zigzag[c], base = (((y0 >> vshift[c]) + sy) * p.stride + (x0 >> hshift[c]) + sx) * 64, row = nonzero[c];
      const predicted = sx ? sy ? (row[(sy - 1) * 32 + sx] + row[sy * 32 + sx - 1] + 1) >> 1 : row[sx - 1] : sy ? row[(sy - 1) * 32] : 32;
      let dcIdx = 0;
      if (!flat) {
        const bucketX = bucketOf(sample(0, x0 + x, y0 + y), dcThresholds[0]);
        const bucketY = bucketOf(sample(1, x0 + x, y0 + y), dcThresholds[1]);
        const bucketB = bucketOf(sample(2, x0 + x, y0 + y), dcThresholds[2]);
        dcIdx = (bucketX * (dcThresholds[2].length + 1) + bucketB) * (dcThresholds[1].length + 1) + bucketY;
      }
      const ctx = map[(c < 2 ? c ^ 1 : 2) * qfRow + dcIdx];
      let left = read((predicted < 8 ? predicted : 4 + (predicted >> 1)) * contexts + ctx); requireJPEG(left <= 63);
      row[sy * 32 + sx] = left; let previous = left > 4 ? 0 : 1;
      const histograms = zeroBase + ctx * 458;
      for (let k = 1; k < 64 && left; k++) {
        const token = read(histograms + DENSITY[left << 6 | k] + previous), value = token & 1 ? -(token + 1) / 2 : token / 2;
        requireJPEG(value >= -32768 && value <= 32767); coeffs[base + order[k]] = value;
        previous = value ? 1 : 0; left -= previous;
      }
      requireJPEG(left === 0);
    }
    code.finish(); ac.end();
  }
  if (toX.some(Boolean) || toB.some(Boolean)) {
    requireJPEG(hshift.every(v => !v) && vshift.every(v => !v));
    const luma = planes[1], ratio = factor => Math.trunc(factor * 2048 / 84);
    const scaled = [0, 2].map(c => Int32Array.from(planes[c].quant, (q, k) => Math.trunc(2048 * luma.quant[k] / q)));
    for (let b = 0; b < blocksW * blocksH; b++) {
      const tile = ((b / blocksW | 0) >> 3) * tilesW + ((b % blocksW) >> 3), factors = [ratio(toX[tile]), ratio(toB[tile])];
      for (const [i, c] of [0, 2].entries()) {
        if (!factors[i]) continue;
        const target = planes[c].coeffs;
        for (let k = 1; k < 64; k++) {
          const at = b * 64 + k, y = luma.coeffs[at];
          if (!y) continue;
          const scale = (factors[i] * scaled[i][k] + 1024) >> 11, value = target[at] + ((scale * y + 1024) >> 11);
          requireJPEG(value >= -32768 && value <= 32767); target[at] = value;
        }
      }
    }
  }
  for (const p of planes) {
    let divisor = 1024; while (p.quant[0] % divisor) divisor >>= 1;
    const lift = reconstruction ? Math.floor(1024 / p.quant[0]) : 1024 / divisor;
    const scale = reconstruction ? 1 : p.quant[0] / divisor;
    for (let b = 0; b < p.dc.length; b++) {
      const dc = ycbcr ? p.dc[b] : (p.dc[b] - lift) / scale;
      requireJPEG(Number.isInteger(dc) && dc >= -32768 && dc <= 32767); p.coeffs[b * 64] = dc;
    }
    delete p.dc;
  }
  return {width, height, orientation, ycbcr, icc: profile, components: grey ? [planes[1]] : ycbcr ? [planes[1], planes[0], planes[2]] : planes};
}
