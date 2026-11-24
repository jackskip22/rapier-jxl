// SPDX-License-Identifier: MIT
import {decodeFile, decodeWholeFile, decodeWithoutNoise, needsSetup, verifyDecodeOptions as decodeOptions, isJPEG, displaySize} from './verify-decode.mjs';
import {nativeGammaRGBA} from '../photo-output.mjs';
import {compileKernels} from '../kernel-runtime.mjs';
import {header, firstFrameNoise} from './inspect.mjs';
import {image} from './input.mjs';
import {fromDecoded, described} from './describe.mjs';
import {check, dimensions, fail} from './primitives.mjs';
import {readGifBytes} from './gif-source.mjs';
import {animationTimelinePairs} from '../animation-timeline.mjs';
import {readPNG16} from '../source.mjs';
import {orientSamples, resizeSamples} from '../sample-transforms.mjs';
import {bandRows} from './band-size.mjs';
import {identityOfSnapshot, isBlob, isIdentity, isRows, rowsIdentity, encodedSourceBytes as rawBytes} from './result-identity.mjs';
import {comparison, measurementTarget, pixelEvidence} from './verify-compare.mjs';
import {jpegPixels} from './jpeg-pixels.mjs';
const PNG = [137,80,78,71,13,10,26,10], JXL = [0,0,0,12,74,88,76,32,13,10,135,10];
const starts = (bytes, signature) => signature.every((value, i) => bytes[i] === value);
const isJXL = bytes => bytes?.[0] === 255 && bytes[1] === 10 || bytes && starts(bytes, JXL);
const unsupported = message => ({code: 'JXL_UNSUPPORTED', message});
const targetMiss = message => ({code: 'JXL_TARGET', message});
const proofKind = fidelity => fidelity === 'exact' ? 'pixels' : measurementTarget(fidelity).kind;
export function protectionDomain(scope, reference, decoded) {
  if (reference.frames || decoded.animation) throw fail('JXL_UNSUPPORTED', 'protected frames: still only');
  const orientation = picture => picture.orientationApplied ? 1 : picture.orientation ?? picture.description?.orientation ?? 1;
  if (orientation(reference) !== 1 || orientation(decoded) !== 1)
    throw fail('JXL_UNSUPPORTED', "protected coordinates: upright pictures");
  if (scope.width !== reference.width || scope.height !== reference.height || scope.width !== decoded.width || scope.height !== decoded.height)
    throw fail('JXL_DIMENSIONS', "protected dimensions: mismatch");
}
export function protectionEvidence(evidence, compared, options) {
  const scope = options.protection;
  if (!scope) return evidence;
  const exact = compared.supported && compared.protectedExact === true && compared.protectedSamples === scope.count * 4;
  return {...evidence, proof: {...evidence.proof, verified: evidence.proof.verified && exact,
    protection: {digest: options.protectionDigest, pixels: scope.count, exact}},
    ...(!exact && !evidence.reason && {reason: targetMiss('protected RGBA: mismatch or incomplete')})};
}
async function readPNG(bytes, options) {
  check(options.signal);
  if (starts(bytes, PNG) && bytes.length >= 24) {
    const size = new DataView(bytes.buffer, bytes.byteOffset + 16, 8);
    dimensions(size.getUint32(0), size.getUint32(4), options.maxPixels);
  }
  const picture = await readPNG16(bytes);
  check(options.signal); dimensions(picture.width, picture.height, options.maxPixels);
  return picture;
}
async function djxlSamples(bytes, decoded, options, read = decodeWholeFile) {
  if (decoded.animation || decoded.bitDepth !== 8 || decoded.sampleFormat !== 'uint' || decoded.colorSpace !== 'srgb' ||
      decoded.transferFunction !== 'srgb' || decoded.orientation !== 1 && !decoded.orientationApplied) return null;
  let float;
  try { float = await read(bytes, {...decodeOptions(options), colorSpace: 'srgb', format: 'float32'}); }
  catch (error) { check(options.signal); if (error?.code === 'JXL_UNSUPPORTED' || needsSetup(error)) return null; throw error; }
  const {width, height, data} = float, n = width * height, channels = data.length / n;
  if (width !== decoded.width || height !== decoded.height || !(data instanceof Float32Array) || (channels !== 3 && channels !== 4)) return null;
  const planes = [new Float32Array(n), new Float32Array(n), new Float32Array(n)];
  for (let i = 0, at = 0; i < n; i++, at += channels) for (let c = 0; c < 3; c++) planes[c][i] = data[at + c];
  await compileKernels();
  const out = nativeGammaRGBA(planes, width, height);
  for (let at = 3; at < out.length; at += 4) out[at] = decoded.data[at];
  return out;
}

