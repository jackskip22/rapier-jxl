// SPDX-License-Identifier: MIT
import {rebuildKernels} from './rebuild-kernels.mjs';
import {bandScratch} from './band-scratch.mjs';
import {renderVarBlock, renderBlock8, blockTables, prepareLF, epfSigma, xybKernelConstants} from './vardct-render.mjs';
import {restorePlanes, restorationStages, restorationSizes, RESTORE_ROWS, SLICE_ROWS, scaledBasis} from './vardct-inverse.mjs';
import {TRANSFORMS} from './vardct-bases.mjs';
import {varDCTLayout} from './vardct-header.mjs';
import {varDCTDCSpec, copyVarDCTDCRows, copyVarDCTCorrelation} from './vardct-planes.mjs';
import {prepareQuantParams, photoDCT8Table} from './quantization-params.mjs';
import {DEFAULT_OPSIN} from './opsin-defaults.mjs';
import {OPSIN, inverse, times, SRGB_CURVE} from './color-transform.mjs';
import {wideLevels} from './color-bytes.mjs';
import {half} from './reconstruct-dct8.mjs';
import {materialize} from './varblock-core.mjs';
import {nativeRGBA, nativeGammaRGBA} from './photo-output.mjs';
import {fault} from './fault.mjs';


const f = Math.fround, GLOBAL = Object.freeze({globalScale: 65536, quantLF: 1,
  correlation: Object.freeze({factor: 84, baseX: 0, baseB: 1, lfX: 128, lfB: 128})});
const YCBCR_GLOBAL = Object.freeze({...GLOBAL, correlation: Object.freeze({...GLOBAL.correlation, baseB: 0})});
const KB = 0.114 * 1.772 / 0.587, KR = 0.299 * 1.402 / 0.587, LEVEL = 128 / 255;
function ycbcrToRGB([cb, y, cr], n) {
  for (let i = 0; i < n; i++) {
    const b = cb[i], l = y[i] + LEVEL, c = cr[i];
    cb[i] = l + 1.402 * c; y[i] = l - KB * b - KR * c; cr[i] = l + 1.772 * b;
  }
}
const uniform = image => image.components.every(c => (c.h ?? 1) === 1 && (c.v ?? 1) === 1);
const GAB = [0.115169525, 0.061248592], SHARP = Array.from({length: 8}, (_, i) => i / 7);
const TABLE_BYTES = /* @__PURE__ */ TRANSFORMS.reduce((sizes, t) => (sizes[t.table] = t.width * t.height * 12, sizes), new Array(17).fill(0)), BIAS3 = /* @__PURE__ */ DEFAULT_OPSIN.quantizationBiases.slice(0, 3);
let DEFAULT_XYB = null;
const LIBRARY = new Map();
const libraryMatrix = table => {
  let m = LIBRARY.get(table);
  if (!m) {
    const t = TRANSFORMS.find(item => item.table === table), w = Math.max(t.width, t.height), h = Math.min(t.width, t.height);
    LIBRARY.set(table, m = prepareQuantParams({mode: 'library'}, w, h, table).weights.map(p => Float32Array.from(p, v => 1 / v)));
  }
  return m;
};

export const rebuildable = image => (!!image?.xyb && !image.ycbcr || !image?.xyb && !!image?.ycbcr && uniform(image)) && !image.useDCFrame && image.cflBase === undefined &&
  !image.quantTable && !image.noiseLut && !image.splineBits && !image.placement && !image.frameHeader && !image.progression?.downsample?.length &&
  (image.upsampling ?? 1) === 1 && !image.auxiliary && (!!image.coefficientRows || !!image.lazyStrategy || !!image.strategyData ||
    image.components.every(c => c.coeffs?.length >= c.stride * c.rows * 64));
export const rebuildableUpsampled = image => [2, 4, 8].includes(image?.upsampling) && image.canvasWidth > 0 && image.canvasHeight > 0 &&
  Math.ceil(image.canvasWidth / image.upsampling) === image.width && Math.ceil(image.canvasHeight / image.upsampling) === image.height &&
  rebuildable({...image, upsampling: 1});

function frameFilter(image, epf) {
  const gab = image.gab;
  return {gaborish: gab ? (gab === true ? [GAB, GAB, GAB] : gab.map(([e, c]) => [half(e), half(c)])) : null,
    epf: epf ? {iters: image.epfIterations ?? 1, sharpLut: SHARP, channelScale: [40, 5, 3.5], quantMul: half(epf),
      pass0SigmaScale: half(0.9), pass2SigmaScale: half(6.5), borderSadMul: half(2 / 3), sigmaForModular: 1} : {iters: 0}};
}

