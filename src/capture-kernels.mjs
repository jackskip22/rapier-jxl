// SPDX-License-Identifier: MIT
import {wideLevels} from './color-bytes.mjs';
import {kernelModule, compileKernels, kernelsSupported, kernelInstance, arenaHolder, heldExports, growArena, takeArena} from './kernel-runtime.mjs';
import {fault} from './fault.mjs';
import {BitWriter} from './bits.mjs';
import {wasmRefused, wasmRequired} from './capture-wasm-error.mjs';
import {weightedTables} from './weighted-policy.mjs';
import {kernelHooks} from './kernel-hooks.mjs';
import {RGB8_THRESHOLDS} from './rgb8-thresholds.mjs';
import {inCall, onCallEnd} from './call-scope.mjs';
import {kernelCaller, into, both, rect, out, outUpTo, room, made} from './kernel-call.mjs';
const outside = () => { throw fault('JXL_INTERNAL', 'capture-kernels:outside-bounds'); };
const copyOut = (T, buffer, at, n) => new T(buffer.slice(at, at + n * T.BYTES_PER_ELEMENT));

export const WEIGHTED_BANDS = [-200, -100, -50, -25, -12, -6, -3, -1, 0, 2, 4, 7, 13, 26, 51, 101, 201];
export const WEIGHTED_CONTEXT = Uint8Array.from({length: 511}, (_, i) => WEIGHTED_BANDS.filter(cut => cut < i - 255).length);
export const LOG_MANTISSA = Uint8Array.of(0, 1, 3, 4, 5, 7, 8, 9, 10, 11, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 22, 23, 24, 25, 26, 27, 27, 28, 29, 30, 31, 31);

const MEMORY_PAGES = 640;
const P = 65536, DIV = 16, WEIGHTS = 272, BANDS = 32768, CONTEXTS = 33280, LOG = 33792, HEADS = 262144, SCRATCH = 832;
export const kernelFail = cause => wasmRefused() ? wasmRequired(cause)
  : Object.assign(new Error('capture kernel: unavailable', {cause}), {code: 'JXL_WASM'});
let compiled, engine, simd, resident;

const SIMD_OK = kernelsSupported;

export async function compileCaptureKernels() {
  try { return await compileKernels() && prepareCaptureKernels(); } catch { return false; }
}

const LITTLE = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;
export function prepareCaptureKernels() {
  try {
    if (typeof WebAssembly !== 'object' || !LITTLE) return false;
    simd ??= SIMD_OK();
    if (!simd) return false;
    compiled ||= kernelModule();
    return true;
  } catch { return false; }
}

export function captureWeighted(w, targets, plane, width, height, offset, contextOf, residuals, properties, keep = false, y0 = 0) {
  if (w || !(plane instanceof Int16Array) || width < 1 || height < 1 || width > 16384 || width * height > 1048576 || plane.length < width * height ||
      Math.abs(offset) > 32768 || !keep && (!(residuals instanceof Uint32Array) ||
      residuals.length < width * height || properties && (!(properties instanceof Int32Array) || properties.length < width * height))) return false;
  if (!prepareCaptureKernels()) return false;
  try {
    ready();
    if (y0 && !(y0 === 8 && resident && resident.buffer === plane.buffer && resident.offset === plane.byteOffset &&
        resident.width === width && resident.height === height && resident.base === base)) y0 = 0;
    const n = width * height, cap = keep > 2 ? width * keep : n, residual = base + cap * 4, property = base + cap * 8, state = base + cap * 12,
      sPlane = state + (width + 2) * 40, sVal = sPlane + (n * 2 + 15 & ~15), sCtx = sVal + (n * 2 + 15 & ~15);
    reserve(keep > 1 ? sCtx + n + 16 : sPlane);
    const buf = engine.memory.buffer, i32 = new Int32Array(buf);
    if (!y0) {
      i32.set(plane.subarray(0, n), base >> 2);
      i32.fill(0, state >> 2, (state >> 2) + (width + 2) * 10);
    } else i32.set(plane.subarray(y0 * width, n), (base >> 2) + y0 * width);
    if (y0 < height) engine.captureWeighted(base + y0 * width * 4, width, height, offset, residual + y0 * width * 4, property + y0 * width * 4, y0, 0, 0, DIV, WEIGHTS, state);
    if (!(typeof __RAPIER_JXL_JPEG__ !== 'undefined' && __RAPIER_JXL_JPEG__ === true) && keep > 1) {
      new Int16Array(buf, sPlane, n).set(plane.subarray(0, n));
      engine.smooth(sPlane, width, 0, height, sVal, sCtx);
      if (keep > 2 && height === 8) resident = {buffer: plane.buffer, offset: plane.byteOffset, width, height: keep, base};
      return {residuals: new Uint32Array(buf, residual, n), properties: new Int32Array(buf, property, n),
        values: new Uint16Array(buf, sVal, n), contexts: new Uint8Array(buf, sCtx, n)};
    }
    if (keep) return true;
    residuals.set(i32.subarray(residual >> 2, (residual >> 2) + n));
    if (properties) properties.set(i32.subarray(property >> 2, (property >> 2) + n));
    return true;
  } catch { return false; }
}

export function captureStripMargin(plane, width, height, keep = 2) {
  const n = width * height;
  if (!(plane instanceof Int16Array) || width < 1 || width > 16384 || height < 1 || n > 1048576 || plane.length < n ||
      keep < 1 || keep > Math.max(2, height))
    outside();
  if (n < 4096 || height < 8) return {chooseW: 1, marginBpp: 1};
  if (keep < 2) throw fault('JXL_INTERNAL', 'capture-kernels:smooth-residuals');
  return run(() => {
    const stripN = width * 8, cap = keep > 2 ? width * keep : stripN;
    const countsOffset = cap * 12 + (width + 2) * 40 + 2 * (stripN * 2 + 15 & ~15) + stripN + 31 & ~15;
    const bytes = countsOffset + 34 * 128 * 4 + 16;
    if (base + bytes > MEMORY_BYTES) captureRelease();
    const smoothCounts = base + countsOffset, weightedCounts = smoothCounts + 16 * 128 * 4,
      totals = weightedCounts + 18 * 128 * 4;
    reserve(totals + 16);
    new Uint8Array(engine.memory.buffer, smoothCounts, totals + 16 - smoothCounts).fill(0);
    const last = height - 8, positions = [last, Math.floor(2 * last / 3), Math.floor(last / 3), 0];
    let previous = -1;
    for (const y0 of positions) {
      if (y0 === previous) continue;
      previous = y0;
      const strip = plane.subarray(y0 * width, (y0 + 8) * width);
      const sampled = captureWeighted(null, null, strip, width, 8, 0, undefined, null, null, y0 ? 2 : keep);
      if (!sampled) throw kernelFail();
      const {residuals, properties, values, contexts} = sampled;
      engine.sampleCounts(values.byteOffset, contexts.byteOffset, residuals.byteOffset, properties.byteOffset,
        width, BANDS, smoothCounts, weightedCounts, totals);
    }
    const counts = new Uint32Array(engine.memory.buffer, totals, 3);
    const wCost = engine.sampleCost(weightedCounts, 18, counts[1], LOG),
      sCost = engine.sampleCost(smoothCounts, 16, counts[0], LOG);
    return {chooseW: wCost <= sCost ? 2 : 0, marginBpp: (sCost - wCost) / counts[2]};
  });
}

export function captureResidualCopies2d(planes, width, height) {
  if (width < 1 || width > 16384 || height < 1 ||
      width * height > 1048576 || !Array.isArray(planes) || planes.length !== 3 ||
      planes.some(plane => !(plane instanceof Int16Array) || plane.length < width * height))
    outside();
  if (width < 8 || height < 8) return false;
  requireCaptureKernels(); ready();
  const n = width * 8;
  if (base + n * 5 + 64 > MEMORY_BYTES) captureRelease();
  return inSpace([room(n * 2), room(n * 2), room(n), out(Uint32Array, 2, 1)], (k, [samples, values, contexts, totals], buffer) => {
    const view = new Int16Array(buffer, samples, n);
    for (const plane of planes) {
      view.set(plane.subarray(0, n));
      k.smooth(samples, width, 0, 8, values, contexts);
      k.sampleRepeats(values, width, totals);
    }
    const counts = new Uint32Array(buffer, totals, 2);
    return counts[0] >= 16 && counts[1] * 4 >= counts[0] * 3;
  });
}

let base = P, held = null;
export function captureHold(words) {
  captureRelease();
  if (!(words instanceof Uint32Array) || words.length > SCAN_WORDS || !prepareCaptureKernels()) return false;
  try {
    ready();
    reserve(P + words.length * 4 + 16);
    new Uint32Array(engine.memory.buffer, P, words.length).set(words);
    held = {buffer: words.buffer, offset: words.byteOffset, end: words.byteOffset + words.byteLength};
    base = P + (words.length * 4 + 16 & ~15);
    return true;
  } catch { captureRelease(); return false; }
}
export function captureRelease() { resident = null; held = null; base = P; }
function heldAt(words) {
  return held && words.buffer === held.buffer && words.byteOffset >= held.offset && words.byteOffset + words.byteLength <= held.end
    ? P + words.byteOffset - held.offset : -1;
}

function tables(memory) {
  weightedTables(new Int32Array(memory.buffer), DIV, WEIGHTS);
  new Uint8Array(memory.buffer).set(WEIGHTED_CONTEXT, BANDS);
  for (let c = 0; c < 16; c++) new Uint8Array(memory.buffer)[CONTEXTS + 255 + c] = c;
  new Uint8Array(memory.buffer).set(LOG_MANTISSA, LOG);
}
let holder = null;
function ready() {
  if (!engine) {
    const {memory, exports} = kernelInstance();
    tables(memory);
    holder = arenaHolder(captureRelease, null, () => tables(memory));
    engine = {...heldExports(exports, holder), memory};
  }
  takeArena(holder);
}
function reserve(bytes) {
  resident = null;
  growArena(bytes);
}

export function capturePrices(configs, {values, counts}, distance = false) {
  if (!(values instanceof Int32Array) || !(counts instanceof Uint32Array) || values.length !== counts.length ||
      values.length > 1048576 || configs.length < 1 || configs.length > 64)
    outside();
  return call(k => k.prices, [values, counts, values.length, configRows(configs), configs.length, distance ? 1 : 0, room(131072), room(4096), LOG,
    out(Float64Array, configs.length * 2)])[1];
}

const searches = [];
onCallEnd(() => {}, () => { searches.length = 0; });
export function captureCopies(values, stride, origin, width, height, contexts, depth, minimum, scale, spatial, lazyUnder = 1 << 30, nice = 1 << 30) {
  try {
    if (!prepareCaptureKernels()) throw wasmRequired();
    const n = width * height;
    const smooth = !(typeof __RAPIER_JXL_JPEG__ !== 'undefined' && __RAPIER_JXL_JPEG__ === true) && values instanceof Int16Array;
    if (!(values instanceof Uint16Array || smooth && stride === width && !origin && contexts === null) ||
        width < 1 || width > 16384 || height < 1 ||
        n > 1048576 || stride < width || origin < 0 ||
        origin + (height - 1) * stride + width > values.length || contexts !== null && !(contexts instanceof Uint8Array && contexts.length >= n) ||
        !(spatial instanceof Uint8Array) || spatial.length > width * 8 + 64 || depth < 0 || depth > 64 ||
        minimum < 1 || scale < 1 || scale > 2 ||
        lazyUnder < 0 || lazyUnder > 1 << 30 || nice < 1 || nice > 1 << 30)
      outside();
    const hasCtx = smooth || Boolean(contexts), words = n + 1 >> 1;
    const key = hasCtx ? null : `${width},${height},${depth},${minimum},${scale},${lazyUnder},${nice},${spatial.length}`;
    return call(k => (flags, scratch, heads, at, chain, value, distance, context) => {
      const buffer = k.memory.buffer, plane = new Uint16Array(buffer, at, n);
      if (smooth) {
        new Int16Array(buffer, value, n).set(values.subarray(0, n));
        k.smooth(value, width, 0, height, at, context);
      } else {
        if (stride === width) plane.set(values.subarray(origin, origin + n));
        else for (let y = 0, from = origin; y < height; y++, from += stride) plane.set(values.subarray(from, from + width), y * width);
        if (contexts) new Uint8Array(buffer).set(contexts.subarray(0, n), context);
      }
      const same = key && inCall() ? searches.find(kept => kept.key === key) : null, kept = context + n + 19 & ~3;
      if (same) {
        const u16 = new Uint16Array(buffer);
        u16[(at >> 1) + n] = 0; u16.set(same.values, kept >> 1);
        if (k.peelEqual(at, kept, words)) return {count: same.count, value: same.value.slice(), distance: same.distance.slice(), context: new Uint8Array(same.count)};
      }
      const count = k.copies(at, hasCtx ? context : 0, n, width, depth, minimum, scale, flags, spatial.length, heads, chain, scratch, value, distance, context, lazyUnder, nice);
      const found = {count, value: new Int32Array(buffer.slice(value, value + count * 4)), distance: new Int32Array(buffer.slice(distance, distance + count * 4)),
        context: hasCtx ? new Uint8Array(buffer.slice(context, context + count)) : new Uint8Array(count)};
      if (key && inCall()) {
        const values = new Uint16Array(words * 2);
        values.set(plane);
        searches.unshift({key, values, count, value: found.value.slice(), distance: found.distance.slice()});
        searches.length = Math.min(searches.length, 4);
      }
      return found;
    }, [spatial, room(SCRATCH), room(depth ? HEADS : 0), room(n * 2 + 19 & ~3), room(depth ? n * 4 : 0), room(n * 4), room(n * 4), room(n + 20 + words * 4)])[0];
  } catch (error) { fail(error); }
}

