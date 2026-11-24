import {kernelModule, compileKernels, kernelsSupported, kernelInstance, arenaHolder, heldExports, takeArena, growArena, tryGrowArena, retireKernels,
  SH_ARGS, SH_LOG2, SH_SYM, SH_LOGLEN, SH_REPEATS, SH_FREQS, SH_SCRATCH, SH_BEST} from './kernel-runtime.mjs';
// The WebAssembly kernels every encoder's pixel loops run in. MIT (images/jxl/LICENSE).
import {kernelHooks, declined} from './kernel-hooks.mjs';
import {ARENA_BYTES} from './arena.mjs';
import {jpegKernels, capJpegKernels, releaseJpegKernels} from './jpeg-kernels.mjs';
import {WEIGHTED_BUCKET, weightedTables} from './weighted-policy.mjs';
import {BitWriter} from './bits.mjs';
import {hybridToken} from './prefix.mjs';
import {fault} from './admit.mjs';
import {inCall, onCallEnd, arenaLeased} from './call-scope.mjs';

export const {ensureKernels, disableEntropyKernels, prepareKernels, arenaKernels, releaseArena, lendEntropy, orientBlock, pngRow, sampleTable, sampleBands, writeAnsTokens} = (() => {
const FORMAT = typeof __RAPIER_JXL_FORMAT__ === 'undefined' || __RAPIER_JXL_FORMAT__ === true;
const UPLOAD = typeof __RAPIER_JXL_UPLOAD__ !== 'undefined' && __RAPIER_JXL_UPLOAD__ === true;
const JPEG = typeof __RAPIER_JXL_JPEG__ !== 'undefined' && __RAPIER_JXL_JPEG__ === true;
const SAMPLE = typeof __RAPIER_JXL_SAMPLE__ !== 'undefined' && __RAPIER_JXL_SAMPLE__ === true;
const CAPTURE_PHOTO = typeof __RAPIER_JXL_CAPTURE_PHOTO__ !== 'undefined' && __RAPIER_JXL_CAPTURE_PHOTO__ === true;
const TREE_STEPS = typeof __RAPIER_JXL_UNSTEPPED__ === 'undefined' || !__RAPIER_JXL_UNSTEPPED__;
const CLUSTERED_TREES = !UPLOAD && !JPEG && !CAPTURE_PHOTO;
const TREE_DEVICE = typeof __RAPIER_JXL_TEN_DEVICE__ === 'undefined' || __RAPIER_JXL_TEN_DEVICE__ === true;
const P = 65536, R = 327680, PROPERTY = 589824, CONTEXT = 851968;
const OUTPUT = 1114128, TABLE = 1642496, SOURCE = 1769472, STATE = 2097152;
const DIV = 16, WEIGHTS = 272, BUCKET = 16656, MAP = 20672, ALPHABET = 257;
let engine, active = 'off', entropyAllowed = true;
const acceptablePlane = (p, w, h, offset, limit = 65536) => p instanceof Int16Array && Number.isInteger(w) && Number.isInteger(h) && w > 0 && h > 0 && w <= 16384 && w * h <= limit && p.length >= w * h && Number.isInteger(offset) && Math.abs(offset) <= 32768;
const acceptableWriter = w => !w || (w instanceof BitWriter && w.write === BitWriter.prototype.write && w.grow === BitWriter.prototype.grow);
const PLAIN = {split: 0, msb: 0, lsb: 0};
const acceptableConfig = c => Number.isInteger(c.split) && Number.isInteger(c.msb) && Number.isInteger(c.lsb) && c.split >= 0 && c.split <= 15 && c.msb >= 0 && c.lsb >= 0 && c.msb + c.lsb <= c.split && (1 << c.split) + ((19 - c.split) << (c.msb + c.lsb)) <= 224;
const RAW_BINS = 4096 + 33;
const GROUP_PLANES = [P, PROPERTY, CONTEXT, STATE];

let holder = null;
const enteredOf = new Map();
const entered = f => enteredOf.get(f) ?? enteredOf.set(f, function (...args) { takeArena(holder); return f.apply(this, args); }).get(f);
const OWN_HOOKS = ['weighted', 'fill', 'palette', 'rct', 'tuple', 'passLevels', 'group', 'screen', 'sampled', 'dct', 'dctFast', 'ycbcrTile', 'ycbcrTiles', 'rgbTiles', 'rgbBand', 'photoTile', 'acGroup', 'acGroupPair', 'acDeferred', 'opaque', 'nonzero', 'entropy', 'varblock', 'gaborish', 'strategyFill', 'strategyWrite', 'xybPlanes', 'gabBand', 'dcEvents', 'dcPlan', 'planTokens', 'shape', 's2cChannel', 's2cPrep'];
function createEngine() {
  const {memory, exports} = kernelInstance();
  holder ??= arenaHolder(() => {
    if (acDeferred) throw fault('JXL_INTERNAL', 'kernels:arena-deferred-ac');
    acClean = false; ansStamp = null; zdLoaded = false; acBucketsZero = false; tileBand = null; tileTables = null; acResident = null;
    vbStrip = null; vbLoaded = -1; s2cPrepLoaded = -1; shapeEpoch = -1; sampleTableEpoch = -1; heldLevelsKey = ''; retainEpoch++;
  }, () => { engine.u8 = new Uint8Array(engine.memory.buffer); engine.i32 = new Int32Array(engine.memory.buffer); },
  () => initializeTables?.(new Int32Array(engine.memory.buffer)));
  const simd = heldExports(exports, holder);
  const u8 = new Uint8Array(memory.buffer), i32 = new Int32Array(memory.buffer);
  initializeTables?.(i32);
  return {memory, simd, u8, i32};
}

const initializeTables = (SAMPLE || CAPTURE_PHOTO || JPEG) ? null : i32 => { weightedTables(i32, DIV, WEIGHTS); i32.set(WEIGHTED_BUCKET, BUCKET >> 2); };

const pngRow = (JPEG || CAPTURE_PHOTO) ? null : function pngRow(row, n, above, raw, at, filter, bpp, out, outAt, w, channels) {
  const view = new Uint8Array(sampleScratch(P + n * 3 + w * 4));
  view.set(row.subarray(0, n), P);
  if (out) return engine.simd.pngWiden(P, w, channels, P + n), out.set(view.subarray(P + n, P + n + w * 4), outAt);
  view.set(above.subarray(0, n), P + n); view.set(raw.subarray(at, at + n), P + 2 * n);
  engine.simd.pngUnfilter(filter, P + 2 * n, P, P + n, n, bpp);
  row.set(view.subarray(P, P + n));
};

const orientBlock = CAPTURE_PHOTO ? null : function orientBlock(from, to, stride, outStride, x, y, width, height, ox, oy, pixelBytes, orientation) {
  if (active !== 'simd' || !engine.simd.orientRGBA) throw fault('JXL_WASM', 'orientation kernel: unavailable');
  if (!(from instanceof Uint8Array) || !(to instanceof Uint8Array) || ![4, 8, 16].includes(pixelBytes) ||
      !Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 256 || height > 256 ||
      !Number.isInteger(orientation) || orientation < 1 || orientation > 8)
    throw fault('JXL_INTERNAL', 'kernels:orientation-block');
  acClean = false; ansStamp = null; zdLoaded = false; acBucketsZero = false; tileBand = null; acResident = null; retainEpoch++;
  const bytes = width * height * pixelBytes, destination = P + bytes;
  const view = new Uint8Array(engine.memory.buffer), rowBytes = width * pixelBytes;
  for (let row = 0; row < height; row++) {
    const at = ((y + row) * stride + x) * pixelBytes;
    view.set(from.subarray(at, at + rowBytes), P + row * rowBytes);
  }
  engine.simd.orientRGBA(P, width, height, pixelBytes, orientation, destination);
  const outWidth = orientation >= 5 ? height : width, outHeight = orientation >= 5 ? width : height, outBytes = outWidth * pixelBytes;
  for (let row = 0; row < outHeight; row++) {
    const at = destination + row * outBytes;
    to.set(view.subarray(at, at + outBytes), ((oy + row) * outStride + ox) * pixelBytes);
  }
};

const SAMPLE_TABLE = P, SAMPLE_LEVELS = SAMPLE_TABLE + 65536 * 8, SAMPLE_SAFE = SAMPLE_LEVELS + 32768 + 4097 * 4 + 7 & ~7,
  SAMPLE_BAND_AT = SAMPLE_SAFE + 131072, SAMPLE_BAND_PIXELS = 262144;
let heldSampleTable = null, sampleTableEpoch = -1;
const sampleScratch = (JPEG || CAPTURE_PHOTO) ? null : function sampleScratch(end = SAMPLE_BAND_AT + 65536 * 8) {
  if (active !== 'simd' || !engine.simd.sampleBand) throw fault('JXL_WASM', 'resampling kernel: unavailable');
  const held = sampleTableEpoch === retainEpoch;
  acClean = false; ansStamp = null; zdLoaded = false; acBucketsZero = false; tileBand = null; acResident = null; retainEpoch++;
  if (held) sampleTableEpoch = retainEpoch;
  if (engine.memory.buffer.byteLength < end) growArena(end);
  return engine.memory.buffer;
};
const sampleStatus = (JPEG || CAPTURE_PHOTO) ? null : function sampleStatus(status) {
  if (status) throw fault('JXL_INPUT', [null, 'alpha: finite 0-1',
    'color samples: finite', 'PQ samples: 0-1',
    'HLG samples: nonnegative', 'resampled value: out of range'][status]);
};
const sampleTable = (JPEG || CAPTURE_PHOTO) ? null : function sampleTable(maximum, transfer) {
  if (![255, 1023, 4095, 65535].includes(maximum) || !(Number.isInteger(transfer) && (transfer >= 0 && transfer <= 4 || transfer >= 1221 && transfer <= 1e7)))
    throw fault('JXL_INTERNAL', 'kernels:sample-transfer-table');
  const buffer = sampleScratch(); engine.simd.sampleTable(transfer, maximum, SAMPLE_TABLE, 0);
  heldSampleTable = new Float64Array(buffer, SAMPLE_TABLE, maximum + 1).slice();
  sampleTableEpoch = retainEpoch;
  return heldSampleTable;
};
let heldLevels = null, heldSafe = null, heldLevelsKey = '';
const sampleBands = (JPEG || CAPTURE_PHOTO) ? null : function sampleBands(width, height, target, rows, config, table, levels, bytesPerSample) {
  if (![width, height, target, rows].every(n => Number.isInteger(n) && n >= 1) || ![1, 2, 4].includes(bytesPerSample) ||
      levels && !(config[0] < 2 && [255, 1023, 4095].includes(config[1]) && !config[3] && config[4] === 1))
    throw fault('JXL_INTERNAL', 'kernels:resample-band-config');
  const stride = Math.max(width, target) * 32, rowBytes = width * 4 * bytesPerSample, outBytes = target * 4 * bytesPerSample;
  const sourceRows = Math.max(1, Math.min(height, Math.floor(SAMPLE_BAND_PIXELS / width)));
  const outRows = Math.max(1, Math.min(rows, Math.floor(SAMPLE_BAND_PIXELS / target)));
  const scratch = SAMPLE_BAND_AT, sum = scratch + stride * 3, index = scratch + stride * 4, weights = index + target * 12 + 7 & ~7;
  const input = weights + (width + 2 * target) * 8, output = input + sourceRows * rowBytes, end = output + outRows * outBytes;
  return {sourceRows, outRows, run(data, first, last, y0, y1, out, outY, carry, open, base = 0) {
    if (last - first > sourceRows || last <= first || y1 - y0 > outRows || y0 < 0 || y1 > rows || y0 >= y1 || first < 0 || last > height ||
        carry && carry.length !== target * 4)
      throw fault('JXL_INTERNAL', 'kernels:resample-band-carry');
    const buffer = sampleScratch(end), bytes = new Uint8Array(buffer);
    if (table && (heldSampleTable !== table || sampleTableEpoch !== retainEpoch)) {
      new Float64Array(buffer).set(table, SAMPLE_TABLE >> 3);
      heldSampleTable = table; sampleTableEpoch = retainEpoch;
    }
    const key = config[1] + ':' + config[2];
    if (levels && heldLevelsKey !== key) {
      engine.simd.sampleTable(config[2], config[1], SAMPLE_BAND_AT, SAMPLE_LEVELS);
      engine.simd.sampleSafe(SAMPLE_LEVELS, config[1], SAMPLE_SAFE);
      heldLevels = bytes.slice(SAMPLE_LEVELS, SAMPLE_LEVELS + 32768 + 4097 * 4);
      heldSafe = bytes.slice(SAMPLE_SAFE, SAMPLE_SAFE + 131072); heldLevelsKey = key;
    } else if (levels) { bytes.set(heldLevels, SAMPLE_LEVELS); bytes.set(heldSafe, SAMPLE_SAFE); }
    bytes.set(new Uint8Array(data.buffer, data.byteOffset + (first - base) * rowBytes, (last - first) * rowBytes), input);
    if (carry) new Float64Array(buffer).set(carry, sum >> 3);
    engine.simd.samplePlan(width, target, index, weights);
    sampleStatus(engine.simd.sampleBand(input, first, last, carry ? 1 : 0, width, height, target, rows, y0, y1, ...config,
      table ? SAMPLE_TABLE : 0, levels ? SAMPLE_LEVELS : 0, levels ? SAMPLE_SAFE : 0, index, weights, scratch, stride, output));
    const done = y1 - y0 - (open ? 1 : 0);
    new Uint8Array(out.buffer, out.byteOffset + outY * outBytes, done * outBytes).set(bytes.subarray(output, output + done * outBytes));
    return open ? new Float64Array(buffer, sum, target * 4).slice() : null;
  }};
};

const SMALL_TOKENS = SAMPLE ? null : Object.freeze({residual: R, table: TABLE, output: OUTPUT});
const tokens = SAMPLE ? null : function tokens(w, targets, count, contexts, config = PLAIN, rawLength = 0, at = SMALL_TOKENS) {
  acClean = false; ansStamp = null; zdLoaded = false; acBucketsZero = false; tileBand = null; acResident = null; retainEpoch++;
  const {simd, i32, u8} = engine, stride = rawLength || ALPHABET;
  if (!acceptableWriter(w) || !targets.length || targets.length > 34) return false;
  const {residual, table, output} = at;
  if (w) {
    i32.fill(0, table >> 2, (table >> 2) + targets.length * ALPHABET * 2);
    for (let c = 0; c < targets.length; c++) {
      const code = targets[c];
      if (!code?.lengths || !code?.codes || code.lengths.length > ALPHABET) return false;
      for (let s = 0; s < code.lengths.length; s++) {
        i32[(table >> 2) + (c * ALPHABET + s) * 2] = code.lengths[s];
        i32[(table >> 2) + (c * ALPHABET + s) * 2 + 1] = code.codes[s];
      }
    }
  } else {
    for (let c = 0; c < targets.length; c++) {
      if (!(targets[c] instanceof Uint32Array) || targets[c].length !== stride) return false;
      i32.set(targets[c], (table >> 2) + c * stride);
    }
  }
  const written = simd.tokens(residual, contexts, count, table, output, w ? 1 : 0, w ? w.acc : 0, w ? w.pending : 0, config.split, config.msb, config.lsb, rawLength);
  if (w) {
    if (w.at + written + 8 >= w.bytes.length) w.grow(written + 8);
    w.bytes.set(u8.subarray(output, output + written), w.at);
    w.at += written; w.acc = i32[(output - 8) >> 2]; w.pending = i32[(output - 4) >> 2];
  } else for (let c = 0; c < targets.length; c++) targets[c].set(i32.subarray((table >> 2) + c * stride, (table >> 2) + (c + 1) * stride));
  return true;
}

const WEIGHTED_BAND = 1048576;
const weightedPlane = SAMPLE ? null : (p, w, h, offset) => p instanceof Int16Array && Number.isInteger(w) && Number.isInteger(h) && w > 0 && h > 0 &&
  p.length >= w * h && Number.isInteger(offset) && Math.abs(offset) <= 32768;
const weightedGrow = SAMPLE ? null : growArena;
const weightedBands = SAMPLE ? null : function weightedBands(plane, width, height, offset, residuals, properties) {
  const rows = Math.max(1, Math.min(height, Math.floor(WEIGHTED_BAND / width))), band = rows * width;
  const first = P + width * 4, residual = first + band * 4, property = residual + band * 4, state = property + band * 4;
  weightedGrow(state + (width + 2) * 40);
  const {i32, simd} = engine;
  i32.fill(0, state >> 2, (state >> 2) + (width + 2) * 10);
  for (let y0 = 0; y0 < height; y0 += rows) {
    const y1 = Math.min(height, y0 + rows), count = (y1 - y0) * width;
    i32.set(plane.subarray(Math.max(0, y0 - 1) * width, y1 * width), (y0 ? P : first) >> 2);
    simd.captureWeighted(first, width, y1, offset, residual, property, y0, 0, 0, DIV, WEIGHTS, state);
    residuals.set(i32.subarray(residual >> 2, (residual >> 2) + count), y0 * width);
    if (properties) properties.set(i32.subarray(property >> 2, (property >> 2) + count), y0 * width);
  }
  return true;
};
const weighted = SAMPLE ? null : function weighted(w, targets, plane, width, height, offset, contextOf, residuals, properties) {
  acClean = false; ansStamp = null; zdLoaded = false; acBucketsZero = false; tileBand = null; acResident = null; retainEpoch++;
  if (!weightedPlane(plane, width, height, offset) || !acceptableWriter(w)) return false;
  const n = width * height;
  if (w && w.at + n * 8 + 32 > 0x7fffffff) throw fault('JXL_MEMORY', 'weighted predictor: output >2GB');
  if (residuals && (!(residuals instanceof Uint32Array) || residuals.length < n)) return false;
  if (properties && (!(properties instanceof Int32Array) || properties.length < n)) return false;
  if (contextOf.length !== 34 || contextOf.some(c => !Number.isInteger(c) || c < 0 || c >= 34)) return false;
  if (!residuals && contextOf.some(c => c >= targets.length)) return false;
  if (residuals && (n > WEIGHTED_BAND || width > 16384)) return weightedBands(plane, width, height, offset, residuals, properties);
  const large = n > 65536, residual = large ? P + n * 4 : R, property = large ? P + n * 8 : PROPERTY;
  const context = large ? P + n * 12 : CONTEXT, state = large ? P + n * 16 : STATE;
  const table = large ? state + (width + 2) * 40 + 15 & ~15 : TABLE, output = large ? table + 34 * ALPHABET * 8 + 16 : OUTPUT;
  weightedGrow(large && !residuals ? output + n * 8 + 64 : state + (width + 2) * 40);
  const {i32, simd} = engine;
  i32.set(plane.subarray(0, n), P >> 2); i32.set(contextOf, MAP >> 2);
  i32.fill(0, state >> 2, (state >> 2) + (width + 2) * 10);
  if (!UPLOAD && residuals && properties && offset === 0) simd.wpDc(P, width, height, residual, property, DIV, WEIGHTS, state);
  else simd.weighted(P, width, height, offset, residual, property, context, MAP, BUCKET, DIV, WEIGHTS, state);
  if (residuals) {
    residuals.set(i32.subarray(residual >> 2, (residual >> 2) + n));
    if (properties) properties.set(i32.subarray(property >> 2, (property >> 2) + n));
    return true;
  }
  if (properties) properties.set(i32.subarray(property >> 2, (property >> 2) + n));
  return tokens(w, targets, n, context, PLAIN, 0, large ? {residual, table, output} : SMALL_TOKENS);
}
const dirty = () => { acClean = false; ansStamp = null; zdLoaded = false; acBucketsZero = false; tileBand = null; acResident = null; retainEpoch++; };
const FILL_OUT = [P, R, PROPERTY, CONTEXT];
const rgbaBands = SAMPLE || JPEG ? null : function rgbaBands(rgba, imageWidth, x0, y0, w, h, count, planes, run) {
  dirty();
  const wide = rgba instanceof Int16Array, view = wide ? new Int16Array(engine.memory.buffer) : engine.u8, to = wide ? SOURCE >> 1 : SOURCE;
  const limit = wide ? 32768 : 65536, rows = Math.max(1, Math.floor(limit / w)), span = Math.min(w, limit);
  for (let y = 0; y < h; y += rows) for (let x = 0; x < w; x += span) {
    const r = Math.min(rows, h - y), n = Math.min(span, w - x);
    for (let k = 0; k < r; k++) view.set(rgba.subarray(((y0 + y + k) * imageWidth + x0 + x) * 4, ((y0 + y + k) * imageWidth + x0 + x + n) * 4), to + k * n * 4);
    run(r * n);
    for (let c = 0; c < count; c++) {
      const from = engine.i32.subarray(FILL_OUT[c] >> 2, (FILL_OUT[c] >> 2) + r * n);
      planes[c].set(from, y * w + x);
    }
  }
  return true;
};
const fill = SAMPLE || JPEG ? null : (rgba, imageWidth, x0, y0, w, h, channels, planes) =>
  rgbaBands(rgba, imageWidth, x0, y0, w, h, channels, planes, n => engine.simd.fill(SOURCE, n, channels, ...FILL_OUT));
const tupleTables = new WeakMap();
const tupleIndex = SAMPLE || JPEG ? null : function tupleIndex(planes, n, keys, out) {
  const k = planes.length;
  let t = tupleTables.get(keys);
  if (!t) {
    const bits = Math.max(4, 32 - Math.clz32(keys.length * 2 - 1)), mask = (1 << bits) - 1, slots = new Int32Array(5 << bits);
    keys.forEach((key, at) => {
      if (key.length !== k) throw declined('tupleIndex');
      let h = 2166136261 | 0, slot;
      for (const v of key) h = Math.imul(h ^ v, 16777619);
      for (slot = h & mask; slots[slot * 5 + 4] && !key.every((v, c) => slots[slot * 5 + c] === (v | 0)); slot = slot + 1 & mask);
      slots.set(key, slot * 5); slots[slot * 5 + 4] = at + 1;
    });
    tupleTables.set(keys, t = {slots, mask});
  }
  dirty();
  const i32 = engine.i32;
  i32.set(t.slots, TABLE >> 2);
  for (let at = 0; at < n; at += 65536) {
    const m = Math.min(65536, n - at);
    for (let c = 0; c < k; c++) i32.set(planes[c].subarray(at, at + m), (P >> 2) + c * m);
    engine.simd.tupleIndex(P, m * 4, m, k, TABLE, t.mask, SOURCE);
    out.set(i32.subarray(SOURCE >> 2, (SOURCE >> 2) + m), at);
  }
  return true;
};
const passLevels = SAMPLE || JPEG || !(typeof __RAPIER_JXL_PROGRESSIVE__ === 'undefined' || __RAPIER_JXL_PROGRESSIVE__ === true) ? null : function passLevels(coeffs, passes, pass) {
  dirty();
  const i16 = new Int16Array(engine.memory.buffer), out = new Int16Array(coeffs.length);
  engine.i32.set(passes.flatMap(({downsample, shift}) => [downsample, shift]), P >> 2);
  for (let at = 0; at < coeffs.length; at += 131072) {
    const n = Math.min(131072, coeffs.length - at);
    i16.set(coeffs.subarray(at, at + n), R >> 1);
    engine.simd.passLevels(R, n, P, pass, PROPERTY);
    out.set(i16.subarray(PROPERTY >> 1, (PROPERTY >> 1) + n), at);
  }
  return out;
};
const rctFill = SAMPLE || JPEG ? null : function rctFill(rgba, imageWidth, x0, y0, w, h, type, channels, planes) {
  const p = Math.floor(type / 7), q = Math.floor(p / 3);
  return rgbaBands(rgba, imageWidth, x0, y0, w, h, channels, planes,
    n => engine.simd.rctFill(SOURCE, n, p % 3, (p + 1 + q) % 3, (p + 2 - q) % 3, type % 7, channels, rgba instanceof Int16Array ? 1 : 0, ...FILL_OUT));
};

const paletteTables = new WeakMap();
const paletteFill = SAMPLE || JPEG ? null : function paletteFill(rgba, imageWidth, x0, y0, w, h, palette, grey, alpha, plane) {
  let t = paletteTables.get(palette);
  if (!t) {
    const bits = Math.max(4, 32 - Math.clz32(palette.length * 2 - 1)), mask = (1 << bits) - 1, slots = new Uint32Array(2 << bits);
    palette.forEach((key, at) => {
      let slot = Math.imul(key >>> 0, 0x9e3779b1) >>> (32 - bits);
      while (slots[slot * 2 + 1] && slots[slot * 2] !== key >>> 0) slot = slot + 1 & mask;
      slots[slot * 2] = key >>> 0; slots[slot * 2 + 1] = at + 1;
    });
    paletteTables.set(palette, t = {slots, mask, shift: 32 - bits});
  }
  engine.i32.set(t.slots, R >> 2);
  return rgbaBands(rgba, imageWidth, x0, y0, w, h, 1, [plane], n => engine.simd.paletteFill(SOURCE, n, grey ? 1 : 0, alpha ? 1 : 0, R, t.mask, t.shift, P));
};

const loadBasis = JPEG || SAMPLE ? null : function loadBasis(f64, basis) {
  const pair = R + 512;
  f64.set(basis, R >> 3);
  for (let u = 0; u < 8; u += 2) for (let x = 0; x < 8; x++) {
    f64[(pair >> 3) + u * 8 + x * 2] = basis[u * 8 + x];
    f64[(pair >> 3) + u * 8 + x * 2 + 1] = basis[(u + 1) * 8 + x];
  }
  return pair;
};

const dct = JPEG || SAMPLE ? null : function dct(blocks, count, basis) {
  acClean = false; ansStamp = null; zdLoaded = false; acBucketsZero = false; tileBand = null; acResident = null; retainEpoch++;
  if (active !== 'simd' || !(blocks instanceof Float64Array) || !Number.isInteger(count) || count < 1 || count > 64 ||
      blocks.length < count * 192 || !(basis instanceof Float64Array) || basis.length !== 64) return false;
  const f64 = new Float64Array(engine.memory.buffer);
  f64.set(blocks.subarray(0, count * 192), P >> 3);
  engine.simd.dct(P, count, R, loadBasis(f64, basis), P + 64 * 192 * 8);
  blocks.set(f64.subarray(P >> 3, (P >> 3) + count * 192));
  return true;
}

const dctFast = JPEG || SAMPLE ? null : function dctFast(blocks, count, scale) {
  acClean = false; ansStamp = null; zdLoaded = false; acBucketsZero = false; tileBand = null; acResident = null; retainEpoch++;
  if (active !== 'simd' || !(blocks instanceof Float64Array) || !Number.isInteger(count) || count < 1 ||
      blocks.length < count * 192 || !(scale instanceof Float64Array) || scale.length !== 64) return false;
  const f64 = new Float64Array(engine.memory.buffer);
  f64.set(scale, R >> 3);
  for (let off = 0; off < count; off += 64) {
    const n = Math.min(64, count - off);
    f64.set(blocks.subarray(off * 192, (off + n) * 192), P >> 3);
    engine.simd.xybTile(0, 0, n, 1, P, 0, 0, R, 0, 0, 0, 0, 0);
    blocks.set(f64.subarray(P >> 3, (P >> 3) + n * 192), off * 192);
  }
  return true;
}

const ycbcrTile = JPEG || SAMPLE ? null : function ycbcrTile(data, width, rowAt, x0, count, tables, coeffs, offset, basis) {
  if (active !== 'simd' || !engine.simd.ycbcrTile) return false;
  const YT_SCRATCH = P + 98304, YT_SRC = YT_SCRATCH + 512, YT_OUT = YT_SRC + 16384, YT_TABLES = YT_OUT + 24576;
  acClean = false; ansStamp = null; zdLoaded = false; acBucketsZero = false; tileBand = null; acResident = null; retainEpoch++;
  const buffer = engine.memory.buffer, u8 = new Uint8Array(buffer), f64 = new Float64Array(buffer);
  const from = x0 * 32, inside = Math.min(count * 32, width * 4 - from), rowBytes = count * 32, planes = coeffs.length;
  for (let y = 0; y < 8; y++) {
    const at = rowAt[y] + from, row = YT_SRC + y * rowBytes;
    u8.set(data.subarray(at, at + inside), row);
    for (let x = inside; x < rowBytes; x += 4) u8.copyWithin(row + x, row + inside - 4, row + inside);
  }
  f64.set(tables, YT_TABLES >> 3);
  engine.simd.ycbcrTile(YT_SRC, rowBytes, count, P, R, loadBasis(f64, basis), YT_SCRATCH, YT_TABLES, YT_TABLES + 1536, YT_TABLES + 3072, planes, YT_OUT, 16);
  const levels = new Int16Array(buffer, YT_OUT, planes * count * 64);
  for (let c = 0; c < planes; c++) coeffs[c].set(levels.subarray(c * count * 64, (c + 1) * count * 64), offset);
  return true;
};

const YCBCR_WIRE_MAP = [1, 0, 2], ycbcrWireTables = new WeakMap();
function ycbcrWireTable(t) {
  let wire = ycbcrWireTables.get(t);
  if (!wire) {
    wire = new Float64Array(396);
    for (let wc = 0; wc < 3; wc++) {
      const sc0 = YCBCR_WIRE_MAP[wc] * 64;
      for (let k = 0; k < 64; k++) { wire[wc * 64 + k] = 16 / t[sc0 + k]; wire[192 + wc * 64 + k] = t[192 + sc0 + k]; }
    }
    wire.set(t.subarray(388, 392), 384); wire.set(t.subarray(384, 388), 388); wire.set(t.subarray(392, 396), 392);
    ycbcrWireTables.set(t, wire);
  }
  return wire;
}

const ycbcrTiles = JPEG || SAMPLE ? null : function ycbcrTiles(data, width, height, bx0, by0, bw, bh, tableOf, cflOf, planes, nonZero, stride, basis) {
  if (active !== 'simd' || !engine.simd.ycbcrRegion || !engine.simd.ycbcrQuant || !(data instanceof Uint8Array || data instanceof Uint8ClampedArray) || !(bw >= 1 && bw <= 8 && bh >= 1 && bh <= 8)) return false;
  const SCRATCH = P + 98304, SRC = SCRATCH + 512, OUT = SRC + 16384, COUNTS = OUT + 24576, SUMS = COUNTS + 192, WEIGHTS = SUMS + 32, TABS = WEIGHTS + 96, TABLES = R + 1024;
  acClean = false; ansStamp = null; zdLoaded = false; acBucketsZero = false; tileBand = null; acResident = null; retainEpoch++;
  const buffer = engine.memory.buffer, u8 = new Uint8Array(buffer), f64 = new Float64Array(buffer), i32 = new Int32Array(buffer);
  const count = bw * bh;
  let firstWire = null, lastTable = null, lastAt = 0, slots = null;
  for (let n = 0; n < count; n++) {
    const t = tableOf(by0 + (n / bw | 0), bx0 + n % bw);
    let at;
    if (t === lastTable) at = lastAt;
    else if (!firstWire) {
      firstWire = ycbcrWireTable(t);
      at = TABLES;
      f64.set(firstWire.subarray(0, 384), at >> 3);
      lastTable = t; lastAt = at;
    } else {
      if (!slots) slots = new Map([[lastTable, lastAt]]);
      at = slots.get(t);
      if (at === undefined) {
        at = TABLES + slots.size * 3072;
        f64.set(ycbcrWireTable(t).subarray(0, 384), at >> 3);
        slots.set(t, at);
      }
      lastTable = t; lastAt = at;
    }
    i32[(TABS >> 2) + n] = at;
  }
  f64.set(firstWire.subarray(384, 396), WEIGHTS >> 3);
  const rowBytes = bw * 32, from = bx0 * 32, inside = Math.min(rowBytes, width * 4 - from);
  for (let y = 0; y < bh * 8; y++) {
    const at = Math.min(height - 1, by0 * 8 + y) * width * 4 + from, row = SRC + y * rowBytes;
    u8.set(data.subarray(at, at + inside), row);
    for (let x = inside; x < rowBytes; x += 4) u8.copyWithin(row + x, row + inside - 4, row + inside);
  }
  engine.simd.ycbcrRegion(SRC, rowBytes, bw, bh, P, R, loadBasis(f64, basis), SCRATCH, TABS, WEIGHTS, OUT, COUNTS, SUMS);
  const [rx, rb] = cflOf(f64[SUMS >> 3], f64[(SUMS >> 3) + 1], f64[(SUMS >> 3) + 2]);
  engine.simd.ycbcrQuant(P, count, TABS, rx, rb, OUT, COUNTS);
  const levels = new Int16Array(buffer, OUT, 3 * count * 64);
  for (let wc = 0; wc < 3; wc++) {
    const dst = planes[YCBCR_WIRE_MAP[wc]], nz = nonZero?.[YCBCR_WIRE_MAP[wc]];
    for (let y = 0; y < bh; y++) {
      const fromBlock = wc * count + y * bw, block = (by0 + y) * stride + bx0;
      dst.set(levels.subarray(fromBlock * 64, (fromBlock + bw) * 64), block * 64);
      if (nz) nz.set(u8.subarray(COUNTS + fromBlock, COUNTS + fromBlock + bw), block);
    }
  }
  return true;
};

const rgbTile = JPEG || SAMPLE ? null : function rgbTile(data, width, height, bx0, by0, bw, bh, tableOf, cflOf, planes, stride, basis, quantScale, resident = null) {
  if (active !== 'simd' || !engine.simd.rgbTile || !(data instanceof Uint8Array || data instanceof Uint8ClampedArray) || !(bw >= 1 && bw <= 8 && bh >= 1 && bh <= 8)) return false;
  const SCRATCH = P + 98304, SRC = SCRATCH + 512, OUT = SRC + 16384, SUMS = OUT + 24576, TABS = SUMS + 32, TABLES = R + 1024;
  acClean = false; ansStamp = null; zdLoaded = false; acBucketsZero = false; tileBand = null; acResident = null; retainEpoch++;
  const buffer = engine.memory.buffer, u8 = new Uint8Array(buffer), f64 = new Float64Array(buffer), i32 = new Int32Array(buffer);
  const count = bw * bh, slots = new Map();
  for (let n = 0; n < count; n++) {
    const t = tableOf(by0 + (n / bw | 0), bx0 + n % bw);
    let at = slots.get(t);
    if (at === undefined) {
      at = TABLES + slots.size * 3072;
      if (t.length !== 384) return false;
      f64.set(t, at >> 3); slots.set(t, at);
    }
    i32[(TABS >> 2) + n] = at;
  }
  const rowBytes = resident ? stride * 32 : bw * 32, from = bx0 * 32, inside = Math.min(bw * 32, width * 4 - from);
  if (!resident) for (let y = 0; y < bh * 8; y++) {
    const at = Math.min(height - 1, by0 * 8 + y) * width * 4 + from, row = SRC + y * rowBytes;
    u8.set(data.subarray(at, at + inside), row);
    for (let x = inside; x < rowBytes; x += 4) u8.copyWithin(row + x, row + inside - 4, row + inside);
  }
  const source = resident ? resident.pixels + by0 * 8 * rowBytes + from : SRC;
  engine.simd.rgbTile(source, rowBytes, bw, bh, P, R, loadBasis(f64, basis), SCRATCH, TABS, OUT, quantScale, SUMS);
  const [ax, ab] = cflOf(f64[SUMS >> 3], f64[(SUMS >> 3) + 1], f64[(SUMS >> 3) + 2]);
  engine.simd.rgbQuant(P, count, TABS, ax, ab, OUT, quantScale);
  if (resident) {
    for (let c = 0; c < 3; c++) for (let y = 0; y < bh; y++) {
      const from = OUT + (c * count + y * bw) * 128, to = resident.levels + ((c * 8 + y) * stride + bx0) * 128;
      u8.copyWithin(to, from, from + bw * 128);
    }
  } else {
    const levels = new Int16Array(buffer, OUT, 3 * count * 64);
    for (let c = 0; c < 3; c++) for (let y = 0; y < bh; y++)
      planes[c].set(levels.subarray((c * count + y * bw) * 64, (c * count + y * bw + bw) * 64), ((by0 + y) * stride + bx0) * 64);
  }
  return true;
};

const TILE_ROOTS = 20816, TILE_LINEAR = 53728, TILE_MIX = 59872, TILE_SCALE = 59952, TILE_STEPS = 60464, TILE_LIMITS = 62000;
const TILE_F64 = P + 16384;
let tileTables = null, tileBand = null;
let retainEpoch = 0;
const TILE_BAND = 12582912;
const TILE_SUMS = P + 150160, TILE_OUT = P + 153256, TILE_COUNTS = P + 177832;
const sampleLayout = (data, samples = null, signed = false) => {
  if (data instanceof Uint8Array || data instanceof Uint8ClampedArray)
    return {mode: signed ? 1 : 0, bpe: 4, bytes: data, curve: null, lift: 1};
  const f16 = typeof Float16Array === 'function' && data instanceof Float16Array;
  if ((data instanceof Uint16Array || f16) && samples?.exponentBits === 5)
    return {mode: 3, bpe: 8, bytes: new Uint8Array(data.buffer, data.byteOffset, data.byteLength), curve: null, lift: samples.lift ?? 1};
  if (data instanceof Uint16Array) {
    const curve = samples?.curve;
    if (!(curve instanceof Float64Array) || curve.length !== 1 << (samples.bitDepth ?? 16)) return null;
    return {mode: 2, bpe: 8, bytes: new Uint8Array(data.buffer, data.byteOffset, data.byteLength), curve, lift: samples.lift ?? 1};
  }
  if (data instanceof Float32Array)
    return {mode: 4, bpe: 16, bytes: new Uint8Array(data.buffer, data.byteOffset, data.byteLength), curve: null, lift: samples?.lift ?? 1};
  return null;
};
const photoTile = JPEG || SAMPLE ? null : function photoTile(data, width, height, bx0, by0, bw, bh, tables, cfl, components, stride, nonZero) {
  retainEpoch++;
  const layout = sampleLayout(data, tables.samples, tables.signed);
  const lin = layout?.mode <= 1 ? (Array.isArray(tables.linear) ? tables.linear : [tables.linear, tables.linear, tables.linear]) : null;
  if (active !== 'simd' || !layout || data.length !== width * height * 4 || !Number.isInteger(bw) || !Number.isInteger(bh) ||
      bw < 1 || bw > 8 || bh < 1 || bh > 8 || tables.roots.length !== 4113 || (lin && (lin.length !== 3 || lin.some(t => t.length !== 256))) || tables.mix.length !== 9) return false;
  const bpe = layout.bpe, curveBytes = layout.mode === 2 ? layout.curve.byteLength : 0, bandAt = TILE_BAND + curveBytes;
  const padded = stride * 8 * bpe, end = bandAt + 64 * padded;
  if (end > engine.memory.buffer.byteLength) {
    if (data.buffer === engine.memory.buffer) data = data.slice();
    growArena(end);
  }
  const source = acIdentity(data);
  if (tileBand?.tables !== tables || tileBand.source !== source || tileBand.width !== width || tileBand.height !== height ||
      tileBand.stride !== stride || tileBand.by0 !== by0 || tileBand.bh !== bh) {
    acClean = false; ansStamp = null; zdLoaded = false; acBucketsZero = false; acResident = null;
    if (layout.mode === 2) new Float64Array(engine.memory.buffer).set(layout.curve, TILE_BAND >> 3);
    const u8 = engine.u8, rowWidth = width * bpe, padCols = stride * 8 - width;
    for (let y = 0; y < bh * 8; y++) {
      const at = Math.min(height - 1, by0 * 8 + y) * rowWidth, row = bandAt + y * padded;
      u8.set(layout.bytes.subarray(at, at + rowWidth), row);
      if (padCols > 0) {
        const last = layout.bytes.subarray(at + rowWidth - bpe, at + rowWidth);
        for (let p = 0; p < padCols; p++) u8.set(last, row + rowWidth + p * bpe);
      }
    }
    tileBand = {tables, source, width, height, stride, by0, bh};
  }
  const src = bandAt + bx0 * 8 * bpe, rowBytes = padded;
  const u8 = engine.u8, f64 = new Float64Array(engine.memory.buffer), count = bw * bh;
  if (tileTables !== tables) {
    f64.set(tables.roots, TILE_ROOTS >> 3); f64.set(tables.mix, TILE_MIX >> 3); f64[(TILE_MIX + 72) >> 3] = layout.lift; f64.set(tables.scale, TILE_SCALE >> 3);
    for (let c = 0; c < 3; c++) {
      if (lin) f64.set(lin[c], (TILE_LINEAR >> 3) + c * 256);
      f64.set(tables.steps[c], (TILE_STEPS >> 3) + c * 64);
      f64.set(tables.limits[c], (TILE_LIMITS >> 3) + c * 64);
    }
    tileTables = tables;
  }
  engine.simd.xybTile(src, rowBytes, bw, bh, TILE_F64, TILE_ROOTS, layout.mode === 2 ? TILE_BAND : TILE_LINEAR, TILE_SCALE, tables.bias, tables.rootBias, TILE_SUMS, TILE_MIX, layout.mode);
  const [fx, fb] = cfl(f64[(TILE_SUMS >> 3) + 1], f64[TILE_SUMS >> 3], f64[(TILE_SUMS >> 3) + 2]);
  if (engine.simd.quantTile(TILE_F64, count, TILE_STEPS, TILE_LIMITS, fx / 84, fb / 84, TILE_OUT, TILE_COUNTS, tables.strict ? 1 : 0)) return 'overflow';
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
let acClean = false, acCleanBytes = 0, ansStamp = null, zdLoaded = false, acBucketsZero = false, acResident = null, acDeferred = null;
const acIdentities = new WeakMap();
const acIdentity = source => {
  let identity = acIdentities.get(source);
  if (!identity) acIdentities.set(source, identity = {});
  return identity;
};
const HIST_KEY = contexts => contexts.contexts;
const ansTables = new WeakMap();
const RECIPS_BYTES = 4097 * 8;
let reciprocalTable = null;
const reciprocals = SAMPLE ? null : function reciprocals() {
  if (reciprocalTable) return reciprocalTable;
  const table = new Int32Array(4097 * 2);
  for (let d = 1; d <= 4096; d++) {
    const l = 32 - Math.clz32(d - 1), n = 2 ** (32 + l);
    let q = Math.floor(n / d), r = n - q * d;
    if (r < 0) { q--; r += d; } else if (r >= d) { q++; r -= d; }
    table[d * 2] = (q + (r ? 1 : 0) - 2 ** 32) | 0; table[d * 2 + 1] = l;
  }
  return reciprocalTable = table;
}
const ansTablesOf = SAMPLE ? null : function ansTablesOf(model) {
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
const parkAt = values => values + 23 * 3 * 1024 * 64 + 256 + 15 & ~15;
const acGroupPair = SAMPLE || JPEG ? null : function acGroupPair(state, g0, g1, pass, sink0, sink1, zd) {
  if (sink0.counts || sink1.counts || !sink0.coding || sink0.coding.model !== sink1.coding?.model || sink0.coding.model?.kind !== 'ans') return false;
  const pair = {};
  if (acGroup(state, g0, pass, sink0, zd, pair) !== 3) return false;
  return acGroup(state, g1, pass, sink1, zd, pair) === 2 ? 2 : flushParked(pair) ? 1 : false;
}
const flushParked = SAMPLE ? null : function flushParked(pair) {
  const args = AC_CONFIGS + 4096 - 256, i32 = new Int32Array(engine.memory.buffer);
  i32.set(pair.args, args >> 2);
  engine.simd.ansFlush(args);
  takeFlushed(pair.w, args, pair.out);
  return true;
}
const flushTokens = (SAMPLE || (typeof __RAPIER_JXL_CAPTURE_PHOTO__ !== 'undefined' && __RAPIER_JXL_CAPTURE_PHOTO__ === true)) ? null : function flushTokens(w, model, values, ids, n) {
  engine ||= createEngine();
  takeArena(holder);
  acClean = false; zdLoaded = false; acBucketsZero = false; tileBand = null; acResident = null; retainEpoch++;
  const ans = ansTablesOf(model);
  const A_SMALL = AC_CODES, A_FREQS = A_SMALL + ans.ids * 256, A_STARTS = A_FREQS + ans.ids * 256, A_REVERSE = A_STARTS + ans.ids * 256;
  const A_CONFIGS = A_REVERSE + ans.ids * 8192, A_COUNTS = A_CONFIGS + ans.ids * 16, A_SYMBOL_STARTS = A_COUNTS + ans.ids * ans.alphabet * 4;
  const A_RECIPS = A_SYMBOL_STARTS + ans.ids * ans.alphabet * 4 + 7 & ~7, A_VALUES = A_RECIPS + RECIPS_BYTES, A_IDS = A_VALUES + n * 4;
  const A_RAWS = A_IDS + n + 8 & ~7, A_META = A_RAWS + n * 4, A_EMITTED = A_META + n + 8 & ~7, OUT = A_EMITTED + n * 2 + 8 & ~7, end = OUT + n * 8 + 16;
  if (end > engine.memory.buffer.byteLength) {
    if (values.buffer === engine.memory.buffer) values = values.slice(0, n);
    if (ids.buffer === engine.memory.buffer) ids = ids.slice(0, n);
    growArena(end);
  }
  const buffer = engine.memory.buffer, u8 = new Uint8Array(buffer), i32 = new Int32Array(buffer), u16 = new Uint16Array(buffer);
  if (ansStamp !== model) {
    i32.set(ans.small, A_SMALL >> 2); i32.set(ans.freqs, A_FREQS >> 2); i32.set(ans.starts, A_STARTS >> 2); u16.set(ans.reverse, A_REVERSE >> 1);
    i32.set(ans.configs, A_CONFIGS >> 2); i32.set(ans.counts, A_COUNTS >> 2); i32.set(ans.symbolStarts, A_SYMBOL_STARTS >> 2);
    i32.set(reciprocals(), A_RECIPS >> 2);
    ansStamp = model;
  }
  new Uint32Array(buffer).set(values.subarray(0, n), A_VALUES >> 2); u8.set(ids.subarray(0, n), A_IDS);
  const args = AC_CONFIGS + 4096 - 128;
  i32.set([A_VALUES, A_IDS, n, A_SMALL, A_FREQS, A_STARTS, A_REVERSE, A_CONFIGS, A_COUNTS, A_SYMBOL_STARTS, ans.alphabet,
    A_RAWS, A_META, A_EMITTED, OUT, w.acc, w.pending, 0, A_RECIPS], args >> 2);
  engine.simd.ansFlush(args);
  takeFlushed(w, args, OUT);
}
const entropyKernels = (SAMPLE || (typeof __RAPIER_JXL_CLI__ !== 'undefined' && __RAPIER_JXL_CLI__ === true)) ? null : () => jpegKernels((typeof __RAPIER_JXL_CAPTURE_PHOTO__ !== 'undefined' && __RAPIER_JXL_CAPTURE_PHOTO__ === true) ? null : flushTokens);
const takeFlushed = SAMPLE ? null : function takeFlushed(w, args, out) {
  const i32 = new Int32Array(engine.memory.buffer), written = i32[(args >> 2) + 17];
  if (w.at + written + 8 >= w.bytes.length) w.grow(written + 8);
  w.bytes.set(new Uint8Array(engine.memory.buffer, out, written), w.at);
  w.at += written; w.acc = i32[(args >> 2) + 15]; w.pending = i32[(args >> 2) + 16];
};
const loadPrefix = SAMPLE ? null : function loadPrefix(model, codes, alphabet) {
  const u8 = new Uint8Array(engine.memory.buffer), i32 = new Int32Array(engine.memory.buffer);
  u8.set(model.contextMap, AC_MAP);
  i32.fill(0, AC_CODES >> 2, (AC_CODES >> 2) + codes.length * alphabet * 2);
  for (let h = 0; h < codes.length; h++) {
    const {config, code} = codes[h];
    i32.set([config.splitToken, config.split, config.msb, config.lsb], (AC_CONFIGS >> 2) + h * 4);
    for (let s = 0; s < code.lengths.length; s++) { i32[(AC_CODES >> 2) + (h * alphabet + s) * 2] = code.lengths[s]; i32[(AC_CODES >> 2) + (h * alphabet + s) * 2 + 1] = code.codes[s]; }
  }
};
const takePrefix = SAMPLE ? null : function takePrefix(w, out) {
  const i32 = new Int32Array(engine.memory.buffer), written = i32[(AC >> 2) + 25];
  if (w.at + written + 8 >= w.bytes.length) w.grow(written + 8);
  w.bytes.set(new Uint8Array(engine.memory.buffer, out, written), w.at);
  w.at += written; w.acc = i32[(AC >> 2) + 23]; w.pending = i32[(AC >> 2) + 24];
};
let keptPool = null, keptScoped = false;
onCallEnd(() => { if (keptPool) keptPool.at = 0; }, () => {
  keptPool = null;
  if (active !== 'simd' || acDeferred || arenaLeased() || engine.memory.buffer.byteLength <= (4 << 20)) return;
  retireKernels(); engine = createEngine();
  if (vbBuffer) vbViews?.();
});
const keptScope = SAMPLE ? null : function keptScope(mode) {
  if (mode === 'enter') keptScoped = true;
  else if (mode === 'rewind') { if (keptPool) keptPool.at = 0; }
  else { keptScoped = false; keptPool = null; }
};
const keptTokens = SAMPLE ? null : function keptTokens(values, ctxs) {
  if (!inCall() && !keptScoped) return {values: values.slice(), ctxs: ctxs.slice()};
  const n = values.length;
  if (!keptPool) keptPool = {values: new Int32Array(Math.max(n, 1 << 16)), ctxs: new Uint16Array(Math.max(n, 1 << 16)), at: 0};
  else if (keptPool.at + n > keptPool.values.length) {
    const size = Math.max(keptPool.at + n, 2 * keptPool.values.length), grown = new Int32Array(size), grownCtxs = new Uint16Array(size);
    grown.set(keptPool.values.subarray(0, keptPool.at)); grownCtxs.set(keptPool.ctxs.subarray(0, keptPool.at));
    keptPool.values = grown; keptPool.ctxs = grownCtxs;
  }
  const pool = keptPool, at = pool.at;
  pool.values.set(values, at); pool.ctxs.set(ctxs, at); pool.at = at + n;
  return {get values() { return pool.values.subarray(at, at + n); }, get ctxs() { return pool.ctxs.subarray(at, at + n); }};
};
const acRowStart = SAMPLE ? null : function acRowStart({groupStarts, starts, segment}, counts, row, bx0, stride) {
  if (groupStarts) return groupStarts[row * Math.ceil(stride / 32) + bx0 / 32];
  const s0 = Math.floor(bx0 / segment);
  let from = starts[row * Math.ceil(stride / segment) + s0];
  for (let b = row * stride + s0 * segment; b < row * stride + bx0; b++) from += counts[b];
  return from;
};
const AC_ROWS_ROOM = 368 * 65536;
const acGroupRow = SAMPLE ? null : function acGroupRow(comps, source, by0, xsizeBlocks, ysizeBlocks, stride, at) {
  const kept = acResident?.held;
  if (kept && kept.offs >= at && kept.by0 === by0 && kept.stride === stride && kept.packs.every((p, c) => p === comps[c].packed) && kept.counts.every((s, c) => s === source[c])) return kept;
  const AC_ROWS_AT = at + 256;
  const rows = Math.min(32, ysizeBlocks - by0), groups = Math.ceil(stride / 32), across = Math.ceil(xsizeBlocks / 32);
  const lows = new Int32Array(3 * rows), highs = new Int32Array(3 * rows);
  for (let c = 0; c < 3; c++) {
    const packed = comps[c].packed, counts = source[c], gs = packed.groupStarts, seg = packed.segment;
    for (let y = 0; y < rows; y++) {
      const row = by0 + y, rowOff = row * stride, gsRow = gs ? row * groups : 0;
      let low = 0x7fffffff, high = 0;
      for (let g = 0; g < across; g++) {
        const bx0 = g * 32, start = gs ? gs[gsRow + g] : acRowStart(packed, counts, row, bx0, stride);
        let end;
        if (gs && g + 1 < across && ((bx0 + 32) % seg) !== 0) end = gs[gsRow + g + 1];
        else {
          end = start;
          const first = rowOff + bx0, stop = first + Math.min(32, xsizeBlocks - bx0);
          for (let b = first; b < stop; b++) end += counts[b];
        }
        if (start < low) low = start;
        if (end > high) high = end;
      }
      lows[c * rows + y] = low; highs[c * rows + y] = high;
    }
  }
  const size = (c, y0, y1) => { const n = highs[c * rows + y1 - 1] - lows[c * rows + y0]; return (n + 15 & ~15) + (2 * n + 15 & ~15) + ((y1 - y0) * stride + 15 & ~15); };
  const room = AC_ROWS_ROOM - 256, chunks = [[], [], []], whole = size(0, 0, rows) + size(1, 0, rows) + size(2, 0, rows) <= room;
  let next = AC_ROWS_AT;
  for (let c = 0; c < 3; c++) for (let y0 = 0; y0 < rows;) {
    let y1 = rows;
    while (y1 - y0 > 1 && size(c, y0, y1) > room) y1 = y0 + (y1 - y0 >> 1);
    const from = lows[c * rows + y0], to = highs[c * rows + y1 - 1], n = to - from, base = whole ? next : AC_ROWS_AT;
    const chunk = {y0, y1, from, to, at: base, val: base + (n + 15 & ~15), cnt: base + (n + 15 & ~15) + (2 * n + 15 & ~15), loaded: false};
    if (whole) next += size(c, y0, y1);
    chunks[c].push(chunk); y0 = y1;
  }
  const need = whole ? next : AC_ROWS_AT + Math.max(...chunks.flat().map(k => k.cnt - k.at + (k.y1 - k.y0) * stride)) + 16;
  if (need > engine.memory.buffer.byteLength) growArena(need);
  return {by0, stride, packs: comps.map(cp => cp.packed), counts: [source[0], source[1], source[2]], chunks, whole, offs: at, current: null};
};
const acRowsHeld = SAMPLE ? null : function acRowsHeld(held, chunk, packed, counts, stride) {
  if (held.whole ? chunk.loaded : held.current === chunk) return;
  const buffer = engine.memory.buffer;
  new Uint8Array(buffer).set(packed.at.subarray(chunk.from, chunk.to), chunk.at);
  new Int16Array(buffer).set(packed.levels.subarray(chunk.from, chunk.to), chunk.val >> 1);
  new Uint8Array(buffer).set(counts.subarray((held.by0 + chunk.y0) * stride, (held.by0 + chunk.y1) * stride), chunk.cnt);
  chunk.loaded = true; held.current = chunk;
};
const acGroup = SAMPLE ? null : function acGroup(state, g, pass, sink, zd, pair = null) {
  retainEpoch++;
  const {authoredOrderPasses, groupsX, strategyData, progression, contexts, lumaBuckets, lumaW, xsizeBlocks, ysizeBlocks, comps, grey,
    orders, counted, blockCounts, nonZero, hshifts, vshifts} = state;
  if (active !== 'simd' || strategyData || progression || authoredOrderPasses?.[pass] || grey || (!nonZero && (!counted || !entropyAllowed)) ||
      hshifts.some(Boolean) || vshifts.some(Boolean) || comps.some(comp => !(comp.coeffs instanceof Int16Array || !comp.coeffs && comp.packed?.starts)) ||
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
  const packed = !comps[0].coeffs;
  if (packed && !nonZero) return false;
  if (!nonZero) {
    if (bw < 1 || bh < 1 || !Number.isInteger(stride) || stride < bx0 + bw ||
        !Number.isInteger(contexts.numDc) || contexts.numDc < 1 || contexts.numDc > 16 ||
        !Number.isInteger(contexts.numCtxs) || contexts.numCtxs < 1 || contexts.numCtxs > 16 || zd.length !== 4096) return false;
    const end = (by0 + bh - 1) * stride + bx0 + bw;
    for (let c = 0; c < 3; c++) {
      if (comps[c].stride !== stride || comps[c].coeffs.length < end * 64 ||
          !(source[c] instanceof Uint8Array) || source[c].length < end || orders[c].length !== 64) return false;
      for (const k of orders[c]) if (!Number.isInteger(k) || k < 0 || k > 63) return false;
      for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) if (source[c][(by0 + y) * stride + bx0 + x] > 63) return false;
    }
  }
  const tokens = 3 * blocks * 64;
  const histBytes = contexts.contexts * 256, HIST = AC_CODES + Math.max(8, codes ? codes.length * alphabet * 8 : 8);
  const defer = !!(sink.counts && sink.defer);
  if (acDeferred && (!defer || acDeferred.counts !== sink.counts || acDeferred.hist !== HIST_KEY(contexts))) throw fault('JXL_INTERNAL', 'kernels:ac-counts-missing');
  let TOUCHED = HIST + histBytes, OVERFLOW = TOUCHED + (defer ? Math.max(tokens * 4, histBytes) : tokens * 4), OUT = OVERFLOW + tokens * 8, end = OUT + tokens * 8 + 16;
  const stage = () => end + 15 & ~15;
  let A_SMALL, A_FREQS, A_STARTS, A_REVERSE, A_CONFIGS, A_COUNTS, A_SYMBOL_STARTS, A_RECIPS, A_VALUES, A_IDS, A_RAWS, A_META, A_EMITTED;
  if (ans) {
    A_SMALL = AC_CODES; A_FREQS = A_SMALL + ans.ids * 256; A_STARTS = A_FREQS + ans.ids * 256; A_REVERSE = A_STARTS + ans.ids * 256;
    A_CONFIGS = A_REVERSE + ans.ids * 8192; A_COUNTS = A_CONFIGS + ans.ids * 16; A_SYMBOL_STARTS = A_COUNTS + ans.ids * ans.alphabet * 4;
    A_RECIPS = A_SYMBOL_STARTS + ans.ids * ans.alphabet * 4 + 7 & ~7; A_VALUES = A_RECIPS + RECIPS_BYTES; A_IDS = A_VALUES + tokens * 4; A_RAWS = A_IDS + tokens + 8 & ~7;
    A_META = A_RAWS + tokens * 4; A_EMITTED = A_META + tokens + 8 & ~7; OUT = A_EMITTED + tokens * 2 + 8 & ~7; end = OUT + tokens * 8 + 16;
  }
  const STAGE_AT = packed ? stage() : 0, STAGE_VAL = STAGE_AT + tokens;
  if (packed) end = STAGE_VAL + 2 * tokens;
  const held = packed && !(ans && sink.kept) ? acGroupRow(comps, source, by0, xsizeBlocks, ysizeBlocks, stride,
    (pair && ans ? Math.max(end, parkAt(A_VALUES) + 20 * tokens + 64) : end) + 15 & ~15) : null;
  if (end > engine.memory.buffer.byteLength) growArena(end);
  const buffer = engine.memory.buffer, u8 = new Uint8Array(buffer), i32 = new Int32Array(buffer), i16 = new Int16Array(buffer), u16 = new Uint16Array(buffer);
  if (!sink.counts) acClean = false;
  else {
    if (!acClean || acCleanBytes < histBytes) {
      if (acDeferred) throw fault('JXL_INTERNAL', 'kernels:ac-counts-zeroing');
      u8.fill(0, HIST, HIST + histBytes); acClean = true;
    }
    acCleanBytes = histBytes;
  }
  if (!ans) ansStamp = null;
  else if (ansStamp !== sink.coding.model) {
    i32.set(ans.small, A_SMALL >> 2); i32.set(ans.freqs, A_FREQS >> 2); i32.set(ans.starts, A_STARTS >> 2); u16.set(ans.reverse, A_REVERSE >> 1);
    i32.set(ans.configs, A_CONFIGS >> 2); i32.set(ans.counts, A_COUNTS >> 2); i32.set(ans.symbolStarts, A_SYMBOL_STARTS >> 2);
    i32.set(reciprocals(), A_RECIPS >> 2);
    ansStamp = sink.coding.model;
  }
  const kept = ans ? sink.kept ?? null : null, keep = !!(sink.counts && sink.keep);
  if (kept) {
    if (!(kept.values instanceof Int32Array) || !(kept.ctxs instanceof Uint16Array) || kept.values.length !== kept.ctxs.length || kept.values.length > tokens) return false;
    acResident = null;
    u8.set(sink.coding.model.contextMap, AC_MAP);
    i32.set(kept.values, A_VALUES >> 2); u16.set(kept.ctxs, A_RAWS >> 1);
    engine.simd.ctxIds(A_RAWS, A_IDS, kept.values.length, AC_MAP);
  } else {
  const c0 = acIdentity(comps[0].coeffs ?? comps[0].packed), c1 = acIdentity(comps[1].coeffs ?? comps[1].packed), c2 = acIdentity(comps[2].coeffs ?? comps[2].packed);
  const s0 = acIdentity(source[0]), s1 = acIdentity(source[1]), s2 = acIdentity(source[2]);
  const sameGroup = acResident && acResident.g === g && acResident.bw === bw && acResident.bh === bh &&
    acResident.c0 === c0 && acResident.c1 === c1 && acResident.c2 === c2 &&
    acResident.s0 === s0 && acResident.s1 === s1 && acResident.s2 === s2;
  let staged = 0;
  for (let c = 0; c < 3; c++) {
    if (!sameGroup && packed) {
      for (const chunk of held.chunks[c]) {
        acRowsHeld(held, chunk, comps[c].packed, source[c], stride);
        const words = new Int32Array(engine.memory.buffer), rows = Math.min(chunk.y1, bh) - chunk.y0;
        if (rows <= 0) continue;
        for (let y = 0; y < rows; y++) words[(held.offs >> 2) + y] = acRowStart(comps[c].packed, source[c], by0 + chunk.y0 + y, bx0, stride) - chunk.from;
        staged += engine.simd.stageRows(chunk.at, chunk.val, chunk.cnt, held.offs, bw, rows, stride, bx0, STAGE_AT + staged, STAGE_VAL + 2 * staged, AC_COUNTS + c * blocks + chunk.y0 * bw);
      }
    } else if (!sameGroup) {
      const coeffs = comps[c].coeffs, counts = source[c];
      for (let y = 0; y < bh; y++) {
        const at = (by0 + y) * stride + bx0;
        i16.set(coeffs.subarray(at * 64, (at + bw) * 64), (AC_COEFFS + c * AC_STRIDE + y * bw * 128) >> 1);
        u8.set(counts.subarray(at, at + bw), AC_COUNTS + c * blocks + y * bw);
        if (!counted && blockCounts[c] !== nonZero[c]) blockCounts[c].set(nonZero[c].subarray(at, at + bw), at);
      }
    } else if (!counted && blockCounts[c] !== nonZero[c]) {
      for (let y = 0; y < bh; y++) {
        const at = (by0 + y) * stride + bx0;
        blockCounts[c].set(nonZero[c].subarray(at, at + bw), at);
      }
    }
    const ord = orders[c];
    for (let k = 0; k < 64; k++) u8[AC_ORDERS + c * 64 + k] = ord[k];
    for (let b = 0; b < contexts.numDc; b++) i32[(AC_BLOCK_CTX >> 2) + c * contexts.numDc + b] = contexts.contextOf(c, b);
  }
  if (!sameGroup && packed) engine.simd.unpackGroup(AC_COEFFS, AC_STRIDE, bw, bh, AC_COUNTS, STAGE_AT, STAGE_VAL);
  acResident = {g, bw, bh, c0, c1, c2, s0, s1, s2, held: held ?? (sameGroup ? acResident.held : null)};
  if (contexts.thresholds.length) {
    acBucketsZero = false;
    for (let y = 0; y < bh; y++) {
      const row = (by0 + y) * lumaW + bx0;
      u8.set(lumaBuckets.subarray(row, row + bw), AC_BUCKETS + y * bw);
    }
  } else if (!acBucketsZero) {
    u8.fill(0, AC_BUCKETS, AC_BUCKETS + 1024);
    acBucketsZero = true;
  }
  if (!zdLoaded) { u16.set(zd, AC_ZD >> 1); zdLoaded = true; }
  if (ans) u8.set(sink.coding.model.contextMap, AC_MAP);
  if (codes) loadPrefix(sink.coding.model, codes, alphabet);
  i32.set([AC_COEFFS, AC_STRIDE, bw, bh, AC_COUNTS, AC_BUCKETS, AC_BLOCK_CTX, contexts.numDc, contexts.numCtxs, AC_ORDERS, AC_ZD, AC_NZ,
    ans ? 2 : codes ? 1 : keep ? 3 : 0, HIST, TOUCHED + 4 * (acDeferred?.touched ?? 0), OVERFLOW, 0, 0, AC_MAP, AC_CONFIGS, AC_CODES, alphabet, OUT, w ? w.acc : 0, w ? w.pending : 0, 0,
    ans ? A_VALUES : keep ? OUT : 0, ans ? A_IDS : keep ? OUT + tokens * 4 : 0, 0], AC >> 2);
  engine.simd.acGroup(AC);
  if (keep) { const n = i32[(AC >> 2) + 28]; sink.kept = keptTokens(i32.subarray(OUT >> 2, (OUT >> 2) + n), u16.subarray((OUT + tokens * 4) >> 1, ((OUT + tokens * 4) >> 1) + n)); }
  }
  if (ans) {
    const args = AC_CONFIGS + 4096 - 128, n = kept ? kept.values.length : i32[(AC >> 2) + 28];
    const tables = [A_SMALL, A_FREQS, A_STARTS, A_REVERSE, A_CONFIGS, A_COUNTS, A_SYMBOL_STARTS, ans.alphabet];
    if (pair && !pair.args) {
      const park = parkAt(A_VALUES), P_IDS = park + n * 4, P_RAWS = P_IDS + n + 8 & ~7, P_META = P_RAWS + n * 4;
      const P_EMITTED = P_META + n + 8 & ~7, P_OUT = P_EMITTED + n * 2 + 8 & ~7, P_END = P_OUT + n * 8 + 16;
      if (P_END > 272 * 65536) return false;
      if (P_END > engine.memory.buffer.byteLength) growArena(P_END);
      const bytes = new Uint8Array(engine.memory.buffer);
      bytes.copyWithin(park, A_VALUES, A_VALUES + n * 4); bytes.copyWithin(P_IDS, A_IDS, A_IDS + n);
      pair.args = [park, P_IDS, n, ...tables, P_RAWS, P_META, P_EMITTED, P_OUT, w.acc, w.pending, 0, A_RECIPS];
      pair.w = w; pair.out = P_OUT; pair.model = sink.coding.model;
      return 3;
    }
    i32.set([A_VALUES, A_IDS, n, ...tables, A_RAWS, A_META, A_EMITTED, OUT, w.acc, w.pending, 0, A_RECIPS], args >> 2);
    if (pair) {
      if (pair.model !== sink.coding.model) throw fault('JXL_INTERNAL', 'kernels:ac-group-model');
      const first = AC_CONFIGS + 4096 - 256;
      i32.set(pair.args, first >> 2);
      engine.simd.ansFlush2(first, args);
      takeFlushed(pair.w, first, pair.out); takeFlushed(w, args, OUT);
      return 2;
    }
    engine.simd.ansFlush(args);
    const written = i32[(args >> 2) + 17];
    if (w.at + written + 8 >= w.bytes.length) w.grow(written + 8);
    w.bytes.set(u8.subarray(OUT, OUT + written), w.at);
    w.at += written; w.acc = i32[(args >> 2) + 15]; w.pending = i32[(args >> 2) + 16];
    return 2;
  }
  if (codes) { takePrefix(w, OUT); return true; }
  const counts = sink.counts, touched = i32[(AC >> 2) + 16], overflow = i32[(AC >> 2) + 17];
  if (defer) acDeferred = {counts, hist: HIST_KEY(contexts), at: HIST, list: TOUCHED, bytes: histBytes, touched: (acDeferred?.touched ?? 0) + touched};
  else takeCounts(counts, HIST, TOUCHED, touched, histBytes);
  for (let i = 0; i < overflow; i++) counts.add(i32[(OVERFLOW >> 2) + 2 * i], i32[(OVERFLOW >> 2) + 2 * i + 1]);
  return true;
}
const takeCounts = SAMPLE ? null : function takeCounts(counts, at, list, touched, bytes) {
  const i32 = new Int32Array(engine.memory.buffer), hist = new Uint32Array(engine.memory.buffer, at, bytes >> 2);
  for (let i = 0; i < touched; i++) {
    const index = i32[(list >> 2) + i], n = hist[index];
    counts.small[index] += n; counts.totals[index >> 6] += n; hist[index] = 0;
  }
}
const deferredCounts = SAMPLE || JPEG ? null : function deferredCounts() {
  if (!acDeferred) return;
  const {counts, at, list, touched, bytes} = acDeferred;
  acDeferred = null;
  if (!acClean) throw fault('JXL_INTERNAL', 'kernels:ac-counts-release');
  takeCounts(counts, at, list, touched, bytes);
}


const GE_PLANE = P, GE_COUNTS = P + 131072, GE_TOUCHED = GE_COUNTS + 4 * (131072 + 33) + 12, GE_STATS = GE_TOUCHED + 4 * 65536;
const dcEvents = SAMPLE ? null : function dcEvents(planes) {
  if (active !== 'simd' || planes.some(p => !(p.data instanceof Int16Array) || !(p.w > 0 && p.h > 0) || p.w * p.h > 65536 || p.data.length < p.w * p.h)) return null;
  acClean = false; ansStamp = null; zdLoaded = false; acBucketsZero = false; tileBand = null; acResident = null; retainEpoch++;
  const buffer = engine.memory.buffer, i16 = new Int16Array(buffer), u32 = new Uint32Array(buffer);
  return planes.map(({data, w, h}) => {
    u32.fill(0, GE_COUNTS >> 2, (GE_COUNTS >> 2) + 131072 + 33);
    i16.set(data.subarray(0, w * h), GE_PLANE >> 1);
    engine.simd.gradEvents(GE_PLANE, w, h, GE_COUNTS, GE_TOUCHED, GE_STATS, 0, 0, 0, 0, 0);
    const touched = u32[(GE_STATS >> 2) + 2], literalPairs = new Uint32Array(2 * touched);
    for (let i = 0; i < touched; i++) { const v = u32[(GE_TOUCHED >> 2) + i]; literalPairs[2 * i] = v; literalPairs[2 * i + 1] = u32[(GE_COUNTS >> 2) + v]; }
    return {literalPairs, literalPairsLen: 2 * touched, lengths: u32.slice((GE_COUNTS >> 2) + 131072, (GE_COUNTS >> 2) + 131072 + 33)};
  });
}

const GE_TAGS = GE_STATS + 16, GE_EXTRA = GE_TAGS + 4 * 65536, GE_FREQ = GE_EXTRA + 4 * 65536;
const GE_WIDE = GE_FREQ + 4 * ALPHABET + 15 & ~15, GE_HASH = GE_WIDE + 4 * 65536, GE_END = GE_HASH + 8 * 131072;
const geCount = (u32, v) => {
  if (v < 131072) return u32[(GE_COUNTS >> 2) + v];
  for (let s = Math.imul(v, 0x9e3779b1) >>> 15; ; s = s + 1 & 131071) if (u32[(GE_HASH >> 2) + 2 * s] === v) return u32[(GE_HASH >> 2) + 2 * s + 1];
};
const dcPlan = SAMPLE ? null : function dcPlan(data, w, h, freq) {
  if (active !== 'simd' || !(data instanceof Int16Array || data instanceof Int32Array) || !(w > 0 && h > 0) || w * h > 65536 || data.length < w * h || freq.length !== ALPHABET) return null;
  const n = w * h;
  let lo = data[0], hi = data[0];
  for (let i = 1; i < n; i++) { const v = data[i]; if (v < lo) lo = v; else if (v > hi) hi = v; }
  const wide = lo < -32768 || hi > 32767 ? 1 : 0;
  acClean = false; ansStamp = null; zdLoaded = false; acBucketsZero = false; tileBand = null; acResident = null; retainEpoch++;
  if (wide && GE_END > engine.memory.buffer.byteLength) {
    if (data.buffer === engine.memory.buffer) data = data.slice(0, n);
    growArena(GE_END);
  }
  const buffer = engine.memory.buffer, i16 = new Int16Array(buffer), u32 = new Uint32Array(buffer);
  const values = wide ? 131072 : Math.min(131072, Math.max(2 * (hi - lo), 2 * Math.abs(data[0])) + 2);
  u32.fill(0, GE_COUNTS >> 2, (GE_COUNTS >> 2) + values);
  u32.fill(0, (GE_COUNTS >> 2) + 131072, (GE_COUNTS >> 2) + 131072 + 33);
  u32.fill(0, GE_FREQ >> 2, (GE_FREQ >> 2) + ALPHABET);
  if (wide) { u32.fill(0, GE_HASH >> 2, GE_END >> 2); new Int32Array(buffer, GE_WIDE, n).set(data.subarray(0, n)); }
  else i16.set(data.subarray(0, n), GE_PLANE >> 1);
  engine.simd.gradEvents(wide ? GE_WIDE : GE_PLANE, w, h, GE_COUNTS, GE_TOUCHED, GE_STATS, GE_TAGS, GE_EXTRA, GE_FREQ, wide, GE_HASH);
  const touched = u32[(GE_STATS >> 2) + 2], used = u32[(GE_STATS >> 2) + 3], literalPairs = new Uint32Array(2 * touched);
  let p = 0;
  for (let pass = 0; pass < 2; pass++) for (let i = 0; i < touched; i++) {
    const v = u32[(GE_TOUCHED >> 2) + i];
    if ((v < 4096) === !pass) { literalPairs[p++] = v; literalPairs[p++] = geCount(u32, v); }
  }
  for (let s = 0; s < ALPHABET; s++) freq[s] += u32[(GE_FREQ >> 2) + s];
  return {tags: u32.slice(GE_TAGS >> 2, (GE_TAGS >> 2) + used), extra: u32.slice(GE_EXTRA >> 2, (GE_EXTRA >> 2) + used), used,
    literalPairs, literalPairsLen: p, lengths: u32.slice((GE_COUNTS >> 2) + 131072, (GE_COUNTS >> 2) + 131072 + 33)};
}

const planTokens = SAMPLE ? null : function planTokens(plan, config) {
  const {tags, extra, used} = plan;
  if (active !== 'simd' || !(tags instanceof Uint32Array) || !(extra instanceof Uint32Array) || !Number.isInteger(used) || used < 0 ||
      used > 65536 || tags.length < used || extra.length < used || !(config.split >= 0 && config.split <= 30) ||
      config.splitToken !== 2 ** config.split || !(config.msb >= 0 && config.lsb >= 0 && config.msb + config.lsb <= config.split)) return false;
  acClean = false; ansStamp = null; zdLoaded = false; acBucketsZero = false; tileBand = null; acResident = null; retainEpoch++;
  const buffer = engine.memory.buffer, u32 = new Uint32Array(buffer), i32 = new Int32Array(buffer);
  u32.set(tags.subarray(0, used), HP_TAGS >> 2); u32.set(extra.subarray(0, used), HP_EXTRA >> 2);
  i32.set([config.splitToken, config.split, config.msb, config.lsb], HP_CFGS >> 2);
  engine.simd.hpTokens(HP_TAGS, HP_EXTRA, used, HP_CFGS);
  tags.set(u32.subarray(HP_TAGS >> 2, (HP_TAGS >> 2) + used)); extra.set(u32.subarray(HP_EXTRA >> 2, (HP_EXTRA >> 2) + used));
  return true;
}

const HP_TAGS = P, HP_EXTRA = P + 262144, HP_CFGS = P + 526336;

let shapeEpoch = -1, shapeTables = null;
const shape = SAMPLE ? null : function shape(freqs, last, total, omit, tables, headerAware) {
  if (active !== 'simd' || !(last >= 3 && last <= 512) || !(total >= 1 && total <= 0xffffffff) || !(omit >= 0 && omit < last) || freqs.length < last) return null;
  const buffer = engine.memory.buffer, i32 = new Int32Array(buffer), u32 = new Uint32Array(buffer), f64 = new Float64Array(buffer);
  if (shapeEpoch !== retainEpoch || shapeTables !== tables) {
    f64.set(tables.log2, SH_LOG2 >> 3); f64.set(tables.symbolBits, SH_SYM >> 3);
    i32.set(tables.logLengths, SH_LOGLEN >> 2); i32.set(tables.repeats, SH_REPEATS >> 2);
    shapeTables = tables;
  }
  acClean = false; ansStamp = null; zdLoaded = false; acBucketsZero = false; tileBand = null; acResident = null; shapeEpoch = ++retainEpoch;
  for (let i = 0; i < last; i++) u32[(SH_FREQS >> 2) + i] = freqs[i];
  i32.set([SH_FREQS, last, total, omit, SH_LOG2, SH_SYM, SH_LOGLEN, SH_REPEATS, SH_SCRATCH, 0, 0, 0, headerAware ? 1 : 0], SH_ARGS >> 2);
  engine.simd.shape(SH_ARGS);
  const shift = i32[(SH_ARGS >> 2) + 9];
  if (shift < 0) return {none: true};
  return {counts: Uint16Array.from(i32.subarray(SH_BEST >> 2, (SH_BEST >> 2) + last)), shift, omit, bits: f64[(SH_ARGS + 40) >> 3]};
}


const opaqueBytes = SAMPLE || JPEG ? null : function opaqueBytes(rgba, samples = null) {
  if (active !== 'simd') return undefined;
  acClean = false; ansStamp = null; zdLoaded = false; acBucketsZero = false; tileBand = null; acResident = null; retainEpoch++;
  if (rgba instanceof Uint8Array || rgba instanceof Uint8ClampedArray) {
    const band = R - P;
    for (let at = 0; at < rgba.length; at += band) {
      const n = Math.min(band, rgba.length - at);
      engine.u8.set(rgba.subarray(at, at + n), P);
      if (!engine.simd.opaque(P, n)) return false;
    }
    return true;
  }
  const f16 = typeof Float16Array === 'function' && rgba instanceof Float16Array;
  const mode = rgba instanceof Float32Array ? 2 : (rgba instanceof Uint16Array || f16) ? 1 : 0;
  if (!mode) return undefined;
  const one = mode === 2 ? 0x3f800000 : samples?.exponentBits === 5 ? 0x3c00 : (1 << (samples?.bitDepth ?? 16)) - 1;
  const bytes = new Uint8Array(rgba.buffer, rgba.byteOffset, rgba.byteLength), band = (R - P - 16) & ~15;
  engine.i32[P >> 2] = one;
  for (let at = 0; at < bytes.length; at += band) {
    const n = Math.min(band, bytes.length - at);
    engine.u8.set(bytes.subarray(at, at + n), P + 4);
    if (!engine.simd.opaque(P + 4, n | mode)) return false;
  }
  return true;
};

const captureOpaque = SAMPLE || JPEG ? null : function captureOpaque(data, width, x, y, w, h) {
  for (let row = y, rows = w === width ? h : 1; row < y + h; row += rows) {
    const at = (row * width + x) * 4, opaque = opaqueBytes(data.subarray(at, at + rows * w * 4));
    if (opaque === undefined) throw fault('JXL_WASM', 'photo: SIMD kernels');
    if (!opaque) return false;
  }
  return true;
};

const nonzero = SAMPLE ? null : function nonzero(coeffs, from, end, natural) {
  if (active !== 'simd' || !(coeffs instanceof Int16Array) || from % 64 || (end - from) % 64) return false;
  acClean = false; ansStamp = null; zdLoaded = false; acBucketsZero = false; tileBand = null; acResident = null; retainEpoch++;
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

const group = SAMPLE || JPEG ? null : function group(w, targets, rgba, imageWidth, x0, y0, width, height, setup) {
  acClean = false; ansStamp = null; zdLoaded = false; acBucketsZero = false; tileBand = null; acResident = null; retainEpoch++;
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
  const {u8, i32, simd} = engine, backend = simd;
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
      simd.tokens(R, 0, n, TABLE + c * RAW_BINS * 4, OUTPUT, 0, 0, 0, config.split, config.msb, config.lsb, targets[c].length);
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

const screen = SAMPLE || JPEG ? null : function screen(plane, width, height, predictor, depth, emit, minLength = 7) {
  acClean = false; ansStamp = null; zdLoaded = false; acBucketsZero = false; tileBand = null; acResident = null; retainEpoch++;
  const n = width * height;
  if (!(plane instanceof Int16Array || plane instanceof Int32Array) || !Number.isInteger(width) || !Number.isInteger(height) ||
      width < 1 || height < 1 || plane.length < n ||
      ![0, 1, 2, 3, 5].includes(predictor) || ![4, 7].includes(minLength) || !Number.isInteger(depth) || depth < 0 || depth > 2147483647) return false;
  const residual = P + n * 4, output = P + n * 8, head = P + n * 16, rows = head + 262144,
    map = rows + height * 4, capacity = 1 << (32 - Math.clz32(height * 2 - 1)), needed = map + capacity * 8;
  if (needed > engine.memory.buffer.byteLength) growArena(needed);
  const {i32} = engine, backend = engine.simd;
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

const align8 = n => Math.ceil(n / 8) * 8;
const RETAIN_BUDGET = 64 * 1048576;
let residentTree = 0, trees = 0;
const UNSPLIT = SAMPLE ? null : Object.freeze({live: () => true, peak: 0, allocate: () => null, release() {}, propose: (members, histograms, choiceBits, keep = null) => { if (keep) keep.handle = null; return null; }});
const sampled = SAMPLE ? null : function sampled(count, kinds, alphabet, columns, symbolSets, table, rawPrice) {
  if (!engine || !Number.isSafeInteger(count) || count < 0 || !kinds || kinds > 16 || symbolSets.length !== kinds ||
      !Number.isInteger(alphabet) || alphabet < 1 || alphabet > 256 || !(table instanceof Float64Array) || table.length < count + 1 ||
      !(rawPrice instanceof Float64Array) || rawPrice.length !== alphabet) return null;
  if (symbolSets.some(s => !(s instanceof Uint8Array) || s.length !== count)) return null;
  let maxCuts = 0;
  for (const column of columns) {
    const cuts = column.cuts.length;
    if (!(column.indices instanceof Uint8Array) || column.indices.length !== count || cuts > 255) return null;
    maxCuts = Math.max(maxCuts, cuts);
  }
  if (count < 64 || !maxCuts) return {...UNSPLIT, rootHistograms() {
    arena(); retainEpoch++;
    const {memory, simd} = engine, band = 32768, binsAt = P + band;
    const u8 = new Uint8Array(memory.buffer), i32 = new Int32Array(memory.buffer);
    return symbolSets.map(symbols => {
      const bins = i32.subarray(binsAt >>> 2, (binsAt >>> 2) + 256);
      bins.fill(0);
      for (let at = 0; at < count; at += band) {
        const part = symbols.subarray(at, at + band);
        u8.set(part, P);
        simd.bytesMax(P, part.length, binsAt);
      }
      return Uint32Array.from(bins.subarray(0, alphabet));
    });
  }};
  const align16 = n => Math.ceil(n / 16) * 16;
  const C = columns.length, bins = maxCuts + 1, cells = kinds * alphabet, histBytes = align8(cells * 4);
  const resSym = align16(P), resIdx = resSym + 16 * count, cutsAt = align8(resIdx + C * count), tableAt = align8(cutsAt + C * 4);
  const rawAt = tableAt + (count + 1) * 8, membersAt = align8(rawAt + alphabet * 8), arenaMembersAt = align8(membersAt + count * 4);
  const symbolsAt = align16(arenaMembersAt + count * 4);
  const lowAt = symbolsAt, highAt = lowAt + count * 4;
  const indicesAt = align16(symbolsAt + 16 * count), histAt = align8(indicesAt + count), outAt = align8(histAt + cells * 4);
  const scratch = align16(outAt + 64 + kinds * 32 + kinds * 4);
  const stateBytes = kinds * 32 + align16(cells * 4);
  const splitAt = align8(scratch + stateBytes + align16(bins * cells * 4) + (2 * bins + 2) * 4);
  const clMetaAt = align8(splitAt + cells * 8), clFreqAt = clMetaAt + 256 * 24, clParamsAt = clFreqAt + 256 * alphabet * 4;
  const clPropMetaAt = clParamsAt + 64, clNzValAt = clPropMetaAt + 36 * 32, clNzSymAt = clNzValAt + 36 * alphabet * 4;
  const histPoolAt = align16(CLUSTERED_TREES ? clNzSymAt + 36 * alphabet : clMetaAt);
  let arenaSlots = 0, needed = histPoolAt;
  let blockBytes = 0;
  columns.forEach(column => { blockBytes += column.cuts.length ? (column.cuts.length + 1) * cells * 4 : 0; });
  const id = ++trees, slots = Math.floor(RETAIN_BUDGET / blockBytes);
  let base = Math.ceil(needed / 64) * 64;
  let epoch = -1, generation = 0, free = [], siblingSlot = 0, siblingBusy = false, peak = 0, clusterEpoch = -1, lastSplitProp = null;
  let freeHistSlots = [], identityMembers = false, cachedBuf = null, cachedF64 = null, cachedU32 = null;
  const syncViews = () => {
    if (cachedBuf !== engine.memory.buffer) {
      cachedBuf = engine.memory.buffer;
      cachedF64 = new Float64Array(cachedBuf);
      cachedU32 = new Uint32Array(cachedBuf);
    }
  };
  const reserve = end => {
    if (end <= engine.memory.buffer.byteLength) return true;
    return tryGrowArena(end);
  };
  const ensureLive = () => {
    if (tree.live()) return;
    if (!reserve(needed)) throw fault('JXL_MEMORY', 'learned tree: grow failed');
    if (engine.u8.buffer !== engine.memory.buffer) { engine.u8 = new Uint8Array(engine.memory.buffer); engine.i32 = new Int32Array(engine.memory.buffer); }
    const {u8, i32} = engine, f64 = new Float64Array(engine.memory.buffer);
    for (let c = 0; c < kinds; c++) u8.set(symbolSets[c], symbolsAt + c * count);
    for (let k = 0; k < C; k++) { u8.set(columns[k].indices, resIdx + k * count); i32[(cutsAt >>> 2) + k] = columns[k].cuts.length; }
    if (engine.simd.bytesMax(symbolsAt, kinds * count, 0) >= alphabet || columns.some((column, k) => engine.simd.bytesMax(resIdx + k * count, count, 0) > column.cuts.length)) throw declined('sampled');
    engine.simd.sampledSplit(resSym, symbolsAt, count, 0, 0, kinds, 0, -1, 0, 0, 0, 0, 0, 0);
    f64.set(table.subarray(0, count + 1), tableAt >>> 3); f64.set(rawPrice, rawAt >>> 3);
    residentTree = id; epoch = retainEpoch; generation++; clusterEpoch = -1; lastSplitProp = null;
    if (slots >= 2) {
      siblingSlot = base;
      siblingBusy = false;
      free = Array.from({length: slots - 1}, (_, s) => base + (slots - 1 - s) * blockBytes);
    } else {
      siblingSlot = 0; siblingBusy = false;
      free = Array.from({length: slots}, (_, s) => base + (slots - 1 - s) * blockBytes);
    }
  };
  const writeStatEntry = (i32, f64, u8, idx, st, nzCursor) => {
    const m32 = (clPropMetaAt >>> 2) + idx * 8, m64 = (clPropMetaAt >>> 3) + idx * 4;
    f64[m64] = st.bits; f64[m64 + 1] = st.raw;
    const len = st.nzSym.length;
    i32[m32 + 4] = st.total; i32[m32 + 5] = st.used; i32[m32 + 6] = nzCursor; i32[m32 + 7] = len;
    if (len) {
      u8.set(st.nzSym, clNzSymAt + nzCursor);
      i32.set(st.nzVal, (clNzValAt >>> 2) + nzCursor);
    }
    return nzCursor + len;
  };
  function sweep(nodeMembers, total, nodeHist, parent, sibling, saved, sides, limit) {
    return engine.simd.sampledNode(resSym, resIdx, count, nodeMembers, total, kinds, alphabet, C, cutsAt, nodeHist, tableAt, rawAt,
      symbolsAt, indicesAt, scratch, outAt, parent, sibling, saved, sides, limit);
  }
  function searchNode(nodeMembers, total, nodeHist, keep, residentNode, limit) {
    if (keep) keep.handle = null;
    const parent = keep?.parent, sibling = keep?.sibling;
    const derive = parent?.generation === generation && (sibling?.generation === generation || residentNode && !sibling);
    let save = !!keep?.save && slots > 0;
    if (save && !derive && !(residentNode && keep.transient)) {
      for (const column of columns) if (column.cuts.length && total * 4 <= (column.cuts.length + 1) * alphabet) { save = false; break; }
    }
    const inherited = save && derive && keep.reuseParent && !parent.transient ? parent : null;
    const handle = inherited || (save ? tree.allocate(!!keep.transient) || (residentNode && keep.forSibling ? tree.allocate(true) : null) : null);
    const k = sweep(nodeMembers, total, nodeHist, derive ? parent.at : 0, derive && sibling ? sibling.at : 0, handle ? handle.at : 0, splitAt, limit);
    if (k === -2) { if (!inherited) tree.release(handle); throw declined('sampled'); }
    if (keep) keep.handle = handle;
    return k;
  }
  function uploadNode(members, histograms, choiceBits) {
    const total = members.length;
    if (!(members instanceof Uint32Array) || total < 64 || total > count || histograms.length !== kinds ||
        histograms.some(h => !(h instanceof Uint32Array) || h.length !== alphabet) || !Number.isSafeInteger(choiceBits)) throw declined('sampled');
    resident();
    new Uint32Array(engine.memory.buffer, membersAt, total).set(members);
    for (let c = 0; c < kinds; c++) engine.i32.set(histograms[c], (histAt >>> 2) + c * alphabet);
  }
  const tree = {
    cells: blockBytes >>> 2,
    live: () => residentTree === id && epoch === retainEpoch,
    get peak() { return peak; },
    allocate(transient = false) {
      if (!tree.live()) return null;
      if (transient && siblingSlot && !siblingBusy) {
        if (!reserve(siblingSlot + blockBytes)) return null;
        siblingBusy = true;
        peak = Math.max(peak, (slots >= 2 ? slots - 1 - free.length : slots - free.length) + 1);
        return {at: siblingSlot, generation, transient: true};
      }
      if (!free.length) return null;
      const at = free.pop();
      if (!reserve(at + blockBytes)) { free.push(at); return null; }
      peak = Math.max(peak, (slots >= 2 ? slots - 1 - free.length : slots - free.length) + (siblingBusy ? 1 : 0));
      return {at, generation, transient: false};
    },
    release(handle) {
      if (!handle || handle.generation !== generation || !tree.live()) return;
      if (handle.transient) siblingBusy = false;
      else free.push(handle.at);
    },
    initArena(maxLeaves) {
      arenaSlots = Math.max(8, maxLeaves * 3 + 8);
      needed = histPoolAt + arenaSlots * histBytes;
      base = Math.ceil(needed / 64) * 64;
      residentTree = 0;
      arena();
      ensureLive();
      freeHistSlots = [];
      for (let s = arenaSlots - 1; s >= 1; s--) freeHistSlots.push(s);
      engine.simd.sampledSplit(resSym, 0, count, 0, 0, kinds, alphabet, -2, 0, arenaMembersAt, 0, 0, histPoolAt, 0);
      identityMembers = true;
      return 0;
    },
    freeHistSlot(slot) { if (slot >= 0) freeHistSlots.push(slot); },
    histSlotSubarray(slot, c) {
      syncViews();
      const start = ((histPoolAt + slot * histBytes) >>> 2) + c * alphabet;
      return cachedU32.subarray(start, start + alphabet);
    },
    readArenaMembers: TREE_STEPS || TREE_DEVICE ? function readArenaMembers(offset, length) {
      return new Uint32Array(engine.memory.buffer, arenaMembersAt + offset * 4, length).slice();
    } : undefined,
    readArenaHistograms: TREE_STEPS || TREE_DEVICE ? function readArenaHistograms(slot) {
      const out = new Array(kinds), start = histPoolAt + slot * histBytes;
      for (let c = 0; c < kinds; c++) out[c] = new Uint32Array(engine.memory.buffer, start + c * alphabet * 4, alphabet).slice();
      return out;
    } : undefined,
    loadArenaState: !TREE_STEPS ? undefined : function loadArenaState(items) {
      identityMembers = false;
      let cursor = 0;
      freeHistSlots = [];
      const u32 = new Uint32Array(engine.memory.buffer), {i32} = engine;
      let nextSlot = 0;
      for (const item of items) {
        const len = item.ids.length;
        u32.set(item.ids, (arenaMembersAt >>> 2) + cursor);
        item.offset = cursor; item.length = len; cursor += len;
        const slot = nextSlot++;
        for (let c = 0; c < kinds; c++) i32.set(item.hist[c], ((histPoolAt + slot * histBytes) >>> 2) + c * alphabet);
        item.histSlot = slot;
        if (item.proposal) {
          const loSlot = nextSlot++, hiSlot = nextSlot++;
          for (let c = 0; c < kinds; c++) {
            i32.set(item.proposal.low[c], ((histPoolAt + loSlot * histBytes) >>> 2) + c * alphabet);
            i32.set(item.proposal.high[c], ((histPoolAt + hiSlot * histBytes) >>> 2) + c * alphabet);
          }
          item.proposal.loSlot = loSlot; item.proposal.hiSlot = hiSlot;
        }
      }
      for (let s = arenaSlots - 1; s >= nextSlot; s--) freeHistSlots.push(s);
    },
    proposeArena(offset, total, histSlot, choiceBits, keep = null, maxPrice = choiceBits) {
      resident();
      const nodeMembersAt = identityMembers && offset === 0 && total === count ? 0 : arenaMembersAt + offset * 4;
      const k = searchNode(nodeMembersAt, total, histPoolAt + histSlot * histBytes, keep, true, maxPrice);
      const prop = sweepResult(k, choiceBits);
      if (!prop || prop.gain <= 0) return null;
      const loSlot = freeHistSlots.pop(), hiSlot = freeHistSlots.pop();
      const u8 = engine.u8;
      u8.copyWithin(histPoolAt + loSlot * histBytes, splitAt, splitAt + cells * 4);
      u8.copyWithin(histPoolAt + hiSlot * histBytes, splitAt + cells * 4, splitAt + cells * 8);
      prop.loSlot = loSlot; prop.hiSlot = hiSlot;
      lastSplitProp = prop;
      return prop;
    },
    partitionArena(offset, total, k, bin) {
      identityMembers = false;
      arena();
      ensureLive();
      const nodeMembersAt = arenaMembersAt + offset * 4;
      return engine.simd.sampledSplit(resSym, resIdx, count, nodeMembersAt, total, kinds, alphabet, k, bin, nodeMembersAt, highAt, 0, 0, 0);
    },
    peelArena(parentHandle, offset, total, histSlot) {
      if (!parentHandle || parentHandle.generation !== generation || total <= 0) return;
      resident();
      sweep(arenaMembersAt + offset * 4, total, histPoolAt + histSlot * histBytes, parentHandle.at, 0, 0, -1, 0);
    },
    propose: !TREE_DEVICE ? undefined : function propose(members, histograms, choiceBits, keep = null) {
      uploadNode(members, histograms, choiceBits);
      lastSplitProp = null;
      const total = members.length, k = searchNode(membersAt, total, histAt, keep, false, Infinity);
      const best = sweepResult(k, choiceBits);
      return best ? taken(total, best, 0) : null;
    },
    split: !TREE_DEVICE ? undefined : function split(members, histograms, choiceBits, record) {
      const total = members.length, {column: k, bin, loSelected, hiSelected, loBits, hiBits} = record ?? {};
      uploadNode(members, histograms, choiceBits);
      if (!record) return null;
      if (!(k >= 0 && k < C && columns[k].cuts.length && bin >= 0 && bin < columns[k].cuts.length && loSelected >= 0 && loSelected < kinds &&
          hiSelected >= 0 && hiSelected < kinds && Number.isSafeInteger(loBits) && Number.isSafeInteger(hiBits))) throw declined('sampled');
      return taken(total, splitResult(k, bin, loSelected, hiSelected, loBits, hiBits, choiceBits), 1);
    },
    finish: !TREE_DEVICE ? undefined : function finish(members, histograms, choiceBits, counts) {
      resident();
      if (!(counts instanceof Uint32Array) || counts.length * 4 !== blockBytes) throw declined('sampled');
      const parent = tree.allocate(), zero = parent && tree.allocate();
      if (!zero) { tree.release(parent); return tree.propose(members, histograms, choiceBits); }
      try {
        const block = new Uint32Array(engine.memory.buffer, parent.at, counts.length);
        let at = 0;
        for (const {cuts} of columns) {
          const bins = cuts.length ? cuts.length + 1 : 0;
          for (let c = 0; c < kinds; c++) for (let b = 0; b < bins; b++) {
            const from = at + (c * bins + b) * alphabet;
            block.set(counts.subarray(from, from + alphabet), at + (b * kinds + c) * alphabet);
          }
          at += bins * cells;
        }
        new Uint8Array(engine.memory.buffer, zero.at, blockBytes).fill(0);
        return tree.propose(members, histograms, choiceBits, {parent, sibling: zero});
      } finally { tree.release(parent); tree.release(zero); }
    },
    scoreCluster: !CLUSTERED_TREES ? null : function scoreCluster(st, item, prop, getPairStats) {
      resident();
      syncViews();
      const {u8, i32} = engine, f64 = cachedF64;
      const {clusters, maxClusters, scale, histBase, histSym, splitCost} = st, K = clusters.length;
      if (clusterEpoch !== st.epoch) {
        for (let g = 0; g < K; g++) {
          const cl = clusters[g], m64 = (clMetaAt + g * 24) >>> 3, m32 = (clMetaAt + g * 24) >>> 2;
          f64[m64] = cl.sumT; f64[m64 + 1] = cl.ent;
          i32[m32 + 4] = cl.total; i32[m32 + 5] = cl.used;
          i32.set(cl.freq, (clFreqAt >>> 2) + g * alphabet);
        }
        clusterEpoch = st.epoch;
      }
      const g0 = item.cluster, c0 = clusters[g0], hasRem = c0.members > 1 ? 1 : 0;
      const freeSlots = maxClusters - K + (hasRem ? 0 : 1);
      const itemHistPtr = hasRem ? (item.histSlot !== undefined ? histPoolAt + item.histSlot * histBytes + item.choice.selected * alphabet * 4
        : (i32.set(item.hist[item.choice.selected], histAt >>> 2), histAt)) : histAt;
      const p64 = clParamsAt >>> 3, p32 = clParamsAt >>> 2;
      f64[p64] = scale; f64[p64 + 1] = histBase; f64[p64 + 2] = histSym;
      f64[p64 + 3] = prop.hi.bits; f64[p64 + 4] = prop.lo.bits;
      const nz0 = writeStatEntry(i32, f64, u8, 0, item.curStats, 0);
      if (prop !== lastSplitProp) {
        if (prop.loSlot !== undefined) {
          u8.copyWithin(splitAt, histPoolAt + prop.loSlot * histBytes, histPoolAt + prop.loSlot * histBytes + cells * 4);
          u8.copyWithin(splitAt + cells * 4, histPoolAt + prop.hiSlot * histBytes, histPoolAt + prop.hiSlot * histBytes + cells * 4);
        } else {
          for (let c = 0; c < kinds; c++) {
            i32.set(prop.low[c], (splitAt >>> 2) + c * alphabet);
            i32.set(prop.high[c], (splitAt >>> 2) + (kinds + c) * alphabet);
          }
        }
        lastSplitProp = prop;
      }
      i32[p32 + 10] = rawAt; i32[p32 + 11] = splitAt; i32[p32 + 12] = nz0;
      engine.simd.sampledClusters(clFreqAt, clMetaAt, K, g0, freeSlots, kinds, alphabet, hasRem, itemHistPtr, tableAt, clParamsAt,
        clPropMetaAt, clNzSymAt, clNzValAt, outAt, prop.hi.selected, prop.lo.selected, 2);
      const o32 = outAt >>> 2, o64 = outAt >>> 3;
      const hi1Pred = i32[o32 + 9], lo1Pred = i32[o32 + 10];
      if (hi1Pred >= 0 && lo1Pred >= 0 && (hi1Pred !== prop.hi.selected || lo1Pred !== prop.lo.selected)) {
        const bothStats = getPairStats(hi1Pred, lo1Pred);
        if (bothStats.bits * scale < f64[o64 + 1]) {
          writeStatEntry(i32, f64, u8, 0, bothStats, 0);
          engine.simd.sampledClusters(clFreqAt, clMetaAt, K, g0, freeSlots, kinds, alphabet, hasRem, histAt, tableAt, clParamsAt,
            clPropMetaAt, clNzSymAt, clNzValAt, outAt, hi1Pred, lo1Pred, 1);
        }
      }
      const before = f64[o64], bestAfter = f64[o64 + 1], hiPred = i32[o32 + 4], hiCl = i32[o32 + 5], loPred = i32[o32 + 6], loCl = i32[o32 + 7], shared = !!i32[o32 + 8];
      prop.epoch = st.epoch; prop.score = before - (bestAfter + splitCost);
      prop.hiChoice = hiPred >= 0 ? {pred: hiPred, cl: hiCl} : null;
      prop.loChoice = loPred >= 0 ? {pred: loPred, cl: loCl} : null;
      prop.shared = shared;
      return prop.score;
    },
  };
  function splitResult(k, bin, loSelected, hiSelected, loBits, hiBits, choiceBits) {
    return {gain: choiceBits - loBits - hiBits, column: columns[k], k, bin, lo: {selected: loSelected, bits: loBits}, hi: {selected: hiSelected, bits: hiBits}};
  }
  function sweepResult(k, choiceBits) {
    if (k < 0) return null;
    syncViews();
    const {i32} = engine, f64 = cachedF64;
    return splitResult(k, i32[(outAt + 4) >>> 2], i32[(outAt + 8) >>> 2], i32[(outAt + 12) >>> 2],
      f64[(outAt + 16) >>> 3], f64[(outAt + 24) >>> 3], choiceBits);
  }
  function taken(total, best, fresh) {
    const {k, bin} = best;
    if (best.gain <= 0) return best;
    const below = engine.simd.sampledSplit(resSym, resIdx, count, membersAt, total, kinds, alphabet, k, bin, lowAt, highAt, fresh ? histAt : 0, fresh ? splitAt : 0, fresh);
    const buffer = engine.memory.buffer, ids = new Uint32Array(buffer, lowAt, total).slice();
    best.lowIds = ids.subarray(0, below); best.highIds = ids.subarray(below);
    const slab = new Uint32Array(buffer, splitAt, 2 * cells).slice();
    best.low = new Array(kinds); best.high = new Array(kinds);
    for (let c = 0; c < kinds; c++) {
      best.low[c] = slab.subarray(c * alphabet, (c + 1) * alphabet);
      best.high[c] = slab.subarray((kinds + c) * alphabet, (kinds + c + 1) * alphabet);
    }
    lastSplitProp = best;
    return best;
  }
  function arena() {
    takeArena(holder);
    acClean = false; ansStamp = null; zdLoaded = false; acBucketsZero = false; tileBand = null; acResident = null; vbStrip = null; s2cPrepLoaded = -1; shapeEpoch = -1;
  }
  function resident() { arena(); ensureLive(); }
  return tree;
}

const SG = 4194304, sgOrderAt = new Int32Array(81);
const strategyLayout = SAMPLE || UPLOAD || JPEG ? null : function strategyLayout(state, g, pass, nzContext, freqContext, orderOf, base) {
  const {authoredOrderPasses, groupsX, strategyData, map, contexts, lumaBuckets, lumaW} = state;
  const blocks = strategyData?.groups[g], passes = CAPTURE_PHOTO ? null : state.progression?.passes;
  if (active !== 'simd' || !blocks || nzContext.length !== 64 || freqContext.length !== 64 || blocks.length * 3 > 3072) return null;
  const authored = authoredOrderPasses?.[pass], bucketed = contexts.thresholds.length > 0, bx0 = g % groupsX * 32, by0 = ((g / groupsX) | 0) * 32;
  const NZ = base + 512, RECS = NZ + 12288, ORDERS = RECS + 3072 * 44;
  sgOrderAt.fill(0);
  const orders = [], meta = blocks._meta, slab = blocks._slab, natOrders = blocks._orders;
  let at = ORDERS, levels = 0;
  if (meta && slab && natOrders) {
    levels = slab.length;
    for (let p = 0; p < meta.length; p += 7) {
      const id = meta[p], id3 = id * 3;
      if (sgOrderAt[id3]) continue;
      const byStrat = authored?.byStrategy[id], nat = natOrders[id];
      for (let c = 0; c < 3; c++) {
        const order = byStrat?.[c] || nat;
        let off = 0;
        for (let k = 0; k < orders.length; k += 2) if (orders[k] === order) { off = orders[k + 1]; break; }
        if (!off) { off = at; at += order.length * 4; orders.push(order, off); }
        sgOrderAt[id3 + c] = off;
      }
    }
  } else for (let b = 0; b < blocks.length; b++) {
    const block = blocks[b], id = block.id, id3 = id * 3;
    levels += block.size * 3;
    if (sgOrderAt[id3]) continue;
    const byStrat = authored?.byStrategy[id];
    for (let c = 0; c < 3; c++) {
      const order = byStrat?.[c] || block.order;
      let off = 0;
      for (let k = 0; k < orders.length; k += 2) if (orders[k] === order) { off = orders[k + 1]; break; }
      if (!off) { off = at; at += order.length * 4; orders.push(order, off); }
      sgOrderAt[id3 + c] = off;
    }
  }
  if (levels > 3 * 65536) return null;
  const LV = at, CTX = LV + levels * 4, VAL = CTX + levels * 4 + 12288, PASSES = VAL + levels * 4 + 12288, end = PASSES + 96;
  if (end > engine.memory.buffer.byteLength) growArena(end);
  const i32 = engine.i32, m0 = map[0], m1 = map[1], m2 = map[2];
  const ctxMap = contexts.map, numDc = contexts.numDc, fastCtx = ctxMap instanceof Uint8Array && ctxMap.length === 39 * numDc;
  const zdBase = contexts.zeroDensityOffset(0), zdStep = contexts.zeroDensityOffset(1) - zdBase;
  i32.set(nzContext, base >> 2); i32.set(freqContext, (base >> 2) + 64);
  if (passes) for (let p = 0; p <= pass; p++) { i32[(PASSES >> 2) + 2 * p] = passes[p].downsample; i32[(PASSES >> 2) + 2 * p + 1] = passes[p].scale; }
  for (let k = 0; k < orders.length; k += 2) i32.set(orders[k], orders[k + 1] >> 2);
  let rec = RECS >> 2, lv = LV, count = 0;
  if (meta && slab && natOrders) {
    i32.set(slab, LV >> 2);
    for (let p = 0; p < meta.length; p += 7) {
      const id = meta[p], bx = meta[p + 1], by = meta[p + 2], bw = meta[p + 3], bh = meta[p + 4], area = meta[p + 5], size = meta[p + 6];
      const id3 = id * 3, ordId = orderOf[id], bucket = bucketed ? lumaBuckets[by * lumaW + bx] : 0, rbx = bx - bx0, rby = by - by0, s4 = size << 2;
      const b1 = fastCtx ? ctxMap[ordId * numDc + bucket] : contexts.contextOf(1, bucket, ordId);
      i32[rec] = size; i32[rec + 1] = area; i32[rec + 2] = bw; i32[rec + 3] = bh;
      i32[rec + 4] = rbx; i32[rec + 5] = rby; i32[rec + 6] = lv + m1 * s4;
      i32[rec + 7] = sgOrderAt[id3 + 1]; i32[rec + 8] = b1; i32[rec + 9] = zdBase + zdStep * b1; i32[rec + 10] = 1;
      const b0 = fastCtx ? ctxMap[(13 + ordId) * numDc + bucket] : contexts.contextOf(0, bucket, ordId);
      i32[rec + 11] = size; i32[rec + 12] = area; i32[rec + 13] = bw; i32[rec + 14] = bh;
      i32[rec + 15] = rbx; i32[rec + 16] = rby; i32[rec + 17] = lv + m0 * s4;
      i32[rec + 18] = sgOrderAt[id3]; i32[rec + 19] = b0; i32[rec + 20] = zdBase + zdStep * b0; i32[rec + 21] = 0;
      const b2 = fastCtx ? ctxMap[(26 + ordId) * numDc + bucket] : contexts.contextOf(2, bucket, ordId);
      i32[rec + 22] = size; i32[rec + 23] = area; i32[rec + 24] = bw; i32[rec + 25] = bh;
      i32[rec + 26] = rbx; i32[rec + 27] = rby; i32[rec + 28] = lv + m2 * s4;
      i32[rec + 29] = sgOrderAt[id3 + 2]; i32[rec + 30] = b2; i32[rec + 31] = zdBase + zdStep * b2; i32[rec + 32] = 2;
      rec += 33; count += 3; lv += size * 12;
    }
  } else for (let b = 0; b < blocks.length; b++) {
    const block = blocks[b], {id, size, area, bw, bh, bx, by} = block, id3 = id * 3, ordId = orderOf[id];
    const bucket = bucketed ? lumaBuckets[by * lumaW + bx] : 0, rbx = bx - bx0, rby = by - by0;
    if (block.levels) {
      i32.set(block.levels, lv >> 2);
      for (let i = 0; i < 3; i++) {
        const c = i === 0 ? 1 : i === 1 ? 0 : 2, mc = c === 1 ? m1 : c === 0 ? m0 : m2;
        const blockCtx = fastCtx ? ctxMap[((c < 2 ? c ^ 1 : 2) * 13 + ordId) * numDc + bucket] : contexts.contextOf(c, bucket, ordId);
        i32[rec] = size; i32[rec + 1] = area; i32[rec + 2] = bw; i32[rec + 3] = bh;
        i32[rec + 4] = rbx; i32[rec + 5] = rby; i32[rec + 6] = lv + mc * size * 4;
        i32[rec + 7] = sgOrderAt[id3 + c]; i32[rec + 8] = blockCtx;
        i32[rec + 9] = zdBase + zdStep * blockCtx; i32[rec + 10] = c;
        rec += 11; count++;
      }
      lv += size * 12;
    } else {
      for (let i = 0; i < 3; i++) {
        const c = i === 0 ? 1 : i === 1 ? 0 : 2, coeffs = block.coeffs[map[c]];
        if (coeffs.length !== size) return null;
        i32.set(coeffs, lv >> 2);
        const blockCtx = fastCtx ? ctxMap[((c < 2 ? c ^ 1 : 2) * 13 + ordId) * numDc + bucket] : contexts.contextOf(c, bucket, ordId);
        i32[rec] = size; i32[rec + 1] = area; i32[rec + 2] = bw; i32[rec + 3] = bh;
        i32[rec + 4] = rbx; i32[rec + 5] = rby; i32[rec + 6] = lv;
        i32[rec + 7] = sgOrderAt[id3 + c]; i32[rec + 8] = blockCtx;
        i32[rec + 9] = zdBase + zdStep * blockCtx; i32[rec + 10] = c;
        rec += 11; lv += size * 4; count++;
      }
    }
  }
  return {n: engine.simd.sgFill(RECS, count, contexts.numCtxs, base, NZ, CTX, VAL, passes ? PASSES : 0, pass), ctx: CTX, val: VAL, levels};
};
const strategyFill = SAMPLE || UPLOAD || JPEG ? null : function strategyFill(state, g, pass, nzContext, freqContext, orderOf, ctxs, values) {
  acClean = false; ansStamp = null; zdLoaded = false; acBucketsZero = false; tileBand = null; acResident = null; retainEpoch++;
  const laid = strategyLayout(state, g, pass, nzContext, freqContext, orderOf, SG);
  if (!laid || laid.n > ctxs.length) return null;
  ctxs.set(engine.i32.subarray(laid.ctx >> 2, (laid.ctx >> 2) + laid.n)); values.set(engine.i32.subarray(laid.val >> 2, (laid.val >> 2) + laid.n));
  return laid.n;
};
const strategyWrite = SAMPLE || UPLOAD || JPEG ? null : function strategyWrite(state, g, pass, nzContext, freqContext, orderOf, coding, w) {
  const model = coding.model, blocks = state.strategyData?.groups[g], kind = model?.kind;
  if (active !== 'simd' || !blocks || (kind !== 'ans' && kind !== 'prefix') || model.histograms.length > 256 || model.contextMap.length > 8192 ||
      !acceptableWriter(w) || kind === 'ans' && model.histograms.some(h => !(h.reverse instanceof Uint16Array) || h.reverse.length !== 4096)) return false;
  let levels = 0;
  for (const block of blocks) levels += 3 * block.size;
  const tokens = levels + 3072;
  if (kind === 'prefix') {
    const codes = model.histograms, alphabet = Math.max(...codes.map(h => h.code.lengths.length));
    const OUT = AC_CODES + Math.max(8, codes.length * alphabet * 8) + 7 & ~7, base = OUT + tokens * 8 + 16 + 8 & ~7;
    retainEpoch++; acClean = false; ansStamp = null; zdLoaded = false; acBucketsZero = false; tileBand = null; acResident = null;
    const laid = strategyLayout(state, g, pass, nzContext, freqContext, orderOf, base);
    if (!laid || laid.n > tokens) return false;
    loadPrefix(model, codes, alphabet);
    const i32 = engine.i32;
    i32.fill(0, AC >> 2, (AC >> 2) + 29);
    i32.set([1, 0, 0, 0, 0, 0, AC_MAP, AC_CONFIGS, AC_CODES, alphabet, OUT, w.acc, w.pending], (AC >> 2) + 12);
    engine.simd.acTokens(AC, laid.ctx, laid.val, laid.n);
    takePrefix(w, OUT);
    return true;
  }
  const ans = ansTablesOf(model);
  const A_SMALL = AC_CODES, A_FREQS = A_SMALL + ans.ids * 256, A_STARTS = A_FREQS + ans.ids * 256, A_REVERSE = A_STARTS + ans.ids * 256;
  const A_CONFIGS = A_REVERSE + ans.ids * 8192, A_COUNTS = A_CONFIGS + ans.ids * 16, A_SYMBOL_STARTS = A_COUNTS + ans.ids * ans.alphabet * 4;
  const A_RECIPS = A_SYMBOL_STARTS + ans.ids * ans.alphabet * 4 + 7 & ~7, A_VALUES = A_RECIPS + RECIPS_BYTES, A_IDS = A_VALUES + tokens * 4, A_RAWS = A_IDS + tokens + 8 & ~7;
  const A_META = A_RAWS + tokens * 4, A_EMITTED = A_META + tokens + 8 & ~7, OUT = A_EMITTED + tokens * 2 + 8 & ~7, base = OUT + tokens * 8 + 16 + 8 & ~7;
  retainEpoch++; acClean = false; zdLoaded = false; acBucketsZero = false; tileBand = null; acResident = null;
  const laid = strategyLayout(state, g, pass, nzContext, freqContext, orderOf, base);
  if (!laid || laid.n > tokens) return false;
  const u8 = engine.u8, i32 = engine.i32, u16 = new Uint16Array(engine.memory.buffer);
  if (ansStamp !== model) {
    i32.set(ans.small, A_SMALL >> 2); i32.set(ans.freqs, A_FREQS >> 2); i32.set(ans.starts, A_STARTS >> 2); u16.set(ans.reverse, A_REVERSE >> 1);
    i32.set(ans.configs, A_CONFIGS >> 2); i32.set(ans.counts, A_COUNTS >> 2); i32.set(ans.symbolStarts, A_SYMBOL_STARTS >> 2);
    i32.set(reciprocals(), A_RECIPS >> 2);
    ansStamp = model;
  }
  u8.set(model.contextMap, AC_MAP);
  i32.fill(0, AC >> 2, (AC >> 2) + 29);
  i32[(AC >> 2) + 12] = 2; i32[(AC >> 2) + 18] = AC_MAP; i32[(AC >> 2) + 26] = A_VALUES; i32[(AC >> 2) + 27] = A_IDS;
  engine.simd.acTokens(AC, laid.ctx, laid.val, laid.n);
  const args = AC_CONFIGS + 4096 - 128;
  i32.set([A_VALUES, A_IDS, i32[(AC >> 2) + 28], A_SMALL, A_FREQS, A_STARTS, A_REVERSE, A_CONFIGS, A_COUNTS, A_SYMBOL_STARTS, ans.alphabet,
    A_RAWS, A_META, A_EMITTED, OUT, w.acc, w.pending, 0, A_RECIPS], args >> 2);
  engine.simd.ansFlush(args);
  takeFlushed(w, args, OUT);
  return 2;
};

const XYB_AT = 4194304, XY_LIN = XYB_AT + 4113 * 8, XY_MIX = XY_LIN + 6144, XY_KEYS = XY_MIX + 128, XY_VALS = XY_KEYS + 4 * 131072, XY_ROWS = XY_VALS + 24 * 131072;
const xybPlanesKernel = SAMPLE || JPEG ? null : function xybPlanesKernel(data, width, height, W, H, planes, roots, linear, mix, bias, rootBias, gab = null, signed = false, samples = null) {
  const layout = sampleLayout(data, samples, signed);
  const lin = layout?.mode <= 1 ? (Array.isArray(linear) ? linear : [linear, linear, linear]) : null;
  if (active !== 'simd' || !layout || data.length !== width * height * 4 || roots.length !== 4113 || (lin && (lin.length !== 3 || lin.some(t => t.length !== 256))) ||
      mix.length !== 9 || W < width || H < height || (planes ? planes.some(p => !(p instanceof Float64Array) || p.length !== W * H) : !samples?.weights)) return false;
  if (gab) return xybGaborish(data, width, height, W, H, planes, roots, lin, mix, bias, rootBias, gab, layout, samples);
  const bpe = layout.bpe, curveBytes = layout.mode === 2 ? layout.curve.byteLength : 0, lumaWeights = samples?.weights ?? null;
  const weightsBytes = lumaWeights ? 8192 : 0, curveAt = XY_ROWS, weightsAt = curveAt + curveBytes, stripsAt = weightsAt + weightsBytes;
  const perRow = width * bpe + (planes ? 3 * W * 8 : 0), rows = Math.min(height, Math.max(1, Math.floor((272 * 65536 - stripsAt - 16) / perRow)));
  const end = stripsAt + Math.ceil(rows * width * bpe / 16) * 16 + (planes ? 3 * rows * W * 8 : 0) + 16;
  if (end > engine.memory.buffer.byteLength) {
    if (data.buffer === engine.memory.buffer) data = data.slice();
    growArena(end);
  }
  const keepVb = vbLoaded === retainEpoch;
  acClean = false; ansStamp = null; zdLoaded = false; acBucketsZero = false; tileBand = null; acResident = null; vbStrip = null; retainEpoch++;
  if (keepVb) vbLoaded = retainEpoch;
  const f64 = new Float64Array(engine.memory.buffer), i32 = engine.i32, u8 = engine.u8;
  f64.set(roots, XYB_AT >> 3);
  if (lin) for (let c = 0; c < 3; c++) f64.set(lin[c], (XY_LIN >> 3) + c * 256);
  else if (layout.mode === 2) f64.set(layout.curve, curveAt >> 3);
  if (lumaWeights) f64.set(lumaWeights, weightsAt >> 3);
  f64.set(mix, XY_MIX >> 3); f64[(XY_MIX + 72) >> 3] = layout.lift; f64[(XY_MIX + 80) >> 3] = 0;
  i32[(XY_MIX + 88) >> 2] = lumaWeights ? weightsAt : 0;
  i32.fill(-1, XY_KEYS >> 2, (XY_KEYS >> 2) + 131072);
  const mode = layout.mode | (lumaWeights ? 8 : 0), linPtr = layout.mode === 2 ? curveAt : XY_LIN;
  for (let y = 0; y < height; y += rows) {
    const n = Math.min(rows, height - y), out = planes ? stripsAt + Math.ceil(n * width * bpe / 16) * 16 : 0;
    u8.set(layout.bytes.subarray(y * width * bpe, (y + n) * width * bpe), stripsAt);
    if (lumaWeights) { i32[(XY_MIX + 92) >> 2] = 0; i32[(XY_MIX + 96) >> 2] = n; }
    engine.simd.xybRows(stripsAt, width, n, W, XYB_AT, linPtr, XY_MIX, bias, rootBias, XY_KEYS, XY_VALS, out, mode);
    if (planes) for (let c = 0; c < 3; c++) planes[c].set(f64.subarray((out >> 3) + c * n * W, (out >> 3) + (c + 1) * n * W), y * W);
  }
  if (lumaWeights) samples.reading = f64[(XY_MIX + 80) >> 3];
  return true;
};

const xybGaborish = SAMPLE || JPEG ? null : function xybGaborish(data, width, height, W, H, planes, roots, lin, mix, bias, rootBias, {weights, iterations, boost}, layout, samples = null) {
  if (!planes || boost !== 1 && !engine.simd.gabBoost || W < 8 || W % 2 || !Number.isInteger(iterations) || iterations < 1 || iterations > 16 || weights.length !== 3) return false;
  const bpe = layout.bpe, curveBytes = layout.mode === 2 ? layout.curve.byteLength : 0, lumaWeights = samples?.weights ?? null;
  const weightsBytes = lumaWeights ? 8192 : 0, curveAt = XY_ROWS, weightsAt = curveAt + curveBytes, stripsAt = weightsAt + weightsBytes;
  const rowBytes = W * 8, perRow = width * bpe + 4 * rowBytes, ringBytes = 2 * rowBytes;
  const rows = Math.min(H, Math.max(16 + 2 * iterations, Math.floor((272 * 65536 - stripsAt - ringBytes - 32) / perRow))), keep = rows === H ? H : rows - 2 * iterations;
  const pixelsAt = stripsAt, planesAt = Math.ceil((pixelsAt + rows * width * bpe) / 16) * 16, workAt = planesAt + 3 * rows * rowBytes, ringAt = workAt + rows * rowBytes, end = ringAt + ringBytes;
  if (end > engine.memory.buffer.byteLength) {
    if (data.buffer === engine.memory.buffer) data = data.slice();
    growArena(end);
  }
  const keepVb = vbLoaded === retainEpoch;
  acClean = false; ansStamp = null; zdLoaded = false; acBucketsZero = false; tileBand = null; acResident = null; vbStrip = null; retainEpoch++;
  if (keepVb) vbLoaded = retainEpoch;
  const f64 = new Float64Array(engine.memory.buffer), i32 = engine.i32, u8 = engine.u8;
  const last = layout.bytes.subarray((height - 1) * width * bpe, height * width * bpe);
  f64.set(roots, XYB_AT >> 3);
  if (lin) for (let c = 0; c < 3; c++) f64.set(lin[c], (XY_LIN >> 3) + c * 256);
  else if (layout.mode === 2) f64.set(layout.curve, curveAt >> 3);
  if (lumaWeights) f64.set(lumaWeights, weightsAt >> 3);
  f64.set(mix, XY_MIX >> 3); f64[(XY_MIX + 72) >> 3] = layout.lift; f64[(XY_MIX + 80) >> 3] = 0;
  i32[(XY_MIX + 88) >> 2] = lumaWeights ? weightsAt : 0;
  i32.fill(-1, XY_KEYS >> 2, (XY_KEYS >> 2) + 131072);
  const mode = layout.mode | (lumaWeights ? 8 : 0), linPtr = layout.mode === 2 ? curveAt : XY_LIN;
  for (let a = 0; a < H; a += keep) {
    const b = Math.min(H, a + keep), from = Math.max(0, a - iterations), to = Math.min(H, b + iterations), n = to - from, real = Math.max(0, Math.min(height, to) - from);
    if (real) u8.set(layout.bytes.subarray(from * width * bpe, (from + real) * width * bpe), pixelsAt);
    for (let y = from + real; y < to; y++) u8.set(last, pixelsAt + (y - from) * width * bpe);
    if (lumaWeights) { i32[(XY_MIX + 92) >> 2] = a - from; i32[(XY_MIX + 96) >> 2] = Math.max(a - from, Math.min(height, b) - from); }
    engine.simd.xybRows(pixelsAt, width, n, W, XYB_AT, linPtr, XY_MIX, bias, rootBias, XY_KEYS, XY_VALS, planesAt, mode);
    for (let c = 0; c < 3; c++) {
      const orig = planesAt + c * n * rowBytes, work = workAt;
      u8.copyWithin(work, orig, orig + n * rowBytes);
      const [w1, w2] = weights[c], norm = 1 / (1 + 4 * w1 + 4 * w2);
      for (let i = 0; i < iterations; i++) {
        engine.simd.gab(work, orig, ringAt, W, n, w1, w2, norm);
        if (i === 0 && boost !== 1) engine.simd.gabBoost(work, orig, n * W, boost);
      }
      planes[c].set(f64.subarray((work >> 3) + (a - from) * W, (work >> 3) + (b - from) * W), a * W);
    }
  }
  if (lumaWeights) samples.reading = f64[(XY_MIX + 80) >> 3];
  return true;
};

const GAB = 4194304, GAB_LIMIT = 272 * 65536;
const gaborish = SAMPLE || UPLOAD || JPEG ? null : function gaborish(t, source, W, H, weights, iterations, start = source, boost = 1) {
  if (boost !== 1 && (start !== source || !engine.simd.gabBoost)) return false;
  if (active !== 'simd' || !(t instanceof Float64Array) || !(source instanceof Float64Array) || source.length < W * H || !(start instanceof Float64Array) || start.length < W * H || start === t && start !== source || !Number.isInteger(W) || !Number.isInteger(H) || W < 8 || W % 2 ||
      H < 1 || t.length !== W * H || !Number.isInteger(iterations) || iterations < 1 || iterations > 16) return false;
  const rowBytes = W * 8, room = Math.floor((GAB_LIMIT - GAB) / rowBytes) - 2;
  const rows = Math.min(H, Math.max(room >> 1, 16 + 2 * iterations)), keep = rows === H ? H : rows - 2 * iterations;
  const end = GAB + (2 * rows + 2) * rowBytes;
  if (end > engine.memory.buffer.byteLength) growArena(end);
  const keepVb = vbLoaded === retainEpoch;
  acClean = false; ansStamp = null; zdLoaded = false; acBucketsZero = false; tileBand = null; acResident = null; vbStrip = null; retainEpoch++;
  if (keepVb) vbLoaded = retainEpoch;
  const f64 = new Float64Array(engine.memory.buffer), orig = GAB + rows * rowBytes, ring = orig + rows * rowBytes;
  const [w1, w2] = weights, norm = 1 / (1 + 4 * w1 + 4 * w2);
  for (let a = 0; a < H; a += keep) {
    const b = Math.min(H, a + keep), from = Math.max(0, a - iterations), to = Math.min(H, b + iterations), rowsOf = source.subarray(from * W, to * W);
    f64.set(start === source ? rowsOf : start.subarray(from * W, to * W), GAB >> 3); f64.set(rowsOf, orig >> 3);
    for (let i = 0; i < iterations; i++) {
      engine.simd.gab(GAB, orig, ring, W, to - from, w1, w2, norm);
      if (i === 0 && boost !== 1) engine.simd.gabBoost(GAB, orig, (to - from) * W, boost);
    }
    t.set(f64.subarray((GAB >> 3) + (a - from) * W, (GAB >> 3) + (b - from) * W), a * W);
  }
  return true;
};


const S2C = 4194304, S2C_LIMIT = 640 * 65536, S2C_PREP_TAB = S2C, S2C_PREP_WORK = S2C + 540672;
let s2cPrepLoaded = -1;
const s2cChannel = SAMPLE || UPLOAD || JPEG ? null : function s2cChannel(P1, P2, w, h, sh, stride, acc1, acc4, span, taps) {
  if (active !== 'simd' || !(P1 instanceof Int16Array) || !(P2 instanceof Int16Array) || P1.length !== P2.length) return false;
  const y0 = span ? span.y0 : 0, y1 = span ? span.y1 : h, from = span ? span.from : 0, cell0 = span ? span.cellRow0 : 0;
  const base = S2C_PREP_WORK, sums = [...acc1, ...acc4], ringAt = base + 128, qAt = ringAt + 5 * 9 * w * 4, accAt = qAt + 3 * w * 4;
  let at = accAt + 112;
  const places = sums.map(sum => { if (!sum) return 0; const place = at; at += sum.byteLength + 7 & ~7; return place; });
  const planesAt = at, room = Math.max(24, Math.floor((S2C_LIMIT - planesAt) / (4 * w))), rows = room - 8;
  const end = planesAt + Math.min(room, P1.length / w) * 4 * w;
  if (end > engine.memory.buffer.byteLength) {
    growArena(end);
  }
  if (end > engine.memory.buffer.byteLength) {
    growArena(end);
  }
  if (engine.u8.buffer !== engine.memory.buffer) { engine.u8 = new Uint8Array(engine.memory.buffer); engine.i32 = new Int32Array(engine.memory.buffer); }
  const keepVb = vbLoaded === retainEpoch, keepPrep = s2cPrepLoaded === retainEpoch;
  acClean = false; ansStamp = null; zdLoaded = false; acBucketsZero = false; tileBand = null; acResident = null; vbStrip = null; retainEpoch++;
  if (keepVb) vbLoaded = retainEpoch;
  if (keepPrep) s2cPrepLoaded = retainEpoch;
  const u8 = engine.u8, i32 = engine.i32, i16 = new Int16Array(engine.memory.buffer);
  i32.set(taps, base >> 2); i32.set(places, (base + 64) >> 2);
  for (const place of places) if (place) u8.fill(0, place, place + sums[places.indexOf(place)].byteLength);
  for (let a = y0; a < y1; a += rows) {
    const b = Math.min(y1, a + rows), lo = Math.max(from, a - 4), hi = Math.min(h, b + 4, from + P1.length / w), n = (hi - lo) * w;
    i16.set(P1.subarray((lo - from) * w, (hi - from) * w), planesAt >> 1); i16.set(P2.subarray((lo - from) * w, (hi - from) * w), (planesAt >> 1) + n);
    engine.simd.s2cChannel(planesAt, planesAt + 2 * n, w, h, sh, stride, a, b, lo, cell0, base, ringAt, qAt, accAt, base + 64);
  }
  sums.forEach((sum, k) => { if (sum) sum.set(new Uint32Array(engine.memory.buffer, places[k], sum.length)); });
  return true;
};
const s2cPrep = SAMPLE || UPLOAD || JPEG ? null : function s2cPrep(op, tables, a0, a1, a2, a3, a4) {
  if (active !== 'simd') return false;
  const ensureMem = end => {
    if (end > engine.memory.buffer.byteLength) {
      growArena(end);
    }
    if (end > engine.memory.buffer.byteLength) {
      growArena(end);
    }
    if (engine.u8.buffer !== engine.memory.buffer) { engine.u8 = new Uint8Array(engine.memory.buffer); engine.i32 = new Int32Array(engine.memory.buffer); }
    const keepVb = vbLoaded === retainEpoch, keepPrep = s2cPrepLoaded === retainEpoch;
    acClean = false; ansStamp = null; zdLoaded = false; acBucketsZero = false; tileBand = null; acResident = null; vbStrip = null; retainEpoch++;
    if (keepVb) vbLoaded = retainEpoch;
    if (keepPrep) s2cPrepLoaded = retainEpoch;
    else {
      const i32 = engine.i32;
      i32[S2C_PREP_TAB >> 2] = tables.bias;
      i32[(S2C_PREP_TAB + 4) >> 2] = tables.black;
      i32.set(tables.mix, (S2C_PREP_TAB + 8) >> 2);
      i32.set(tables.lin, (S2C_PREP_TAB + 64) >> 2);
      for (let j = 0; j < 9; j++) i32.set(tables.cones[j], (S2C_PREP_TAB + 1088 + j * 1024) >> 2);
      i32.set(tables.lo, (S2C_PREP_TAB + 10304) >> 2);
      i32.set(tables.hi, (S2C_PREP_TAB + 272448) >> 2);
      s2cPrepLoaded = retainEpoch;
    }
  };
  const CHUNK = 1048576, badAt = S2C_PREP_WORK;
  if (op === 'rgba3') {
    const rgba = a0, n = a1, X = new Int16Array(n), Y = new Int16Array(n), B = new Int16Array(n);
    const step = Math.min(n || 1, CHUNK), inAt = badAt + 16, xAt = inAt + step * 4, yAt = xAt + step * 2, bAt = yAt + step * 2;
    ensureMem(bAt + step * 2 + 16);
    for (let off = 0; off < n; off += step) {
      const m = Math.min(step, n - off);
      engine.u8.set(rgba.subarray(off * 4, (off + m) * 4), inAt);
      engine.simd.s2cChannel(inAt, 0, m, -1, -2, 0, 0, 0, 0, 0, S2C_PREP_TAB, xAt, yAt, bAt, badAt);
      if (engine.i32[badAt >> 2]) throw fault('JXL_INTERNAL', 's2-cells:xyb-2');
      const i16 = new Int16Array(engine.memory.buffer);
      X.set(i16.subarray(xAt >> 1, (xAt >> 1) + m), off);
      Y.set(i16.subarray(yAt >> 1, (yAt >> 1) + m), off);
      B.set(i16.subarray(bAt >> 1, (bAt >> 1) + m), off);
    }
    return [X, Y, B];
  }
  if (op === 'rgba1') {
    const rgba = a0, n = a1, c = a2, out = a3;
    const step = Math.min(n || 1, CHUNK), inAt = badAt + 16, outAt = inAt + step * 4;
    ensureMem(outAt + step * 2 + 16);
    for (let off = 0; off < n; off += step) {
      const m = Math.min(step, n - off);
      engine.u8.set(rgba.subarray(off * 4, (off + m) * 4), inAt);
      engine.simd.s2cChannel(inAt, 0, m, c, -2, 0, 0, 0, 0, 0, S2C_PREP_TAB, outAt, 0, 0, badAt);
      if (engine.i32[badAt >> 2]) throw fault('JXL_INTERNAL', 's2-cells:xyb-2');
      out.set(new Int16Array(engine.memory.buffer, outAt, m), off);
    }
    return out;
  }
  if (op === 'lin3') {
    const [R0, G0, B0] = a0, n = a1, X = new Int16Array(n), Y = new Int16Array(n), B = new Int16Array(n);
    const step = Math.min(n || 1, CHUNK), rAt = badAt + 16, gAt = rAt + step * 2, b0At = gAt + step * 2;
    const xAt = b0At + step * 2, yAt = xAt + step * 2, bAt = yAt + step * 2;
    ensureMem(bAt + step * 2 + 16);
    for (let off = 0; off < n; off += step) {
      const m = Math.min(step, n - off), u16 = new Uint16Array(engine.memory.buffer), i16 = new Int16Array(engine.memory.buffer);
      u16.set(R0.subarray(off, off + m), rAt >> 1);
      u16.set(G0.subarray(off, off + m), gAt >> 1);
      u16.set(B0.subarray(off, off + m), b0At >> 1);
      engine.simd.s2cChannel(rAt, gAt, m, 0, -3, 0, b0At, 0, 0, 0, S2C_PREP_TAB, xAt, yAt, bAt, badAt);
      if (engine.i32[badAt >> 2]) throw fault('JXL_INTERNAL', 's2-cells:xyb-1');
      X.set(i16.subarray(xAt >> 1, (xAt >> 1) + m), off);
      Y.set(i16.subarray(yAt >> 1, (yAt >> 1) + m), off);
      B.set(i16.subarray(bAt >> 1, (bAt >> 1) + m), off);
    }
    return [X, Y, B];
  }
  if (op === 'down') {
    const pic = a0, pw = a1, ph = a2, w = a3, h = a4;
    const l0 = new Uint16Array(w * h), l1 = new Uint16Array(w * h), l2 = new Uint16Array(w * h);
    const rowStep = Math.max(1, Math.min(h || 1, Math.floor(CHUNK / Math.max(1, pw))));
    if (pic.rgba) {
      const inAt = badAt + 16, o0 = inAt + 2 * rowStep * pw * 4, o1 = o0 + rowStep * w * 2, o2 = o1 + rowStep * w * 2;
      ensureMem(o2 + rowStep * w * 2 + 16);
      for (let y = 0; y < h; y += rowStep) {
        const dh = Math.min(rowStep, h - y), sy0 = 2 * y, shRows = Math.max(1, Math.min(ph - sy0, 2 * dh));
        engine.u8.set(pic.rgba.subarray(sy0 * pw * 4, (sy0 + shRows) * pw * 4), inAt);
        engine.simd.s2cChannel(inAt, 0, pw, shRows, -4, w, dh, 0, 0, 0, S2C_PREP_TAB, o0, o1, o2, badAt);
        const u16 = new Uint16Array(engine.memory.buffer), m = dh * w;
        l0.set(u16.subarray(o0 >> 1, (o0 >> 1) + m), y * w);
        l1.set(u16.subarray(o1 >> 1, (o1 >> 1) + m), y * w);
        l2.set(u16.subarray(o2 >> 1, (o2 >> 1) + m), y * w);
      }
    } else {
      const [s0, s1, s2] = pic.lin, inBytes = 2 * rowStep * pw * 2;
      const i0 = badAt + 16, i1 = i0 + inBytes, i2 = i1 + inBytes, o0 = i2 + inBytes, o1 = o0 + rowStep * w * 2, o2 = o1 + rowStep * w * 2;
      ensureMem(o2 + rowStep * w * 2 + 16);
      for (let y = 0; y < h; y += rowStep) {
        const dh = Math.min(rowStep, h - y), sy0 = 2 * y, shRows = Math.max(1, Math.min(ph - sy0, 2 * dh)), u16 = new Uint16Array(engine.memory.buffer);
        u16.set(s0.subarray(sy0 * pw, (sy0 + shRows) * pw), i0 >> 1);
        u16.set(s1.subarray(sy0 * pw, (sy0 + shRows) * pw), i1 >> 1);
        u16.set(s2.subarray(sy0 * pw, (sy0 + shRows) * pw), i2 >> 1);
        engine.simd.s2cChannel(i0, i1, pw, shRows, -5, w, dh, 0, i2, 0, S2C_PREP_TAB, o0, o1, o2, badAt);
        const m = dh * w;
        l0.set(u16.subarray(o0 >> 1, (o0 >> 1) + m), y * w);
        l1.set(u16.subarray(o1 >> 1, (o1 >> 1) + m), y * w);
        l2.set(u16.subarray(o2 >> 1, (o2 >> 1) + m), y * w);
      }
    }
    return {lin: [l0, l1, l2]};
  }
  return false;
};

const GB = 4194304, GB_LIMIT = 272 * 65536, GB_TILE_ROWS = 4, GB_INTO = [3, 0, 1];
const PACK_TABLE = new Uint8Array(6144);
for (let mask = 0; mask < 256; mask++) for (let lane = 0, j = 0; lane < 8; lane++) if (mask >> lane & 1) {
  PACK_TABLE[mask * 16 + 2 * j] = 2 * lane; PACK_TABLE[mask * 16 + 2 * j + 1] = 2 * lane + 1; PACK_TABLE[4096 + mask * 8 + j++] = lane;
}
const GB_ROOTS = GB, GB_LIN = GB + 32912, GB_MIX = GB_LIN + 6144, GB_BASIS = GB_MIX + 80, GB_PAIRED = GB_BASIS + 512, GB_QUANT = GB_PAIRED + 512,
  GB_THR = GB_QUANT + 1536, GB_SCRATCH = GB_THR + 1536, GB_TILE = GB_SCRATCH + 512, GB_CFL = GB_TILE + 98304,
  GB_PACK = GB_CFL + 1024, GB_NAT = GB_PACK + 6144, GB_KEYS = GB_NAT + 768,
  GB_VALS = GB_KEYS + 4 * 131072, GB_CHUNK = GB_VALS + 24 * 131072, GB_FAST_BYTES = 4 << 20;
function copyWords(to, at, from, start, words) { for (let i = 0; i < words; i++) to[at + i] = from[start + i]; }
const gabBand = SAMPLE || JPEG ? null : function gabBand(data, width, total, top, height, job) {
  const {linear, mix, bias, rootBias, weights, iterations, thresholds, c84, components, cfl, nonZero, fast, quantFields = null, signed = false, samples = null} = job;
  const pre = fast ? null : job.pre ?? null;
  const layout = pre ? null : sampleLayout(data, samples, signed);
  const lin = !pre && !fast && layout?.mode <= 1 ? (Array.isArray(linear) ? linear : [linear, linear, linear]) : null;
  const stride = Math.ceil(width / 8), rows = Math.ceil(height / 8), W = stride * 8, Hpad = Math.ceil(total / 8) * 8;
  if (pre && (pre.length !== 3 || pre.some(p => !(p instanceof Float64Array) || p.length < W * Hpad))) return false;
  if (active !== 'simd' || (!pre && (!layout || data.length !== total * width * 4)) || (fast && layout?.mode !== 0) ||
      !Number.isInteger(top) || top < 0 || top + rows * 8 > Hpad || (fast ? linear.length !== 256 : lin && (lin.length !== 3 || lin.some(t => t.length !== 256))) || mix.length !== 9 ||
      !Number.isInteger(iterations) || iterations < (fast ? 1 : 0) || iterations > 16 || !fast && job.roots.length !== 4113 ||
      (fast ? job.steps.length !== 3 || job.scale.length !== 64 : job.basis.length !== 64)) return false;
  const S = fast ? 4 : 8, bpe = pre ? 0 : layout.bpe, halo = iterations ? iterations + (iterations & 1) : 0, packed = !pre && layout.mode <= 1 ? job.packed : null;
  const tileRows = Math.ceil(rows / 8), tileCols = Math.ceil(stride / 8), chunkRows = Math.min(tileRows, GB_TILE_ROWS) * 64 + 2 * iterations;
  const perColumn = chunkRows * (bpe + 4 * S) + 2 * S + 3 * 8 * 16 + 3 + (packed ? 585 : 0);
  const fieldsBytes = !fast && quantFields ? (stride * rows * 4 + 15 & ~15) : 0, fieldsAt = GB_CHUNK;
  const curveBytes = !pre && layout.mode === 2 ? layout.curve.byteLength : 0, curveAt = fieldsAt + fieldsBytes;
  const limit = Math.min(GB_LIMIT, engine.memory.buffer.byteLength);
  const chunkAt = fast ? GB_KEYS + 1024 : curveAt + curveBytes, held = limit - chunkAt;
  const room = fast ? (held >= perColumn * (256 + 2 * halo) ? held : GB_FAST_BYTES) : Math.max(held, perColumn * (64 + 2 * halo));
  let across = Math.min(tileCols, Math.floor((Math.floor(room / perColumn) - 2 * halo) / 64));
  if (packed && across < tileCols) across &= ~3;
  if (across < 1) across = packed ? Math.min(tileCols, 4) : 1;
  const span = Math.min(W, across * 64) + 2 * halo, need = chunkAt + span * perColumn + 128;
  if (need > engine.memory.buffer.byteLength) {
    if (data.buffer === engine.memory.buffer) data = data.slice();
    growArena(need);
  }
  acClean = false; ansStamp = null; zdLoaded = false; acBucketsZero = false; tileBand = null; acResident = null; retainEpoch++;
  const buffer = engine.memory.buffer, f64 = new Float64Array(buffer), f32 = new Float32Array(buffer), u8 = engine.u8, i8 = new Int8Array(buffer);
  if (fast) {
    f32.set(linear, GB_LIN >> 2); f32.set(mix, GB_MIX >> 2);
    f32.set(job.scale, GB_PAIRED >> 2);
    for (let c = 0; c < 3; c++) { f32.set(job.steps[c], (GB_QUANT >> 2) + c * 64); f32.set(thresholds[c], (GB_THR >> 2) + c * 64); }
  } else {
    const basis = job.basis;
    f64.set(job.roots, GB_ROOTS >> 3);
    if (lin) for (let c = 0; c < 3; c++) f64.set(lin[c], (GB_LIN >> 3) + c * 256);
    else if (!pre && layout.mode === 2) f64.set(layout.curve, curveAt >> 3);
    f64.set(mix, GB_MIX >> 3); f64[(GB_MIX + 72) >> 3] = pre ? 1 : layout.lift; f64.set(basis, GB_BASIS >> 3);
    if (fieldsBytes) engine.i32.set(quantFields.subarray(0, stride * rows), fieldsAt >> 2);
    for (let u = 0; u < 8; u += 2) for (let x = 0; x < 8; x++) {
      f64[(GB_PAIRED >> 3) + u * 8 + x * 2] = basis[u * 8 + x];
      f64[(GB_PAIRED >> 3) + u * 8 + x * 2 + 1] = basis[(u + 1) * 8 + x];
    }
    for (let c = 0; c < 3; c++) { for (let k = 0; k < 64; k++) f64[(GB_QUANT >> 3) + c * 64 + k] = job.quant[c][k]; f64.set(thresholds[c], (GB_THR >> 3) + c * 64); }
    engine.i32.fill(-1, GB_KEYS >> 2, (GB_KEYS >> 2) + 131072);
  }
  const norms = weights.map(([w1, w2]) => 1 / (1 + 4 * w1 + 4 * w2)), tileWidth = cfl.width, linPtr = !pre && layout.mode === 2 ? curveAt : GB_LIN;
  if (packed) {
    engine.i32.fill(0, GB_NAT >> 2, (GB_NAT >> 2) + 192);
    u8.set(PACK_TABLE, GB_PACK);
    packed.segment = across * 8; packed.segments = Math.ceil(stride / packed.segment);
    for (const channel of packed.channels) { channel.starts = new Uint32Array(rows * packed.segments); channel.groupStarts = new Uint32Array(rows * Math.ceil(stride / 32)); }
  }
  for (let ty0 = 0; ty0 < tileRows; ty0 += GB_TILE_ROWS) {
    const ty1 = Math.min(tileRows, ty0 + GB_TILE_ROWS), first = top + ty0 * 64, last = top + Math.min(ty1 * 64, rows * 8);
    const s0 = Math.max(0, first - iterations), s1 = Math.min(Hpad, last + iterations), n = s1 - s0;
    for (let tx0 = 0; tx0 < tileCols; tx0 += across) {
      const tx1 = Math.min(tileCols, tx0 + across), x0 = tx0 * 64, x1 = Math.min(tx1 * 64, W);
      const c0 = Math.max(0, x0 - halo), c1 = Math.min(W, x1 + halo), Wc = c1 - c0, real = Math.min(c1, width) - c0;
      const rgba = chunkAt, planes = rgba + (pre ? 0 : Math.ceil(n * real * bpe / 16) * 16), plane = n * Wc * S, orig = planes + 3 * plane, ring = orig + plane;
      const levels = ring + 2 * Wc * S, blocks = (tx1 - tx0 - 1) * 8 + Math.min(8, stride - (tx1 - 1) * 8), counts = levels + 3 * 8 * blocks * 128;
      if (pre) for (let c = 0; c < 3; c++) for (let y = s0; y < s1; y++) f64.set(pre[c].subarray(y * W + c0, y * W + c1), ((planes + c * plane) >> 3) + (y - s0) * Wc);
      else {
        if (c0 === 0 && real === width) {
          const direct = Math.min(s1, total) - s0, rowBytes = width * bpe;
          if (direct > 0) u8.set(layout.bytes.subarray(s0 * rowBytes, (s0 + direct) * rowBytes), rgba);
          const last = layout.bytes.subarray((total - 1) * rowBytes, total * rowBytes);
          for (let y = Math.max(s0, total); y < s1; y++) u8.set(last, rgba + (y - s0) * rowBytes);
        } else if (!(real * bpe & 3) && !(c0 * bpe & 3) && !(width * bpe & 3) && !(rgba & 3) && !(layout.bytes.byteOffset & 3)) {
          const words = real * bpe >> 2, from32 = new Int32Array(layout.bytes.buffer, layout.bytes.byteOffset, layout.bytes.length >> 2);
          for (let y = s0; y < s1; y++) copyWords(engine.i32, (rgba >> 2) + (y - s0) * words, from32, (Math.min(y, total - 1) * width + c0) * bpe >> 2, words);
        } else for (let y = s0; y < s1; y++) {
          const from = (Math.min(y, total - 1) * width + c0) * bpe;
          u8.set(layout.bytes.subarray(from, from + real * bpe), rgba + (y - s0) * real * bpe);
        }
        if (packed && packed.opaque) packed.opaque = engine.simd.opaque(rgba, n * real * 4) === 1;
        if (fast) engine.simd.fgXyb(rgba, real, n, Wc, GB_LIN, GB_MIX, Math.fround(bias), Math.fround(rootBias), planes);
        else engine.simd.xybRows(rgba, real, n, Wc, GB_ROOTS, linPtr, GB_MIX, bias, rootBias, GB_KEYS, GB_VALS, planes, layout.mode);
      }
      for (let c = 0; c < 3 && !pre && iterations > 0; c++) {
        const p = planes + c * plane, [w1, w2] = weights[c];
        if (fast) {
          const into = planes + GB_INTO[c] * plane;
          engine.simd.gab32From(p, into, Wc, n, Math.fround(w1), Math.fround(w2), Math.fround(norms[c]), Math.fround(job.boost ?? 1));
          for (let i = 1; i < iterations; i++) engine.simd.gab32(into, p, ring, Wc, n, Math.fround(w1), Math.fround(w2), Math.fround(norms[c]));
          continue;
        }
        u8.copyWithin(orig, p, p + plane);
        for (let i = 0; i < iterations; i++) engine.simd.gab(p, orig, ring, Wc, n, w1, w2, norms[c]);
      }
      for (let ty = ty0; ty < ty1; ty++) {
        const bh = Math.min(8, rows - ty * 8), bwLast = Math.min(8, stride - (tx1 - 1) * 8);
        if (fast) engine.simd.fgTiles(planes + GB_INTO[0] * plane, n, Wc, top + ty * 64 - s0, x0 - c0, tx1 - tx0, bwLast, bh, GB_TILE, GB_PAIRED, GB_QUANT, GB_THR, c84, levels, counts, GB_CFL, blocks,
          planes + GB_INTO[1] * plane, planes + GB_INTO[2] * plane);
        else engine.simd.gabTiles(planes, n, Wc, top + ty * 64 - s0, x0 - c0, tx1 - tx0, bwLast, bh, GB_TILE, GB_BASIS, GB_PAIRED,
          GB_SCRATCH, GB_QUANT, GB_THR, c84, levels, counts, GB_CFL, blocks, fieldsBytes ? fieldsAt : 0, stride, ty * 8, tx0 * 8);
        if (packed) { packTileRow(packed, levels, counts, bh, blocks, stride, ty * 8 * stride + tx0 * 8, u8); }
        else {
        const out = new Int16Array(buffer, levels, 3 * 8 * blocks * 64);
        for (let c = 0; c < 3; c++) for (let by = 0; by < bh; by++) {
          const from = (c * 8 + by) * blocks, block = (ty * 8 + by) * stride + tx0 * 8;
          components[c].coeffs.set(out.subarray(from * 64, (from + blocks) * 64), block * 64);
          nonZero[c].set(u8.subarray(counts + from, counts + from + blocks), block);
        }
        }
        for (let t = 0; t < tx1 - tx0; t++) { cfl.x[ty * tileWidth + tx0 + t] = i8[GB_CFL + t]; cfl.b[ty * tileWidth + tx0 + t] = i8[GB_CFL + tx1 - tx0 + t]; }
      }
    }
  }
  if (packed) packed.natural.set(new Uint32Array(engine.memory.buffer, GB_NAT, 192));
  return true;
}
const packTileRow = SAMPLE ? null : function packTileRow(packed, levels, counts, bh, blocks, stride, first, u8) {
  const entries = 3 * 8 * blocks, starts = counts + entries + 3 & ~3, dc = starts + 4 * entries, at = dc + 2 * entries, val = at + 63 * entries + 9 & ~1;
  const end = val + 126 * entries + 16;
  if (end > engine.memory.buffer.byteLength) throw fault('JXL_INTERNAL', 'kernels:tile-row-arena');
  const n = engine.simd.packLevels(levels, counts, bh, blocks, at, val, starts, dc, GB_NAT, 0, GB_PACK);
  const buffer = engine.memory.buffer, i32 = new Int32Array(buffer, starts, entries), i16 = new Int16Array(buffer, dc, entries);
  for (let c = 0; c < 3; c++) {
    const from = bh ? i32[c * 8 * blocks] : 0, to = c < 2 && bh ? i32[(c + 1) * 8 * blocks] : n, channel = packed.channels[c];
    const base = channel.total - from;
    if (channel.total + to - from > channel.at.length) {
      const size = Math.max(channel.total + to - from, channel.at.length * 2), grownAt = new Uint8Array(size), grownVal = new Int16Array(size);
      grownAt.set(channel.at.subarray(0, channel.total)); grownVal.set(channel.levels.subarray(0, channel.total));
      channel.at = grownAt; channel.levels = grownVal;
    }
    channel.at.set(u8.subarray(at + from, at + to), channel.total);
    channel.levels.set(new Int16Array(buffer, val + 2 * from, to - from), channel.total);
    channel.total += to - from;
    for (let by = 0; by < bh; by++) {
      const row = (c * 8 + by) * blocks, block = first + by * stride;
      channel.dc.set(i16.subarray(row, row + blocks), block);
      channel.counts.set(u8.subarray(counts + row, counts + row + blocks), block);
      channel.starts[(Math.floor(first / stride) + by) * packed.segments + (first % stride) / packed.segment] = base + i32[row];
      for (let k = 0, at = (Math.floor(first / stride) + by) * Math.ceil(stride / 32) + (first % stride) / 32; k * 32 < blocks; k++) channel.groupStarts[at + k] = base + i32[row + k * 32];
    }
  }
}

const rgbBand = SAMPLE || JPEG || UPLOAD ? null : function rgbBand(data, width, height, {components, tableOf, cflOf, basis, quantScale}) {
  if (active !== 'simd' || !engine.simd.rgbTile || !engine.simd.rgbQuant || !engine.simd.captureSelect || !engine.simd.packLevels
      || !(data instanceof Uint8Array || data instanceof Uint8ClampedArray) || !Number.isSafeInteger(width) || width < 1
      || !Number.isInteger(height) || height < 1 || height > 256 || data.length !== width * height * 4) return false;
  const stride = Math.ceil(width / 8), rows = Math.ceil(height / 8), W = stride * 8, H = rows * 8, entries = 3 * 8 * stride;
  const levels = GB_KEYS + 1024, counts = levels + entries * 128, starts = Math.ceil((counts + entries) / 4) * 4;
  const dc = starts + entries * 4, at = dc + entries * 2, val = Math.ceil((at + entries * 63 + 8) / 2) * 2;
  const pixels = Math.ceil((val + entries * 126 + 16) / 16) * 16, end = pixels + W * H * 4;
  if (end > GB_LIMIT) return false;
  if (data.buffer === engine.memory.buffer) data = Uint8Array.from(data);
  if (end > engine.memory.buffer.byteLength) growArena(end);
  const u8 = engine.u8, u32 = new Uint32Array(engine.memory.buffer), tiled = Math.ceil(stride / 8);
  for (let y = 0; y < H; y++) {
    const source = Math.min(height - 1, y) * width * 4, target = pixels + y * W * 4;
    u8.set(data.subarray(source, source + width * 4), target);
    if (W > width) u32.fill(u32[(target >> 2) + width - 1], (target >> 2) + width, (target >> 2) + W);
  }
  s2cPrepLoaded = -1;
  u8.set(PACK_TABLE, GB_PACK); engine.i32.fill(0, GB_NAT >> 2, (GB_NAT >> 2) + 192);
  const packed = {segment: stride, segments: 1, channels: [0, 1, 2].map(() => ({at: new Uint8Array(stride * rows * 4),
    levels: new Int16Array(stride * rows * 4), total: 0, counts: new Uint8Array(stride * rows), dc: new Int16Array(stride * rows),
    starts: new Uint32Array(rows), groupStarts: new Uint32Array(rows * Math.ceil(stride / 32))}))};
  const resident = {pixels, levels};
  for (let by = 0; by < rows; by += 8) {
    const bh = Math.min(8, rows - by);
    for (let bx = 0; bx < stride; bx += 8)
      if (!rgbTile(data, width, height, bx, by, Math.min(8, stride - bx), bh, tableOf,
        (rg, bg, gg) => cflOf((by >> 3) * tiled + (bx >> 3), rg, bg, gg), null, stride, basis, quantScale, resident)) return false;
    for (let c = 0; c < 3; c++) engine.simd.captureSelect(levels + c * 8 * stride * 128, counts + c * 8 * stride, bh * stride, 128, 3);
    packTileRow(packed, levels, counts, bh, stride, stride, by * stride, u8);
  }
  const natural = new Uint32Array(engine.memory.buffer, GB_NAT, 192).slice();
  for (let c = 0; c < 3; c++) {
    const channel = packed.channels[c], n = channel.total;
    components[c].coeffs = null;
    components[c].packed = {at: channel.at.slice(0, n), levels: channel.levels.slice(0, n), counts: channel.counts,
      starts: channel.starts, groupStarts: channel.groupStarts, segment: stride, dc: channel.dc,
      natural: natural.subarray(c * 64, c * 64 + 64), length: stride * rows * 64};
  }
  return true;
};

const VB_LOG2 = P, VB_BASES = P + 32768, VB_PIX = P + 54272, VB_TMP = P + 62464, VB_TR = P + 70656, VB_TABLES = P + 95232,
  VB_TABLES_END = R, VB_LEVELS = R, VB_OUT = R + 12288, VB_REGION = R + 12352, VB_REGION_END = PROPERTY, VB_STRIP = 4194304, VB_STRIP_ROWS = 32;
let vbRegionNext = VB_REGION;
let bandLast = null, vbLoaded = -1, vbSlots = null, vbNext = 0, vbBuffer = null, vbF64 = null, vbI32 = null, vbU8 = null, vbStrip = null;
const vbViewCache = new Map();
const vbViews = SAMPLE || UPLOAD || JPEG ? null : function vbViews() {
  if (vbBuffer !== engine.memory.buffer) { vbBuffer = engine.memory.buffer; vbF64 = new Float64Array(vbBuffer); vbI32 = new Int32Array(vbBuffer); vbU8 = new Uint8Array(vbBuffer); vbViewCache.clear(); }
};
const vbEnter = SAMPLE || UPLOAD || JPEG ? null : function vbEnter(log2, bases) {
  vbViews();
  if (vbLoaded !== retainEpoch) {
    acClean = false; ansStamp = null; zdLoaded = false; acBucketsZero = false; tileBand = null; acResident = null;
    vbF64.set(log2, VB_LOG2 >> 3);
    let at = VB_BASES >> 3;
    for (const size of [8, 16, 32]) { const {basis, basisT} = bases(size); vbF64.set(basis, at); vbF64.set(basisT, at + size * size); at += 2 * size * size; }
    const b4 = bases(4); vbF64.set(b4.basis, VB_TABLES >> 3); vbF64.set(b4.basisT, (VB_TABLES >> 3) + 16);
    vbSlots = new Map(); vbNext = VB_TABLES + 256; vbStrip = null;
    vbLoaded = ++retainEpoch;
  }
};
const vbSamePlanes = (strip, planes, top, W) => {
  if (strip.planes.has(planes)) return true;
  if (!planes[0]?.buffer?.wholePlane || strip.b0?.deref() !== planes[0].buffer || strip.b1?.deref() !== planes[1].buffer || strip.b2?.deref() !== planes[2].buffer) return false;
  const shift = top * W * 8;
  if (planes[0].byteOffset - shift !== strip.o0 || planes[1].byteOffset - shift !== strip.o1 || planes[2].byteOffset - shift !== strip.o2) return false;
  strip.planes.add(planes);
  return true;
};
const vbStripAt = SAMPLE || UPLOAD || JPEG ? null : function vbStripAt(planes, top, y, W, h) {
  const available = planes[0].length / W - (y - top);
  if (!vbStrip || !vbSamePlanes(vbStrip, planes, top, W) || vbStrip.W !== W || y < vbStrip.y || y + h > vbStrip.y + vbStrip.rows) {
    const rows = Math.min(available, Math.max(h, VB_STRIP_ROWS)), end = VB_STRIP + 3 * rows * W * 8;
    vbStrip = null; s2cPrepLoaded = -1;
    if (end <= engine.memory.buffer.byteLength || tryGrowArena(end)) {
      vbViews();
      for (let c = 0; c < 3; c++) vbF64.set(planes[c].subarray((y - top) * W, (y - top + rows) * W), (VB_STRIP >> 3) + c * rows * W);
      const whole = !!planes[0]?.buffer?.wholePlane, shift = top * W * 8;
      vbStrip = {planes: new WeakSet([planes]), W, y, rows,
        b0: whole ? new WeakRef(planes[0].buffer) : null, b1: whole ? new WeakRef(planes[1].buffer) : null, b2: whole ? new WeakRef(planes[2].buffer) : null,
        o0: planes[0].byteOffset - shift, o1: planes[1].byteOffset - shift, o2: planes[2].byteOffset - shift};
    }
    }
};
const vbBasis = size => VB_BASES + 8 * (size === 8 ? 0 : size === 16 ? 128 : 640);
const varblock = SAMPLE || UPLOAD || JPEG ? null : function varblock(log2, bases) {
  if (active !== 'simd' || !(log2 instanceof Float64Array) || log2.length !== 4096) return null;
  return {
    table(id, table, size, order, high, weights = null) {
      vbEnter(log2, bases);
      let slot = vbSlots.get(id);
      if (slot?.table === table && slot.epoch === vbLoaded) return slot;
      if (size > 1024 || table.planes.some(p => p.length !== size) || order.length !== size || high.length !== size) return null;
      const wBytes = weights ? size * 8 : 0;
      if (!slot || slot.size !== size || Boolean(slot.weights) !== Boolean(weights)) {
        const bytes = (size * 29 + wBytes + 7) & ~7;
        if (vbNext + bytes > VB_TABLES_END) { vbSlots.clear(); vbNext = VB_TABLES + 256; }
        if (vbNext + bytes > VB_TABLES_END) return null;
        slot = {size, steps: vbNext, weights: weights ? vbNext + size * 24 : 0, order: vbNext + size * 24 + wBytes, high: vbNext + size * 28 + wBytes};
        vbNext += bytes;
        vbSlots.set(id, slot);
      }
      slot.table = table; slot.epoch = vbLoaded;
      for (let c = 0; c < 3; c++) vbF64.set(table.planes[c], (slot.steps >> 3) + c * size);
      if (weights) vbF64.set(weights, slot.weights >> 3);
      vbI32.set(order, slot.order >> 2); vbU8.set(high, slot.high);
      return slot;
    },
    block(planes, top, x, y, W, w, h, from, to, id = 0) {
      vbEnter(log2, bases);
      vbStripAt(planes, top, y, W, h);
      const small = id === 3 || id === 12 || id === 13;
      for (let c = from; c <= to; c++) {
        const src = vbStrip ? VB_STRIP + 8 * (c * vbStrip.rows * W + (y - vbStrip.y) * W + x) : VB_PIX, str = vbStrip ? W : w;
        if (!vbStrip) for (let r = 0; r < h; r++) vbF64.set(planes[c].subarray((y - top + r) * W + x, (y - top + r) * W + x + w), (VB_PIX >> 3) + r * w);
        if (small) engine.simd.vbDct(src, str, 0, -id, VB_TABLES, vbBasis(8), VB_TMP, VB_TR + c * 8192);
        else engine.simd.vbDct(src, str, w, h, vbBasis(w) + 8 * w * w, vbBasis(h), VB_TMP, VB_TR + c * 8192);
      }
    },
    load(planes, at, size) {
      vbEnter(log2, bases);
      for (let c = 0; c < 3; c++) vbF64.set(planes[c].subarray(at, at + size), (VB_TR >> 3) + c * 1024);
    },
    row8: CAPTURE_PHOTO ? null : function row8(planes, top, x, y, W, n, slot, params, dead, ones, rc1, rc2, rates = null) {
      if (!engine.simd.vbRow8) return null;
      vbEnter(log2, bases);
      if (slot.epoch !== vbLoaded || slot.size !== 64) return null;
      if (W) {
        vbStripAt(planes, top, y, W, 8);
        if (!vbStrip) return null;
      } else {
        vbStrip = null; s2cPrepLoaded = -1;
      }
      const at = VB_STRIP + (W ? 3 * vbStrip.rows * W * 8 : 3 * n * 512), deadAt = at + n * 32, onesAt = deadAt + 48, dcAt = onesAt + 32, levelsAt = dcAt + n * 24, ratesAt = levelsAt + n * 768, end = ratesAt + (rates ? n * 8 : 0);
      if (end > engine.memory.buffer.byteLength && !tryGrowArena(end)) return null;
      vbViews();
      if (!W) for (let c = 0; c < 3; c++) vbF64.set(planes[c].subarray(x, x + n * 64), (VB_STRIP >> 3) + c * n * 64);
      vbF64.set(params.subarray(0, n * 4), at >> 3); vbF64.set(dead, deadAt >> 3); vbF64.set(ones, onesAt >> 3);
      const done = engine.simd.vbRow8(W ? VB_STRIP + 8 * ((y - vbStrip.y) * W + x) : VB_STRIP, W ? 8 * vbStrip.rows * W : n * 512, W, n, vbBasis(8) + 512, vbBasis(8), VB_TMP, VB_TR,
        slot.order, slot.steps, slot.high, VB_LOG2, at, deadAt, onesAt, rc1, rc2, levelsAt, dcAt, VB_OUT, rates ? rates[0] : 0, rates ? rates[1] : 0, rates ? ratesAt : 0);
      return {done, levels: vbI32.subarray(levelsAt >> 2, (levelsAt >> 2) + n * 192), dc: vbF64.subarray(dcAt >> 3, (dcAt >> 3) + n * 3),
        ...(rates && {rates: vbF64.subarray(ratesAt >> 3, (ratesAt >> 3) + n)})};
    },
    band: CAPTURE_PHOTO ? null : function band(planes, top, y, W, h, jobs, count, levelCount, slots, maxRun, ones, rc1, rc2) {
      if (!engine.simd.vbBand) return null;
      vbEnter(log2, bases);
      for (const [id, slot] of slots) if (slot.epoch !== vbLoaded || vbSlots.get(id) !== slot) return null;
      vbStripAt(planes, top, y, W, h);
      if (!vbStrip || y + h > vbStrip.y + vbStrip.rows) return null;
      const jobsAt = VB_STRIP + 3 * vbStrip.rows * W * 8, onesAt = jobsAt + ((jobs.length + 7) & ~7), levelsAt = onesAt + 32,
        dcsAt = levelsAt + 4 * levelCount, dcTmpAt = (dcsAt + 4 * (levelCount >> 6) + 7) & ~7, lowAt = dcTmpAt + 24 * maxRun, stopAt = lowAt + 512,
        bound = ((levelCount / 192) | 0) + 1, sizesAt = stopAt + 8, endsAt = sizesAt + 4 * bound, packAt = endsAt + 4 * bound, end = packAt + 8 * levelCount + 16 * bound;
      if (end > engine.memory.buffer.byteLength && !tryGrowArena(end)) return null;
      vbViews();
      vbU8.set(jobs, jobsAt);
      for (let j = 0, b32 = jobsAt >> 2; j < count; j++, b32 += 48) {
        const w = vbI32[b32] === 0 ? 8 : vbI32[b32 + 3], hh = vbI32[b32] === 0 ? 8 : vbI32[b32 + 4];
        vbI32[b32 + 15] = vbBasis(w) + 8 * w * w; vbI32[b32 + 22] = vbBasis(hh);
      }
      vbF64.set(ones, onesAt >> 3);
      vbI32[stopAt >> 2] = 0;
      const done = engine.simd.vbBand(jobsAt, count, VB_STRIP + 8 * (y - vbStrip.y) * W, 8 * vbStrip.rows * W, W, VB_TMP, VB_TR, VB_LOG2, onesAt, rc1, rc2,
        levelsAt, dcsAt, dcTmpAt, lowAt, VB_OUT, stopAt);
      bandLast = {levelsAt, sizesAt, endsAt, packAt, bound, epoch: vbLoaded};
      return {done, stop: vbI32[stopAt >> 2], levels: vbI32.subarray(levelsAt >> 2, (levelsAt >> 2) + levelCount), dcs: vbI32.subarray(dcsAt >> 2, (dcsAt >> 2) + (levelCount >> 6))};
    },
    pack: CAPTURE_PHOTO ? null : function pack(sizes, n) {
      if (!engine.simd.vbPack || !bandLast || bandLast.epoch !== vbLoaded || vbLoaded !== retainEpoch || n > bandLast.bound) return null;
      vbViews();
      const {levelsAt, sizesAt, endsAt, packAt} = bandLast;
      vbI32.set(sizes.subarray(0, n), sizesAt >> 2);
      const total = engine.simd.vbPack(levelsAt, sizesAt, n, packAt, endsAt);
      return {bytes: vbU8.subarray(packAt, packAt + total), ends: vbI32.subarray(endsAt >> 2, (endsAt >> 2) + n)};
    },
    priceRow8(planes, top, x, y, W, n, slot, params, dead, ones, rc0, rc1, rc2, rc3) {
      if (!engine.simd.vbPriceRow8) return null;
      vbEnter(log2, bases);
      if (slot.epoch !== vbLoaded || slot.size !== 64) return null;
      vbStripAt(planes, top, y, W, 8);
      if (!vbStrip) return null;
      const at = VB_STRIP + 3 * vbStrip.rows * W * 8, deadAt = at + n * 40, onesAt = deadAt + 48, drAt = onesAt + 56, end = drAt + n * 16;
      if (end > engine.memory.buffer.byteLength && !tryGrowArena(end)) return null;
      vbViews();
      vbF64.set(params.subarray(0, n * 5), at >> 3); vbF64.set(dead, deadAt >> 3); vbF64.set(ones, onesAt >> 3);
      const done = engine.simd.vbPriceRow8(VB_STRIP + 8 * ((y - vbStrip.y) * W + x), 8 * vbStrip.rows * W, W, n, vbBasis(8) + 512, vbBasis(8), VB_TMP, VB_TR,
        slot.order, slot.steps, slot.high, VB_LOG2, at, deadAt, onesAt, rc0, rc1, rc2, rc3, VB_OUT, drAt);
      return {done, dr: vbF64.subarray(drAt >> 3, (drAt >> 3) + done * 2)};
    },
    coefficients(c, size) {
      vbViews();
      const key = c * 4096 + size;
      let view = vbViewCache.get(key);
      if (!view) vbViewCache.set(key, view = vbF64.subarray((VB_TR >> 3) + c * 1024, (VB_TR >> 3) + c * 1024 + size));
      return view;
    },
    region() { vbRegionNext = VB_REGION; },
    reserve(size) {
      if (vbRegionNext + 12 * size > VB_REGION_END) return -1;
      const at = vbRegionNext;
      vbRegionNext += 12 * size;
      return at;
    },
    unreserve(at) { if (at >= 0) vbRegionNext = at; },
    epoch() { return vbLoaded === retainEpoch ? vbLoaded : -1; },
    levels(at, c, size) { vbViews(); return vbI32.subarray((at >> 2) + c * size, (at >> 2) + (c + 1) * size); },
    copyLevels(at, size, dst) { vbViews(); dst.set(vbI32.subarray(at >> 2, (at >> 2) + 3 * size)); },
    quant(c, slot, area, size, fc, lo, hi, fine, unit, one, detail, rc1, rc2, R, plane, sums = null, at = -1) {
      vbEnter(log2, bases);
      if (slot.epoch !== vbLoaded) return 0;
      const base = at >= 0 ? at + c * size * 4 : plane || !sums ? VB_LEVELS : 0;
      if (at >= 0 || plane) {
        const b32 = base >> 2, o32 = slot.order >> 2;
        if (area === 1) vbI32[b32] = 0;
        else for (let k = 0; k < area; k++) vbI32[b32 + vbI32[o32 + k]] = 0;
      }
      vbI32[(VB_TMP >> 2) + 6] = slot.weights || 0;
      vbI32[(VB_TMP >> 2) + 7] = 0;
      const made = engine.simd.vbQuant(VB_TR + c * 8192, c === 1 ? 0 : VB_TR + 8192, slot.order, slot.steps + c * size * 8, slot.high, area,
        size | 0x40000000, base, VB_LOG2, fc, lo, hi, fine, unit, one, detail, rc1, rc2, R, sums ? VB_TMP : 0);
      if (made === 1) return 0;
      if (plane) plane.set(vbI32.subarray(base >> 2, (base >> 2) + size));
      if (!sums) return made === 2 ? 2 : 1;
      sums[0] = vbF64[VB_TMP >> 3]; sums[1] = vbF64[(VB_TMP >> 3) + 1]; sums[2] = vbI32[(VB_TMP >> 2) + 4];
      const wide = vbI32[(VB_TMP >> 2) + 7];
      for (let i = 0; i < wide; i++) sums[1] += rc2 * Math.log2(vbI32[(VB_TMP >> 2) + 8 + i]);
      return wide ? 2 : 1;
    },
  };
};

function disableEntropyKernels() { entropyAllowed = false; kernelHooks.entropy = null; }
function ensureKernels() {
  if (active === 'simd') return true;
  try {
    if (typeof WebAssembly !== 'object' || new Uint8Array(new Uint32Array([1]).buffer)[0] !== 1) return false;
    if (!(kernelsSupported())) return false;
    engine ||= createEngine();
    active = 'simd';
    if (!SAMPLE && !JPEG) kernelHooks.weighted = weighted;
    if (!SAMPLE && !JPEG) kernelHooks.fill = fill;
    if (!SAMPLE && !JPEG && kernelHooks.fill) kernelHooks.group = group;
    if (!SAMPLE && !JPEG) { kernelHooks.palette = paletteFill; kernelHooks.rct = rctFill; kernelHooks.tuple = tupleIndex; if ((typeof __RAPIER_JXL_PROGRESSIVE__ === 'undefined' || __RAPIER_JXL_PROGRESSIVE__ === true)) kernelHooks.passLevels = passLevels; }
    if (!SAMPLE && !JPEG) kernelHooks.screen = screen;
    if (!SAMPLE) { kernelHooks.sampled = sampled; }
    if (!SAMPLE && !JPEG) { kernelHooks.dct = dct; kernelHooks.dctFast = dctFast; kernelHooks.xybPlanes = xybPlanesKernel; kernelHooks.ycbcrTile = ycbcrTile; kernelHooks.ycbcrTiles = ycbcrTiles; kernelHooks.rgbTiles = rgbTile; kernelHooks.rgbBand = rgbBand; }
    if (!SAMPLE && !JPEG) kernelHooks.photoTile = photoTile;
    if (!SAMPLE) { kernelHooks.acGroup = acGroup; kernelHooks.acGroupPair = acGroupPair; kernelHooks.acDeferred = deferredCounts; }
    if (!SAMPLE) kernelHooks.nonzero = nonzero;
    if (!SAMPLE && !JPEG) kernelHooks.opaque = opaqueBytes;
    if (!SAMPLE) { kernelHooks.dcEvents = dcEvents; kernelHooks.dcPlan = dcPlan; kernelHooks.planTokens = planTokens; }
    if (!SAMPLE) kernelHooks.shape = shape;
    if (!SAMPLE && !UPLOAD && !JPEG) {
      kernelHooks.varblock = varblock;
      kernelHooks.gaborish = gaborish;
      kernelHooks.s2cChannel = s2cChannel;
      kernelHooks.s2cPrep = s2cPrep;
    }
    if (!SAMPLE && !UPLOAD && !JPEG) { kernelHooks.strategyFill = strategyFill; kernelHooks.strategyWrite = strategyWrite; }
    if (!SAMPLE && !JPEG) kernelHooks.gabBand = gabBand;
    if ((!SAMPLE && !(typeof __RAPIER_JXL_CLI__ !== 'undefined' && __RAPIER_JXL_CLI__ === true)) && entropyAllowed) kernelHooks.entropy = entropyKernels;
    for (const name of OWN_HOOKS) if (kernelHooks[name]) kernelHooks[name] = entered(kernelHooks[name]);
  } catch { active = 'off'; for (const name of OWN_HOOKS) kernelHooks[name] = null; }
  return active === 'simd';
}
async function prepareKernels() {
  if (typeof WebAssembly !== 'object' || new Uint8Array(new Uint32Array([1]).buffer)[0] !== 1) return false;
  if (!(kernelsSupported())) return false;
  return compileKernels();
}
const lendEntropy = (SAMPLE || (typeof __RAPIER_JXL_CLI__ !== 'undefined' && __RAPIER_JXL_CLI__ === true)) || (typeof __RAPIER_JXL_CAPTURE_PHOTO__ !== 'undefined' && __RAPIER_JXL_CAPTURE_PHOTO__ === true) ? () => null : /* @__PURE__ */ Object.assign(() => capJpegKernels(ARENA_BYTES, flushTokens), {release: releaseJpegKernels});
const arenaKernels = ((SAMPLE || (typeof __RAPIER_JXL_CLI__ !== 'undefined' && __RAPIER_JXL_CLI__ === true)) || (typeof __RAPIER_JXL_CAPTURE_PHOTO__ !== 'undefined' && __RAPIER_JXL_CAPTURE_PHOTO__ === true)) ? null : capJpegKernels;
const releaseArena = ((SAMPLE || (typeof __RAPIER_JXL_CLI__ !== 'undefined' && __RAPIER_JXL_CLI__ === true)) || (typeof __RAPIER_JXL_CAPTURE_PHOTO__ !== 'undefined' && __RAPIER_JXL_CAPTURE_PHOTO__ === true)) ? null : releaseJpegKernels;
if (!SAMPLE) kernelHooks.keptScope = keptScope;
kernelHooks.ensure = ensureKernels;
if (!SAMPLE && !JPEG) kernelHooks.capturePhoto = {prepare: prepareKernels, ready: ensureKernels, opaque: captureOpaque};
return {ensureKernels, disableEntropyKernels, prepareKernels, arenaKernels, releaseArena, lendEntropy, orientBlock, pngRow, sampleTable, sampleBands, writeAnsTokens: flushTokens};
})();
