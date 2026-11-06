// SPDX-License-Identifier: MIT
import {check, fail, LARGEST, JPEG_PIXELS} from './primitives.mjs';
import {copyBytes} from './bytes.mjs';
import {own} from './ownership.mjs';
import {captureFidelity} from './fidelity.mjs';
const PRESERVATION = ['jpeg-bytes', 'pixels', 'lossy'];
const isJPEG = bytes => bytes?.[0] === 255 && bytes[1] === 216;
let jpegDisplay = null;
export const useJpegDisplay = reader => { jpegDisplay = reader; };
const displaySize = picture => picture.orientation >= 5 ? {width: picture.height, height: picture.width} : {width: picture.width, height: picture.height};
export const targetMiss = message => ({code: 'JXL_TARGET', message});
function settingsOf(options) {
  const {signal, source, owned, ...given} = options;
  return {...own(given, LARGEST, Number.MAX_SAFE_INTEGER), signal};
}
function dimensionsOf(bytes, reference, options) {
  if (options.transform) return {width: options.transform.width, height: options.transform.height};
  if (Number.isSafeInteger(reference?.width) && Number.isSafeInteger(reference?.height)) return displaySize(reference);
  if (jpegDisplay && options.format === 'jpeg' && bytes) return jpegDisplay(bytes, JPEG_PIXELS);
  const original = reference instanceof Uint8Array ? reference : null;
  if (jpegDisplay && isJPEG(original)) return jpegDisplay(original, JPEG_PIXELS);
  throw fail('JXL_INTERNAL', 'The image job did not retain its admitted dimensions.');
}
function sourceOf(source) {
  if (source === undefined || source === null) return null;
  if (!source || !['bytes', 'pixels'].includes(source.kind) || typeof source.digest !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(source.digest))
    throw fail('JXL_INTERNAL', 'A supplied source identity names its byte or pixel domain and SHA-256 digest.');
  return {kind: source.kind, digest: source.digest};
}

export async function imageResultRecord(bytes, reference, options = {}, describe, fidelityOf) {
  const settings = settingsOf(options), {signal} = settings;
  check(signal);
  const missed = !(typeof __RAPIER_JXL_CAPTURE_LEAN__ !== 'undefined' && __RAPIER_JXL_CAPTURE_LEAN__) &&
    (bytes === null || Number.isFinite(settings.maxBytes) && bytes.length > settings.maxBytes);
  const fidelity = fidelityOf(settings.fidelity, missed);
  const format = typeof __RAPIER_JXL_CAPTURE_LEAN__ !== 'undefined' && __RAPIER_JXL_CAPTURE_LEAN__ ? 'jxl' : settings.format ?? 'jxl';
  if (!(typeof __RAPIER_JXL_CAPTURE_LEAN__ !== 'undefined' && __RAPIER_JXL_CAPTURE_LEAN__) && !['jxl', 'jpeg', 'png'].includes(format))
    throw fail('JXL_INTERNAL', 'An image result format is jxl, jpeg or png.');
  const size = typeof __RAPIER_JXL_CAPTURE_LEAN__ !== 'undefined' && __RAPIER_JXL_CAPTURE_LEAN__
    ? {width: reference?.width, height: reference?.height} : dimensionsOf(bytes, reference, {...settings, format});
  if (!Number.isSafeInteger(size.width) || !Number.isSafeInteger(size.height) || size.width < 1 || size.height < 1)
    throw fail('JXL_INTERNAL', 'The image job did not retain valid dimensions.');
  const source = typeof __RAPIER_JXL_CAPTURE_LEAN__ !== 'undefined' && __RAPIER_JXL_CAPTURE_LEAN__ ? null : sourceOf(options.source);
  const description = {...size, format, source, fidelity,
    ...(!(typeof __RAPIER_JXL_CAPTURE_LEAN__ !== 'undefined' && __RAPIER_JXL_CAPTURE_LEAN__) && settings.transform && {transform: {...settings.transform}}),
    ...(settings.readAs && {readAs: settings.readAs})};
  if (!(typeof __RAPIER_JXL_CAPTURE_LEAN__ !== 'undefined' && __RAPIER_JXL_CAPTURE_LEAN__) && missed)
    return {bytes: null, ...description, kept: null, fits: false, measurements: [], reason: targetMiss('No tested output met the requested byte and fidelity targets.')};
  const output = options.owned ? bytes : copyBytes(bytes);
  if (!(output instanceof Uint8Array) || !output.length) throw fail('JXL_INTERNAL', 'The encoder must return a nonempty Uint8Array.');
  const kept = settings.kept ?? (fidelity === 'exact' ? 'pixels' : 'lossy');
  if (!PRESERVATION.includes(kept)) throw fail('JXL_INTERNAL', 'The image job did not state a preservation promise.');
  const {measurements, reason: target} = describe(settings, fidelity, kept);
  const reason = fidelity === 'exact' && kept === 'lossy'
    ? targetMiss('The selected output does not promise exact preservation.') : target;
  check(signal);
  return {bytes: output, ...description, kept, fits: !reason, measurements, ...(reason && {reason})};
}

function noMeasurements(settings) {
  if (settings.measurements !== undefined && (!Array.isArray(settings.measurements) || settings.measurements.length))
    throw fail('JXL_INTERNAL', 'This operation produces no measurements.');
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
  const record = own(result, LARGEST, Number.MAX_SAFE_INTEGER);
  return {...record, bytes: record.bytes === null ? null : base64Bytes(copyBytes(record.bytes)), byteEncoding: 'base64'};
}