export function capturePrune(values, distances, count, plane, w, h, stride, origin, minimum, costs) {
  if (!(values instanceof Int32Array) || !(distances instanceof Int32Array) || !(plane instanceof Uint16Array) || count < 1 ||
      values.length < count || distances.length < count || count > w * h || w * h > 1048576 || origin + (h - 1) * stride + w > plane.length)
    outside();
  return run(() => {
    const n = w * h, V = base, D = V + count * 4, at = D + count * 4, samples = at + count * 4, keep = samples + n * 2 + 15 & ~15,
      out = keep + count + 15 & ~15;
    reserve(out + 16);
    let buffer = engine.memory.buffer;
    new Int32Array(buffer, V, count).set(values.subarray(0, count)); new Int32Array(buffer, D, count).set(distances.subarray(0, count));
    const rect = new Uint16Array(buffer, samples, n);
    if (stride === w) rect.set(plane.subarray(origin, origin + n));
    else for (let y = 0; y < h; y++) rect.set(plane.subarray(origin + y * stride, origin + y * stride + w), y * w);
    engine.pruneScan(V, D, count, samples, minimum, at, out);
    const [copies, top, found] = new Int32Array(buffer, out, 3), scale = found || 2;
    if (copies < 1000) return null;
    const literals = out + 31 & ~15, freq = literals + (top + 1) * 4 + 15 & ~15, bits = freq + (top + 1) * 4 + 15 & ~15,
      tables = bits + (top + 1) * 8, symbolsAt = tables + 4096, outValues = symbolsAt + 16, outDistances = outValues + n * 4;
    reserve(outDistances + n * 4);
    buffer = engine.memory.buffer;
    new Uint8Array(buffer, keep, count).fill(1);
    new Uint32Array(buffer, literals, top + 1).fill(0);
    const literalCount = engine.pruneLiterals(V, D, count, literals);
    for (let pass = 0; pass < 2; pass++) {
      new Uint32Array(buffer, freq, top + 1).set(new Uint32Array(buffer, literals, top + 1));
      const kept = engine.pruneTally(V, D, count, samples, minimum, scale, at, keep, freq, top, tables, tables + 2048, literalCount, symbolsAt);
      if (!kept) break;
      costs(new Uint32Array(buffer, freq, top + 1), top, new Float64Array(buffer, symbolsAt, 1)[0], kept, new Float64Array(buffer, bits, top + 1),
        new Float64Array(buffer, tables, 256), new Float64Array(buffer, tables + 2048, 256));
      if (!engine.pruneDecide(V, D, count, samples, minimum, scale, at, keep, bits, top, tables, tables + 2048)) break;
    }
    const total = engine.pruneExpand(V, D, count, samples, minimum, scale, at, keep, outValues, outDistances);
    if (total === count) return null;
    return {count: total, value: copyOut(Int32Array, buffer, outValues, total), distance: copyOut(Int32Array, buffer, outDistances, total)};
  });
}

export function captureNearestWalk(colours, left, out, start) {
  const m = left.length;
  if (!(left instanceof Int32Array) || !(out instanceof Int32Array) || out.length < m || m < 1 || m > 1 << 20)
    outside();
  const packed = new Uint32Array(m);
  for (let k = 0; k < m; k++) packed[k] = colours[left[k]];
  out.set(call(k => k.nearestWalk, [packed, left, m, start >>> 0, outUpTo(Int32Array, m, () => m), room(32788 + m * 16)], true)[1]);
}

export function captureRowsModel(plane, w, h, values, contexts) {
  const n = w * h;
  if (!(plane instanceof Int32Array) || !(values instanceof Int32Array) || !(contexts instanceof Uint8Array) || n < 1 || n > 1 << 20 ||
      plane.length < n || values.length < n || contexts.length < n || h > 1024)
    outside();
  const [, o, c, chosen] = call(k => k.rowsModel, [into(Int32Array, plane, n), w, h, out(Int32Array, n), out(Uint8Array, n), out(Uint8Array, 3 * h),
    room(n * 4), room(n * 4), room(h * 18432), LOG], true);
  values.set(o); contexts.set(c);
  return chosen.slice();
}
export function captureRowsBits(values, distances, contexts, count, classes, copies) {
  if (!(values instanceof Int32Array) || !(distances instanceof Int32Array) || !(contexts instanceof Uint8Array) || count < 1 || count > 1 << 20 ||
      values.length < count || distances.length < count || contexts.length < count || classes < 1 || classes > 3072)
    outside();
  return call(k => k.rowsBits, [into(Int32Array, values, count), into(Int32Array, distances, count), into(Uint8Array, contexts, count), count, classes,
    copies ? 1 : 0, room(classes * 2048), LOG])[0];
}

export function captureBlockHashes(words, width, height) {
  if (width < 8 || height < 8 || words.length < width * height)
    outside();
  requireCaptureKernels(); ready();
  const blocks = (width >> 3) * (height >> 3), at = heldAt(words);
  if (base + (at >= 0 ? 0 : width * height * 4) + blocks * 4 + 32 > MEMORY_BYTES) return null;
  return call(k => k.blockHashes, [at >= 0 ? at : into(Uint32Array, words, width * height), width, height, out(Uint32Array, blocks)])[1];
}

export function captureKeyCounts(keys, hn) {
  const n = keys.length;
  if (!(keys instanceof Uint32Array) || n > 1 << 24 || hn < 1 || hn > 4096)
    outside();
  const [, values, counts, starts] = call(k => k.keyCounts, [keys, n, room(n * 4), room(8192), outUpTo(Int32Array, n, d => d),
    outUpTo(Uint32Array, n, d => d), out(Int32Array, hn + 1), hn]);
  return {values, counts, starts};
}

const ANS_WINDOW = 1 << 18;
export function captureAnsTokens(models, index, configs, copy, histograms, most) {
  const offset = copy ? 1 : 0, sLen = copy?.spatial ? copy.sCodes.length : 0, hn = histograms + offset;
  let window = 1;
  for (const model of models) window = Math.max(window, Math.min(ANS_WINDOW, model.count));
  const [tokens, freqs] = call(k => (hmap, cfg, lengthConfig, distanceConfig, sCodes, values, distances, contexts, tags, bits, freqs) => {
    const buffer = k.memory.buffer, i32 = new Int32Array(buffer), u8 = new Uint8Array(buffer);
    const outTags = new Uint32Array(most), outBits = new Uint32Array(most);
    let at = 0;
    for (const model of models) {
      for (let from = 0; from < model.count; from += window) {
        const to = Math.min(model.count, from + window);
        i32.set(model.pieceValue.subarray(from, to), values >> 2); i32.set(model.pieceDistance.subarray(from, to), distances >> 2);
        u8.set(model.pieceContext.subarray(from, to), contexts);
        const written = k.ansTokens(values, distances, contexts, to - from, hmap + model.base * 4, cfg, offset, copy ? Math.min(copy.minSymbol, 256) : 256, lengthConfig,
          distanceConfig, copy ? copy.minSymbol : 0, copy?.spatial ? 1 : 0, sLen, sCodes, tags, bits, 0, freqs);
        if (written < 0) return null;
        outTags.set(new Uint32Array(buffer, tags, written), at); outBits.set(new Uint32Array(buffer, bits, written), at);
        at += written;
      }
    }
    return {tags: outTags, bits: outBits, n: at};
  }, [into(Int32Array, index), configRows(configs, histograms), copy ? config(copy.lengthConfig) : room(16), copy ? config(copy.distanceConfig) : room(16), sLen ? into(Int16Array, copy.sCodes, sLen) : room(0),
    room(window * 4), room(window * 4), room(window), room(window * 8), room(window * 8), out(Uint32Array, hn * 256, 1)]);
  return tokens && {...tokens, freqs: Array.from({length: hn}, (_, h) => freqs.subarray(h * 256, h * 256 + 256))};
}

const localPlane = (plane, w, h) => {
  if (!(plane instanceof Int32Array || plane instanceof Int16Array) || w < 1 || h < 1 || w * h > 1 << 20 || plane.length < w * h)
    outside();
  requireCaptureKernels();
  ready();
};
export function captureLocalResiduals(plane, w, h, predictor) {
  localPlane(plane, w, h);
  const n = w * h;
  return call(k => k.localResiduals, [into(Int32Array, plane, n), w, h, predictor, out(Uint32Array, n), room(32)])[1];
}
export function captureLocalProperties(plane, w, h, property) {
  localPlane(plane, w, h);
  const n = w * h, [answer, properties] = call(k => k.localProperties, [into(Int32Array, plane, n), w, h, property, out(Int32Array, n), room(32)]);
  return answer < 0 ? null : properties;
}
export function captureLocalTokens(values, properties, cuts, residualConfig, lz77, alphabet, contexts, tags = null) {
  const n = values.length, mode = !cuts ? 0 : cuts === 'learned' ? 2 : 1, ncuts = mode === 1 ? cuts.length : 0;
  if (!(values instanceof Uint32Array) || n > 1 << 20 || mode && !(properties?.length >= n) || ncuts > 256 || contexts < 1 || contexts > 256)
    outside();
  const used = u => u, [, a, b] = call(k => k.localTokens, [values, n, mode ? into(Int32Array, properties, n) : room(0), mode,
    ncuts ? into(Int32Array, cuts) : room(0), ncuts, tags ? 1 : 0, tags ? outUpTo(Uint32Array, n * 2, used) : out(Uint32Array, contexts * alphabet, 1),
    tags ? outUpTo(Uint32Array, n * 2, used) : room(0), alphabet, config(residualConfig), config(lz77.lengthConfig), lz77.minLength, lz77.minSymbol,
    tags ? tags.first : 0, tags?.map ? into(Uint8Array, tags.map) : 0]);
  if (tags) return {tags: a, extra: b, used: a.length};
  return Array.from({length: contexts}, (_, c) => a.subarray(c * alphabet, (c + 1) * alphabet));
}

const LOCAL_OUT = 1 << 20;
export function captureLocalWrite(writer, values, properties, cuts, codes, mapping, residualConfig, lz77, alphabet) {
  const n = values.length, mode = !cuts ? 0 : cuts === 'learned' ? 2 : 1, ncuts = mode === 1 ? cuts.length : 0;
  if (!(values instanceof Uint32Array) || n > 1 << 20 || mode && !(properties?.length >= n) || ncuts > 256 || codes.length < 1 || codes.length > 256)
    outside();
  call(k => (at, props, cutsAt, cfg, map, state, table, out) => {
    const buffer = k.memory.buffer, i32 = new Int32Array(buffer), u8 = new Uint8Array(buffer);
    stateIn(buffer, state, writer);
    for (let i = 0; i < n;) {
      i = k.localWrite(at, i, n, props, mode, cutsAt, ncuts, table, alphabet, cfg, cfg + 16, lz77.minLength, lz77.minSymbol, mapping ? map : 0, out, out + LOCAL_OUT, state);
      if (i < 0) throw fault('JXL_INTERNAL', 'capture-kernels:token-code');
      drain(writer, u8, out, i32[(state >> 2) + 3] - out);
    }
    stateOut(buffer, state, writer);
  }, [values, mode ? into(Int32Array, properties, n) : room(0), ncuts ? into(Int32Array, cuts) : room(0), configPair(residualConfig, lz77.lengthConfig),
    mapping ? into(Uint8Array, mapping) : room(0), room(16), codeRows(codes, alphabet), room(LOCAL_OUT + 64)]);
}