const TRANSFORM_SPECS = new WeakMap();
const isSrgbTable = t => t === SRGB_CURVE || t?.length === 256 && t.every((v, i) => v === SRGB_CURVE[i]);
function prepareTransformSpec(transform) {
  if (!transform?.lms || transform.tables?.length !== 3) return null;
  let spec = TRANSFORM_SPECS.get(transform);
  if (spec !== undefined) return spec;
  const mat = inverse(times(inverse(OPSIN), transform.lms));
  const srgb = transform.tables.every(isSrgbTable) ? 1 : 0;
  const bytes = new Uint8Array(srgb ? 80016 : 30848), f64 = new Float64Array(bytes.buffer, 0, 780);
  f64.set(mat, 0);
  let mode = srgb;
  if (srgb) {
    const lv = wideLevels();
    f64.set(lv, 9); f64[9 + 256] = Infinity;
    const first = bytes.subarray(6272, 6272 + 8192);
    let k = 0;
    for (let b = 0; b < 8192; b++) {
      while (k < 256 && b / 8192 >= f64[9 + k + 1]) k++;
      first[b] = k;
    }
    const u16 = new Uint16Array(bytes.buffer, 14464, 32769);
    u16[0] = 0; u16[32768] = 255;
    let kk = 0;
    for (let b = 1; b < 32768; b++) {
      const lo = b / 32768, hi = (b + 1) / 32768;
      while (kk < 255 && f64[9 + kk + 1] <= lo) kk++;
      u16[b] = lo - f64[9 + kk] > 2e-11 && f64[9 + kk + 1] - hi > 2e-11 ? kk : 256;
    }
  } else {
    let oneStep = true;
    for (let c = 0; c < 3; c++) {
      const tbl = transform.tables[c], mBase = 9 + c * 258;
      if (tbl?.length !== 256) { TRANSFORM_SPECS.set(transform, null); return null; }
      for (let k = 0; k < 255; k++) {
        const m = (tbl[k] + tbl[k + 1]) * 0.5;
        if (!(m >= 0 && m < 1) || (k > 0 && m < f64[mBase + k - 1])) { TRANSFORM_SPECS.set(transform, null); return null; }
        f64[mBase + k] = m;
      }
      f64[mBase + 255] = Infinity;
      const first = bytes.subarray(6272 + c * 8192, 6272 + (c + 1) * 8192);
      let k = 0;
      for (let b = 0; b < 8192; b++) {
        while (k < 255 && f64[mBase + k] < b / 8192) k++;
        first[b] = k;
      }
      for (let b = 0; b < 8192; b++) if ((b < 8191 ? first[b + 1] : 255) - first[b] > 1) oneStep = false;
    }
    if (oneStep) mode = 2;
  }
  spec = {bytes, mode};
  TRANSFORM_SPECS.set(transform, spec);
  return spec;
}

function cellCoefficients(arena, used, c0, c1, c2, st, BW, by0, by1) {
  for (let by = by0; by < by1; by++) for (let bx = 0; bx < BW; bx++) {
    const from = (by * st + bx) * 64;
    for (let k = 1; k < 64; k++) {
      const tr = 8 * (k & 7) + (k >> 3);
      arena[used + tr] = c0[from + k];
      arena[used + 64 + tr] = c1[from + k];
      arena[used + 128 + tr] = c2[from + k];
    }
    used += 192;
  }
  return used;
}

function renderCells8(by0, by1, tTop, BW, width, height, dcGroupsX, groups, baseX, baseB, corrFactor, arenaByte, w0, uniformScale, fields, shift, gScale, b0, b1, b2, num, lf0, lf1, lf2, lf0Off, lf1Off, lf2Off, t0, t1, t2, rowBytes, basis8, block8, blocks8) {
  for (let by = by0, u = 0; by < by1; by++) {
    const y0 = by * 8, ys = Math.min(8, height - y0), rowCell = by * BW, gRow = (by >> 8) * dcGroupsX, ty = by >> 3;
    const dstRow = (y0 - tTop) * rowBytes;
    for (let bx = 0; bx < BW;) {
      const group = groups[gRow + (bx >> 8)], atCell = rowCell + bx;
      const tile = (ty - (group.by >> 3)) * group.width + (bx >> 3) - (group.bx >> 3);
      const corrx = baseX + group.xFromY[tile] / corrFactor, corrb = baseB + group.bFromY[tile] / corrFactor;
      const x0 = bx * 8, dstOff = dstRow + x0 * 4, a0 = arenaByte + u * 4;
      if (blocks8 && ys === 8 && x0 + 8 <= width) {
        const run = Math.min(((bx >> 3) + 1) * 8, width >> 3) - bx;
        if (run > 1) {
          blocks8(run, a0, w0, uniformScale, b0, b1, b2, num, corrx, corrb,
            lf0Off + atCell * 4, lf1Off + atCell * 4, lf2Off + atCell * 4,
            t0 + dstOff, t1 + dstOff, t2 + dstOff, rowBytes, basis8);
          bx += run; u += run * 192;
          continue;
        }
      }
      const scale = fields ? 65536 / (gScale * (fields[atCell] * shift)) : uniformScale;
      block8(a0, a0 + 256, a0 + 512, w0, scale, scale, scale, b0, b1, b2, num,
        corrx, corrb,
        lf0[atCell], lf1[atCell], lf2[atCell], t0 + dstOff, t1 + dstOff, t2 + dstOff, rowBytes,
        Math.min(8, width - x0), ys, basis8);
      bx++; u += 192;
    }
  }
}

function lfScaled(lf, src, scale, lift, step, cells) { for (let i = 0; i < cells; i++) lf[i] = (src[i] * scale + lift) * step; }
function lfStepped(lf, dc, step, cells) { for (let i = 0; i < cells; i++) lf[i] = dc[i] * step; }

const CELL_LOOPS = /* @__PURE__ */ Object.freeze([cellCoefficients, renderCells8, lfScaled, lfStepped]);

