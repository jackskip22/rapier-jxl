// SPDX-License-Identifier: MIT
import './engines.mjs';
import {configuredDecoder, DECODER_SNAPSHOT} from '../shown-picture.mjs';
import {own} from './ownership.mjs';
import {check, fail, declared, isCaller, object, snapshotOptions, dimensions, pixelLimit, PIXELS, admitSignal, progressOf, admitKeys} from './primitives.mjs';
import {header} from './inspect.mjs';
import {boxes, EXIF, XML, JUMBF, FTYP, LEVEL, CODESTREAM, PARTIAL} from '../container.mjs';
import {encodeFidelity} from './fidelity.mjs';
import {jpegDisplayDimensions} from './preparation-jpeg.mjs';
import {qualityTarget, measuredLook, smallPicture} from '../photo-quality-table.mjs';
import {digestBytes, identityOfSnapshot, isIdentity, isRows, snapshotSource, encodedSourceBytes} from './result-identity.mjs';
import {pixelResult, rowResult, referenceFromOriginal, searchedWithoutNoise} from './verify-pixels.mjs';
import {isImageResult} from './result-shape.mjs';
import {protectedScope} from './verify-protection.mjs';
import {restoreFile, restoredByJbrd, jpegReader, jpegPixelReader, unreadBytes, isJPEG, displaySize} from './verify-decode.mjs';
import {comparison, comparisonContext, pictureICC, conversionProfile, sameBytes as sameProfileBytes, pixelEvidence, metricSamples, measurementTarget, opaque, composedOver} from './verify-compare.mjs';
import {nativeGammaRGBA} from '../photo-output.mjs';
import {protectionDomain, protectionEvidence, noiseUnread} from './verify-pixels.mjs';
import {describedIdentity, sampleBytes} from './result-identity.mjs';
import {nativeBitmap, requirePNGReader} from './input-native.mjs';
import {nativePictureWith, NATIVE_PICTURE_OPTIONS} from '../native-picture.mjs';
import {profileTransformSteps} from '../icc-transform.mjs';
import {scaleBand, bandState, downsample, referenceArena, useReferenceArena, releaseReferenceArena} from '../ssimulacra2-arithmetic.mjs';
import {GAUSS32, scaleNorm, scoreNorms} from '../ssimulacra2.mjs';
import {s2Pad} from '../ssimulacra2-input.mjs';
import {compileKernels} from '../kernel-runtime.mjs';
import {prepareKernels, ensureKernels, orientBlock, sampleBands} from '../kernels.mjs';
import {wasmRequired} from '../capture-wasm-error.mjs';
import {sampleResizeConfig, sampleResizeStep} from '../sample-transforms.mjs';
export {configureDecoder} from '../shown-picture.mjs';