export function captureChannelCode(w, target, plane, width, height, leaf, raw, residuals, beginY, configs) {
  const n = width * height, short = plane instanceof Int16Array, words = plane instanceof Uint8Array || plane instanceof Uint16Array || plane instanceof Int8Array;
  if (!(plane instanceof Int32Array || short || words && leaf.multiplier === 1) || width < 1 || height < 1 || plane.length < n ||
      !(leaf.multiplier >= 1) || beginY < 0 ||
      w && !(w instanceof BitWriter && w.write === BitWriter.prototype.write && w.grow === BitWriter.prototype.grow)) return false;
  const mode = residuals ? 3 : w ? 2 : raw ? 1 : 0, targetLen = mode < 2 ? target.length : mode === 2 ? target.lengths.length : n;
  const table = mode < 2 ? into(Uint32Array, target) : mode === 3 ? room(n * 4) : codeRows([target], 257);
  return call(k => (at, cfg, state, table, out) => {
    const buffer = k.memory.buffer, i32 = new Int32Array(buffer);
    if (mode === 2) { stateIn(buffer, state, w); i32[(state >> 2) + 3] = out; }
    if (k.channelCode(at, width, height, beginY, leaf.predictor, leaf.offset, leaf.multiplier, short ? 1 : 0, mode, table, targetLen, cfg, cfg + 16,
      configs.minSymbol, configs.minLength, table, 257, out, state) < 0) return false;
    if (leaf.multiplier !== 1) plane.set(short ? Int16Array.from(new Int32Array(buffer, at, n)) : new Int32Array(buffer, at, n));
    if (mode < 2) target.set(new Uint32Array(buffer, table, targetLen));
    else if (mode === 3) residuals.set(new Int32Array(buffer, table + beginY * width * 4, n - beginY * width), beginY * width);
    else { drain(w, new Uint8Array(buffer), out, i32[(state >> 2) + 3] - out); stateOut(buffer, state, w); }
    return true;
  }, [into(Int32Array, plane, n), configPair(leaf.config ?? configs.residual, configs.run), room(16), table, room(mode === 2 ? n * 6 + 64 : 0)])[0];
}

export function captureNativeFill(planes, words, stride, x0, y0, w, h, fill) {
  const n = w * h, {channels, tables} = fill;
  if (!INTEGER_WORDS.some(kind => words instanceof kind) || w < 1 || h < 1 ||
      ((y0 + h - 1) * stride + x0 + w) * 4 > words.length || planes.length < channels || planes.some((p, c) => c < channels && p.length < n)) return false;
  let tableBytes = 0;
  if (tables) for (const t of tables) if (t) tableBytes += t.length * 4;
  return call(k => (at, list, tableAt, out) => {
    const buffer = k.memory.buffer, i32 = new Int32Array(buffer);
    if (tables) for (let c = 0, next = tableAt; c < channels; c++) {
      const t = tables[c];
      i32[(list >> 2) + c * 2] = t ? next : 0; i32[(list >> 2) + c * 2 + 1] = t ? t.length : 0;
      if (t) { i32.set(t, next >> 2); next += t.length * 4; }
    }
    const [s0, s1, s2, sa] = fill.shifts;
    k.nativeFill(at, n, channels, fill.alpha ? 1 : 0, fill.grey ? 1 : 0, fill.rct, s0, s1, s2, sa, fill.qmode, fill.drop, tables ? list : 0, out);
    for (let c = 0; c < channels; c++) planes[c].set(new Int32Array(buffer, out + c * n * 4, n));
    return true;
  }, [made(Int32Array, n * 4, to => { for (let y = 0, from = (y0 * stride + x0) * 4; y < h; y++, from += stride * 4) to.set(words.subarray(from, from + w * 4), y * w * 4); }),
    room(channels * 8), room(tableBytes), room(channels * n * 4)])[0];
}

export function captureNativeShape(words, opaqueValue, known, opaque, grey, qmode, drop) {
  let flags = (opaque ? 1 : 0) | (grey ? 2 : 0);
  for (let start = 0; start < words.length && (flags & 2 || !known && flags & 1); start += DISTINCT_BAND) {
    const band = words.subarray(start, start + DISTINCT_BAND);
    flags = call(k => k.nativeShape, [into(Int32Array, band), band.length, opaqueValue, known ? 1 : 0, flags, qmode, drop])[0];
  }
  return {opaque: !!(flags & 1), grey: !!(flags & 2)};
}
export function captureWordsOr(words, n, colour, alpha, channels, float) {
  if (n > words.length || channels < 1 || channels > 4) outside();
  let or = new Int32Array(4), nonNegative = true;
  for (let start = 0; start < n; start += DISTINCT_BAND) {
    const band = words.subarray(start, Math.min(n, start + DISTINCT_BAND)), [all, kept] = call(k => k.wordsOr, [into(Int32Array, band), band.length, colour, alpha ? 1 : 0, channels, float, both(Int32Array, or)]);
    if (!all) nonNegative = false;
    or = kept;
  }
  return {or: or.slice(0, channels), nonNegative};
}

export function captureModularAnsWrite(w, tags, extras, n, shapes, offset) {
  if (w && !(w instanceof BitWriter && w.write === BitWriter.prototype.write && w.grow === BitWriter.prototype.grow) || n < 0 ||
      tags.length < n || extras.length < n || offset < 0 || offset > shapes.length) return false;
  return run(() => {
    const tabs = base, at = tabs + shapes.length * 9232, words = at + n * 4, raw = words + (n * 2 + 3 & ~3), out = raw + n * 4;
    reserve(w ? out + 64 : raw + n * 4);
    let buffer = engine.memory.buffer;
    const u16 = new Uint16Array(buffer), i32 = new Int32Array(buffer);
    shapes.forEach((h, k) => {
      const first = (tabs + k * 9232) >> 1;
      u16.fill(0, first, first + 520); u16.set(h.counts, first); u16.set(h.starts, first + 256); u16.set(h.reverse, first + 520);
    });
    i32.set(tags.subarray(0, n), at >> 2); i32.set(extras.subarray(0, n), raw >> 2);
    const bits = engine.tokAnsBack(at, n, tabs + offset * 9232, words);
    if (!w) return bits;
    const end = out + ((bits + w.pending) >> 3) + 16;
    reserve(end);
    buffer = engine.memory.buffer;
    const written = engine.tokAnsWrite(at, raw, n, words, w.acc, w.pending, out), whole = written >> 3, rest = written & 7, u8 = new Uint8Array(buffer);
    if (w.at + whole + 8 >= w.bytes.length) w.grow(whole + 8);
    w.bytes.set(u8.subarray(out, out + whole), w.at); w.at += whole;
    w.acc = rest ? u8[out + whole] & (1 << rest) - 1 : 0; w.pending = rest;
    return bits;
  });
}

const DISTINCT_SLOTS = 1 << 18, DISTINCT_BAND = 1 << 20;
export const INTEGER_WORDS = [Uint8Array, Uint8ClampedArray, Int8Array, Uint16Array, Int16Array, Uint32Array, Int32Array];
export function captureDistinctWords(words, from, limit) {
  return captureDistinct(words, from, limit, keys => keys.sort())?.table ?? null;
}
export function captureDistinct(words, from, limit, sort, plane = null) {
  if (!INTEGER_WORDS.some(kind => words instanceof kind) || limit < 1 || limit > DISTINCT_SLOTS / 2 ||
      plane && !(plane instanceof Int16Array && plane.length >= words.length / 4 && limit <= 32768))
    outside();
  let slots = 1024;
  while (slots < 4 * (limit + 1) && slots < DISTINCT_SLOTS) slots *= 2;
  const bandWords = Math.min(DISTINCT_BAND, words.length + 3 & ~3);
  return call(k => (keys, used, ranks, at, out) => {
    const buffer = k.memory.buffer, i32 = new Int32Array(buffer);
    let count = 0;
    for (let start = 0; start < words.length; start += bandWords) {
      const band = words.subarray(start, Math.min(words.length, start + bandWords));
      i32.set(band, at >> 2);
      count = k.distinctWords(at, band.length, from, keys, used, slots, count, limit);
      if (count < 0) return null;
    }
    const n = k.distinctKeys(keys, used, slots, at), table = sort(copyOut(Int32Array, buffer, at, n));
    if (!plane) return {table};
    i32.set(table, at >> 2);
    k.distinctRank(keys, used, slots, at, n, ranks);
    for (let start = 0; start < words.length; start += bandWords) {
      const band = words.subarray(start, Math.min(words.length, start + bandWords));
      i32.set(band, at >> 2);
      if (k.distinctIndex(at, band.length, from, keys, used, slots, ranks, out) < 0) throw fault('JXL_INTERNAL', 'capture-kernels:sample-set');
      plane.set(new Int16Array(buffer, out, band.length >> 2), start >> 2);
    }
    return {table, plane};
  }, [room(slots * 4), room(slots, 1), room(slots * 4), room(Math.max(bandWords, limit + 1) * 4), room(bandWords / 2 + 8)])[0];
}

export function captureWeightedPieces(plane, width, height, minimum, y0 = 0) {
  if (!captureWeighted(null, null, plane, width, height, 0, undefined, null, null, true, y0))
    throw kernelFail();
  try {
    const n = width * height, residual = base + n * 4, property = base + n * 8, context = base + n * 12 + (width + 2) * 40;
    reserve(context + n);
    const count = engine.runs(residual, property, n, minimum, BANDS, context), buffer = engine.memory.buffer;
    return {count, value: copyOut(Int32Array, buffer, residual, count), distance: copyOut(Int32Array, buffer, property, count),
      context: copyOut(Uint8Array, buffer, context, count)};
  } catch (error) {
    throw kernelFail(error);
  }
}

const MEMORY_BYTES = MEMORY_PAGES * 65536;
export function captureWeightedLanes(planes, width, height, minimum, small, gradient = false, answers = null) {
  const n = width * height, lanes = planes.length;
  if (lanes < 1 || lanes > 4 || width < 1 || height < 1 || width > 16384 ||
      n > 1048576 || planes.some(plane => !(plane instanceof Int16Array) || plane.length < n) || !prepareCaptureKernels())
    outside();
  try {
    ready();
    const written = lanes === 4 ? 4 : 3, state = base, plane = state + (width + 2) * 160, residual = plane + n * 8,
      property = residual + n * 4 * written, context = property + n * 4 * written, classes = WEIGHTED_BANDS.length + 1,
      end = (context + n + 19 & ~3) + classes * (small + 1) * 4 + n * 4;
    if (end > MEMORY_BYTES) return null;
    reserve(end);
    const buffer = engine.memory.buffer;
    if (!(typeof __RAPIER_JXL_CAPTURE_LEAN__ !== 'undefined' && __RAPIER_JXL_CAPTURE_LEAN__ === true) && answers) answers.forEach((a, c) => {
      new Uint32Array(buffer, residual + c * n * 4, n).set(a.residuals.subarray(0, n));
      new Int32Array(buffer, property + c * n * 4, n).set(a.properties.subarray(0, n));
    });
    else {
      new Uint8Array(buffer, state, (width + 2) * 160).fill(0);
      for (let c = 0; c < lanes; c++) new Int16Array(buffer, residual + c * n * 2, n).set(planes[c].subarray(0, n));
      engine.interleave4(residual, n, (1 << lanes) - 1, plane);
      if (gradient) engine.gradient4(plane, width, height, written, residual, property);
      else engine.weighted4(plane, width, height, written, residual, property, DIV, WEIGHTS, state);
    }
    return planes.map((_, c) => {
      const values = residual + c * n * 4, distances = property + c * n * 4;
      const count = engine.runs(values, distances, n, minimum, gradient ? CONTEXTS : BANDS, context);
      return {count, value: copyOut(Int32Array, buffer, values, count), distance: copyOut(Int32Array, buffer, distances, count),
        context: copyOut(Uint8Array, buffer, context, count)};
    });
  } catch (error) { fail(error); }
}

