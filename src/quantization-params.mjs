// SPDX-License-Identifier: MIT
import {float16Bits} from './bits.mjs';
import {fault} from './admit.mjs';
import {entropyLog2} from './entropy.mjs';
import {QUANT_PARAM_LIBRARY} from './quantization-defaults.mjs';
import {buildCode, uintConfig, writeHybrid} from './prefix.mjs';

const QUANT_PARAM_MODES = ['library', 'identity', 'dct2', 'dct4', 'dct4x8', 'afv', 'dct'];
const QUANT_PARAM_AFV_FREQS = [0, 0, .8517778890324296, 5.37778436506804, 0, 0, 4.734747904497923,
  5.449245381693219, 1.6598270267479331, 4, 7.275749096817861, 10.423227632456525,
  2.662932286148962, 7.630657783650829, 8.962388608184032, 12.97166202570235];

function quantParamHalfValue(bits) {
  const sign = bits & 32768 ? -1 : 1, exponent = (bits >>> 10) & 31, mantissa = bits & 1023;
  let value = exponent ? 1024 + mantissa : mantissa, shift = exponent ? exponent - 25 : -24;
  while (shift < 0) { value /= 2; shift++; }
  while (shift > 0) { value *= 2; shift--; }
  return sign * value;
}

function quantParamNumber(value, divisor, positive, library) {
  if (typeof value !== 'number' || !Number.isFinite(value) || positive && value <= 0)
    throw fault('JXL_INPUT', 'Quantization parameters are finite; weights and multipliers positive.');
  if (library) return value;
  if (Math.abs(value / divisor) >= 65520) throw fault('JXL_INPUT', 'Quantization parameter exceeds its binary16 field.');
  const decoded = quantParamHalfValue(float16Bits(value / divisor)) * divisor;
  if (positive && decoded <= 0) throw fault('JXL_INPUT', 'A quantization parameter rounds to zero in binary16.');
  return decoded;
}

function quantParamVector(value, count, convert) {
  if ((!Array.isArray(value) && !ArrayBuffer.isView(value)) || value.length !== count)
    throw fault('JXL_INPUT', 'A quantization parameter vector has the wrong length.');
  return Array.from(value, convert);
}

function quantParamTriplet(value, count, convert) {
  if (!Array.isArray(value) || value.length !== 3)
    throw fault('JXL_INPUT', 'Quantization parameters are three vectors, Y/Cb/Cr.');
  return value.map(vector => quantParamVector(vector, count, convert));
}

function quantParamBands(value, library) {
  const count = value?.[0]?.length;
  if (!Number.isInteger(count) || count < 1 || count > 16)
    throw fault('JXL_INPUT', 'DCT distance bands: 1 to 16 values per channel.');
  return quantParamTriplet(value, count, (v, i) => quantParamNumber(v, i ? 1 : 64, !i, library));
}

function quantParamAdmit(input, width, height, family) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || ArrayBuffer.isView(input))
    throw fault('JXL_INPUT', 'A compact quantization table is a descriptor with a mode.');
  const mode = QUANT_PARAM_MODES.indexOf(input.mode), library = mode === 0;
  if (mode < 0) throw fault('JXL_INPUT', 'Quantization mode is library, identity, dct2, dct4, dct4x8, afv or dct.');
  if (mode > 0 && mode < 6 && width * height !== 64)
    throw fault('JXL_INPUT', 'Compact quantization modes need an 8x8 table family.');
  const source = !(typeof __RAPIER_JXL_CAPTURE_PHOTO__ !== 'undefined' && __RAPIER_JXL_CAPTURE_PHOTO__ === true) && library ? QUANT_PARAM_LIBRARY[family] : input;
  if (!source) throw fault('JXL_INPUT', 'Unknown quantization-table family.');
  const kind = QUANT_PARAM_MODES.indexOf(source.mode), table = {mode, kind, library};
  const positive = (v, divisor = 1) => quantParamNumber(v, divisor, true, library);
  if (!(typeof __RAPIER_JXL_CAPTURE_PHOTO__ !== 'undefined' && __RAPIER_JXL_CAPTURE_PHOTO__ === true) && (kind === 1 || kind === 2)) table.weights = quantParamTriplet(source.weights, kind === 1 ? 3 : 6, v => positive(v, 64));
  else if (kind === 3) {
    table.multipliers = quantParamTriplet(source.multipliers, 2, v => positive(v));
    table.bands = quantParamBands(source.bands, library);
  } else if (kind === 4) {
    table.multipliers = quantParamVector(source.multipliers, 3, v => positive(v));
    table.bands = quantParamBands(source.bands, library);
  } else if (!(typeof __RAPIER_JXL_CAPTURE_PHOTO__ !== 'undefined' && __RAPIER_JXL_CAPTURE_PHOTO__ === true) && kind === 5) {
    table.weights = quantParamTriplet(source.weights, 9, (v, i) => quantParamNumber(v, i < 6 ? 64 : 1, i < 6, library));
    table.bands4x8 = quantParamBands(source.bands4x8, library);
    table.bands4x4 = quantParamBands(source.bands4x4, library);
  } else table.bands = quantParamBands(source.bands, library);
  return table;
}

