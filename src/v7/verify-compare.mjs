// SPDX-License-Identifier: MIT
import {check} from './primitives.mjs';
import {sampleDescription} from './result-identity.mjs';
import {ssimulacra2} from '../ssimulacra2.mjs';
import {compileKernels} from '../kernel-runtime.mjs';
import {linearFromTransform, P3_TRANSFORM} from '../color-transform.mjs';
import {admitSampleKind} from './verify-samples.mjs';

export const sameBytes = (a, b) => !!a && !!b && a.byteLength === b.byteLength && a.every((value, i) => value === b[i]);
const sameRecord = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const intent = value => typeof value === 'string' ? ['perceptual', 'relative', 'saturation', 'absolute'].indexOf(value) : value ?? 1;
const coordinates = value => Array.isArray(value) ? value.map(each => Array.isArray(each) ? coordinates(each) : Math.round(each * 1000000) / 1000000) : value;
function color(picture) {
  const icc = Object.hasOwn(picture, 'rgbaICC') ? picture.rgbaICC : picture.icc;
  if (icc) return {icc};
  const encoding = picture.rgbaColorEncoding ?? picture.colorEncoding;
  if (encoding) return {space: encoding.space === 'gray' ? 'rgb' : encoding.space,
    whitePoint: coordinates(encoding.whitePoint ?? 'd65'), primaries: encoding.space === 'gray' ? 'srgb' : coordinates(encoding.primaries ?? 'srgb'),
    transferFunction: encoding.gamma !== undefined ? 'gamma' : encoding.transferFunction ?? 'srgb',
    gamma: encoding.gamma === undefined ? undefined : Math.round(encoding.gamma * 10000000) / 10000000,
    renderingIntent: intent(encoding.renderingIntent)};
  const description = sampleDescription(picture);
  return {space: 'rgb', whitePoint: 'd65', primaries: description.colorSpace, transferFunction: description.transferFunction,
    gamma: undefined, renderingIntent: 1};
}
function sameMeaning(reference, decoded) {
  const a = color(reference), b = color(decoded);
  if (a.icc || b.icc) { if (!sameBytes(a.icc, b.icc)) return false; }
  else if (!sameRecord(a, b)) return false;
  const description = sampleDescription(reference);
  const target = decoded.header?.toneMapping?.intensityTarget ?? sampleDescription(decoded).intensityTarget;
  return description.intensityTarget === target && description.alphaPremultiplied === (decoded.alphaPremultiplied ?? false) &&
    description.orientation === (decoded.orientationApplied ? 1 : decoded.orientation ?? 1);
}
function half(value) {
  const sign = value & 32768 ? -1 : 1, exponent = value >>> 10 & 31, mantissa = value & 1023;
  return sign * (exponent === 0 ? mantissa * 2 ** -24 : exponent === 31 ? mantissa ? NaN : Infinity : (1024 + mantissa) * 2 ** (exponent - 25));
}
const incomparable = message => ({exact: false, alphaExact: false, maxError: Infinity, supported: false, message});
export function comparison(reference, decoded, protection, pixelOffset = 0) {
  admitSampleKind(reference.data, reference);
  admitSampleKind(decoded.data, decoded);
  if (reference.width !== decoded.width || reference.height !== decoded.height || reference.data.length !== decoded.data.length)
    return incomparable('Decoded dimensions differ from the reference.');
  if (reference.extraChannels?.length || decoded.extraChannels?.some(channel => channel.type !== 0) ||
      decoded.extraChannels?.filter(channel => channel.type === 0).length > 1)
    return incomparable('Verification of extra channels is unavailable.');
  if (!sameMeaning(reference, decoded))
    return incomparable('The decoded color, orientation, or alpha description differs from the reference.');
  const source = sampleDescription(reference), output = sampleDescription(decoded), data = reference.data, restored = decoded.data;
  const originalMax = source.sampleFormat === 'uint' ? 2 ** source.bitDepth - 1 : 1;
  const restoredMax = output.sampleFormat === 'uint' ? 2 ** output.bitDepth - 1 : 1;
  const encodedDepth = decoded.header?.bitDepth?.bits ?? output.bitDepth;
  const encodedFloat = decoded.header?.bitDepth?.float ?? (output.sampleFormat !== 'uint');
  const sameIntegerDepth = source.sampleFormat === 'uint' && output.sampleFormat === 'uint' && encodedDepth === source.bitDepth && !encodedFloat;
  let exact = true, alphaExact = true, maxError = 0, protectedSamples = 0, protectedExact = true;
  for (let i = 0; i < data.length; i++) {
    const before = source.sampleFormat === 'float16' ? half(data[i]) : data[i];
    const after = output.sampleFormat === 'float16' ? half(restored[i]) : restored[i];
    const expected = sameIntegerDepth ? Math.round(before * restoredMax / originalMax) : before;
    const actual = sameIntegerDepth ? after : after * originalMax / restoredMax;
    const equal = Object.is(expected, actual), error = Math.abs(expected - actual) * (sameIntegerDepth ? originalMax / restoredMax : 1);
    if (!equal) { exact = false; if ((i & 3) === 3) alphaExact = false; }
    if (!Number.isFinite(error)) return incomparable('Nonfinite samples have no fidelity proof.');
    if (protection?.has(pixelOffset + (i >>> 2))) { protectedSamples++; protectedExact &&= equal; }
    maxError = Math.max(maxError, error);
  }
  return {exact, alphaExact, maxError, supported: true, ...(protection && {protectedSamples, protectedExact})};
}