const CLAIM_SLACK = 0.1, MAX_ERROR_SLACK = 1;
const sameBytes = (a, b) => !!a && !!b && a.length === b.length && a.every((value, i) => value === b[i]);
const sameIdentity = (a, b) => a.kind === b.kind && a.digest === b.digest;
const METADATA = new Map([[EXIF, 'Exif'], [XML, 'XMP'], [JUMBF, 'JUMBF']]);
const STRUCTURE = new Set([FTYP, LEVEL, CODESTREAM, PARTIAL, 0x6a786c69]);
const fourcc = type => String.fromCharCode(type >>> 24, type >>> 16 & 255, type >>> 8 & 255, type & 255);
function metadataBoxes(bytes) {
  if (!bytes || bytes[0] !== 0 || bytes.length < 12) return [];
  return [...boxes(bytes)].filter(box => !STRUCTURE.has(box.type)).map(box => ({
    name: METADATA.has(box.decoded) ? METADATA.get(box.decoded) + ' metadata' : `a '${fourcc(box.decoded)}' box`, bytes: bytes.subarray(box.at, box.end)}));
}
function codestreamOf(bytes) {
  if (bytes[0] !== 0) return bytes;
  const parts = [...boxes(bytes)].filter(box => box.type === CODESTREAM || box.type === PARTIAL)
    .map(box => bytes.subarray(box.body + (box.type === PARTIAL ? 4 : 0), box.end));
  return parts.length === 1 ? parts[0] : Uint8Array.from(parts.flatMap(part => [...part]));
}
async function foreignContent(candidate, source, options) {
  if (unreadBytes(candidate, options) > 0) return 'bytes after its last frame';
  const carried = metadataBoxes(candidate), fields = header(candidate);
  if (!carried.length && !fields.intrinsicSize && !fields.preview) return null;
  const own = await source(), ownJXL = own && (own[0] === 255 && own[1] === 10 || own[0] === 0 && own.length >= 12);
  const ownBoxes = ownJXL ? metadataBoxes(own) : [], ownFields = ownJXL ? header(own) : {intrinsicSize: null, preview: null};
  if (carried.length && !(ownBoxes.length === carried.length && ownBoxes.every((box, i) => box.name === carried[i].name && sameBytes(box.bytes, carried[i].bytes))))
    return carried[0].name;
  if (JSON.stringify(fields.intrinsicSize) !== JSON.stringify(ownFields.intrinsicSize)) return 'an intrinsic size';
  if (fields.preview && !(ownFields.preview && sameBytes(codestreamOf(candidate), codestreamOf(own)))) return 'a preview';
  return null;
}
function settingsOf(options, result) {
  const given = snapshotOptions(options);
  admitKeys(given, ['signal', 'onProgress', 'maxPixels', 'protection']);
  admitSignal(given.signal);
  if (given.onProgress !== undefined && typeof given.onProgress !== 'function') throw fail('JXL_OPTIONS', "onProgress: function");
  const kept = result && typeof result === 'object' ? Object.getOwnPropertyDescriptor(result, 'kept')?.value : undefined;
  const maxPixels = given.maxPixels === undefined && kept === 'jpeg-bytes' ? PIXELS : pixelLimit(given.maxPixels);
  return {...given, maxPixels};
}
function protectionOf(given, result) {
  if (given === undefined) return undefined;
  const source = object(given, 'Verification protection');
  if (![Object.prototype, null].includes(Object.getPrototypeOf(source)))
    throw fail('JXL_OPTIONS', 'protection: plain object');
  const fields = Object.getOwnPropertyDescriptors(source);
  for (const key of Reflect.ownKeys(fields)) {
    if (!['exactRects', 'mask'].includes(key)) throw fail('JXL_OPTIONS', `unknown protection: ${String(key)}`);
    if (!Object.hasOwn(fields[key], 'value')) throw fail('JXL_OPTIONS', 'protection: plain values');
  }
  return protectedScope({width: result.width, height: result.height, rectangles: fields.exactRects?.value, mask: fields.mask?.value});
}
function targetOf(fidelity, measurements = [], width, height) {
  if (fidelity && typeof fidelity === 'object' && Object.keys(fidelity).length === 1 && Object.hasOwn(fidelity, 'maxError')) {
    if (!Number.isFinite(fidelity.maxError) || fidelity.maxError < 0) throw fail('JXL_OPTIONS', "maxError: finite nonnegative");
    return {fidelity: fidelity.maxError === 0 ? 'exact' : fidelity, targetOrigin: 'explicit'};
  }
  const admitted = encodeFidelity(fidelity);
  if (admitted.quality === 100) return {fidelity: 'exact', targetOrigin: 'explicit'};
  if (fidelity?.quality !== undefined) {
    const scale = measuredLook(fidelity.quality / 100);
    const measured = measurements.some(m => m.metric === 'ssimulacra2' && m.domain !== 'predicted' && m.region === undefined);
    const aimed = measurements.some(m => m.metric === 'ssimulacra2' && m.domain === 'predicted' && m.region === undefined && m.floor === scale);
    const small = Number.isFinite(width) && Number.isFinite(height) && smallPicture(width, height);
    return {fidelity, floor: measured && !small || aimed ? scale : qualityTarget(fidelity.quality), targetOrigin: 'quality-prediction'};
  }
  return {fidelity, targetOrigin: 'explicit'};
}
function refused(code, message, receipt) {
  const reason = {code, message};
  return Object.assign(fail(code, message), {verification: {...receipt, verified: false, reason}});
}