export function rebuildPicture(source, {rgba: wantRGBA = true, linear: wantLinear = false, gamma: wantGamma = false, xyb: wantXYB = false, rendered = false, inputs = false, only = null, views = false, upsample = null, transform = null, sliceFrom = 0, sliceCount = -1, transformOut = null} = {}) {
  const image = materialize(source.lazyStrategy || source.coefficientRows ? coded(source) : source);
  const factor = upsample && rebuildableUpsampled(image) && !inputs && !rendered && !only ? image.upsampling : 1;
  if (factor === 1 && !rebuildable(image)) throw Object.assign(new Error('photo-rebuild:unsupported'), {code: 'JXL_INTERNAL'});
  const kernels = rebuildKernels(), layout = varDCTLayout(image), {width, height} = image, ycbcr = !!image.ycbcr;
  const global = ycbcr ? YCBCR_GLOBAL : GLOBAL, map = layout.map;
  const {comps, dcScale, quantScale: QS, field, shift, xsizeBlocks: BW, ysizeBlocks: BH, dcGroupsX, numDcGroups, epf} = layout;
  const strategy = image.strategyData, fields = image.quantFields, n = width * height, cells = BW * BH;
  const filter = frameFilter(image, epf), stages = restorationStages(filter);
  const full = ((typeof __RAPIER_JXL_UPLOAD__ === 'undefined' || __RAPIER_JXL_UPLOAD__ !== true) ? strategy : null);
  const cMeta = full?.compact?.meta ?? null;
  const onlyList = only ? [...only] : null, needBlocks = inputs || !!onlyList;
  const blocks = needBlocks ? (cMeta ? new Array(cMeta.length / 6) : full ? new Array(full.blocks.length) : new Array(cells)) : null;
  if (needBlocks) {
    if (cMeta) {
      const lv = full.compact.levels;
      for (let i = 0, p = 0; p < cMeta.length; i++, p += 6) {
        const id = cMeta[p], bx = cMeta[p + 1], by = cMeta[p + 2], bw = cMeta[p + 3], bh = cMeta[p + 4], off = cMeta[p + 5], sz = bw * bh * 64;
        blocks[i] = {id, x: bx, y: by, bw, bh, area: bw * bh,
          multiplier: fields ? fields[by * BW + bx] * shift : field,
          lfGroup: (by >> 8) * dcGroupsX + (bx >> 8),
          source: {coeffs: [lv.subarray(off, off + sz), lv.subarray(off + sz, off + 2 * sz), lv.subarray(off + 2 * sz, off + 3 * sz)]},
          coefficients: null, arena: null};
      }
    } else if (full) {
      const src = full.blocks;
      for (let i = 0; i < src.length; i++) {
        const b = src[i];
        blocks[i] = {id: b.id, x: b.bx, y: b.by, bw: b.bw, bh: b.bh, area: b.bw * b.bh,
          multiplier: fields ? fields[b.by * BW + b.bx] * shift : field,
          lfGroup: (b.by >> 8) * dcGroupsX + (b.bx >> 8), source: b, coefficients: null, arena: null};
      }
    } else {
      let idx = 0;
      for (let by = 0; by < BH; by++) {
        const rowOff = by * BW, gRow = (by >> 8) * dcGroupsX;
        for (let bx = 0; bx < BW; bx++)
          blocks[idx++] = {id: 0, x: bx, y: by, bw: 1, bh: 1, area: 1, multiplier: fields ? fields[rowOff + bx] * shift : field,
            lfGroup: gRow + (bx >> 8), source: null, coefficients: null, arena: null};
      }
    }
  }
  const canSlice = factor === 1 && !ycbcr && !rendered && !inputs && !onlyList && !image.alpha &&
    sliceCount > 0 && sliceFrom >= 0 && sliceFrom + sliceCount <= n &&
    sliceFrom % width === 0 && sliceCount % width === 0;
  const ySlice0 = canSlice ? sliceFrom / width : 0, ySlice1 = canSlice ? (sliceFrom + sliceCount) / width : height;
  const rad = stages.reduce((s, st) => s + st.radius, 0) + 1;
  const ry0 = canSlice ? Math.max(0, ySlice0 - rad) : 0, ry1 = canSlice ? Math.min(height, ySlice1 + rad) : height;
  const cellSlice = canSlice && !needBlocks && !cMeta && !full && (ySlice1 - ySlice0 <= SLICE_ROWS || !stages.length);
  const by0 = cellSlice ? ry0 >> 3 : 0, by1 = cellSlice ? Math.min(BH, (ry1 + 7) >> 3) : BH;
  const tTop = by0 * 8, tRows = cellSlice ? Math.min(height, by1 * 8) - tTop : height, tCount = tRows * width, outCount = cellSlice ? sliceCount : n;
  let areaSum = 0;
  if (onlyList) for (let i = 0; i < onlyList.length; i++) areaSum += (blocks[onlyList[i]]?.area ?? 0) * 64;
  else if (cMeta) areaSum = full.compact.levels.length / 3;
  else if (full) { const src = full.blocks; for (let i = 0; i < src.length; i++) areaSum += src[i].bw * src[i].bh * 64; }
  else areaSum = (by1 - by0) * BW * 64;
  const coefficientCount = 3 * areaSum;
  const narrowArena = inputs && !image.wideCoefficients;
  const denominator = half(field / (8 * 255 * QS)), matrices = new Map();
  const quant = table => {
    let m = matrices.get(table), compact;
    if (!m) {
      const own = ((typeof __RAPIER_JXL_UPLOAD__ === 'undefined' || __RAPIER_JXL_UPLOAD__ !== true) ? strategy : null) ? ((typeof __RAPIER_JXL_UPLOAD__ === 'undefined' || __RAPIER_JXL_UPLOAD__ !== true) ? strategy : null).tables[table] : null;
      if (own?.parameters) m = own.parameters.weights.map(p => Float32Array.from(p, v => 1 / v));
      else if (!(typeof __RAPIER_JXL_JPEG__ !== 'undefined' && __RAPIER_JXL_JPEG__ === true) && own && table === 0 && own.w === 8 && own.h === 8 && (compact = photoDCT8Table(image, map.map(c => own.planes[c]), field, QS)))
        m = compact.weights.map(p => Float32Array.from(p, v => 1 / v));
      else if (own) m = [0, 1, 2].map(c => Float32Array.from(own.planes[map[c]], v => f(v * denominator)));
      else if (!(typeof __RAPIER_JXL_JPEG__ !== 'undefined' && __RAPIER_JXL_JPEG__ === true) && !((typeof __RAPIER_JXL_UPLOAD__ === 'undefined' || __RAPIER_JXL_UPLOAD__ !== true) ? strategy : null) && table === 0 && (compact = photoDCT8Table(image, comps.map(c => c.quant), field, QS, comps)))
        m = compact.library ? libraryMatrix(0) : compact.weights.map(p => Float32Array.from(p, v => 1 / v));
      else if (!((typeof __RAPIER_JXL_UPLOAD__ === 'undefined' || __RAPIER_JXL_UPLOAD__ !== true) ? strategy : null) && table === 0) m = [0, 1, 2].map(c => {
        const q = comps[c].quant, out = new Float32Array(64);
        for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) out[8 * x + y] = f(q[8 * y + x] * denominator);
        return out;
      });
      else m = libraryMatrix(table);
      matrices.set(table, m);
    }
    return m;
  };
  const tableBytes = TABLE_BYTES;
  const needPlanes = !inputs;
  const sizes = [...Array(9).fill(cells * 4), ...tableBytes, 65536 + 3 * 1024 * 8, numDcGroups * 8192,
    ...(needPlanes ? [tCount * 4, tCount * 4, tCount * 4] : [0, 0, 0]), coefficientCount * (narrowArena ? 2 : 4), needPlanes && !rendered ? outCount * 4 : 0];
  const inPlace = !cellSlice && needPlanes && !rendered && !narrowArena && stages.length > 0 && coefficientCount >= 3 * n;
  const frameBytes = sizes.reduce((sum, size) => sum + Math.ceil(size / 16) * 16, 0);
  const restoreSpan = cellSlice ? Math.max(1, ySlice1 - ySlice0) : RESTORE_ROWS;
  const at = kernels.reserve(inPlace || cellSlice && stages.length > 0 ? [...sizes, ...restorationSizes(width, height, filter, restoreSpan)] : sizes);
  const lfAt = at.slice(0, 9), weightsAt = at.slice(9, 26), [tablesAt, cflAt, xAt, yAt, bAt, arenaAt, rgbaAt] = at.slice(26);
  const buffer = kernels.buffer;
  const lfDequant = [0, 1, 2].map(c => half(comps[c].quant[0] / dcScale[c] / (255 * 8 * QS) * 128));
  for (let c = 0; c < 3; c++) {
    const spec = varDCTDCSpec(image, layout, c, 0, 0, BW, BH);
    const step = f(lfDequant[c] * (1 << 9) / (global.globalScale * global.quantLF)), lf = new Float32Array(buffer, lfAt[c], cells);
    if (spec.source && spec.stride === BW && spec.step === 1) {
      CELL_LOOPS[2](lf, spec.source, spec.scale, spec.lift, step, cells);
    } else CELL_LOOPS[3](lf, copyVarDCTDCRows(spec, bandScratch(Int32Array, 'rebuild-dc', cells)), step, cells);
  }
  const dims = [BW, BW, BW], zero = [0, 0, 0];
  const lf = prepareLF(kernels, lfAt, [cells, cells, cells], {dcWidth: dims, dcHeight: [BH, BH, BH], hshift: zero, vshift: zero,
    cflBlock: true, correlation: global.correlation, steps: lfDequant.map(m => 512 * m / (global.globalScale * global.quantLF)), smooth: !!image.adaptiveLFSmoothing && !image.useDCFrame && BW > 2 && BH > 2});
  const groups = [];
  for (let g = 0; g < numDcGroups; g++) {
    const bx = g % dcGroupsX * 256, by = Math.floor(g / dcGroupsX) * 256;
    const cw = Math.ceil(Math.min(2048, width - bx * 8) / 64), ch = Math.ceil(Math.min(2048, height - by * 8) / 64);
    const colors = [new Int32Array(cw * ch), new Int32Array(cw * ch)];
    if (image.cfl) copyVarDCTCorrelation(image.cfl, bx, by, cw, ch, colors);
    groups.push({xFromY: colors[0], bFromY: colors[1], width: cw, bx, by});
  }
  const arena = narrowArena ? new Int16Array(buffer, arenaAt, coefficientCount) : new Int32Array(buffer, arenaAt, coefficientCount);
  let used = 0, fullOffsets = null;
  if (needBlocks) {
    for (let idx = 0, len = onlyList ? onlyList.length : blocks.length; idx < len; idx++) {
      const index = onlyList ? onlyList[idx] : idx, block = blocks[index];
      if (!block) continue;
      const size = block.area * 64, held = [0, 0, 0];
      for (let c = 0; c < 3; c++) {
        held[c] = used;
        if (block.source) {
          const q = block.source.coeffs[map[c]];
          arena.set(q.length === size ? q : q.subarray(0, size), used);
        } else {
          const q = comps[c].coeffs, from = (block.y * comps[c].stride + block.x) * 64;
          for (let k = 1; k < 64; k++) arena[used + 8 * (k & 7) + (k >> 3)] = q[from + k];
        }
        used += size;
      }
      block.coefficients = held; block.arena = arena;
    }
  } else if (cMeta) {
    const lv = full.compact.levels, m0 = map[0], m1 = map[1], m2 = map[2];
    if (m0 === 0 && m1 === 1 && m2 === 2) {
      arena.set(lv, 0);
      used = lv.length;
    } else {
      for (let p = 0; p < cMeta.length; p += 6) {
        const size = cMeta[p + 3] * cMeta[p + 4] * 64, off = cMeta[p + 5];
        arena.set(lv.subarray(off + m0 * size, off + (m0 + 1) * size), used);
        arena.set(lv.subarray(off + m1 * size, off + (m1 + 1) * size), used + size);
        arena.set(lv.subarray(off + m2 * size, off + (m2 + 1) * size), used + 2 * size);
        used += 3 * size;
      }
    }
  } else if (full) {
    const src = full.blocks, m0 = map[0], m1 = map[1], m2 = map[2], direct = m0 === 0 && m1 === 1 && m2 === 2;
    fullOffsets = new Int32Array(src.length);
    for (let i = 0; i < src.length; i++) {
      const b = src[i], size = b.bw * b.bh * 64;
      fullOffsets[i] = used;
      if (direct && b.levels?.length === 3 * size) {
        const buf = b.levels.buffer;
        let runEnd = b.levels.byteOffset + b.levels.byteLength, count = 3 * size;
        while (i + 1 < src.length) {
          const nb = src[i + 1], nSize = nb.bw * nb.bh * 64;
          if (!nb.levels || nb.levels.buffer !== buf || nb.levels.byteOffset !== runEnd || nb.levels.length !== 3 * nSize) break;
          i++; fullOffsets[i] = used + count; runEnd += nb.levels.byteLength; count += 3 * nSize;
        }
        arena.set(new Int32Array(buf, b.levels.byteOffset, count), used);
        used += count;
      } else {
        const c = b.coeffs, q0 = c[m0], q1 = c[m1], q2 = c[m2];
        arena.set(q0.length === size ? q0 : q0.subarray(0, size), used);
        arena.set(q1.length === size ? q1 : q1.subarray(0, size), used + size);
        arena.set(q2.length === size ? q2 : q2.subarray(0, size), used + 2 * size);
        used += 3 * size;
      }
    }
  } else {
    used = CELL_LOOPS[0](arena, used, comps[0].coeffs, comps[1].coeffs, comps[2].coeffs, comps[0].stride, BW, by0, by1);
  }
  let sigma = null;
  if (filter.epf.iters && !rendered) {
    const sharp = image.sharpness, hasBlocks = cMeta ? cMeta.length > 0 : full ? full.blocks.length > 0 : cells > 0;
    if (!fields && !sharp && hasBlocks && !onlyList && !inputs) {
      filter.epf.sigmaForModular = f(epfSigma(filter.epf, global.globalScale, field, 7));
    } else {
      sigma = new Float32Array(cells);
      if (!fields && !sharp && hasBlocks && !onlyList) {
        sigma.fill(epfSigma(filter.epf, global.globalScale, field, 7));
      } else if (needBlocks) {
        for (const block of blocks) for (let y = 0; y < block.bh; y++) for (let x = 0; x < block.bw; x++) {
          const cell = (block.y + y) * BW + block.x + x;
          sigma[cell] = epfSigma(filter.epf, global.globalScale, block.multiplier, sharp ? sharp[cell] : 7);
        }
      } else if (cMeta) {
        for (let p = 0; p < cMeta.length; p += 6) {
          const bx = cMeta[p + 1], by = cMeta[p + 2], bw = cMeta[p + 3], bh = cMeta[p + 4];
          const mul = fields ? fields[by * BW + bx] * shift : field;
          for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) {
            const cell = (by + y) * BW + bx + x;
            sigma[cell] = epfSigma(filter.epf, global.globalScale, mul, sharp ? sharp[cell] : 7);
          }
        }
      } else if (full) {
        for (const b of full.blocks) {
          const mul = fields ? fields[b.by * BW + b.bx] * shift : field;
          for (let y = 0; y < b.bh; y++) for (let x = 0; x < b.bw; x++) {
            const cell = (b.by + y) * BW + b.bx + x;
            sigma[cell] = epfSigma(filter.epf, global.globalScale, mul, sharp ? sharp[cell] : 7);
          }
        }
      } else {
        for (let by = 0; by < BH; by++) for (let bx = 0; bx < BW; bx++) {
          const cell = by * BW + bx, mul = fields ? fields[cell] * shift : field;
          sigma[cell] = epfSigma(filter.epf, global.globalScale, mul, sharp ? sharp[cell] : 7);
        }
      }
    }
  }
  const ctx = {kernels, lf, widths: [width, width, width], heights: [height, height, height], bias: BIAS3,
    numerator: DEFAULT_OPSIN.quantizationBiases[3], qmScale: [1, 1, 1], global, dcWidth: dims, ox: 0, hshift: zero, vshift: zero,
    cflBlock: true, weights: {offsets: weightsAt, loaded: []}, blocks: blockTables(tablesAt, cflAt), blockPlanes: [null, null, null],
    quant, group: g => groups[g]};
  if (inputs) {
    const tables = new Map();
    for (const block of blocks) { const t = TRANSFORMS[block.id].table; if (!tables.has(t)) tables.set(t, quant(t)); }
    for (const block of blocks) { block.source = null; block.arena = null; }
    const out = {width, height, xsize: BW, ysize: BH, ycbcr, arena: arena.subarray(0, used), tables,
      lf, groups, global, bias: ctx.bias, numerator: ctx.numerator, filter, sigma,
      blocks};
    for (const block of blocks) { block.source = null; block.arena = null; }
    return {inputs: out};
  }
  const targets = [xAt, yAt, bAt].map(o => new Float32Array(buffer, o, tCount));
  if ((typeof __RAPIER_JXL_UPLOAD__ === 'undefined' || __RAPIER_JXL_UPLOAD__ !== true) && onlyList) for (const k of onlyList) { if (blocks[k]) renderVarBlock(ctx, blocks[k], targets, zero); }
  else if (needBlocks) for (const block of blocks) {
    if (!renderBlock8(ctx, block, targets, zero)) {
      if ((typeof __RAPIER_JXL_UPLOAD__ === 'undefined' || __RAPIER_JXL_UPLOAD__ !== true)) renderVarBlock(ctx, block, targets, zero);
      else throw fault('JXL_INTERNAL', 'photo-rebuild:dct8');
    }
  } else {
    const q0 = quant(0), w0 = weightsAt[0];
    for (let k = 0; k < 3; k++) new Float32Array(kernels.buffer, w0 + k * 256, 64).set(q0[k]);
    ctx.weights.loaded[0] = true;
    const basis8 = kernels.basis(8, () => scaledBasis(8)), arenaByte = arena.byteOffset;
    const lf0 = lf[0], lf1 = lf[1], lf2 = lf[2], lf0Off = lf0.byteOffset, lf1Off = lf1.byteOffset, lf2Off = lf2.byteOffset;
    const t0 = targets[0].byteOffset, t1 = targets[1].byteOffset, t2 = targets[2].byteOffset;
    const b0 = BIAS3[0], b1 = BIAS3[1], b2 = BIAS3[2], num = ctx.numerator, rowBytes = width * 4;
    const corr = global.correlation, baseX = corr.baseX, baseB = corr.baseB, corrFactor = corr.factor;
    const gScale = global.globalScale, uniformScale = !fields ? 65536 / (gScale * field) : 0;
    const block8 = kernels.block8, blocks8 = !fields ? kernels.blocks8 : null;
    if (cMeta) {
      let varBlock = null;
      for (let p = 0; p < cMeta.length; p += 6) {
        const id = cMeta[p], bx = cMeta[p + 1], by = cMeta[p + 2], bw = cMeta[p + 3], bh = cMeta[p + 4], u = cMeta[p + 5];
        if ((by + bh) * 8 <= ry0 || by * 8 >= ry1) continue;
        const lfGroup = (by >> 8) * dcGroupsX + (bx >> 8);
        if (id === 0) {
          const group = groups[lfGroup], scale = fields ? 65536 / (gScale * (fields[by * BW + bx] * shift)) : uniformScale;
          const tile = ((by >> 3) - (group.by >> 3)) * group.width + (bx >> 3) - (group.bx >> 3), atCell = by * BW + bx;
          const x0 = bx * 8, y0 = by * 8, dstOff = (y0 * width + x0) * 4, a0 = arenaByte + u * 4;
          const corrx = baseX + group.xFromY[tile] / corrFactor, corrb = baseB + group.bFromY[tile] / corrFactor;
          if (blocks8 && y0 + 8 <= height && x0 + 8 <= width) {
            const tileEnd = Math.min(((bx >> 3) + 1) * 8, width >> 3);
            let run = 1;
            while (bx + run < tileEnd && p + run * 6 < cMeta.length) {
              const np = p + run * 6;
              if (cMeta[np] !== 0 || cMeta[np + 2] !== by || cMeta[np + 1] !== bx + run || cMeta[np + 5] !== u + run * 192) break;
              run++;
            }
            if (run > 1) {
              blocks8(run, a0, w0, scale, b0, b1, b2, num, corrx, corrb,
                lf0Off + atCell * 4, lf1Off + atCell * 4, lf2Off + atCell * 4,
                t0 + dstOff, t1 + dstOff, t2 + dstOff, rowBytes, basis8);
              p += (run - 1) * 6;
              continue;
            }
          }
          block8(a0, a0 + 256, a0 + 512, w0, scale, scale, scale, b0, b1, b2, num,
            corrx, corrb,
            lf0[atCell], lf1[atCell], lf2[atCell], t0 + dstOff, t1 + dstOff, t2 + dstOff, rowBytes,
            Math.min(8, width - x0), Math.min(8, height - y0), basis8);
        } else if ((typeof __RAPIER_JXL_UPLOAD__ === 'undefined' || __RAPIER_JXL_UPLOAD__ !== true)) {
          const size = bw * bh * 64;
          varBlock ??= {id: 0, x: 0, y: 0, bw: 1, bh: 1, area: 1, multiplier: 0, lfGroup: 0, coefficients: null, arena: null};
          varBlock.id = id; varBlock.x = bx; varBlock.y = by; varBlock.bw = bw; varBlock.bh = bh; varBlock.area = bw * bh;
          varBlock.multiplier = fields ? fields[by * BW + bx] * shift : field; varBlock.lfGroup = lfGroup;
          varBlock.coefficients = [u, u + size, u + 2 * size]; varBlock.arena = arena;
          renderVarBlock(ctx, varBlock, targets, zero);
        } else throw fault('JXL_INTERNAL', 'photo-rebuild:dct8');
      }
    } else if (full) {
      const src = full.blocks;
      let varBlock = null;
      for (let i = 0; i < src.length; i++) {
        const b = src[i], bx = b.bx, by = b.by;
        if ((by + b.bh) * 8 <= ry0 || by * 8 >= ry1) continue;
        const lfGroup = (by >> 8) * dcGroupsX + (bx >> 8), u = fullOffsets[i];
        if (b.id === 0) {
          const group = groups[lfGroup], scale = fields ? 65536 / (gScale * (fields[by * BW + bx] * shift)) : uniformScale;
          const tile = ((by >> 3) - (group.by >> 3)) * group.width + (bx >> 3) - (group.bx >> 3), atCell = by * BW + bx;
          const x0 = bx * 8, y0 = by * 8, dstOff = (y0 * width + x0) * 4, a0 = arenaByte + u * 4;
          const corrx = baseX + group.xFromY[tile] / corrFactor, corrb = baseB + group.bFromY[tile] / corrFactor;
          if (blocks8 && y0 + 8 <= height && x0 + 8 <= width) {
            const tileEnd = Math.min(((bx >> 3) + 1) * 8, width >> 3);
            let run = 1;
            while (bx + run < tileEnd && i + run < src.length) {
              const nb = src[i + run];
              if (nb.id !== 0 || nb.by !== by || nb.bx !== bx + run || fullOffsets[i + run] !== u + run * 192) break;
              run++;
            }
            if (run > 1) {
              blocks8(run, a0, w0, scale, b0, b1, b2, num, corrx, corrb,
                lf0Off + atCell * 4, lf1Off + atCell * 4, lf2Off + atCell * 4,
                t0 + dstOff, t1 + dstOff, t2 + dstOff, rowBytes, basis8);
              i += run - 1;
              continue;
            }
          }
          block8(a0, a0 + 256, a0 + 512, w0, scale, scale, scale, b0, b1, b2, num,
            corrx, corrb,
            lf0[atCell], lf1[atCell], lf2[atCell], t0 + dstOff, t1 + dstOff, t2 + dstOff, rowBytes,
            Math.min(8, width - x0), Math.min(8, height - y0), basis8);
        } else if ((typeof __RAPIER_JXL_UPLOAD__ === 'undefined' || __RAPIER_JXL_UPLOAD__ !== true)) {
          const size = b.bw * b.bh * 64;
          varBlock ??= {id: 0, x: 0, y: 0, bw: 1, bh: 1, area: 1, multiplier: 0, lfGroup: 0, coefficients: null, arena: null};
          varBlock.id = b.id; varBlock.x = bx; varBlock.y = by; varBlock.bw = b.bw; varBlock.bh = b.bh; varBlock.area = b.bw * b.bh;
          varBlock.multiplier = fields ? fields[by * BW + bx] * shift : field; varBlock.lfGroup = lfGroup;
          varBlock.coefficients = [u, u + size, u + 2 * size]; varBlock.arena = arena;
          renderVarBlock(ctx, varBlock, targets, zero);
        } else throw fault('JXL_INTERNAL', 'photo-rebuild:dct8');
      }
    } else {
      CELL_LOOPS[1](by0, by1, tTop, BW, width, height, dcGroupsX, groups, baseX, baseB, corrFactor, arenaByte, w0, uniformScale, fields, shift, gScale, b0, b1, b2, num, lf0, lf1, lf2, lf0Off, lf1Off, lf2Off, t0, t1, t2, rowBytes, basis8, block8, blocks8);
    }
  }
  if (rendered) { if (blocks) for (const block of blocks) block.source = null; return {rendered: only ? targets : targets.map(p => p.slice())}; }
  let planes = targets;
  if (cellSlice && stages.length) {
    planes = restorePlanes(kernels, targets, width, height, filter, sigma, 'final', at[0] + frameBytes, ySlice0, ySlice1, tTop, ySlice0);
    planes.rgbaAt = rgbaAt;
  } else if (inPlace) {
    planes = restorePlanes(kernels, targets, width, height, filter, sigma, [0, 1, 2].map(c => new Float32Array(buffer, arenaAt + c * n * 4, n)), at[0] + frameBytes, ySlice0, ySlice1);
    planes.rgbaAt = rgbaAt;
  } else if (stages.length) {
    const restored = restorePlanes(kernels, targets.map((p, c) => { const copy = bandScratch(Float32Array, 'rebuild-in' + c, n); copy.set(p); return copy; }),
      width, height, filter, sigma, [0, 1, 2].map(c => bandScratch(Float32Array, 'rebuild-out' + c, n)), undefined, ySlice0, ySlice1);
    const [x, y, b, out] = kernels.reserve([n * 4, n * 4, n * 4, n * 4]);
    planes = [x, y, b].map((o, c) => { const p = new Float32Array(kernels.buffer, o, n); p.set(restored[c]); return p; });
    planes.rgbaAt = out;
  } else planes.rgbaAt = rgbaAt;
  let count = n, alpha = image.alpha ? (i => image.alpha[i]) : null;
  if (factor !== 1) {
    const W = image.canvasWidth, H = image.canvasHeight, custom = image.upsamplingWeights ?? {};
    const coded = planes.slice(0, 3).map(p => p.slice(0, n));
    let shownAlpha = null;
    if (image.alpha) {
      const plane = new Float32Array(n);
      for (let i = 0; i < n; i++) plane[i] = image.alpha[i * 4 + 3];
      shownAlpha = upsample(kernels, plane, width, height, factor, W, H, custom);
    }
    const up = coded.map(p => upsample(kernels, p, width, height, factor, W, H, custom));
    count = W * H;
    const [x, y, b, out] = kernels.reserve([count * 4, count * 4, count * 4, count * 4]);
    planes = [x, y, b].map((o, c) => { const p = new Float32Array(kernels.buffer, o, count); p.set(up[c]); return p; });
    planes.rgbaAt = out;
    if (shownAlpha) alpha = i => Math.max(0, Math.min(255, Math.round(shownAlpha[(i - 3) >> 2])));
  }
  const result = {};
  const alphaInto = rgba => {
    if (alpha) for (let i = 3; i < count * 4; i += 4) rgba[i] = alpha(i);
    else for (let i = 3; i < count * 4; i += 4) rgba[i] = 255;
  };
  if (ycbcr) {
    ycbcrToRGB(planes, count);
    if (wantGamma) result.gamma = planes.map(p => p.slice());
    if (wantRGBA) {
      kernels.i32.set([count, 0, planes[0].byteOffset, planes[1].byteOffset, planes[2].byteOffset, 0, planes.rgbaAt, 0, 0, 0], kernels.args / 4);
      kernels.rgba(kernels.args);
      result.rgba = new Uint8Array(kernels.buffer, planes.rgbaAt, count * 4).slice();
      alphaInto(result.rgba);
    }
    if (blocks) for (const block of blocks) block.source = null;
    return result;
  }
  if (wantXYB) result.xyb = views ? planes.slice(0, 3) : planes.slice(0, 3).map(p => p.slice());
  if (!wantLinear && !wantRGBA && !(transform && transformOut)) {
    if (blocks) for (const block of blocks) block.source = null;
    return result;
  }
  const constants = DEFAULT_XYB ??= xybKernelConstants(DEFAULT_OPSIN.inverseMatrix.map(f), DEFAULT_OPSIN.opsinBiases, 255);
  const planeSkip = cellSlice ? (stages.length ? 0 : (ySlice0 - tTop) * width) : canSlice ? sliceFrom : 0;
  const trSpec = transform && transformOut && !wantRGBA && !alpha && factor === 1 && kernels.xybTransform ? prepareTransformSpec(transform) : null;
  if (trSpec) {
    const sc = sliceCount >= 0 ? sliceCount : count - sliceFrom, trLen = trSpec.bytes.length, trSkip = cellSlice ? planeSkip : sliceFrom;
    const p0Off = planes[0].byteOffset, p1Off = planes[1].byteOffset, p2Off = planes[2].byteOffset;
    const [constAt, trAt, outAt] = kernels.reserve([64, trLen, sc * 4], Math.max(p0Off, p1Off, p2Off) + planes[0].byteLength);
    constants.packed ??= new Float32Array([...constants.root, ...constants.bias, ...constants.m]);
    new Float32Array(kernels.buffer, constAt, 15).set(constants.packed);
    new Uint8Array(kernels.buffer, trAt, trLen).set(trSpec.bytes);
    kernels.xybTransform(sc, p0Off + trSkip * 4, p1Off + trSkip * 4, p2Off + trSkip * 4,
      constAt, trAt, trSpec.mode, outAt);
    transformOut.set(new Uint8Array(kernels.buffer, outAt, sc * 4));
    result.transformed = true;
    if (blocks) for (const block of blocks) block.source = null;
    return result;
  }
  const sf = canSlice ? sliceFrom : 0, sc = canSlice ? sliceCount : count;
  const sPlanes = canSlice ? planes.map(p => p.subarray(planeSkip, planeSkip + sc)) : planes;
  if (cellSlice) result.sliced = true;
  if (wantLinear) kernels.xyb(sc, sPlanes[0], sPlanes[1], sPlanes[2], constants);
  if (wantRGBA) {
    const rgba8 = new Uint8Array(kernels.buffer, planes.rgbaAt, outCount * 4);
    const rgbaSlice = cellSlice ? rgba8 : canSlice ? rgba8.subarray(sf * 4, (sf + sc) * 4) : rgba8;
    if (wantLinear) kernels.srgb8(sc, sPlanes[0], sPlanes[1], sPlanes[2], rgbaSlice);
    else kernels.xyb(sc, sPlanes[0], sPlanes[1], sPlanes[2], constants, rgbaSlice);
    const outRgba = cellSlice ? rgbaSlice : rgba8;
    result.rgba = views ? outRgba : outRgba.slice();
    if (alpha) alphaInto(result.rgba);
  }
  if (wantLinear) {
    const outLin = cellSlice ? sPlanes : planes.slice(0, 3);
    result.linear = views ? outLin : outLin.map(p => p.slice());
  }
  if (blocks) for (const block of blocks) block.source = null;
  return result;
}

