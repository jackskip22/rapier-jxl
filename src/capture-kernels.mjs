import {kernelModule, compileKernels, kernelsSupported, kernelInstance, arenaHolder, heldExports, growArena, takeArena} from './kernel-runtime.mjs';
// SPDX-License-Identifier: MIT
import {fault} from './fault.mjs';
import {wasmRequired} from './capture-wasm-error.mjs';
import {weightedTables} from './weighted-policy.mjs';
import {kernelHooks} from './kernel-hooks.mjs';

export const WEIGHTED_BANDS = [-200, -100, -50, -25, -12, -6, -3, -1, 0, 2, 4, 7, 13, 26, 51, 101, 201];
export const WEIGHTED_CONTEXT = Uint8Array.from({length: 511}, (_, i) => WEIGHTED_BANDS.filter(cut => cut < i - 255).length);
export const LOG_MANTISSA = Uint8Array.of(0, 1, 3, 4, 5, 7, 8, 9, 10, 11, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 22, 23, 24, 25, 26, 27, 27, 28, 29, 30, 31, 31);

const MEMORY_PAGES = 640;
const P = 65536, DIV = 16, WEIGHTS = 272, BANDS = 32768, CONTEXTS = 33280, LOG = 33792, HEADS = 262144, SCRATCH = 832;
export const kernelFail = cause => Object.assign(new Error("The capture WebAssembly kernel could not run: check memory. Under a CSP, add 'wasm-unsafe-eval' to script-src.", {cause}), {code: 'JXL_WASM'});
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
  if (w || !(plane instanceof Int16Array) || !Number.isInteger(width) || !Number.isInteger(height) ||
      width < 1 || height < 1 || width > 16384 || width * height > 1048576 || plane.length < width * height ||
      !Number.isInteger(offset) || Math.abs(offset) > 32768 || !keep && (!(residuals instanceof Uint32Array) ||
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
    throw fault('JXL_INTERNAL', 'The capture token prices were called outside their bounds.');
  requireCaptureKernels();
  try {
    ready();
    const freqs = base, used = freqs + 131072, input = used + 4096, n = values.length, tallies = input + n * 4,
      config = tallies + n * 4, output = config + configs.length * 16;
    reserve(output + configs.length * 16);
    const buffer = engine.memory.buffer, i32 = new Int32Array(buffer);
    i32.set(values, input >> 2); i32.set(counts, tallies >> 2);
    for (let k = 0; k < configs.length; k++) {
      const c = configs[k], at = (config >> 2) + k * 4;
      i32[at] = c.split; i32[at + 1] = c.msb; i32[at + 2] = c.lsb; i32[at + 3] = c.splitToken;
    }
    engine.prices(input, tallies, n, config, configs.length, distance ? 1 : 0, freqs, used, LOG, output);
    return new Float64Array(buffer.slice(output, output + configs.length * 16));
  } catch (error) {
    throw error?.code ? error : kernelFail(error);
  }
}

export function captureCopies(values, stride, origin, width, height, contexts, depth, minimum, scale, spatial, lazyUnder = 1 << 30, nice = 1 << 30) {
  try {
    if (!prepareCaptureKernels()) throw wasmRequired();
    const n = width * height;
    const smooth = !(typeof __RAPIER_JXL_JPEG__ !== 'undefined' && __RAPIER_JXL_JPEG__ === true) && values instanceof Int16Array;
    if (!(values instanceof Uint16Array || smooth && stride === width && !origin && contexts === null) ||
        !Number.isInteger(width) || width < 1 || width > 16384 || !Number.isInteger(height) || height < 1 ||
        n > 1048576 || !Number.isInteger(stride) || stride < width || !Number.isInteger(origin) || origin < 0 ||
        origin + (height - 1) * stride + width > values.length || contexts !== null && !(contexts instanceof Uint8Array && contexts.length >= n) ||
        !(spatial instanceof Uint8Array) || spatial.length > width * 8 + 64 || !Number.isInteger(depth) || depth < 0 || depth > 64 ||
        !Number.isInteger(minimum) || minimum < 1 || !Number.isInteger(scale) || scale < 1 || scale > 2 ||
        !Number.isInteger(lazyUnder) || lazyUnder < 0 || lazyUnder > 1 << 30 || !Number.isInteger(nice) || nice < 1 || nice > 1 << 30)
      throw fault('JXL_INTERNAL', 'The capture copy search was called outside its bounds.');
    ready();
    const scratch = base + spatial.length + 3 & ~3, heads = scratch + SCRATCH, at = heads + (depth ? HEADS : 0);
    const chain = at + (n * 2 + 19 & ~3), value = chain + (depth ? n * 4 : 0), distance = value + n * 4, context = distance + n * 4;
    reserve(context + n + 16);
    const buffer = engine.memory.buffer, bytes = new Uint8Array(buffer), plane = new Uint16Array(buffer, at, n);
    bytes.set(spatial, base);
    if (smooth) {
      new Int16Array(buffer, value, n).set(values.subarray(0, n));
      engine.smooth(value, width, 0, height, at, context);
    } else {
      if (stride === width) plane.set(values.subarray(origin, origin + n));
      else for (let y = 0, from = origin; y < height; y++, from += stride) plane.set(values.subarray(from, from + width), y * width);
      if (contexts) bytes.set(contexts.subarray(0, n), context);
    }
    const hasCtx = smooth || Boolean(contexts);
    const count = engine.copies(at, hasCtx ? context : 0, n, width, depth, minimum, scale, base, spatial.length, heads, chain, scratch, value, distance, context, lazyUnder, nice);
    return {count, value: new Int32Array(buffer.slice(value, value + count * 4)), distance: new Int32Array(buffer.slice(distance, distance + count * 4)),
      context: hasCtx ? new Uint8Array(buffer.slice(context, context + count)) : new Uint8Array(count)};
  } catch (error) {
    throw error?.code ? error : kernelFail(error);
  }
}

export function captureWeightedPieces(plane, width, height, minimum, y0 = 0) {
  if (!captureWeighted(null, null, plane, width, height, 0, undefined, null, null, true, y0))
    throw kernelFail();
  try {
    const n = width * height, residual = base + n * 4, property = base + n * 8, context = base + n * 12 + (width + 2) * 40;
    reserve(context + n);
    const count = engine.runs(residual, property, n, minimum, BANDS, context), buffer = engine.memory.buffer;
    return {count, value: new Int32Array(buffer.slice(residual, residual + count * 4)), distance: new Int32Array(buffer.slice(property, property + count * 4)),
      context: new Uint8Array(buffer.slice(context, context + count))};
  } catch (error) {
    throw kernelFail(error);
  }
}

const MEMORY_BYTES = MEMORY_PAGES * 65536;
export function captureWeightedLanes(planes, width, height, minimum, small, gradient = false, answers = null) {
  const n = width * height, lanes = planes.length;
  if (lanes < 2 || lanes > 4 || !Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 16384 ||
      n > 1048576 || planes.some(plane => !(plane instanceof Int16Array) || plane.length < n) || !prepareCaptureKernels())
    throw fault('JXL_INTERNAL', 'The capture weighted lanes were called outside their bounds.');
  try {
    ready();
    const written = lanes === 4 ? 4 : 3, state = base, plane = state + (width + 2) * 160, residual = plane + n * 8,
      property = residual + n * 4 * written, context = property + n * 4 * written, classes = WEIGHTED_BANDS.length + 1,
      table = context + n + 19 & ~3, literals = table + classes * small * 4, others = literals + classes * 4, end = others + n * 4;
    if (end > MEMORY_BYTES) return null;
    reserve(end);
    const buffer = engine.memory.buffer, samples = new Int16Array(buffer, plane, n * 4);
    if ((typeof __RAPIER_JXL_CAPTURE_DEEP__ === 'undefined' || __RAPIER_JXL_CAPTURE_DEEP__) && answers) answers.forEach((a, c) => {
      new Uint32Array(buffer, residual + c * n * 4, n).set(a.residuals.subarray(0, n));
      new Int32Array(buffer, property + c * n * 4, n).set(a.properties.subarray(0, n));
    });
    else {
      new Uint8Array(buffer, state, (width + 2) * 160).fill(0);
      for (let c = 0; c < 4; c++) {
        const source = planes[c];
        if (source) for (let i = 0, at = c; i < n; i++, at += 4) samples[at] = source[i];
        else for (let at = c; at < n * 4; at += 4) samples[at] = 0;
      }
      if (gradient) engine.gradient4(plane, width, height, written, residual, property);
      else engine.weighted4(plane, width, height, written, residual, property, DIV, WEIGHTS, state);
    }
    return planes.map((_, c) => {
      const values = residual + c * n * 4, distances = property + c * n * 4;
      const count = engine.runs(values, distances, n, minimum, gradient ? CONTEXTS : BANDS, context);
      new Int32Array(buffer, table, classes * (small + 1)).fill(0);
      const other = engine.pieces(values, distances, context, count, small, table, literals, others);
      return {count, value: new Int32Array(buffer.slice(values, values + count * 4)), distance: new Int32Array(buffer.slice(distances, distances + count * 4)),
        context: new Uint8Array(buffer.slice(context, context + count)),
        counts: {counts: new Uint32Array(buffer.slice(table, literals)), literals: new Uint32Array(buffer.slice(literals, literals + classes * 4)),
          others: new Int32Array(buffer.slice(others, others + other * 4))}};
    });
  } catch (error) {
    throw error?.code ? error : kernelFail(error);
  }
}

export const SCAN_WORDS = 1 << 21;
export function captureLowestInk(words, width, height, background, stride = width, origin = 0) {
  if (!(words instanceof Uint32Array) || !Number.isInteger(width) || !Number.isInteger(height) || width < 1 || width > 32767 ||
      height < 1 || height > 32767 || !Number.isInteger(stride) || stride < width || !Number.isInteger(origin) || origin < 0 ||
      origin + (height - 1) * stride + width > words.length)
    throw fault('JXL_INTERNAL', 'The capture column scan was called outside its bounds.');
  requireCaptureKernels();
  try {
    ready();
    const at = heldAt(words.subarray(origin, origin + (height - 1) * stride + width));
    const lowest = base, open = lowest + width * 4, pixels = open + width * 4, rows = at < 0 ? Math.min(height, Math.floor(SCAN_WORDS / width)) : height;
    reserve(at < 0 ? pixels + rows * width * 4 : pixels);
    const buffer = engine.memory.buffer, i32 = new Int32Array(buffer), u32 = new Uint32Array(buffer);
    i32.fill(-1, lowest >> 2, (lowest >> 2) + width);
    i32.fill(-1, open >> 2, (open >> 2) + width);
    for (let end = height, count = width; end && count;) {
      const start = Math.max(0, end - rows);
      if (at < 0) for (let y = start; y < end; y++) u32.set(words.subarray(origin + y * stride, origin + y * stride + width), (pixels >> 2) + (y - start) * width);
      count = at < 0 ? engine.lowestInk(pixels, width, width, end - start, start, background, open, count, lowest)
        : engine.lowestInk(at + start * stride * 4, width, stride, end - start, start, background, open, count, lowest);
      end = start;
    }
    return new Int32Array(buffer.slice(lowest, lowest + width * 4));
  } catch (error) {
    throw error?.code ? error : kernelFail(error);
  }
}

export function captureCropEdges(words, width, height, stride = width, origin = 0) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || stride < width || origin < 0) return undefined;
  const at = heldAt(words.subarray(origin, origin + (height - 1) * stride + width));
  if (at < 0) return undefined;
  try {
    const out = base;
    reserve(out + 16);
    engine.edges(at, width, height, stride, out);
    const edges = new Int32Array(engine.memory.buffer, out, 4);
    return edges[0] === width * height ? null : Array.from(edges);
  } catch { return undefined; }
}