export function verify(original, output, options) {
  try {
    const decoder = configuredDecoder();
    const settings = settingsOf(options, output); check(settings.signal);
    settings[DECODER_SNAPSHOT] = decoder;
    if (isIdentity(original)) throw fail('JXL_INPUT', 'original: samples or bytes');
    const result = own(output, settings.maxPixels, Number.MAX_SAFE_INTEGER);
    if (!isImageResult(result) || result.fidelity === undefined)
      throw fail('JXL_INPUT', 'result: encode result with bytes');
    if (!result.meetsTarget) throw fail(result.reason.code, result.reason.message);
    dimensions(result.width, result.height, settings.maxPixels);
    settings.protection = protectionOf(settings.protection, result);
    const fixed = snapshotSource(original, {...settings, readAs: result?.readAs});
    return complete(fixed, result, settings).catch(error => { throw declared(error); });
  } catch (error) { return Promise.reject(declared(error)); }
}
Object.defineProperty(verify,Symbol.for('rapier-jxl.steps'),{value:Object.freeze({kind:'verify'})});
const VERIFY_TOOLS = Object.freeze({comparison, comparisonContext, pictureICC, conversionProfile, sameBytes: sameProfileBytes, pixelEvidence, metricSamples, measurementTarget, opaque, composedOver, nativeGammaRGBA,
  protectionDomain, protectionEvidence, noiseUnread, describedIdentity, sampleBytes, nativeBitmap, requirePNGReader, nativePictureWith,
  NATIVE_PICTURE_OPTIONS, profileTransformSteps, scaleBand, bandState, downsample, referenceArena, useReferenceArena, releaseReferenceArena,
  GAUSS32, scaleNorm, scoreNorms, s2Pad, compileKernels, prepareKernels, ensureKernels, orientBlock, sampleBands,
  wasmRequired, sampleResizeConfig, sampleResizeStep});