export const SCAN_WORDS = 1 << 21;
export function captureLowestInk(words, width, height, background, stride = width, origin = 0) {
  if (!(words instanceof Uint32Array) || width < 1 || width > 32767 ||
      height < 1 || height > 32767 || stride < width || origin < 0 ||
      origin + (height - 1) * stride + width > words.length)
    outside();
  requireCaptureKernels(); ready();
  const at = heldAt(words.subarray(origin, origin + (height - 1) * stride + width)), rows = at < 0 ? Math.min(height, Math.floor(SCAN_WORDS / width)) : height;
  return call(k => (lowest, open, pixels) => {
    const u32 = new Uint32Array(k.memory.buffer);
    for (let end = height, count = width; end && count;) {
      const start = Math.max(0, end - rows);
      if (at < 0) for (let y = start; y < end; y++) u32.set(words.subarray(origin + y * stride, origin + y * stride + width), (pixels >> 2) + (y - start) * width);
      count = at < 0 ? k.lowestInk(pixels, width, width, end - start, start, background, open, count, lowest)
        : k.lowestInk(at + start * stride * 4, width, stride, end - start, start, background, open, count, lowest);
      end = start;
    }
  }, [made(Int32Array, width, to => to.fill(-1), width), made(Int32Array, width, to => to.fill(-1)), room(at < 0 ? rows * width * 4 : 0)])[1];
}

export function captureCropEdges(words, width, height, stride = width, origin = 0) {
  if (width < 1 || height < 1 || stride < width || origin < 0) return undefined;
  const at = heldAt(words.subarray(origin, origin + (height - 1) * stride + width));
  if (at < 0) return undefined;
  const edges = callOr(k => k.edges, [at, width, height, stride, out(Int32Array, 4)])?.[1];
  return edges && (edges[0] === width * height ? null : Array.from(edges));
}

export function captureRowsUnlike(words, width, height, stride, origin) {
  const at = heldAt(words.subarray(origin, origin + (height - 1) * stride + width));
  if (at < 0) return undefined;
  return callOr(k => k.rowInk, [at, width, height, stride, out(Int32Array, height)])?.[1];
}
export function captureColumnsUnlike(words, width, height, stride, origin, y0, y1, key) {
  const at = heldAt(words.subarray(origin, origin + (height - 1) * stride + width));
  if (at < 0 || !(y0 >= 0 && y0 <= y1 && y1 <= height)) return undefined;
  return callOr(k => k.colInk, [at, width, y0, y1, stride, key, out(Int32Array, width)])?.[1];
}

let pageIndices = null;
export function captureScan(words, stride, x0, y0, w, h, limit, rows, blank = null) {
  if (!(words instanceof Uint32Array) || w < 1 || h < 1 ||
      x0 < 0 || y0 < 0 || x0 + w > stride || stride > SCAN_WORDS || (y0 + h) * stride > words.length ||
      limit < 1 || limit > 16384 || !prepareCaptureKernels()) return undefined;
  let size = 1024;
  while (size < limit * 2) size <<= 1;
  const rowsAt = blank ? -1 : heldAt(words.subarray(y0 * stride, (y0 + h) * stride)), across = rowsAt < 0 ? w : stride,
    bandRows = Math.min(h, Math.floor(SCAN_WORDS / across)), n = w * h;
  return callOr(k => (keys, colours, first, last, staged, indices) => {
    const buffer = k.memory.buffer, at = rowsAt < 0 ? staged : rowsAt;
    let plane, count = 0;
    for (let y = 0; y < h; y += bandRows) {
      const height = Math.min(bandRows, h - y);
      if (rowsAt < 0) {
        const band = new Uint32Array(buffer, at, w * height), top = y0 + y;
        if (w === stride) band.set(words.subarray(top * stride + x0, (top + height) * stride + x0));
        else for (let row = 0, from = top * stride + x0; row < height; row++, from += stride) band.set(words.subarray(from, from + w), row * w);
        if (blank) for (const r of blank) for (let row = Math.max(r.y, top); row < Math.min(r.y + r.height, top + height); row++) {
          const a = Math.max(r.x, x0), b = Math.min(r.x + r.width, x0 + w);
          if (a < b) band.fill(r.fill, (row - top) * w + a - x0, (row - top) * w + b - x0);
        }
      }
      count = k.scan(rowsAt < 0 ? at : at + y * stride * 4, across, rowsAt < 0 ? 0 : x0, w, height, limit, rows ? 1 : 0,
        keys, keys + size * 4, size - 1, Math.clz32(size) + 1, colours, indices, first, last, count, y);
      if (count < 0) return null;
      if (!plane) {
        if (rows && n <= SCAN_WORDS) {
          if (!pageIndices || pageIndices.length < n) pageIndices = new Uint16Array(Math.max(n, 1 << 20));
          plane = pageIndices.subarray(0, n);
        } else plane = new Uint16Array(n);
      }
      plane.set(new Uint16Array(buffer, indices, w * height), y * w);
    }
    return {colours: copyOut(Uint32Array, buffer, colours, count), indices: plane,
      first: rows ? copyOut(Int32Array, buffer, first, count) : undefined, last: rows ? copyOut(Int32Array, buffer, last, count) : undefined};
  }, [room(size * 6, 1), room(limit * 4), room(limit * 4), room(limit * 4), room(rowsAt < 0 ? across * bandRows * 4 : 0), room(w * bandRows * 2 + 3 & ~3)])?.[0];
}

const TEXT_DELTA_SLOTS = 65536, TEXT_DELTA_LIMIT = 16384;
export function captureTextDelta(colours, indices, stride, x, y, width, height) {
  const pixels = width * height, origin = y * stride + x;
  if (colours.length < 1 || colours.length > TEXT_DELTA_LIMIT || stride < width || width < 1 || height < 1 || pixels > (1 << 22) || origin < 0 || origin + (height - 1) * stride + width > indices.length) return null;
  const [count, out16, deltas, stats] = callOr(k => k.textDelta, [into(Uint32Array, colours), colours.length, into(Uint16Array, indices), stride, width, height, origin,
    out(Uint16Array, pixels), room(TEXT_DELTA_SLOTS * 8), TEXT_DELTA_SLOTS - 1, outUpTo(Int16Array, TEXT_DELTA_LIMIT * 3, c => c * 3), out(Uint32Array, 4), TEXT_DELTA_LIMIT]) ?? [0];
  return count < 1 ? null : {indices: out16, deltas, count, novel: stats[1], l1: stats[2], hits: stats[3]};
}

export function treeArena(count, span, props = 4, plane = {w: 0, h: 0, colours: 0}) {
  const {w, h, colours} = plane;
  if (count < 1 || count > 1048576 || span < 128 || span > 65536 ||
      props < 1 || props > 8 || !(w * h <= 1048576) || !(colours <= 65536) || !prepareCaptureKernels())
    outside();
  try {
    ready();
    const all = base, counts = all + 512, order = counts + span * props * 4, scratch = order + count * 4, tokens = scratch + count * 4;
    const bins = tokens + count, nlog = bins + props * count + 3 & ~3, low = nlog + count * 4 + 4, used = low + 512, perProperty = used + 128,
      ctx = perProperty + 32, contexts = ctx + 128, records = contexts + count + 7 & ~7, samples = records + 4096 * 8,
      values = samples + w * h * 2 + 3 & ~3, distances = values + count * 4, remapAt = distances + count * 4, yBins = remapAt + colours * 4,
      xBins = yBins + h, binOfAt = xBins + w;
    reserve(binOfAt + colours + 16);
    const buffer = engine.memory.buffer, at = p => new Uint8Array(buffer, bins + p * count, count), views = Array.from({length: props}, (_, p) => at(p));
    return {
      all: new Uint32Array(buffer, all, 128), counts: new Uint32Array(buffer, counts, span * props), order: new Int32Array(buffer, order, count),
      tokens: new Uint8Array(buffer, tokens, count), bins: views, by: views[0], bx: views[1], bw: views[2], bn: views[3],
      bin(source, stride, origin, pieceValue, pieceDistance, minimum, yBin, xBin, binOf, remap) {
        const memory = engine.memory.buffer, rect = new Uint16Array(memory, samples, w * h);
        if (stride === w) rect.set(source.subarray(origin, origin + w * h));
        else for (let y = 0; y < h; y++) rect.set(source.subarray(origin + y * stride, origin + y * stride + w), y * w);
        new Int32Array(memory, values, count).set(pieceValue.subarray(0, count)); new Int32Array(memory, distances, count).set(pieceDistance.subarray(0, count));
        new Uint8Array(memory, yBins, h).set(yBin); new Uint8Array(memory, xBins, w).set(xBin); new Uint8Array(memory, binOfAt, colours).set(binOf);
        if (props > 4) new Int32Array(memory, remapAt, colours).set(remap.subarray(0, colours));
        if (engine.pieceBins(samples, w, values, distances, count, minimum, yBins, xBins, binOfAt, remapAt, colours, tokens, bins, order, props) < 0)
          throw fault('JXL_INTERNAL', 'capture-kernels:palette-index');
      },
      learn(cuts, split, min, most, context) {
        if (cuts.length !== props || !(context instanceof Uint8Array) || context.length < count || most < 1 || most > 4096)
          outside();
        const memory = engine.memory.buffer, fields = new Int32Array(memory, ctx, 22);
        new Int32Array(memory, perProperty, props).set(cuts.map(c => c.length + 1));
        engine.treeNlog(nlog, count, LOG);
        fields.set([order, tokens, bins, count, props, span, all, counts, low, used, nlog, perProperty, 32 * split, min, most, contexts, records, 0, 0, 0, scratch, 0]);
        engine.treeLearn(ctx);
        const written = new Int32Array(memory, ctx, 22)[19];
        context.set(new Uint8Array(memory, contexts, count));
        return new Int32Array(memory.slice(records, records + written * 8));
      },
    };
  } catch (error) { fail(error); }
}

export function captureLiterals(models, n, remap) {
  if (n < 1 || n > 65536 || remap && !(remap instanceof Int32Array && remap.length >= n) || !prepareCaptureKernels())
    outside();
  let most = 1;
  for (const {count, pieceValue, pieceDistance} of models) {
    if (!(pieceValue instanceof Int32Array) || !(pieceDistance instanceof Int32Array) || count < 1 || count > 1048576 || pieceValue.length < count || pieceDistance.length < count)
      outside();
    most = Math.max(most, count);
  }
  const [, counts] = call(k => (table, values, distances) => {
    const i32 = new Int32Array(k.memory.buffer);
    for (const model of models) {
      const count = model.count;
      i32.set(model.pieceValue.subarray(0, count), values >> 2);
      i32.set(model.pieceDistance.subarray(0, count), distances >> 2);
      k.literals(values, distances, count, table, remap ? 1 : 0);
      if (remap) model.pieceValue.set(i32.subarray(values >> 2, (values >> 2) + count));
    }
  }, [made(Uint32Array, n, to => remap ? to.set(remap.subarray(0, n)) : to.fill(0), remap ? null : n), room(most * 4), room(most * 4)]);
  return counts;
}

export function capturePieceCounts(model, small, key) {
  const {count, classes, pieceValue, pieceDistance, pieceContext} = model;
  if (count < 1 || count > 1048576 || classes < 1 || classes > 4096 ||
      !(pieceValue instanceof Int32Array) || !(pieceDistance instanceof Int32Array) || !(pieceContext instanceof Uint8Array) ||
      pieceValue.length < count || pieceDistance.length < count || pieceContext.length < count || small < 1 || small > 4096 || classes * small > 1 << 21 || !prepareCaptureKernels())
    outside();
  const [, counts, larges, lengths, distances] = call(k => (values, distances, contexts, table, larges, lengths, dists, state) => {
    k.pieces(values, distances, contexts, count, small, table, table + classes * small * 4, table + classes * (small + 1) * 4, key, larges, lengths, dists, state);
    const at = new Int32Array(k.memory.buffer, state, 2);
    return [at[0], at[1]];
  }, [into(Int32Array, pieceValue, count), into(Int32Array, pieceDistance, count), into(Uint8Array, pieceContext, count),
    out(Uint32Array, classes * (small + 2), 1), outUpTo(Uint32Array, count, n => n[0]), outUpTo(Uint32Array, count, n => n[1]), outUpTo(Uint32Array, count, n => n[1]), room(8)], true);
  return {counts: counts.slice(), literals: counts.subarray(classes * small, classes * (small + 1)), copies: counts.subarray(classes * (small + 1)), larges, lengths, distances};
}

