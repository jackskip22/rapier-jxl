// SPDX-License-Identifier: MIT
import {fault} from './admit.mjs';
import {ceilLog2} from './bits.mjs';
import {QUANT_SHAPE} from './photo-dct.mjs';
import {AFV_BASIS} from './afv-basis.mjs';
import {prepareQuantParams, quantParamSteps} from './quantization-params.mjs';

const NAMES = ['dct8', 'identity', 'dct2', 'dct4', 'dct16', 'dct32', 'dct16x8', 'dct8x16',
  'dct32x8', 'dct8x32', 'dct32x16', 'dct16x32', 'dct4x8', 'dct8x4', 'afv0', 'afv1', 'afv2', 'afv3',
  'dct64', 'dct64x32', 'dct32x64', 'dct128', 'dct128x64', 'dct64x128', 'dct256', 'dct256x128', 'dct128x256'];
const WIDTHS = [1, 1, 1, 1, 2, 4, 1, 2, 1, 4, 2, 4, 1, 1, 1, 1, 1, 1, 8, 4, 8, 16, 8, 16, 32, 16, 32];
const HEIGHTS = [1, 1, 1, 1, 2, 4, 2, 1, 4, 1, 4, 2, 1, 1, 1, 1, 1, 1, 8, 8, 4, 16, 16, 8, 32, 32, 16];
const TABLES = [0, 1, 2, 3, 4, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 10, 10, 11, 12, 12, 13, 14, 14, 15, 16, 16];
export const TRANSFORMS = Object.freeze(NAMES.map((name, id) => Object.freeze({name, id, width: WIDTHS[id] * 8,
  height: HEIGHTS[id] * 8, table: TABLES[id]})));
const bases = new Map(), scans = new Map();

function cosine(numerator, denominator) {
  let n = numerator % (denominator * 2);
  if (n > denominator) n -= denominator * 2;
  if (n < -denominator) n += denominator * 2;
  let sign = 1;
  if (n > denominator / 2) { n = denominator - n; sign = -1; }
  if (n < -denominator / 2) { n = -denominator - n; sign = -1; }
  const x = n * 3.141592653589793 / denominator, square = x * x;
  let term = 1, sum = 1;
  for (let i = 1; i < 15; i++) sum += term *= -square / ((2 * i - 1) * (2 * i));
  return sign * sum;
}

function basis(size) {
  let b = bases.get(size);
  if (!b) {
    b = new Float64Array(size * size);
    for (let k = 0; k < size; k++) for (let x = 0; x < size; x++) b[k * size + x] =
      k ? 1.4142135623730951 * cosine((2 * x + 1) * k, 2 * size) / size : 1 / size;
    bases.set(size, b);
  }
  return b;
}

export function scaledDCT(pixels, width, height) {
  const bx = basis(width), by = basis(height), tmp = new Float64Array(width * height), out = new Float64Array(tmp.length);
  for (let y = 0; y < height; y++) for (let u = 0; u < width; u++) {
    let sum = 0;
    for (let x = 0; x < width; x++) sum += pixels[y * width + x] * bx[u * width + x];
    tmp[y * width + u] = sum;
  }
  for (let v = 0; v < height; v++) for (let u = 0; u < width; u++) {
    let sum = 0;
    for (let y = 0; y < height; y++) sum += tmp[y * width + u] * by[v * height + y];
    out[height >= width ? u * height + v : v * width + u] = sum;
  }
  return out;
}

function inverseScaledDCT(coeffs, width, height) {
  const bx = basis(width), by = basis(height), tmp = new Float64Array(width * height), out = new Float64Array(tmp.length);
  for (let v = 0; v < height; v++) for (let x = 0; x < width; x++) {
    let sum = 0;
    for (let u = 0; u < width; u++) sum += coeffs[height >= width ? u * height + v : v * width + u] * bx[u * width + x] * width;
    tmp[v * width + x] = sum;
  }
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    let sum = 0;
    for (let v = 0; v < height; v++) sum += tmp[v * width + x] * by[v * height + y] * height;
    out[y * width + x] = sum;
  }
  return out;
}

