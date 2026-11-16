// SPDX-License-Identifier: MIT
import {nativePicture, decodesJXL} from './native-picture.mjs';
import {fault} from './fault.mjs';
import {callers, check, snapshotOptions} from './v7/primitives.mjs';
import {nativeGammaRGBA} from './photo-output.mjs';
import {DECODER_KEY, configuredDecoder} from './decoder-setting.mjs';

const NEEDS = 'This runtime cannot read JPEG XL; call configureDecoder(decode) with decode from rapier-jxl/decode.';
const BROWSER_NEEDS = 'This browser cannot decode JPEG XL, which measuring a photo needs (effort 6 and up); use effort 5 or lower here.';
const needs = () => /^Mozilla\//.test(globalThis.navigator?.userAgent ?? '') ? BROWSER_NEEDS : NEEDS;
const unsupported = error => {
  try { return error != null && Object.getOwnPropertyDescriptor(error, 'code')?.value === 'JXL_UNSUPPORTED'; }
  catch { return false; }
};

export function configureDecoder(decode, restore, recompress) {
  if (decode !== null && typeof decode !== 'function')
    throw fault('JXL_INPUT', 'The decoder is invalid; pass decode from rapier-jxl/decode or null.');
  if (restore !== undefined && restore !== null && typeof restore !== 'function')
    throw fault('JXL_INPUT', 'The restoration callback is invalid; pass restore from rapier-jxl/jpeg or omit it.');
  if (recompress !== undefined && recompress !== null && typeof recompress !== 'function')
    throw fault('JXL_INPUT', 'The recompression callback is invalid; pass recompress from rapier-jxl/jpeg or omit it.');
  globalThis[DECODER_KEY] = decode === null && !restore && !recompress ? null : Object.freeze({...(decode && {decode}), ...(restore && {restore}), ...(recompress && {recompress})});
}

export {configuredDecoder};
export const DECODER_SNAPSHOT = Symbol.for('rapier-jxl.decoder.snapshot');

async function hostPicture(decode, bytes, {width, height, colorSpace, signal}) {
  check(signal);
  let float = colorSpace === 'srgb';
  const ask = format => {
    const file = bytes.slice(), settings = {colorSpace: format === 'float32' ? 'srgb' : colorSpace, format, signal};
    return Promise.resolve().then(() => decode(file, settings)).catch(error => { throw callers(error); });
  };
  const decoding = (float ? ask('float32').catch(error => {
    check(signal);
    if (!unsupported(error)) throw error;
    float = false; return ask('uint8');
  }) : ask('uint8')).catch(error => { throw callers(error); });
  let picture = !signal ? await decoding : await new Promise((resolve, reject) => {
    const stop = () => { try { check(signal); } catch (error) { reject(error); } };
    const settle = done => value => { signal.removeEventListener?.('abort', stop); done(value); };
    decoding.then(settle(resolve), settle(reject));
    signal.addEventListener('abort', stop, {once: true});
    if (signal.aborted) stop();
  });
  check(signal);
  if (picture && typeof picture === 'object' && !Array.isArray(picture) && !ArrayBuffer.isView(picture))
    picture = snapshotOptions(picture, 'Decoder result', ['data', 'width', 'height', 'alphaPremultiplied']);
  if (picture?.alphaPremultiplied !== undefined && picture.alphaPremultiplied !== false)
    throw fault('JXL_PLATFORM', 'The configured decoder returned premultiplied alpha; return straight RGBA samples.');
  const samples = picture?.data, n = width * height, read = {width, height, colorSpace, sampleFormat: 'uint', bitDepth: 8, alphaPremultiplied: false};
  if (!float) {
    if (!(samples instanceof Uint8Array || samples instanceof Uint8ClampedArray) || picture.width !== width || picture.height !== height ||
        samples.length !== n * 4)
      throw fault('JXL_PLATFORM', 'The configured decoder returned incomplete samples; return {data, width, height} with straight 8-bit RGBA for the whole file.');
    return {...read, data: samples};
  }
  const channels = samples instanceof Float32Array && picture.width === width && picture.height === height ? samples.length / n : 0;
  if (channels !== 3 && channels !== 4)
    throw fault('JXL_PLATFORM', 'The configured decoder returned incomplete samples; return {data, width, height} with straight float RGB or RGBA for the whole file.');
  const planes = [new Float32Array(n), new Float32Array(n), new Float32Array(n)], data = new Uint8ClampedArray(n * 4);
  for (let i = 0, at = 0; i < n; i++, at += channels) {
    for (let c = 0; c < 3; c++) { const v = samples[at + c]; planes[c][i] = v; data[i * 4 + c] = Math.round(v * 255); }
    data[i * 4 + 3] = channels === 4 ? Math.round(samples[at + 3] * 255) : 255;
  }
  const native = nativeGammaRGBA(planes, width, height);
  for (let at = 3; at < native.length; at += 4) native[at] = data[at];
  return {...read, data, native};
}

export function captureReader(snapshot = configuredDecoder()) {
  let chosen = null;
  return async function read(bytes, options) {
    if (!chosen) {
      if (await decodesJXL()) chosen = nativePicture;
      else {
        const host = snapshot?.decode;
        if (!host) throw fault('JXL_PLATFORM', needs());
        chosen = (file, {width, height, colorSpace = 'srgb', signal}) => hostPicture(host, file, {width, height, colorSpace, signal});
      }
    }
    return chosen(bytes, options);
  };
}
