// SPDX-License-Identifier: MIT
import {fail, callers} from './primitives.mjs';

export const DESCRIPTION = ['colorSpace','colorEncoding','transferFunction','bitDepth','sampleFormat','intensityTarget','alphaPremultiplied',
  'icc','orientation','extraChannels'];

export function refuseDescription(options, where = 'options') {
  for (const key of DESCRIPTION) if (options?.[key] !== undefined)
    throw fail('JXL_OPTIONS', `${key}: move from ${where} to image`);
}

const INTENTS = ['perceptual', 'relative', 'saturation', 'absolute'];
function ownEncoding(e) {
  if (!e || typeof e !== 'object' || Array.isArray(e)) return e;
  const {transferFunction, primaries, ...out} = e;
  if (transferFunction !== 'gamma' || e.gamma === undefined) out.transferFunction = transferFunction;
  if (e.space !== 'gray' || primaries !== 'srgb') out.primaries = primaries;
  if (Number.isInteger(e.renderingIntent) && INTENTS[e.renderingIntent]) out.renderingIntent = INTENTS[e.renderingIntent];
  if (e.whitePoint === 'd50') out.whitePoint = [0.345669, 0.358496];
  for (const key of Object.keys(out)) if (out[key] === undefined) delete out[key];
  return out;
}

export function described(record) {
  const out = {};
  for (const key of DESCRIPTION) if (record[key] !== undefined) out[key] = record[key];
  if (out.colorEncoding) out.colorEncoding = ownEncoding(out.colorEncoding);
  return out;
}

const FORMATS = {uint8: {bitDepth: 8, sampleFormat: 'uint'}, uint16: {bitDepth: 16, sampleFormat: 'uint'},
  float32: {bitDepth: 32, sampleFormat: 'float32'}};
const formatOf = decoded => { try { return decoded.format; } catch (error) { throw callers(error); } };
const SPACES = ['srgb', 'display-p3', 'rec2020'], TRANSFERS = ['srgb', 'linear', 'pq', 'hlg'];
export const isDecoded = record => !!record && typeof record === 'object' && Object.hasOwn(record, 'rgbaColorEncoding') &&
  Object.hasOwn(record, 'format') && ArrayBuffer.isView(record.data);

export function decodedFields(decoded) {
  const out = {...FORMATS[formatOf(decoded)]};
  if (decoded.rgbaICC) return out;
  const encoding = decoded.rgbaColorEncoding ?? {};
  const white = encoding.whitePoint === undefined || encoding.whitePoint === 'd65';
  const primaries = encoding.space === 'gray' ? 'srgb' : encoding.primaries;
  if (SPACES.includes(primaries) && white) out.colorSpace = primaries;
  if (TRANSFERS.includes(encoding.transferFunction)) out.transferFunction = encoding.transferFunction;
  return out;
}

const RETAGGABLE = ['colorSpace', 'transferFunction', 'bitDepth', 'sampleFormat', 'intensityTarget'];
const same = (a, b) => a === b || JSON.stringify(a) === JSON.stringify(b);
export function decodedDescription(decoded) {
  if (!Object.hasOwn(FORMATS, formatOf(decoded))) throw fail('JXL_INPUT', "decoded format: uint8, uint16, float32");
  const out = decodedFields(decoded), header = decoded.header;
  const intensity = header?.toneMapping?.intensityTarget;
  if (typeof intensity === 'number') out.intensityTarget = intensity;
  for (const key of RETAGGABLE) if (decoded[key] !== undefined && decoded[key] !== out[key])
    throw fail('JXL_INPUT', `${key}: ${String(decoded[key])} vs ${String(out[key] ?? 'unnamed')}, use {data, width, height, ${key}}`);
  const first = decoded.frames?.[0], changed = first && ['icc', 'colorEncoding', 'alphaPremultiplied'].find(key => !same(decoded[key] ?? null, first[key] ?? null)) ||
    header && decoded.orientation !== header.orientation && 'orientation';
  if (changed) throw fail('JXL_INPUT', `${changed}: file-owned, use {data, width, height, ${changed}}`);
  const encoding = decoded.rgbaColorEncoding;
  if (decoded.rgbaICC) out.icc = decoded.rgbaICC;
  else if (out.colorSpace === undefined || out.transferFunction === undefined || encoding?.space !== 'rgb' || (encoding.renderingIntent ?? 1) !== 1) {
    if (!['rgb', 'gray'].includes(encoding?.space) || ['unknown', 'icc'].includes(encoding.transferFunction))
      throw fail('JXL_INPUT', 'colorSpace: srgb, display-p3 or rec2020');
    delete out.colorSpace; delete out.transferFunction;
    out.colorEncoding = ownEncoding(encoding);
  }
  if (decoded.alphaPremultiplied) out.alphaPremultiplied = true;
  if (!decoded.orientationApplied && decoded.orientation > 1) out.orientation = decoded.orientation;
  if (decoded.extraChannels != null && !Array.isArray(decoded.extraChannels))
    throw fail('JXL_INPUT', "extraChannels: array");
  const extra = (decoded.extraChannels ?? []).filter(channel => channel?.type !== 0);
  if (extra.length) throw fail('JXL_UNSUPPORTED', 'extraChannels: use format({kind: \'channels\'}) or pixels');
  return out;
}

export function fromDecoded(decoded) {
  const description = decodedDescription(decoded);
  if (decoded.animation) {
    if (!Array.isArray(decoded.frames)) throw fail('JXL_INPUT', "frames: array");
    for (const frame of decoded.frames) if (!frame || typeof frame !== 'object' || !ArrayBuffer.isView(frame.data) ||
        frame.data instanceof DataView || !Number.isFinite(frame.durationSeconds) || frame.durationSeconds < 0)
      throw fail('JXL_INPUT', "frame: data, durationSeconds >=0");
    return {width: decoded.width, height: decoded.height, loops: decoded.animation.loops, ...description,
      frames: decoded.frames.map(frame => ({data: frame.data, duration: frame.durationSeconds * 1000}))};
  }
  return {data: decoded.data, width: decoded.width, height: decoded.height, ...description};
}
