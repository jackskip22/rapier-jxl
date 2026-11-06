// SPDX-License-Identifier: MIT
import {decodeFile} from './verify-decode.mjs';
import {header} from './inspect.mjs';
import {image} from './input.mjs';
import {fromDecoded, described} from './describe.mjs';
import {check, dimensions, fail} from './primitives.mjs';
import {readGifBytes} from './gif-source.mjs';
import {readPNG16} from '../source.mjs';
import {orientSamples, resizeSamples} from '../sample-transforms.mjs';
import {bandRows} from './band-size.mjs';
import {identityOfSnapshot, isBlob, isIdentity, isRows, rowsIdentity, encodedSourceBytes as rawBytes} from './result-identity.mjs';
import {comparison, measurementTarget, pixelEvidence} from './verify-compare.mjs';
const PNG = [137,80,78,71,13,10,26,10], JXL = [0,0,0,12,74,88,76,32,13,10,135,10];
const starts = (bytes, signature) => signature.every((value, i) => bytes[i] === value);
const isJPEG = bytes => bytes?.[0] === 255 && bytes[1] === 216;
const isJXL = bytes => bytes?.[0] === 255 && bytes[1] === 10 || bytes && starts(bytes, JXL);
const decodeOptions = ({signal, maxPixels}) => ({colorSpace: 'original', applyOrientation: false, unpremultiplyAlpha: false,
  renderSpotColors: false, maxPixels, signal});
const unsupported = message => ({code: 'JXL_UNSUPPORTED', message});
const targetMiss = message => ({code: 'JXL_TARGET', message});
const proofKind = fidelity => fidelity === 'exact' ? 'pixels' : measurementTarget(fidelity).kind;
const displaySize = picture => picture.orientation >= 5 ? {width: picture.height, height: picture.width}
  : {width: picture.width, height: picture.height};
function protectionDomain(scope, reference, decoded) {
  if (reference.frames || decoded.animation) throw fail('JXL_UNSUPPORTED', 'Protected samples require a still output; animation protection has no frame policy.');
  const orientation = picture => picture.orientationApplied ? 1 : picture.orientation ?? picture.description?.orientation ?? 1;
  if (orientation(reference) !== 1 || orientation(decoded) !== 1)
    throw fail('JXL_UNSUPPORTED', 'Protected output coordinates require an upright comparison canvas.');
  if (scope.width !== reference.width || scope.height !== reference.height || scope.width !== decoded.width || scope.height !== decoded.height)
    throw fail('JXL_DIMENSIONS', 'The protected scope does not match the reference and output dimensions.');
}
function protectionEvidence(evidence, compared, options) {
  const scope = options.protection;
  if (!scope) return evidence;
  const exact = compared.supported && compared.protectedExact === true && compared.protectedSamples === scope.count * 4;
  return {...evidence, proof: {...evidence.proof, verified: evidence.proof.verified && exact,
    protection: {digest: options.protectionDigest, pixels: scope.count, exact}},
    ...(!exact && !evidence.reason && {reason: targetMiss('Decoded protected RGBA samples differ or were not all compared.')})};
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
export async function pixelResult(bytes, picture, {record, referenceIdentity, fidelity, format, size, outputDigest, details, options}) {
  referenceIdentity ??= await identityOfSnapshot(picture, options);
  const decoded = format === 'png' ? await readPNG(bytes, options) : await decodeFile(bytes, decodeOptions(options));
  if (options.protection) protectionDomain(options.protection, picture, decoded);
  if (!picture.frames && decoded.animation) throw fail('JXL_TARGET', 'An animated output cannot verify a still reference.');
  const compared = picture.frames ? null : comparison(picture, decoded, options.protection);
  const evidence = picture.frames ? await animationEvidence(picture, decoded, fidelity, options)
    : protectionEvidence(await pixelEvidence(picture, decoded, fidelity, options, compared), compared, options);
  check(options.signal);
  return {...record, ...(format === 'png' ? displaySize(decoded) : size), kept: evidence.kept,
    proof: {...evidence.proof, outputDigest, referenceDigest: referenceIdentity.digest, ...details}, fits: evidence.proof.verified,
    ...(evidence.reason && {reason: evidence.reason})};
}

export async function rowResult(bytes, reference, original, {fidelity, format, size, outputDigest, details, options}) {
  if (options.transform) throw fail('JXL_UNSUPPORTED', 'Row verification does not resample the reference.');
  let compared = {exact: true, alphaExact: true, maxError: 0, supported: true,
    ...(options.protection && {protectedSamples: 0, protectedExact: true})}, unavailable;
  try { if (format !== 'jxl') throw fail('JXL_UNSUPPORTED', 'Banded verification is available for JPEG XL.'); const info = header(bytes);
    if (options.protection) protectionDomain(options.protection, reference, info);
    if (info.animation) throw fail('JXL_TARGET', 'An animated output cannot verify a row source.'); size = displaySize(info); }
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
    if (options.protection) { compared.protectedSamples += measured.protectedSamples ?? 0; compared.protectedExact &&= measured.protectedExact === true; }
    if (measured.message) compared.message = measured.message;
  }});
  const source = original === reference ? referenceIdentity : await identityOfSnapshot(original, options);
  let evidence;
  if (unavailable) evidence = {kept: 'lossy', proof: {kind: proofKind(fidelity), verified: false},
    reason: unsupported('Bounded verification is unavailable for this file: ' + unavailable.message)};
  else if (fidelity === 'exact' || measurementTarget(fidelity, options).kind === 'max-error')
    evidence = await pixelEvidence(reference, null, fidelity, options, compared);
  else evidence = {kept: 'lossy', proof: {...measurementTarget(fidelity, options), verified: false},
    reason: unsupported('The perceptual scorer has no bounded row-source proof.')};
  if (unavailable) compared.supported = false;
  evidence = protectionEvidence(evidence, compared, options);
  check(options.signal);
  return {bytes, ...size, format, kept: evidence.kept, source, proof: {...evidence.proof, outputDigest,
    referenceDigest: referenceIdentity.digest, ...details}, fits: evidence.proof.verified, fidelity,
    ...(evidence.reason && {reason: evidence.reason})};
}

