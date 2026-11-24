// SPDX-License-Identifier: MIT
import {header} from './inspect.mjs';
import {isDecoded} from './describe.mjs';
import {check, fail, callers, snapshotOptions} from './primitives.mjs';
import {nativePicture, decodesJXL, nativeKeeps} from '../native-picture.mjs';
import {configuredDecoder, DECODER_SNAPSHOT} from '../shown-picture.mjs';
import {ownDecoder} from './verify-own.mjs';
import {boxes} from '../container.mjs';

const SETUP = ": configureDecoder(decode, restore); decode: jpegxl/decode; restore: jpegxl/jpeg";
const NEEDS_SETUP = Symbol('setup');
const setup = what => Object.assign(fail('JXL_PLATFORM', what + SETUP), {[NEEDS_SETUP]: true});
const activeDecoder = options => options && DECODER_SNAPSHOT in options ? options[DECODER_SNAPSHOT] : configuredDecoder();
const host = (name, options) => activeDecoder(options)?.[name] ?? ownDecoder?.[name];
async function decodeWith(read, bytes, options, opened) {
  const supplied = !!activeDecoder(options)?.decode;
  const {[DECODER_SNAPSHOT]: snapshot, ...settings} = options;
  try { return await read(bytes, settings, opened); }
  catch (error) { throw supplied ? callers(error) : error; }
}

function whyHost(info, options) {
  const encoding = info.colorEncoding, alphas = info.extraChannels;
  if (options.region) return 'Banded verification';
  if (info.animation) return 'Verifying an animation';
  if (info.bitDepth.float || info.bitDepth.bits !== 8) return 'Verifying a file of more than 8 bits or float samples';
  if (encoding.wantICC || !['rgb', 'gray'].includes(encoding.space) || encoding.whitePoint !== 'd65' || !['srgb', 'display-p3'].includes(encoding.primaries) ||
      encoding.transferFunction !== 'srgb' || info.toneMapping?.intensityTarget !== 255)
    return 'Verifying a file whose color is not sRGB or Display P3';
  if (info.orientation !== 1 || alphas.length > 1 || alphas.some(c => c.type !== 0 || c.associated || c.bitDepth.float || c.bitDepth.bits !== 8 || c.dimShift))
    return 'Verifying a file with orientation or extra channels';
  if ((options.colorSpace ?? 'original') !== 'original' || options.unpremultiplyAlpha) return 'Verifying in another color space';
  return null;
}

export function shown(info, picture, native) {
  const {primaries, renderingIntent} = info.colorEncoding;
  const encoding = {space: 'rgb', whitePoint: 'd65', primaries, transferFunction: 'srgb', renderingIntent};
  return {width: picture.width, height: picture.height, data: new Uint8Array(picture.data.buffer, picture.data.byteOffset, picture.data.length),
    format: 'uint8', planes: [], extraChannels: info.extraChannels.map(channel => ({...channel})), colorEncoding: encoding, icc: null,
    rgbaColorEncoding: encoding, rgbaICC: null, duration: 0, durationSeconds: 0, alphaPremultiplied: false, orientation: 1,
    orientationApplied: false, animation: null, bitDepth: 8, sampleFormat: 'uint', colorSpace: primaries, transferFunction: 'srgb', header: info,
    ...(native === 'opaque' && {colorScope: 'opaque'})};
}
export async function nativeVerification(info,options,bitmap = false) {
  if (whyHost(info,options) || !await decodesJXL()) return false;
  const all = await nativeKeeps(), keeps = bitmap ? all.bitmap : all;
  if (info.colorEncoding.primaries === 'display-p3' && !keeps.displayP3) return false;
  if (!info.extraChannels.length) return true;
  return activeDecoder(options)?.decode ? false : keeps.alpha || 'opaque';
}
const P3_LOST = 'display-p3 verify';

export async function decodeFile(bytes, options) {
  const info = header(bytes), why = whyHost(info, options);
  if (!options.region && options.maxPixels !== undefined && info.width * info.height > options.maxPixels)
    throw fail('JXL_DIMENSIONS', `maxPixels: ${options.maxPixels} exceeded`);
  const native = await nativeVerification(info,options);
  if (native) {
    check(options.signal);
    return shown(info, await nativePicture(bytes, {width: info.width, height: info.height, colorSpace: info.colorEncoding.primaries, alpha: info.extraChannels.length > 0,
      signal: options.signal, ...(options.maxPixels !== undefined && {maxPixels: options.maxPixels})}), native);
  }
  const decode = host('decode', options);
  if (!decode) {
    const reason = why ?? (info.colorEncoding.primaries === 'display-p3' && await decodesJXL() ? P3_LOST : null);
    throw setup(reason ?? 'jxl verify');
  }
  const decoded = await decodeWith(decode, bytes.slice(), options);
  return admittedPicture(decoded,options);
}
function admittedPicture(decoded,options) {
  check(options.signal);
  if (activeDecoder(options)?.decode && decoded && typeof decoded === 'object' && !Array.isArray(decoded))
    decoded = snapshotOptions(decoded, 'Decoder result');
  if (!isDecoded(decoded)) throw fail('JXL_PLATFORM', "decoder output: use jpegxl/decode");
  return decoded;
}