const TOKEN_OUT = 1 << 18;
export function captureTokens(writer, models, index, codes, configs, fastBits, fastLen, copy) {
  const hn = codes.length, syms = new Int32Array(hn);
  let symbols = 0;
  for (let h = 0; h < hn; h++) { syms[h] = symbols; symbols += codes[h].lengths.length; }
  const sLen = copy ? copy.sCodes.length : 0, dSymbols = copy ? copy.code.lengths.length : 0;
  let largest = 1;
  for (const model of models) largest = Math.max(largest, model.count);
  call(k => (state, hmap, syms, cfg, lengthConfig, distanceConfig, fast, fastLens, codeTable, codeLens, dcodes, dLens, sCodes, values, distances, contexts, out) => {
    const buffer = k.memory.buffer, i32 = new Int32Array(buffer), u8 = new Uint8Array(buffer);
    stateIn(buffer, state, writer);
    for (const model of models) {
      const count = model.count, classes = model.classes;
      for (let c = 0; c < classes; c++) i32[(hmap >> 2) + c] = index[model.base + c];
      i32.set(model.pieceValue.subarray(0, count), values >> 2);
      i32.set(model.pieceDistance.subarray(0, count), distances >> 2);
      u8.set(model.pieceContext.subarray(0, count), contexts);
      for (let q = 0; q < count;) {
        q = k.captureTokens(values, distances, contexts, q, count, hmap, fast, fastLens, syms, codeTable, codeLens, cfg, lengthConfig, distanceConfig,
          dcodes, dLens, copy ? copy.minSymbol : 0, copy?.spatial ? 1 : 0, sLen, sCodes, out, out + TOKEN_OUT, state);
        drain(writer, u8, out, i32[(state >> 2) + 3] - out);
      }
    }
    stateOut(buffer, state, writer);
  }, [room(16), room(1024), syms, configRows(configs, hn), copy ? config(copy.lengthConfig) : room(16), copy ? config(copy.distanceConfig) : room(16), into(Uint32Array, fastBits, hn << 9),
    into(Uint8Array, fastLen, hn << 9), made(Uint16Array, symbols, to => codes.forEach((code, h) => to.set(code.codes, syms[h]))),
    made(Uint8Array, symbols, to => codes.forEach((code, h) => to.set(code.lengths, syms[h]))),
    copy ? into(Uint16Array, copy.code.codes, dSymbols) : room(0), copy ? into(Uint8Array, copy.code.lengths, dSymbols) : room(0), sLen ? into(Int16Array, copy.sCodes, sLen) : room(0),
    room(largest * 4), room(largest * 4), room(largest), room(TOKEN_OUT + 64)]);
}

const PATCH_RUNS = 1 << 17, PATCH_BAND = 1 << 22;
export function capturePatchMarks(words, width, height, side, limit, least) {
  if (!prepareCaptureKernels()) return null;
  const n = width * height, at = heldAt(words), band = at < 0 ? Math.max(1, Math.min(height, PATCH_BAND / (4 * width) | 0)) : height;
  return callOr(k => (ink, above, stack, boxes, rows) => {
    if (at >= 0) k.patchInk(at, width, height, 0, height, ink, above);
    else for (let y = 0; y < height; y += band) {
      const from = Math.max(0, y - 1), to = Math.min(height, y + band + 1);
      new Uint32Array(k.memory.buffer, rows, (to - from) * width).set(words.subarray(from * width, to * width));
      k.patchInk(rows + (y - from) * width * 4, width, Math.min(band, height - y), y, height, ink + y * width, above);
    }
    const found = k.patchMarks(ink, width, height, stack, PATCH_RUNS, boxes, limit, side, least);
    return found < 0 ? null : new Int32Array(k.memory.buffer, boxes, found * 4).slice();
  }, [room(n, 1), made(Int32Array, width, to => to.fill(-1)), room(PATCH_RUNS * 12), room(limit * 16), room(at < 0 ? (band + 2) * width * 4 : 0)])?.[0] ?? null;
}

const PEEL_MARKS = 1 << 18, PEEL_RUNS = 1 << 20;
export function capturePeelMarks(words, width, height, bg, side) {
  if (!prepareCaptureKernels()) return null;
  const n = width * height, at = heldAt(words), band = at < 0 ? Math.max(1, Math.min(height, PATCH_BAND / (4 * width) | 0)) : height;
  return callOr(k => (ink, stack, runs, marks, rows) => {
    if (at >= 0) k.peelInk(at, n, bg, ink);
    else for (let y = 0; y < height; y += band) {
      const to = Math.min(height, y + band);
      new Uint32Array(k.memory.buffer, rows, (to - y) * width).set(words.subarray(y * width, to * width));
      k.peelInk(rows, (to - y) * width, bg, ink + y * width);
    }
    const found = k.peelMarks(ink, width, height, stack, PATCH_RUNS, runs, PEEL_RUNS, marks, PEEL_MARKS, side);
    if (found < 0) return null;
    const buf = k.memory.buffer, list = new Int32Array(buf, marks, found * 6).slice();
    return {marks: list, runs: new Int32Array(buf, runs, found ? list[found * 6 - 1] : 0).slice()};
  }, [room(n), room(PATCH_RUNS * 12), room(PEEL_RUNS * 12), room(PEEL_MARKS * 24), room(at < 0 ? band * width * 4 : 0)])?.[0] ?? null;
}

export function capturePeelBackground(words) {
  const n = words.length, samples = Math.ceil(n / 61), capacity = 2 ** Math.ceil(Math.log2(Math.max(2, samples * 2))),
    at = heldAt(words), band = Math.min(n, SCAN_WORDS);
  return call(k => (table, order, state, input) => {
    let bg = 0;
    for (let offset = 0; offset < n; offset += band) {
      const size = Math.min(band, n - offset);
      if (at < 0) new Uint32Array(k.memory.buffer, input, size).set(words.subarray(offset, offset + size));
      bg = k.peelBackground(at < 0 ? input : at + offset * 4, size, offset, table, capacity - 1, order, state, offset + size === n);
    }
    return bg >>> 0;
  }, [room(capacity * 8, 1), room(samples * 4), room(16, 1), room(at < 0 ? band * 4 : 0)])[0];
}

export function capturePeelTools(bg) {
  requireCaptureKernels();
  ready();
  const id = bg === 0xffffffff ? 0xffffffff : 0;
  let scratch = base, templates = null;
  const arena = end => { ready(); reserve(end); return engine.memory.buffer; };
  return {
    cells(words, width, mark, runs) {
      const size = mark.w * mark.h, input = scratch, selected = input + size * 4, count = mark.end - mark.start,
        out = selected + count * 4, table = out + size * 4, buffer = arena(table + 262144), raw = new Uint32Array(buffer, input, size);
      for (let y = 0; y < mark.h; y++) raw.set(words.subarray((mark.y + y) * width + mark.x, (mark.y + y) * width + mark.x + mark.w), y * mark.w);
      new Int32Array(buffer, selected, count).set(runs.subarray(mark.start, mark.end));
      const pixels = engine.peelCellData(input, mark.w, mark.h, mark.x, mark.y, bg, selected, count / 3, out, table);
      return pixels < 0 ? null : {cells: copyOut(Uint32Array, buffer, out, size), pixels};
    },
    info(cells, width, height, ink = false) {
      const input = scratch, out = input + cells.byteLength, triples = out + 16,
        buffer = arena(triples + (ink ? cells.length * 12 : 0));
      new Uint32Array(buffer, input, cells.length).set(cells);
      const count = engine.peelGlyphs(input, width, height, id, ink ? triples : 0, out);
      return {hash: new Int32Array(buffer, out, 1)[0], inkCount: count,
        ink: ink ? copyOut(Int32Array, buffer, triples, count * 3) : null};
    },
    equal(a, b) {
      if (a.length !== b.length) return false;
      const second = scratch + a.byteLength, buffer = arena(second + b.byteLength);
      new Uint32Array(buffer, scratch, a.length).set(a); new Uint32Array(buffer, second, b.length).set(b);
      return Boolean(engine.peelEqual(scratch, second, a.length));
    },
    templates(list) {
      const records = scratch, capacity = 2 ** Math.ceil(Math.log2(Math.max(2, list.length * 2))),
        table = records + list.length * 32, ink = table + capacity * 16,
        bytes = list.reduce((sum, t) => sum + t.ink.byteLength, 0),
        resident = ink + bytes + 128 * 128 * 8 + 32 <= MEMORY_BYTES,
        end = ink + (resident ? bytes : list.reduce((max, t) => Math.max(max, t.ink.byteLength), 0)),
        buffer = arena(end), values = new Int32Array(buffer);
      let at = ink;
      for (let i = 0; i < list.length; i++) {
        const t = list[i], anchor = t.ink.length - 3;
        values.set([t.w, t.h, resident ? at : 0, t.ink.length / 3, t.ink[anchor], t.ink[anchor + 1], t.ink[anchor + 2], 0], (records >> 2) + i * 8);
        if (resident) { values.set(t.ink, at >> 2); at += t.ink.byteLength; }
      }
      engine.peelTemplates(records, list.length, table, capacity - 1);
      templates = {records, table, mask: capacity - 1, ink, list}; scratch = end;
    },
    factor(group) {
      const input = scratch, out = input + group.cells.byteLength, bounds = out + Math.floor(group.cells.length / 12) * 12,
        state = bounds + 16, buffer = arena(state + 16);
      new Uint32Array(buffer, input, group.cells.length).set(group.cells);
      new Int32Array(buffer, state, 4).fill(0);
      let loaded = 0, next;
      while ((next = engine.peelFactor(input, group.w, group.h, id, templates.records, templates.table, templates.mask, out, bounds, state, loaded, templates.ink))) {
        const ink = templates.list[next - 1].ink;
        new Int32Array(buffer, templates.ink, ink.length).set(ink); loaded = next;
      }
      const count = new Int32Array(buffer, state, 3)[2], matches = copyOut(Int32Array, buffer, out, count * 3),
        [x, y, x1, y1] = new Int32Array(buffer, bounds, 4);
      if (x1 < 0) return {matches};
      const width = x1 - x + 1, height = y1 - y + 1, cells = new Uint32Array(width * height), plane = new Uint32Array(buffer, input, group.cells.length);
      for (let row = 0; row < height; row++) cells.set(plane.subarray((y + row) * group.w + x, (y + row) * group.w + x + width), row * width);
      return {matches, cells, width, height, x, y};
    },
    contain(groups) {
      scratch = base; templates = null;
      const space = (count, cells, ink) => {
        const capacity = 2 ** Math.ceil(Math.log2(Math.max(2, ink * 2)));
        return {capacity, end: scratch + count * 16 + cells * 4 + capacity * 16 + ink * 12 + 128 * 128 * 4 + 12};
      };
      for (let first = 0; first < groups.length;) {
        let last = first + 1, cells = groups[first].cells.length, ink = groups[first].inkCount, layout = space(1, cells, ink);
        while (last < groups.length) {
          const g = groups[last], next = space(last - first + 1, cells + g.cells.length, ink + g.inkCount);
          if (next.end > MEMORY_BYTES) break;
          cells += g.cells.length; ink += g.inkCount; layout = next; last++;
        }
        const records = scratch, input = records + (last - first) * 16, table = input + cells * 4,
          nodes = table + layout.capacity * 16, target = nodes + ink * 12, out = target + 128 * 128 * 4,
          buffer = arena(layout.end), values = new Uint32Array(buffer);
        let at = input, maxArea = 0, maxWidth = 0, maxHeight = 0;
        for (let i = first; i < last; i++) {
          const g = groups[i];
          values.set([g.w, g.h, at, g.cells.length], (records >> 2) + (i - first) * 4);
          values.set(g.cells, at >> 2); at += g.cells.byteLength;
          maxArea = Math.max(maxArea, g.cells.length); maxWidth = Math.max(maxWidth, g.w); maxHeight = Math.max(maxHeight, g.h);
        }
        engine.peelContainIndex(records, last - first, id, table, layout.capacity - 1, nodes);
        for (let i = 0; i < groups.length; i++) {
          const t = groups[i];
          if (t.in || t.cells.length >= maxArea || t.w > maxWidth || t.h > maxHeight) continue;
          const own = i >= first && i < last, at = own ? values[(records >> 2) + (i - first) * 4 + 2] : target;
          if (!own) new Uint32Array(buffer, target, t.cells.length).set(t.cells);
          if (engine.peelContain(at, t.w, t.h, id, records, table, layout.capacity - 1, nodes, out)) {
            const found = new Int32Array(buffer, out, 3); t.in = groups[first + found[0] - 1]; t.ox = found[1]; t.oy = found[2];
          }
        }
        first = last;
      }
    },
    body(words, width, height, marks, runs) {
      const count = marks.reduce((sum, m) => sum + m.end - m.start, 0), selected = scratch, input = selected + count * 4,
        band = Math.max(1, Math.min(height, Math.floor(PATCH_BAND / (4 * width)))), buffer = arena(input + band * width * 4),
        selectedRuns = new Int32Array(buffer, selected, count), body = new Uint32Array(words.length);
      body.set(words.subarray(width * height), width * height);
      let next = 0;
      for (const m of marks) { selectedRuns.set(runs.subarray(m.start, m.end), next); next += m.end - m.start; }
      for (let y = 0; y < height; y += band) {
        const rows = Math.min(band, height - y), plane = new Uint32Array(buffer, input, rows * width);
        plane.set(words.subarray(y * width, (y + rows) * width));
        engine.peelBody(input, width, y, rows, selected, count / 3, bg); body.set(plane, y * width);
      }
      return body;
    },
  };
}