function smallTransform(pixels, id) {
  const out = new Float64Array(64);
  const cut = (x0, y0, w, h) => Float64Array.from({length: w * h}, (_, i) => pixels[(y0 + Math.floor(i / w)) * 8 + x0 + i % w]);
  const combineFour = () => {
    const a = out[0], b = out[1], c = out[8], d = out[9];
    out[0] = (a + b + c + d) * .25; out[1] = (a + b - c - d) * .25;
    out[8] = (a - b + c - d) * .25; out[9] = (a - b - c + d) * .25;
  };
  if (id === 1 || id === 3) {
    for (let by = 0; by < 2; by++) for (let bx = 0; bx < 2; bx++) {
      const block = cut(bx * 4, by * 4, 4, 4);
      if (id === 3) {
        const coeffs = scaledDCT(block, 4, 4);
        for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) out[(by + y * 2) * 8 + bx + x * 2] = coeffs[y * 4 + x];
      } else {
        let sum = 0;
        for (const value of block) sum += value;
        for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) if (x !== 1 || y !== 1)
          out[(by + y * 2) * 8 + bx + x * 2] = block[y * 4 + x] - block[5];
        out[(by + 2) * 8 + bx + 2] = out[by * 8 + bx]; out[by * 8 + bx] = sum / 16;
      }
    }
    combineFour();
  } else if (id === 2) {
    out.set(pixels);
    for (const size of [8, 4, 2]) {
      const temp = new Float64Array(64), half = size / 2;
      for (let y = 0; y < half; y++) for (let x = 0; x < half; x++) {
        const a = out[y * 16 + x * 2], b = out[y * 16 + x * 2 + 1], c = out[y * 16 + x * 2 + 8], d = out[y * 16 + x * 2 + 9];
        temp[y * 8 + x] = (a + b + c + d) * .25;
        temp[y * 8 + x + half] = (a + b - c - d) * .25;
        temp[(y + half) * 8 + x] = (a - b + c - d) * .25;
        temp[(y + half) * 8 + x + half] = (a - b - c + d) * .25;
      }
      for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) out[y * 8 + x] = temp[y * 8 + x];
    }
  } else if (id === 12 || id === 13) {
    for (let half = 0; half < 2; half++) {
      const w = id === 12 ? 8 : 4, h = id === 12 ? 4 : 8;
      const coeffs = scaledDCT(cut(id === 13 ? half * 4 : 0, id === 12 ? half * 4 : 0, w, h), w, h);
      for (let y = 0; y < 4; y++) for (let x = 0; x < 8; x++) out[(half + y * 2) * 8 + x] = coeffs[y * 8 + x];
    }
    const a = out[0], b = out[8]; out[0] = (a + b) * .5; out[8] = (a - b) * .5;
  } else {
    const kind = id - 14, ax = kind & 1, ay = kind >> 1, block = cut(ax * 4, ay * 4, 4, 4);
    for (let i = 0; i < 16; i++) {
      let sum = 0;
      for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) sum += block[(ay ? 3 - y : y) * 4 + (ax ? 3 - x : x)] * AFV_BASIS[(y * 4 + x) * 16 + i];
      out[Math.floor(i / 4) * 16 + (i % 4) * 2] = sum;
    }
    const other = scaledDCT(cut((1 - ax) * 4, ay * 4, 4, 4), 4, 4);
    for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) out[y * 16 + x * 2 + 1] = other[y * 4 + x];
    const half = scaledDCT(cut(0, (1 - ay) * 4, 8, 4), 8, 4);
    for (let y = 0; y < 4; y++) for (let x = 0; x < 8; x++) out[(1 + y * 2) * 8 + x] = half[y * 8 + x];
    const a = out[0] * .25, b = out[1], c = out[8];
    out[0] = (a + b + 2 * c) * .25; out[1] = (a - b) * .5; out[8] = (a + b - 2 * c) * .25;
  }
  return out;
}

export function naturalOrder(widthBlocks, heightBlocks) {
  const cx = Math.max(widthBlocks, heightBlocks), cy = Math.min(widthBlocks, heightBlocks), key = cx * 64 + cy;
  if (scans.has(key)) return scans.get(key);
  const width = cx * 8, ratio = cx / cy, order = new Uint32Array(cx * cy * 64);
  let next = cx * cy;
  for (let i = 0; i < width; i++) for (let j = 0; j <= i; j++) {
    let x = j, y = i - j;
    if (i & 1) [x, y] = [y, x];
    if (y % ratio) continue;
    y /= ratio;
    order[x < cx && y < cy ? y * cx + x : next++] = y * width + x;
  }
  for (let ip = width - 1; ip > 0; ip--) for (let j = 0; j < ip; j++) {
    let x = width - ip + j, y = width - 1 - j;
    if ((ip - 1) & 1) [x, y] = [y, x];
    if (y % ratio) continue;
    order[next++] = y / ratio * width + x;
  }
  scans.set(key, order);
  return order;
}

