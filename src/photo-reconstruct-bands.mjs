// SPDX-License-Identifier: MIT
import {reconstruct, toRGBAInto} from './reconstruct.mjs';
import {rebuildPicture, rebuildable} from './photo-rebuild.mjs';
import {butteraugliRows, butteraugliLinearTable} from './butteraugli.mjs';
import {exactPow} from './exact-math.mjs';
import {memoryPlan} from './memory-plan.mjs';
import {fault} from './fault.mjs';
const RECON_MARGIN = 8;

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

export function bandedRGBA(image, rows = 512, convert = toRGBAInto) {
  const {width, height} = image, stride = image.components[0].stride, blockRows = image.components[0].rows, out = new Uint8ClampedArray(width * height * 4);
  const decoded = convert === toRGBAInto && rebuildable(image);
  for (let y0 = 0; y0 < height; y0 += rows) {
    const y1 = Math.min(height, y0 + rows), by0 = Math.max(0, Math.floor((y0 - RECON_MARGIN) / 64) * 8), by1 = Math.min(blockRows, Math.ceil((y1 + RECON_MARGIN) / 64) * 8);
    const sub = subImage(image, 0, by0, stride, by1);
    if (decoded) out.set(rebuildPicture(sub).rgba.subarray((y0 - by0 * 8) * width * 4, (y1 - by0 * 8) * width * 4), y0 * width * 4);
    else convert(reconstruct(sub), (y0 - by0 * 8) * width, (y1 - y0) * width, out, y0 * width);
  }
  return out;
}

export function bandedOutputs(image, rows, native) {
  const {width, height} = image, stride = image.components[0].stride, blockRows = image.components[0].rows;
  const pack = new Uint8ClampedArray(width * height * 4), own = new Uint8ClampedArray(width * height * 4), decoded = rebuildable(image);
  for (let y0 = 0; y0 < height; y0 += rows) {
    const y1 = Math.min(height, y0 + rows), by0 = Math.max(0, Math.floor((y0 - RECON_MARGIN) / 64) * 8), by1 = Math.min(blockRows, Math.ceil((y1 + RECON_MARGIN) / 64) * 8);
    const sub = subImage(image, 0, by0, stride, by1), from = (y0 - by0 * 8) * width, count = (y1 - y0) * width;
    if (decoded) {
      const made = rebuildPicture(sub, {rgba: true, linear: true});
      pack.set(made.rgba.subarray(from * 4, (from + count) * 4), y0 * width * 4);
      native(made.linear, from, count, own, y0 * width);
    } else {
      const linear = reconstruct(sub);
      toRGBAInto(linear, from, count, pack, y0 * width);
      native(linear, from, count, own, y0 * width);
    }
  }
  return {package: pack, native: own};
}

export const BAND_ROWS = 128;

function eachRow(reference, width, height, image, rows, consume) {
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
  butteraugliRows(refRow, distorted, width, height, consume);
}

export function bandedMap(reference, width, height, image, rows = BAND_ROWS) {
  const map = new Float64Array(width * height);
  eachRow(reference, width, height, image, rows, (y, row) => map.set(row, y * width));
  return map;
}

export function bandedScores(reference, width, height, image, {p = 3, margin = 2, rows = BAND_ROWS} = {}) {
  if (!Number.isSafeInteger(margin) || margin < 0) throw new RangeError('Exact block margin must be a nonnegative integer.');
  const stride = Math.ceil(width / 8), count = Math.ceil(height / 8), cells = new Float64Array(stride * count), blocks = new Float64Array(stride * count);
  const sums = [0, 0, 0]; let max = 0;
  eachRow(reference, width, height, image, rows, (y, map) => {
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
  });
  const butteraugli3 = sums.reduce((a, sum, k) => a + exactPow(sum / (width * height), 1 / (3 * (1 << k))), 0) / 3;
  return {butteraugli: max, butteraugli3, cells, blocks};
}

export function exactScores(cpu, reference, width, height, image, want = {}, memory = cpu.memory ?? null) {
  const plan = memory ?? memoryPlan(width * height, {width, height});
  if (!plan.banded) return cpu(image, want);
  if (typeof cpu.banded !== 'function') throw fault('JXL_INPUT', 'Banded scoring requires the CPU reference transaction.');
  return cpu.banded(image, want, (typeof __RAPIER_JXL_CAPTURE_PHOTO__ !== 'undefined' && __RAPIER_JXL_CAPTURE_PHOTO__ === true) ? null
    : ref => bandedScores(ref, width, height, image, {...want, rows: plan.bandRows}));
}