export function measurementTarget(fidelity, options = {}) {
  if (fidelity && typeof fidelity === 'object') {
    if (typeof fidelity.maxError === 'number') return {kind: 'max-error', metric: 'max-error', limit: fidelity.maxError};
    if (typeof fidelity.ssimulacra2 === 'number') return {kind: 'score', metric: 'ssimulacra2', floor: fidelity.ssimulacra2};
    if (typeof fidelity.butteraugli === 'number') return {kind: 'score', metric: 'butteraugli', limit: fidelity.butteraugli};
    if (typeof fidelity.butteraugli3 === 'number') return {kind: 'score', metric: 'butteraugli3', limit: fidelity.butteraugli3};
  }
  const metric = options.metric ?? 'ssimulacra2';
  return {kind: metric === 'max-error' ? 'max-error' : 'score', metric,
    ...(Number.isFinite(options.floor) && {floor: options.floor}), ...(Number.isFinite(options.limit) && {limit: options.limit})};
}
function sdrEncoding(picture) {
  const description = sampleDescription(picture), encoding = color(picture);
  if (description.sampleFormat !== 'uint' || description.bitDepth !== 8 || description.alphaPremultiplied ||
      description.intensityTarget !== 255 || encoding.icc || encoding.space !== 'rgb' || encoding.whitePoint !== 'd65' ||
      encoding.transferFunction !== 'srgb' || !['srgb', 'display-p3'].includes(encoding.primaries)) return null;
  return encoding;
}
const linearRGB = picture => linearFromTransform(picture.data, picture.width * picture.height, P3_TRANSFORM);
const unavailable = message => ({code: 'JXL_UNSUPPORTED', message});
const missed = message => ({code: 'JXL_TARGET', message});
export async function pixelEvidence(reference, decoded, fidelity, options = {}, compared = comparison(reference, decoded)) {
  check(options.signal);
  if (!compared.supported) return {kept: 'lossy', proof: {kind: fidelity === 'exact' ? 'pixels' : measurementTarget(fidelity, options).kind, verified: false},
    reason: unavailable(compared.message)};
  const kept = compared.exact ? 'pixels' : 'lossy';
  if (fidelity === 'exact') return {kept, proof: {kind: 'pixels', verified: compared.exact},
    ...(!compared.exact && {reason: missed('Decoded pixels differ from the exact reference.')})};
  const target = measurementTarget(fidelity, options);
  if (target.kind === 'max-error') {
    const verified = Number.isFinite(target.limit) && compared.maxError <= target.limit && (compared.alphaExact || options.format === 'png');
    return {kept, proof: {...target, score: compared.maxError, verified},
      ...(!verified && {reason: missed('Decoded samples exceed the maximum error or change alpha.')})};
  }
  if (target.metric !== 'ssimulacra2')
    return {kept, proof: {...target, verified: false}, reason: unavailable('This perceptual metric has no admitted scorer.')};
  const sourceEncoding = sdrEncoding(reference), outputEncoding = sdrEncoding(decoded);
  if (!sourceEncoding || !outputEncoding)
    return {kept, proof: {...target, verified: false}, reason: unavailable('The perceptual scorer covers straight 8-bit SDR sRGB and Display P3 pictures.')};
  let original = {rgba: reference.data}, restored = {rgba: decoded.data};
  if (sourceEncoding.primaries === 'display-p3') {
    original = linearRGB(reference); restored = linearRGB(decoded);
  }
  await compileKernels(); check(options.signal);
  const score = ssimulacra2(original, restored, reference.width, reference.height, {wantMap: false}).score;
  check(options.signal);
  if (!Number.isFinite(score)) return {kept, proof: {...target, verified: false}, reason: unavailable('The scorer did not produce a finite measurement.')};
  const hasBound = Number.isFinite(target.floor), verified = hasBound && score >= target.floor && compared.alphaExact;
  return {kept, proof: {...target, score, verified}, ...(!verified && {reason: hasBound
    ? missed('The measured fidelity target was missed or decoded alpha changed.')
    : unavailable('This fidelity setting has no admitted perceptual floor; the decoded score is a measurement only.')})};
}