const verifySteps = (original,result,context) => {
  const options = settingsOf({maxPixels:context.maxPixels},result);
  options[DECODER_SNAPSHOT] = context && DECODER_SNAPSHOT in context ? context[DECODER_SNAPSHOT] : configuredDecoder();
  if (!isImageResult(result) || result.fidelity === undefined)
    throw fail('JXL_INPUT','result: encode result with bytes');
  if (!result.meetsTarget) throw fail(result.reason.code,result.reason.message);
  dimensions(result.width,result.height,options.maxPixels);
  return complete(original,result,options,{...context,tools:VERIFY_TOOLS}).catch(error => { throw declared(error); });
};
verifySteps.tools = VERIFY_TOOLS;
Object.defineProperty(verify,Symbol.for('rapier-jxl.verify.steps'),{value:Object.freeze(verifySteps)});
async function complete(pending, result, options, context) {
  const tell = progressOf(options.onProgress, options.signal); tell?.(0);
  const original = context ? pending : await pending; check(options.signal);
  const target = targetOf(result.fidelity, result.measurements, result.width, result.height), details = {transform: result.transform, readAs: result.readAs};
  const settings = {...options, ...details, ...target, format: result.format};
  if (options.protection) settings.protectionDigest = await options.protection.digest();
  let receipt = {verified: false, source: result.source, outputDigest: context?.outputDigest ?? await digestBytes(result.bytes), width: result.width,
    height: result.height, format: result.format, kept: result.kept, fidelity: result.fidelity,
    ...(options.protection && {protection: {digest: settings.protectionDigest, pixels: options.protection.count, exact: false}}),
    ...(result.transform && {transform: result.transform}), ...(result.readAs && {readAs: result.readAs})};
  try {
    const source = context?.sourceIdentity ?? (isRows(original) ? null : await identityOfSnapshot(original, options));
    if (source) receipt.source = source;
    if (source && result.source && !sameIdentity(source, result.source)) throw refused('JXL_INPUT', "original: source mismatch", receipt);
    tell?.(0.15);
    if (result.kept === 'jpeg-bytes') {
      if (options.protection) throw fail('JXL_UNSUPPORTED', 'protection: decoded pixels only');
      if (target.fidelity !== 'exact') throw fail('JXL_UNSUPPORTED', 'jpeg: exact only; decode pixels for lossy');
      const raw = context ? original : await encodedSourceBytes(original);
      if (!raw) throw fail('JXL_INPUT', 'original jpeg: Uint8Array');
      const compressed = result.format === 'jxl' ? result.bytes : result.format === 'jpeg' ? raw : null;
      if (!compressed || result.format === 'jxl' && !isJPEG(context ? raw.subarray(0,2) : raw)) throw fail('JXL_INPUT', 'jpeg: original and recompress result');
      check(options.signal);
      const expected = result.format === 'jxl' ? raw : result.bytes;
      let size, restoredDigest, equal;
      if (context) {
        const restored = await context.restored(compressed,expected,{...options,format:result.format},context);
        size = restored.size; restoredDigest = restored.digest; equal = restored.equal;
      } else {
        const restoring = {maxPixels: Math.min(options.maxPixels, PIXELS), signal: options.signal, ...(DECODER_SNAPSHOT in settings && {[DECODER_SNAPSHOT]: settings[DECODER_SNAPSHOT]})};
        const restored = await restoreFile(compressed, restoring);
        if (!restored) throw fail('JXL_RECONSTRUCTION', 'reconstruction: use recompress()');
        size = result.format === 'jxl' ? displaySize(header(compressed)) : jpegDisplayDimensions(result.bytes, options.maxPixels);
        restoredDigest = await digestBytes(restored); equal = sameBytes(restored,expected);
        const others = equal && result.format === 'jxl' ? await restoredByJbrd(compressed, restoring) : null;
        if (others !== null && others < expected.length) receipt.otherDecoders = {missing: expected.length - others, reason: 'past-jbrd'};
      }
      receipt = {...receipt, kind: 'jpeg-restore', restoredDigest,
        referenceDigest: result.format === 'jxl' ? receipt.source.digest : receipt.outputDigest};
      if (!equal) throw refused('JXL_RECONSTRUCTION', 'restored jpeg: mismatch; recompress', receipt);
      if (size.width !== result.width || size.height !== result.height) throw refused('JXL_DIMENSIONS', 'dimensions: result mismatch', receipt);
    } else {
      if (result.format === 'jpeg') throw fail('JXL_UNSUPPORTED', 'jpeg: recompress result');
      const carried = result.format === 'jxl' && await foreignContent(result.bytes,
        async () => context ? (ArrayBuffer.isView(original) ? original : null) : encodedSourceBytes(original), settings);
      if (carried) throw refused('JXL_TARGET', `unexpected metadata: ${carried}`, receipt);
      const proofDetails = {...(result.transform && {transform: result.transform}), ...(result.readAs && {readAs: result.readAs})};
      const needsJpegPixelFallback = candidate => {
        if (!candidate.proof.verified) return true;
        if (result.kept === 'pixels' && candidate.kept !== 'pixels') return true;
        if (candidate.proof.metric === 'ssimulacra2' && Number.isFinite(candidate.proof.score)) {
          const claim = result.measurements.reduce((most, m) => m.metric === 'ssimulacra2' && m.domain !== 'predicted' && m.region === undefined &&
            !(candidate.proof.notChecked === 'noise' && m.view === 'without-noise') ? Math.max(most, m.score) : most, -Infinity);
          if (claim > candidate.proof.score + CLAIM_SLACK) return true;
        }
        if (candidate.proof.metric === 'max-error' && Number.isFinite(candidate.proof.score)) {
          const claim = result.measurements.reduce((least, m) => m.metric === 'max-error' && m.region === undefined ? Math.min(least, m.score) : least, Infinity);
          if (claim < candidate.proof.score - MAX_ERROR_SLACK) return true;
        }
        return false;
      };
      let actual;
      if (context) {
        const callBounded = ctx => context.pixelResult(result.bytes,original,{fidelity:target.fidelity,format:result.format,
          size:{width:result.width,height:result.height},outputDigest:receipt.outputDigest,details:proofDetails,options:settings,noiseOff:searchedWithoutNoise(result)},ctx);
        const pixelRead = context.source?.kind === 'file' && settings.readAs === undefined && isJPEG(original.subarray(0,2)) ? jpegPixelReader(settings) : null;
        try {
          actual = await callBounded(context);
          if (pixelRead && needsJpegPixelFallback(actual)) {
            const altRef = await referenceFromOriginal(original, settings, pixelRead);
            const alt = await callBounded({...context, reference: altRef});
            if (!needsJpegPixelFallback(alt) || (!actual.proof.verified && alt.proof.verified)) actual = alt;
          }
        } catch (err) {
          if (pixelRead && err?.code === 'JXL_JPEG') {
            const altRef = await referenceFromOriginal(original, settings, pixelRead);
            actual = await callBounded({...context, reference: altRef});
          } else throw err;
        }
      } else if (isRows(original)) actual = await rowResult(result.bytes, original, original, {fidelity: target.fidelity, format: result.format,
        size: {width: result.width, height: result.height}, outputDigest: receipt.outputDigest, details: proofDetails, options: settings});
      else {
        const rawBytes = await encodedSourceBytes(original);
        const pixelRead = rawBytes && isJPEG(rawBytes) && settings.readAs === undefined ? jpegPixelReader(settings) : null;
        const outSize = displaySize(result.format === 'jxl' ? header(result.bytes) : result);
        const checkRef = ref => pixelResult(result.bytes, ref, {record: result, referenceIdentity: ref === original ? receipt.source : undefined,
          fidelity: target.fidelity, format: result.format, size: outSize, outputDigest: receipt.outputDigest, details: proofDetails, options: settings});
        let usedPixels = false, reference;
        try {
          reference = await referenceFromOriginal(original, settings, jpegReader());
        } catch (err) {
          if (pixelRead && err?.code === 'JXL_JPEG') {
            reference = await referenceFromOriginal(original, settings, pixelRead);
            usedPixels = true;
          } else throw err;
        }
        actual = await checkRef(reference);
        if (!usedPixels && pixelRead && jpegReader() && needsJpegPixelFallback(actual)) {
          const altRef = await referenceFromOriginal(original, settings, pixelRead);
          const alt = await checkRef(altRef);
          if (!needsJpegPixelFallback(alt) || (!actual.proof.verified && alt.proof.verified)) actual = alt;
        }
      }
      receipt = {...receipt, ...actual.proof, source: actual.source ?? receipt.source,
        ...(actual.proof.metric && {domain: 'decoded-output', targetOrigin: target.targetOrigin}),
        ...(actual.proof.metric === 'ssimulacra2' && {arithmetic: 'binary64'})};
      if (result.source && !sameIdentity(receipt.source, result.source)) throw refused('JXL_INPUT', "original: source mismatch", receipt);
      if (actual.width !== result.width || actual.height !== result.height) throw refused('JXL_DIMENSIONS', 'dimensions: result mismatch', receipt);
      if (!actual.proof.verified) throw refused(actual.reason?.code ?? 'JXL_TARGET', actual.reason?.message ?? 'fidelity: target missed; reencode', receipt);
      if (receipt.metric === 'ssimulacra2' && Number.isFinite(receipt.score)) {
        const claim = result.measurements.reduce((most, m) => m.metric === 'ssimulacra2' && m.domain !== 'predicted' && m.region === undefined &&
          !(receipt.notChecked === 'noise' && m.view === 'without-noise') ? Math.max(most, m.score) : most, -Infinity);
        if (claim > receipt.score + CLAIM_SLACK)
          throw refused('JXL_TARGET', `claimed: ${claim}; measured: ${receipt.score}`, receipt);
      }
      if (receipt.metric === 'max-error' && Number.isFinite(receipt.score)) {
        const claim = result.measurements.reduce((least, m) => m.metric === 'max-error' && m.region === undefined ? Math.min(least, m.score) : least, Infinity);
        if (claim < receipt.score - MAX_ERROR_SLACK)
          throw refused('JXL_TARGET', `claimed error: ${claim}; measured: ${receipt.score}`, receipt);
      }
      const unchecked = result.measurements.filter(m => m.region !== undefined || m.metric !== receipt.metric)
        .map(m => ({metric: m.metric, ...(m.region && {region: {...m.region}})}));
      if (unchecked.length) receipt = {...receipt, unchecked};
      if (result.kept === 'pixels' && actual.kept !== 'pixels') throw refused('JXL_TARGET', 'exact pixels: mismatch; reencode', receipt);
    }
  } catch (error) {
    check(options.signal);
    if (isCaller(error) || tell?.isCaller(error)) throw error;
    if (error?.verification) throw error;
    const named = declared(error), code = named?.code;
    if (typeof code !== 'string' || !code.startsWith('JXL_')) throw named;
    throw Object.assign(refused(code, named?.message ?? String(named), receipt), {cause: named});
  }
  check(options.signal); tell?.(1); await tell?.finish();
  return {...receipt, verified: true};
}
