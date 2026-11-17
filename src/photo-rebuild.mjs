// SPDX-License-Identifier: MIT
import {rebuildKernels} from './rebuild-kernels.mjs';
import {bandScratch} from './band-scratch.mjs';
import {renderVarBlock, renderBlock8, blockTables, prepareLF, epfSigma, xybKernelConstants} from './vardct-render.mjs';
import {restorePlanes, restorationStages, restorationSizes, RESTORE_ROWS} from './vardct-inverse.mjs';
import {TRANSFORMS} from './vardct-bases.mjs';
import {varDCTLayout} from './vardct-header.mjs';
import {varDCTDCSpec, copyVarDCTDCRows, copyVarDCTCorrelation} from './vardct-planes.mjs';
import {prepareQuantParams, photoDCT8Table} from './quantization-params.mjs';
import {DEFAULT_OPSIN} from './opsin-defaults.mjs';
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

export function rebuildPicture(source, {rgba: wantRGBA = true, linear: wantLinear = false, gamma: wantGamma = false, rendered = false, inputs = false, only = null, views = false, upsample = null} = {}) {
  const image = materialize(source.lazyStrategy || source.coefficientRows ? coded(source) : source);
  const factor = upsample && rebuildableUpsampled(image) && !inputs && !rendered && !only ? image.upsampling : 1;
  if (factor === 1 && !rebuildable(image)) throw Object.assign(new Error('photo-rebuild:unsupported'), {code: 'JXL_INTERNAL'});
  const kernels = rebuildKernels(), layout = varDCTLayout(image), {width, height} = image, ycbcr = !!image.ycbcr;
  const global = ycbcr ? YCBCR_GLOBAL : GLOBAL, map = layout.map;
  const {comps, dcScale, quantScale: QS, field, shift, xsizeBlocks: BW, ysizeBlocks: BH, dcGroupsX, numDcGroups, epf} = layout;
  const strategy = image.strategyData, fields = image.quantFields, n = width * height, cells = BW * BH;
  const filter = frameFilter(image, epf), stages = restorationStages(filter);
  const full = ((typeof __RAPIER_JXL_UPLOAD__ === 'undefined' || __RAPIER_JXL_UPLOAD__ !== true) ? strategy : null);
  const blocks = full ? new Array(full.blocks.length) : new Array(cells);
  if (full) {
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
  const onlyList = only ? [...only] : null;
  let areaSum = 0;
  if (onlyList) for (let i = 0; i < onlyList.length; i++) areaSum += (blocks[onlyList[i]]?.area ?? 0) * 64;
  else if (full) for (let i = 0; i < blocks.length; i++) areaSum += blocks[i].area * 64;
  else areaSum = cells * 64;
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
    ...(needPlanes ? [n * 4, n * 4, n * 4] : [0, 0, 0]), coefficientCount * (narrowArena ? 2 : 4), needPlanes && !rendered ? n * 4 : 0];
  const inPlace = needPlanes && !rendered && !narrowArena && stages.length > 0 && coefficientCount >= 3 * n;
  const frameBytes = sizes.reduce((sum, size) => sum + Math.ceil(size / 16) * 16, 0);
  const at = kernels.reserve(inPlace ? [...sizes, ...restorationSizes(width, height, filter, RESTORE_ROWS)] : sizes);
  const lfAt = at.slice(0, 9), weightsAt = at.slice(9, 26), [tablesAt, cflAt, xAt, yAt, bAt, arenaAt, rgbaAt] = at.slice(26);
  const buffer = kernels.buffer;
  const lfDequant = [0, 1, 2].map(c => half(comps[c].quant[0] / dcScale[c] / (255 * 8 * QS) * 128));
  for (let c = 0; c < 3; c++) {
    const dc = copyVarDCTDCRows(varDCTDCSpec(image, layout, c, 0, 0, BW, BH), new Int32Array(cells));
    const step = f(lfDequant[c] * (1 << 9) / (global.globalScale * global.quantLF)), lf = new Float32Array(buffer, lfAt[c], cells);
    for (let i = 0; i < cells; i++) lf[i] = dc[i] * step;
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
  let used = 0;
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
  let sigma = null;
  if (filter.epf.iters && !rendered) {
    sigma = new Float32Array(cells);
    const sharp = image.sharpness;
    if (!fields && !sharp && blocks.length > 0 && !onlyList) {
      sigma.fill(epfSigma(filter.epf, global.globalScale, field, 7));
    } else {
      for (const block of blocks) for (let y = 0; y < block.bh; y++) for (let x = 0; x < block.bw; x++) {
        const cell = (block.y + y) * BW + block.x + x;
        sigma[cell] = epfSigma(filter.epf, global.globalScale, block.multiplier, sharp ? sharp[cell] : 7);
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
  const targets = [xAt, yAt, bAt].map(o => new Float32Array(buffer, o, n));
  if ((typeof __RAPIER_JXL_UPLOAD__ === 'undefined' || __RAPIER_JXL_UPLOAD__ !== true) && onlyList) for (const k of onlyList) { if (blocks[k]) renderVarBlock(ctx, blocks[k], targets, zero); }
  else for (const block of blocks) if (!renderBlock8(ctx, block, targets, zero)) {
    if ((typeof __RAPIER_JXL_UPLOAD__ === 'undefined' || __RAPIER_JXL_UPLOAD__ !== true)) renderVarBlock(ctx, block, targets, zero);
    else throw fault('JXL_INTERNAL', 'photo-rebuild:dct8');
  }
  if (rendered) { for (const block of blocks) block.source = null; return {rendered: only ? targets : targets.map(p => p.slice())}; }
  let planes = targets;
  if (inPlace) {
    planes = restorePlanes(kernels, targets, width, height, filter, sigma, [0, 1, 2].map(c => new Float32Array(buffer, arenaAt + c * n * 4, n)), at[0] + frameBytes);
    planes.rgbaAt = rgbaAt;
  } else if (stages.length) {
    const restored = restorePlanes(kernels, targets.map((p, c) => { const copy = bandScratch(Float32Array, 'rebuild-in' + c, n); copy.set(p); return copy; }),
      width, height, filter, sigma, [0, 1, 2].map(c => bandScratch(Float32Array, 'rebuild-out' + c, n)));
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
    for (const block of blocks) block.source = null;
    return result;
  }
  const constants = DEFAULT_XYB ??= xybKernelConstants(DEFAULT_OPSIN.inverseMatrix.map(f), DEFAULT_OPSIN.opsinBiases, 255);
  if (wantLinear) kernels.xyb(count, planes[0], planes[1], planes[2], constants);
  if (wantRGBA) {
    const rgba8 = new Uint8Array(kernels.buffer, planes.rgbaAt, count * 4);
    if (wantLinear) kernels.srgb8(count, planes[0], planes[1], planes[2], rgba8);
    else kernels.xyb(count, planes[0], planes[1], planes[2], constants, rgba8);
    result.rgba = views ? rgba8 : rgba8.slice();
    alphaInto(result.rgba);
  }
  if (wantLinear) result.linear = views ? planes.slice(0, 3) : planes.map(p => p.slice());
  for (const block of blocks) block.source = null;
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