export function noiseUnread(decodedEvidence) {
  const unread = {...decodedEvidence, proof: {...decodedEvidence.proof, notChecked: 'noise'}};
  if (decodedEvidence.proof.verified || decodedEvidence.reason?.code !== 'JXL_TARGET' || !Number.isFinite(decodedEvidence.proof.score)) return unread;
  return {...unread,
    reason: unsupported('noise-free read: configureDecoder(decode, restore) with decode from jpegxl/decode')};
}
export const searchedWithoutNoise = record => Array.isArray(record?.measurements) &&
  record.measurements.some(m => m.metric === 'ssimulacra2' && m.view === 'without-noise' && m.region === undefined);
async function withoutNoise(bytes, picture, decodedEvidence, compared, fidelity, options) {
  const decodedScore = decodedEvidence.proof.score, carries = firstFrameNoise(bytes);
  if (carries === false) return decodedEvidence;
  let plain = await decodeWithoutNoise(bytes, decodeOptions(options));
  if (!plain) return carries === true && compared.alphaExact ? noiseUnread(decodedEvidence) : decodedEvidence;
  const read = async (file, given) => await decodeWithoutNoise(file, given) ?? Promise.reject(fail('JXL_UNSUPPORTED', "noise-free decode: use decode from jpegxl/decode"));
  const native = await djxlSamples(bytes, plain, options, read);
  if (native) plain = {...plain, native};
  const evidence = await pixelEvidence(picture, plain, fidelity, options, compared);
  return {...evidence, proof: {...evidence.proof, view: 'without-noise', ...(Number.isFinite(decodedScore) && {decodedScore})}};
}

export async function pixelResult(bytes, picture, {record, referenceIdentity, fidelity, format, size, outputDigest, details, options}) {
  referenceIdentity ??= await identityOfSnapshot(picture, options);
  let decoded = format === 'png' ? await readPNG(bytes, options) : await decodeFile(bytes, decodeOptions(options));
  if (format === 'jxl' && !picture.frames && fidelity !== 'exact' && measurementTarget(fidelity, options).metric === 'ssimulacra2') {
    const native = await djxlSamples(bytes, decoded, options);
    if (native) decoded = {...decoded, native};
  }
  if (!picture.frames && picture.orientation > 1 && decoded.orientation === 1 && !decoded.orientationApplied)
    picture = await orientSamples(picture, options);
  if (options.protection) protectionDomain(options.protection, picture, decoded);
  if (!picture.frames && decoded.animation) throw fail('JXL_TARGET', "output: still only");
  const compared = picture.frames ? null : comparison(picture, decoded, options.protection);
  let evidence = picture.frames ? await animationEvidence(picture, decoded, fidelity, options)
    : await pixelEvidence(picture, decoded, fidelity, options, compared);
  if (format === 'jxl' && !picture.frames && searchedWithoutNoise(record) && evidence.proof.metric === 'ssimulacra2')
    evidence = await withoutNoise(bytes, picture, evidence, compared, fidelity, options);
  if (!picture.frames) evidence = protectionEvidence(evidence, compared, options);
  check(options.signal);
  return {...record, ...(format === 'png' ? displaySize(decoded) : size), kept: evidence.kept,
    proof: {...evidence.proof, outputDigest, referenceDigest: referenceIdentity.digest, ...details}, meetsTarget: evidence.proof.verified,
    ...(evidence.reason && {reason: evidence.reason})};
}

export async function rowResult(bytes, reference, original, {fidelity, format, size, outputDigest, details, options}) {
  if (options.transform) throw fail('JXL_UNSUPPORTED', 'rows: supply transformed reference');
  let compared = {exact: true, alphaExact: true, maxError: 0, supported: true,
    ...(options.protection && {protectedSamples: 0, protectedExact: true})}, unavailable;
  try { if (format !== 'jxl') throw fail('JXL_UNSUPPORTED', "banded format: jxl only"); const info = header(bytes);
    if (options.protection) protectionDomain(options.protection, reference, info);
    if (info.animation) throw fail('JXL_TARGET', "animated output: use original animation"); size = displaySize(info); }
  catch (error) { unavailable = error; }
  const referenceIdentity = await rowsIdentity(reference, {signal: options.signal, consume: async (band, y) => {
    if (unavailable) return;
    let actual;
    try {
      const maxTotalSamples = Math.min(2147483647, Math.max(1048576, reference.width * Math.max(256, bandRows(reference.width)) * 24));
      actual = await decodeFile(bytes, {...decodeOptions(options), region: {x: 0, y, width: band.width, height: band.height}, maxTotalSamples});
    } catch (error) { check(options.signal); unavailable = error; return; }
    const measured = comparison(band, actual, options.protection, y * reference.width);
    compared.exact &&= measured.exact; compared.alphaExact &&= measured.alphaExact;
    compared.maxError = Math.max(compared.maxError, measured.maxError); compared.supported &&= measured.supported;
    if (measured.colorScope) Object.assign(compared, {colorScope: measured.colorScope,
      colourSamples: (compared.colourSamples ?? 0) + measured.colourSamples, visible: Boolean(compared.visible || measured.visible)});
    if (options.protection) { compared.protectedSamples += measured.protectedSamples ?? 0; compared.protectedExact &&= measured.protectedExact === true; }
    if (measured.message) compared.message = measured.message;
  }});
  const source = original === reference ? referenceIdentity : await identityOfSnapshot(original, options);
  let evidence;
  if (unavailable) evidence = {kept: 'lossy', proof: {kind: proofKind(fidelity), verified: false},
    reason: unsupported("rows: " + unavailable.message)};
  else if (fidelity === 'exact' || measurementTarget(fidelity, options).kind === 'max-error')
    evidence = await pixelEvidence(reference, null, fidelity, options, compared);
  else evidence = {kept: 'lossy', proof: {...measurementTarget(fidelity, options), verified: false},
    reason: unsupported('perceptual score: complete still picture')};
  if (unavailable) compared.supported = false;
  evidence = protectionEvidence(evidence, compared, options);
  check(options.signal);
  return {bytes, ...size, format, kept: evidence.kept, source, proof: {...evidence.proof, outputDigest,
    referenceDigest: referenceIdentity.digest, ...details}, meetsTarget: evidence.proof.verified, fidelity,
    ...(evidence.reason && {reason: evidence.reason})};
}