export function captureRowsUnlike(words, width, height, stride, origin) {
  const at = heldAt(words.subarray(origin, origin + (height - 1) * stride + width));
  if (at < 0) return undefined;
  try {
    reserve(base + height * 4);
    engine.rowInk(at, width, height, stride, base);
    return new Int32Array(engine.memory.buffer.slice(base, base + height * 4));
  } catch { return undefined; }
}
export function captureColumnsUnlike(words, width, height, stride, origin, y0, y1, key) {
  const at = heldAt(words.subarray(origin, origin + (height - 1) * stride + width));
  if (at < 0 || !(y0 >= 0 && y0 <= y1 && y1 <= height)) return undefined;
  try {
    reserve(base + width * 4);
    engine.colInk(at, width, y0, y1, stride, key, base);
    return new Int32Array(engine.memory.buffer.slice(base, base + width * 4));
  } catch { return undefined; }
}

let pageIndices = null;
export function captureScan(words, stride, x0, y0, w, h, limit, rows, blank = null) {
  if (!(words instanceof Uint32Array) || !Number.isInteger(stride) || !Number.isInteger(w) || !Number.isInteger(h) || w < 1 || h < 1 ||
      x0 < 0 || y0 < 0 || x0 + w > stride || stride > SCAN_WORDS || (y0 + h) * stride > words.length ||
      !Number.isInteger(limit) || limit < 1 || limit > 16384 || !prepareCaptureKernels()) return undefined;
  try {
    ready();
    let size = 1024;
    while (size < limit * 2) size <<= 1;
    const bandRows = Math.min(h, Math.floor(SCAN_WORDS / stride)), band = stride * bandRows, n = w * h,
      rowsAt = blank ? -1 : heldAt(words.subarray(y0 * stride, (y0 + h) * stride)), keys = base, slots = keys + size * 4,
      colours = slots + size * 2, first = colours + limit * 4, last = first + limit * 4, at = rowsAt < 0 ? last + limit * 4 : rowsAt,
      indices = rowsAt < 0 ? at + band * 4 : last + limit * 4;
    reserve(indices + w * bandRows * 2 + 3 & ~3);
    const buffer = engine.memory.buffer;
    new Uint8Array(buffer, keys, size * 6).fill(0);
    let plane, count = 0;
    for (let y = 0; y < h; y += bandRows) {
      const height = Math.min(bandRows, h - y);
      if (rowsAt < 0) {
        const band = new Uint32Array(buffer, at, stride * height), top = y0 + y;
        band.set(words.subarray(top * stride, (top + height) * stride));
        if (blank) for (const r of blank) for (let row = Math.max(r.y, top); row < Math.min(r.y + r.height, top + height); row++)
          band.fill(r.fill, (row - top) * stride + r.x, (row - top) * stride + r.x + r.width);
      }
      count = engine.scan(rowsAt < 0 ? at : at + y * stride * 4, stride, x0, w, height, limit, rows ? 1 : 0,
        keys, slots, size - 1, Math.clz32(size) + 1, colours, indices, first, last, count, y);
      if (count < 0) return null;
      if (!plane) {
        if (rows && n <= SCAN_WORDS) {
          if (!pageIndices || pageIndices.length < n) pageIndices = new Uint16Array(Math.max(n, 1 << 20));
          plane = pageIndices.subarray(0, n);
        } else plane = new Uint16Array(n);
      }
      plane.set(new Uint16Array(buffer, indices, w * height), y * w);
    }
    return {colours: new Uint32Array(buffer.slice(colours, colours + count * 4)), indices: plane,
      first: rows ? new Int32Array(buffer.slice(first, first + count * 4)) : undefined, last: rows ? new Int32Array(buffer.slice(last, last + count * 4)) : undefined};
  } catch { return undefined; }
}

