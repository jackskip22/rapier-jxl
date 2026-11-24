// SPDX-License-Identifier: MIT
import {quantParamHalfValue, quantParamNumber, quantParamInterpolate, quantParamVector, quantParamTriplet, quantParamBands, quantParamWeight, quantParamExpandBands} from './quantization-math.mjs';
import {float16Bits} from './bits.mjs';
import {fault} from './admit.mjs';
import {QUANT_PARAM_LIBRARY} from './quantization-defaults.mjs';
import {buildCode, uintConfig, writeHybrid} from './prefix.mjs';

const QUANT_PARAM_MODES = ['library', 'identity', 'dct2', 'dct4', 'dct4x8', 'afv', 'dct'];
const QUANT_PARAM_AFV_FREQS = [0, 0, .8517778890324296, 5.37778436506804, 0, 0, 4.734747904497923,
  5.449245381693219, 1.6598270267479331, 4, 7.275749096817861, 10.423227632456525,
  2.662932286148962, 7.630657783650829, 8.962388608184032, 12.97166202570235];






function quantParamAdmit(input, width, height, family) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || ArrayBuffer.isView(input))
    throw fault('JXL_INPUT', 'quantization table: {mode}');
  const mode = QUANT_PARAM_MODES.indexOf(input.mode), library = mode === 0;
  if (mode < 0) throw fault('JXL_INPUT', 'mode: library, identity, dct2, dct4, dct4x8, afv or dct');
  if (mode > 0 && mode < 6 && width * height !== 64)
    throw fault('JXL_INPUT', 'compact mode: 8x8 family required');
  const source = library ? QUANT_PARAM_LIBRARY[family] : input;
  if (!source) throw fault('JXL_INPUT', 'unknown quantization family');
  const kind = QUANT_PARAM_MODES.indexOf(source.mode), table = {mode, kind, library};
  const positive = (v, divisor = 1) => quantParamNumber(v, divisor, true, library);
  if ((typeof __RAPIER_JXL_UPLOAD__ === 'undefined' || __RAPIER_JXL_UPLOAD__ !== true) && (kind === 1 || kind === 2)) table.weights = quantParamTriplet(source.weights, kind === 1 ? 3 : 6, v => positive(v, 64));
  else if ((typeof __RAPIER_JXL_UPLOAD__ === 'undefined' || __RAPIER_JXL_UPLOAD__ !== true) && kind === 3) {
    table.multipliers = quantParamTriplet(source.multipliers, 2, v => positive(v));
    table.bands = quantParamBands(source.bands, library);
  } else if ((typeof __RAPIER_JXL_UPLOAD__ === 'undefined' || __RAPIER_JXL_UPLOAD__ !== true) && kind === 4) {
    table.multipliers = quantParamVector(source.multipliers, 3, v => positive(v));
    table.bands = quantParamBands(source.bands, library);
  } else if ((typeof __RAPIER_JXL_UPLOAD__ === 'undefined' || __RAPIER_JXL_UPLOAD__ !== true) && kind === 5) {
    table.weights = quantParamTriplet(source.weights, 9, (v, i) => quantParamNumber(v, i < 6 ? 64 : 1, i < 6, library));
    table.bands4x8 = quantParamBands(source.bands4x8, library);
    table.bands4x4 = quantParamBands(source.bands4x4, library);
  } else table.bands = quantParamBands(source.bands, library);
  return table;
}





export function fillQuantParamDCT(parameters, width, height, out, from = 0, to = width * height, origin = 0) {
  const bands = quantParamExpandBands(parameters), scale = (bands.length - 1) / (1.4142135623730951 + .000001);
  for (let i = from; i < to; i++) {
    const x = (i % width) / (width - 1), y = Math.floor(i / width) / (height - 1);
    out[i - origin] = quantParamInterpolate(bands, Math.sqrt(x * x + y * y) * scale);
  }
  return out;
}
function quantParamDCT(parameters, width, height) {
  return fillQuantParamDCT(parameters, width, height, new Float64Array(width * height));
}