function lowFrequencies(coeffs, widthBlocks, heightBlocks) {
  const w = Math.max(widthBlocks, heightBlocks), h = Math.min(widthBlocks, heightBlocks), low = new Float64Array(w * h);
  const scale = (k, size) => cosine(k, 2 * size) * cosine(k, size) * cosine(2 * k, size);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) low[y * w + x] = coeffs[y * w * 8 + x]
    * scale(x, w * 8) * scale(y, h * 8);
  return inverseScaledDCT(low, widthBlocks, heightBlocks);
}

function radialShape(x, y, width, height) {
  const u = x * 8 / width, v = y * 8 / height;
  const exponent = Math.max(0, Math.sqrt(u * u + v * v) * 5 / Math.sqrt(98) - 1) * 0.26236426446749106;
  let term = 1, sum = 1;
  for (let n = 1; n < 30; n++) sum += term *= exponent / n;
  return sum;
}

function admitTransforms(value) {
  if (value === undefined || value === 'auto') return [4, 0];
  const names = Array.isArray(value) ? value : [value];
  if (!names.length || names.length > 27) throw fault('JXL_INPUT', 'transforms names one or more JPEG XL transform strategies.');
  const ids = names.map(name => NAMES.indexOf(name));
  if (ids.some(id => id < 0)) throw fault('JXL_INPUT', 'transforms names a strategy exported by TRANSFORMS, or auto.');
  return [...new Set([...ids, 0])].sort((a, b) => WIDTHS[b] * HEIGHTS[b] - WIDTHS[a] * HEIGHTS[a]);
}

function admitQuantization(value) {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw fault('JXL_INPUT', 'quantization maps transform names to three positive coefficient-step arrays.');
  const out = {};
  for (const [name, matrices] of Object.entries(value)) {
    if (name === 'dc') {
      if ((!Array.isArray(matrices) && !ArrayBuffer.isView(matrices)) || matrices.length !== 3)
        throw fault('JXL_INPUT', 'quantization.dc gives three positive DC steps in Y/Cb/Cr order.');
      out.dc = Int32Array.from(matrices, value => {
        if (!Number.isFinite(value) || value < 1 / 16 || value > 4095) throw fault('JXL_INPUT', 'DC steps are finite numbers from 1/16 through 4095.');
        return Math.round(value * 16);
      });
      continue;
    }
    const id = NAMES.indexOf(name), area = id < 0 ? 0 : WIDTHS[id] * HEIGHTS[id] * 64;
    if (!area) throw fault('JXL_INPUT', 'Quantization keys name transform families from TRANSFORMS.');
    if (out[TABLES[id]]) throw fault('JXL_INPUT', 'Transposed strategies share one quantization family; supply that family once.');
    if (matrices && typeof matrices === 'object' && !Array.isArray(matrices) && !ArrayBuffer.isView(matrices)) {
      const parameters = prepareQuantParams(matrices, Math.max(WIDTHS[id], HEIGHTS[id]) * 8, Math.min(WIDTHS[id], HEIGHTS[id]) * 8, TABLES[id]);
      out[TABLES[id]] = {parameters, planes: quantParamSteps(parameters, 16, 2, [1, 0, 2])};
      continue;
    }
    if (!Array.isArray(matrices) || matrices.length !== 3 || matrices.some(matrix => !matrix || matrix.length !== area))
      throw fault('JXL_INPUT', 'Each custom quantization family has three complete coefficient-step matrices or a compact descriptor.');
    out[TABLES[id]] = matrices.map(matrix => Int32Array.from(matrix, value => {
      if (!Number.isFinite(value) || value < 1 / 16 || value > 4095) throw fault('JXL_INPUT', 'Coefficient steps are finite numbers from 1/16 through 4095.');
      return Math.round(value * 16);
    }));
  }
  return out;
}