export function requireCaptureKernels() {
  if (!prepareCaptureKernels()) throw wasmRequired();
}

export function captureResiduals(plane, width, height, residuals, properties) {
  if (!captureWeighted(null, null, plane, width, height, 0, undefined, residuals, properties))
    throw kernelFail();
}

export function captureTreeSample(plane, width, height, positions, properties, predictors, residuals, wp, references) {
  const m = positions.length, P = properties.length, K = predictors.length;
  requireCaptureKernels(); ready();
  const R = references.length, align = bytes => bytes + 15 & ~15;
  const batchCap = Math.min(m, 65536);
  const start = base + align(batchCap * 4) + align(P * 4) + align(K * 4) + align(P * batchCap * 4) + align(K * batchCap);
  const perRow = width * (2 + 2 * R + 8), halo = width * (4 + 2 * R) + 16 * (R + 6);
  const rows = Math.min(height, Math.floor((MEMORY_BYTES - start - halo) / perRow));
  if (rows < 1) throw kernelFail();
  const columns = Array.from({length: P}, (_, p) => ({property: properties[p], values: new Int32Array(m)}));
  const symbolSets = Array.from({length: K}, () => new Uint8Array(m));
  const room16 = align((2 + rows) * width * 2) + align(R * (1 + rows) * width * 2) + rows * width * 8 + 16;
  for (let b0 = 0; b0 < m; b0 += batchCap) {
    const b1 = Math.min(m, b0 + batchCap), bm = b1 - b0;
    const [, vals, syms] = call(k => (posAt, propsAt, predsAt, valsAt, symsAt, start) => {
      for (let s0 = 0; s0 < bm;) {
        const y0 = (positions[b0 + s0] / width) | 0, y1 = Math.min(height, y0 + rows), endPos = y1 * width;
        let s1 = s0 + 1;
        while (s1 < bm && positions[b0 + s1] < endPos) s1++;
        const count = (y1 - y0) * width, above = Math.min(y0, 2), refAbove = Math.min(y0, 1);
        const refAt = start + align((above + y1 - y0) * width * 2), span = (refAbove + y1 - y0) * width, resAt = refAt + align(R * span * 2), wpAt = resAt + count * 4;
        const buf = k.memory.buffer;
        new Int16Array(buf, start, (above + y1 - y0) * width).set(plane.subarray((y0 - above) * width, y1 * width));
        references.forEach((r, q) => new Int16Array(buf, refAt + q * span * 2, span).set(r.subarray((y0 - refAbove) * width, y1 * width)));
        new Uint32Array(buf, resAt, count).set(residuals.subarray(y0 * width, y1 * width));
        new Int32Array(buf, wpAt, count).set(wp.subarray(y0 * width, y1 * width));
        k.treeSample(start + above * width * 2, width, y0, posAt, s0, s1, bm, resAt, wpAt, refAt + refAbove * width * 2, span, propsAt, P, predsAt, K, valsAt, symsAt);
        s0 = s1;
      }
    }, [into(Uint32Array, positions.subarray(b0, b1)), properties, predictors, out(Int32Array, P * bm), out(Uint8Array, K * bm), room(room16)], true);
    for (let k = 0; k < K; k++) symbolSets[k].set(syms.subarray(k * bm, (k + 1) * bm), b0);
    for (let p = 0; p < P; p++) columns[p].values.set(vals.subarray(p * bm, (p + 1) * bm), b0);
  }
  return {columns, symbolSets};
}

export function captureTreeWalk(nodes, plane, width, height, residuals, wp, references) {
  const n = width * height, sixteen = a => a instanceof Int16Array || a.every(v => v >= -32768 && v <= 32767);
  if (width < 1 || height < 1 || plane.length < n ||
      residuals.length < n || wp.length < n || references.some(r => r.length < n) || !sixteen(plane) || !references.every(sixteen))
    outside();
  requireCaptureKernels(); ready();
  const R = references.length, align = bytes => bytes + 15 & ~15, start = base + align(nodes.length * 4);
  const perRow = width * (2 + 2 * R + 13), halo = width * (4 + 2 * R) + 16 * (R + 6);
  const rows = Math.min(height, Math.floor((MEMORY_BYTES - start - halo) / perRow));
  if (rows < 1) throw kernelFail();
  const values = new Int32Array(n), contexts = new Uint8Array(n);
  for (let y0 = 0; y0 < height; y0 += rows) {
    const y1 = Math.min(height, y0 + rows), m = (y1 - y0) * width, above = Math.min(y0, 2), refAbove = Math.min(y0, 1), span = (refAbove + y1 - y0) * width;
    const [, v, c] = call(k => (tree, p, refs, res, props, coded, ctx) => k.treeWalk(p + above * width * 2, width, y0, y1 - y0, tree, res, props,
      refs + refAbove * width * 2, span, coded, ctx), [into(Int32Array, nodes), into(Int16Array, plane.subarray((y0 - above) * width, y1 * width)),
      made(Int16Array, R * span, to => references.forEach((r, q) => to.set(r.subarray((y0 - refAbove) * width, y1 * width), q * span))),
      into(Uint32Array, residuals.subarray(y0 * width, y1 * width)), into(Int32Array, wp.subarray(y0 * width, y1 * width)), out(Int32Array, m), out(Uint8Array, m)], true);
    values.set(v, y0 * width); contexts.set(c, y0 * width);
  }
  return {values, contexts};
}

export function captureDenseTiles(words, stride, x, y, width, height) {
  if (!(words instanceof Uint32Array) || x < 0 || y < 0 || width < 1 || height < 1 ||
      width > 32767 || height > 32767 || x + width > stride || (y + height - 1) * stride + x + width > words.length)
    outside();
  requireCaptureKernels(); ready();
  const tx = Math.ceil(width / 16), mask = new Uint8Array(tx * Math.ceil(height / 16)), held = heldAt(words);
  return call(k => (pixels, output) => {
    const data = new Uint32Array(k.memory.buffer);
    for (let by = 0; by * 16 < height; by++) {
      const start = Math.max(0, by * 16 - 1), end = Math.min(height, (by + 1) * 16);
      if (held < 0) for (let row = start; row < end; row++)
        data.set(words.subarray((y + row) * stride + x, (y + row) * stride + x + width), (pixels >> 2) + (row - start) * width);
      k.denseTiles(held >= 0 ? held + ((y + start) * stride + x) * 4 : pixels, held >= 0 ? stride : width, width, end - start, output);
      mask.set(new Uint8Array(k.memory.buffer, output, tx), by * tx);
    }
    return mask;
  }, [room(held >= 0 ? 0 : 17 * width * 4), room(tx)])[0];
}

export function captureCutHistogram(cuts, residuals, properties) {
  const n = residuals.length, k = cuts.length + 1;
  if (!(residuals instanceof Uint32Array) || !(properties instanceof Int32Array) || properties.length !== n || k > 64)
    outside();
  requireCaptureKernels(); ready();
  if (base + n * 8 + 256 + k * 200 > MEMORY_BYTES) outside();
  const [, hist, raw] = call(k => k.cutHistogram, [residuals, properties, n, into(Int32Array, cuts), cuts.length, out(Uint32Array, k * 48), out(Float64Array, k)], true);
  return {hist: Float64Array.from(hist), raw: raw.slice()};
}

export function captureSmoothCells(data, exact, width, height) {
  if (!(data instanceof Uint8Array || data instanceof Uint8ClampedArray) || !(exact instanceof Uint8Array) || width < 1 || height < 1 || data.length < width * height * 4 || exact.length < width * height)
    outside();
  const cw = Math.ceil(width / 16), grid = new Uint8Array(cw * Math.ceil(height / 16));
  return call(k => (pixels, mask, seen, out) => {
    const u8 = new Uint8Array(k.memory.buffer);
    for (let cy = 0, y = 0; y < height; cy++, y += 16) {
      const rows = Math.min(16, height - y);
      u8.set(data.subarray(y * width * 4, (y + rows) * width * 4), pixels);
      u8.set(exact.subarray(y * width, (y + rows) * width), mask);
      k.smoothCells(pixels, mask, width, rows, out, seen);
      grid.set(u8.subarray(out, out + cw), cy * cw);
    }
    return grid;
  }, [room(width * 64), room(width * 16), room(80), room(cw)])[0];
}

export function captureMergePhotoHints(rects) {
  const n = rects.length, words = new Uint32Array(n * 6);
  if (n < 2) return rects;
  if (n > 65536) outside();
  for (let i = 0; i < n; i++) {
    const r = rects[i], right = r.x + r.width, bottom = r.y + r.height;
    if (![r.x, r.y, right, bottom].every(v => Number.isInteger(v) && v >= 0 && v <= 0xffffffff) || right <= r.x || bottom <= r.y) outside();
    words.set([r.x, r.y, right, bottom, r.rescued ? 1 : 0, i], i * 6);
  }
  const [count, merged] = call(k => k.mergePhotoHints, [words, n, outUpTo(Uint32Array, n * 6, c => c * 6)], true), ordered = new Array(n);
  for (let i = 0; i < count; i++) {
    const at = i * 6, x = merged[at], y = merged[at + 1], r = {x, y, width: merged[at + 2] - x, height: merged[at + 3] - y};
    if (merged[at + 4]) r.rescued = true;
    ordered[merged[at + 5]] = r;
  }
  return ordered.filter(Boolean);
}

function maskArena(layout) {
  requireCaptureKernels();
  const shared = layout(base + 15 & ~15);
  if (shared.end <= MEMORY_BYTES) { ready(); reserve(shared.end); return {k: engine, at: shared}; }
  const at = layout(P), pages = Math.ceil(at.end / 65536);
  if (pages > 65536) throw kernelFail();
  try {
    const memory = new WebAssembly.Memory({initial: pages, maximum: pages});
    return {k: {...new WebAssembly.Instance(compiled ??= kernelModule(), {env: {memory}}).exports, memory}, at};
  } catch (cause) { throw kernelFail(cause); }
}
const fail = error => { throw error?.code ? error : kernelFail(error); };
function run(work) { requireCaptureKernels(); try { ready(); return work(); } catch (error) { fail(error); } }
const shared = lay => { requireCaptureKernels(); ready(); const at = lay(base); reserve(at.end); return {k: engine, at}; };
const config = c => Int32Array.of(c.split, c.msb, c.lsb, c.splitToken),
  configRows = (configs, n = configs.length) => made(Int32Array, n * 4, to => {
    for (let k = 0; k < n; k++) { const c = configs[k]; to[k * 4] = c.split; to[k * 4 + 1] = c.msb; to[k * 4 + 2] = c.lsb; to[k * 4 + 3] = c.splitToken; }
  }), configPair = (a, b) => configRows([a, b]);
const codeRows = (codes, alphabet) => made(Uint32Array, codes.length * alphabet * 2, to => codes.forEach(({lengths, codes: bits}, h) => {
  for (let s = 0, row = h * alphabet * 2; s < alphabet; s++) { const known = s < lengths.length; to[row + s * 2] = known ? bits[s] : 0; to[row + s * 2 + 1] = known ? lengths[s] : 255; }
}));
const drain = (w, u8, from, written) => {
  if (w.at + written + 16 >= w.bytes.length) w.grow(written + 16);
  w.bytes.set(u8.subarray(from, from + written), w.at);
  w.at += written;
};
const stateIn = (buffer, state, w) => { new BigInt64Array(buffer, state, 1)[0] = BigInt(w.acc); new Int32Array(buffer)[(state >> 2) + 2] = w.pending; };
const stateOut = (buffer, state, w) => { w.acc = Number(new BigInt64Array(buffer, state, 1)[0]); w.pending = new Int32Array(buffer)[(state >> 2) + 2]; };
export const call = /* @__PURE__ */ kernelCaller(shared, fail);
const callFit = /* @__PURE__ */ kernelCaller(maskArena, fail),
  callOr = /* @__PURE__ */ kernelCaller(shared, () => undefined);
