// SPDX-License-Identifier: MIT
import {TRANSFORMS, basis, basisT, llfDivisors} from './vardct-bases.mjs';
import {AFV_BASIS} from './afv-basis.mjs';
import {half} from './reconstruct-dct8.mjs';
import {dct8Band, VAR_BASE} from './dct8-band.mjs';

const align8 = p => (p + 7) & ~7;
const SIDES = [1, 2, 4, 8, 16, 32];

let tablesEnd = 0, loadedBand = null;
function ensureTables(band) {
  if (loadedBand === band && tablesEnd) return tablesEnd;
  let p = VAR_BASE + 208;
  const bOff = [], btOff = [], divOff = new Int32Array(36);
  for (const s of SIDES) { bOff.push(p); p += s * s * 8; btOff.push(p); p += s * s * 8; }
  for (let i = 0; i < 6; i++) for (let j = 0; j <= i; j++) {
    divOff[i * 6 + j] = p;
    p += SIDES[i] * SIDES[j] * 8;
  }
  const afvOff = p;
  p += 256 * 8;
  const buf = band.grow(p), i32 = new Int32Array(buf), f64 = new Float64Array(buf);
  SIDES.forEach((s, i) => {
    i32[(VAR_BASE >> 2) + i] = bOff[i];
    i32[((VAR_BASE + 24) >> 2) + i] = btOff[i];
    f64.set(basis(s), bOff[i] >> 3);
    f64.set(basisT(s), btOff[i] >> 3);
  });
  for (let i = 0; i < 6; i++) for (let j = 0; j <= i; j++) {
    const off = divOff[i * 6 + j];
    i32[((VAR_BASE + 48) >> 2) + i * 6 + j] = off;
    f64.set(llfDivisors(SIDES[i], SIDES[j]), off >> 3);
  }
  i32[(VAR_BASE + 192) >> 2] = afvOff;
  f64.set(AFV_BASIS, afvOff >> 3);
  loadedBand = band;
  return tablesEnd = p;
}

export function rcLlfFromDC(means, bw, bh) {
  const w = Math.max(bw, bh), h = Math.min(bw, bh), area = w * h;
  if (!area) return new Float64Array(0);
  const band = dct8Band(), baseAt = ensureTables(band);
  const argsAt = baseAt, meansAt = align8(argsAt + 32), tmpAt = meansAt + area * 8, outAt = tmpAt + area * 8;
  let end = outAt + area * 8, btPtr, byPtr, divPtr;
  const lgW = SIDES.indexOf(bw), lgH = SIDES.indexOf(bh);
  if (lgW >= 0 && lgH >= 0) {
    const dir = new Int32Array(band.buffer());
    btPtr = dir[((VAR_BASE + 24) >> 2) + lgW];
    byPtr = dir[(VAR_BASE >> 2) + lgH];
    divPtr = dir[((VAR_BASE + 48) >> 2) + Math.max(lgW, lgH) * 6 + Math.min(lgW, lgH)];
  } else {
    btPtr = end; end += bw * bw * 8;
    byPtr = end; end += bh * bh * 8;
    divPtr = end; end += area * 8;
  }
  const buf = band.grow(end), i32 = new Int32Array(buf), f64 = new Float64Array(buf);
  f64.set(means.length === area ? means : means.subarray(0, area), meansAt >> 3);
  if (lgW < 0 || lgH < 0) {
    f64.set(basisT(bw), btPtr >> 3);
    f64.set(basis(bh), byPtr >> 3);
    f64.set(llfDivisors(w, h), divPtr >> 3);
  }
  i32.set([meansAt, bw, bh, btPtr, byPtr, divPtr, tmpAt, outAt], argsAt >> 2);
  band.exports.coeffPlanes(0, argsAt);
  return new Float64Array(buf, outAt, area).slice();
}

