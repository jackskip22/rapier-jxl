// SPDX-License-Identifier: MIT
import {rebuildKernels} from './rebuild-kernels.mjs';
import {renderVarBlock, blockTables, prepareLF, epfSigma, xybKernelConstants} from './vardct-render.mjs';
import {restorePlanes, restorationStages} from './vardct-inverse.mjs';
import {TRANSFORMS} from './vardct-bases.mjs';
import {varDCTLayout} from './vardct-header.mjs';
import {varDCTDCSpec, copyVarDCTDCRows, copyVarDCTCorrelation} from './vardct-planes.mjs';
import {prepareQuantParams} from './quantization-params.mjs';
import {DEFAULT_OPSIN} from './opsin.mjs';
import {half} from './reconstruct-dct8.mjs';
import {materialize} from './varblock-core.mjs';

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

function frameFilter(image, epf) {
  const gab = image.gab;
  return {gaborish: gab ? (gab === true ? [GAB, GAB, GAB] : gab.map(([e, c]) => [half(e), half(c)])) : null,
    epf: epf ? {iters: image.epfIterations ?? 1, sharpLut: SHARP, channelScale: [40, 5, 3.5], quantMul: half(epf),
      pass0SigmaScale: half(0.9), pass2SigmaScale: half(6.5), borderSadMul: half(2 / 3), sigmaForModular: 1} : {iters: 0}};
}