export function quantParamMatrix(table, channel, width, height) {
  const {kind} = table;
  if ((typeof __RAPIER_JXL_UPLOAD__ !== 'undefined' && __RAPIER_JXL_UPLOAD__ === true) || kind === 6) return quantParamDCT(table.bands[channel], width, height);
  const plane = new Float64Array(64), weights = table.weights?.[channel];
  if (kind === 1) {
    plane.fill(weights[0]); plane[1] = plane[8] = weights[1]; plane[9] = weights[2];
  } else if (kind === 2) {
    plane[0] = 1;
    for (let i = 0; i < 6; i++) {
      const size = 1 << Math.floor(i / 2);
      for (let y = i & 1 ? size : 0; y < (i & 1 ? 2 * size : size); y++) for (let x = size; x < 2 * size; x++) {
        plane[y * 8 + x] = weights[i];
        if (!(i & 1)) plane[x * 8 + y] = weights[i];
      }
    }
  } else if (kind === 3) {
    const small = quantParamDCT(table.bands[channel], 4, 4);
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) plane[y * 8 + x] = small[Math.floor(y / 2) * 4 + Math.floor(x / 2)];
    plane[1] /= table.multipliers[channel][0]; plane[8] /= table.multipliers[channel][0]; plane[9] /= table.multipliers[channel][1];
  } else if (kind === 4) {
    const small = quantParamDCT(table.bands[channel], 8, 4);
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) plane[y * 8 + x] = small[Math.floor(y / 2) * 8 + x];
    plane[8] /= table.multipliers[channel];
  } else {
    const bands = quantParamExpandBands(weights.slice(5)), low = QUANT_PARAM_AFV_FREQS[2], span = QUANT_PARAM_AFV_FREQS[15] - low + .000001;
    const half = quantParamDCT(table.bands4x8[channel], 8, 4), quarter = quantParamDCT(table.bands4x4[channel], 4, 4);
    plane[0] = 1; plane[8] = weights[0]; plane[1] = weights[1]; plane[16] = weights[2]; plane[2] = weights[3]; plane[18] = weights[4];
    for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) if (x >= 2 || y >= 2)
      plane[y * 16 + x * 2] = quantParamInterpolate(bands, (QUANT_PARAM_AFV_FREQS[y * 4 + x] - low) * 3 / span);
    for (let y = 0; y < 4; y++) for (let x = 0; x < 8; x++) if (x || y) plane[(y * 2 + 1) * 8 + x] = half[y * 8 + x];
    for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) if (x || y) plane[y * 16 + x * 2 + 1] = quarter[y * 4 + x];
  }
  for (const weight of plane) quantParamWeight(weight);
  return plane;
}

function quantParamWriteBands(writer, bands, order) {
  writer.write(4, bands[0].length - 1);
  for (const channel of order) for (let i = 0; i < bands[channel].length; i++)
    writer.write(16, float16Bits(bands[channel][i] / (i ? 1 : 64)));
}

export function writeQuantParams(writer, table, order) {
  writer.write(3, table.mode);
  if (table.library) return;
  const {kind} = table;
  if ((typeof __RAPIER_JXL_UPLOAD__ === 'undefined' || __RAPIER_JXL_UPLOAD__ !== true) && (!(typeof __RAPIER_JXL_CAPTURE_PHOTO__ !== 'undefined' && __RAPIER_JXL_CAPTURE_PHOTO__ === true) && (kind === 1 || kind === 2))) for (const channel of order) for (const value of table.weights[channel]) writer.write(16, float16Bits(value / 64));
  else if ((typeof __RAPIER_JXL_UPLOAD__ === 'undefined' || __RAPIER_JXL_UPLOAD__ !== true) && !(typeof __RAPIER_JXL_CAPTURE_PHOTO__ !== 'undefined' && __RAPIER_JXL_CAPTURE_PHOTO__ === true) && (kind === 3 || kind === 4)) {
    for (const channel of order) for (const value of kind === 3 ? table.multipliers[channel] : [table.multipliers[channel]]) writer.write(16, float16Bits(value));
    quantParamWriteBands(writer, table.bands, order);
  } else if ((typeof __RAPIER_JXL_UPLOAD__ === 'undefined' || __RAPIER_JXL_UPLOAD__ !== true) && (!(typeof __RAPIER_JXL_CAPTURE_PHOTO__ !== 'undefined' && __RAPIER_JXL_CAPTURE_PHOTO__ === true) && kind === 5)) {
    for (const channel of order) for (let i = 0; i < 9; i++) writer.write(16, float16Bits(table.weights[channel][i] / (i < 6 ? 64 : 1)));
    quantParamWriteBands(writer, table.bands4x8, order); quantParamWriteBands(writer, table.bands4x4, order);
  } else quantParamWriteBands(writer, table.bands, order);
}

export function prepareQuantParams(input, width, height, family) {
  const table = quantParamAdmit(input, width, height, family);
  const weights = [0, 1, 2].map(channel => quantParamMatrix(table, channel, width, height));
  return {mode: table.mode, weights, library: table.library, syntax: table};
}

