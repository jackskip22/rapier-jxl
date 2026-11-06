// SPDX-License-Identifier: MIT
import {TRANSFORMS, basis, basisT, llfDivisors} from './vardct-bases.mjs';
import {scaledBasis, inverseBlock} from './vardct-inverse.mjs';
import {exactCbrt} from './exact-math.mjs';

const WIRE_ORDER = [1, 0, 2];
const fail = message => { throw Object.assign(new Error(message), {code: 'JXL_DECODE'}); };

export const blockTables = (tables, cfl) => ({tables, cfl, next: tables + 2048, bases: new Map(), maps: new Map()});

function blockTable(ctx, key, values) {
  const K = ctx.blocks;
  let at = K.bases.get(key);
  if (at === undefined) {
    const v = values(); at = K.next; K.next += v.byteLength;
    if (K.next > K.tables + 65536) fail('JPEG XL block tables exceed their region.');
    K.bases.set(key, at); new v.constructor(ctx.kernels.buffer, at, v.length).set(v);
  }
  return at;
}
function cflMaps(ctx, lfGroup) {
  const K = ctx.blocks, group = ctx.group(lfGroup);
  if (!K.maps.has(lfGroup)) { const at = K.cfl + lfGroup * 8192, i32 = ctx.kernels.i32; i32.set(group.xFromY, at / 4); i32.set(group.bFromY, at / 4 + 1024); K.maps.set(lfGroup, at); }
  return K.maps.get(lfGroup);
}

export function renderVarBlock(ctx, block, targets, tops) {
  const {kernels, lf, widths, heights, bias, numerator, qmScale, global, dcWidth, ox, hshift, vshift, cflBlock} = ctx, group = ctx.group(block.lfGroup);
  const {id, area, multiplier, bw, bh} = block, shape = TRANSFORMS[id], size = area * 64, quant = ctx.quant(shape.table);
  const transpose = !(id === 1 || id === 2 || id === 3 || id >= 12 && id <= 17) && shape.height >= shape.width;
  const held = block.coefficients, K = ctx.weights, arena = block.arena.byteOffset, table = shape.table;
  const wide = Math.max(shape.width, shape.height), coefficients = ctx.blockPlanes, i32 = kernels.i32, tiles = ctx.blocks.tables;
  coefficients[0] = coefficients[1] = coefficients[2] = null;
  if (cflBlock) {
    const columns = size / wide;
    for (let u = 0; u < wide; u++) { const px = block.x * 8 + (transpose ? 0 : u), py = block.y * 8 + (transpose ? u : 0); i32[tiles / 4 + u] = transpose ? Math.floor(py / 64) - (group.by >> 3) : Math.floor(px / 64) - (group.bx >> 3); }
    for (let v = 0; v < columns; v++) { const px = block.x * 8 + (transpose ? v : 0), py = block.y * 8 + (transpose ? 0 : v); i32[tiles / 4 + 256 + v] = transpose ? Math.floor(px / 64) - (group.bx >> 3) : Math.floor(py / 64) - (group.by >> 3); }
  }
  for (let wire = 0; wire < 3; wire++) {
    const c = WIRE_ORDER[wire], h = held[c]; if (h == null) continue;
    const values = kernels.coefficients[c], factor = 65536 / (global.globalScale * multiplier) * qmScale[c];
    if (!K.loaded[table]) { for (let k = 0; k < 3; k++) new Float32Array(kernels.buffer, K.offsets[table] + k * size * 4, size).set(quant[k]); K.loaded[table] = true; }
    kernels.dequant(arena + h * 4, size, K.offsets[table] + c * size * 4, factor, bias[c], numerator, values.byteOffset);
    if (c !== 1 && cflBlock) {
      const maps = cflMaps(ctx, block.lfGroup), base = c === 0 ? global.correlation.baseX : global.correlation.baseB, map = c === 0 ? maps : maps + 4096, luma = coefficients[1];
      if (size === 64) {
        const ci = transpose ? i32[tiles / 4] * group.width + i32[tiles / 4 + 256] : i32[tiles / 4 + 256] * group.width + i32[tiles / 4];
        kernels.cfl64(values.byteOffset, luma.byteOffset, base + i32[map / 4 + ci] / global.correlation.factor);
      } else kernels.cfl(values.byteOffset, luma.byteOffset, size, wide, tiles, tiles + 1024, transpose ? 1 : 0, group.width, map, base, global.correlation.factor);
    }
    const bx = (block.x - ox) >> hshift[c], by = block.y >> vshift[c], plane = lf[c], stride = dcWidth[c];
    if (area === 1) values[0] = 0 + plane[by * stride + bx];
    else {
      const w = Math.max(bw, bh), h2 = Math.min(bw, bh);
      i32.set([values.byteOffset, plane.byteOffset, stride, bx, by, bw, bh, blockTable(ctx, 'T' + bw, () => basisT(bw)), blockTable(ctx, 'B' + bh, () => basis(bh)),
        blockTable(ctx, 'D' + w + 'x' + h2, () => llfDivisors(w, h2)), wide, tiles + 65536], kernels.args / 4);
      kernels.llf(kernels.args);
    }
    coefficients[c] = values;
  }
  block.coefficients = block.arena = null;
  for (let c = 0; c < 3; c++) if (coefficients[c]) {
    const values = coefficients[c], x0 = ((block.x - ox) >> hshift[c]) * 8, y0 = (block.y >> vshift[c]) * 8;
    inverseBlock(kernels, values.byteOffset, shape);
    const w = widths[c], xs = Math.min(shape.width, w - x0), ys = Math.min(shape.height, heights[c] - y0);
    if (xs > 0 && ys > 0) kernels.store(shape.width, targets[c], (y0 - tops[c]) * w + x0, w, xs, ys);
  }
}

