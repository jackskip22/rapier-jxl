// SPDX-License-Identifier: MIT
import {reconstruct, toRGBAInto} from './reconstruct.mjs';
import {rebuildPicture, rebuildable} from './photo-rebuild.mjs';
import {butteraugli, butteraugliReference, butteraugliRows, butteraugliLinearTable} from './butteraugli.mjs';
import {BA_MEMORY} from './butteraugli-memory.mjs';
import {exactPow} from './exact-math.mjs';
import {memoryPlan} from './memory-plan.mjs';
import {fault} from './fault.mjs';
import {bandScratch} from './band-scratch.mjs';
export const RECON_MARGIN = 8;

export function subBase(base, bx0, by0, bx1, by1) {
  const sliced = sliceBlocks(base, bx0, by0, bx1, by1), W = base.components[0].stride * 8, w = (bx1 - bx0) * 8;
  sliced.planes = base.planes.map(p => { const o = new p.constructor(w * (by1 - by0) * 8); for (let y = 0; y < (by1 - by0) * 8; y++) o.set(p.subarray((by0 * 8 + y) * W + bx0 * 8, (by0 * 8 + y) * W + bx0 * 8 + w), y * w); return o; });
  return sliced;
}

export function subImage(image, bx0, by0, bx1, by1) {
  if (image.lazyStrategy) return subImage(image.lazyStrategy.rows(by0, by1), bx0, by0, bx1, by1);
  const sub = sliceBlocks(image, bx0, by0, bx1, by1), sd = image.strategyData;
  if (!sd) return sub;
  const stride = bx1 - bx0, rows = by1 - by0, at = new Int32Array(stride * rows).fill(-1), blocks = [];
  for (const b of sd.blocks) if (b.bx >= bx0 && b.bx < bx1 && b.by >= by0 && b.by < by1) {
    const moved = {...b, bx: b.bx - bx0, by: b.by - by0};
    for (let y = 0; y < b.bh; y++) for (let x = 0; x < b.bw; x++) at[(moved.by + y) * stride + moved.bx + x] = blocks.length;
    blocks.push(moved);
  }
  sub.strategyData = {groups: [blocks], blocks, at, tables: sd.tables, stride};
  return sub;
}

function sliceBlocks(image, bx0, by0, bx1, by1) {
  const comps = image.components, stride = comps[0].stride, sw = bx1 - bx0, sh = by1 - by0, n = sw * sh;
  const rows = (arr, per, row0 = 0) => {
    const o = ArrayBuffer.isView(arr) ? new arr.constructor(n * per) : new Float64Array(n * per);
    for (let y = 0; y < sh; y++) {
      const from = ((by0 - row0 + y) * stride + bx0) * per;
      if (ArrayBuffer.isView(arr)) o.set(arr.subarray(from, from + sw * per), y * sw * per);
      else for (let x = 0; x < sw * per; x++) o[y * sw * per + x] = arr[from + x];
    }
    return o;
  };
  const cfl = image.cfl, tw = Math.ceil(sw / 8), th = Math.ceil(sh / 8), tiles = arr => { const o = new arr.constructor(tw * th); for (let y = 0; y < th; y++) o.set(arr.subarray((by0 / 8 + y) * cfl.width + bx0 / 8, (by0 / 8 + y) * cfl.width + bx0 / 8 + tw), y * tw); return o; };
  const {planes: _planes, values: _values, coefficientRows, ...coded} = image;
  const observed = coefficientRows?.(by0, by1);
  const width = Math.min(image.width, bx1 * 8) - bx0 * 8, height = Math.min(image.height, by1 * 8) - by0 * 8;
  let alpha = null;
  if (image.alpha) {
    alpha = new image.alpha.constructor(width * height * 4);
    for (let y = 0; y < height; y++) alpha.set(image.alpha.subarray(((by0 * 8 + y) * image.width + bx0 * 8) * 4, ((by0 * 8 + y) * image.width + bx0 * 8 + width) * 4), y * width * 4);
  }
  return {...coded, width, height, alpha,
    components: comps.map((c, channel) => ({...c, stride: sw, rows: sh, ...(observed ? {coeffs: rows(observed[channel], 64, by0)}
      : c.coeffs?.length === stride * comps[0].rows * 64 ? {coeffs: rows(c.coeffs, 64)} : {}),
      ...(c.dc ? {dc: rows(c.dc, 1)} : {})})),
    quantFields: image.quantFields ? rows(image.quantFields, 1) : image.quantFields,
    ...(image.sharpness ? {sharpness: rows(image.sharpness, 1)} : {}),
    ...(cfl ? {cfl: {...cfl, width: tw, x: tiles(cfl.x), b: tiles(cfl.b)}} : {})};
}