const TEXT_DELTA_SLOTS = 65536, TEXT_DELTA_LIMIT = 16384;
export function captureTextDelta(colours, indices, stride, x, y, width, height) {
  const pixels = width * height, origin = y * stride + x;
  if (!(colours instanceof Uint32Array) || !(indices instanceof Uint16Array) || colours.length < 1 || colours.length > TEXT_DELTA_LIMIT ||
      !Number.isInteger(stride) || stride < width || !Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 ||
      pixels > (1 << 22) || origin < 0 || origin + (height - 1) * stride + width > indices.length || !prepareCaptureKernels()) return null;
  try {
    ready();
    const colourAt = base, indexAt = colourAt + colours.length * 4, outAt = indexAt + indices.length * 2,
      slotsAt = (outAt + pixels * 2 + 3) & ~3, deltaAt = slotsAt + TEXT_DELTA_SLOTS * 8, statsAt = (deltaAt + TEXT_DELTA_LIMIT * 6 + 3) & ~3;
    reserve(statsAt + 16);
    const buffer = engine.memory.buffer;
    new Uint32Array(buffer, colourAt, colours.length).set(colours);
    new Uint16Array(buffer, indexAt, indices.length).set(indices);
    const count = engine.textDelta(colourAt, colours.length, indexAt, stride, width, height, origin, outAt, slotsAt, TEXT_DELTA_SLOTS - 1, deltaAt, statsAt, TEXT_DELTA_LIMIT);
    if (count < 1) return null;
    const stats = new Uint32Array(buffer, statsAt, 4);
    return {indices: new Uint16Array(buffer.slice(outAt, outAt + pixels * 2)),
      deltas: new Int16Array(buffer.slice(deltaAt, deltaAt + count * 6)),
      count, novel: stats[1], l1: stats[2], hits: stats[3]};
  } catch (error) {
    throw error?.code ? error : kernelFail(error);
  }
}

