// Optional WebAssembly kernels. MIT (images/jxl/LICENSE).
import {kernelHooks} from './kernel-hooks.mjs';
import {WEIGHTED_BUCKET} from './weighted-policy.mjs';
import {BitWriter} from './bits.mjs';
import {hybridToken} from './prefix.mjs';
import {fault} from './admit.mjs';
import {SCALAR, SIMD, SIMD_PROBE} from './kernels-bytes.mjs';

export const {configureKernels, ensureKernels, kernelMode} = (() => {
const P = 65536, R = 327680, PROPERTY = 589824, CONTEXT = 851968;
const OUTPUT = 1114128, TABLE = 1642496, SOURCE = 1769472, STATE = 2097152;
const DIV = 16, WEIGHTS = 272, BUCKET = 16656, MAP = 20672, ALPHABET = 257;
let engine, active = 'off', explicit = false;
const decode = text => Uint8Array.from(atob(text), c => c.charCodeAt(0));
const acceptablePlane = (p, w, h, offset, limit = 65536) => p instanceof Int16Array && Number.isInteger(w) && Number.isInteger(h) && w > 0 && h > 0 && w <= 16384 && w * h <= limit && p.length >= w * h && Number.isInteger(offset) && Math.abs(offset) <= 32768;
const acceptableWriter = w => !w || (w instanceof BitWriter && w.write === BitWriter.prototype.write && w.grow === BitWriter.prototype.grow);
const PLAIN = {split: 0, msb: 0, lsb: 0};
const acceptableConfig = c => Number.isInteger(c.split) && Number.isInteger(c.msb) && Number.isInteger(c.lsb) && c.split >= 0 && c.split <= 15 && c.msb >= 0 && c.lsb >= 0 && c.msb + c.lsb <= c.split && (1 << c.split) + ((19 - c.split) << (c.msb + c.lsb)) <= 224;
const RAW_BINS = 4096 + 33;
const GROUP_PLANES = [P, PROPERTY, CONTEXT, STATE];

function createEngine() {
  const memory = new WebAssembly.Memory({initial: 48, maximum: 272});
  const names = new Map(Object.entries(new WebAssembly.Instance(new WebAssembly.Module(decode(SCALAR)), {env: {memory}}).exports));
  const scalar = {residual: names.get('residual'), tokens: names.get('tokens'), fill: names.get('fill'), weighted: names.get('weighted'), screen: names.get('screen'), sampled: names.get('sampled')};
  const u8 = new Uint8Array(memory.buffer), i32 = new Int32Array(memory.buffer);
  for (let i = 0; i < 64; i++) i32[(DIV >> 2) + i] = Math.floor(16777216 / (i + 1));
  for (let most = 12; most <= 13; most++) for (let sum = 0; sum < 2048; sum++) {
    const shift = Math.max(0, 26 - Math.clz32(sum + 1));
    i32[(WEIGHTS >> 2) + (most - 12) * 2048 + sum] = 4 + ((most * i32[(DIV >> 2) + (sum >> shift)]) >> shift);
  }
  i32.set(WEIGHTED_BUCKET, BUCKET >> 2);
  return {memory, scalar, simd: null, u8, i32};
}

function tokens(w, targets, count, contexts, config = PLAIN, rawLength = 0) {
  tileTables = null; acClean = false; ansStamp = null; tileBand = null;
  const {scalar, i32, u8} = engine, stride = rawLength || ALPHABET;
  if (!acceptableWriter(w) || !targets.length || targets.length > 34) return false;
  if (w) {
    i32.fill(0, TABLE >> 2, (TABLE >> 2) + targets.length * ALPHABET * 2);
    for (let c = 0; c < targets.length; c++) {
      const code = targets[c];
      if (!code?.lengths || !code?.codes || code.lengths.length > ALPHABET) return false;
      for (let s = 0; s < code.lengths.length; s++) {
        i32[(TABLE >> 2) + (c * ALPHABET + s) * 2] = code.lengths[s];
        i32[(TABLE >> 2) + (c * ALPHABET + s) * 2 + 1] = code.codes[s];
      }
    }
  } else {
    for (let c = 0; c < targets.length; c++) {
      if (!(targets[c] instanceof Uint32Array) || targets[c].length !== stride) return false;
      i32.set(targets[c], (TABLE >> 2) + c * stride);
    }
  }
  const written = scalar.tokens(R, contexts, count, TABLE, OUTPUT, w ? 1 : 0, w ? w.acc : 0, w ? w.pending : 0, config.split, config.msb, config.lsb, rawLength);
  if (w) {
    if (w.at + written + 8 >= w.bytes.length) w.grow(written + 8);
    w.bytes.set(u8.subarray(OUTPUT, OUTPUT + written), w.at);
    w.at += written; w.acc = i32[(OUTPUT - 8) >> 2]; w.pending = i32[(OUTPUT - 4) >> 2];
  } else for (let c = 0; c < targets.length; c++) targets[c].set(i32.subarray((TABLE >> 2) + c * stride, (TABLE >> 2) + (c + 1) * stride));
  return true;
}
function channel(w, target, plane, width, height, leaf, raw) {
  tileTables = null; acClean = false; ansStamp = null; tileBand = null;
  const config = leaf.config || PLAIN;
  if (!acceptablePlane(plane, width, height, leaf.offset) || leaf.multiplier !== 1 || !Number.isInteger(leaf.predictor) || leaf.predictor < 0 || leaf.predictor > 5 || !acceptableWriter(w) || !acceptableConfig(config)) return false;
  if (raw && (w || !(target instanceof Uint32Array) || target.length < 34 || target.length > RAW_BINS)) return false;
  const n = width * height;
  if (w && w.at + n * 8 + 32 > 0x7fffffff) return false;
  engine.i32.set(plane.subarray(0, n), P >> 2);
  (active === 'simd' ? engine.simd : engine.scalar).residual(P, width, height, leaf.predictor, leaf.offset, R);
  return tokens(w, [target], n, 0, config, raw ? target.length : 0);
}
function weighted(w, targets, plane, width, height, offset, contextOf, residuals, properties) {
  tileTables = null; acClean = false; ansStamp = null; tileBand = null;
  if (!acceptablePlane(plane, width, height, offset, residuals ? 1048576 : 65536) || !acceptableWriter(w)) return false;
  const n = width * height;
  if (w && w.at + n * 8 + 32 > 0x7fffffff) return false;
  if (residuals && (!(residuals instanceof Uint32Array) || residuals.length < n)) return false;
  if (properties && (!(properties instanceof Int32Array) || properties.length < n)) return false;
  if (contextOf.length !== 34 || contextOf.some(c => !Number.isInteger(c) || c < 0 || c >= 34)) return false;
  if (!residuals && contextOf.some(c => c >= targets.length)) return false;
  const large = n > 65536, residual = large ? P + n * 4 : R, property = large ? P + n * 8 : PROPERTY;
  const context = large ? P + n * 12 : CONTEXT, state = large ? P + n * 16 : STATE;
  const needed = state + (width + 2) * 40;
  if (needed > engine.memory.buffer.byteLength) {
    try { engine.memory.grow(Math.ceil((needed - engine.memory.buffer.byteLength) / 65536)); }
    catch { return false; }
    engine.u8 = new Uint8Array(engine.memory.buffer);
    engine.i32 = new Int32Array(engine.memory.buffer);
  }
  const {i32, scalar} = engine;
  i32.set(plane.subarray(0, n), P >> 2); i32.set(contextOf, MAP >> 2);
  i32.fill(0, state >> 2, (state >> 2) + (width + 2) * 10);
  scalar.weighted(P, width, height, offset, residual, property, context, MAP, BUCKET, DIV, WEIGHTS, state);
  if (residuals) {
    residuals.set(i32.subarray(residual >> 2, (residual >> 2) + n));
    if (properties) properties.set(i32.subarray(property >> 2, (property >> 2) + n));
    return true;
  }
  if (properties) properties.set(i32.subarray(PROPERTY >> 2, (PROPERTY >> 2) + n));
  return tokens(w, targets, n, CONTEXT);
}
function fill(rgba, imageWidth, x0, y0, w, h, channels, planes) {
  tileTables = null; acClean = false; ansStamp = null; tileBand = null;
  const n = w * h;
  if (n < 1 || n > 65536 || channels < 1 || channels > 4) return false;
  const {u8, i32} = engine;
  for (let y = 0; y < h; y++) {
    const at = ((y0 + y) * imageWidth + x0) * 4;
    u8.set(rgba.subarray(at, at + w * 4), SOURCE + y * w * 4);
  }
  (active === 'simd' ? engine.simd : engine.scalar).fill(SOURCE, n, channels, P, R, PROPERTY, CONTEXT);
  for (let c = 0; c < channels; c++) {
    const at = [P, R, PROPERTY, CONTEXT][c] >> 2;
    planes[c].set(i32.subarray(at, at + n));
  }
  return true;
}

function dct(blocks, count, basis) {
  tileTables = null; acClean = false; ansStamp = null; tileBand = null;
  if (active !== 'simd' || !(blocks instanceof Float64Array) || !Number.isInteger(count) || count < 1 || count > 64 ||
      blocks.length < count * 192 || !(basis instanceof Float64Array) || basis.length !== 64) return false;
  const f64 = new Float64Array(engine.memory.buffer), pair = R + 512;
  f64.set(blocks.subarray(0, count * 192), P >> 3);
  f64.set(basis, R >> 3);
  for (let u = 0; u < 8; u += 2) for (let x = 0; x < 8; x++) {
    f64[(pair >> 3) + u * 8 + x * 2] = basis[u * 8 + x];
    f64[(pair >> 3) + u * 8 + x * 2 + 1] = basis[(u + 1) * 8 + x];
  }
  engine.simd.dct(P, count, R, pair, P + 64 * 192 * 8);
  blocks.set(f64.subarray(P >> 3, (P >> 3) + count * 192));
  return true;
}

const TILE_F64 = P + 16384, TILE_ROOTS = P + 114688, TILE_LINEAR = P + 147600, TILE_SCALE = P + 149648;
let tileTables = null, tileBand = null;
const TILE_BAND = 12582912;
const TILE_SUMS = P + 150160, TILE_STEPS = P + 150184, TILE_LIMITS = P + 151720, TILE_OUT = P + 153256, TILE_COUNTS = P + 177832;
function photoTile(data, width, height, bx0, by0, bw, bh, tables, cfl, components, stride, nonZero) {
  if (active !== 'simd' || !(data instanceof Uint8Array || data instanceof Uint8ClampedArray) || !Number.isInteger(bw) || !Number.isInteger(bh) ||
      bw < 1 || bw > 8 || bh < 1 || bh > 8 || tables.roots.length !== 4113 || tables.linear.length !== 256) return false;
  const padded = stride * 32, end = TILE_BAND + 64 * padded;
  if (end > engine.memory.buffer.byteLength) {
    try { engine.memory.grow(Math.ceil((end - engine.memory.buffer.byteLength) / 65536)); } catch { return false; }
    engine.u8 = new Uint8Array(engine.memory.buffer); engine.i32 = new Int32Array(engine.memory.buffer);
  }
  if (tileBand?.tables !== tables || tileBand.by0 !== by0) {
    acClean = false; ansStamp = null;
    const u8 = new Uint8Array(engine.memory.buffer);
    for (let y = 0; y < bh * 8; y++) {
      const at = Math.min(height - 1, by0 * 8 + y) * width * 4, row = TILE_BAND + y * padded;
      u8.set(data.subarray(at, at + width * 4), row);
      for (let x = width; x < stride * 8; x++) u8.copyWithin(row + x * 4, row + (width - 1) * 4, row + width * 4);
    }
    tileBand = {tables, by0};
  }
  const src = TILE_BAND + bx0 * 32, rowBytes = padded;
  const u8 = new Uint8Array(engine.memory.buffer), f64 = new Float64Array(engine.memory.buffer), count = bw * bh;
  if (tileTables !== tables) {
    f64.set(tables.roots, TILE_ROOTS >> 3); f64.set(tables.linear, TILE_LINEAR >> 3); f64.set(tables.scale, TILE_SCALE >> 3);
    for (let c = 0; c < 3; c++) { f64.set(tables.steps[c], (TILE_STEPS >> 3) + c * 64); f64.set(tables.limits[c], (TILE_LIMITS >> 3) + c * 64); }
    tileTables = tables;
  }
  engine.simd.xybTile(src, rowBytes, bw, bh, TILE_F64, TILE_ROOTS, TILE_LINEAR, TILE_SCALE, tables.bias, tables.rootBias, TILE_SUMS);
  const [fx, fb] = cfl(f64[(TILE_SUMS >> 3) + 1], f64[TILE_SUMS >> 3], f64[(TILE_SUMS >> 3) + 2]);
  engine.simd.quantTile(TILE_F64, count, TILE_STEPS, TILE_LIMITS, fx / 84, fb / 84, TILE_OUT, TILE_COUNTS);
  const levels = new Int16Array(engine.memory.buffer, TILE_OUT, 3 * count * 64);
  for (let c = 0; c < 3; c++) {
    const out = components[c].coeffs, counts = nonZero[c];
    for (let y = 0; y < bh; y++) {
      const from = c * count + y * bw, block = (by0 + y) * stride + bx0;
      out.set(levels.subarray(from * 64, (from + bw) * 64), block * 64);
      counts.set(u8.subarray(TILE_COUNTS + from, TILE_COUNTS + from + bw), block);
    }
  }
  return true;
}

const AC = 4194304, AC_COEFFS = AC + 128, AC_STRIDE = 131072, AC_COUNTS = AC_COEFFS + 3 * AC_STRIDE, AC_BUCKETS = AC_COUNTS + 3072;
const AC_BLOCK_CTX = AC_BUCKETS + 1024, AC_ORDERS = AC_BLOCK_CTX + 1024, AC_ZD = AC_ORDERS + 256, AC_NZ = AC_ZD + 8192;
const AC_MAP = AC_NZ + 12288, AC_CONFIGS = AC_MAP + 8192, AC_CODES = AC_CONFIGS + 4096;
let acClean = false, ansStamp = null;
const ansTables = new WeakMap();
function ansTablesOf(model) {
  let t = ansTables.get(model);
  if (t) return t;
  const {histograms} = model, ids = histograms.length, slots = [0, 0, 0];
  const alphabet = Math.max(...histograms.map(h => Math.max(h.counts.length, h.starts.length)));
  t = {ids, alphabet, small: new Int32Array(ids * 64), freqs: new Int32Array(ids * 64), starts: new Int32Array(ids * 64),
    reverse: new Uint16Array(ids * 4096), configs: new Int32Array(ids * 4), counts: new Int32Array(ids * alphabet), symbolStarts: new Int32Array(ids * alphabet)};
  histograms.forEach((h, id) => {
    for (let v = 0; v < 64; v++) {
      hybridToken(h.config, v, slots);
      t.small[id * 64 + v] = slots[1] << 6 | slots[2]; t.freqs[id * 64 + v] = h.counts[slots[0]]; t.starts[id * 64 + v] = h.starts[slots[0]];
    }
    t.reverse.set(h.reverse, id * 4096);
    t.configs.set([h.config.splitToken, h.config.split, h.config.msb, h.config.lsb], id * 4);
    for (let s = 0; s < h.counts.length; s++) t.counts[id * alphabet + s] = h.counts[s];
    for (let s = 0; s < h.starts.length; s++) t.symbolStarts[id * alphabet + s] = h.starts[s];
  });
  ansTables.set(model, t);
  return t;
}
function acGroup(state, g, pass, sink, zd) {
  const {authoredOrderPasses, groupsX, strategyData, progression, contexts, lumaBuckets, lumaW, xsizeBlocks, ysizeBlocks, comps, grey,
    orders, counted, blockCounts, nonZero, hshifts, vshifts} = state;
  if (active !== 'simd' || strategyData || progression || authoredOrderPasses?.[pass] || grey || !nonZero ||
      hshifts.some(Boolean) || vshifts.some(Boolean) || comps.some(comp => !(comp.coeffs instanceof Int16Array)) ||
      contexts.contexts > 65536 || contexts.map.length > 8192) return false;
  tileBand = null;
  let codes = null, alphabet = 0, w = null, ans = null;
  if (!sink.counts) {
    const model = sink.coding.model;
    if (!model || model.histograms.length > 256 || model.contextMap.length > 8192 || !acceptableWriter(sink.w)) return false;
    if (model.kind === 'ans') {
      if (!sink.coding.flush || model.histograms.some(h => !(h.reverse instanceof Uint16Array) || h.reverse.length !== 4096)) return false;
      ans = ansTablesOf(model);
    } else if (model.kind === 'prefix') { codes = model.histograms; alphabet = Math.max(...codes.map(h => h.code.lengths.length)); }
    else return false;
    w = sink.w;
  }
  const gx = g % groupsX, gy = (g / groupsX) | 0, bx0 = gx * 32, by0 = gy * 32;
  const bw = Math.min(32, xsizeBlocks - bx0), bh = Math.min(32, ysizeBlocks - by0), blocks = bw * bh, stride = comps[0].stride;
  const source = counted ? blockCounts : nonZero;
  const tokens = 3 * blocks * 64;
  const histBytes = contexts.contexts * 256, HIST = AC_CODES + Math.max(8, codes ? codes.length * alphabet * 8 : 8);
  let TOUCHED = HIST + histBytes, OVERFLOW = TOUCHED + tokens * 4, OUT = OVERFLOW + tokens * 8, end = OUT + tokens * 8 + 16;
  let A_SMALL, A_FREQS, A_STARTS, A_REVERSE, A_CONFIGS, A_COUNTS, A_SYMBOL_STARTS, A_VALUES, A_IDS, A_RAWS, A_META, A_EMITTED;
  if (ans) {
    A_SMALL = AC_CODES; A_FREQS = A_SMALL + ans.ids * 256; A_STARTS = A_FREQS + ans.ids * 256; A_REVERSE = A_STARTS + ans.ids * 256;
    A_CONFIGS = A_REVERSE + ans.ids * 8192; A_COUNTS = A_CONFIGS + ans.ids * 16; A_SYMBOL_STARTS = A_COUNTS + ans.ids * ans.alphabet * 4;
    A_VALUES = A_SYMBOL_STARTS + ans.ids * ans.alphabet * 4; A_IDS = A_VALUES + tokens * 4; A_RAWS = A_IDS + tokens + 8 & ~7;
    A_META = A_RAWS + tokens * 4; A_EMITTED = A_META + tokens + 8 & ~7; OUT = A_EMITTED + tokens * 2 + 8 & ~7; end = OUT + tokens * 8 + 16;
  }
  if (end > engine.memory.buffer.byteLength) {
    try { engine.memory.grow(Math.ceil((end - engine.memory.buffer.byteLength) / 65536)); } catch { return false; }
    engine.u8 = new Uint8Array(engine.memory.buffer); engine.i32 = new Int32Array(engine.memory.buffer);
  }
  const buffer = engine.memory.buffer, u8 = new Uint8Array(buffer), i32 = new Int32Array(buffer), i16 = new Int16Array(buffer), u16 = new Uint16Array(buffer);
  if (!sink.counts) acClean = false;
  else if (!acClean) { u8.fill(0, HIST, HIST + histBytes); acClean = true; }
  if (!ans) ansStamp = null;
  else if (ansStamp !== sink.coding.model) {
    i32.set(ans.small, A_SMALL >> 2); i32.set(ans.freqs, A_FREQS >> 2); i32.set(ans.starts, A_STARTS >> 2); u16.set(ans.reverse, A_REVERSE >> 1);
    i32.set(ans.configs, A_CONFIGS >> 2); i32.set(ans.counts, A_COUNTS >> 2); i32.set(ans.symbolStarts, A_SYMBOL_STARTS >> 2);
    ansStamp = sink.coding.model;
  }
  for (let c = 0; c < 3; c++) {
    const coeffs = comps[c].coeffs, counts = source[c];
    for (let y = 0; y < bh; y++) {
      const at = (by0 + y) * stride + bx0;
      i16.set(coeffs.subarray(at * 64, (at + bw) * 64), (AC_COEFFS + c * AC_STRIDE + y * bw * 128) >> 1);
      u8.set(counts.subarray(at, at + bw), AC_COUNTS + c * blocks + y * bw);
      if (!counted) blockCounts[c].set(nonZero[c].subarray(at, at + bw), at);
    }
    for (let k = 0; k < 64; k++) u8[AC_ORDERS + c * 64 + k] = orders[c][k];
    for (let b = 0; b < contexts.numDc; b++) i32[(AC_BLOCK_CTX >> 2) + c * contexts.numDc + b] = contexts.contextOf(c, b);
  }
  for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++)
    u8[AC_BUCKETS + y * bw + x] = contexts.thresholds.length ? lumaBuckets[(by0 + y) * lumaW + bx0 + x] : 0;
  u16.set(zd, AC_ZD >> 1);
  if (ans) u8.set(sink.coding.model.contextMap, AC_MAP);
  if (codes) {
    const {contextMap} = sink.coding.model;
    u8.set(contextMap, AC_MAP);
    i32.fill(0, AC_CODES >> 2, (AC_CODES >> 2) + codes.length * alphabet * 2);
    for (let h = 0; h < codes.length; h++) {
      const {config, code} = codes[h];
      i32.set([config.splitToken, config.split, config.msb, config.lsb], (AC_CONFIGS >> 2) + h * 4);
      for (let s = 0; s < code.lengths.length; s++) { i32[(AC_CODES >> 2) + (h * alphabet + s) * 2] = code.lengths[s]; i32[(AC_CODES >> 2) + (h * alphabet + s) * 2 + 1] = code.codes[s]; }
    }
  }
  i32.set([AC_COEFFS, AC_STRIDE, bw, bh, AC_COUNTS, AC_BUCKETS, AC_BLOCK_CTX, contexts.numDc, contexts.numCtxs, AC_ORDERS, AC_ZD, AC_NZ,
    ans ? 2 : codes ? 1 : 0, HIST, TOUCHED, OVERFLOW, 0, 0, AC_MAP, AC_CONFIGS, AC_CODES, alphabet, OUT, w ? w.acc : 0, w ? w.pending : 0, 0,
    ans ? A_VALUES : 0, ans ? A_IDS : 0, 0], AC >> 2);
  engine.simd.acGroup(AC);
  if (ans) {
    const args = AC_CONFIGS + 4096 - 128;
    i32.set([A_VALUES, A_IDS, i32[(AC >> 2) + 28], A_SMALL, A_FREQS, A_STARTS, A_REVERSE, A_CONFIGS, A_COUNTS, A_SYMBOL_STARTS, ans.alphabet,
      A_RAWS, A_META, A_EMITTED, OUT, w.acc, w.pending, 0], args >> 2);
    engine.simd.ansFlush(args);
    const written = i32[(args >> 2) + 17];
    if (w.at + written + 8 >= w.bytes.length) w.grow(written + 8);
    w.bytes.set(u8.subarray(OUT, OUT + written), w.at);
    w.at += written; w.acc = i32[(args >> 2) + 15]; w.pending = i32[(args >> 2) + 16];
    return 2;
  }
  if (codes) {
    const written = i32[(AC >> 2) + 25];
    if (w.at + written + 8 >= w.bytes.length) w.grow(written + 8);
    w.bytes.set(u8.subarray(OUT, OUT + written), w.at);
    w.at += written; w.acc = i32[(AC >> 2) + 23]; w.pending = i32[(AC >> 2) + 24];
    return true;
  }
  const counts = sink.counts, touched = i32[(AC >> 2) + 16], overflow = i32[(AC >> 2) + 17], hist = new Uint32Array(buffer, HIST, histBytes >> 2);
  for (let i = 0; i < touched; i++) {
    const index = i32[(TOUCHED >> 2) + i], n = hist[index];
    counts.small[index] += n; counts.totals[index >> 6] += n; hist[index] = 0;
  }
  for (let i = 0; i < overflow; i++) counts.add(i32[(OVERFLOW >> 2) + 2 * i], i32[(OVERFLOW >> 2) + 2 * i + 1]);
  return true;
}

function nonzero(coeffs, from, end, natural) {
  if (active !== 'simd' || !(coeffs instanceof Int16Array) || from % 64 || (end - from) % 64) return false;
  tileTables = null; acClean = false; ansStamp = null; tileBand = null;
  const i16 = new Int16Array(engine.memory.buffer), i32 = new Int32Array(engine.memory.buffer), out = R + 131072;
  i32.fill(0, out >> 2, (out >> 2) + 64);
  for (let at = from; at < end; at += 65536) {
    const stop = Math.min(end, at + 65536);
    i16.set(coeffs.subarray(at, stop), P >> 1);
    engine.simd.nonzeroCounts(P, (stop - at) >> 6, out);
  }
  for (let i = 0; i < 64; i++) natural[i] += i32[(out >> 2) + i];
  return true;
}

function group(w, targets, rgba, imageWidth, x0, y0, width, height, setup) {
  tileTables = null; acClean = false; ansStamp = null; tileBand = null;
  const {channels, leaves, picture} = setup, n = width * height;
  if (setup.palette || setup.samples || setup.rct !== undefined ||
      !(rgba instanceof Uint8Array || rgba instanceof Uint8ClampedArray) ||
      !Number.isInteger(channels) || channels < 1 || channels > 4 ||
      leaves.length !== channels || picture.length !== channels || targets.length !== channels ||
      !Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 256 || height > 256 ||
      !Number.isSafeInteger(imageWidth) || !Number.isSafeInteger(x0) || !Number.isSafeInteger(y0) || x0 < 0 || y0 < 0 ||
      imageWidth < x0 + width || ((y0 + height - 1) * imageWidth + x0 + width) * 4 > rgba.length ||
      !acceptableWriter(w) || w && w.at + n * channels * 8 + 32 > 0x7fffffff) return false;
  for (let c = 0; c < channels; c++) {
    const l = leaves[c], target = targets[c];
    if (picture[c] !== c || l.multiplier !== 1 || !Number.isInteger(l.predictor) || l.predictor < 0 || l.predictor > 5 ||
        !Number.isInteger(l.offset) || Math.abs(l.offset) > 32768 || !acceptableConfig(l.config || PLAIN)) return false;
    if (w) {
      if (!(target?.lengths instanceof Uint8Array) || !(target?.codes instanceof Uint16Array) ||
          target.lengths.length > ALPHABET || target.codes.length !== target.lengths.length) return false;
      for (let s = 0; s < target.lengths.length; s++) if (target.lengths[s] > 15 || target.codes[s] >= 1 << target.lengths[s]) return false;
    } else {
      if (!(target instanceof Uint32Array) || target.length < 34 || target.length > RAW_BINS) return false;
      for (let k = 0; k < c; k++) if (target.buffer === targets[k].buffer &&
          target.byteOffset < targets[k].byteOffset + targets[k].byteLength && targets[k].byteOffset < target.byteOffset + target.byteLength) return false;
    }
  }
  const {u8, i32, scalar} = engine, backend = active === 'simd' ? engine.simd : scalar;
  for (let y = 0; y < height; y++) {
    const at = ((y0 + y) * imageWidth + x0) * 4;
    u8.set(rgba.subarray(at, at + width * 4), SOURCE + y * width * 4);
  }
  backend.fill(SOURCE, n, channels, ...GROUP_PLANES);
  if (!w) {
    for (let c = 0; c < channels; c++) i32.set(targets[c], (TABLE >> 2) + c * RAW_BINS);
    for (let c = 0; c < channels; c++) {
      const l = leaves[c], config = l.config || PLAIN;
      backend.residual(GROUP_PLANES[c], width, height, l.predictor, l.offset, R);
      scalar.tokens(R, 0, n, TABLE + c * RAW_BINS * 4, OUTPUT, 0, 0, 0, config.split, config.msb, config.lsb, targets[c].length);
    }
    for (let c = 0; c < channels; c++) {
      const at = (TABLE >> 2) + c * RAW_BINS;
      targets[c].set(i32.subarray(at, at + targets[c].length));
    }
  } else {
    const at = w.at, acc = w.acc, pending = w.pending, bytes = w.bytes;
    try {
      for (let c = 0; c < channels; c++) {
        const l = leaves[c];
        backend.residual(GROUP_PLANES[c], width, height, l.predictor, l.offset, R);
        tokens(w, [targets[c]], n, 0, l.config || PLAIN);
      }
    } catch (error) {
      w.at = at; w.acc = acc; w.pending = pending; w.bytes = bytes;
      throw error;
    }
  }
  return true;
}

function screen(plane, width, height, predictor, depth, emit, minLength = 7) {
  tileTables = null; acClean = false; ansStamp = null; tileBand = null;
  const n = width * height;
  if (!(plane instanceof Int16Array) || !Number.isInteger(width) || !Number.isInteger(height) ||
      width < 1 || height < 1 || width > 16384 || height > 16384 || n > 1048576 || plane.length < n ||
      ![0, 1, 2, 3, 5].includes(predictor) || ![4, 7].includes(minLength) || !Number.isInteger(depth) || depth < 0 || depth > 2147483647) return false;
  const residual = P + n * 4, output = P + n * 8, head = P + n * 16, rows = head + 262144,
    map = rows + height * 4, capacity = 1 << (32 - Math.clz32(height * 2 - 1)), needed = map + capacity * 8;
  if (needed > engine.memory.buffer.byteLength) {
    try { engine.memory.grow(Math.ceil((needed - engine.memory.buffer.byteLength) / 65536)); }
    catch { return false; }
    engine.u8 = new Uint8Array(engine.memory.buffer);
    engine.i32 = new Int32Array(engine.memory.buffer);
  }
  const {i32} = engine, backend = active === 'simd' ? engine.simd : engine.scalar;
  i32.set(plane.subarray(0, n), P >> 2);
  backend.residual(P, width, height, predictor, 0, residual);
  i32.fill(-1, head >> 2, (head + 262144) >> 2);
  i32.fill(-1, map >> 2, (map + capacity * 8) >> 2);
  const count = backend.screen(residual, n, width, depth, head, P, rows, map, capacity - 1, output, minLength);
  for (let i = output >> 2, end = i + count * 2; i < end; i += 2) {
    const value = i32[i] >>> 0, distance = i32[i + 1];
    if (distance) emit(0, value, distance);
    else emit(value, 0, 0);
  }
  return true;
}

function sampled(members, histograms, symbolSets, columns, table, rawPrice, choiceBits) {
  tileTables = null; acClean = false; ansStamp = null; tileBand = null;
  const total = members.length, kinds = symbolSets.length, alphabet = rawPrice.length;
  if (!(members instanceof Uint32Array) || total < 64 || total > 65536 || !kinds || kinds > 16 ||
      !alphabet || alphabet > 256 || !(table instanceof Float64Array) || table.length < total + 1 ||
      !(rawPrice instanceof Float64Array) || histograms.length !== kinds || !Number.isSafeInteger(choiceBits)) return false;
  const count = symbolSets[0].length;
  if (count > 1 << 20 || count < total || symbolSets.some(s => !(s instanceof Uint8Array) || s.length !== count) ||
      histograms.some(h => !(h instanceof Uint32Array) || h.length !== alphabet)) return false;
  let maxCuts = 0;
  for (const column of columns) {
    if (!(column.indices instanceof Uint8Array) || column.indices.length !== count || column.cuts.length > 255) return false;
    maxCuts = Math.max(maxCuts, column.cuts.length);
  }
  if (!maxCuts) return null;
  const align = n => Math.ceil(n / 8) * 8;
  const symbols = P, indices = symbols + total * kinds, histogram = align(indices + total);
  const entropy = align(histogram + kinds * alphabet * 4), raw = entropy + (total + 1) * 8;
  const output = raw + alphabet * 8, scratch = output + 24, bins = maxCuts + 1;
  const needed = scratch + kinds * 32 + kinds * alphabet * 8 + bins * kinds * alphabet * 4 + total * 4 + (2 * bins + 1) * 4;
  if (needed > engine.memory.buffer.byteLength) {
    try { engine.memory.grow(Math.ceil((needed - engine.memory.buffer.byteLength) / 65536)); }
    catch { return false; }
    engine.u8 = new Uint8Array(engine.memory.buffer);
    engine.i32 = new Int32Array(engine.memory.buffer);
  }
  const {u8, i32} = engine, f64 = new Float64Array(engine.memory.buffer);
  for (let i = 0; i < total; i++) if (members[i] >= count) return false;
  for (let c = 0; c < kinds; c++) {
    const source = symbolSets[c], at = symbols + c * total;
    for (let i = 0; i < total; i++) { const symbol = source[members[i]]; if (symbol >= alphabet) return false; u8[at + i] = symbol; }
    i32.set(histograms[c], (histogram >> 2) + c * alphabet);
  }
  f64.set(table.subarray(0, total + 1), entropy >> 3); f64.set(rawPrice, raw >> 3);
  const backend = active === 'simd' ? engine.simd : engine.scalar;
  let best = null;
  for (const column of columns) {
    const cuts = column.cuts.length;
    if (!cuts) continue;
    const source = column.indices;
    for (let i = 0; i < total; i++) { const bin = source[members[i]]; if (bin > cuts) return false; u8[indices + i] = bin; }
    const bin = backend.sampled(symbols, total, kinds, indices, cuts, alphabet, histogram, entropy, raw, scratch, output);
    if (bin < 0) continue;
    const loBits = f64[(output + 8) >> 3], hiBits = f64[(output + 16) >> 3], gain = choiceBits - loBits - hiBits;
    if (!best || gain > best.gain) best = {gain, column, bin,
      lo: {selected: i32[output >> 2], bits: loBits}, hi: {selected: i32[(output + 4) >> 2], bits: hiBits}};
  }
  return best;
}

function configureKernels(mode = 'auto', parts) {
  if (!['off', 'auto', 'scalar', 'simd'].includes(mode)) throw fault('JXL_INPUT', 'Kernel mode is off, auto, scalar or simd.');
  explicit = true; tileTables = null; acClean = false; ansStamp = null; tileBand = null;
  kernelHooks.channel = kernelHooks.weighted = kernelHooks.fill = kernelHooks.group = kernelHooks.screen = kernelHooks.sampled = kernelHooks.dct = kernelHooks.photoTile = kernelHooks.acGroup = kernelHooks.nonzero = null; active = 'off';
  if (mode === 'off') return active;
  try {
    if (typeof WebAssembly !== 'object' || !WebAssembly.validate || new Uint8Array(new Uint32Array([1]).buffer)[0] !== 1) return active;
    const simd = mode !== 'scalar' && SIMD && WebAssembly.validate(decode(SIMD_PROBE));
    if (mode !== 'scalar' && !simd) return active;
    engine ||= createEngine();
    if (simd && !engine.simd) {
      const names = new Map(Object.entries(new WebAssembly.Instance(new WebAssembly.Module(decode(SIMD)), {env: {memory: engine.memory}}).exports));
      engine.simd = {residual: names.get('residual'), fill: names.get('fill'), screen: names.get('screen'), sampled: names.get('sampled'), dct: names.get('dct'), xybTile: names.get('xybTile'), quantTile: names.get('quantTile'), acGroup: names.get('acGroup'), ansFlush: names.get('ansFlush'), nonzeroCounts: names.get('nonzeroCounts')};
    }
    active = simd ? 'simd' : 'scalar';
    const enabled = parts ? new Map(Object.entries(parts)) : null;
    if (!enabled || enabled.get('channel')) kernelHooks.channel = channel;
    if (!enabled || enabled.get('weighted')) kernelHooks.weighted = weighted;
    if (!enabled || enabled.get('fill')) kernelHooks.fill = fill;
    if (kernelHooks.fill && kernelHooks.channel) kernelHooks.group = group;
    if (!enabled || enabled.get('screen')) kernelHooks.screen = screen;
    if (!enabled || enabled.get('sampled')) kernelHooks.sampled = sampled;
    if (simd && (!enabled || enabled.get('dct'))) kernelHooks.dct = dct;
    if (simd && (!enabled || enabled.get('photoTile'))) kernelHooks.photoTile = photoTile;
    if (simd && (!enabled || enabled.get('acGroup'))) kernelHooks.acGroup = acGroup;
    if (simd && (!enabled || enabled.get('nonzero'))) kernelHooks.nonzero = nonzero;
  } catch { active = 'off'; kernelHooks.channel = kernelHooks.weighted = kernelHooks.fill = kernelHooks.group = kernelHooks.screen = kernelHooks.sampled = kernelHooks.dct = kernelHooks.photoTile = kernelHooks.acGroup = kernelHooks.nonzero = null; }
  return active;
}
function ensureKernels() {
  if (!explicit) configureKernels('auto');
  return active;
}
function kernelMode() { return active; }
return {configureKernels, ensureKernels, kernelMode};
})();