export function admitStrategyOptions(options) {
  if (options.orientation !== undefined && (!Number.isInteger(options.orientation) || options.orientation < 1 || options.orientation > 8))
    throw fault('JXL_INPUT', 'orientation is an Exif orientation from one through eight.');
  const selection = new Map(Object.entries(options)).get('transforms');
  return {ids: admitTransforms(selection), custom: admitQuantization(options.quantization),
    automatic: selection === undefined || selection === 'auto', variable: selection !== undefined || options.quantization !== undefined};
}

function strategyQuantization(width, height, quality, custom) {
  const stride = Math.ceil(width / 8), rows = Math.ceil(height / 8), quantScale = 16;
  const distance = quality >= 30 ? 0.1 + (100 - quality) * 0.09 : 53 / 3000 * quality * quality - 23 / 20 * quality + 25;
  const components = [0, 1, 2].map(c => ({h: 1, v: 1, stride, rows, coeffs: new Int16Array(0), dc: new Int32Array(stride * rows),
    quant: Int32Array.from(QUANT_SHAPE, (shape, k) => Math.max(1, Math.round(quantScale * distance * (c ? 18 : 10) * (k ? shape : 0.25))))}));
  if (custom.dc) for (let c = 0; c < 3; c++) components[c].quant[0] = custom.dc[c];
  const tables = new Map();
  const tableFor = id => {
    const family = TABLES[id];
    if (tables.has(family)) return tables.get(family);
    const w = Math.max(WIDTHS[id], HEIGHTS[id]) * 8, h = Math.min(WIDTHS[id], HEIGHTS[id]) * 8, scale = 8 / Math.sqrt(w * h);
    const parameters = custom[family]?.parameters;
    const planes = (parameters ? custom[family].planes : custom[family]) || components.map((comp, c) => Int32Array.from({length: w * h}, (_, k) =>
      Math.max(1, Math.round(quantScale * distance * (c ? 18 : 10) * scale * radialShape(k % w, Math.floor(k / w), w, h)))));
    const table = {w, h, planes, parameters}; tables.set(family, table); return table;
  };
  return {components, stride, rows, quantScale, tables, tableFor};
}