export function treeArena(count, span) {
  if (!Number.isInteger(count) || count < 1 || count > 1048576 || !Number.isInteger(span) || span < 128 || span > 65536 || !prepareCaptureKernels())
    throw fault('JXL_INTERNAL', 'The capture context tree was called outside its bounds.');
  try {
    ready();
    const all = base, counts = all + 512, order = counts + span * 16, scratch = order + count * 4, tokens = scratch + count * 4;
    const by = tokens + count, bx = by + count, bw = bx + count, bn = bw + count, end = bn + count;
    reserve(end);
    const buffer = engine.memory.buffer, {tally, part} = engine, bins = [by, bx, bw, bn];
    return {
      all: new Uint32Array(buffer, all, 128), counts: new Uint32Array(buffer, counts, span * 4), order: new Int32Array(buffer, order, count),
      tokens: new Uint8Array(buffer, tokens, count), by: new Uint8Array(buffer, by, count), bx: new Uint8Array(buffer, bx, count),
      bw: new Uint8Array(buffer, bw, count), bn: new Uint8Array(buffer, bn, count),
      tally: (from, to, withBins) => tally(order, from, to, tokens, by, bx, bw, bn, all, counts, span, withBins ? 1 : 0),
      part: (from, to, property, cut) => part(order, from, to, bins[property], cut, scratch),
    };
  } catch (error) {
    throw error?.code ? error : kernelFail(error);
  }
}

export function captureLiterals(models, n, remap) {
  if (!Number.isInteger(n) || n < 1 || n > 65536 || remap && !(remap instanceof Int32Array && remap.length >= n) || !prepareCaptureKernels())
    throw fault('JXL_INTERNAL', 'The capture palette pieces were called outside their bounds.');
  try {
    ready();
    const table = base, values = table + n * 4;
    let loaded = false;
    for (const model of models) {
      const count = model.count;
      if (!(model.pieceValue instanceof Int32Array) || !(model.pieceDistance instanceof Int32Array) || !Number.isInteger(count) ||
          count < 1 || count > 1048576 || model.pieceValue.length < count || model.pieceDistance.length < count)
        throw fault('JXL_INTERNAL', 'The capture palette pieces were called outside their bounds.');
      const distances = values + count * 4;
      reserve(distances + count * 4);
      const buffer = engine.memory.buffer, i32 = new Int32Array(buffer);
      if (!loaded) {
        if (remap) i32.set(remap.subarray(0, n), table >> 2);
        else i32.fill(0, table >> 2, (table >> 2) + n);
        loaded = true;
      }
      i32.set(model.pieceValue.subarray(0, count), values >> 2);
      i32.set(model.pieceDistance.subarray(0, count), distances >> 2);
      engine.literals(values, distances, count, table, remap ? 1 : 0);
      if (remap) model.pieceValue.set(i32.subarray(values >> 2, (values >> 2) + count));
    }
    return remap ? undefined : loaded ? new Uint32Array(engine.memory.buffer.slice(table, table + n * 4)) : new Uint32Array(n);
  } catch (error) {
    throw error?.code ? error : kernelFail(error);
  }
}

