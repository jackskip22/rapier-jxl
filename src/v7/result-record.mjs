// SPDX-License-Identifier: MIT
import {check, fail, PIXELS} from './primitives.mjs';
import {copyBytes} from './bytes.mjs';
import {own} from './ownership.mjs';
import {captureFidelity} from './fidelity.mjs';
const PRESERVATION = ['jpeg-bytes', 'pixels', 'lossy'];
const isJPEG = bytes => bytes?.[0] === 255 && bytes[1] === 216;
let jpegDisplay = null;
export const useJpegDisplay = reader => { jpegDisplay = reader; };
const displaySize = picture => picture.orientation >= 5 ? {width: picture.height, height: picture.width} : {width: picture.width, height: picture.height};
export const targetMiss = message => ({code: 'JXL_TARGET', message});
export function originalByteFacts(originalBytes, bytes) {
  if (originalBytes === undefined) return {};
  if (!Number.isSafeInteger(originalBytes) || originalBytes < 1)
    throw fail('JXL_INTERNAL', 'result-record:image-3');
  return {originalBytes, ...(bytes && {largerThanOriginal: bytes.byteLength > originalBytes})};
}
function settingsOf(options) {
  const {signal, source, owned, ...given} = options;
  return {...own(given, PIXELS, Number.MAX_SAFE_INTEGER), signal};
}
function dimensionsOf(bytes, reference, options) {
  if (options.transform) return {width: options.transform.width, height: options.transform.height};
  if (Number.isSafeInteger(reference?.width) && Number.isSafeInteger(reference?.height)) return displaySize(reference);
  if (jpegDisplay && options.format === 'jpeg' && bytes) return jpegDisplay(bytes, PIXELS);
  const original = reference instanceof Uint8Array ? reference : null;
  if (jpegDisplay && isJPEG(original)) return jpegDisplay(original, PIXELS);
  throw fail('JXL_INTERNAL', 'result-record:image-1');
}
function sourceOf(source) {
  if (source === undefined || source === null) return null;
  if (!source || !['bytes', 'pixels'].includes(source.kind) || typeof source.digest !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(source.digest))
    throw fail('JXL_INTERNAL', 'result-record:source');
  return {kind: source.kind, digest: source.digest};
}

