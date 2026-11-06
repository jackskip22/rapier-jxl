// SPDX-License-Identifier: MIT
import {photoXYBSteps, gaborishXYB, signedRoot, XYB_TABLES} from './photo-xyb.mjs';
import {coefficientAnsSteps} from './coefficient-ans.mjs';
import {V6, GABORISH} from './photo-v6-settings.mjs';
import {float16Sample as half} from './sample-values.mjs';

const {mix: MIX, bias: BIAS, rootBias: ROOT_BIAS} = XYB_TABLES;
const MIXES = new Map([['srgb', MIX],
  ['display-p3', [0.3397908977966958, 0.5745437613923088, 0.08566534081099536, 0.2511010986273785, 0.6632335605616261, 0.08566534081099536, 0.27873014036934823, 0.1152316509458983, 0.6060382086847534]],
  ['rec2020', [0.41926114593841846, 0.5205262403311576, 0.0602126137304239, 0.29430824257431676, 0.6409641128451732, 0.06472764458050997, 0.3686815325499533, 0.03343540192120963, 0.597883065528837]]]);

export function hdrRoute(data, samples, quality) {
  if (!(quality < 100) || !samples.exponentBits || samples.transferFunction !== 'linear' || samples.alphaPremultiplied ||
      samples.icc || !MIXES.has(samples.colorSpace ?? 'srgb')) return false;
  const value = samples.exponentBits === 5 ? i => half(data[i]) : i => data[i];
  for (let i = 0; i < data.length; i++) { const v = value(i); if (!Number.isFinite(v) || (i & 3) === 3 && v !== 1) return false; }
  return true;
}

export function* hdrSteps(data, width, height, quality, effort, samples, exact) {
  const lossy = yield* hdrLossySteps(data, width, height, quality, effort, samples), native = yield* exact();
  return !lossy || native.length < lossy.length ? native : lossy;
}

export function* hdrLossySteps(data, width, height, quality, effort, samples) {
  const W = Math.ceil(width / 8) * 8, H = Math.ceil(height / 8) * 8, mix = MIXES.get(samples.colorSpace ?? 'srgb');
  const planes = [0, 1, 2].map(() => new Float64Array(W * H)), [X, Y, B] = planes;
  const value = samples.exponentBits === 5 ? i => half(data[i]) : i => data[i];
  for (let y = 0; y < height; y++) {
    const row = y * W;
    for (let x = 0, at = y * width * 4; x < width; x++, at += 4) {
      const r = value(at), g = value(at + 1), b = value(at + 2);
      const l = signedRoot(mix[0] * r + mix[1] * g + mix[2] * b + BIAS) - ROOT_BIAS;
      const m = signedRoot(mix[3] * r + mix[4] * g + mix[5] * b + BIAS) - ROOT_BIAS;
      const s = signedRoot(mix[6] * r + mix[7] * g + mix[8] * b + BIAS) - ROOT_BIAS;
      const luma = (l + m) * 127.5;
      X[row + x] = (l - m) * 127.5; Y[row + x] = luma; B[row + x] = s * 255 - luma;
    }
    for (const p of planes) p.fill(p[row + width - 1], row + width, row + W);
    if ((y & 63) === 63) yield 0;
  }
  for (const p of planes) for (let y = height; y < H; y++) p.copyWithin(y * W, (height - 1) * W, height * W);
  const options = {...V6, ...GABORISH, space: samples.colorSpace ?? 'srgb'};
  options.pre = gaborishXYB(planes, W, H, options.gaborish);
  const image = yield* photoXYBSteps(OPAQUE, width, height, quality, options);
  if (image.components.some(({coeffs}) => coeffs.some(v => v === 32767 || v === -32768))) return null;
  image.profile = {bitDepth: samples.bitDepth, exponentBits: samples.exponentBits, transferFunction: 'linear', intensityTarget: samples.intensityTarget ?? 255};
  return yield* coefficientAnsSteps(image, effort);
}
const OPAQUE = new Uint8Array([0, 0, 0, 255]);

export const HDR = Object.freeze({route: hdrRoute, steps: hdrSteps, lossy: hdrLossySteps});