export function capturePieceCounts(model, small) {
  const {count, classes, pieceValue, pieceDistance, pieceContext} = model;
  if (!Number.isInteger(count) || count < 1 || count > 1048576 || !Number.isInteger(classes) || classes < 1 || classes > 4096 ||
      !(pieceValue instanceof Int32Array) || !(pieceDistance instanceof Int32Array) || !(pieceContext instanceof Uint8Array) ||
      pieceValue.length < count || pieceDistance.length < count || pieceContext.length < count || !Number.isInteger(small) ||
      small < 1 || small > 4096 || classes * small > 1 << 21 || !prepareCaptureKernels())
    throw fault('JXL_INTERNAL', 'The capture histograms were called outside their bounds.');
  try {
    ready();
    const table = base, literals = table + classes * small * 4, values = literals + classes * 4, distances = values + count * 4;
    const others = distances + count * 4, contexts = others + count * 4;
    reserve(contexts + count);
    const buffer = engine.memory.buffer, i32 = new Int32Array(buffer);
    i32.fill(0, table >> 2, values >> 2);
    i32.set(pieceValue.subarray(0, count), values >> 2);
    i32.set(pieceDistance.subarray(0, count), distances >> 2);
    new Uint8Array(buffer).set(pieceContext.subarray(0, count), contexts);
    const n = engine.pieces(values, distances, contexts, count, small, table, literals, others);
    return {counts: new Uint32Array(buffer.slice(table, literals)), literals: new Uint32Array(buffer, literals, classes),
      others: new Int32Array(buffer, others, n)};
  } catch (error) {
    throw error?.code ? error : kernelFail(error);
  }
}

const TOKEN_OUT = 1 << 18;
export function captureTokens(writer, models, index, codes, configs, fastBits, fastLen, copy) {
  requireCaptureKernels();
  try {
    ready();
    const hn = codes.length;
    let symbols = 0;
    for (const code of codes) symbols += code.lengths.length;
    const dSymbols = copy ? copy.code.lengths.length : 0, sLen = copy ? copy.sCodes.length : 0;
    let largest = 1;
    for (const model of models) largest = Math.max(largest, model.count);
    const state = base, hmap = state + 16, syms = hmap + 1024, cfg = syms + hn * 4, lengthConfig = cfg + hn * 16,
      distanceConfig = lengthConfig + 16, fast = distanceConfig + 16, codeTable = fast + hn * 4096, dcodes = codeTable + symbols * 8,
      sCodes = dcodes + dSymbols * 8, values = sCodes + (sLen * 2 + 7 & ~7), distances = values + largest * 4,
      contexts = distances + largest * 4, out = contexts + (largest + 7 & ~7), end = out + TOKEN_OUT + 64;
    reserve(end);
    const buffer = engine.memory.buffer, i32 = new Int32Array(buffer), u32 = new Uint32Array(buffer), u8 = new Uint8Array(buffer);
    const putConfig = (at, c) => { i32[at >> 2] = c.split; i32[(at >> 2) + 1] = c.msb; i32[(at >> 2) + 2] = c.lsb; i32[(at >> 2) + 3] = c.splitToken; };
    for (let h = 0, at = 0; h < hn; h++) {
      const {lengths, codes: bits} = codes[h];
      i32[(syms >> 2) + h] = at;
      putConfig(cfg + h * 16, configs[h]);
      for (let s = 0; s < lengths.length; s++, at++) { u32[(codeTable >> 2) + at * 2] = bits[s]; u32[(codeTable >> 2) + at * 2 + 1] = lengths[s]; }
    }
    for (let i = 0, n = hn << 9; i < n; i++) { u32[(fast >> 2) + i * 2] = fastBits[i]; u32[(fast >> 2) + i * 2 + 1] = fastLen[i]; }
    if (copy) {
      putConfig(lengthConfig, copy.lengthConfig); putConfig(distanceConfig, copy.distanceConfig);
      const {lengths, codes: bits} = copy.code;
      for (let s = 0; s < lengths.length; s++) { u32[(dcodes >> 2) + s * 2] = bits[s]; u32[(dcodes >> 2) + s * 2 + 1] = lengths[s]; }
      new Int16Array(buffer, sCodes, sLen).set(copy.sCodes);
    }
    new BigInt64Array(buffer, state, 1)[0] = BigInt(writer.acc);
    i32[(state >> 2) + 2] = writer.pending;
    for (const model of models) {
      const count = model.count, classes = model.classes;
      for (let c = 0; c < classes; c++) i32[(hmap >> 2) + c] = index[model.base + c];
      i32.set(model.pieceValue.subarray(0, count), values >> 2);
      i32.set(model.pieceDistance.subarray(0, count), distances >> 2);
      u8.set(model.pieceContext.subarray(0, count), contexts);
      for (let k = 0; k < count;) {
        k = engine.captureTokens(values, distances, contexts, k, count, hmap, fast, syms, codeTable, cfg, lengthConfig, distanceConfig,
          dcodes, copy ? copy.minSymbol : 0, copy?.spatial ? 1 : 0, sLen, sCodes, out, out + TOKEN_OUT, state);
        const written = i32[(state >> 2) + 3] - out;
        if (writer.at + written + 16 >= writer.bytes.length) writer.grow(written + 16);
        writer.bytes.set(u8.subarray(out, out + written), writer.at);
        writer.at += written;
      }
    }
    writer.acc = Number(new BigInt64Array(buffer, state, 1)[0]); writer.pending = i32[(state >> 2) + 2];
  } catch (error) {
    throw error?.code ? error : kernelFail(error);
  }
}