export function coefficientPlanes(image) {
  const comps = image.components, stride = comps[0].stride, rows = comps[0].rows, W = stride * 8, H = rows * 8;
  const QS = image.quantScale || 256, planes = [0, 1, 2].map(() => new Float32Array(W * H)), cells = new Uint32Array(stride * rows);
  if (!stride || !rows) return {planes, cells, W, H, stride, rows};
  const cfl = image.cfl, base = image.quantFieldBase || 1, fields = image.quantFields;
  const dcStep = comps.map(c => half(c.quant[0] / (255 * 8 * QS) * 128) / 128 * 255 * 8);
  const strategy = image.strategyData, band = dct8Band();
  if ((typeof __RAPIER_JXL_UPLOAD__ !== 'undefined' && __RAPIER_JXL_UPLOAD__ === true) || !strategy) {
    for (let c = 0; c < 3; c++) {
      band.quantViews[c].set(comps[c].quant);
      band.dcView[c] = dcStep[c];
    }
    const argsAt = ensureTables(band), cellsOutAt = argsAt + 32, out0At = cellsOutAt + band.blocks * 4;
    const planeBytes = band.coeff[1] - band.coeff[0], buf = band.grow(out0At + 3 * band.blocks * 256);
    const i32 = new Int32Array(buf), cellsOut = new Uint32Array(buf, cellsOutAt, band.blocks);
    const stripStep = (bx0, by0, bw, bh) => {
      const first = by0 * stride + bx0, count = bw * bh, sw = bw * 8, stripPixels = count * 64;
      for (let c = 0; c < 3; c++) band.coeffViews[c].set(comps[c].coeffs.subarray(first * 64, (first + count) * 64));
      if (fields) band.fieldView.set(fields.subarray(first, first + count));
      const tx = bx0 >> 3, ty = by0 >> 3, tw = ((bx0 + bw + 7) >> 3) - tx;
      if (cfl) {
        const th = ((by0 + bh + 7) >> 3) - ty;
        for (let y = 0; y < th; y++) {
          const start = (ty + y) * cfl.width + tx;
          band.cflXView.set(cfl.x.subarray(start, start + tw), y * tw);
          band.cflBView.set(cfl.b.subarray(start, start + tw), y * tw);
        }
      }
      band.dequant8(band.coeff[0], planeBytes, count, bw, bx0 & 7, by0 & 7, tw,
        band.quant, band.dc, band.one, fields ? band.field : 0, cfl ? band.cflX : 0, band.cflB, QS, base, 0, 0);
      i32.set([band.coeff[0], planeBytes, bx0, by0, bw, bh, out0At, cellsOutAt], argsAt >> 2);
      band.exports.coeffPlanes(1, argsAt);
      cells.set(cellsOut.subarray(0, count), first);
      for (let c = 0; c < 3; c++) {
        const view = new Float32Array(buf, out0At + c * stripPixels * 4, stripPixels), p = planes[c];
        if (bw === stride) p.set(view, by0 * 8 * W);
        else for (let r = 0; r < bh * 8; r++) p.set(view.subarray(r * sw, (r + 1) * sw), (by0 * 8 + r) * W + bx0 * 8);
      }
    };
    for (let by = 0; by < rows;) {
      if (stride <= band.blocks) {
        const bh = Math.min(rows - by, Math.floor(band.blocks / stride));
        stripStep(0, by, stride, bh);
        by += bh;
      } else {
        for (let bx = 0; bx < stride; bx += band.blocks) stripStep(bx, by, Math.min(band.blocks, stride - bx), 1);
        by++;
      }
    }
    return {planes, cells, W, H, stride, rows};
  }
  const blocks = strategy.blocks;
  if (!blocks.length) return {planes, cells, W, H, stride, rows};
  const baseAt = ensureTables(band), nCells = stride * rows;
  let maxSize = 64, maxArea = 1, totalStepsBytes = 0, totalOrdersBytes = 0;
  const familyMap = new Map(), orderMap = new Map();
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i], fam = TRANSFORMS[b.id].table;
    if (b.size > maxSize) maxSize = b.size;
    if (b.area > maxArea) maxArea = b.area;
    if (!familyMap.has(fam)) {
      const sPlanes = strategy.tables[fam].planes, len = sPlanes[0].length;
      familyMap.set(fam, {planes: sPlanes, len, off: totalStepsBytes});
      totalStepsBytes += 3 * len * 8;
    }
    if (!orderMap.has(b.order)) {
      orderMap.set(b.order, {order: b.order, len: b.order.length, off: totalOrdersBytes});
      totalOrdersBytes += b.order.length * 4;
    }
  }
  const argsAt = align8(baseAt), dc0At = argsAt + 144, dcStrideBytes = nCells * 8;
  const fieldsAt = fields ? dc0At + 3 * dcStrideBytes : 0;
  const afterFields = fields ? fieldsAt + nCells * 8 : dc0At + 3 * dcStrideBytes;
  const cflLen = cfl ? cfl.x.length : 0, cflXAt = cfl ? afterFields : 0, cflBAt = cfl ? cflXAt + cflLen * 8 : 0;
  const cellsAt = cfl ? cflBAt + cflLen * 8 : afterFields;
  const stepsBase = align8(cellsAt + nCells * 4), ordersBase = stepsBase + totalStepsBytes;
  const scratchAt = align8(ordersBase + totalOrdersBytes);
  const scratchBytes = maxSize * 20 + maxArea * 24 + 3584, bandStart = scratchAt + scratchBytes;
  let buf = band.grow(bandStart), i32 = new Int32Array(buf), f64 = new Float64Array(buf);
  for (let c = 0; c < 3; c++) f64.set(comps[c].dc.subarray(0, nCells), (dc0At >> 3) + c * nCells);
  if (fields) f64.set(fields.subarray(0, nCells), fieldsAt >> 3);
  if (cfl) { f64.set(cfl.x, cflXAt >> 3); f64.set(cfl.b, cflBAt >> 3); }
  new Uint8Array(buf, cellsAt, nCells * 4).fill(0);
  for (const {planes: sPlanes, len, off} of familyMap.values())
    for (let c = 0; c < 3; c++) f64.set(sPlanes[c], ((stepsBase + off) >> 3) + c * len);
  for (const {order, off} of orderMap.values()) i32.set(order, (ordersBase + off) >> 2);

  const bands = [];
  if (W * H * 12 <= 16777216) {
    bands.push({by0: 0, by1: rows, list: blocks});
  } else {
    const groups = Array.from({length: Math.ceil(rows / 32)}, (_, g) => ({by0: g * 32, by1: Math.min(rows, (g + 1) * 32), list: []}));
    for (let i = 0; i < blocks.length; i++) groups[blocks[i].by >> 5].list.push(blocks[i]);
    for (const g of groups) {
      if (!g.list.length) continue;
      let maxBy1 = g.by1;
      for (let i = 0; i < g.list.length; i++) if (g.list[i].by + g.list[i].bh > maxBy1) maxBy1 = g.list[i].by + g.list[i].bh;
      g.by1 = maxBy1;
      if (bands.length && g.by0 < bands.at(-1).by1) {
        const prev = bands.at(-1);
        prev.by1 = Math.max(prev.by1, g.by1);
        for (let i = 0; i < g.list.length; i++) prev.list.push(g.list[i]);
      } else bands.push(g);
    }
  }

  for (const {by0, by1, list} of bands) {
    let totalCoeffs = 0;
    for (let i = 0; i < list.length; i++) totalCoeffs += 3 * list[i].size;
    const bandPixels = W * (by1 - by0) * 8;
    const recsAt = bandStart, qBaseAt = recsAt + list.length * 32;
    const out0At = qBaseAt + totalCoeffs * 4, out1At = out0At + bandPixels * 4, out2At = out1At + bandPixels * 4;
    buf = band.grow(out2At + bandPixels * 4);
    i32 = new Int32Array(buf); f64 = new Float64Array(buf);
    new Uint8Array(buf, out0At, bandPixels * 12).fill(0);
    let qAt = qBaseAt;
    for (let i = 0; i < list.length; i++) {
      const b = list[i], r = (recsAt >> 2) + i * 8, sz = b.size;
      i32[r] = b.id; i32[r + 1] = b.bx; i32[r + 2] = b.by; i32[r + 3] = b.bw; i32[r + 4] = b.bh;
      i32[r + 5] = ordersBase + orderMap.get(b.order).off;
      i32[r + 6] = stepsBase + familyMap.get(TRANSFORMS[b.id].table).off;
      i32[r + 7] = qAt;
      for (let c = 0; c < 3; c++) i32.set(b.coeffs[c].length === sz ? b.coeffs[c] : b.coeffs[c].subarray(0, sz), (qAt >> 2) + c * sz);
      qAt += 3 * sz * 4;
    }
    const a32 = argsAt >> 2, a64 = argsAt >> 3;
    i32[a32] = list.length; i32[a32 + 1] = recsAt; i32[a32 + 2] = stride; i32[a32 + 3] = W;
    i32[a32 + 4] = by0 * 8; i32[a32 + 5] = cfl ? cfl.width : 0; i32[a32 + 6] = dc0At; i32[a32 + 7] = dcStrideBytes;
    i32[a32 + 8] = fieldsAt; i32[a32 + 9] = cflXAt; i32[a32 + 10] = cflBAt; i32[a32 + 11] = band.one;
    i32[a32 + 12] = out0At; i32[a32 + 13] = out1At; i32[a32 + 14] = out2At; i32[a32 + 15] = cellsAt;
    i32[a32 + 16] = VAR_BASE; i32[a32 + 17] = scratchAt; i32[a32 + 18] = maxSize; i32[a32 + 19] = maxArea;
    f64[a64 + 12] = QS; f64[a64 + 13] = base;
    f64[a64 + 14] = dcStep[0]; f64[a64 + 15] = dcStep[1]; f64[a64 + 16] = dcStep[2];
    band.exports.coeffPlanes(2, argsAt);
    for (let c = 0; c < 3; c++) planes[c].set(new Float32Array(buf, out0At + c * bandPixels * 4, bandPixels), by0 * 8 * W);
  }
  cells.set(new Uint32Array(band.buffer(), cellsAt, nCells));
  return {planes, cells, W, H, stride, rows};
}

