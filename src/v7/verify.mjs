// SPDX-License-Identifier: MIT
import {own} from './ownership.mjs';
import {check, fail, declared, isCaller, object, dimensions, pixelLimit, LARGEST, JPEG_PIXELS, admitSignal, progressOf} from './primitives.mjs';
import {header} from './inspect.mjs';
import {encodeFidelity} from './fidelity.mjs';
import {jpegDisplayDimensions} from './preparation-jpeg.mjs';
import {qualityTarget} from '../photo-quality-table.mjs';
import {digestBytes, identityOfSnapshot, isIdentity, isRows, snapshotSource, encodedSourceBytes} from './result-identity.mjs';
import {pixelResult, rowResult, referenceFromOriginal} from './verify-pixels.mjs';
import {isImageResult} from './result-shape.mjs';
import {protectedScope} from './verify-protection.mjs';
import {restoreFile, jpegReader} from './verify-decode.mjs';
import {comparison, comparisonContext, pictureICC, conversionProfile, sameBytes as sameProfileBytes, pixelEvidence, metricSamples} from './verify-compare.mjs';
import {protectionDomain, protectionEvidence} from './verify-pixels.mjs';
import {describedIdentity, sampleBytes} from './result-identity.mjs';
import {nativeBitmap, requirePNGReader} from './input-native.mjs';
import {nativePictureWith, NATIVE_PICTURE_OPTIONS} from '../native-picture.mjs';
import {profileTransformSteps} from '../icc-transform.mjs';
import {scaleBand, downsample, referenceArena, useReferenceArena, releaseReferenceArena} from '../ssimulacra2-arithmetic.mjs';
import {GAUSS32, scaleNorm, scoreNorms} from '../ssimulacra2.mjs';
import {s2Pad} from '../ssimulacra2-input.mjs';
import {compileKernels} from '../kernel-runtime.mjs';
import {prepareKernels, ensureKernels, orientBlock, sampleFilter, sampleSum, sampleFinish} from '../kernels.mjs';
import {wasmRequired} from '../capture-wasm-error.mjs';
import {sampleResizeConfig, sampleResizeRows, sampleResizeWeight} from '../sample-transforms.mjs';
export {configureWasm} from '../wasm-modules.mjs';
export {configureDecoder} from '../shown-picture.mjs';

const CLAIM_SLACK = 0.1, MAX_ERROR_SLACK = 1;
const sameBytes = (a, b) => !!a && !!b && a.length === b.length && a.every((value, i) => value === b[i]);
const sameIdentity = (a, b) => a.kind === b.kind && a.digest === b.digest;
const displaySize = picture => picture.orientation >= 5 ? {width: picture.height, height: picture.width} : {width: picture.width, height: picture.height};
const isJPEG = bytes => bytes?.[0] === 255 && bytes[1] === 216;
function settingsOf(options, result) {
  const given = {...object(options)};
  for (const key of Object.keys(given)) if (!['signal', 'onProgress', 'maxPixels', 'protection'].includes(key)) throw fail('JXL_OPTIONS', `Unknown verification option: ${key}.`);
  admitSignal(given.signal);
  if (given.onProgress !== undefined && typeof given.onProgress !== 'function') throw fail('JXL_OPTIONS', 'onProgress is a function.');
  const kept = result && typeof result === 'object' ? Object.getOwnPropertyDescriptor(result, 'kept')?.value : undefined;
  const maxPixels = given.maxPixels === undefined && kept === 'jpeg-bytes' ? JPEG_PIXELS : pixelLimit(given.maxPixels, LARGEST);
  return {...given, maxPixels};
}
function protectionOf(given, result) {
  if (given === undefined) return undefined;
  const source = object(given, 'Verification protection');
  if (![Object.prototype, null].includes(Object.getPrototypeOf(source)))
    throw fail('JXL_OPTIONS', 'Verification protection is a plain object.');
  const fields = Object.getOwnPropertyDescriptors(source);
  for (const key of Reflect.ownKeys(fields)) {
    if (!['exactRects', 'mask'].includes(key)) throw fail('JXL_OPTIONS', `Unknown verification protection field: ${String(key)}.`);
    if (!Object.hasOwn(fields[key], 'value')) throw fail('JXL_OPTIONS', 'Verification protection fields are plain values.');
  }
  return protectedScope({width: result.width, height: result.height, rectangles: fields.exactRects?.value, mask: fields.mask?.value});
}
function targetOf(fidelity) {
  if (fidelity && typeof fidelity === 'object' && Object.keys(fidelity).length === 1 && Object.hasOwn(fidelity, 'maxError')) {
    if (!Number.isFinite(fidelity.maxError) || fidelity.maxError < 0) throw fail('JXL_OPTIONS', 'maxError is a finite nonnegative number.');
    return {fidelity: fidelity.maxError === 0 ? 'exact' : fidelity, targetOrigin: 'explicit'};
  }
  const admitted = encodeFidelity(fidelity);
  if (admitted.quality === 100) return {fidelity: 'exact', targetOrigin: 'explicit'};
  if (fidelity?.quality !== undefined) return {fidelity, floor: qualityTarget(fidelity.quality), targetOrigin: 'quality-prediction'};
  return {fidelity, targetOrigin: 'explicit'};
}
function refused(code, message, receipt) {
  const reason = {code, message};
  return Object.assign(fail(code, message), {verification: {...receipt, verified: false, reason}});
}

