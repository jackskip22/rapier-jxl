import {kernelModule, compileKernels, kernelsSupported} from './kernel-runtime.mjs';
// The WebAssembly kernels every encoder's pixel loops run in. MIT (images/jxl/LICENSE).
import {kernelHooks} from './kernel-hooks.mjs';
import {ARENA_BYTES} from './arena.mjs';
import {jpegKernels, capJpegKernels, releaseJpegKernels} from './jpeg-kernels.mjs';
import {WEIGHTED_BUCKET, weightedTables} from './weighted-policy.mjs';
import {BitWriter} from './bits.mjs';
import {hybridToken} from './prefix.mjs';
import {fault} from './admit.mjs';

export const {configureKernels, ensureKernels, kernelMode, kernelRequest, disableEntropyKernels, prepareKernels, arenaKernels, releaseArena, orientBlock, sampleTable, sampleFilter, sampleSum, sampleFinish} = (() => {
const UPLOAD = typeof __RAPIER_JXL_UPLOAD__ !== 'undefined' && __RAPIER_JXL_UPLOAD__ === true;
const JPEG = typeof __RAPIER_JXL_JPEG__ !== 'undefined' && __RAPIER_JXL_JPEG__ === true;
const SAMPLE = typeof __RAPIER_JXL_SAMPLE__ !== 'undefined' && __RAPIER_JXL_SAMPLE__ === true;
const P = 65536, R = 327680, PROPERTY = 589824, CONTEXT = 851968;
const OUTPUT = 1114128, TABLE = 1642496, SOURCE = 1769472, STATE = 2097152;
const DIV = 16, WEIGHTS = 272, BUCKET = 16656, MAP = 20672, ALPHABET = 257;
let engine, active = 'off', explicit = false, entropyAllowed = true, hasPartsFilter = false;
const acceptablePlane = (p, w, h, offset, limit = 65536) => p instanceof Int16Array && Number.isInteger(w) && Number.isInteger(h) && w > 0 && h > 0 && w <= 16384 && w * h <= limit && p.length >= w * h && Number.isInteger(offset) && Math.abs(offset) <= 32768;
const acceptableWriter = w => !w || (w instanceof BitWriter && w.write === BitWriter.prototype.write && w.grow === BitWriter.prototype.grow);
const PLAIN = {split: 0, msb: 0, lsb: 0};
const acceptableConfig = c => Number.isInteger(c.split) && Number.isInteger(c.msb) && Number.isInteger(c.lsb) && c.split >= 0 && c.split <= 15 && c.msb >= 0 && c.lsb >= 0 && c.msb + c.lsb <= c.split && (1 << c.split) + ((19 - c.split) << (c.msb + c.lsb)) <= 224;
const RAW_BINS = 4096 + 33;
const GROUP_PLANES = [P, PROPERTY, CONTEXT, STATE];

function createEngine() {
  const memory = new WebAssembly.Memory({initial: 48, maximum: 272});
  const simd = new WebAssembly.Instance(kernelModule(), {env: {memory}}).exports;
  const u8 = new Uint8Array(memory.buffer), i32 = new Int32Array(memory.buffer);
  initializeTables?.(i32);
  return {memory, simd, u8, i32};
}

const initializeTables = SAMPLE ? null : i32 => { weightedTables(i32, DIV, WEIGHTS); i32.set(WEIGHTED_BUCKET, BUCKET >> 2); };

const orientBlock = JPEG ? null : function orientBlock(from, to, stride, outStride, x, y, width, height, ox, oy, pixelBytes, orientation) {
  if (active !== 'simd' || !engine.simd.orientRGBA) throw fault('JXL_WASM', 'The sample orientation kernel is unavailable.');
  if (!(from instanceof Uint8Array) || !(to instanceof Uint8Array) || ![4, 8, 16].includes(pixelBytes) ||
      !Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 256 || height > 256 ||
      !Number.isInteger(orientation) || orientation < 1 || orientation > 8)
    throw fault('JXL_INTERNAL', 'Invalid sample orientation block.');
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

const SAMPLE_LINEAR = P + 262144, SAMPLE_FILTER = P + 786432, SAMPLE_SUM = P + 1310720, SAMPLE_OUT = P + 1835008, SAMPLE_TABLE = P + 2097152, SAMPLE_LEVELS = P + 2621440;
let heldSampleTable = null, sampleTableEpoch = -1;
const sampleScratch = JPEG ? null : function sampleScratch() {
  if (active !== 'simd' || !engine.simd.sampleRead) throw fault('JXL_WASM', 'The sample resampling kernel is unavailable.');
  const held = sampleTableEpoch === retainEpoch;
  acClean = false; ansStamp = null; zdLoaded = false; acBucketsZero = false; tileBand = null; acResident = null; retainEpoch++;
  if (held) sampleTableEpoch = retainEpoch;
  return engine.memory.buffer;
};
const sampleStatus = JPEG ? null : function sampleStatus(status) {
  if (status) throw fault('JXL_INPUT', [null, 'Resampling requires finite alpha between zero and one.',
    'Resampling requires finite color samples.', 'PQ resampling requires samples between zero and one.',
    'HLG resampling requires nonnegative samples.', 'The resampled value exceeds the sample format.'][status]);
};
const sampleTable = JPEG ? null : function sampleTable(maximum, transfer) {
  if (![255, 1023, 4095, 65535].includes(maximum) || ![0, 1, 2, 3].includes(transfer))
    throw fault('JXL_INTERNAL', 'Invalid sample transfer table.');
  const buffer = sampleScratch(); engine.simd.sampleTable(transfer, maximum, SAMPLE_TABLE, 0);
  heldSampleTable = new Float64Array(buffer, SAMPLE_TABLE, maximum + 1).slice();
  sampleTableEpoch = retainEpoch;
  return heldSampleTable;
};
const sampleFilter = JPEG ? null : function sampleFilter(data, row, width, target, config, table) {
  if (!Number.isInteger(width) || !Number.isInteger(target) || width < 1 || width > 16384 || target < 1 || target > 16384 ||
      !Number.isInteger(row) || row < 0 || (row + 1) * width * 4 > data.length || ![1, 2, 4].includes(data.BYTES_PER_ELEMENT))
    throw fault('JXL_INTERNAL', 'Invalid sample resampling row.');
  const buffer = sampleScratch(), bytes = new Uint8Array(buffer), length = width * 4 * data.BYTES_PER_ELEMENT;
  bytes.set(new Uint8Array(data.buffer, data.byteOffset + row * length, length), P);
  if (table && (heldSampleTable !== table || sampleTableEpoch !== retainEpoch)) {
    new Float64Array(buffer).set(table, SAMPLE_TABLE >> 3);
    heldSampleTable = table; sampleTableEpoch = retainEpoch;
  }
  sampleStatus(engine.simd.sampleRead(P, width, ...config, SAMPLE_LINEAR, table ? SAMPLE_TABLE : 0));
  engine.simd.sampleHorizontal(SAMPLE_LINEAR, width, target, SAMPLE_FILTER);
  return new Float64Array(buffer, SAMPLE_FILTER, target * 4).slice();
};
const sampleSum = JPEG ? null : function sampleSum(sum, row, weight) {
  if (!(sum instanceof Float64Array) || !(row instanceof Float64Array) || row.length !== sum.length ||
      !sum.length || sum.length > 65536 || sum.length % 4 || !Number.isFinite(weight) || weight < 0 || weight > 1)
    throw fault('JXL_INTERNAL', 'Invalid sample accumulation row.');
  const buffer = sampleScratch(), view = new Float64Array(buffer);
  view.set(row, SAMPLE_FILTER >> 3); view.set(sum, SAMPLE_SUM >> 3);
  engine.simd.sampleAccumulate(SAMPLE_FILTER, SAMPLE_SUM, sum.length, weight);
  sum.set(new Float64Array(buffer, SAMPLE_SUM, sum.length));
};
let heldLevels = null, heldLevelsKey = '';
const sampleFinish = JPEG ? null : function sampleFinish(sum, out, row, width, config, levels = false) {
  if (!(sum instanceof Float64Array) || sum.length !== width * 4 || width < 1 || width > 16384 ||
      !Number.isInteger(row) || row < 0 || (row + 1) * width * 4 > out.length || ![1, 2, 4].includes(out.BYTES_PER_ELEMENT) ||
      levels && !(config[0] < 2 && [255, 1023, 4095].includes(config[1]) && !config[3] && config[4] === 1))
    throw fault('JXL_INTERNAL', 'Invalid resampled output row.');
  const buffer = sampleScratch(), key = config[1] + ':' + config[2];
  if (levels && heldLevelsKey !== key) {
    engine.simd.sampleTable(config[2], config[1], SAMPLE_OUT, SAMPLE_LEVELS);
    heldLevels = new Uint8Array(buffer, SAMPLE_LEVELS, 32768 + 4097 * 4).slice(); heldLevelsKey = key;
  } else if (levels) new Uint8Array(buffer).set(heldLevels, SAMPLE_LEVELS);
  new Float64Array(buffer).set(sum, SAMPLE_SUM >> 3);
  sampleStatus(engine.simd.sampleFinish(SAMPLE_SUM, width, ...config, SAMPLE_OUT, levels ? SAMPLE_LEVELS : 0));
  const length = width * 4 * out.BYTES_PER_ELEMENT;
  new Uint8Array(out.buffer, out.byteOffset + row * length, length).set(new Uint8Array(buffer, SAMPLE_OUT, length));
};

const tokens = SAMPLE ? null : function tokens(w, targets, count, contexts, config = PLAIN, rawLength = 0) {
  acClean = false; ansStamp = null; zdLoaded = false; acBucketsZero = false; tileBand = null; acResident = null; retainEpoch++;
  const {simd, i32, u8} = engine, stride = rawLength || ALPHABET;
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
  const written = simd.tokens(R, contexts, count, TABLE, OUTPUT, w ? 1 : 0, w ? w.acc : 0, w ? w.pending : 0, config.split, config.msb, config.lsb, rawLength);
  if (w) {
    if (w.at + written + 8 >= w.bytes.length) w.grow(written + 8);
    w.bytes.set(u8.subarray(OUTPUT, OUTPUT + written), w.at);
    w.at += written; w.acc = i32[(OUTPUT - 8) >> 2]; w.pending = i32[(OUTPUT - 4) >> 2];
  } else for (let c = 0; c < targets.length; c++) targets[c].set(i32.subarray((TABLE >> 2) + c * stride, (TABLE >> 2) + (c + 1) * stride));
  return true;
}
const channel = SAMPLE ? null : function channel(w, target, plane, width, height, leaf, raw) {
  acClean = false; ansStamp = null; zdLoaded = false; acBucketsZero = false; tileBand = null; acResident = null; retainEpoch++;
  const config = leaf.config || PLAIN;
  if (!acceptablePlane(plane, width, height, leaf.offset) || leaf.multiplier !== 1 || !Number.isInteger(leaf.predictor) || leaf.predictor < 0 || leaf.predictor > 5 || !acceptableWriter(w) || !acceptableConfig(config)) return false;
  if (raw && (w || !(target instanceof Uint32Array) || target.length < 34 || target.length > RAW_BINS)) return false;
  const n = width * height;
  if (w && w.at + n * 8 + 32 > 0x7fffffff) return false;
  engine.i32.set(plane.subarray(0, n), P >> 2);
  engine.simd.residual(P, width, height, leaf.predictor, leaf.offset, R);
  return tokens(w, [target], n, 0, config, raw ? target.length : 0);
}
const weighted = SAMPLE ? null : function weighted(w, targets, plane, width, height, offset, contextOf, residuals, properties) {
  acClean = false; ansStamp = null; zdLoaded = false; acBucketsZero = false; tileBand = null; acResident = null; retainEpoch++;
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
  const {i32, simd} = engine;
  i32.set(plane.subarray(0, n), P >> 2); i32.set(contextOf, MAP >> 2);
  i32.fill(0, state >> 2, (state >> 2) + (width + 2) * 10);
  if (residuals && properties && offset === 0) simd.wpDc(P, width, height, residual, property, DIV, WEIGHTS, state);
  else simd.weighted(P, width, height, offset, residual, property, context, MAP, BUCKET, DIV, WEIGHTS, state);
  if (residuals) {
    residuals.set(i32.subarray(residual >> 2, (residual >> 2) + n));
    if (properties) properties.set(i32.subarray(property >> 2, (property >> 2) + n));
    return true;
  }
  if (properties) properties.set(i32.subarray(PROPERTY >> 2, (PROPERTY >> 2) + n));
  return tokens(w, targets, n, CONTEXT);
}
const fill = SAMPLE || JPEG ? null : function fill(rgba, imageWidth, x0, y0, w, h, channels, planes) {
  acClean = false; ansStamp = null; zdLoaded = false; acBucketsZero = false; tileBand = null; acResident = null; retainEpoch++;
  const n = w * h;
  if (n < 1 || n > 65536 || channels < 1 || channels > 4) return false;
  const {u8, i32} = engine;
  for (let y = 0; y < h; y++) {
    const at = ((y0 + y) * imageWidth + x0) * 4;
    u8.set(rgba.subarray(at, at + w * 4), SOURCE + y * w * 4);
  }
  engine.simd.fill(SOURCE, n, channels, P, R, PROPERTY, CONTEXT);
  for (let c = 0; c < channels; c++) {
    const at = [P, R, PROPERTY, CONTEXT][c] >> 2;
    planes[c].set(i32.subarray(at, at + n));
  }
  return true;
}

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

const rgbTile = JPEG || SAMPLE || UPLOAD ? null : function rgbTile(data, width, height, bx0, by0, bw, bh, tableOf, cflOf, planes, stride, basis, quantScale, resident = null) {
  if (active !== 'simd' || !engine.simd.rgbTile || !(data instanceof Uint8Array || data instanceof Uint8ClampedArray) || !(bw >= 1 && bw <= 8 && bh >= 1 && bh <= 8)) return false;
  const SCRATCH = P + 98304, SRC = SCRATCH + 512, OUT = SRC + 16384, SUMS = OUT + 24576, TABS = SUMS + 32, TABLES = TABS + 256;
  acClean = false; ansStamp = null; zdLoaded = false; acBucketsZero = false; tileBand = null; acResident = null; retainEpoch++;
  const buffer = engine.memory.buffer, u8 = new Uint8Array(buffer), f64 = new Float64Array(buffer), i32 = new Int32Array(buffer);
  const count = bw * bh, slots = new Map();
  for (let n = 0; n < count; n++) {
    const t = tableOf(by0 + (n / bw | 0), bx0 + n % bw);
    let at = slots.get(t);
    if (at === undefined) {
      at = TABLES + slots.size * 3072;
      if (at + 3072 > R || t.length !== 384) return false;
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

const TILE_ROOTS = 20816, TILE_LINEAR = 53728, TILE_SCALE = 55776, TILE_STEPS = 56288, TILE_LIMITS = 57824;
const TILE_F64 = P + 16384;
let tileTables = null, tileBand = null;
let retainEpoch = 0;
const TILE_BAND = 12582912;
const TILE_SUMS = P + 150160, TILE_OUT = P + 153256, TILE_COUNTS = P + 177832;
const photoTile = JPEG || SAMPLE ? null : function photoTile(data, width, height, bx0, by0, bw, bh, tables, cfl, components, stride, nonZero) {
  retainEpoch++;
  if (active !== 'simd' || !(data instanceof Uint8Array || data instanceof Uint8ClampedArray) || !Number.isInteger(bw) || !Number.isInteger(bh) ||
      bw < 1 || bw > 8 || bh < 1 || bh > 8 || tables.roots.length !== 4113 || tables.linear.length !== 256) return false;
  const padded = stride * 32, end = TILE_BAND + 64 * padded;
  if (end > engine.memory.buffer.byteLength) {
    try { engine.memory.grow(Math.ceil((end - engine.memory.buffer.byteLength) / 65536)); } catch { return false; }
    engine.u8 = new Uint8Array(engine.memory.buffer); engine.i32 = new Int32Array(engine.memory.buffer);
  }
  const source = acIdentity(data);
  if (tileBand?.tables !== tables || tileBand.source !== source || tileBand.width !== width || tileBand.height !== height ||
      tileBand.stride !== stride || tileBand.by0 !== by0 || tileBand.bh !== bh) {
    acClean = false; ansStamp = null; zdLoaded = false; acBucketsZero = false; acResident = null;
    const u8 = new Uint8Array(engine.memory.buffer), rowWidth = width * 4, padWidth = (stride * 8 - width) * 4;
    for (let y = 0; y < bh * 8; y++) {
      const at = Math.min(height - 1, by0 * 8 + y) * rowWidth, row = TILE_BAND + y * padded;
      u8.set(data.subarray(at, at + rowWidth), row);
      if (padWidth > 0) {
        const lastPixel = data[at + rowWidth - 4] | (data[at + rowWidth - 3] << 8) | (data[at + rowWidth - 2] << 16) | (data[at + rowWidth - 1] << 24);
        engine.i32.fill(lastPixel, (row + rowWidth) >> 2, (row + rowWidth + padWidth) >> 2);
      }
    }
    tileBand = {tables, source, width, height, stride, by0, bh};
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
const flushTokens = SAMPLE ? null : function flushTokens(w, model, values, ids, n) {
  acClean = false; zdLoaded = false; acBucketsZero = false; tileBand = null; acResident = null; retainEpoch++;
  const ans = ansTablesOf(model);
  const A_SMALL = AC_CODES, A_FREQS = A_SMALL + ans.ids * 256, A_STARTS = A_FREQS + ans.ids * 256, A_REVERSE = A_STARTS + ans.ids * 256;
  const A_CONFIGS = A_REVERSE + ans.ids * 8192, A_COUNTS = A_CONFIGS + ans.ids * 16, A_SYMBOL_STARTS = A_COUNTS + ans.ids * ans.alphabet * 4;
  const A_RECIPS = A_SYMBOL_STARTS + ans.ids * ans.alphabet * 4 + 7 & ~7, A_VALUES = A_RECIPS + RECIPS_BYTES, A_IDS = A_VALUES + n * 4;
  const A_RAWS = A_IDS + n + 8 & ~7, A_META = A_RAWS + n * 4, A_EMITTED = A_META + n + 8 & ~7, OUT = A_EMITTED + n * 2 + 8 & ~7, end = OUT + n * 8 + 16;
  if (end > engine.memory.buffer.byteLength) {
    try { engine.memory.grow(Math.ceil((end - engine.memory.buffer.byteLength) / 65536)); }
    catch (cause) { throw Object.assign(fault('JXL_MEMORY', 'The ANS writer cannot grow its kernel memory.'), {cause}); }
    engine.u8 = new Uint8Array(engine.memory.buffer); engine.i32 = new Int32Array(engine.memory.buffer);
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
const entropyKernels = SAMPLE ? null : () => jpegKernels(flushTokens);
const takeFlushed = SAMPLE ? null : function takeFlushed(w, args, out) {
  const i32 = new Int32Array(engine.memory.buffer), written = i32[(args >> 2) + 17];
  if (w.at + written + 8 >= w.bytes.length) w.grow(written + 8);
  w.bytes.set(new Uint8Array(engine.memory.buffer, out, written), w.at);
  w.at += written; w.acc = i32[(args >> 2) + 15]; w.pending = i32[(args >> 2) + 16];
}
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
  if (acDeferred && (!defer || acDeferred.counts !== sink.counts || acDeferred.hist !== HIST_KEY(contexts))) throw new Error('Deferred AC counts were not taken.');
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
  if (end > engine.memory.buffer.byteLength) {
    try { engine.memory.grow(Math.ceil((end - engine.memory.buffer.byteLength) / 65536)); } catch { return false; }
    engine.u8 = new Uint8Array(engine.memory.buffer); engine.i32 = new Int32Array(engine.memory.buffer);
  }
  const buffer = engine.memory.buffer, u8 = new Uint8Array(buffer), i32 = new Int32Array(buffer), i16 = new Int16Array(buffer), u16 = new Uint16Array(buffer);
  if (!sink.counts) acClean = false;
  else {
    if (!acClean || acCleanBytes < histBytes) {
      if (acDeferred) throw new Error('Deferred AC counts were overwritten.');
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
      const {at, levels, starts, segment, groupStarts} = comps[c].packed, counts = source[c], segments = Math.ceil(stride / segment), s0 = Math.floor(bx0 / segment);
      for (let y = 0; y < bh; y++) {
        const row = (by0 + y) * stride, first = row + bx0;
        let from;
        if (groupStarts) from = groupStarts[(by0 + y) * Math.ceil(stride / 32) + bx0 / 32];
        else { from = starts[(by0 + y) * segments + s0]; for (let b = row + s0 * segment; b < first; b++) from += counts[b]; }
        let to = from;
        for (let b = first; b < first + bw; b++) to += counts[b];
        u8.set(at.subarray(from, to), STAGE_AT + staged);
        i16.set(levels.subarray(from, to), (STAGE_VAL >> 1) + staged);
        staged += to - from;
        u8.set(counts.subarray(first, first + bw), AC_COUNTS + c * blocks + y * bw);
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
  acResident = {g, bw, bh, c0, c1, c2, s0, s1, s2};
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
    ans ? 2 : codes ? 1 : keep ? 3 : 0, HIST, TOUCHED + 4 * (acDeferred?.touched ?? 0), OVERFLOW, 0, 0, AC_MAP, AC_CONFIGS, AC_CODES, alphabet, OUT, w ? w.acc : 0, w ? w.pending : 0, 0,
    ans ? A_VALUES : keep ? OUT : 0, ans ? A_IDS : keep ? OUT + tokens * 4 : 0, 0], AC >> 2);
  engine.simd.acGroup(AC);
  if (keep) { const n = i32[(AC >> 2) + 28]; sink.kept = {values: i32.slice(OUT >> 2, (OUT >> 2) + n), ctxs: u16.slice((OUT + tokens * 4) >> 1, ((OUT + tokens * 4) >> 1) + n)}; }
  }
  if (ans) {
    const args = AC_CONFIGS + 4096 - 128, n = kept ? kept.values.length : i32[(AC >> 2) + 28];
    const tables = [A_SMALL, A_FREQS, A_STARTS, A_REVERSE, A_CONFIGS, A_COUNTS, A_SYMBOL_STARTS, ans.alphabet];
    if (pair && !pair.args) {
      const park = A_VALUES + 23 * 3 * 1024 * 64 + 256 + 15 & ~15, P_IDS = park + n * 4, P_RAWS = P_IDS + n + 8 & ~7, P_META = P_RAWS + n * 4;
      const P_EMITTED = P_META + n + 8 & ~7, P_OUT = P_EMITTED + n * 2 + 8 & ~7, P_END = P_OUT + n * 8 + 16;
      if (P_END > 272 * 65536) return false;
      if (P_END > engine.memory.buffer.byteLength) {
        try { engine.memory.grow(Math.ceil((P_END - engine.memory.buffer.byteLength) / 65536)); } catch { return false; }
        engine.u8 = new Uint8Array(engine.memory.buffer); engine.i32 = new Int32Array(engine.memory.buffer);
      }
      const bytes = new Uint8Array(engine.memory.buffer);
      bytes.copyWithin(park, A_VALUES, A_VALUES + n * 4); bytes.copyWithin(P_IDS, A_IDS, A_IDS + n);
      pair.args = [park, P_IDS, n, ...tables, P_RAWS, P_META, P_EMITTED, P_OUT, w.acc, w.pending, 0, A_RECIPS];
      pair.w = w; pair.out = P_OUT; pair.model = sink.coding.model;
      return 3;
    }
    i32.set([A_VALUES, A_IDS, n, ...tables, A_RAWS, A_META, A_EMITTED, OUT, w.acc, w.pending, 0, A_RECIPS], args >> 2);
    if (pair) {
      if (pair.model !== sink.coding.model) throw new Error('A pair of AC groups crosses models.');
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
  if (codes) {
    const written = i32[(AC >> 2) + 25];
    if (w.at + written + 8 >= w.bytes.length) w.grow(written + 8);
    w.bytes.set(u8.subarray(OUT, OUT + written), w.at);
    w.at += written; w.acc = i32[(AC >> 2) + 23]; w.pending = i32[(AC >> 2) + 24];
    return true;
  }
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
  if (!acClean) throw new Error('Deferred AC counts were overwritten.');
  takeCounts(counts, at, list, touched, bytes);
}

const wpTokens = SAMPLE ? null : function wpTokens(flat, errors, weighted, n, leaves, alphabet) {
  const WP_RUNS = P + 1024, WP_ERRORS = P + 2048, WP_WEIGHTED = WP_ERRORS + 4 * n, WP_TAGS = WP_WEIGHTED + 4 * n, WP_EXTRA = WP_TAGS + 4 * n, WP_FREQS = WP_EXTRA + 4 * n;
  if (active !== 'simd' || n > 65536 || flat.length > 256 || leaves * alphabet > 65536 || WP_FREQS + 4 * leaves * alphabet > AC) return null;
  acClean = false; ansStamp = null; zdLoaded = false; acBucketsZero = false; tileBand = null; acResident = null; retainEpoch++;
  const i32 = new Int32Array(engine.memory.buffer);
  i32.set(flat, P >> 2); i32.set(errors.subarray(0, n), WP_ERRORS >> 2); i32.set(new Int32Array(weighted.buffer, weighted.byteOffset, n), WP_WEIGHTED >> 2);
  i32.fill(0, WP_FREQS >> 2, (WP_FREQS >> 2) + leaves * alphabet);
  const used = engine.simd.wpTokens(P, WP_ERRORS, WP_WEIGHTED, n, WP_TAGS, WP_EXTRA, WP_FREQS, alphabet, WP_RUNS);
  const freqs = Array.from({length: leaves}, (_, l) => Uint32Array.from(new Uint32Array(engine.memory.buffer, WP_FREQS + 4 * l * alphabet, alphabet)));
  const tags = new Uint32Array(errors.buffer, errors.byteOffset, n), extra = weighted;
  tags.set(new Uint32Array(engine.memory.buffer, WP_TAGS, used)); extra.set(new Uint32Array(engine.memory.buffer, WP_EXTRA, used));
  return {freqs, tags, extra, used};
}

const GE_PLANE = P, GE_COUNTS = P + 131072, GE_TOUCHED = GE_COUNTS + 4 * (131072 + 33) + 12, GE_STATS = GE_TOUCHED + 4 * 65536;
const dcEvents = SAMPLE ? null : function dcEvents(planes) {
  if (active !== 'simd' || planes.some(p => !(p.data instanceof Int16Array) || !(p.w > 0 && p.h > 0) || p.w * p.h > 65536 || p.data.length < p.w * p.h)) return null;
  acClean = false; ansStamp = null; zdLoaded = false; acBucketsZero = false; tileBand = null; acResident = null; retainEpoch++;
  const buffer = engine.memory.buffer, i16 = new Int16Array(buffer), u32 = new Uint32Array(buffer);
  return planes.map(({data, w, h}) => {
    u32.fill(0, GE_COUNTS >> 2, (GE_COUNTS >> 2) + 131072 + 33);
    i16.set(data.subarray(0, w * h), GE_PLANE >> 1);
    engine.simd.gradEvents(GE_PLANE, w, h, GE_COUNTS, GE_TOUCHED, GE_STATS);
    const touched = u32[(GE_STATS >> 2) + 2], literalPairs = new Uint32Array(2 * touched);
    for (let i = 0; i < touched; i++) { const v = u32[(GE_TOUCHED >> 2) + i]; literalPairs[2 * i] = v; literalPairs[2 * i + 1] = u32[(GE_COUNTS >> 2) + v]; }
    return {literalPairs, literalPairsLen: 2 * touched, lengths: u32.slice((GE_COUNTS >> 2) + 131072, (GE_COUNTS >> 2) + 131072 + 33)};
  });
}

const HP_TAGS = P, HP_EXTRA = P + 262144, HP_LAYOUT = P + 524288, HP_CFGS = HP_LAYOUT + 2048, HP_COUNTS = HP_CFGS + 4096;
const HP_ROOM = (AC - HP_COUNTS) >> 2;
const hybridPlan = SAMPLE ? null : function hybridPlan(plan, sizes) {
  const {tags, extra, used} = plan, contexts = sizes.length;
  if (active !== 'simd' || !(tags instanceof Uint32Array) || !(extra instanceof Uint32Array) || !Number.isInteger(used) || used < 0 ||
      used > 65536 || tags.length < used || extra.length < used || contexts < 1 || contexts > 256) return null;
  let total = 0;
  for (const size of sizes) { if (!Number.isInteger(size) || size < 1) return null; total += size + 33; }
  if (total > HP_ROOM) return null;
  for (let i = 0; i < used; i++) if ((tags[i] >>> 16) >= contexts) return null;
  acClean = false; ansStamp = null; zdLoaded = false; acBucketsZero = false; tileBand = null; acResident = null; retainEpoch++;
  const epoch = retainEpoch, buffer = engine.memory.buffer, u32 = new Uint32Array(buffer), i32 = new Int32Array(buffer);
  u32.set(tags.subarray(0, used), HP_TAGS >> 2); u32.set(extra.subarray(0, used), HP_EXTRA >> 2);
  const counts = [];
  for (let c = 0, at = 0; c < contexts; c++) {
    i32[(HP_LAYOUT >> 2) + 2 * c] = at; i32[(HP_LAYOUT >> 2) + 2 * c + 1] = sizes[c];
    counts.push(u32.subarray((HP_COUNTS >> 2) + at, (HP_COUNTS >> 2) + at + sizes[c] + 33));
    at += sizes[c] + 33;
  }
  u32.fill(0, HP_COUNTS >> 2, (HP_COUNTS >> 2) + total);
  engine.simd.hpCount(HP_TAGS, HP_EXTRA, used, HP_COUNTS, HP_LAYOUT);
  return {counts, tokens(configs) {
    if (retainEpoch !== epoch || configs.length !== contexts || !configs.every(c => Number.isInteger(c.split) && Number.isInteger(c.msb) && Number.isInteger(c.lsb) &&
        c.split >= 0 && c.split <= 30 && c.msb >= 0 && c.lsb >= 0 && c.msb + c.lsb <= c.split && c.splitToken === 2 ** c.split)) return false;
    configs.forEach((config, c) => i32.set([config.splitToken, config.split, config.msb, config.lsb], (HP_CFGS >> 2) + 4 * c));
    engine.simd.hpTokens(HP_TAGS, HP_EXTRA, used, HP_CFGS);
    tags.set(u32.subarray(HP_TAGS >> 2, (HP_TAGS >> 2) + used)); extra.set(u32.subarray(HP_EXTRA >> 2, (HP_EXTRA >> 2) + used));
    return true;
  }};
}

const SH_ARGS = P, SH_LOG2 = P + 64, SH_SYM = SH_LOG2 + 4097 * 8, SH_LOGLEN = SH_SYM + 4097 * 8, SH_REPEATS = SH_LOGLEN + 64,
  SH_FREQS = SH_REPEATS + 64, SH_SCRATCH = SH_FREQS + 2048, SH_BEST = SH_SCRATCH + 24576;
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


const captureTokenGroup = SAMPLE || JPEG ? null : function captureTokenGroup(comps, width, height, group, density, order, ac = null) {
  if (active !== 'simd') throw fault('JXL_WASM', 'Photographic capture needs its SIMD kernels.');
  const groupsX = Math.ceil(width / 256), bx = group % groupsX * 32, by = Math.floor(group / groupsX) * 32;
  const bw = Math.min(32, Math.ceil(width / 8) - bx), bh = Math.min(32, Math.ceil(height / 8) - by);
  if (bw < 1 || bh < 1 || comps.length !== 3 || comps.some(c => !(c.coeffs instanceof Int16Array) || c.stride < bx + bw || c.coeffs.length < ((by + bh - 1) * c.stride + bx + bw) * 64))
    throw fault('JXL_INPUT', 'Photo capture needs three signed16 DCT8 planes.');
  acClean = false; ansStamp = null; zdLoaded = false; acBucketsZero = false; tileBand = null; acResident = null; retainEpoch++;
  const args = P, coeff = P + 128, counts = coeff + 393216, buckets = counts + 3072, contexts = buckets + 1024;
  const orders = contexts + 64, zd = orders + 192, nz = zd + 8192, values = nz + 12288, ids = values + 786432;
  const buffer = engine.memory.buffer, u8 = new Uint8Array(buffer), i16 = new Int16Array(buffer), u16 = new Uint16Array(buffer), i32 = new Int32Array(buffer);
  for (let c = 0; c < 3; c++) {
    const {coeffs, stride} = comps[c], at = coeff + c * 131072;
    for (let y = 0; y < bh; y++) i16.set(coeffs.subarray(((by + y) * stride + bx) * 64, ((by + y) * stride + bx + bw) * 64), (at >> 1) + y * bw * 64);
    engine.simd.captureSelect(at, counts + c * bw * bh, bw * bh, 128, 3);
    u8.set(order, orders + c * 64);
  }
  u8.fill(0, buckets, buckets + 1024); u16.set(density, zd >> 1);
  if (ac && ac.K > 1) {
    const {coeffs, stride} = comps[1];
    for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) u8[buckets + y * bw + x] = ac.bucket(coeffs[((by + y) * stride + bx + x) * 64]);
    i32.set(ac.table, contexts >> 2);
  } else i32.set([1, 0, 2], contexts >> 2);
  i32.set([coeff, 131072, bw, bh, counts, buckets, contexts, ac ? ac.K : 1, ac ? ac.numCtxs : 3, orders, zd, nz, 4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, values, ids, 0], args >> 2);
  engine.simd.acGroup(args);
  const n = i32[(args >> 2) + 28];
  return {n, values: new Uint32Array(buffer, values, n), ctxs: new Uint16Array(buffer, ids, n)};
}

const captureOpaque = SAMPLE || JPEG ? null : function captureOpaque(data, width, x, y, w, h) {
  if (active !== 'simd') throw fault('JXL_WASM', 'Photographic capture needs its SIMD kernels.');
  acClean = false; ansStamp = null; zdLoaded = false; acBucketsZero = false; tileBand = null; acResident = null; retainEpoch++;
  for (let row = y; row < y + h; row++) {
    const at = (row * width + x) * 4;
    engine.u8.set(data.subarray(at, at + w * 4), P);
    if (!engine.simd.opaque(P, w * 4)) return false;
  }
  return true;
};

const capturePlane = SAMPLE || JPEG ? null : function capturePlane(data, sourceWidth, x, y, width, height, step = 1, offset = 0) {
  if (active !== 'simd') throw fault('JXL_WASM', 'Photographic capture needs its SIMD kernels.');
  const type = data instanceof Int16Array ? 1 : data instanceof Int8Array ? 2 : data instanceof Uint8Array || data instanceof Uint8ClampedArray ? 0 : -1;
  if (type < 0 || width < 1 || height < 1 || width > 256 || height > 256 || !Number.isInteger(step) || step < 1 || step > 64 || x < 0 || y < 0 || x + width > sourceWidth || ((y + height - 1) * sourceWidth + x + width - 1) * step + offset >= data.length)
    throw fault('JXL_INPUT', 'Photographic capture plane is outside its owned sample rows.');
  acClean = false; ansStamp = null; zdLoaded = false; acBucketsZero = false; tileBand = null; acResident = null; retainEpoch++;
  const raw = new Uint8Array(data.buffer, data.byteOffset, data.byteLength), unit = data.BYTES_PER_ELEMENT, output = new Int16Array(width * height);
  const u8 = new Uint8Array(engine.memory.buffer), out = P + 65536, i16 = new Int16Array(engine.memory.buffer);
  for (let row = 0; row < height; row++) {
    const at = ((y + row) * sourceWidth + x) * step * unit, end = at + ((width - 1) * step + offset + 1) * unit;
    u8.set(raw.subarray(at, end), P);
    engine.simd.captureSelect(P + offset * unit, out, width, step * unit, type);
    output.set(i16.subarray(out >> 1, (out >> 1) + width), row * width);
  }
  return output;
}

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
const sampledLayout = SAMPLE ? null : function sampledLayout(total, kinds, alphabet, maxCuts) {
  const symbols = P, indices = symbols + total * kinds, histogram = align8(indices + total);
  const entropy = align8(histogram + kinds * alphabet * 4), raw = entropy + (total + 1) * 8;
  const output = raw + alphabet * 8, scratch = output + 24, bins = maxCuts + 1;
  const dense = scratch + kinds * 32 + kinds * alphabet * 8;
  return {symbols, indices, histogram, entropy, raw, output, scratch, dense, needed: dense + bins * kinds * alphabet * 4 + total * 4 + (2 * bins + 1) * 4};
}
const SAMPLED_CAP = 272 * 65536, RETAIN_BUDGET = 8 * 1048576;
const SAMPLED_COUNT = (typeof __RAPIER_JXL_UPLOAD__ !== 'undefined' && __RAPIER_JXL_UPLOAD__ === true) ||
  (typeof __RAPIER_JXL_JPEG__ !== 'undefined' && __RAPIER_JXL_JPEG__ === true) ? 65536 : 262144;

const sampledStore = SAMPLE ? null : function sampledStore(count, kinds, alphabet, columns) {
  if (!engine || !Number.isInteger(count) || count < 64 || count > SAMPLED_COUNT || !kinds || kinds > 16 || !alphabet || alphabet > 256) return null;
  let maxCuts = 0;
  for (const column of columns) maxCuts = Math.max(maxCuts, column.cuts.length);
  if (!maxCuts || maxCuts > 255) return null;
  const base = Math.ceil(sampledLayout(count, kinds, alphabet, maxCuts).needed / 64) * 64;
  if (base >= SAMPLED_CAP) return null;
  const epoch = retainEpoch, free = [[base, Math.min(SAMPLED_CAP, base + RETAIN_BUDGET)]];
  let peak = 0, used = 0;
  const live = () => epoch === retainEpoch;
  return {
    live,
    allocate(bytes) {
      if (!live()) return -1;
      for (let i = 0; i < free.length; i++) {
        const [at, end] = free[i];
        if (end - at < bytes) continue;
        if (at + bytes > engine.memory.buffer.byteLength) {
          try { engine.memory.grow(Math.ceil((at + bytes - engine.memory.buffer.byteLength) / 65536)); }
          catch { return -1; }
          engine.u8 = new Uint8Array(engine.memory.buffer); engine.i32 = new Int32Array(engine.memory.buffer);
        }
        if (at + bytes === end) free.splice(i, 1); else free[i] = [at + bytes, end];
        used += bytes; peak = Math.max(peak, used);
        return at;
      }
      return -1;
    },
    release(handle) {
      if (!handle) return;
      used -= handle.bytes;
      free.push([handle.at, handle.at + handle.bytes]);
      free.sort((a, b) => a[0] - b[0]);
      for (let i = free.length - 1; i > 0; i--) if (free[i - 1][1] === free[i][0]) { free[i - 1][1] = free[i][1]; free.splice(i, 1); }
    },
    get peak() { return peak; },
  };
}

const sampled = SAMPLE ? null : function sampled(members, histograms, symbolSets, columns, table, rawPrice, choiceBits, keep = null) {
  acClean = false; ansStamp = null; zdLoaded = false; acBucketsZero = false; tileBand = null; acResident = null; shapeEpoch = -1;
  const total = members.length, kinds = symbolSets.length, alphabet = rawPrice.length;
  if (keep) keep.handle = null;
  if (!(members instanceof Uint32Array) || total < 64 || total > SAMPLED_COUNT || !kinds || kinds > 16 ||
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
  const {symbols, indices, histogram, entropy, raw, output, scratch, dense, needed} = sampledLayout(total, kinds, alphabet, maxCuts);
  if (needed > SAMPLED_CAP) return false;
  if (needed > engine.memory.buffer.byteLength) {
    try { engine.memory.grow(Math.ceil((needed - engine.memory.buffer.byteLength) / 65536)); }
    catch { return false; }
    engine.u8 = new Uint8Array(engine.memory.buffer);
    engine.i32 = new Int32Array(engine.memory.buffer);
  }
  const store = keep?.store?.live() ? keep.store : null;
  const derive = !!(store && keep.parent && keep.sibling && keep.parent.columns === columns && keep.sibling.columns === columns);
  let save = !!(store && keep.save);
  for (const column of columns) if (column.cuts.length && !derive && total * 4 <= (column.cuts.length + 1) * alphabet) save = false;
  let handle = null;
  if (save) {
    const offsets = [];
    let bytes = 0;
    for (const column of columns) { offsets.push(bytes); bytes += column.cuts.length ? (column.cuts.length + 1) * kinds * alphabet * 4 : 0; }
    const at = bytes ? store.allocate(bytes) : -1;
    if (at >= 0) handle = {at, bytes, offsets, columns};
  }
  const {u8, i32} = engine, f64 = new Float64Array(engine.memory.buffer);
  if (!derive) {
    for (let i = 0; i < total; i++) if (members[i] >= count) return store?.release(handle), false;
    for (let c = 0; c < kinds; c++) {
      const source = symbolSets[c], at = symbols + c * total;
      for (let i = 0; i < total; i++) { const symbol = source[members[i]]; if (symbol >= alphabet) return store?.release(handle), false; u8[at + i] = symbol; }
    }
  }
  for (let c = 0; c < kinds; c++) i32.set(histograms[c], (histogram >> 2) + c * alphabet);
  f64.set(table.subarray(0, total + 1), entropy >> 3); f64.set(rawPrice, raw >> 3);
  const backend = engine.simd;
  let best = null;
  for (let k = 0; k < columns.length; k++) {
    const column = columns[k], cuts = column.cuts.length;
    if (!cuts) continue;
    const size = (cuts + 1) * kinds * alphabet;
    if (derive) {
      backend.subtract(dense, keep.parent.at + keep.parent.offsets[k], keep.sibling.at + keep.sibling.offsets[k], size);
    } else {
      const source = column.indices;
      for (let i = 0; i < total; i++) { const bin = source[members[i]]; if (bin > cuts) return store?.release(handle), false; u8[indices + i] = bin; }
    }
    const bin = backend.sampled(symbols, total, kinds, indices, cuts, alphabet, histogram, entropy, raw, scratch, output, derive ? 1 : 0);
    if (handle) u8.copyWithin(handle.at + handle.offsets[k], dense, dense + size * 4);
    if (bin < 0) continue;
    const loBits = f64[(output + 8) >> 3], hiBits = f64[(output + 16) >> 3], gain = choiceBits - loBits - hiBits;
    if (!best || gain > best.gain) best = {gain, column, bin,
      lo: {selected: i32[output >> 2], bits: loBits}, hi: {selected: i32[(output + 4) >> 2], bits: hiBits}};
  }
  if (keep) keep.handle = handle;
  return best;
}


const SG = 4194304, sgOrderAt = new Int32Array(81);
const strategyLayout = SAMPLE || UPLOAD || JPEG ? null : function strategyLayout(state, g, pass, nzContext, freqContext, orderOf, base) {
  const {authoredOrderPasses, groupsX, strategyData, map, contexts, lumaBuckets, lumaW} = state;
  const blocks = strategyData?.groups[g];
  if (active !== 'simd' || !blocks || nzContext.length !== 64 || freqContext.length !== 64 || blocks.length * 3 > 3072) return null;
  const authored = authoredOrderPasses?.[pass], bucketed = contexts.thresholds.length > 0, bx0 = g % groupsX * 32, by0 = ((g / groupsX) | 0) * 32;
  const NZ = base + 512, RECS = NZ + 12288, ORDERS = RECS + 3072 * 44;
  sgOrderAt.fill(0);
  const orders = [];
  let at = ORDERS, levels = 0;
  for (let b = 0; b < blocks.length; b++) {
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
  const LV = at, CTX = LV + levels * 4, VAL = CTX + levels * 4 + 12288, end = VAL + levels * 4 + 12288;
  if (end > engine.memory.buffer.byteLength) {
    try { engine.memory.grow(Math.ceil((end - engine.memory.buffer.byteLength) / 65536)); } catch { return null; }
    engine.u8 = new Uint8Array(engine.memory.buffer); engine.i32 = new Int32Array(engine.memory.buffer);
  }
  const i32 = engine.i32, m0 = map[0], m1 = map[1], m2 = map[2];
  i32.set(nzContext, base >> 2); i32.set(freqContext, (base >> 2) + 64);
  for (let k = 0; k < orders.length; k += 2) i32.set(orders[k], orders[k + 1] >> 2);
  let rec = RECS >> 2, lv = LV, count = 0;
  for (let b = 0; b < blocks.length; b++) {
    const block = blocks[b], {id, size, area, bw, bh, bx, by} = block, id3 = id * 3, ordId = orderOf[id];
    const bucket = bucketed ? lumaBuckets[by * lumaW + bx] : 0, rbx = bx - bx0, rby = by - by0;
    if (block.levels) {
      i32.set(block.levels, lv >> 2);
      for (let i = 0; i < 3; i++) {
        const c = i === 0 ? 1 : i === 1 ? 0 : 2, mc = c === 1 ? m1 : c === 0 ? m0 : m2, blockCtx = contexts.contextOf(c, bucket, ordId);
        i32[rec] = size; i32[rec + 1] = area; i32[rec + 2] = bw; i32[rec + 3] = bh;
        i32[rec + 4] = rbx; i32[rec + 5] = rby; i32[rec + 6] = lv + mc * size * 4;
        i32[rec + 7] = sgOrderAt[id3 + c]; i32[rec + 8] = blockCtx;
        i32[rec + 9] = contexts.zeroDensityOffset(blockCtx); i32[rec + 10] = c;
        rec += 11; count++;
      }
      lv += size * 12;
    } else {
      for (let i = 0; i < 3; i++) {
        const c = i === 0 ? 1 : i === 1 ? 0 : 2, coeffs = block.coeffs[map[c]];
        if (coeffs.length !== size) return null;
        i32.set(coeffs, lv >> 2);
        const blockCtx = contexts.contextOf(c, bucket, ordId);
        i32[rec] = size; i32[rec + 1] = area; i32[rec + 2] = bw; i32[rec + 3] = bh;
        i32[rec + 4] = rbx; i32[rec + 5] = rby; i32[rec + 6] = lv;
        i32[rec + 7] = sgOrderAt[id3 + c]; i32[rec + 8] = blockCtx;
        i32[rec + 9] = contexts.zeroDensityOffset(blockCtx); i32[rec + 10] = c;
        rec += 11; lv += size * 4; count++;
      }
    }
  }
  return {n: engine.simd.sgFill(RECS, count, contexts.numCtxs, base, NZ, CTX, VAL), ctx: CTX, val: VAL, levels};
};
const strategyFill = SAMPLE || UPLOAD || JPEG ? null : function strategyFill(state, g, pass, nzContext, freqContext, orderOf, ctxs, values) {
  acClean = false; ansStamp = null; zdLoaded = false; acBucketsZero = false; tileBand = null; acResident = null; retainEpoch++;
  const laid = strategyLayout(state, g, pass, nzContext, freqContext, orderOf, SG);
  if (!laid || laid.n > ctxs.length) return null;
  ctxs.set(engine.i32.subarray(laid.ctx >> 2, (laid.ctx >> 2) + laid.n)); values.set(engine.i32.subarray(laid.val >> 2, (laid.val >> 2) + laid.n));
  return laid.n;
};
const strategyWrite = SAMPLE || UPLOAD || JPEG ? null : function strategyWrite(state, g, pass, nzContext, freqContext, orderOf, coding, w) {
  const model = coding.model, blocks = state.strategyData?.groups[g];
  if (active !== 'simd' || !blocks || model?.kind !== 'ans' || !coding.flush || model.histograms.length > 256 || model.contextMap.length > 8192 ||
      !acceptableWriter(w) || model.histograms.some(h => !(h.reverse instanceof Uint16Array) || h.reverse.length !== 4096)) return false;
  let levels = 0;
  for (const block of blocks) levels += 3 * block.size;
  const tokens = levels + 3072, ans = ansTablesOf(model);
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
  const written = i32[(args >> 2) + 17];
  if (w.at + written + 8 >= w.bytes.length) w.grow(written + 8);
  w.bytes.set(u8.subarray(OUT, OUT + written), w.at);
  w.at += written; w.acc = i32[(args >> 2) + 15]; w.pending = i32[(args >> 2) + 16];
  return 2;
};

const XYB_AT = 4194304, XY_LIN = XYB_AT + 4113 * 8, XY_MIX = XY_LIN + 2048, XY_KEYS = XY_MIX + 128, XY_VALS = XY_KEYS + 4 * 131072, XY_ROWS = XY_VALS + 24 * 131072;
const xybPlanesKernel = SAMPLE || UPLOAD || JPEG ? null : function xybPlanesKernel(data, width, height, W, H, planes, roots, linear, mix, bias, rootBias) {
  if (active !== 'simd' || !(data instanceof Uint8Array || data instanceof Uint8ClampedArray) || roots.length !== 4113 || linear.length !== 256 ||
      mix.length !== 9 || W < width || H < height || planes.some(p => !(p instanceof Float64Array) || p.length !== W * H)) return false;
  const perRow = width * 4 + 3 * W * 8, rows = Math.min(height, Math.floor((272 * 65536 - XY_ROWS - 8) / perRow));
  if (rows < 1) return false;
  const end = XY_ROWS + rows * perRow + 8;
  if (end > engine.memory.buffer.byteLength) {
    try { engine.memory.grow(Math.ceil((end - engine.memory.buffer.byteLength) / 65536)); } catch { return false; }
    engine.u8 = new Uint8Array(engine.memory.buffer); engine.i32 = new Int32Array(engine.memory.buffer);
  }
  const keepVb = vbLoaded === retainEpoch;
  acClean = false; ansStamp = null; zdLoaded = false; acBucketsZero = false; tileBand = null; acResident = null; vbStrip = null; retainEpoch++;
  if (keepVb) vbLoaded = retainEpoch;
  const f64 = new Float64Array(engine.memory.buffer), u8 = engine.u8;
  f64.set(roots, XYB_AT >> 3); f64.set(linear, XY_LIN >> 3); f64.set(mix, XY_MIX >> 3); engine.i32.fill(-1, XY_KEYS >> 2, (XY_KEYS >> 2) + 131072);
  for (let y = 0; y < height; y += rows) {
    const n = Math.min(rows, height - y), out = XY_ROWS + Math.ceil(n * width / 2) * 8;
    u8.set(data.subarray(y * width * 4, (y + n) * width * 4), XY_ROWS);
    engine.simd.xybRows(XY_ROWS, width, n, W, XYB_AT, XY_LIN, XY_MIX, bias, rootBias, XY_KEYS, XY_VALS, out);
    for (let c = 0; c < 3; c++) planes[c].set(f64.subarray((out >> 3) + c * n * W, (out >> 3) + (c + 1) * n * W), y * W);
  }
  return true;
};

const GAB = 4194304, GAB_LIMIT = 272 * 65536;
const gaborish = SAMPLE || UPLOAD || JPEG ? null : function gaborish(t, source, W, H, weights, iterations) {
  if (active !== 'simd' || !(t instanceof Float64Array) || !(source instanceof Float64Array) || source.length < W * H || !Number.isInteger(W) || !Number.isInteger(H) || W < 8 || W % 2 ||
      H < 1 || t.length !== W * H || !Number.isInteger(iterations) || iterations < 1 || iterations > 16) return false;
  const rowBytes = W * 8, room = Math.floor((GAB_LIMIT - GAB) / rowBytes) - 2;
  const rows = Math.min(H, room >> 1), keep = rows === H ? H : rows - 2 * iterations;
  if (keep < 16) return false;
  const end = GAB + (2 * rows + 2) * rowBytes;
  if (end > engine.memory.buffer.byteLength) {
    try { engine.memory.grow(Math.ceil((end - engine.memory.buffer.byteLength) / 65536)); } catch { return false; }
    engine.u8 = new Uint8Array(engine.memory.buffer); engine.i32 = new Int32Array(engine.memory.buffer);
  }
  const keepVb = vbLoaded === retainEpoch;
  acClean = false; ansStamp = null; zdLoaded = false; acBucketsZero = false; tileBand = null; acResident = null; vbStrip = null; retainEpoch++;
  if (keepVb) vbLoaded = retainEpoch;
  const f64 = new Float64Array(engine.memory.buffer), orig = GAB + rows * rowBytes, ring = orig + rows * rowBytes;
  const [w1, w2] = weights, norm = 1 / (1 + 4 * w1 + 4 * w2);
  for (let a = 0; a < H; a += keep) {
    const b = Math.min(H, a + keep), from = Math.max(0, a - iterations), to = Math.min(H, b + iterations), rowsOf = source.subarray(from * W, to * W);
    f64.set(rowsOf, GAB >> 3); f64.set(rowsOf, orig >> 3);
    for (let i = 0; i < iterations; i++) engine.simd.gab(GAB, orig, ring, W, to - from, w1, w2, norm);
    t.set(f64.subarray((GAB >> 3) + (a - from) * W, (GAB >> 3) + (b - from) * W), a * W);
  }
  return true;
};

const GB = 4194304, GB_LIMIT = 272 * 65536, GB_TILE_ROWS = 4, GB_INTO = [3, 0, 1];
const PACK_TABLE = new Uint8Array(6144);
for (let mask = 0; mask < 256; mask++) for (let lane = 0, j = 0; lane < 8; lane++) if (mask >> lane & 1) {
  PACK_TABLE[mask * 16 + 2 * j] = 2 * lane; PACK_TABLE[mask * 16 + 2 * j + 1] = 2 * lane + 1; PACK_TABLE[4096 + mask * 8 + j++] = lane;
}
const GB_ROOTS = GB, GB_LIN = GB + 32912, GB_MIX = GB_LIN + 2048, GB_BASIS = GB_MIX + 80, GB_PAIRED = GB_BASIS + 512, GB_QUANT = GB_PAIRED + 512,
  GB_THR = GB_QUANT + 1536, GB_SCRATCH = GB_THR + 1536, GB_TILE = GB_SCRATCH + 512, GB_CFL = GB_TILE + 98304, GB_KEYS = GB_CFL + 1024,
  GB_VALS = GB_KEYS + 4 * 131072, GB_CHUNK = GB_VALS + 24 * 131072, GB_FAST_BYTES = 4 << 20;
const gabBand = SAMPLE || JPEG ? null : function gabBand(data, width, total, top, height, job) {
  const {linear, mix, bias, rootBias, weights, iterations, thresholds, c84, components, cfl, nonZero, fast} = job;
  const stride = Math.ceil(width / 8), rows = Math.ceil(height / 8), W = stride * 8, Hpad = Math.ceil(total / 8) * 8;
  if (active !== 'simd' || !(data instanceof Uint8Array || data instanceof Uint8ClampedArray) || data.length !== total * width * 4 ||
      !Number.isInteger(top) || top < 0 || top + rows * 8 > Hpad || linear.length !== 256 || mix.length !== 9 ||
      !Number.isInteger(iterations) || iterations < 1 || iterations > 8 || !fast && job.roots.length !== 4113 ||
      (fast ? job.steps.length !== 3 || job.scale.length !== 64 : job.basis.length !== 64)) return false;
  const S = fast ? 4 : 8, halo = iterations + (iterations & 1), packed = fast ? job.packed : null;
  const tileRows = Math.ceil(rows / 8), tileCols = Math.ceil(stride / 8), chunkRows = Math.min(tileRows, GB_TILE_ROWS) * 64 + 2 * iterations;
  const perColumn = chunkRows * (4 + 4 * S) + 2 * S + 3 * 8 * 16 + 3 + (packed ? 585 : 0);
  const chunkAt = fast ? GB_KEYS + 1024 : GB_CHUNK, room = fast ? GB_FAST_BYTES : GB_LIMIT - GB_CHUNK;
  let across = Math.min(tileCols, Math.floor((Math.floor(room / perColumn) - 2 * halo) / 64));
  if (packed && across < tileCols) across &= ~3;
  if (across < 1) return false;
  const span = Math.min(W, across * 64) + 2 * halo, need = chunkAt + span * perColumn + 64;
  if (need > engine.memory.buffer.byteLength) {
    try { engine.memory.grow(Math.ceil((need - engine.memory.buffer.byteLength) / 65536)); } catch { return false; }
    engine.u8 = new Uint8Array(engine.memory.buffer); engine.i32 = new Int32Array(engine.memory.buffer);
  }
  acClean = false; ansStamp = null; zdLoaded = false; acBucketsZero = false; tileBand = null; acResident = null; retainEpoch++;
  const buffer = engine.memory.buffer, f64 = new Float64Array(buffer), f32 = new Float32Array(buffer), u8 = engine.u8, i8 = new Int8Array(buffer);
  if (fast) {
    f32.set(linear, GB_LIN >> 2); f32.set(mix, GB_MIX >> 2);
    f32.set(job.scale, GB_PAIRED >> 2);
    for (let c = 0; c < 3; c++) { f32.set(job.steps[c], (GB_QUANT >> 2) + c * 64); f32.set(thresholds[c], (GB_THR >> 2) + c * 64); }
  } else {
    const basis = job.basis;
    f64.set(job.roots, GB_ROOTS >> 3); f64.set(linear, GB_LIN >> 3); f64.set(mix, GB_MIX >> 3); f64.set(basis, GB_BASIS >> 3);
    for (let u = 0; u < 8; u += 2) for (let x = 0; x < 8; x++) {
      f64[(GB_PAIRED >> 3) + u * 8 + x * 2] = basis[u * 8 + x];
      f64[(GB_PAIRED >> 3) + u * 8 + x * 2 + 1] = basis[(u + 1) * 8 + x];
    }
    for (let c = 0; c < 3; c++) { for (let k = 0; k < 64; k++) f64[(GB_QUANT >> 3) + c * 64 + k] = job.quant[c][k]; f64.set(thresholds[c], (GB_THR >> 3) + c * 64); }
    engine.i32.fill(-1, GB_KEYS >> 2, (GB_KEYS >> 2) + 131072);
  }
  const norms = weights.map(([w1, w2]) => 1 / (1 + 4 * w1 + 4 * w2)), tileWidth = cfl.width;
  if (packed) {
    engine.i32.fill(0, GB_KEYS >> 2, (GB_KEYS >> 2) + 192);
    u8.set(PACK_TABLE, GB_ROOTS);
    packed.segment = across * 8; packed.segments = Math.ceil(stride / packed.segment);
    for (const channel of packed.channels) { channel.starts = new Uint32Array(rows * packed.segments); channel.groupStarts = new Uint32Array(rows * Math.ceil(stride / 32)); }
  }
  for (let ty0 = 0; ty0 < tileRows; ty0 += GB_TILE_ROWS) {
    const ty1 = Math.min(tileRows, ty0 + GB_TILE_ROWS), first = top + ty0 * 64, last = top + Math.min(ty1 * 64, rows * 8);
    const s0 = Math.max(0, first - iterations), s1 = Math.min(Hpad, last + iterations), n = s1 - s0;
    for (let tx0 = 0; tx0 < tileCols; tx0 += across) {
      const tx1 = Math.min(tileCols, tx0 + across), x0 = tx0 * 64, x1 = Math.min(tx1 * 64, W);
      const c0 = Math.max(0, x0 - halo), c1 = Math.min(W, x1 + halo), Wc = c1 - c0, real = Math.min(c1, width) - c0;
      const rgba = chunkAt, planes = rgba + Math.ceil(n * real * 4 / 16) * 16, plane = n * Wc * S, orig = planes + 3 * plane, ring = orig + plane;
      const levels = ring + 2 * Wc * S, blocks = (tx1 - tx0 - 1) * 8 + Math.min(8, stride - (tx1 - 1) * 8), counts = levels + 3 * 8 * blocks * 128;
      for (let y = s0; y < s1; y++) {
        const from = (Math.min(y, total - 1) * width + c0) * 4;
        u8.set(data.subarray(from, from + real * 4), rgba + (y - s0) * real * 4);
      }
      if (packed && packed.opaque) packed.opaque = engine.simd.opaque(rgba, n * real * 4) === 1;
      if (fast) engine.simd.fgXyb(rgba, real, n, Wc, GB_LIN, GB_MIX, Math.fround(bias), Math.fround(rootBias), planes);
      else engine.simd.xybRows(rgba, real, n, Wc, GB_ROOTS, GB_LIN, GB_MIX, bias, rootBias, GB_KEYS, GB_VALS, planes);
      for (let c = 0; c < 3; c++) {
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
          GB_SCRATCH, GB_QUANT, GB_THR, c84, levels, counts, GB_CFL, blocks);
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
  if (packed) packed.natural.set(new Uint32Array(engine.memory.buffer, GB_KEYS, 192));
  return true;
}
const packTileRow = SAMPLE ? null : function packTileRow(packed, levels, counts, bh, blocks, stride, first, u8) {
  const entries = 3 * 8 * blocks, starts = counts + entries + 3 & ~3, dc = starts + 4 * entries, at = dc + 2 * entries, val = at + 63 * entries + 9 & ~1;
  const end = val + 126 * entries + 16;
  if (end > engine.memory.buffer.byteLength) throw new RangeError('The packed tile row passes the arena.');
  const n = engine.simd.packLevels(levels, counts, bh, blocks, at, val, starts, dc, GB_KEYS, 0, GB_ROOTS);
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
  if (end > engine.memory.buffer.byteLength) {
    try { engine.memory.grow(Math.ceil((end - engine.memory.buffer.byteLength) / 65536)); } catch { return false; }
    engine.u8 = new Uint8Array(engine.memory.buffer); engine.i32 = new Int32Array(engine.memory.buffer);
  }
  const u8 = engine.u8, u32 = new Uint32Array(engine.memory.buffer), tiled = Math.ceil(stride / 8);
  for (let y = 0; y < H; y++) {
    const source = Math.min(height - 1, y) * width * 4, target = pixels + y * W * 4;
    u8.set(data.subarray(source, source + width * 4), target);
    if (W > width) u32.fill(u32[(target >> 2) + width - 1], (target >> 2) + width, (target >> 2) + W);
  }
  u8.set(PACK_TABLE, GB_ROOTS); engine.i32.fill(0, GB_KEYS >> 2, (GB_KEYS >> 2) + 192);
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
  const natural = new Uint32Array(engine.memory.buffer, GB_KEYS, 192).slice();
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
  VB_TABLES_END = P + 160768, VB_LEVELS = P + 160768, VB_OUT = P + 173056, VB_REGION = P + 173120, VB_STRIP = 4194304, VB_STRIP_ROWS = 32;
let vbRegionNext = VB_REGION;
let vbLoaded = -1, vbSlots = null, vbNext = 0, vbBuffer = null, vbF64 = null, vbI32 = null, vbU8 = null, vbStrip = null;
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
    vbSlots = new Map(); vbNext = VB_TABLES; vbStrip = null;
    vbLoaded = ++retainEpoch;
  }
};
const vbBasis = size => VB_BASES + 8 * (size === 8 ? 0 : size === 16 ? 128 : 640);
const varblock = SAMPLE || UPLOAD || JPEG ? null : function varblock(log2, bases) {
  if (active !== 'simd' || !(log2 instanceof Float64Array) || log2.length !== 4096) return null;
  return {
    table(id, table, size, order, high) {
      vbEnter(log2, bases);
      let slot = vbSlots.get(id);
      if (slot?.table === table && slot.epoch === vbLoaded) return slot;
      if (size > 1024 || table.planes.some(p => p.length !== size) || order.length !== size || high.length !== size) return null;
      if (!slot || slot.size !== size) {
        const bytes = size * 29 + 7 & ~7;
        if (vbNext + bytes > VB_TABLES_END) return null;
        slot = {size, steps: vbNext, order: vbNext + size * 24, high: vbNext + size * 28};
        vbNext += bytes;
        vbSlots.set(id, slot);
      }
      slot.table = table; slot.epoch = vbLoaded;
      for (let c = 0; c < 3; c++) vbF64.set(table.planes[c], (slot.steps >> 3) + c * size);
      vbI32.set(order, slot.order >> 2); vbU8.set(high, slot.high);
      return slot;
    },
    block(planes, top, x, y, W, w, h, from, to) {
      vbEnter(log2, bases);
      const available = planes[0].length / W - (y - top);
      if (!vbStrip || !vbStrip.planes.has(planes) || vbStrip.W !== W || y < vbStrip.y || y + h > vbStrip.y + vbStrip.rows) {
        const rows = Math.min(available, Math.max(h, VB_STRIP_ROWS)), end = VB_STRIP + 3 * rows * W * 8;
        vbStrip = null;
        let room = end <= engine.memory.buffer.byteLength;
        if (!room) try {
          engine.memory.grow(Math.ceil((end - engine.memory.buffer.byteLength) / 65536)); room = true;
          engine.u8 = new Uint8Array(engine.memory.buffer); engine.i32 = new Int32Array(engine.memory.buffer);
        } catch {}
        if (room) {
          vbViews();
          for (let c = 0; c < 3; c++) vbF64.set(planes[c].subarray((y - top) * W, (y - top + rows) * W), (VB_STRIP >> 3) + c * rows * W);
          vbStrip = {planes: new WeakSet([planes]), W, y, rows};
        }
      }
      for (let c = from; c <= to; c++) {
        if (vbStrip) engine.simd.vbDct(VB_STRIP + 8 * (c * vbStrip.rows * W + (y - vbStrip.y) * W + x), W, w, h, vbBasis(w) + 8 * w * w, vbBasis(h), VB_TMP, VB_TR + c * 8192);
        else {
          for (let r = 0; r < h; r++) vbF64.set(planes[c].subarray((y - top + r) * W + x, (y - top + r) * W + x + w), (VB_PIX >> 3) + r * w);
          engine.simd.vbDct(VB_PIX, w, w, h, vbBasis(w) + 8 * w * w, vbBasis(h), VB_TMP, VB_TR + c * 8192);
        }
      }
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
      if (vbRegionNext + 12 * size > R) return -1;
      const at = vbRegionNext;
      vbRegionNext += 12 * size;
      return at;
    },
    unreserve(at) { if (at >= 0) vbRegionNext = at; },
    epoch() { return vbLoaded === retainEpoch ? vbLoaded : -1; },
    levels(at, c, size) { vbViews(); return vbI32.subarray((at >> 2) + c * size, (at >> 2) + (c + 1) * size); },
    copyLevels(at, size, dst) { vbViews(); dst.set(vbI32.subarray(at >> 2, (at >> 2) + 3 * size)); },
    quant(c, slot, area, size, fc, lo, hi, fine, unit, one, detail, rc1, rc2, R, plane, sums, at = -1) {
      vbEnter(log2, bases);
      if (slot.epoch !== vbLoaded) return false;
      const base = at >= 0 ? at + c * size * 4 : VB_LEVELS;
      if (at >= 0 || plane) {
        const b32 = base >> 2, o32 = slot.order >> 2;
        for (let k = 0; k < area; k++) vbI32[b32 + vbI32[o32 + k]] = 0;
      }
      if (engine.simd.vbQuant(VB_TR + c * 8192, c === 1 ? 0 : VB_TR + 8192, slot.order, slot.steps + c * size * 8, slot.high, area, size,
        base, VB_LOG2, fc, lo, hi, fine, unit, one, detail, rc1, rc2, R, VB_OUT)) return false;
      if (plane) plane.set(vbI32.subarray(base >> 2, (base >> 2) + size));
      sums[0] = vbF64[VB_OUT >> 3]; sums[1] = vbF64[(VB_OUT >> 3) + 1]; sums[2] = vbI32[(VB_OUT >> 2) + 4];
      return true;
    },
  };
};

function disableEntropyKernels() { entropyAllowed = false; kernelHooks.entropy = null; }
function configureKernels(mode = 'auto', parts) {
  if (!['off', 'auto', 'simd'].includes(mode)) throw fault('JXL_INPUT', 'Kernel mode is off, auto or simd.');
  explicit = true; acClean = false; ansStamp = null; zdLoaded = false; acBucketsZero = false; tileBand = null; acResident = null; retainEpoch++;
  kernelHooks.channel = kernelHooks.weighted = kernelHooks.fill = kernelHooks.group = kernelHooks.screen = kernelHooks.sampled = kernelHooks.sampledStore = kernelHooks.dct = kernelHooks.ycbcrTile = kernelHooks.rgbTiles = kernelHooks.rgbBand = kernelHooks.photoTile = kernelHooks.acGroup = kernelHooks.acGroupPair = kernelHooks.acDeferred = kernelHooks.wpTokens = kernelHooks.nonzero = kernelHooks.entropy = kernelHooks.varblock = kernelHooks.gaborish = kernelHooks.strategyFill = kernelHooks.strategyWrite = kernelHooks.xybPlanes = kernelHooks.gabBand = kernelHooks.dcEvents = kernelHooks.hybridPlan = kernelHooks.shape = null; active = 'off';
  if (mode === 'off') return active;
  try {
    if (typeof WebAssembly !== 'object' || new Uint8Array(new Uint32Array([1]).buffer)[0] !== 1) return active;
    if (!(kernelsSupported())) return active;
    engine ||= createEngine();
    active = 'simd';
    const enabled = parts ? new Map(Object.entries(parts)) : null;
    if (!SAMPLE && (!enabled || enabled.get('channel'))) kernelHooks.channel = channel;
    if (!SAMPLE && (!enabled || enabled.get('weighted'))) kernelHooks.weighted = weighted;
    if (!SAMPLE && !JPEG && (!enabled || enabled.get('fill'))) kernelHooks.fill = fill;
    if (!SAMPLE && !JPEG && kernelHooks.fill && kernelHooks.channel) kernelHooks.group = group;
    if (!SAMPLE && !JPEG && (!enabled || enabled.get('screen'))) kernelHooks.screen = screen;
    if (!SAMPLE && (!enabled || enabled.get('sampled'))) { kernelHooks.sampled = sampled; kernelHooks.sampledStore = sampledStore; }
    if (!SAMPLE && (!enabled || enabled.get('dct'))) { kernelHooks.dct = dct; kernelHooks.ycbcrTile = ycbcrTile; kernelHooks.rgbTiles = rgbTile; kernelHooks.rgbBand = rgbBand; }
    if (!SAMPLE && (!enabled || enabled.get('photoTile'))) kernelHooks.photoTile = photoTile;
    if (!SAMPLE && (!enabled || enabled.get('acGroup'))) { kernelHooks.acGroup = acGroup; kernelHooks.acGroupPair = acGroupPair; kernelHooks.acDeferred = deferredCounts; }
    if (!SAMPLE && (!enabled || enabled.get('nonzero'))) kernelHooks.nonzero = nonzero;
    if (!SAMPLE && (!enabled || enabled.get('wpTokens'))) { kernelHooks.wpTokens = wpTokens; kernelHooks.dcEvents = dcEvents; kernelHooks.hybridPlan = hybridPlan; }
    if (!SAMPLE && entropyAllowed && (!enabled || enabled.get('shape'))) kernelHooks.shape = shape;
    if (!SAMPLE && !UPLOAD && !JPEG) {
      if (!enabled || enabled.get('varblock')) kernelHooks.varblock = varblock;
      if (!enabled || enabled.get('gaborish')) kernelHooks.gaborish = gaborish;
      if (!enabled || enabled.get('xybPlanes')) kernelHooks.xybPlanes = xybPlanesKernel;
    }
    if (!SAMPLE && !UPLOAD && !JPEG && (!enabled || enabled.get('strategyFill'))) { kernelHooks.strategyFill = strategyFill; kernelHooks.strategyWrite = strategyWrite; }
    if (!SAMPLE && (!enabled || enabled.get('gabBand'))) kernelHooks.gabBand = gabBand;
    if (!SAMPLE && entropyAllowed && (!enabled || enabled.get('entropy'))) kernelHooks.entropy = entropyKernels;
  } catch { active = 'off'; kernelHooks.channel = kernelHooks.weighted = kernelHooks.fill = kernelHooks.group = kernelHooks.screen = kernelHooks.sampled = kernelHooks.sampledStore = kernelHooks.dct = kernelHooks.ycbcrTile = kernelHooks.rgbTiles = kernelHooks.rgbBand = kernelHooks.photoTile = kernelHooks.acGroup = kernelHooks.acGroupPair = kernelHooks.acDeferred = kernelHooks.wpTokens = kernelHooks.nonzero = kernelHooks.entropy = kernelHooks.varblock = kernelHooks.gaborish = kernelHooks.strategyFill = kernelHooks.strategyWrite = kernelHooks.xybPlanes = kernelHooks.gabBand = kernelHooks.dcEvents = kernelHooks.hybridPlan = kernelHooks.shape = null; }
  return active;
}
function ensureKernels() {
  if (!explicit) configureKernels('auto');
  return active;
}
function kernelMode() { return active; }
function kernelRequest() { return explicit ? active : 'auto'; }
async function prepareKernels() {
  if (typeof WebAssembly !== 'object' || new Uint8Array(new Uint32Array([1]).buffer)[0] !== 1) return false;
  if (!(kernelsSupported())) return false;
  return compileKernels();
}
const arenaKernels = SAMPLE || UPLOAD ? null : capJpegKernels;
const releaseArena = SAMPLE || UPLOAD ? null : releaseJpegKernels;
if (!SAMPLE) kernelHooks.arena = {lend: () => capJpegKernels(ARENA_BYTES), release: releaseJpegKernels};
if (!SAMPLE && !JPEG) kernelHooks.capturePhoto = {prepare: prepareKernels, ready: ensureKernels, tokenGroup: captureTokenGroup, plane: capturePlane, opaque: captureOpaque};
return {configureKernels, ensureKernels, kernelMode, kernelRequest, disableEntropyKernels, prepareKernels, arenaKernels, releaseArena, orientBlock, sampleTable, sampleFilter, sampleSum, sampleFinish};
})();