export function bandedRGBA(image, rows = 512, convert = toRGBAInto, from = 0, to = image.height) {
  const {width, height} = image, stride = image.components[0].stride, blockRows = image.components[0].rows, end = Math.min(height, to);
  const out = new Uint8ClampedArray(width * (end - from) * 4), decoded = convert === toRGBAInto && rebuildable(image);
  for (let y0 = from; y0 < end; y0 += rows) {
    const y1 = Math.min(height, y0 + rows), by0 = Math.max(0, Math.floor((y0 - RECON_MARGIN) / 64) * 8), by1 = Math.min(blockRows, Math.ceil((y1 + RECON_MARGIN) / 64) * 8);
    const sub = subImage(image, 0, by0, stride, by1);
    if (decoded) out.set(rebuildPicture(sub).rgba.subarray((y0 - by0 * 8) * width * 4, (y1 - by0 * 8) * width * 4), (y0 - from) * width * 4);
    else convert(reconstruct(sub), (y0 - by0 * 8) * width, (y1 - y0) * width, out, (y0 - from) * width);
  }
  return out;
}

export function bandedOutputs(image, rows, native, sink = null, from = 0, to = image.height) {
  const {width, height} = image, stride = image.components[0].stride, blockRows = image.components[0].rows;
  const pack = sink ? null : new Uint8ClampedArray(width * height * 4), own = sink ? null : new Uint8ClampedArray(width * height * 4), decoded = rebuildable(image);
  for (let y0 = from; y0 < Math.min(height, to); y0 += rows) {
    const y1 = Math.min(height, y0 + rows), by0 = Math.max(0, Math.floor((y0 - RECON_MARGIN) / 64) * 8), by1 = Math.min(blockRows, Math.ceil((y1 + RECON_MARGIN) / 64) * 8);
    const sub = subImage(image, 0, by0, stride, by1), from = (y0 - by0 * 8) * width, count = (y1 - y0) * width;
    const bandPack = sink ? bandScratch(Uint8ClampedArray, 'band-package', count * 4) : pack, bandOwn = sink ? bandScratch(Uint8ClampedArray, 'band-native', count * 4) : own;
    const at = sink ? 0 : y0 * width;
    if (decoded) {
      const made = rebuildPicture(sub, {rgba: true, linear: true, views: true});
      bandPack.set(made.rgba.subarray(from * 4, (from + count) * 4), at * 4);
      native(made.linear, from, count, bandOwn, at, y0);
    } else {
      const linear = reconstruct(sub);
      toRGBAInto(linear, from, count, bandPack, at);
      native(linear, from, count, bandOwn, at, y0);
    }
    sink?.(y0, y1 - y0, bandPack, bandOwn);
  }
  return sink ? null : {package: pack, native: own};
}

export const BAND_ROWS = 128;

function readers(reference, width, height, image, rows) {
  if (!Number.isSafeInteger(rows) || rows < 1) throw new RangeError('Exact band rows must be a positive integer.');
  const blockRows = image.components[0].rows, stride = image.components[0].stride;
  let lin = null, top = 0, end = 0, sw = 0, skip = 0;
  const distorted = (c, y) => {
    if (y < top || y >= end) {
      const y0 = y - y % rows, by0 = Math.max(0, Math.floor((y0 - RECON_MARGIN) / 64) * 8), by1 = Math.min(blockRows, Math.ceil((Math.min(height, y0 + rows) + RECON_MARGIN) / 64) * 8);
      const sub = subImage(image, 0, by0, stride, by1);
      lin = null; lin = reconstruct(sub); sw = sub.width; top = y0; end = Math.min(height, y0 + rows); skip = by0 * 8;
    }
    return lin[c].subarray((y - skip) * sw, (y - skip) * sw + width);
  };
  const row = new Float32Array(width), table = reference.rgba && butteraugliLinearTable(), refRow = reference.rgba
    ? (c, y) => { for (let x = 0, at = y * width * 4 + c; x < width; x++, at += 4) row[x] = table[reference.rgba[at]]; return row; }
    : (c, y) => reference[c].subarray(y * width, (y + 1) * width);
  return {refRow, distorted};
}
function eachRow(reference, width, height, image, rows, consume) {
  const {refRow, distorted} = readers(reference, width, height, image, rows);
  butteraugliRows(refRow, distorted, width, height, consume);
}

export function bandedMap(reference, width, height, image, rows = BAND_ROWS) {
  const map = new Float64Array(width * height);
  eachRow(reference, width, height, image, rows, (y, row) => map.set(row, y * width));
  return map;
}