export function verify(original, output, options) {
  try {
    const settings = settingsOf(options, output); check(settings.signal);
    if (isIdentity(original)) throw fail('JXL_INPUT', 'Verification needs original samples or bytes, not their identity.');
    const result = own(output, settings.maxPixels, Number.MAX_SAFE_INTEGER);
    if (!isImageResult(result) || result.fidelity === undefined)
      throw fail('JXL_INPUT', 'Verification needs an ImageResult with its fidelity, source identity, format, and preservation promise.');
    if (!result.fits) throw fail(result.reason.code, result.reason.message);
    dimensions(result.width, result.height, settings.maxPixels);
    settings.protection = protectionOf(settings.protection, result);
    const fixed = snapshotSource(original, {...settings, readAs: result?.readAs});
    return complete(fixed, result, settings).catch(error => { throw error === settings.signal?.reason ? error : declared(error); });
  } catch (error) { return Promise.reject(declared(error)); }
}
Object.defineProperty(verify,Symbol.for('rapier-jxl.steps'),{value:Object.freeze({kind:'verify'})});
const VERIFY_TOOLS = Object.freeze({comparison, comparisonContext, pictureICC, conversionProfile, sameBytes: sameProfileBytes, pixelEvidence, metricSamples,
  protectionDomain, protectionEvidence, describedIdentity, sampleBytes, nativeBitmap, requirePNGReader, nativePictureWith,
  NATIVE_PICTURE_OPTIONS, profileTransformSteps, scaleBand, downsample, referenceArena, useReferenceArena, releaseReferenceArena,
  GAUSS32, scaleNorm, scoreNorms, s2Pad, compileKernels, prepareKernels, ensureKernels, orientBlock, sampleFilter, sampleSum,
  sampleFinish, wasmRequired, sampleResizeConfig, sampleResizeRows, sampleResizeWeight});
