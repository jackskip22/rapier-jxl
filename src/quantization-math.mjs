// SPDX-License-Identifier: MIT
import {float16Bits} from './bits.mjs';
import {fault} from './fault.mjs';

export function quantParamHalfValue(bits) {
  const sign = bits & 32768 ? -1 : 1, exponent = (bits >>> 10) & 31, mantissa = bits & 1023;
  let value = exponent ? 1024 + mantissa : mantissa, shift = exponent ? exponent - 25 : -24;
  while (shift < 0) { value /= 2; shift++; }
  while (shift > 0) { value *= 2; shift--; }
  return sign * value;
}

export function quantParamNumber(value, divisor, positive, library) {
  if (typeof value !== 'number' || !Number.isFinite(value) || positive && value <= 0)
    throw fault('JXL_INPUT', 'quantization params: finite positive');
  if (library) return value;
  if (Math.abs(value / divisor) >= 65520) throw fault('JXL_INPUT', 'quantization param: overflows float16');
  const decoded = quantParamHalfValue(float16Bits(value / divisor)) * divisor;
  if (positive && decoded <= 0) throw fault('JXL_INPUT', 'quantization param: underflows float16');
  return decoded;
}

export function quantParamInterpolate(bands, position) {
  if (bands.length === 1) return bands[0];
  const index = Math.min(bands.length - 2, Math.floor(position)), a = bands[index], b = bands[index + 1];
  return a * Math.pow(b / a, position - index);
}

export function quantParamVector(value, count, convert) {
  if ((!Array.isArray(value) && !ArrayBuffer.isView(value)) || value.length !== count)
    throw fault('JXL_INPUT', 'quantization vector length');
  return Array.from(value, convert);
}

export function quantParamTriplet(value, count, convert) {
  if (!Array.isArray(value) || value.length !== 3)
    throw fault('JXL_INPUT', 'quantization params: 3 vectors');
  return value.map(vector => quantParamVector(vector, count, convert));
}

export function quantParamBands(value, library) {
  const count = value?.[0]?.length;
  if (!Number.isInteger(count) || count < 1 || count > 16)
    throw fault('JXL_INPUT', 'bands: 1-16 per channel');
  return quantParamTriplet(value, count, (v, i) => quantParamNumber(v, i ? 1 : 64, !i, library));
}

export function quantParamWeight(value) {
  if (!Number.isFinite(value) || value < 1e-8 || value >= 1e8)
    throw fault('JXL_INPUT', 'weights: 1e-8 to 1e8');
  return value;
}

export function quantParamExpandBands(parameters) {
  const bands = [quantParamWeight(parameters[0])];
  for (let i = 1; i < parameters.length; i++) {
    const delta = parameters[i];
    bands.push(quantParamWeight(bands.at(-1) * (delta > 0 ? 1 + delta : 1 / (1 - delta))));
  }
  return bands;
}