function missWords(fidelity) {
  if (fidelity === 'exact') return 'No exact file fits maxBytes; raise maxBytes or allow a lossy quality.';
  const range = fidelity?.quality;
  if (range === undefined) return 'No file fits maxBytes; raise maxBytes.';
  const min = typeof range === 'object' ? range.min : range, max = typeof range === 'object' ? range.max : range;
  const searched = min === max ? `quality ${max}` : `quality ${min} to ${max}`;
  return `No file at ${searched} fits maxBytes; raise maxBytes` + (min > 1 ? ' or lower the minimum quality.' : '.');
}
export async function imageResultRecord(bytes, reference, options = {}, describe, fidelityOf) {
  const settings = settingsOf(options), {signal} = settings;
  check(signal);
  const missed = !(typeof __RAPIER_JXL_CAPTURE_LEAN__ !== 'undefined' && __RAPIER_JXL_CAPTURE_LEAN__) &&
    (bytes === null || Number.isFinite(settings.maxBytes) && bytes.length > settings.maxBytes);
  const fidelity = fidelityOf(settings.fidelity, missed);
  const format = typeof __RAPIER_JXL_CAPTURE_LEAN__ !== 'undefined' && __RAPIER_JXL_CAPTURE_LEAN__ ? 'jxl' : settings.format ?? 'jxl';
  if (!(typeof __RAPIER_JXL_CAPTURE_LEAN__ !== 'undefined' && __RAPIER_JXL_CAPTURE_LEAN__) && !['jxl', 'jpeg', 'png'].includes(format))
    throw fail('JXL_INTERNAL', 'result-record:format');
  const size = typeof __RAPIER_JXL_CAPTURE_LEAN__ !== 'undefined' && __RAPIER_JXL_CAPTURE_LEAN__
    ? {width: reference?.width, height: reference?.height} : dimensionsOf(bytes, reference, {...settings, format});
  if (!Number.isSafeInteger(size.width) || !Number.isSafeInteger(size.height) || size.width < 1 || size.height < 1)
    throw fail('JXL_INTERNAL', 'result-record:image-2');
  const source = typeof __RAPIER_JXL_CAPTURE_LEAN__ !== 'undefined' && __RAPIER_JXL_CAPTURE_LEAN__ ? null : sourceOf(options.source);
  const originalBytes = typeof __RAPIER_JXL_CAPTURE_LEAN__ !== 'undefined' && __RAPIER_JXL_CAPTURE_LEAN__ ? undefined : settings.originalBytes;
  if (settings.lexer !== undefined && (typeof settings.lexer !== 'string' || !settings.lexer.length))
    throw fail('JXL_INTERNAL', 'result-record:lexer');
  const description = {...size, format, source, fidelity,
    ...originalByteFacts(originalBytes, missed ? null : bytes),
    ...(!(typeof __RAPIER_JXL_CAPTURE_LEAN__ !== 'undefined' && __RAPIER_JXL_CAPTURE_LEAN__) && settings.transform && {transform: {...settings.transform}}),
    ...(settings.readAs && {readAs: settings.readAs})};
  if (!(typeof __RAPIER_JXL_CAPTURE_LEAN__ !== 'undefined' && __RAPIER_JXL_CAPTURE_LEAN__) && missed)
    return {bytes: null, ...description, kept: null, meetsTarget: false, measurements: [], ...(typeof settings.usedWebGPU === 'boolean' && {usedWebGPU: settings.usedWebGPU}), reason: targetMiss(missWords(fidelity))};
  const output = options.owned ? bytes : copyBytes(bytes);
  if (!(output instanceof Uint8Array) || !output.length) throw fail('JXL_INTERNAL', 'result-record:empty');
  const kept = settings.kept ?? (fidelity === 'exact' ? 'pixels' : 'lossy');
  if (!PRESERVATION.includes(kept)) throw fail('JXL_INTERNAL', 'result-record:image-4');
  const {measurements, reason: target} = describe(settings, fidelity, kept);
  const reason = fidelity === 'exact' && kept === 'lossy'
    ? targetMiss("lossy output: does not preserve exact samples") : target;
  check(signal);
  return {bytes: output, ...description, kept, meetsTarget: !reason, measurements,
    ...(reason && {reason}), ...(settings.otherDecoders && {otherDecoders: settings.otherDecoders}),
    ...(settings.timing && {timing: settings.timing}), ...(settings.textMarks && {textMarks: settings.textMarks}),
    ...(settings.unproved && {unproved: settings.unproved.map(entry => ({...entry}))}),
    ...(typeof settings.usedWebGPU === 'boolean' && {usedWebGPU: settings.usedWebGPU}),
    ...(typeof settings.lexer === 'string' && {lexer: settings.lexer})};
}

function noMeasurements(settings) {
  if (settings.measurements !== undefined && (!Array.isArray(settings.measurements) || settings.measurements.length))
    throw fail('JXL_INTERNAL', 'result-record:measurements');
  return {measurements: []};
}
const captureResultFidelity = value => captureFidelity(value) === 0 ? 'exact' : value;
export const unmeasuredResult = (bytes, reference, options) => imageResultRecord(bytes, reference, options, noMeasurements, captureResultFidelity);

function base64Bytes(bytes) {
  const chunks = [];
  for (let start = 0; start < bytes.length; start += 12288)
    chunks.push(btoa(String.fromCharCode(...bytes.subarray(start, start + 12288))));
  return chunks.join('');
}
export function resultJSON(result) {
  const record = own(result, PIXELS, Number.MAX_SAFE_INTEGER);
  if (record === null || typeof record !== 'object') throw fail('JXL_INPUT', 'result: encode() record');
  return {...record, bytes: record.bytes === null ? null : base64Bytes(copyBytes(record.bytes)), byteEncoding: 'base64'};
}