const WITHOUT_NOISE = Symbol.for('rapier-jxl.verify.without-noise');
export const readsWithoutNoise = options => !!host('decode', options)?.[WITHOUT_NOISE];
export async function decodeWithoutNoise(bytes, options) {
  const decode = host('decode', options)?.[WITHOUT_NOISE];
  return decode ? admittedPicture(await decodeWith(decode, bytes.slice(), options), options) : null;
}

export async function restoreFile(bytes, options) {
  const {maxPixels, signal} = options;
  const configured = activeDecoder(options)?.restore;
  if (configured) {
    const file = bytes.slice(), settings = {maxPixels, signal};
    let restored;
    try { restored = await configured(file, settings); }
    catch (error) { throw callers(error); }
    check(signal);
    let out;
    try { out = restored?.bytes ?? restored; } catch (error) { throw callers(error); }
    if (!(out instanceof Uint8Array)) throw fail('JXL_PLATFORM', "restored jpeg: use jpegxl/jpeg");
    return out;
  }
  if (ownDecoder) return ownDecoder.restore(bytes, {maxPixels});
  throw setup('jpeg verify');
}

export async function restoredByJbrd(bytes, options) {
  const kept = [...boxes(bytes)];
  if (!kept.some(box => box.type === 0x75756964)) return null;
  const parts = kept.filter(box => box.type !== 0x75756964), out = new Uint8Array(parts.reduce((n, box) => n + box.end - box.at, kept[0].at));
  out.set(bytes.subarray(0, kept[0].at));
  let at = kept[0].at;
  for (const box of parts) { out.set(bytes.subarray(box.at, box.end), at); at += box.end - box.at; }
  return (await restoreFile(out, options))?.length ?? 0;
}

export const jpegReader = () => ownDecoder?.readJPEG;
export function jpegPixelReader(options) {
  if (ownDecoder?.readJPEGPixels) return ownDecoder.readJPEGPixels;
  const read = activeDecoder(options)?.recompress?.[Symbol.for('rapier-jxl.jpeg.pixels')];
  return typeof read === 'function'
    ? (bytes, settings) => read(bytes, {maxPixels: Math.min(settings.maxPixels, PIXELS), signal: settings.signal, scale: 8})
    : null;
}
const configuredJPEGSource = options => activeDecoder(options)?.restore?.[Symbol.for('rapier-jxl.verify.source')];
export const ownJPEGReference = options => ownDecoder !== null ||
  (typeof globalThis.createImageBitmap !== 'function' || typeof globalThis.OffscreenCanvas !== 'function') &&
  typeof configuredJPEGSource(options)?.open === 'function';
export const jpegReferenceSteps = options => ownDecoder?.readJPEGSteps?.(options) ?? configuredJPEGSource(options);
export const restorationSteps = options => activeDecoder(options)?.restore?.[Symbol.for('rapier-jxl.steps')] ?? ownDecoder?.restoreSteps;
const groups = options => host('decode', options)?.[Symbol.for('rapier-jxl.verify.groups')];
export const boundedVerification = options => !!groups(options)?.open && !!groups(options)?.region;
export const boundedWithoutNoise = options => !!groups(options)?.open && !!groups(options)?.withoutNoise;
export const BOUNDED_SETUP = 'bounded verify' + SETUP;
export const needsSetup = error => error?.[NEEDS_SETUP] === true;
export function verificationImageSteps(bytes,options) {
  const open = groups(options)?.open;
  if (!open) throw setup('bounded verify');
  return open(bytes,options);
}
export async function decodeWholeFile(bytes,options) {
  const decode = host('decode', options);
  if (!decode) throw setup('jxl verify');
  return admittedPicture(await decodeWith(decode,bytes.slice(),options),options);
}
export async function decodeGroupFile(bytes,options,opened,withoutNoise = false) {
  const region = groups(options)?.[withoutNoise ? 'withoutNoise' : 'region'];
  if (!region) throw setup('bounded verify');
  const {maxTotalSamples,...bounded} = options;
  return admittedPicture(await decodeWith(region,bytes,bounded,opened),options);
}
export const unreadBytes = (bytes, options) => host('decode', options)?.[Symbol.for('rapier-jxl.verify.unread')]?.(bytes, {maxPixels: options?.maxPixels}) ?? null;

export const isJPEG = bytes => bytes?.[0] === 255 && bytes[1] === 216;
export const displaySize = picture => picture.orientation >= 5 ? {width: picture.height, height: picture.width} : {width: picture.width, height: picture.height};
export const verifyDecodeOptions = options => ({colorSpace: 'original', applyOrientation: false, unpremultiplyAlpha: false,
  renderSpotColors: false, maxPixels: options.maxPixels, signal: options.signal,
  ...(options && DECODER_SNAPSHOT in options && {[DECODER_SNAPSHOT]: options[DECODER_SNAPSHOT]})});
