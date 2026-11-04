// SPDX-License-Identifier: MIT
import {fail} from './primitives.mjs';

export const DESCRIPTION = ['colorSpace','transferFunction','bitDepth','sampleFormat','intensityTarget','alphaPremultiplied',
  'icc','orientation','extraChannels'];

export function refuseDescription(options, where = 'options') {
  for (const key of DESCRIPTION) if (options?.[key] !== undefined)
    throw fail('JXL_OPTIONS', `${key} goes on the image, not the ${where}.`);
}

export function described(record) {
  const out = {};
  for (const key of DESCRIPTION) if (record[key] !== undefined) out[key] = record[key];
  return out;
}

const FORMATS = {uint8: {bitDepth: 8, sampleFormat: 'uint'}, uint16: {bitDepth: 16, sampleFormat: 'uint'},
  float32: {bitDepth: 32, sampleFormat: 'float32'}};
const SPACES = ['srgb', 'display-p3', 'rec2020'], TRANSFERS = ['srgb', 'linear', 'pq', 'hlg'];
export const isDecoded = record => !!record && typeof record === 'object' && Object.hasOwn(record, 'rgbaColorEncoding') &&
  Object.hasOwn(record, 'format') && ArrayBuffer.isView(record.data);

export function decodedFields(decoded) {
  const out = {...FORMATS[decoded.format]};
  if (decoded.rgbaICC) return out;
  const encoding = decoded.rgbaColorEncoding ?? {};
  const white = encoding.whitePoint === undefined || encoding.whitePoint === 'd65';
  const primaries = encoding.space === 'gray' ? 'srgb' : encoding.primaries;
  if (SPACES.includes(primaries) && white) out.colorSpace = primaries;
  if (TRANSFERS.includes(encoding.transferFunction)) out.transferFunction = encoding.transferFunction;
  return out;
}

const RETAGGABLE = ['colorSpace', 'transferFunction', 'bitDepth', 'sampleFormat', 'intensityTarget'];
export function decodedDescription(decoded) {
  const out = decodedFields(decoded);
  if (decoded.rgbaICC) out.icc = decoded.rgbaICC;
  else if (out.colorSpace === undefined || out.transferFunction === undefined)
    throw fail('JXL_INPUT', 'Encode cannot name this color; decode with colorSpace srgb, display-p3 or rec2020.');
  const intensity = decoded.header?.toneMapping?.intensityTarget;
  if (typeof intensity === 'number') out.intensityTarget = intensity;
  if (decoded.alphaPremultiplied) out.alphaPremultiplied = true;
  if (!decoded.orientationApplied && decoded.orientation > 1) out.orientation = decoded.orientation;
  for (const key of RETAGGABLE) if (decoded[key] !== undefined && decoded[key] !== out[key])
    throw fail('JXL_INPUT', `${key} is ${String(decoded[key])} but the samples are ${String(out[key] ?? 'unnamed')}; to retag, pass {data, width, height, ${key}}.`);
  const extra = (decoded.extraChannels ?? []).filter(channel => channel?.type !== 0);
  if (extra.length) throw fail('JXL_UNSUPPORTED', 'Encode drops extra channels beyond alpha; pass {data, width, height}, or use format({kind: \'channels\'}).');
  return out;
}

export function fromDecoded(decoded) {
  const description = decodedDescription(decoded);
  if (decoded.animation) {
    return {width: decoded.width, height: decoded.height, loops: decoded.animation.loops, ...description,
      frames: decoded.frames.map(frame => ({data: frame.data, duration: frame.durationSeconds * 1000}))};
  }
  return {data: decoded.data, width: decoded.width, height: decoded.height, ...description};
}
