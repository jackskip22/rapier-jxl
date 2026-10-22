// SPDX-License-Identifier: MIT
import {ceilLog2, JPEG_LIMITS} from './bits.mjs';
import {canonicalCodes} from './prefix.mjs';
import {LOG_LENGTHS, LOG_CODES, reverseAlias} from './ans.mjs';
import {ZIGZAG} from './jfif.mjs';
import {zeroDensityContext} from './vardct.mjs';
import {fault} from './admit.mjs';

const invalidJPEGData = () => fault('JXL_RECONSTRUCTION', 'Invalid or unsupported JPEG reconstruction data.');
export function requireJPEG(condition) { if (!condition) throw invalidJPEGData(); }
export class JxlBits {
  constructor(bytes) { this.bytes = bytes; this.bit = 0; }
  read(n) {
    requireJPEG(n >= 0 && n <= 32 && this.bit + n <= this.bytes.length * 8);
    let value = 0, shift = 0;
    while (n) {
      const take = Math.min(n, 8 - (this.bit & 7));
      value += ((this.bytes[this.bit >>> 3] >>> (this.bit & 7)) & ((1 << take) - 1)) * ((1 << shift) >>> 0);
      this.bit += take; shift += take; n -= take;
    }
    return value;
  }
  expect(n, value) { requireJPEG(this.read(n) === value); }
  u32(choices) { const [bits, offset] = choices[this.read(2)]; return this.read(bits) + offset; }
  align() { this.expect((-this.bit) & 7, 0); }
  end() { this.align(); requireJPEG(this.bit === this.bytes.length * 8); }
}
const signed = n => n & 1 ? -(n + 1) / 2 : n / 2;
const var8 = r => r.read(1) ? (n => (1 << n) + r.read(n))(r.read(3)) : 0;
function prefixDecoder(lengths, explicit) {
  const codes = explicit || canonicalCodes(lengths), tables = [];
  let count = 0, last = 0, max = 0;
  for (let i = 0; i < lengths.length; i++) if (lengths[i]) {
    (tables[lengths[i]] ||= new Map()).set(codes[i], i); count++; last = i; max = Math.max(max, lengths[i]);
  }
  requireJPEG(count > 0);
  if (count === 1) return () => last;
  return r => {
    let code = 0;
    for (let n = 1; n <= max; n++) { code |= r.read(1) << (n - 1); const value = tables[n]?.get(code); if (value !== undefined) return value; }
    throw invalidJPEGData();
  };
}
function readPrefix(r, size) {
  if (size === 1) return () => 0;
  const lengths = new Uint8Array(size), form = r.read(2);
  if (form === 1) {
    const count = r.read(2) + 1, symbols = Array.from({length: count}, () => r.read(ceilLog2(size)));
    requireJPEG(new Set(symbols).size === count && symbols.every(s => s < size));
    if (count === 1) return () => symbols[0];
    const depths = count === 2 ? [1, 1] : count === 3 ? [1, 2, 2] : r.read(1) ? [1, 2, 3, 3] : [2, 2, 2, 2];
    symbols.forEach((s, i) => { lengths[s] = depths[i]; });
  } else {
    const order = [1, 2, 3, 4, 0, 5, 17, 6, 16, 7, 8, 9, 10, 11, 12, 13, 14, 15];
    const fixed = prefixDecoder([2, 4, 3, 2, 2, 4], [0, 7, 3, 2, 1, 15]), codeLengths = new Uint8Array(18);
    let space = 32;
    for (let i = form; i < order.length && space; i++) { const n = fixed(r); codeLengths[order[i]] = n; if (n) space -= 32 >>> n; }
    requireJPEG(space === 0);
    const decode = prefixDecoder(codeLengths);
    let at = 0, previous = 8, repeat = 0, repeated = -1;
    space = 32768;
    while (space && at < size) {
      const token = decode(r);
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
  r.expect(1, 0); r.expect(3, 7); r.expect(3, 5);
  const size = var8(r) + 3, lengths = new Uint8Array(size), repeats = new Uint16Array(size);
  requireJPEG(size <= 256);
  const decode = prefixDecoder([...LOG_LENGTHS, 7], [...LOG_CODES, 65]);
  let omit = 0;
  for (let i = 0; i < size; i++) {
    const n = decode(r);
    if (n === 13) {
      const count = var8(r) + 4;
      requireJPEG(i > 0 && i + count <= size);
      lengths.fill(lengths[i - 1], i, i + count); repeats[i - 1] = count + 1; i += count - 1;
    } else { lengths[i] = n; if (n > lengths[omit]) omit = i; }
  }
  const counts = new Uint16Array(size);
  let total = 0;
  for (let i = 0; i < size; i++) {
    if (i !== omit) counts[i] = !lengths[i] ? 0 : lengths[i] === 1 ? 1 : (1 << (lengths[i] - 1)) + r.read(lengths[i] - 1);
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
  if (r.read(1)) { const bits = r.read(2); for (let i = 0; i < count; i++) map[i] = r.read(bits); }
  else {
    r.expect(1, 0);
    const code = entropy(r, 1, {depth: depth + 1, values: count});
    for (let i = 0; i < count; i++) { const value = code.read(0); requireJPEG(value < 256); map[i] = value; }
    code.finish();
  }
  return map;
}
function entropy(r, contexts, {spatial = false, depth = 0, byteHistory = false, values}) {
  requireJPEG(Number.isSafeInteger(values) && values >= 0);
  let remaining = values;
  const lz = r.read(1), minimum = lz ? r.u32([[0, 224], [0, 512], [0, 4096], [15, 8]]) : 0;
  const minLength = lz ? r.u32([[0, 3], [0, 4], [2, 5], [8, 9]]) : 0, lengthConfig = lz ? config(r, 8) : null;
  const map = contexts + lz > 1 ? contextMap(r, contexts + lz, depth) : new Uint8Array(1);
  if (byteHistory) requireJPEG(map.subarray(0, contexts).every(value => value === map[0]));
  const count = 1 + Math.max(...map), prefix = r.read(1), log = prefix ? 15 : r.read(2) + 5;
  const configs = Array.from({length: count}, () => config(r, log));
  let decoders, aliases;
  if (prefix) {
    const sizes = configs.map(() => r.read(1) ? (n => (1 << n) + r.read(n) + 1)(r.read(4)) : 1);
    decoders = sizes.map(size => readPrefix(r, size));
  } else aliases = configs.map(() => {
    const counts = distribution(r), {starts, reverse} = reverseAlias(counts, log), symbols = new Uint16Array(4096), offsets = new Uint16Array(4096);
    for (let s = 0; s < counts.length; s++) for (let i = 0; i < counts[s]; i++) { const at = reverse[starts[s] + i]; symbols[at] = s; offsets[at] = i; }
    return {counts, symbols, offsets};
  });
  let state = null, left = 0, previous = 0, produced = false, position = 0, distance = 1;
  const history = byteHistory ? new Uint8Array(1048576) : null;
  const remember = value => {
    if (history) { requireJPEG(value < 256); history[position++ & 1048575] = value; }
    return previous = value;
  };
  const token = h => {
    if (prefix) return decoders[h](r);
    state ??= r.read(32);
    const a = aliases[h], at = state & 4095, s = a.symbols[at];
    state = a.counts[s] * Math.floor(state / 4096) + a.offsets[at];
    if (state < 65536) state = state * 65536 + r.read(16);
    return s;
  };
  return {
    read(ctx) {
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
      produced = true; return remember(hybrid(r, t, configs[h]));
    },
    finish() { requireJPEG(!left && (prefix || state === 0x130000)); state = null; produced = false; },
  };
}

export function skipICC(r) {
  const start = r.bit, form = r.read(2);
  let size = form === 1 ? r.read(4) + 1 : form === 2 ? r.read(8) + 17 : form === 3 ? r.read(12) : 0;
  if (form === 3) for (let shift = 12; r.read(1); shift += 8) {
    requireJPEG(shift <= 28); size += r.read(8) * ((1 << shift) >>> 0);
  }
  requireJPEG(size >= 132 && size <= 0xffffffff + 16 && size <= Math.max(65536, (r.bytes.length * 8 - start) * 32));
  const code = entropy(r, 41, {byteHistory: true, values: size});
  for (let i = 0; i < size; i++) {
    if (i && i % 65536 === 0) requireJPEG(i <= (r.bit - start) * 32);
    code.read(0);
  }
  code.finish();
}
function modular(r, shapes) {
  r.expect(4, 2);
  const treeCode = entropy(r, 6, {values: 6 * (2 * shapes.length - 1)}), nodes = [{}], leaves = [];
  for (const node of nodes) {
    requireJPEG(nodes.length <= 2 * shapes.length - 1);
    const property = treeCode.read(0);
    if (property) {
      requireJPEG(property === 1); node.cut = signed(treeCode.read(1)); node.left = {}; node.right = {}; nodes.push(node.left, node.right);
    } else {
      node.predictor = treeCode.read(2); node.offset = signed(treeCode.read(3));
      const shift = treeCode.read(4), mul = treeCode.read(5);
      requireJPEG([0, 5].includes(node.predictor) && !node.offset && !shift && !mul);
      node.ctx = leaves.length; leaves.push(node);
    }
  }
  treeCode.finish();
  const code = entropy(r, leaves.length, {spatial: true, values: shapes.reduce((n, [width, height]) => n + width * height, 0)}), planes = [];
  for (let c = 0; c < shapes.length; c++) {
    const [width, height] = shapes[c], data = new Int32Array(width * height);
    let leaf = nodes[0]; while (leaf.left) leaf = c > leaf.cut ? leaf.left : leaf.right;
    for (let y = 0, i = 0; y < height; y++) for (let x = 0; x < width; x++, i++) {
      let predicted = 0;
      if (leaf.predictor) {
        const l = x ? data[i - 1] : y ? data[i - width] : 0, t = y ? data[i - width] : l, tl = x && y ? data[i - width - 1] : l;
        predicted = Math.max(Math.min(l, t), Math.min(Math.max(l, t), l + t - tl));
      }
      data[i] = predicted + signed(code.read(leaf.ctx));
    }
    planes.push(data);
  }
  code.finish(); return planes;
}

export function readJPEGCoefficients(bytes, {reconstruction = false} = {}) {
  requireJPEG(bytes instanceof Uint8Array && bytes.length > 0);
  const r = new JxlBits(bytes), size = [[9, 1], [13, 1], [18, 1], [30, 1]];
  r.expect(17, 0x0aff); const height = r.u32(size); r.expect(3, 0); const width = r.u32(size);
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
  r.expect(3, 4); if (icc) skipICC(r); r.align(); r.expect(4, 0); r.expect(2, 2); r.expect(8, 111);
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
  const planes = [0, 1, 2].map(c => ({h: 1 << hs[c], v: 1 << vs[c], stride: blocksW >> hshift[c], rows: blocksH >> vshift[c], dc: new Int32Array((blocksW >> hshift[c]) * (blocksH >> vshift[c])), coeffs: new Int16Array((blocksW >> hshift[c]) * (blocksH >> vshift[c]) * 64)}));
  const dc = section(0); dc.expect(1, 0); dc.read(16); dc.read(16); dc.read(16);
  dc.expect(2, 3); dc.expect(16, 57343); dc.expect(2, 1); dc.expect(5, 0); dc.expect(5, 0);
  const thresholds = Array.from({length: dc.read(4)}, () => signed(dc.u32([[4, 0], [8, 16], [16, 272], [32, 65808]])));
  dc.expect(8, 0); const numDc = thresholds.length + 1, map = contextMap(dc, 3 * 13 * numDc), contexts = Math.max(...map) + 1;
  dc.expect(3, 0); dc.expect(32, 0); dc.expect(8, 128); dc.expect(8, 128); dc.expect(1, 0); end(dc);
  for (let g = 0; g < dcs; g++) {
    const reader = section(1 + g), x0 = g % dcX * 256, y0 = Math.floor(g / dcX) * 256, rw = Math.min(256, blocksW - x0), rh = Math.min(256, blocksH - y0);
    reader.expect(2, 0);
    const values = modular(reader, [1, 0, 2].map(c => [rw >> hshift[c], rh >> vshift[c]]));
    for (const [i, c] of [1, 0, 2].entries()) {
      const p = planes[c], w = rw >> hshift[c], h = rh >> vshift[c];
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) p.dc[(y + (y0 >> vshift[c])) * p.stride + x + (x0 >> hshift[c])] = values[i][y * w + x];
    }
    const n = rw * rh; reader.expect(ceilLog2(n), n - 1);
    const cw = (rw + 7) >> 3, ch = (rh + 7) >> 3;
    for (const data of modular(reader, [[cw, ch], [cw, ch], [n, 2], [rw, rh]])) requireJPEG(data.every(v => v === 0));
    end(reader);
  }
  const ac = section(1 + dcs); ac.expect(1, 0); ac.expect(3, 7); ac.read(16);
  const matrices = modular(ac, [[8, 8], [8, 8], [8, 8]]);
  for (let c = 0; c < 3; c++) {
    const p = planes[c]; p.quant = Int32Array.from({length: 64}, (_, k) => matrices[c][(k % 8) * 8 + (k >> 3)]);
    requireJPEG(p.quant.every(q => q > 0 && q < 65536));
  }
  ac.expect(32, 0); ac.expect(16, 0);
  if (groups > 1) ac.expect(ceilLog2(groups), 0);
  const natural = ZIGZAG.map(k => (k % 8) * 8 + (k >> 3)), orders = [natural, natural, natural];
  const orderBits = ac.u32([[0, 95], [0, 19], [0, 0], [13, 0]]);
  requireJPEG(orderBits === 0 || orderBits === 1);
  if (orderBits) {
    const code = entropy(ac, 8, {values: 3 * 64});
    for (let c = 0; c < 3; c++) {
      const length = code.read(0) + 1, available = natural.slice(1), order = [0]; requireJPEG(length <= 64);
      for (let k = 1; k < length; k++) { const index = code.read(0); requireJPEG(index < available.length); order.push(available.splice(index, 1)[0]); }
      orders[c] = order.concat(available);
    }
    code.finish();
  }
  const code = entropy(ac, contexts * 495, {values: planes.reduce((n, plane) => n + plane.coeffs.length, 0)}); end(ac);
  for (let g = 0; g < groups; g++) {
    const reader = section(2 + dcs + g);
    if (groups !== 1) { ac.bytes = reader.bytes; ac.bit = 0; }
    const x0 = g % groupsX * 32, y0 = Math.floor(g / groupsX) * 32, bw = Math.min(32, blocksW - x0), bh = Math.min(32, blocksH - y0);
    const nonzero = [0, 1, 2].map(() => new Uint8Array(1024));
    for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) for (const c of [1, 0, 2]) {
      const sx = x >> hshift[c], sy = y >> vshift[c]; if ((sx << hshift[c]) !== x || (sy << vshift[c]) !== y) continue;
      const p = planes[c], block = ((y0 >> vshift[c]) + sy) * p.stride + (x0 >> hshift[c]) + sx, row = nonzero[c];
      const predicted = sx ? sy ? (row[(sy - 1) * 32 + sx] + row[sy * 32 + sx - 1] + 1) >> 1 : row[sx - 1] : sy ? row[(sy - 1) * 32] : 32;
      const dcValue = planes[1].dc[((y0 + y) >> vshift[1]) * planes[1].stride + ((x0 + x) >> hshift[1])];
      const bucket = thresholds.reduce((n, t) => n + (dcValue > t), 0), ctx = map[(c < 2 ? c ^ 1 : 2) * 13 * numDc + bucket];
      let left = code.read((predicted < 8 ? predicted : 4 + (predicted >> 1)) * contexts + ctx); requireJPEG(left <= 63);
      row[sy * 32 + sx] = left; let previous = left > 4 ? 0 : 1;
      for (let k = 1; k < 64 && left; k++) {
        const value = signed(code.read(contexts * 37 + ctx * 458 + zeroDensityContext(left, k, previous)));
        requireJPEG(value >= -32768 && value <= 32767); p.coeffs[block * 64 + orders[c][k]] = value;
        previous = value ? 1 : 0; left -= previous;
      }
      requireJPEG(left === 0);
    }
    code.finish(); ac.end();
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
  return {width, height, orientation, ycbcr, components: grey ? [planes[1]] : ycbcr ? [planes[1], planes[0], planes[2]] : planes};
}