const verifySteps = (original,result,context) => {
  const options = settingsOf({maxPixels:context.maxPixels},result);
  if (!isImageResult(result) || result.fidelity === undefined)
    throw fail('JXL_INPUT','Verification needs an ImageResult with its fidelity, source identity, format, and preservation promise.');
  if (!result.fits) throw fail(result.reason.code,result.reason.message);
  dimensions(result.width,result.height,options.maxPixels);
  return complete(original,result,options,{...context,tools:VERIFY_TOOLS}).catch(error => { throw declared(error); });
};
verifySteps.tools = VERIFY_TOOLS;
Object.defineProperty(verify,Symbol.for('rapier-jxl.verify.steps'),{value:Object.freeze(verifySteps)});
async function complete(pending, result, options, context) {
  const tell = progressOf(options.onProgress, options.signal); tell?.(0);
  const original = context ? pending : await pending; check(options.signal);
  const target = targetOf(result.fidelity), details = {transform: result.transform, readAs: result.readAs};
  const settings = {...options, ...details, ...target, format: result.format};
  if (options.protection) settings.protectionDigest = await options.protection.digest();
  let receipt = {verified: false, source: result.source, outputDigest: context?.outputDigest ?? await digestBytes(result.bytes), width: result.width,
    height: result.height, format: result.format, kept: result.kept, fidelity: result.fidelity,
    ...(options.protection && {protection: {digest: settings.protectionDigest, pixels: options.protection.count, exact: false}}),
    ...(result.transform && {transform: result.transform}), ...(result.readAs && {readAs: result.readAs})};
  try {
    const source = context?.sourceIdentity ?? (isRows(original) ? null : await identityOfSnapshot(original, options));
    if (source) receipt.source = source;
    if (source && result.source && !sameIdentity(source, result.source)) throw refused('JXL_INPUT', 'The original does not match the result source identity.', receipt);
    tell?.(0.15);
    if (result.kept === 'jpeg-bytes') {
      if (options.protection) throw fail('JXL_UNSUPPORTED', 'Protected pixel verification requires a decoded-pixel result.');
      if (target.fidelity !== 'exact') throw fail('JXL_UNSUPPORTED', 'JPEG byte restoration verifies exact preservation; a perceptual target needs decoded-pixel verification.');
      const raw = context ? original : await encodedSourceBytes(original);
      if (!raw) throw fail('JXL_INPUT', 'JPEG byte verification needs the original encoded bytes.');
      const compressed = result.format === 'jxl' ? result.bytes : result.format === 'jpeg' ? raw : null;
      if (!compressed || result.format === 'jxl' && !isJPEG(context ? raw.subarray(0,2) : raw)) throw fail('JXL_INPUT', 'JPEG byte verification compares a JPEG and its JPEG XL reconstruction.');
      check(options.signal);
      const expected = result.format === 'jxl' ? raw : result.bytes;
      let size, restoredDigest, equal;
      if (context) {
        const restored = await context.restored(compressed,expected,{...options,format:result.format},context);
        size = restored.size; restoredDigest = restored.digest; equal = restored.equal;
      } else {
        const restored = await restoreFile(compressed, {maxPixels: Math.min(options.maxPixels, JPEG_PIXELS), signal: options.signal});
        if (!restored) throw fail('JXL_RECONSTRUCTION', 'The JPEG XL file contains no JPEG reconstruction data.');
        size = result.format === 'jxl' ? displaySize(header(compressed)) : jpegDisplayDimensions(result.bytes, options.maxPixels);
        restoredDigest = await digestBytes(restored); equal = sameBytes(restored,expected);
      }
      receipt = {...receipt, kind: 'jpeg-restore', restoredDigest,
        referenceDigest: result.format === 'jxl' ? receipt.source.digest : receipt.outputDigest};
      if (!equal) throw refused('JXL_RECONSTRUCTION', 'Restored JPEG bytes differ from the original.', receipt);
      if (size.width !== result.width || size.height !== result.height) throw refused('JXL_DIMENSIONS', 'The output dimensions differ from the result record.', receipt);
    } else {
      if (result.format === 'jpeg') throw fail('JXL_UNSUPPORTED', 'JPEG verification requires a byte-restorable result.');
      const proofDetails = {...(result.transform && {transform: result.transform}), ...(result.readAs && {readAs: result.readAs})};
      let actual;
      if (context) actual = await context.pixelResult(result.bytes,original,{fidelity:target.fidelity,format:result.format,
        size:{width:result.width,height:result.height},outputDigest:receipt.outputDigest,details:proofDetails,options:settings},context);
      else if (isRows(original)) actual = await rowResult(result.bytes, original, original, {fidelity: target.fidelity, format: result.format,
        size: {width: result.width, height: result.height}, outputDigest: receipt.outputDigest, details: proofDetails, options: settings});
      else {
        const reference = await referenceFromOriginal(original, settings, jpegReader());
        actual = await pixelResult(result.bytes, reference, {record: result, referenceIdentity: reference === original ? receipt.source : undefined,
          fidelity: target.fidelity, format: result.format, size: displaySize(result.format === 'jxl' ? header(result.bytes) : result),
          outputDigest: receipt.outputDigest, details: proofDetails, options: settings});
      }
      receipt = {...receipt, ...actual.proof, source: actual.source ?? receipt.source,
        ...(actual.proof.metric && {domain: 'decoded-output', targetOrigin: target.targetOrigin})};
      if (result.source && !sameIdentity(receipt.source, result.source)) throw refused('JXL_INPUT', 'The original does not match the result source identity.', receipt);
      if (actual.width !== result.width || actual.height !== result.height) throw refused('JXL_DIMENSIONS', 'The output dimensions differ from the result record.', receipt);
      if (!actual.proof.verified) throw refused(actual.reason?.code ?? 'JXL_TARGET', actual.reason?.message ?? 'The output does not meet its fidelity target.', receipt);
      if (receipt.metric === 'ssimulacra2' && Number.isFinite(receipt.score)) {
        const claim = result.measurements.reduce((most, m) => m.metric === 'ssimulacra2' && m.region === undefined ? Math.max(most, m.score) : most, -Infinity);
        if (claim > receipt.score + CLAIM_SLACK)
          throw refused('JXL_TARGET', `The result claims a higher score than its file has: ${claim} claimed, ${receipt.score} measured.`, receipt);
      }
      if (receipt.metric === 'max-error' && Number.isFinite(receipt.score)) {
        const claim = result.measurements.reduce((least, m) => m.metric === 'max-error' && m.region === undefined ? Math.min(least, m.score) : least, Infinity);
        if (claim < receipt.score - MAX_ERROR_SLACK)
          throw refused('JXL_TARGET', `The result claims a smaller error than its file has: ${claim} claimed, ${receipt.score} measured.`, receipt);
      }
      const unchecked = result.measurements.filter(m => m.region !== undefined || m.metric !== receipt.metric)
        .map(m => ({metric: m.metric, ...(m.region && {region: {...m.region}})}));
      if (unchecked.length) receipt = {...receipt, unchecked};
      if (result.kept === 'pixels' && actual.kept !== 'pixels') throw refused('JXL_TARGET', 'Decoded pixels differ from the promised exact samples.', receipt);
    }
    check(options.signal); tell?.(1);
    return {...receipt, verified: true};
  } catch (error) {
    check(options.signal);
    if (isCaller(error)) throw error;
    if (error?.verification) throw error;
    const named = declared(error), code = typeof named?.code === 'string' && named.code.startsWith('JXL_') ? named.code : 'JXL_INPUT';
    throw Object.assign(refused(code, named?.message ?? String(named), receipt), {cause: named});
  }
}