async function transformed(picture, options) {
  const transform = options.transform;
  if (!transform) return picture;
  if (transform.frame !== undefined) {
    if (!Number.isSafeInteger(transform.frame) || transform.frame < 0 || !picture.frames?.[transform.frame])
      throw fail('JXL_INPUT', "animation frame: original animation required");
    picture = {width: picture.width, height: picture.height, ...described(picture), data: picture.frames[transform.frame].data};
  }
  if (picture.frames || isRows(picture)) throw fail('JXL_UNSUPPORTED', "reference transform: complete still picture");
  picture = await orientSamples(picture, options);
  return resizeSamples(picture, transform.width, transform.height, options);
}
async function nativeReference(original, options) {
  const blob = isBlob(original) ? original : new Blob([original]);
  return image(blob, {readAs: options.readAs}, {maxPixels: options.maxPixels, signal: options.signal, jpegPixels,
    deep: async () => ({readSource: readPNG16, orient: orientSamples})});
}
export async function referenceFromOriginal(original, options, readJPEG) {
  if (isIdentity(original)) throw fail('JXL_INPUT', "reference: original samples or file");
  const bytes = await rawBytes(original);
  if (!bytes) return transformed(original, options);
  let picture;
  if (starts(bytes, [71,73,70])) {
    const gif = readGifBytes(bytes, 'original.gif', options.maxPixels);
    if (gif.kind === 'animation' && options.readAs !== undefined) throw fail('JXL_OPTIONS', "readAs: not with animated GIF");
    picture = options.readAs !== undefined ? await nativeReference(original, options) : gif.kind === 'still' ? gif.picture : gif.animation;
  } else if (options.readAs !== undefined) picture = await nativeReference(original, options);
  else if (isJXL(bytes)) picture = fromDecoded(await decodeFile(bytes, decodeOptions(options)));
  else if (starts(bytes, PNG)) picture = await orientSamples(await readPNG(bytes, options), options);
  else if (isJPEG(bytes)) {
    picture = readJPEG ? await readJPEG(bytes, options) : await nativeReference(original, options);
  } else {
    try { picture = await nativeReference(original, options); }
    catch (error) {
      check(options.signal);
      if (typeof error?.code === 'string' && error.code !== 'JXL_PLATFORM') throw error;
      throw fail(error?.code ?? 'JXL_INPUT', "original bytes: raw RGBA {data, width, height}");
    }
  }
  return transformed(picture, options);
}

async function animationEvidence(reference, decoded, fidelity, options) {
  const pairs = animationTimelinePairs(reference, decoded), refused = reason => ({kept: 'lossy', proof: {kind: proofKind(fidelity), verified: false}, reason});
  let allExact = true, worst, failed, step;
  while (!(step = pairs.next()).done) {
    check(options.signal);
    const {source, output} = step.value;
    const before = {...reference, frames: undefined, data: source.data}, after = {...decoded, ...output};
    const evidence = await pixelEvidence(before, after, fidelity, options);
    allExact &&= evidence.kept === 'pixels';
    if (!evidence.proof.verified) failed ??= evidence;
    if (Number.isFinite(evidence.proof.score)) {
      const score = evidence.proof.score;
      if (!worst || (evidence.proof.metric === 'ssimulacra2' ? score < worst.proof.score : score > worst.proof.score)) worst = evidence;
    }
  }
  const failure = step.value;
  if (failure?.kind === 'empty') throw fail(failure.code, failure.message);
  if (failure) return refused(failure.kind === 'duration' ? unsupported(failure.message) : targetMiss(failure.message));
  if (failed) return worst ? {...worst, kept: allExact ? 'pixels' : 'lossy', proof: {...worst.proof, verified: false}, reason: failed.reason} : failed;
  return worst ? {...worst, kept: allExact ? 'pixels' : 'lossy'} : {kept: 'pixels', proof: {kind: 'pixels', verified: true}};
}