function quantParamWeight(value) {
  if (!Number.isFinite(value) || value < 1e-8 || value >= 1e8)
    throw fault('JXL_INPUT', 'Quantization weights are from 1e-8 to below 1e8.');
  return value;
}

function quantParamExpandBands(parameters) {
  const bands = [quantParamWeight(parameters[0])];
  for (let i = 1; i < parameters.length; i++) {
    const delta = parameters[i];
    bands.push(quantParamWeight(bands.at(-1) * (delta > 0 ? 1 + delta : 1 / (1 - delta))));
  }
  return bands;
}

function quantParamPower(base, exponent) {
  const log = entropyLog2(base) * exponent, whole = Math.round(log), reduced = (log - whole) * .6931471805599453;
  let term = 1, sum = 1, factor = 1;
  for (let i = 1; i < 24; i++) sum += term *= reduced / i;
  for (let i = 0; i < whole; i++) factor *= 2;
  for (let i = 0; i > whole; i--) factor /= 2;
  return sum * factor;
}

function quantParamInterpolate(bands, position) {
  if (bands.length === 1) return bands[0];
  const index = Math.min(bands.length - 2, Math.floor(position)), a = bands[index], b = bands[index + 1];
  return a * quantParamPower(b / a, position - index);
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
  if (kind === 6) return quantParamDCT(table.bands[channel], width, height);
  const plane = new Float64Array(64), weights = table.weights?.[channel];
  if (!(typeof __RAPIER_JXL_CAPTURE_PHOTO__ !== 'undefined' && __RAPIER_JXL_CAPTURE_PHOTO__ === true) && kind === 1) {
    plane.fill(weights[0]); plane[1] = plane[8] = weights[1]; plane[9] = weights[2];
  } else if (!(typeof __RAPIER_JXL_CAPTURE_PHOTO__ !== 'undefined' && __RAPIER_JXL_CAPTURE_PHOTO__ === true) && kind === 2) {
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
  } else if (kind === 4 || (typeof __RAPIER_JXL_CAPTURE_PHOTO__ !== 'undefined' && __RAPIER_JXL_CAPTURE_PHOTO__ === true)) {
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
  if (!(typeof __RAPIER_JXL_CAPTURE_PHOTO__ !== 'undefined' && __RAPIER_JXL_CAPTURE_PHOTO__ === true) && (kind === 1 || kind === 2)) for (const channel of order) for (const value of table.weights[channel]) writer.write(16, float16Bits(value / 64));
  else if (kind === 3 || kind === 4) {
    for (const channel of order) for (const value of kind === 3 ? table.multipliers[channel] : [table.multipliers[channel]]) writer.write(16, float16Bits(value));
    quantParamWriteBands(writer, table.bands, order);
  } else if (!(typeof __RAPIER_JXL_CAPTURE_PHOTO__ !== 'undefined' && __RAPIER_JXL_CAPTURE_PHOTO__ === true) && kind === 5) {
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
  return {contextMap, histograms: [{config, code}], bits: 0,
    write: (writer, context, value) => writeHybrid(writer, code, config, value)};
}