const spaceFit = (args, work) => callFit(k => (...at) => work(k, at, k.memory.buffer), args)[0],
  inSpace = (args, work) => call(k => (...at) => work(k, at, k.memory.buffer), args)[0];
const rowsInto = (bytes, source, stride, X, Y, w, h, at, size = 1) => {
  for (let y = 0; y < h; y++) bytes.set(source.subarray(((Y + y) * stride + X) * size, ((Y + y) * stride + X + w) * size), at + y * w * size);
};

export function captureMaskRuns(px, w, h) {
  return maskRunsOf(w, h, (i32, at) => i32.set(px, at));
}
export function captureRectangleRuns(words, width, r) {
  return maskRunsOf(r.width, r.height, (i32, at) => rowsInto(i32, words, width, r.x, r.y, r.width, r.height, at));
}
function maskRunsOf(w, h, write) {
  const n = w * h;
  return spaceFit([made(Int32Array, n, to => write(to, 0)), room(n, 1), room(n * 4), room((n >> 1) * 12 + 12), room(8)], (k, [words, mark, pixels, runs, out], buffer) => {
    const count = k.maskRuns(words, w, h, mark, pixels, runs, out);
    const list = new Int32Array(buffer.slice(runs, runs + count * 12)), last = count ? list[count * 3 - 3] + list[count * 3 - 2] : 0;
    return {pixels: new Int32Array(buffer.slice(pixels, pixels + last * 4)), runs: list, transparent: new Int32Array(buffer, out, 1)[0]};
  });
}

export function capturePhotoMasks(words, width, height, regions, found, exactRects) {
  let count = 0, need = 0;
  for (let i = 0; i < regions.length; i++) {
    const n = regions[i].width * regions[i].height, f = found[i];
    count += f.runs.length / 3;
    need = Math.max(need, n * 4 + f.pixels.length * 4 + f.runs.length / 3 * 8 + exactRects.length * 16 + 3 * (n + 8) + 64);
  }
  let cap = 64;
  while (cap < count * 2) cap *= 2;
  const rows = Math.max(1, Math.min(height + 1 >> 1, (1 << 22) / (width * 4) | 0)), outside = regions.length * 16 + rows * width * 4;
  const {k, at: {table, all, after}} = maskArena(s => {
    const table = s, all = table + cap * 12, after = all + count * 12 + 7 & ~7;
    return {table, all, after, end: after + Math.max(need, outside)};
  });
  try {
    const buffer = k.memory.buffer, i32 = new Int32Array(buffer), offsets = [];
    for (let i = 0, at = all >> 2; i < regions.length; i++) { offsets.push(at << 2); i32.set(found[i].runs, at); at += found[i].runs.length; }
    k.maskColours(table, cap, all, count);
    if (count) {
      const ordered = [...regions].sort((a, b) => a.x - b.x), rects = after;
      ordered.forEach((r, q) => i32.set([r.x, r.y, r.width, r.height], (rects >> 2) + q * 4));
      const band = rects + ordered.length * 16;
      for (let y0 = 0; y0 < height; y0 += rows * 2) {
        const r = Math.min(rows, height - y0 + 1 >> 1);
        for (let q = 0; q < r; q++) i32.set(words.subarray((y0 + 2 * q) * width, (y0 + 2 * q + 1) * width), (band >> 2) + q * width);
        k.maskOutside(table, cap, band, width, r, y0, rects, ordered.length);
      }
    }
    return regions.map((r, i) => {
      const {pixels, runs, transparent} = found[i], w = r.width, h = r.height, n = w * h, T = Math.max(192, n >> 12);
      const px = after, pix = px + n * 4, keep = pix + (pixels.length * 4 + 7 & ~7), boxes = keep + runs.length / 3 * 8,
        exact = boxes + exactRects.length * 16, border = exact + (n + 7 & ~7), only = border + (n + 7 & ~7), out = only + (n + 7 & ~7);
      rowsInto(i32, words, width, r.x, r.y, w, h, px >> 2);
      i32.set(pixels, pix >> 2);
      let rects = 0;
      for (const e of exactRects) {
        const x0 = Math.max(0, e.x - r.x), y0 = Math.max(0, e.y - r.y), x1 = Math.min(w, e.x + e.width - r.x), y1 = Math.min(h, e.y + e.height - r.y);
        if (x1 > x0 && y1 > y0) i32.set([x0, y0, x1, y1], (boxes >> 2) + 4 * rects++);
      }
      k.maskExact(px, w, h, pix, offsets[i], runs.length / 3, keep, exact, border, only, boxes, rects, transparent ? 1 : 0, out, table, cap, T);
      const [list, ring, flat, fill] = new Int32Array(buffer, out, 4);
      return {exact: copyOut(Uint8Array, buffer, exact, n), list, ring, flat, fill};
    });
  } catch (error) { fail(error); }
}

export function captureInkKeep(data, width, {x: X, y: Y, w, h}, ground) {
  const n = w * h;
  let cap = 64;
  while (cap <= n) cap *= 2;
  const [kept, keep, out3] = callFit(k => k.inkKeep, [rect(Uint8Array, data, width, X, Y, w, h, 4), w, h, ground ? into(Uint8Array, ground) : 0,
    room(n * 4), room(cap * 12), cap, room(n), room(n), room(n), out(Uint8Array, n), out(Int32Array, 4)]);
  return kept ? {c: out3[0], strong: out3[2] === 1, keep} : null;
}

const LOG2_1P = Float64Array.from({length: 256}, (_, r) => Math.log2(1 + r));
export function captureInkBits(data, width, {x: X, y: Y, w, h}, parts) {
  const boxes = new Int32Array(parts.length * 4);
  parts.forEach((r, q) => {
    const y0 = Math.max(0, r.y - Y), y1 = Math.min(h, r.y - Y + r.h);
    boxes.set([r.x - X, y0, r.w, Math.max(0, y1 - y0)], q * 4);
  });
  const [, o] = callFit(k => k.inkBits, [rect(Uint8Array, data, width, X, Y, w, h, 4), w, h, room(w * h), boxes, parts.length,
    into(Float64Array, LOG2_1P, 256), out(Int32Array, 4)], true);
  return {bits: new Float64Array(o.buffer, o.byteOffset, 1)[0], out: o[2], off: o[3]};
}

export function captureBoxLines(data, width, covered, {x: X, y: Y, w, h}) {
  const n = w * h, layout = s => {
    const rgba = s, cover = rgba + n * 4, out = cover + (n + 7 & ~7);
    return {rgba, cover, out, end: out + Math.max(w, h) * 4};
  };
  let k, at, copy = -1, buffer = null;
  const load = () => {
    ({k, at} = maskArena(layout));
    buffer = k.memory.buffer;
    const bytes = new Uint8Array(buffer);
    rowsInto(bytes, data, width, X, Y, w, h, at.rgba, 4);
    rowsInto(bytes, covered, width, X, Y, w, h, at.cover);
    copy = ++boxLinesCopy;
  };
  return (x, y, length, rows, count) => {
    try {
      if (copy !== boxLinesCopy || k.memory.buffer !== buffer) load();
      k.lineKinds(at.rgba, at.cover, (y - Y) * w + x - X, length, rows ? 1 : w, count, rows ? w : 1, at.out);
      return copyOut(Int32Array, buffer, at.out, count);
    } catch (error) { fail(error); }
  };
}
let boxLinesCopy = 0;

export function captureProtectedBoxes(width, height, regions, masks, union) {
  const n = width * height, largest = Math.max(union ? union.box.width * union.box.height : 0, ...regions.map(r => r.width * r.height));
  return spaceFit([room(n), room(largest), room(1 << 20), room((width + 2) * 24), room((width + 2) * 24)], (k, [exact, mask, boxes, prev, cur], buffer) => {
    const bytes = new Uint8Array(buffer);
    bytes.fill(1, exact, exact + n);
    let photo = 0;
    regions.forEach((r, i) => {
      if (!masks[i]) return;
      bytes.set(masks[i].exact, mask);
      photo += k.protectedCompose(exact, width, mask, r.x, r.y, r.width, r.height, 0);
    });
    if (!photo) return {photo: 0};
    if (union) {
      bytes.set(union.mask.exact, mask);
      photo -= k.protectedCompose(exact, width, mask, union.box.x, union.box.y, union.box.width, union.box.height, 1);
      if (!photo) return {photo: 0};
    }
    const count = k.protectedBoxes(exact, width, height, boxes, 1 << 16, prev, cur);
    if (count < 0) return {boxes: null};
    const words = new Int32Array(buffer, boxes, count * 4), out = new Array(count);
    for (let q = 0; q < count; q++) out[q] = {x: words[4 * q], y: words[4 * q + 1], w: words[4 * q + 2], h: words[4 * q + 3]};
    return {boxes: out};
  });
}

export function captureMarkStrokes(data, width, height, y0, h, marks) {
  const count = marks.length >> 2, from = Math.max(0, y0 - 1), to = Math.min(height, y0 + h + 1), records = new Int32Array(count * 6);
  for (let q = 0; q < count; q++) records.set(marks.subarray(4 * q, 4 * q + 4), 6 * q);
  return spaceFit([into(Uint8Array, data.subarray(from * width * 4, to * width * 4)), records, room(count * 4 + 8), room(count * 4 + 8), room(98320)],
    (k, [band, at, list, tmp, table], buffer) => {
      const n = k.markStrokes(band, width, height, from, at, count, list, tmp, table), i32 = new Int32Array(buffer);
      const order = new Int32Array(buffer, list, n), out = new Array(n);
      for (let q = 0; q < n; q++) { const r = (at >> 2) + 6 * order[q]; out[q] = {x: i32[r], y: i32[r + 1], w: i32[r + 2], h: i32[r + 3], ground: i32[r + 4]}; }
      return out;
    });
}

export function captureMaskComponents(mask, w, h) {
  const n = w * h, parts = limit => callFit(k => k.components, [into(Uint8Array, mask, n), w, h, room(limit * 20 + 16), limit, outUpTo(Int32Array, limit * 4, c => Math.max(0, c) * 4)], true);
  let [count, boxes] = parts((n >> 5) + 16);
  if (count < 0) [count, boxes] = parts(-1 - count);
  const out = new Array(count);
  for (let q = 0; q < count; q++) out[q] = {x: boxes[4 * q], y: boxes[4 * q + 1], width: boxes[4 * q + 2], height: boxes[4 * q + 3]};
  return out;
}

export function captureUnionExact(r, lossy) {
  const n = r.width * r.height, largest = Math.max(0, ...lossy.map(q => q.masked ? q.r.width * q.r.height : 0));
  return spaceFit([room(n), room(largest)], (k, [exact, mask], buffer) => {
    const bytes = new Uint8Array(buffer);
    bytes.fill(1, exact, exact + n);
    let photo = 0;
    for (const q of lossy) {
      if (q.masked) bytes.set(q.exact.subarray(0, q.r.width * q.r.height), mask);
      photo += k.unionClear(exact, r.width, q.masked ? mask : 0, q.r.x - r.x, q.r.y - r.y, q.r.width, q.r.height);
    }
    return {exact: new Uint8Array(buffer.slice(exact, exact + n)), photo};
  });
}

export function captureFillUnder(words, width, kept) {
  for (const {r, exact, fill, masked} of kept) {
    const n = r.width * r.height, [, px] = callFit(k => k.fillUnder, [made(Int32Array, n, to => rowsInto(to, words, width, r.x, r.y, r.width, r.height, 0), n),
      n, masked ? into(Uint8Array, exact, n) : 0, fill | 0], true);
    for (let y = 0; y < r.height; y++) words.set(px.subarray(y * r.width, (y + 1) * r.width), (r.y + y) * width + r.x);
  }
}

export function captureTextDiff(data, under, n) {
  const [count, diff] = callFit(k => k.diffMask, [into(Uint8Array, data, n * 4), into(Uint8Array, under, n * 4), n, out(Uint8Array, n)]);
  return {diff, count};
}

export function captureMarkFacts(data, width, y0, h, boxed, marks) {
  const count = marks.length, list = new Int32Array(count * 4);
  marks.forEach((m, q) => list.set([m.x, m.y, m.w, m.h], 4 * q));
  const [, o] = callFit(k => k.markFacts, [into(Uint8Array, data.subarray(y0 * width * 4, (y0 + h) * width * 4)), into(Uint8Array, boxed.subarray(y0 * width, (y0 + h) * width)),
    width, y0, list, count, out(Int32Array, count * 7)], true);
  const facts = marks.map((m, q) => ({open: o[7 * q] === 1, lo: [o[7 * q + 1], o[7 * q + 2], o[7 * q + 3]], hi: [o[7 * q + 4], o[7 * q + 5], o[7 * q + 6]]}));
  return {facts, grounded: ({x, y, w, h: mh}) => groundedIn(data, width, y0, h, x, y, w, mh)};
}