export function quantParamStepValues(weights, quantScale, field, out = new Float64Array(weights.length)) {
  for (let i = 0; i < weights.length; i++) out[i] = 8 * 255 * quantScale / (field * weights[i]);
  return out;
}
export function quantParamSteps(prepared, quantScale, field, order) {
  return order.map((_, component) => quantParamStepValues(prepared.weights[prepared.library ? order.indexOf(component) : component], quantScale, field));
}
export {quantParamAdmit as quantParamDescriptor};

export function quantParamCoding(counts) {
  const config = uintConfig(0), aggregate = counts.aggregate(Array.from({length: counts.contexts}, (_, i) => i));
  const code = buildCode(aggregate.tokens([0], config, 64)), contextMap = new Uint8Array(counts.contexts);
  const histograms = [{config, code}];
  return {contextMap, histograms, model: {kind: 'prefix', contextMap, histograms}, bits: 0,
    write: (writer, context, value) => writeHybrid(writer, code, config, value)};
}

const DCT8_TWINS = new WeakMap(), TWIN_BANDS = 6;
const twinAt = k => Math.sqrt((k & 7) * (k & 7) + (k >> 3) * (k >> 3)) / 7 * (TWIN_BANDS - 1) / (1.4142135623730951 + .000001);
function twinBands(steps, denominator) {
  const n = TWIN_BANDS, a = Array.from({length: n}, () => new Float64Array(n + 1));
  for (let k = 1; k < 64; k++) {
    const at = twinAt(k), i = Math.min(n - 2, Math.floor(at)), t = at - i, y = -Math.log(steps[k] * denominator);
    a[i][i] += (1 - t) * (1 - t); a[i][i + 1] += (1 - t) * t; a[i + 1][i] += (1 - t) * t; a[i + 1][i + 1] += t * t;
    a[i][n] += (1 - t) * y; a[i + 1][n] += t * y;
  }
  for (let i = 1; i < n; i++) { const f = a[i][i - 1] / a[i - 1][i - 1]; for (let j = i - 1; j <= n; j++) a[i][j] -= f * a[i - 1][j]; }
  const logs = new Float64Array(n);
  for (let i = n - 1; i >= 0; i--) logs[i] = (a[i][n] - (i < n - 1 ? a[i][i + 1] * logs[i + 1] : 0)) / a[i][i];
  const first = quantParamHalfValue(float16Bits(Math.exp(logs[0]) / 64)) * 64, bands = [first];
  if (!(first > 0) || !Number.isFinite(first)) return null;
  let previous = first;
  for (let i = 1; i < n; i++) {
    const ratio = Math.exp(logs[i]) / previous, fall = quantParamHalfValue(float16Bits(ratio >= 1 ? ratio - 1 : 1 - 1 / ratio));
    bands.push(fall); previous *= fall > 0 ? 1 + fall : 1 / (1 - fall);
  }
  const weights = fillQuantParamDCT(bands, 8, 8, new Float64Array(64));
  for (let k = 1; k < 64; k++) {
    const step = 1 / (weights[k] * denominator);
    if (!(Math.abs(step - steps[k]) <= Math.max(1, steps[k] / 400))) return null;
  }
  return {bands, weights};
}
export function dct8Twin(steps, field, quantScale) {
  const denominator = quantParamHalfValue(float16Bits(field / (8 * 255 * quantScale)));
  let byFirst = DCT8_TWINS.get(steps[0]), bySecond = byFirst?.get(steps[1]), entry = bySecond?.get(steps[2]);
  if (!entry || entry.denominator !== denominator) {
    const twins = steps.map(s => twinBands(s, denominator));
    entry = {denominator, twin: twins.every(Boolean) ? {mode: 6, kind: 6, library: false, bands: twins.map(t => t.bands), weights: twins.map(t => t.weights)} : null};
    if (!byFirst) DCT8_TWINS.set(steps[0], byFirst = new WeakMap());
    if (!bySecond) byFirst.set(steps[1], bySecond = new WeakMap());
    bySecond.set(steps[2], entry);
  }
  return entry.twin;
}

function acZero(comps) {
  for (const comp of comps) {
    const coeffs = comp.coeffs;
    if (!coeffs || comp.row0 !== undefined || coeffs.length < comp.stride * comp.rows * 64) return false;
    for (let i = 0; i < coeffs.length; i++) if (coeffs[i] && i & 63) return false;
  }
  return true;
}
const LIBRARY_DCT8 = Object.freeze({mode: 0, library: true});
const COMPACT_SIDE = 64;
export function photoDCT8Table(image, steps, field, quantScale, comps = null) {
  if (!image.xyb || Math.min(image.width, image.height) >= COMPACT_SIDE) return null;
  return comps && acZero(comps) ? LIBRARY_DCT8 : dct8Twin(steps, field, quantScale);
}