export function* strategyCoefficientSteps(data, width, height, quality, colorSpace, options = {}, admitted = admitStrategyOptions(options), retain = false) {
  const {ids, custom, automatic} = admitted;
  const {components, stride, rows, quantScale, tables, tableFor} = strategyQuantization(width, height, quality, custom);
  const groupsX = Math.ceil(width / 256), groupsY = Math.ceil(height / 256), groups = [], blocks = [];
  let wideCoefficients = false;
  const at = new Int32Array(stride * rows).fill(-1);
  const candidate = (id, bx, by) => {
    const bw = WIDTHS[id], bh = HEIGHTS[id], w = bw * 8, h = bh * 8, area = bw * bh, size = area * 64;
    const pixels = components.map(() => new Float64Array(size));
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const source = (Math.min(height - 1, by * 8 + y) * width + Math.min(width - 1, bx * 8 + x)) * 4;
      const r = data[source], g = data[source + 1], b = data[source + 2], k = y * w + x;
      pixels[0][k] = .299 * r + .587 * g + .114 * b - 128;
      pixels[1][k] = -.168735892 * r - .331264108 * g + .5 * b;
      pixels[2][k] = .5 * r - .418687589 * g - .081312411 * b;
    }
    const table = tableFor(id), order = naturalOrder(bw, bh), coeffs = [], dc = [], unquantized = retain && {planes: [], low: []};
    let cost = 18, wide = false;
    for (let c = 0; c < 3; c++) {
      const transformed = id === 1 || id === 2 || id === 3 || id >= 12 && id <= 17 ? smallTransform(pixels[c], id) : scaledDCT(pixels[c], w, h);
      const plane = new Int32Array(size);
      const low = lowFrequencies(transformed, bw, bh), dcStep = components[c].quant[0] / quantScale;
      if (unquantized) { unquantized.planes.push(transformed); unquantized.low.push(low); }
      dc.push(Int32Array.from(low, value => Math.round(value * 8 / dcStep)));
      for (let k = area; k < size; k++) {
        const pos = order[k], step = table.planes[c][pos] / quantScale, value = Math.round(transformed[pos] * 8 / step);
        if (!Number.isSafeInteger(value) || value < -2147483648 || value > 2147483647)
          throw fault('JXL_INPUT', 'Quantization produces a coefficient outside the signed 32-bit format range.');
        wide ||= value < -32768 || value > 32767;
        plane[pos] = value;
        if (value) cost += 2 + ceilLog2(1 + Math.abs(value));
      }
      coeffs.push(plane);
    }
    const block = {id, bx, by, bw, bh, area, size, order, coeffs, dc, cost, wide};
    if (unquantized) block.unquantized = unquantized;
    return block;
  };
  for (let gy = 0; gy < groupsY; gy++) for (let gx = 0; gx < groupsX; gx++) {
    const group = [], x0 = gx * 32, y0 = gy * 32, x1 = Math.min(stride, x0 + 32), y1 = Math.min(rows, y0 + 32);
    for (let by = y0; by < y1; by++) for (let bx = x0; bx < x1; bx++) {
      if (at[by * stride + bx] !== -1) continue;
      let chosen;
      for (const id of ids) {
        const bw = WIDTHS[id], bh = HEIGHTS[id];
        if (bx + bw > x1 || by + bh > y1) continue;
        let clear = true;
        for (let y = 0; y < bh && clear; y++) for (let x = 0; x < bw; x++) if (at[(by + y) * stride + bx + x] !== -1) { clear = false; break; }
        if (!clear) continue;
        const large = candidate(id, bx, by);
        if (automatic) {
          if (id) {
            let smallCost = 0;
            for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) smallCost += candidate(0, bx + x, by + y).cost;
            if (large.cost >= smallCost) continue;
          }
        }
        chosen = large; break;
      }
      const index = blocks.length; blocks.push(chosen); group.push(chosen);
      wideCoefficients ||= chosen.wide;
      for (let y = 0; y < chosen.bh; y++) for (let x = 0; x < chosen.bw; x++) {
        const pos = (by + y) * stride + bx + x;
        at[pos] = x || y ? -2 : index;
        for (let c = 0; c < 3; c++) components[c].dc[pos] = chosen.dc[c][y * chosen.bw + x];
      }
    }
    groups.push(group); yield groups.length / (groupsX * groupsY);
  }
  const used = new Set(blocks.map(block => TABLES[block.id]));
  for (const id of tables.keys()) if (!used.has(id)) tables.delete(id);
  let alpha = null;
  for (let i = 3; i < data.length; i += 4) if (data[i] !== 255) { alpha = data; break; }
  return {width, height, components, quantScale, ycbcr: true, orientation: options.orientation || 1, alpha, colorSpace,
    wideCoefficients, strategyData: {groups, blocks, at, tables, stride}};
}

export function* requantizeStrategySteps(retained, quality, admitted) {
  const {width, height} = retained;
  const {components, stride, quantScale, tables, tableFor} = strategyQuantization(width, height, quality, admitted.custom);
  const groups = [], blocks = [];
  let wideCoefficients = false;
  for (const sourceGroup of retained.strategyData.groups) {
    const group = [];
    for (const source of sourceGroup) {
      const {id, bx, by, bw, bh, area, size, order, unquantized} = source, table = tableFor(id), coeffs = [], dc = [];
      for (let c = 0; c < 3; c++) {
        const plane = new Int32Array(size), transformed = unquantized.planes[c], dcStep = components[c].quant[0] / quantScale;
        const low = Int32Array.from(unquantized.low[c], value => Math.round(value * 8 / dcStep));
        dc.push(low);
        for (let k = area; k < size; k++) {
          const pos = order[k], step = table.planes[c][pos] / quantScale, value = Math.round(transformed[pos] * 8 / step);
          if (!Number.isSafeInteger(value) || value < -2147483648 || value > 2147483647)
            throw fault('JXL_INPUT', 'Quantization produces a coefficient outside the signed 32-bit format range.');
          wideCoefficients ||= value < -32768 || value > 32767;
          plane[pos] = value;
        }
        coeffs.push(plane);
        for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) components[c].dc[(by + y) * stride + bx + x] = low[y * bw + x];
      }
      const block = {id, bx, by, bw, bh, area, size, order, coeffs, dc};
      group.push(block); blocks.push(block);
    }
    groups.push(group); yield groups.length / retained.strategyData.groups.length;
  }
  return {width, height, components, quantScale, ycbcr: true, orientation: retained.orientation,
    alpha: retained.alpha, colorSpace: retained.colorSpace, wideCoefficients,
    strategyData: {groups, blocks, at: retained.strategyData.at, tables, stride}};
}