export function renderBlock8(ctx, block, targets, tops) {
  const {kernels, lf, widths, heights, bias, numerator, qmScale, global, dcWidth, ox, cflBlock} = ctx, held = block.coefficients;
  if (block.id !== 0 || !cflBlock || !held.every(h => typeof h === 'number')) return false;
  const group = ctx.group(block.lfGroup), {multiplier} = block, table = 0, quant = ctx.quant(table), K = ctx.weights, arena = block.arena.byteOffset;
  const {offsets, loaded} = K, scale = 65536 / (global.globalScale * multiplier);
  if (!loaded[table]) { for (let k = 0; k < 3; k++) new Float32Array(kernels.buffer, offsets[table] + k * 256, 64).set(quant[k]); loaded[table] = true; }
  const tile = (Math.floor(block.y * 8 / 64) - (group.by >> 3)) * group.width + Math.floor(block.x * 8 / 64) - (group.bx >> 3), at = block.y * dcWidth[0] + block.x - ox;
  const x0 = (block.x - ox) * 8, y0 = block.y * 8, w = widths[0], xs = Math.min(8, w - x0), ys = Math.min(8, heights[0] - y0);
  kernels.block8(arena + held[0] * 4, arena + held[1] * 4, arena + held[2] * 4, offsets[table], scale * qmScale[0], scale * qmScale[1], scale * qmScale[2],
    bias[0], bias[1], bias[2], numerator, global.correlation.baseX + group.xFromY[tile] / global.correlation.factor,
    global.correlation.baseB + group.bFromY[tile] / global.correlation.factor, lf[0][at], lf[1][at], lf[2][at],
    targets[0].byteOffset + ((y0 - tops[0]) * w + x0) * 4, targets[1].byteOffset + ((y0 - tops[1]) * w + x0) * 4, targets[2].byteOffset + ((y0 - tops[2]) * w + x0) * 4,
    w * 4, xs, ys, kernels.basis(8, () => scaledBasis(8)));
  block.coefficients = block.arena = null;
  return true;
}

export function prepareLF(kernels, at, lengths, {dcWidth, dcHeight, hshift, vshift, cflBlock, correlation, steps, smooth}) {
  const planes = from => [0, 1, 2].map(c => new Float32Array(kernels.buffer, at[from + c], lengths[c]));
  kernels.i32.set([...at, ...dcWidth, ...dcHeight, ...hshift, ...vshift], kernels.args / 4);
  kernels.lfPrepare(kernels.args, cflBlock ? 1 : 0, correlation.baseX + (correlation.lfX - 128) / correlation.factor,
    correlation.baseB + (correlation.lfB - 128) / correlation.factor, smooth ? 1 : 0, ...steps);
  return smooth ? planes(6) : planes(0);
}

export const epfSigma = (epf, globalScale, multiplier, sharp) =>
  (epf.quantMul ?? .46) * 65536 / globalScale / multiplier * (epf.sharpLut || [0, 1 / 7, 2 / 7, 3 / 7, 4 / 7, 5 / 7, 6 / 7, 1])[sharp];

export function xybKernelConstants(raw, opsinBiases, intensityTarget) {
  const f = Math.fround, bias = opsinBiases.map(f), root = bias.map(v => f(exactCbrt(v))), scale = f(255 / intensityTarget);
  return {bias, root, m: raw.map(v => f(v * scale))};
}
