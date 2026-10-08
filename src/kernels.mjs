// Optional integer WebAssembly kernels. MIT (LICENSE).
// No fetch, runtime dependency, shared memory or floating-point byte decisions.
import {kernelHooks} from './kernel-hooks.mjs';
import {BitWriter, LIMITS} from './bits.mjs';
import {fault} from './admit.mjs';
import {SCALAR, SIMD, SIMD_PROBE} from './kernels-bytes.mjs';

export const {configureKernels, kernelMode} = (() => {
const P = 65536, R = 327680, PROPERTY = 589824, CONTEXT = 851968;
const OUTPUT = 1114128, TABLE = 1642496, SOURCE = 1769472, STATE = 2097152;
const DIV = 16, WEIGHTS = 272, BUCKET = 16656, MAP = 20672, ALPHABET = 257;
const CUTS = [-500,-392,-255,-191,-127,-95,-63,-47,-31,-23,-15,-11,-7,-4,-3,-1,0,1,3,5,7,11,15,23,31,47,63,95,127,191,255,392,500];
let engine, active = 'off';
const decode = text => Uint8Array.from(atob(text), c => c.charCodeAt(0));
const acceptablePlane = (p, w, h, offset, limit = 65536) => p instanceof Int16Array && Number.isInteger(w) && Number.isInteger(h) && w > 0 && h > 0 && w <= 16384 && w * h <= limit && p.length >= w * h && Number.isInteger(offset) && Math.abs(offset) <= 32768;
const acceptableWriter = w => !w || (w instanceof BitWriter && w.write === BitWriter.prototype.write && w.grow === BitWriter.prototype.grow);
// A hybrid-integer configuration the kernels write: split up to 15, msb and lsb within it, and every token a residual below
// 2^19 can take inside the 224 symbols below the LZ77 lengths. A raw histogram (lossless-coding.mjs) is bins for the
// residual values and the 33 length tokens: at most the 4,096 of a palette's indices and 33 more, in the arena's table.
const PLAIN = {split: 0, msb: 0, lsb: 0};
const acceptableConfig = c => Number.isInteger(c.split) && Number.isInteger(c.msb) && Number.isInteger(c.lsb) && c.split >= 0 && c.split <= 15 && c.msb >= 0 && c.lsb >= 0 && c.msb + c.lsb <= c.split && (1 << c.split) + ((19 - c.split) << (c.msb + c.lsb)) <= 224;
const RAW_BINS = 4096 + 33;

function createEngine() {
  const memory = new WebAssembly.Memory({initial: 48, maximum: 272});
  const names = new Map(Object.entries(new WebAssembly.Instance(new WebAssembly.Module(decode(SCALAR)), {env: {memory}}).exports));
  // Lookup strings are ABI names, never JavaScript property-mangler candidates.
  const scalar = {residual: names.get('residual'), tokens: names.get('tokens'), fill: names.get('fill'), weighted: names.get('weighted'), screen: names.get('screen')};
  const u8 = new Uint8Array(memory.buffer), i32 = new Int32Array(memory.buffer);
  for (let i = 0; i < 64; i++) i32[(DIV >> 2) + i] = Math.floor(16777216 / (i + 1));
  for (let most = 12; most <= 13; most++) for (let sum = 0; sum < 2048; sum++) {
    const shift = Math.max(0, 26 - Math.clz32(sum + 1));
    i32[(WEIGHTS >> 2) + (most - 12) * 2048 + sum] = 4 + ((most * i32[(DIV >> 2) + (sum >> shift)]) >> shift);
  }
  for (let i = 0; i < 1003; i++) i32[(BUCKET >> 2) + i] = CUTS.filter(cut => cut < i - 501).length;
  return {memory, scalar, simd: null, u8, i32};
}

// Both passes use one bulk crossing. In particular the writer never calls back into
// JS per token. Code tables use explicit little-endian i32 fields in private memory.
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
  // A raw histogram is counted, never written, into bins that fit the arena's table.
  if (raw && (w || !(target instanceof Uint32Array) || target.length < 34 || target.length > RAW_BINS)) return false;
  const n = width * height;
  if (w && w.at + n * 8 + 32 > LIMITS.bytes) return false;
  engine.i32.set(plane.subarray(0, n), P >> 2);
  (active === 'simd' ? engine.simd : engine.scalar).residual(P, width, height, leaf.predictor, leaf.offset, R);
  return tokens(w, [target], n, 0, config, raw ? target.length : 0);
}
function weighted(w, targets, plane, width, height, offset, contextOf, residuals, properties) {
  if (!acceptablePlane(plane, width, height, offset, residuals ? 1048576 : 65536) || !acceptableWriter(w)) return false;
  const n = width * height;
  if (w && w.at + n * 8 + 32 > LIMITS.bytes) return false;
  if (residuals && (!(residuals instanceof Uint32Array) || residuals.length < n)) return false;
  if (properties && (!(properties instanceof Int32Array) || properties.length < n)) return false;
  if (contextOf.length !== 34 || contextOf.some(c => !Number.isInteger(c) || c < 0 || c >= 34)) return false;
  if (!residuals && contextOf.some(c => c >= targets.length)) return false;
  // Learned 1024-pixel groups need residuals and properties, not the small token arena.
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

// Screen candidates keep one format group's complete matching history. The input
// plane becomes chain storage after residual generation; no candidate owns an arena.
function screen(plane, width, height, predictor, depth, emit) {
  const n = width * height;
  if (!(plane instanceof Int16Array) || !Number.isInteger(width) || !Number.isInteger(height) ||
      width < 1 || height < 1 || width > 16384 || height > 16384 || n > 1048576 || plane.length < n ||
      ![0, 1, 2, 3, 5].includes(predictor) || !Number.isInteger(depth) || depth < 0 || depth > 2147483647) return false;
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
  const count = backend.screen(residual, n, width, depth, head, P, rows, map, capacity - 1, output);
  for (let i = output >> 2, end = i + count * 2; i < end; i += 2) {
    const value = i32[i] >>> 0, distance = i32[i + 1];
    if (distance) emit(0, value, distance);
    else emit(value, 0, 0);
  }
  return true;
}

/** Configure optional kernels. Missing or blocked WASM or SIMD uses JavaScript.
 * `parts` is a deterministic per-realm ablation switch, not a timing-based decision.
 * Set it before an encode, never inside a progress callback.
 */
function configureKernels(mode = 'auto', parts) {
  if (!['off', 'auto', 'scalar', 'simd'].includes(mode)) throw fault('JXL_INPUT', 'Kernel mode is off, auto, scalar or simd.');
  kernelHooks.channel = kernelHooks.weighted = kernelHooks.fill = kernelHooks.screen = null; active = 'off';
  if (mode === 'off') return active;
  try {
    if (typeof WebAssembly !== 'object' || !WebAssembly.validate || new Uint8Array(new Uint32Array([1]).buffer)[0] !== 1) return active;
    // A SIMD request is not silently tested as scalar: unsupported SIMD is JS.
    const simd = mode !== 'scalar' && SIMD && WebAssembly.validate(decode(SIMD_PROBE));
    if (mode !== 'scalar' && !simd) return active;
    engine ||= createEngine();
    if (simd && !engine.simd) {
      const names = new Map(Object.entries(new WebAssembly.Instance(new WebAssembly.Module(decode(SIMD)), {env: {memory: engine.memory}}).exports));
      engine.simd = {residual: names.get('residual'), fill: names.get('fill'), screen: names.get('screen')};
    }
    active = simd ? 'simd' : 'scalar';
    const enabled = parts ? new Map(Object.entries(parts)) : null;
    if (!enabled || enabled.get('channel')) kernelHooks.channel = channel;
    if (!enabled || enabled.get('weighted')) kernelHooks.weighted = weighted;
    if (!enabled || enabled.get('fill')) kernelHooks.fill = fill;
    if (!enabled || enabled.get('screen')) kernelHooks.screen = screen;
  } catch { active = 'off'; kernelHooks.channel = kernelHooks.weighted = kernelHooks.fill = kernelHooks.screen = null; }
  return active;
}
function kernelMode() { return active; }
return {configureKernels, kernelMode};
})();