function scorer(width, height, p, margin) {
  if (!Number.isSafeInteger(margin) || margin < 0) throw new RangeError('Exact block margin must be a nonnegative integer.');
  const stride = Math.ceil(width / 8), count = Math.ceil(height / 8), cells = new Float64Array(stride * count), blocks = new Float64Array(stride * count);
  const sums = [0, 0, 0]; let max = 0;
  const consume = (y, map) => {
    const by0 = Math.max(0, Math.ceil((y - margin - 7) / 8)), by1 = Math.min(count - 1, Math.floor((y + margin) / 8));
    for (let x = 0; x < width; x++) {
      const v = map[x]; max = Math.max(max, v);
      let d = v * (v * v); sums[0] += d; d *= d; sums[1] += d; d *= d; sums[2] += d;
      cells[(y >> 3) * stride + (x >> 3)] += exactPow(v, p);
      const bx0 = Math.max(0, Math.ceil((x - margin - 7) / 8)), bx1 = Math.min(stride - 1, Math.floor((x + margin) / 8));
      for (let by = by0; by <= by1; by++) for (let bx = bx0; bx <= bx1; bx++) {
        const at = by * stride + bx; blocks[at] = Math.max(blocks[at], v);
      }
    }
  };
  const result = () => ({butteraugli: max,
    butteraugli3: sums.reduce((a, sum, k) => a + exactPow(sum / (width * height), 1 / (3 * (1 << k))), 0) / 3, cells, blocks});
  return {consume, result};
}
export function bandedScores(reference, width, height, image, {p = 3, margin = 2, rows = BAND_ROWS} = {}) {
  const s = scorer(width, height, p, margin);
  eachRow(reference, width, height, image, rows, s.consume);
  return s.result();
}

export function* deviceBandedScores(reference, width, height, image, {p = 3, margin = 2, rows = BAND_ROWS} = {}, look = 0, failed = () => {}, during = null) {
  const {refRow, distorted} = readers(reference, width, height, image, rows), core = BA_MEMORY.rowCore, halo = BA_MEMORY.rowHalo;
  const bands = Math.ceil(height / core), tiles = Math.ceil(width / core), audited = look * 7919 % (bands * tiles);
  const ab = Math.floor(audited / tiles), ax = audited % tiles * core;
  const s = scorer(width, height, p, margin), pending = [];
  let last = null;
  const windowAt = (top, bottom) => {
    const h = bottom - top, n = width * h, ref = new Float32Array(3 * n), dist = new Float32Array(3 * n);
    for (let y = top; y < bottom; y++) for (let c = 0; c < 3; c++) {
      const at = c * n + (y - top) * width;
      if (last && y < last.bottom) {
        const from = c * last.n + (y - last.top) * width;
        ref.set(last.ref.subarray(from, from + width), at); dist.set(last.dist.subarray(from, from + width), at);
      } else { ref.set(refRow(c, y).subarray(0, width), at); dist.set(distorted(c, y).subarray(0, width), at); }
    }
    return last = {top, bottom, n, ref, dist};
  };
  const expect = (w, y) => {
    const left = Math.max(0, ax - halo), right = Math.min(width, ax + core + halo), cw = right - left, h = w.bottom - w.top;
    const cut = planes => [0, 1, 2].map(c => { const o = new Float32Array(cw * h); for (let r = 0; r < h; r++) o.set(planes.subarray(c * w.n + r * width + left, c * w.n + r * width + right), r * cw); return o; });
    return {left, cw, map: butteraugli(butteraugliReference(cut(w.ref), cw, h), cut(w.dist)).map};
  };
  const finish = function* (job) {
    const answer = yield {await: job.answer};
    if (!answer?.map || answer.flagged) return false;
    const {y, end, w, check} = job, map = answer.map;
    if (check) for (let r = y; r < end; r++) for (let x = ax; x < Math.min(width, ax + core); x++)
      if (!Object.is(map[(r - w.top) * width + x], check.map[(r - w.top) * check.cw + x - check.left])) { failed(); return false; }
    for (let r = y; r < end; r++) s.consume(r, map.subarray((r - w.top) * width, (r - w.top + 1) * width));
    return true;
  };
  const depth = Math.max(2, Math.floor(256 * 1024 * 1024 / (24 * width * Math.min(height, core + 2 * halo))));
  let other;
  const run = () => { if (during) { other = during(); during = null; } };
  for (let b = 0; b < bands; b++) {
    const y = b * core, end = Math.min(height, y + core), w = windowAt(Math.max(0, y - halo), Math.min(height, end + halo));
    const answer = Promise.resolve(yield {gpu: {kind: 'ba-map', ref: w.ref, dist: w.dist, width, height: w.bottom - w.top}, later: true});
    pending.push({y, end, w, answer, check: b === ab ? expect(w, y) : null});
    if (pending.length >= depth) { run(); if (!(yield* finish(pending.shift()))) return null; }
  }
  run();
  while (pending.length) if (!(yield* finish(pending.shift()))) return null;
  return {...s.result(), during: other};
}

export function exactScores(cpu, reference, width, height, image, want = {}, memory = cpu.memory ?? null) {
  const plan = memory ?? memoryPlan(width * height, {width, height});
  if (!plan.banded) return cpu(image, want);
  if (typeof cpu.banded !== 'function') throw fault('JXL_INPUT', 'Banded scoring requires the CPU reference transaction.');
  return cpu.banded(image, want, (typeof __RAPIER_JXL_CAPTURE_PHOTO__ !== 'undefined' && __RAPIER_JXL_CAPTURE_PHOTO__ === true) ? null
    : ref => bandedScores(ref, width, height, image, {...want, rows: plan.bandRows}));
}