export function rebuildPicture(source, {rgba: wantRGBA = true, linear: wantLinear = false, gamma: wantGamma = false} = {}) {
  const image = materialize(source.lazyStrategy || source.coefficientRows ? coded(source) : source);
  if (!rebuildable(image)) throw Object.assign(new Error('This coefficient image has no decoder rebuild.'), {code: 'JXL_INTERNAL'});
  const kernels = rebuildKernels(), layout = varDCTLayout(image), {width, height} = image, ycbcr = !!image.ycbcr;
  const global = ycbcr ? YCBCR_GLOBAL : GLOBAL, map = layout.map;
  const {comps, dcScale, quantScale: QS, field, shift, xsizeBlocks: BW, ysizeBlocks: BH, dcGroupsX, numDcGroups, epf} = layout;
  const strategy = image.strategyData, fields = image.quantFields, n = width * height, cells = BW * BH;
  const filter = frameFilter(image, epf), stages = restorationStages(filter);
  const blocks = [];
  const multiplierAt = (bx, by) => fields ? fields[by * BW + bx] * shift : field;
  if (strategy) for (const b of strategy.blocks) blocks.push({id: b.id, x: b.bx, y: b.by, bw: b.bw, bh: b.bh, area: b.bw * b.bh,
    multiplier: multiplierAt(b.bx, b.by), lfGroup: (b.by >> 8) * dcGroupsX + (b.bx >> 8), source: b});
  else for (let by = 0; by < BH; by++) for (let bx = 0; bx < BW; bx++)
    blocks.push({id: 0, x: bx, y: by, bw: 1, bh: 1, area: 1, multiplier: multiplierAt(bx, by), lfGroup: (by >> 8) * dcGroupsX + (bx >> 8), source: null});
  const coefficientCount = 3 * blocks.reduce((sum, b) => sum + b.area * 64, 0);
  const denominator = half(field / (8 * 255 * QS)), matrices = new Map();
  const quant = table => {
    let m = matrices.get(table);
    if (!m) {
      const own = strategy ? strategy.tables[table] : null;
      if (own?.parameters) m = own.parameters.weights.map(p => Float32Array.from(p, v => 1 / v));
      else if (own) m = [0, 1, 2].map(c => Float32Array.from(own.planes[map[c]], v => f(v * denominator)));
      else if (!strategy && table === 0) m = [0, 1, 2].map(c => {
        const q = comps[c].quant, out = new Float32Array(64);
        for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) out[8 * x + y] = f(q[8 * y + x] * denominator);
        return out;
      });
      else m = libraryMatrix(table);
      matrices.set(table, m);
    }
    return m;
  };
  const tableBytes = TRANSFORMS.reduce((sizes, t) => (sizes[t.table] = t.width * t.height * 12, sizes), new Array(17).fill(0));
  const restoreRows = 128;
  const sizes = [...Array(9).fill(cells * 4), ...tableBytes, 65536 + 3 * 1024 * 8, numDcGroups * 8192,
    ...Array(3).fill(n * 4), coefficientCount * 4, n * 4];
  const at = kernels.reserve(sizes);
  const lfAt = at.slice(0, 9), weightsAt = at.slice(9, 26), [tablesAt, cflAt, xAt, yAt, bAt, arenaAt, rgbaAt] = at.slice(26);
  const i32 = kernels.i32, buffer = kernels.buffer;
  const lfDequant = [0, 1, 2].map(c => half(comps[c].quant[0] / dcScale[c] / (255 * 8 * QS) * 128));
  for (let c = 0; c < 3; c++) {
    const dc = copyVarDCTDCRows(varDCTDCSpec(image, layout, c, 0, 0, BW, BH), new Int32Array(cells));
    const step = f(lfDequant[c] * (1 << 9) / (global.globalScale * global.quantLF)), lf = new Float32Array(buffer, lfAt[c], cells);
    for (let i = 0; i < cells; i++) lf[i] = dc[i] * step;
  }
  const dims = [BW, BW, BW], zero = [0, 0, 0];
  const lf = prepareLF(kernels, lfAt, [cells, cells, cells], {dcWidth: dims, dcHeight: [BH, BH, BH], hshift: zero, vshift: zero,
    cflBlock: true, correlation: global.correlation, steps: lfDequant.map(m => 512 * m / (global.globalScale * global.quantLF)), smooth: false});
  const groups = [];
  for (let g = 0; g < numDcGroups; g++) {
    const bx = g % dcGroupsX * 256, by = Math.floor(g / dcGroupsX) * 256;
    const cw = Math.ceil(Math.min(2048, width - bx * 8) / 64), ch = Math.ceil(Math.min(2048, height - by * 8) / 64);
    const colors = [new Int32Array(cw * ch), new Int32Array(cw * ch)];
    if (image.cfl && !ycbcr) copyVarDCTCorrelation(image.cfl, bx, by, cw, ch, colors);
    groups.push({xFromY: colors[0], bFromY: colors[1], width: cw, bx, by});
  }
  const arena = new Int32Array(buffer, arenaAt, coefficientCount);
  let used = 0;
  for (const block of blocks) {
    const size = block.area * 64, held = [0, 0, 0];
    for (let c = 0; c < 3; c++) {
      held[c] = used;
      if (block.source) {
        const q = block.source.coeffs[map[c]], order = block.source.order;
        for (let k = block.area; k < size; k++) arena[used + order[k]] = q[order[k]];
      } else {
        const q = comps[c].coeffs, from = (block.y * comps[c].stride + block.x) * 64;
        for (let k = 1; k < 64; k++) arena[used + 8 * (k & 7) + (k >> 3)] = q[from + k];
      }
      used += size;
    }
    block.coefficients = held; block.arena = arena;
  }
  let sigma = null;
  if (filter.epf.iters) {
    sigma = new Float32Array(cells);
    const sharp = image.sharpness;
    for (const block of blocks) for (let y = 0; y < block.bh; y++) for (let x = 0; x < block.bw; x++) {
      const cell = (block.y + y) * BW + block.x + x;
      sigma[cell] = epfSigma(filter.epf, global.globalScale, block.multiplier, sharp ? sharp[cell] : 7);
    }
  }
  const targets = [xAt, yAt, bAt].map(o => new Float32Array(buffer, o, n));
  const ctx = {kernels, lf, widths: [width, width, width], heights: [height, height, height], bias: DEFAULT_OPSIN.quantizationBiases.slice(0, 3),
    numerator: DEFAULT_OPSIN.quantizationBiases[3], qmScale: [1, 1, 1], global, dcWidth: dims, ox: 0, hshift: zero, vshift: zero,
    cflBlock: true, weights: {offsets: weightsAt, loaded: []}, blocks: blockTables(tablesAt, cflAt), blockPlanes: [null, null, null],
    quant, group: g => groups[g]};
  for (const block of blocks) renderVarBlock(ctx, block, targets, zero);
  let planes = targets;
  if (stages.length) {
    const restored = restorePlanes(kernels, targets.map(p => p.slice()), width, height, filter, sigma);
    const [x, y, b, out] = kernels.reserve([n * 4, n * 4, n * 4, n * 4]);
    planes = [x, y, b].map((o, c) => { const p = new Float32Array(kernels.buffer, o, n); p.set(restored[c]); return p; });
    planes.rgbaAt = out;
  } else planes.rgbaAt = rgbaAt;
  const result = {};
  const alphaInto = rgba => {
    if (image.alpha) for (let i = 3; i < n * 4; i += 4) rgba[i] = image.alpha[i];
    else for (let i = 3; i < n * 4; i += 4) rgba[i] = 255;
  };
  if (ycbcr) {
    ycbcrToRGB(planes, n);
    if (wantGamma) result.gamma = planes.map(p => p.slice());
    if (wantRGBA) {
      kernels.i32.set([n, 0, planes[0].byteOffset, planes[1].byteOffset, planes[2].byteOffset, 0, planes.rgbaAt, 0, 0, 0], kernels.args / 4);
      kernels.rgba(kernels.args);
      result.rgba = new Uint8Array(kernels.buffer, planes.rgbaAt, n * 4).slice();
      alphaInto(result.rgba);
    }
    for (const block of blocks) block.source = null;
    return result;
  }
  const constants = xybKernelConstants(DEFAULT_OPSIN.inverseMatrix.map(f), DEFAULT_OPSIN.opsinBiases, 255);
  if (wantRGBA) {
    const rgba8 = new Uint8Array(kernels.buffer, planes.rgbaAt, n * 4);
    kernels.xyb(n, planes[0], planes[1], planes[2], constants, rgba8);
    result.rgba = rgba8.slice();
    alphaInto(result.rgba);
  }
  if (wantLinear) {
    kernels.xyb(n, planes[0], planes[1], planes[2], constants);
    result.linear = planes.map(p => p.slice());
  }
  for (const block of blocks) block.source = null;
  return result;
}

function coded(image) {
  if (image.lazyStrategy) return image.lazyStrategy.materialize();
  const stride = image.components[0].stride, rows = image.components[0].rows, observed = image.coefficientRows(0, rows);
  const {coefficientRows: _rows, ...rest} = image;
  return {...rest, components: image.components.map((c, channel) => ({...c, coeffs: observed[channel]}))};
}