export function epfInverseSigma(image) {
  const stride = image.components[0].stride, rows = image.components[0].rows, n = stride * rows;
  if (!n) return new Float32Array(0);
  const field = image.quantFieldBase || 1;
  let shift = 1;
  while (field * shift / (8 * 255 * (image.quantScale || 1)) < 1 / 16384) shift *= 2;
  const mul = half(image.epf), band = dct8Band(), baseAt = ensureTables(band);
  const blocks = image.strategyData?.blocks ?? null, sharp = image.sharpness, qFields = image.quantFields;
  const argsAt = align8(baseAt), blocksAt = blocks ? argsAt + 64 : 0;
  const firstOfAt = blocks ? blocksAt + blocks.length * 16 : 0;
  let p = align8(blocks ? firstOfAt + n * 4 : argsAt + 64);
  const fieldsAt = qFields ? p : 0; if (qFields) p += n * 8;
  const sharpAt = sharp ? p : 0; if (sharp) p += n * 8;
  const invAt = p; p += n * 4;
  const buf = band.grow(p), i32 = new Int32Array(buf), f64 = new Float64Array(buf);
  if (blocks) for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i], o = (blocksAt >> 2) + i * 4;
    i32[o] = b.bx; i32[o + 1] = b.by; i32[o + 2] = b.bw; i32[o + 3] = b.bh;
  }
  if (qFields) f64.set(qFields.subarray(0, n), fieldsAt >> 3);
  if (sharp) f64.set(sharp.subarray(0, n), sharpAt >> 3);
  const a32 = argsAt >> 2, a64 = argsAt >> 3;
  i32[a32] = n; i32[a32 + 1] = stride; i32[a32 + 2] = blocks ? blocks.length : 0; i32[a32 + 3] = blocksAt;
  i32[a32 + 4] = firstOfAt; i32[a32 + 5] = fieldsAt; i32[a32 + 6] = sharpAt; i32[a32 + 7] = invAt;
  f64[a64 + 4] = field; f64[a64 + 5] = shift; f64[a64 + 6] = mul;
  band.exports.coeffPlanes(3, argsAt);
  return new Float32Array(buf, invAt, n).slice();
}