const PATCH_RUNS = 1 << 17, PATCH_BAND = 1 << 22;
export function capturePatchMarks(words, width, height, side, limit, least) {
  if (!prepareCaptureKernels()) return null;
  try {
    ready();
    const n = width * height, at = heldAt(words), band = at < 0 ? Math.max(1, Math.min(height, PATCH_BAND / (4 * width) | 0)) : height;
    const ink = base, above = ink + (n + 15 & ~15), stack = above + (width * 4 + 15 & ~15), boxes = stack + PATCH_RUNS * 12,
      rows = boxes + limit * 16, end = at < 0 ? rows + (band + 2) * width * 4 : rows;
    if (end > MEMORY_BYTES) return null;
    reserve(end);
    const buf = engine.memory.buffer;
    new Uint8Array(buf, ink, n).fill(0);
    new Int32Array(buf, above, width).fill(-1);
    if (at >= 0) engine.patchInk(at, width, height, 0, height, ink, above);
    else for (let y = 0; y < height; y += band) {
      const from = Math.max(0, y - 1), to = Math.min(height, y + band + 1);
      new Uint32Array(buf, rows, (to - from) * width).set(words.subarray(from * width, to * width));
      engine.patchInk(rows + (y - from) * width * 4, width, Math.min(band, height - y), y, height, ink + y * width, above);
    }
    const found = engine.patchMarks(ink, width, height, stack, PATCH_RUNS, boxes, limit, side, least);
    return found < 0 ? null : new Int32Array(buf, boxes, found * 4).slice();
  } catch { return null; }
}

const PEEL_MARKS = 1 << 18, PEEL_RUNS = 1 << 20;
export function capturePeelMarks(words, width, height, bg, side) {
  if (!prepareCaptureKernels()) return null;
  try {
    ready();
    const n = width * height, at = heldAt(words), band = at < 0 ? Math.max(1, Math.min(height, PATCH_BAND / (4 * width) | 0)) : height;
    const ink = base, stack = ink + (n + 15 & ~15), runs = stack + PATCH_RUNS * 12, marks = runs + PEEL_RUNS * 12,
      rows = marks + PEEL_MARKS * 24, end = at < 0 ? rows + band * width * 4 : rows;
    if (end > MEMORY_BYTES) return null;
    reserve(end);
    if (at >= 0) engine.peelInk(at, n, bg, ink);
    else for (let y = 0; y < height; y += band) {
      const to = Math.min(height, y + band);
      new Uint32Array(engine.memory.buffer, rows, (to - y) * width).set(words.subarray(y * width, to * width));
      engine.peelInk(rows, (to - y) * width, bg, ink + y * width);
    }
    const found = engine.peelMarks(ink, width, height, stack, PATCH_RUNS, runs, PEEL_RUNS, marks, PEEL_MARKS, side);
    if (found < 0) return null;
    const buf = engine.memory.buffer, list = new Int32Array(buf, marks, found * 6).slice();
    return {marks: list, runs: new Int32Array(buf, runs, found ? list[found * 6 - 1] : 0).slice()};
  } catch { return null; }
}

