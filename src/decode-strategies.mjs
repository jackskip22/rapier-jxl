// SPDX-License-Identifier: MIT
import {quantParamNumber, quantParamInterpolate, quantParamVector, quantParamTriplet, quantParamBands, quantParamWeight, quantParamExpandBands} from './quantization-math.mjs';
import {fault} from './fault.mjs';
export {naturalOrder} from './coefficient-layout.mjs';
import {QUANT_PARAM_LIBRARY} from './decode-quant-defaults.mjs';

export {TRANSFORMS, basis, basisT, inverseScaledDCT, llfDivisors} from './vardct-bases.mjs';
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
  if (kind === 1 || kind === 2) table.weights = quantParamTriplet(source.weights, kind === 1 ? 3 : 6, v => positive(v, 64));
  else if (kind === 3) {
    table.multipliers = quantParamTriplet(source.multipliers, 2, v => positive(v));
    table.bands = quantParamBands(source.bands, library);
  } else if (kind === 4) {
    table.multipliers = quantParamVector(source.multipliers, 3, v => positive(v));
    table.bands = quantParamBands(source.bands, library);
  } else if (kind === 5) {
    table.weights = quantParamTriplet(source.weights, 9, (v, i) => quantParamNumber(v, i < 6 ? 64 : 1, i < 6, library));
    table.bands4x8 = quantParamBands(source.bands4x8, library);
    table.bands4x4 = quantParamBands(source.bands4x4, library);
  } else table.bands = quantParamBands(source.bands, library);
  return table;
}
function quantParamDCT(parameters, width, height) {
  const bands = quantParamExpandBands(parameters), scale = (bands.length - 1) / (1.4142135623730951 + .000001);
  return Float64Array.from({length: width * height}, (_, i) => {
    const x = (i % width) / (width - 1), y = Math.floor(i / width) / (height - 1);
    return quantParamInterpolate(bands, Math.sqrt(x * x + y * y) * scale);
  });
}
function quantParamMatrix(table, channel, width, height) {
  const {kind} = table;
  if (kind === 6) return quantParamDCT(table.bands[channel], width, height);
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
export function prepareQuantParams(input, width, height, family) {
  const table = quantParamAdmit(input, width, height, family);
  return {mode: table.mode, weights: [0, 1, 2].map(channel => quantParamMatrix(table, channel, width, height)), library: table.library};
}
