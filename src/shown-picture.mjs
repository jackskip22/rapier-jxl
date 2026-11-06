// SPDX-License-Identifier: MIT
import {nativePicture, decodesJXL} from './native-picture.mjs';
import {fault} from './fault.mjs';
import {callers} from './v7/primitives.mjs';

const NEEDS = 'Measuring a photo here needs configureDecoder(decode) from rapier-jxl/decode, or a browser that decodes JPEG XL.';
const KEY = Symbol.for('rapier-jxl.decoder');
const setting = () => globalThis[KEY] ?? null;

export function configureDecoder(decode, restore) {
  if (decode !== null && typeof decode !== 'function')
    throw fault('JXL_INPUT', 'configureDecoder takes a decode function (rapier-jxl/decode) or null.');
  if (restore !== undefined && restore !== null && typeof restore !== 'function')
    throw fault('JXL_INPUT', 'configureDecoder takes restore from rapier-jxl/jpeg as its second argument, or nothing.');
  globalThis[KEY] = decode === null ? null : Object.freeze({decode, ...(restore && {restore})});
}

export const configuredDecoder = setting;

async function hostPicture(decode, bytes, {width, height, colorSpace, signal}) {
  if (signal?.aborted) throw signal.reason;
  const decoding = Promise.resolve().then(() => decode(bytes.slice(), {colorSpace, format: 'uint8', signal})).catch(error => { throw callers(error); });
  const picture = !signal ? await decoding : await new Promise((resolve, reject) => {
    const stop = () => reject(signal.reason);
    const settle = done => value => { signal.removeEventListener('abort', stop); done(value); };
    decoding.then(settle(resolve), settle(reject));
    signal.addEventListener('abort', stop, {once: true});
    if (signal.aborted) stop();
  });
  if (signal?.aborted) throw signal.reason;
  if (picture?.alphaPremultiplied !== undefined && picture.alphaPremultiplied !== false)
    throw fault('JXL_PLATFORM', 'The configured decoder must answer straight (unpremultiplied) alpha.');
  const data = picture?.data;
  if (!(data instanceof Uint8Array || data instanceof Uint8ClampedArray) || picture.width !== width || picture.height !== height ||
      data.length !== width * height * 4)
    throw fault('JXL_PLATFORM', 'The configured decoder must answer {data, width, height}: 8-bit straight RGBA of the whole file.');
  return {data, width, height, colorSpace, sampleFormat: 'uint', bitDepth: 8, alphaPremultiplied: false};
}

export function captureReader() {
  let chosen = null;
  return async function read(bytes, options) {
    if (!chosen) {
      if (await decodesJXL()) chosen = nativePicture;
      else {
        const host = setting()?.decode;
        if (!host) throw fault('JXL_UNSUPPORTED', NEEDS);
        chosen = (file, {width, height, colorSpace = 'srgb', signal}) => hostPicture(host, file, {width, height, colorSpace, signal});
      }
    }
    return chosen(bytes, options);
  };
}