export function capturePeelBackground(words) {
  requireCaptureKernels();
  ready();
  const n = words.length, samples = Math.ceil(n / 61), capacity = 2 ** Math.ceil(Math.log2(Math.max(2, samples * 2))),
    table = base, order = table + capacity * 8, state = order + samples * 4, input = state + 16,
    at = heldAt(words), band = Math.min(n, SCAN_WORDS);
  reserve(at < 0 ? input + band * 4 : input);
  new Uint8Array(engine.memory.buffer, table, capacity * 8).fill(0);
  new Int32Array(engine.memory.buffer, state, 1)[0] = 0;
  let bg = 0;
  for (let offset = 0; offset < n; offset += band) {
    const size = Math.min(band, n - offset);
    if (at < 0) new Uint32Array(engine.memory.buffer, input, size).set(words.subarray(offset, offset + size));
    bg = engine.peelBackground(at < 0 ? input : at + offset * 4, size, offset, table, capacity - 1, order, state, offset + size === n);
  }
  return bg >>> 0;
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
      return pixels < 0 ? null : {cells: new Uint32Array(buffer, out, size).slice(), pixels};
    },
    info(cells, width, height, ink = false) {
      const input = scratch, out = input + cells.byteLength, triples = out + 16,
        buffer = arena(triples + (ink ? cells.length * 12 : 0));
      new Uint32Array(buffer, input, cells.length).set(cells);
      const count = engine.peelGlyphs(input, width, height, id, ink ? triples : 0, out);
      return {hash: new Int32Array(buffer, out, 1)[0], inkCount: count,
        ink: ink ? new Int32Array(buffer, triples, count * 3).slice() : null};
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
      const count = new Int32Array(buffer, state, 3)[2], matches = new Int32Array(buffer, out, count * 3).slice(),
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

export function captureTreeWalk(nodes, plane, width, height, residuals, wp, references) {
  const n = width * height, sixteen = a => a instanceof Int16Array || a.every(v => v >= -32768 && v <= 32767);
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || plane.length < n ||
      residuals.length < n || wp.length < n || references.some(r => r.length < n) || !sixteen(plane) || !references.every(sixteen))
    throw fault('JXL_INTERNAL', 'The tree walk was called outside its bounds.');
  requireCaptureKernels(); ready();
  const R = references.length, align = bytes => bytes + 15 & ~15, tree = base, start = tree + align(nodes.length * 4);
  const perRow = width * (2 + 2 * R + 13), halo = width * (4 + 2 * R) + 16 * (R + 6);
  const rows = Math.min(height, Math.floor((MEMORY_BYTES - start - halo) / perRow));
  if (rows < 1) throw kernelFail();
  const values = new Int32Array(n), contexts = new Uint8Array(n);
  for (let y0 = 0; y0 < height; y0 += rows) {
    const y1 = Math.min(height, y0 + rows), m = (y1 - y0) * width, above = Math.min(y0, 2), refAbove = Math.min(y0, 1);
    const refAt = start + align((above + y1 - y0) * width * 2), span = (refAbove + y1 - y0) * width;
    const res = refAt + align(R * span * 2), props = res + m * 4, coded = props + m * 4, ctx = coded + m * 4;
    reserve(ctx + m + 16);
    const buf = engine.memory.buffer, row0 = start + above * width * 2;
    if (y0 === 0) new Int32Array(buf, tree, nodes.length).set(nodes);
    new Int16Array(buf, start, (above + y1 - y0) * width).set(plane.subarray((y0 - above) * width, y1 * width));
    references.forEach((r, k) => new Int16Array(buf, refAt + k * span * 2, span).set(r.subarray((y0 - refAbove) * width, y1 * width)));
    new Uint32Array(buf, res, m).set(residuals.subarray(y0 * width, y1 * width)); new Int32Array(buf, props, m).set(wp.subarray(y0 * width, y1 * width));
    engine.treeWalk(row0, width, y0, y1 - y0, tree, res, props, refAt + refAbove * width * 2, span, coded, ctx);
    values.set(new Int32Array(buf, coded, m), y0 * width); contexts.set(new Uint8Array(buf, ctx, m), y0 * width);
  }
  return {values, contexts};
}

export function captureDenseTiles(words, stride, x, y, width, height) {
  if (!(words instanceof Uint32Array) || !Number.isInteger(stride) || !Number.isInteger(x) || !Number.isInteger(y) ||
      !Number.isInteger(width) || !Number.isInteger(height) || x < 0 || y < 0 || width < 1 || height < 1 ||
      width > 32767 || height > 32767 || x + width > stride || (y + height - 1) * stride + x + width > words.length)
    throw fault('JXL_INTERNAL', 'The dense tile scan was called outside its bounds.');
  requireCaptureKernels(); ready();
  const tx = Math.ceil(width / 16), mask = new Uint8Array(tx * Math.ceil(height / 16)), held = heldAt(words);
  const pixels = base, output = held >= 0 ? base : base + 17 * width * 4;
  reserve(output + tx);
  const buffer = engine.memory.buffer, data = new Uint32Array(buffer);
  for (let by = 0; by * 16 < height; by++) {
    const start = Math.max(0, by * 16 - 1), end = Math.min(height, (by + 1) * 16);
    if (held < 0) for (let row = start; row < end; row++)
      data.set(words.subarray((y + row) * stride + x, (y + row) * stride + x + width), (pixels >> 2) + (row - start) * width);
    engine.denseTiles(held >= 0 ? held + ((y + start) * stride + x) * 4 : pixels,
      held >= 0 ? stride : width, width, end - start, output);
    mask.set(new Uint8Array(buffer, output, tx), by * tx);
  }
  return mask;
}