function coded(image) {
  if (image.lazyStrategy) return image.lazyStrategy.materialize();
  const stride = image.components[0].stride, rows = image.components[0].rows, observed = image.coefficientRows(0, rows);
  const {coefficientRows: _rows, ...rest} = image;
  return {...rest, components: image.components.map((c, channel) => ({...c, coeffs: observed[channel]}))};
}

export function rebuildShown(image, {upsample = null} = {}) {
  const up = upsample && image.upsampling > 1 && rebuildableUpsampled(image);
  const ycbcr = !!image.ycbcr, width = up ? image.canvasWidth : image.width, height = up ? image.canvasHeight : image.height;
  const made = rebuildPicture(image, {rgba: true, linear: !ycbcr, gamma: ycbcr, upsample});
  return {rgba: made.rgba, native(origin = {x: 0, y: 0}) {
    const out = ycbcr ? nativeGammaRGBA(made.gamma, width, height, origin) : nativeRGBA(made.linear, width, height, origin);
    for (let at = 3; at < out.length; at += 4) out[at] = made.rgba[at];
    return out;
  }};
}
export function xybToShown(xyb, width, height, wantRGBA = true) {
  const kernels = rebuildKernels(), count = width * height;
  const constants = DEFAULT_XYB ??= xybKernelConstants(DEFAULT_OPSIN.inverseMatrix.map(f), DEFAULT_OPSIN.opsinBiases, 255);
  const [x, y, b, out] = kernels.reserve([count * 4, count * 4, count * 4, wantRGBA ? count * 4 : 0]);
  const planes = [x, y, b].map((o, c) => { const plane = new Float32Array(kernels.buffer, o, count); plane.set(xyb[c]); return plane; });
  kernels.xyb(count, planes[0], planes[1], planes[2], constants);
  let rgba = null;
  if (wantRGBA) {
    const rgba8 = new Uint8Array(kernels.buffer, out, count * 4);
    kernels.srgb8(count, planes[0], planes[1], planes[2], rgba8);
    rgba = rgba8.slice();
  }
  return {linear: planes.map(plane => plane.slice()), rgba};
}