export function captureGrounded(data, width, x, y, w, h) {
  return groundedIn(data, width, y, h, x, y, w, h);
}
function groundedIn(data, width, y0, rows, x, y, w, h) {
  let cap = 64;
  while (cap < 2 * w * h) cap *= 2;
  return callFit(k => k.markGrounded, [into(Uint8Array, data.subarray(y0 * width * 4, (y0 + rows) * width * 4)), width, y0, x, y, w, h, room(cap * 8), cap])[0] === 1;
}

export function captureGroundCells(data, width, height, box, text) {
  const y0 = Math.max(0, box.y - 2), y1 = Math.min(height, box.y + box.h + 2), rows = Math.max(0, y1 - y0);
  let cap = 64;
  while (cap < 2 * (rows * Math.min(width, box.w + 4))) cap *= 2;
  const [ring, cells] = callFit(k => k.groundRing, [into(Uint8Array, data.subarray(y0 * width * 4, y1 * width * 4)),
    text ? into(Uint8Array, text.subarray(y0 * width, y1 * width)) : 0, width, height, y0, box.x, box.y, box.w, box.h, room(cap * 8), cap, out(Uint8Array, 32768)]);
  return ring < 16 ? null : cells;
}

export function captureTextMask(data, under, w, h) {
  const n = w * h;
  return spaceFit([into(Uint8Array, data, n * 4), into(Uint8Array, under, n * 4), room(n), room(n)], (k, [a, b, diff, mask], buffer) => {
    const count = k.diffMask(a, b, n, diff), ring = count && count * 2 <= n;
    if (ring) k.textRing(diff, w, h, mask);
    return {mask: ring ? new Uint8Array(buffer.slice(mask, mask + n)) : null, count};
  });
}

export function captureBoxBound(data, width, box, regions) {
  const {x, y, width: w, height: h} = box, pairs = Math.max(0, h - 1 + 3 >> 2), rects = new Int32Array(regions.length * 4);
  regions.forEach((r, q) => rects.set([r.x - x, r.y - y, r.width, r.height], 4 * q));
  const [, o] = callFit(k => k.boxBound, [made(Uint8Array, pairs * w * 8, to => {
    for (let q = 0; q < pairs; q++) {
      const from = ((y + 4 * q) * width + x) * 4;
      to.set(data.subarray(from, from + w * 4), q * w * 8);
      to.set(data.subarray(from + width * 4, from + width * 4 + w * 4), q * w * 8 + w * 4);
    }
  }), w, h, rects, regions.length, out(Int32Array, 2)], true);
  return {samples: o[0], bound: o[1]};
}

export function captureLinearPlanes(planes) {
  const n = planes[0].length, wide = planes.every(p => p instanceof Float32Array) ? 0 : 1, T = wide ? Float64Array : Float32Array;
  return planes.map(p => callFit(k => k.linearRows, [into(T, p, n), out(Float64Array, n), n, wide])[1]);
}

let STEP_LEVELS = null;
function stepLevels(T) {
  const step = new Uint8Array(65536);
  for (let i = 0, k = 0; i < 65536; i++) { while (k < 255 && i / 65536 >= T[k + 1]) k++; step[i] = k; }
  return step;
}
export function captureLinearRGBA(planes, width, height) {
  const n = width * height, wide = planes.every(p => p instanceof Float32Array) ? 0 : 1, T = wide ? Float64Array : Float32Array;
  const levels = wide ? wideLevels() : Float64Array.from(RGB8_THRESHOLDS), steps = wide ? null : STEP_LEVELS ??= stepLevels(RGB8_THRESHOLDS);
  return callFit(k => k.rgbaLinear, [...planes.slice(0, 3).map(p => into(T, p, n)), n, wide, into(Float64Array, levels, 256),
    steps ? into(Uint8Array, steps, 65536) : room(65536), out(Uint8ClampedArray, n * 4)])[1];
}

export function captureFrameRows({colours, indices, stride, x = 0, y = 0}, w, h) {
  stride ??= w;
  const from = y * stride + x, span = h ? (h - 1) * stride + w : 0, n = w * h;
  const head = () => [into(Uint32Array, colours), into(Uint16Array, indices.subarray(from, from + span)), stride, 0, w, h];
  return {
    soft: () => callFit(k => k.frameSoft, head())[0],
    remap: table => { const [, plane, alpha] = callFit(k => k.frameRemap, [...head(), into(Uint16Array, table), out(Uint16Array, n), out(Int16Array, n)]); return {plane, alpha}; },
  };
}

export function captureSqueezeStep(data, w, h, horizontal) {
  if (typeof __RAPIER_JXL_UPLOAD__ !== 'undefined' && __RAPIER_JXL_UPLOAD__ === true || typeof __RAPIER_JXL_CAPTURE_LEAN__ !== 'undefined' && __RAPIER_JXL_CAPTURE_LEAN__ === true) return undefined;
  const n = horizontal ? w : h, low = (n + 1) >> 1, high = n - low, ow = horizontal ? low : w, oh = horizontal ? h : low, rw = horizontal ? high : w, rh = horizontal ? h : high;
  if (base + (w * h + ow * oh + rw * rh) * 2 + 48 > MEMORY_BYTES) return undefined;
  return callOr(k => k.squeezeStep, [into(Int16Array, data, w * h), w, h, horizontal ? 1 : 0, out(Int16Array, ow * oh), out(Int16Array, rw * rh)])?.slice(1);
}

export function captureFillHoles(rgba, w, h, exact) {
  const n = w * h, [count] = callFit(k => k.maskOnes, [into(Uint8Array, exact, n), n]);
  rgba.set(callFit(k => k.fillHoles, [both(Uint8Array, rgba, n * 4), w, h, into(Uint8Array, exact, n), room(count * 16), room(w * 4)])[1]);
}

export function captureFillClear(rgba, w, h) {
  if (!(rgba instanceof Uint8Array || rgba instanceof Uint8ClampedArray) || !prepareCaptureKernels()) return rgba;
  const pixels = base + 7 & ~7, fit = Math.min(h, Math.floor((MEMORY_BYTES - pixels - 16 - w * 4) / (w * 20))), rows = fit >= h ? h : fit & ~7 || fit;
  if (rows < 1) return rgba;
  return callOr(k => at => {
    let out = null;
    for (let y = 0; y < h; y += rows) {
      const r = Math.min(rows, h - y), n = w * r, nearest = at + n * 4, column = nearest + n * 16, buffer = k.memory.buffer;
      new Uint8Array(buffer, at, n * 4).set(rgba.subarray(y * w * 4, (y + r) * w * 4));
      if (!k.fillClear(at, w, r, nearest, column)) continue;
      out ??= rgba.slice();
      out.set(new Uint8Array(buffer, at, n * 4), y * w * 4);
    }
    return out ?? rgba;
  }, [room(rows * w * 20 + w * 4)])?.[0] ?? rgba;
}

export function captureComposeOver(dst, src, w, h, bg) {
  if (!(dst instanceof Uint8Array || dst instanceof Uint8ClampedArray) || !(src instanceof Uint8Array || src instanceof Uint8ClampedArray) || !prepareCaptureKernels()) return false;
  const rows = Math.min(h, Math.floor((MEMORY_BYTES - base - 32) / (w * 8)));
  if (rows < 1) return false;
  return callOr(k => (at, under) => {
    for (let y = 0; y < h; y += rows) {
      const n = w * Math.min(rows, h - y), a = y * w * 4, u8 = new Uint8Array(k.memory.buffer);
      u8.set(dst.subarray(a, a + n * 4), at); u8.set(src.subarray(a, a + n * 4), under);
      k.composeOver(at, under, n, bg);
      dst.set(new Uint8Array(k.memory.buffer, at, n * 4), a);
    }
    return true;
  }, [room(rows * w * 4), room(rows * w * 4)])?.[0] ?? false;
}

export const photoKernels = () => {
  if (!kernelHooks.capturePhoto) throw wasmRequired();
  return kernelHooks.capturePhoto;
};

export function captureColourGroup(words, stride, x, y, width, height, rct = -1, minimumGain = 0.02) {
  const n = width * height;
  if (!(words instanceof Uint32Array) || width < 1 || height < 1 ||
      n > 1048576 || stride < width || x < 0 || y < 0 ||
      x + width > stride || (y + height - 1) * stride + x + width > words.length ||
      rct < -1 || rct > 41 || !Number.isFinite(minimumGain) || minimumGain < 0)
    outside();
  const rank = rct < 0 && width >= 4 && height >= 4 && n >= 1024;
  return run(() => {
    let heldPtr = heldAt(words);
    const align = bytes => bytes + 15 & ~15, staging = align(n * 4);
    if (rank && base + (heldPtr < 0 ? staging : 0) + 4848 > MEMORY_BYTES) {
      captureRelease(); heldPtr = -1;
    }
    const wordsPtr = heldPtr < 0 ? base : heldPtr, after = base + (heldPtr < 0 ? staging : 0);
    const planeBytes = align(n * 2 + 16), p0 = after, p1 = p0 + planeBytes, p2 = p1 + planeBytes;
    if (p2 + planeBytes > MEMORY_BYTES) throw kernelFail();
    reserve(Math.max(p2 + planeBytes, rank ? after + 4848 : 0));
    const buffer = engine.memory.buffer;
    if (heldPtr < 0) {
      const dst = new Uint32Array(buffer, wordsPtr, n);
      if (stride === width && x === 0) dst.set(words.subarray(y * stride, y * stride + n));
      else for (let row = 0, at = y * stride + x; row < height; row++, at += stride) dst.set(words.subarray(at, at + width), row * width);
    }
    const srcStride = heldPtr < 0 ? width : stride, sx = heldPtr < 0 ? 0 : x, sy = heldPtr < 0 ? 0 : y;
    if (rank) {
      const hists = after, raws = hists + 4608, prices = hists + 4688, order = prices + 144;
      const samples = engine.rctRank(wordsPtr, srcStride, sx, sy, width, height, hists, raws);
      if (!samples) throw kernelFail();
      const gain = engine.rctRankFinish(hists, raws, samples, prices, order, LOG);
      rct = gain >= minimumGain ? new Uint32Array(buffer, order, 1)[0] : 10;
    } else if (rct < 0) rct = 10;
    const mask = engine.rctUnpack(wordsPtr, srcStride, sx, sy, width, height, rct, p0, p1, p2);
    const planes = [p0, p1, p2].map(at => copyOut(Int16Array, buffer, at, n));
    for (let c = 0; c < 3; c++) Object.defineProperty(planes[c], 'constant', {value: Boolean(mask & 1 << c)});
    return {rct, planes};
  });
}

export function captureLetGo() { pageIndices = null; }

export function captureDeepLeaves(data, width, height) {
  const row = data.byteLength / height;
  return call(k => at => {
    let leaves = 0x7fff;
    for (let y = 1; leaves && y < height - 1; y += 4) {
      new Uint8Array(k.memory.buffer, at).set(new Uint8Array(data.buffer, data.byteOffset + y * row, 2 * row));
      leaves = k.deepLeaves(at, width, data instanceof Float32Array, leaves);
    }
    return leaves > 0;
  }, [room(2 * row)])[0];
}

export function captureWindowVulnerability(data, width, x, y, w, h, overlaps) {
  if (!(data instanceof Uint8Array || data instanceof Uint8ClampedArray) || !Number.isInteger(width) || width < 1 ||
      !Number.isInteger(x) || !Number.isInteger(y) || !Number.isInteger(w) || !Number.isInteger(h) ||
      x < 0 || y < 0 || w < 0 || h < 0 || x + w > width || ((y + h - 1) * width + x + w) * 4 > data.length)
    outside();
  const count = overlaps?.length ?? 0, rects = new Float64Array(count * 4);
  for (let k = 0; k < count; k++) {
    const r = overlaps[k];
    rects.set([r.x - x, r.y - y, r.x + r.width - x, r.y + r.height - y], k * 4);
  }
  const [sum, hits] = call(k => k.windowVulnerability, [rect(Uint8Array, data, width, x, y, w, h, 4), w, h, rects, count, out(Uint32Array, 1, 1)]);
  return {sum, hits: hits[0]};
}
