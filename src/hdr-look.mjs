// SPDX-License-Identifier: MIT
import {toLinearSrgb} from './xyb-space.mjs';
import {float16Sample as half} from './sample-values.mjs';
import {ssimulacra2} from './ssimulacra2.mjs';
import {captureLinearPlanes} from './capture-kernels.mjs';

const P = [0.353487901, 0.3734658629, 8.277049286e-05, 0.9062562627, 0.09150303166, 0.9099517204, 596.3148142];
const encode = nits => {
  const y = Math.pow(nits < 0.005 ? 0.005 : nits > 10000 ? 10000 : nits, P[3]);
  return P[6] * (Math.pow((P[0] + P[1] * y) / (1 + P[2] * y), P[4]) - P[5]);
};
const FLOOR = encode(0.005), WHITE = encode(203) - FLOOR;

export function pu21Levels(nits) {
  const u = Float64Array.from(nits, v => v > 0.005 ? (encode(v) - FLOOR) / WHITE : 0), [out] = captureLinearPlanes([u]);
  for (let i = 0; i < out.length; i++) if (!(nits[i] > 0.005)) out[i] = 0;
  return out;
}

export function pu21Planes(planes, count, scale = 1) {
  return planes.map(from => Float32Array.from(pu21Levels(Float64Array.from(from.subarray(0, count), v => v * scale))));
}

export function hdrSpace(samples) {
  const encoding = samples.colorEncoding;
  if (!encoding) return samples.iccGiven ? undefined : samples.colorSpace ?? 'srgb';
  if (encoding.space !== 'rgb' || samples.colorChannels === 1) return undefined;
  const primaries = encoding.primaries ?? 'srgb';
  if (typeof primaries === 'string') return ['srgb', 'display-p3', 'rec2020'].includes(primaries) && (encoding.whitePoint ?? 'd65') === 'd65' ? primaries : undefined;
  return {primaries, whitePoint: encoding.whitePoint};
}
export function hdrDomain(data, samples) {
  if (samples.native8 || samples.icc || hdrSpace(samples) === undefined) return false;
  if (!samples.exponentBits) {
    if (hdrCurve(samples) !== 'srgb' || samples.alphaPremultiplied || samples.bitDepth > 16 || (samples.colorChannels ?? 3) !== 3) return false;
    for (let i = 3; i < data.length; i += 4) if (data[i] !== 2 ** samples.bitDepth - 1) return false;
    return true;
  }
  if (hdrCurve(samples) !== 'linear') return false;
  const value = samples.exponentBits === 5 ? i => half(data[i]) : i => data[i];
  for (let i = 0; i < data.length; i++) { const v = value(i); if (!Number.isFinite(v) || (i & 3) === 3 && !(v >= 0)) return false; }
  return true;
}
export const hdrCurve = samples => samples.colorEncoding ? samples.colorEncoding.transferFunction : samples.transferFunction;
export function srgbLight(bits) {
  const top = 2 ** bits - 1, table = new Float64Array(top + 1);
  for (let v = 0; v <= top; v++) { const e = v / top; table[v] = e <= 0.04045 ? e / 12.92 : ((e + 0.055) / 1.055) ** 2.4; }
  return table;
}
export function hdrValue(data, samples) {
  const curve = samples.exponentBits ? null : srgbLight(samples.bitDepth);
  return curve ? i => curve[data[i]] : samples.exponentBits === 5 ? i => half(data[i]) : i => data[i];
}
export function hdrNits(data, samples, width, height) {
  const toSrgb = toLinearSrgb(hdrSpace(samples)), value = hdrValue(data, samples), target = samples.intensityTarget ?? 255;
  const count = width * height, nits = [0, 1, 2].map(() => new Float32Array(count));
  for (let k = 0, at = 0; k < count; k++, at += 4) {
    const u = value(at), v = value(at + 1), w = value(at + 2);
    nits[0][k] = (toSrgb[0] * u + toSrgb[1] * v + toSrgb[2] * w) * target; nits[1][k] = (toSrgb[3] * u + toSrgb[4] * v + toSrgb[5] * w) * target;
    nits[2][k] = (toSrgb[6] * u + toSrgb[7] * v + toSrgb[8] * w) * target;
  }
  return nits;
}
export function hdrViews(planes, count, opacity, scale = 1, premultiplied = false) {
  if (!opacity) return [pu21Planes(planes, count, scale)];
  return [203, 0].map(background => pu21Planes(planes.map(plane => {
    const out = new Float32Array(count);
    for (let i = 0; i < count; i++) out[i] = plane[i] * scale * (premultiplied ? 1 : opacity[i]) + background * (1 - opacity[i]);
    return out;
  }), count, 1));
}
export function hdrLook(source, output, width, height) {
  const count = width * height, alpha = hdrValue(source.data, source.samples);
  let opacity = null;
  for (let i = 0; i < count; i++) if (alpha(i * 4 + 3) !== 1) { opacity = Float32Array.from({length: count}, (_, k) => Math.min(1, alpha(k * 4 + 3))); break; }
  const references = hdrViews(hdrNits(source.data, source.samples, width, height), count, opacity, 1, !!source.samples.alphaPremultiplied);
  const outputs = hdrViews(hdrNits(output.data, output.samples, width, height), count, opacity, 1, !!output.samples.alphaPremultiplied);
  return Math.min(...references.map((reference, k) => ssimulacra2(reference, outputs[k], width, height, {wantMap: false}).score));
}
