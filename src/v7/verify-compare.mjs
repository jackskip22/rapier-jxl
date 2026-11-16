// SPDX-License-Identifier: MIT
import {check} from './primitives.mjs';
import {sampleDescription} from './result-identity.mjs';
import {ssimulacra2} from '../ssimulacra2.mjs';
import {captureComposeOver} from '../capture-kernels.mjs';
import {compileKernels} from '../kernel-runtime.mjs';
import {linearFromTransform} from '../color-bytes.mjs';
import {P3_TRANSFORM} from '../color-transform.mjs';
import {profileTransform} from '../icc-transform.mjs';
import {lossyProfileEncoding} from './header-intent.mjs';
import {admitSampleKind} from './verify-samples.mjs';
import {admitSampleDomain} from '../sample-domain.mjs';
import {hdrDomain, hdrLook} from '../hdr-look.mjs';
import {isDecoded, decodedDescription} from './describe.mjs';

export const sameBytes = (a, b) => !!a && !!b && a.byteLength === b.byteLength && a.every((value, i) => value === b[i]);
const sameRecord = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const intent = value => typeof value === 'string' ? ['perceptual', 'relative', 'saturation', 'absolute'].indexOf(value) : value ?? 1;
const coordinates = value => Array.isArray(value) ? value.map(each => Array.isArray(each) ? coordinates(each) : Math.round(each * 1000000) / 1000000) : value;
export const pictureICC = picture => Object.hasOwn(picture, 'rgbaICC') ? picture.rgbaICC : picture.icc;
function color(picture) {
  const icc = pictureICC(picture);
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
export function conversionProfile(reference, decoded) {
  const a = color(reference), b = color(decoded);
  if (!a.icc) return null;
  if (b.icc || srgbRecord(b)) return a.icc;
  const named = lossyProfileEncoding(a.icc);
  return named && sameRecord(color({colorEncoding: named}), b) ? a.icc : null;
}
const srgbRecord = b => !b.icc && b.space === 'rgb' && b.whitePoint === 'd65' && b.primaries === 'srgb' && b.transferFunction === 'srgb';
const readable = transform => transform && (transform.gray ? {...transform, gray: false, tables: [0, 0, 0].map(() => transform.tables[0])} : transform);
function converted(reference, decoded) {
  const icc = conversionProfile(reference, decoded);
  return icc && profileTransform(icc);
}
function sameMeaning(reference, decoded, profile, equalICC) {
  const a = color(reference), b = color(decoded);
  if (b.icc || a.icc && !profile) { if (!(equalICC ?? sameBytes(a.icc, b.icc))) return false; }
  else if (!profile && !sameRecord(a, b)) return false;
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
export function comparisonContext(reference, decoded, profile = converted(reference, decoded), equalICC) {
  profile = readable(profile);
  return {profile, supported: sameMeaning(reference, decoded, profile, equalICC)};
}
export function comparison(reference, decoded, protection, pixelOffset = 0, context) {
  admitSampleKind(reference.data, reference);
  admitSampleKind(decoded.data, decoded);
  if (reference.width !== decoded.width || reference.height !== decoded.height || reference.data.length !== decoded.data.length)
    return incomparable("Output dimensions differ; use the matching reference.");
  if (reference.extraChannels?.length || decoded.extraChannels?.some(channel => channel.type !== 0) ||
      decoded.extraChannels?.filter(channel => channel.type === 0).length > 1)
    return incomparable('Verification of extra channels is unavailable.');
  const {profile, supported} = context ?? comparisonContext(reference, decoded);
  if (!supported)
    return incomparable("Output color, orientation, or alpha differs; use the matching reference.");
  const source = sampleDescription(reference), output = sampleDescription(decoded), data = reference.data, restored = decoded.data;
  const originalMax = source.sampleFormat === 'uint' ? 2 ** source.bitDepth - 1 : 1;
  const restoredMax = output.sampleFormat === 'uint' ? 2 ** output.bitDepth - 1 : 1;
  const encodedDepth = decoded.header?.bitDepth?.bits ?? output.bitDepth;
  const encodedFloat = decoded.header?.bitDepth?.float ?? (output.sampleFormat !== 'uint');
  const sameIntegerDepth = source.sampleFormat === 'uint' && output.sampleFormat === 'uint' && encodedDepth === source.bitDepth && !encodedFloat;
  let exact = true, alphaExact = true, maxError = 0, protectedSamples = 0, protectedExact = true;
  const opaque = decoded.colorScope === 'opaque';
  let colourCompared = 0, visible = false;
  for (let i = 0; i < data.length; i++) {
    if (opaque && (i & 3) === 3 && data[i] !== 0) visible = true;
    if (opaque && (i & 3) !== 3 && data[i | 3] !== originalMax) continue;
    if ((i & 3) !== 3) colourCompared++;
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
  if (profile && !pictureICC(decoded)) exact = protectedExact = false, maxError = Infinity;
  return {exact, alphaExact, maxError, supported: true, ...(profile && {profile}), ...(opaque && {colorScope: 'opaque', colourSamples: colourCompared, visible}), ...(protection && {protectedSamples, protectedExact})};
}

export function measurementTarget(fidelity, options = {}) {
  if (fidelity && typeof fidelity === 'object') {
    if (typeof fidelity.maxError === 'number') return {kind: 'max-error', metric: 'max-error', limit: fidelity.maxError};
    if (typeof fidelity.ssimulacra2 === 'number') return {kind: 'score', metric: 'ssimulacra2', floor: fidelity.ssimulacra2};
  }
  const metric = options.metric ?? 'ssimulacra2';
  return {kind: metric === 'max-error' ? 'max-error' : 'score', metric,
    ...(Number.isFinite(options.floor) && {floor: options.floor}), ...(Number.isFinite(options.limit) && {limit: options.limit})};
}
function sdrEncoding(picture, profile) {
  const description = sampleDescription(picture), encoding = color(picture);
  if (description.sampleFormat !== 'uint' || description.bitDepth !== 8 || description.alphaPremultiplied ||
      description.intensityTarget !== 255) return null;
  if (profile) return encoding;
  const srgbGamma = encoding.transferFunction === 'gamma' && encoding.primaries === 'srgb' &&
    typeof encoding.gamma === 'number' && Math.abs(encoding.gamma - 0.45455) <= 1e-4;
  if (encoding.icc || encoding.space !== 'rgb' || encoding.whitePoint !== 'd65' ||
      (encoding.transferFunction !== 'srgb' && !srgbGamma) || !['srgb', 'display-p3'].includes(encoding.primaries)) return null;
  return encoding;
}
const linearRGB = picture => linearFromTransform(picture.data, picture.width * picture.height, P3_TRANSFORM);
const unavailable = message => ({code: 'JXL_UNSUPPORTED', message});
const missed = message => ({code: 'JXL_TARGET', message});
export function metricSamples(reference,decoded,profile,sourceEncoding) {
  let original = {rgba:reference.data}, restored = {rgba:decoded.data};
  if (profile) {
    original = linearFromTransform(reference.data,reference.width * reference.height,profile);
    if (!srgbRecord(color(decoded))) restored = linearFromTransform(decoded.data,decoded.width * decoded.height,profile);
  }
  else if (sourceEncoding.primaries === 'display-p3') { original = linearRGB(reference); restored = linearRGB(decoded); }
  return [original,restored];
}
export const opaque = rgba => { for (let i = 3; i < rgba.length; i += 4) if (rgba[i] !== 255) return false; return true; };
export function composedOver(picture, background) {
  const out = new Uint8Array(picture.data);
  if (!captureComposeOver(out, picture.data, picture.width, picture.height, background))
    throw Object.assign(new Error('This verification needs WebAssembly with SIMD; use a runtime that provides it.'), {code: 'JXL_WASM'});
  return {...picture, data: out};
}
async function scorePixels(reference,decoded,profile,sourceEncoding,options,arithmetic = 'binary64') {
  await compileKernels(); check(options.signal);
  const {width,height} = reference;
  const score = (a,b) => ssimulacra2(...metricSamples(a,b,profile,sourceEncoding),width,height,{wantMap:false,arithmetic}).score;
  if (opaque(reference.data) && opaque(decoded.data)) return score(reference,decoded);
  return Math.min(...[255,0].map(background => score(composedOver(reference,background),composedOver(decoded,background))));
}
export async function pixelEvidence(reference, decoded, fidelity, options = {}, compared = comparison(reference, decoded), measure = scorePixels) {
  check(options.signal);
  if (!compared.supported) return {kept: 'lossy', proof: {kind: fidelity === 'exact' ? 'pixels' : measurementTarget(fidelity, options).kind, verified: false},
    reason: unavailable(compared.message)};
  if (compared.colorScope === 'opaque' && compared.visible && !compared.colourSamples)
    return {kept: 'lossy', proof: {kind: fidelity === 'exact' ? 'pixels' : measurementTarget(fidelity, options).kind, verified: false},
      reason: unavailable("This browser premultiplies color; call configureDecoder(decode, restore).")};
  const kept = compared.exact ? 'pixels' : 'lossy', scope = compared.colorScope && {colorScope: compared.colorScope};
  if (fidelity === 'exact') return {kept, proof: {kind: 'pixels', verified: compared.exact, ...scope},
    ...(!compared.exact && {reason: missed("Pixels differ from the reference; use an exact encoding.")})};
  const target = measurementTarget(fidelity, options);
  if (target.kind === 'max-error') {
    const verified = Number.isFinite(target.limit) && compared.maxError <= target.limit && (compared.alphaExact || options.format === 'png');
    return {kept, proof: {...target, score: compared.maxError, verified, ...scope},
      ...(!verified && {reason: missed("Samples exceed the error limit or change alpha; encode to the target.")})};
  }
  if (scope) return {kept, proof: {...target, verified: false},
    reason: unavailable("This browser premultiplies color; call configureDecoder(decode, restore).")};
  if (target.metric !== 'ssimulacra2')
    return {kept, proof: {...target, verified: false}, reason: unavailable("Unsupported fidelity metric; use quality or exact fidelity.")};
  const sourceEncoding = sdrEncoding(reference, compared.profile), outputEncoding = sdrEncoding(decoded, compared.profile);
  if (!sourceEncoding || !outputEncoding) {
    if (compared.exact && compared.alphaExact && Number.isFinite(target.floor) && target.floor <= 100) return {kept, proof: {...target, verified: true}};
    const source = hdrSamples(reference);
    if (source) {
      const output = hdrSamples(decoded);
      if (!output) return {kept, proof: {...target, verified: false}, reason: unavailable('Measuring this HDR file needs its float or 16-bit samples: configureDecoder(decode, restore) with rapier-jxl/decode.')};
      await compileKernels(); check(options.signal);
      const score = hdrLook(source, output, reference.width, reference.height);
      const verified = Number.isFinite(target.floor) && score >= target.floor && compared.alphaExact;
      return {kept, proof: {...target, score, view: 'pu21', verified}, ...(!verified && {reason: missed("Fidelity target missed or alpha changed; encode to the target.")})};
    }
    return {kept, proof: {...target, verified: false}, reason: unavailable('This picture cannot be measured by the SDR perceptual scorer; use straight 8-bit sRGB or Display P3 pixels, or verify an exact result.')};
  }
  let score = await measure(reference,decoded,compared.profile,sourceEncoding,options);
  if (decoded.native && Number.isFinite(score)) score = Math.min(score, await measure(reference,{...decoded,data: decoded.native},compared.profile,sourceEncoding,options));
  check(options.signal);
  if (!Number.isFinite(score)) return {kept, proof: {...target, verified: false}, reason: unavailable("Fidelity measurement failed; report the input.")};
  const libjxlScore = await measure(reference,decoded,compared.profile,sourceEncoding,options,'libjxl');
  check(options.signal);
  const hasBound = Number.isFinite(target.floor), verified = hasBound && score >= target.floor && compared.alphaExact;
  return {kept, proof: {...target, score, ...(Number.isFinite(libjxlScore) && {libjxlScore}), verified}, ...(!verified && {reason: hasBound
    ? missed("Fidelity target missed or alpha changed; encode to the target.")
    : unavailable("Missing fidelity target; set a quality from 1 to 100.")})};
}

function hdrSamples(picture) {
  let samples;
  try { samples = admitSampleDomain(picture.data, isDecoded(picture) ? decodedDescription(picture) : sampleDescription(picture)); } catch { return null; }
  return !picture.rgbaICC?.length && !picture.icc?.length && hdrDomain(picture.data, samples) ? {data: picture.data, samples} : null;
}
