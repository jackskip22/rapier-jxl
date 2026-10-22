// Optional WebAssembly kernels. MIT (LICENSE).
import {kernelHooks} from './kernel-hooks.mjs';
import {WEIGHTED_BUCKET} from './weighted-policy.mjs';
import {BitWriter} from './bits.mjs';
import {fault} from './admit.mjs';
import {SCALAR, SIMD, SIMD_PROBE} from './kernels-bytes.mjs';

export const {configureKernels, kernelMode} = (() => {
const P = 65536, R = 327680, PROPERTY = 589824, CONTEXT = 851968;
const OUTPUT = 1114128, TABLE = 1642496, SOURCE = 1769472, STATE = 2097152;
const DIV = 16, WEIGHTS = 272, BUCKET = 16656, MAP = 20672, ALPHABET = 257;
let engine, active = 'off';
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

function group(w, targets, rgba, imageWidth, x0, y0, width, height, setup) {
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
  kernelHooks.channel = kernelHooks.weighted = kernelHooks.fill = kernelHooks.group = kernelHooks.screen = kernelHooks.sampled = kernelHooks.dct = null; active = 'off';
  if (mode === 'off') return active;
  try {
    if (typeof WebAssembly !== 'object' || !WebAssembly.validate || new Uint8Array(new Uint32Array([1]).buffer)[0] !== 1) return active;
    const simd = mode !== 'scalar' && SIMD && WebAssembly.validate(decode(SIMD_PROBE));
    if (mode !== 'scalar' && !simd) return active;
    engine ||= createEngine();
    if (simd && !engine.simd) {
      const names = new Map(Object.entries(new WebAssembly.Instance(new WebAssembly.Module(decode(SIMD)), {env: {memory: engine.memory}}).exports));
      engine.simd = {residual: names.get('residual'), fill: names.get('fill'), screen: names.get('screen'), sampled: names.get('sampled'), dct: names.get('dct')};
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
  } catch { active = 'off'; kernelHooks.channel = kernelHooks.weighted = kernelHooks.fill = kernelHooks.group = kernelHooks.screen = kernelHooks.sampled = kernelHooks.dct = null; }
  return active;
}
function kernelMode() { return active; }
return {configureKernels, kernelMode};
})();