export function captureMergePhotoHints(rects) {
  const n = rects.length;
  if (n < 2) return rects;
  if (n > 65536) throw fault('JXL_INTERNAL', 'The photo hints were called outside their bounds.');
  requireCaptureKernels(); ready();
  try {
    const out = base + n * 24;
    reserve(out + n * 24);
    const words = new Uint32Array(engine.memory.buffer);
    for (let i = 0; i < n; i++) {
      const r = rects[i], right = r.x + r.width, bottom = r.y + r.height, at = (base >> 2) + i * 6;
      if (![r.x, r.y, right, bottom].every(v => Number.isInteger(v) && v >= 0 && v <= 0xffffffff) || right <= r.x || bottom <= r.y)
        throw fault('JXL_INTERNAL', 'The photo hints were called outside their bounds.');
      words[at] = r.x; words[at + 1] = r.y; words[at + 2] = right; words[at + 3] = bottom;
      words[at + 4] = r.rescued ? 1 : 0; words[at + 5] = i;
    }
    const count = engine.mergePhotoHints(base, n, out), ordered = new Array(n);
    for (let i = 0; i < count; i++) {
      const at = (out >> 2) + i * 6, x = words[at], y = words[at + 1];
      const r = {x, y, width: words[at + 2] - x, height: words[at + 3] - y};
      if (words[at + 4]) r.rescued = true;
      ordered[words[at + 5]] = r;
    }
    return ordered.filter(Boolean);
  } catch (error) {
    throw error?.code ? error : kernelFail(error);
  }
}

export function captureMaskRuns(px, w, h) {
  if (typeof __RAPIER_JXL_UPLOAD__ !== 'undefined' && __RAPIER_JXL_UPLOAD__ === true || typeof __RAPIER_JXL_CAPTURE_LEAN__ !== 'undefined' && __RAPIER_JXL_CAPTURE_LEAN__ === true) return undefined;
  const n = w * h, words = base + 7 & ~7, mark = words + n * 4, pixels = mark + (n + 7 & ~7), runs = pixels + n * 4, out = runs + (n >> 1) * 12 + 12;
  if (out + 8 > MEMORY_BYTES || !prepareCaptureKernels()) return undefined;
  try {
    ready();
    reserve(out + 8);
    const buffer = engine.memory.buffer;
    new Int32Array(buffer, words, n).set(px);
    new Uint8Array(buffer, mark, n).fill(0);
    const count = engine.maskRuns(words, w, h, mark, pixels, runs, out);
    const list = new Int32Array(buffer.slice(runs, runs + count * 12)), last = count ? list[count * 3 - 3] + list[count * 3 - 2] : 0;
    return {pixels: new Int32Array(buffer.slice(pixels, pixels + last * 4)), runs: list, transparent: new Int32Array(buffer, out, 1)[0]};
  } catch { return undefined; }
}

export function captureSqueezeStep(data, w, h, horizontal) {
  if (typeof __RAPIER_JXL_UPLOAD__ !== 'undefined' && __RAPIER_JXL_UPLOAD__ === true || typeof __RAPIER_JXL_CAPTURE_LEAN__ !== 'undefined' && __RAPIER_JXL_CAPTURE_LEAN__ === true) return undefined;
  const n = horizontal ? w : h, low = (n + 1) >> 1, high = n - low, ow = horizontal ? low : w, oh = horizontal ? h : low, rw = horizontal ? high : w, rh = horizontal ? h : high;
  const p = base + 7 & ~7, out = p + (w * h * 2 + 7 & ~7), res = out + (ow * oh * 2 + 7 & ~7), end = res + rw * rh * 2;
  if (end > MEMORY_BYTES || !prepareCaptureKernels()) return undefined;
  try {
    ready();
    reserve(end);
    const buffer = engine.memory.buffer;
    new Int16Array(buffer, p, w * h).set(data.subarray(0, w * h));
    engine.squeezeStep(p, w, h, horizontal ? 1 : 0, out, res);
    return [new Int16Array(buffer.slice(out, out + ow * oh * 2)), new Int16Array(buffer.slice(res, res + rw * rh * 2))];
  } catch { return undefined; }
}

export function captureFillHoles(rgba, w, h, exact, count) {
  if (typeof __RAPIER_JXL_UPLOAD__ !== 'undefined' && __RAPIER_JXL_UPLOAD__ === true || typeof __RAPIER_JXL_CAPTURE_LEAN__ !== 'undefined' && __RAPIER_JXL_CAPTURE_LEAN__ === true) return false;
  const n = w * h, pixels = base + 7 & ~7, mask = pixels + n * 4, nearest = mask + (n + 7 & ~7), column = nearest + count * 16;
  if (column + w * 4 > MEMORY_BYTES || !prepareCaptureKernels()) return false;
  try {
    ready();
    reserve(column + w * 4);
    const buffer = engine.memory.buffer;
    new Uint8Array(buffer, pixels, n * 4).set(rgba.subarray(0, n * 4));
    new Uint8Array(buffer, mask, n).set(exact.subarray(0, n));
    engine.fillHoles(pixels, w, h, mask, nearest, column);
    rgba.set(new Uint8Array(buffer, pixels, n * 4));
    return true;
  } catch { return false; }
}

export const photoKernels = () => {
  if (!kernelHooks.capturePhoto) throw wasmRequired();
  return kernelHooks.capturePhoto;
};