async function transformed(picture, options) {
  const transform = options.transform;
  if (!transform) return picture;
  if (transform.frame !== undefined) {
    if (!Number.isSafeInteger(transform.frame) || transform.frame < 0 || !picture.frames?.[transform.frame])
      throw fail('JXL_INPUT', 'The referenced animation frame is absent.');
    picture = {width: picture.width, height: picture.height, ...described(picture), data: picture.frames[transform.frame].data};
  }
  if (picture.frames || isRows(picture)) throw fail('JXL_UNSUPPORTED', 'This reference transform requires a resident still picture.');
  return resizeSamples(await orientSamples(picture, options), transform.width, transform.height, options);
}
async function nativeReference(original, options) {
  const blob = isBlob(original) ? original : new Blob([original]);
  return image(blob, {readAs: options.readAs}, {maxPixels: options.maxPixels, signal: options.signal,
    deep: async () => ({readSource: readPNG16, orient: orientSamples})});
}
export async function referenceFromOriginal(original, options, readJPEG) {
  if (isIdentity(original)) throw fail('JXL_INPUT', 'Verification needs the original samples or file, not its identity alone.');
  const bytes = await rawBytes(original);
  if (!bytes) return transformed(original, options);
  let picture;
  if (options.readAs !== undefined) picture = await nativeReference(original, options);
  else if (isJXL(bytes)) picture = fromDecoded(await decodeFile(bytes, decodeOptions(options)));
  else if (starts(bytes, PNG)) picture = await orientSamples(await readPNG(bytes, options), options);
  else if (isJPEG(bytes)) {
    picture = readJPEG ? await readJPEG(bytes, options) : await nativeReference(original, options);
  } else if (starts(bytes, [71,73,70])) {
    const gif = readGifBytes(bytes, 'original.gif', options.maxPixels); picture = gif.kind === 'still' ? gif.picture : gif.animation;
  } else picture = await nativeReference(original, options);
  return transformed(picture, options);
}

async function animationEvidence(reference, decoded, fidelity, options) {
  if (!decoded.animation || (reference.loops ?? 0) !== decoded.animation.loops)
    return {kept: 'lossy', proof: {kind: proofKind(fidelity), verified: false}, reason: targetMiss('Animation loop count or timeline is missing.')};
  let frames = reference.frames.filter(frame => frame.duration > 0);
  if (!frames.length) frames = reference.frames.slice(-1);
  if (!frames.length || !decoded.frames?.length) throw fail('JXL_TARGET', 'The animation has no displayed frame.');
  const outputs = decoded.frames, total = frames.reduce((sum, frame) => sum + frame.duration, 0),
    actualTotal = outputs.reduce((sum, frame) => sum + frame.durationSeconds * 1000, 0);
  if (Math.abs(total - actualTotal) > 1e-6 * Math.max(frames.length, outputs.length))
    return {kept: 'lossy', proof: {kind: proofKind(fidelity), verified: false}, reason: unsupported('The animation duration was rounded; exact timeline verification is unavailable.')};
  let i = 0, j = 0, left = frames[0].duration, right = outputs[0].durationSeconds * 1000, allExact = true, worst, failed;
  while (i < frames.length && j < outputs.length) {
    check(options.signal);
    const before = {...reference, frames: undefined, data: frames[i].data}, after = {...decoded, ...outputs[j]};
    const evidence = await pixelEvidence(before, after, fidelity, options);
    allExact &&= evidence.kept === 'pixels';
    if (!evidence.proof.verified) failed ??= evidence;
    if (Number.isFinite(evidence.proof.score)) {
      const score = evidence.proof.score;
      if (!worst || (evidence.proof.metric === 'ssimulacra2' ? score < worst.proof.score : score > worst.proof.score)) worst = evidence;
    }
    const elapsed = Math.min(left, right); left -= elapsed; right -= elapsed;
    if (left <= 1e-6) { i++; if (i < frames.length) left = frames[i].duration; }
    if (right <= 1e-6) { j++; if (j < outputs.length) right = outputs[j].durationSeconds * 1000; }
  }
  if (i !== frames.length || j !== outputs.length)
    return {kept: 'lossy', proof: {kind: proofKind(fidelity), verified: false}, reason: targetMiss('The animation timeline differs from the source.')};
  if (failed) return worst ? {...worst, kept: allExact ? 'pixels' : 'lossy', proof: {...worst.proof, verified: false}, reason: failed.reason} : failed;
  return worst ? {...worst, kept: allExact ? 'pixels' : 'lossy'} : {kept: 'pixels', proof: {kind: 'pixels', verified: true}};
}


