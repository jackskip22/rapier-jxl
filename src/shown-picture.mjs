// SPDX-License-Identifier: MIT
import {nativePicture, decodesJXL} from './native-picture.mjs';
import {fault} from './fault.mjs';
import {callers, check, snapshotOptions} from './v7/primitives.mjs';
import {nativeGammaRGBA} from './photo-output.mjs';
import {configuredDecoder, setDecoder} from './decoder-setting.mjs';

const NEEDS = 'no JPEG XL decoder: call configureDecoder(decode) with decode from jpegxl/decode';
const BROWSER_NEEDS = 'no browser JPEG XL decode: use effort 1-5';
const needs = () => /^Mozilla\//.test(globalThis.navigator?.userAgent ?? '') ? BROWSER_NEEDS : NEEDS;
const unsupported = error => {
  try { return error != null && Object.getOwnPropertyDescriptor(error, 'code')?.value === 'JXL_UNSUPPORTED'; }
  catch { return false; }
};

export const configureDecoder = setDecoder;

export {configuredDecoder};
export const DECODER_SNAPSHOT = /* @__PURE__ */ Symbol.for('rapier-jxl.decoder.snapshot');

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
    throw fault('JXL_PLATFORM', 'decoder result: straight RGBA');
  const samples = picture?.data, n = width * height, read = {width, height, colorSpace, sampleFormat: 'uint', bitDepth: 8, alphaPremultiplied: false};
  if (!float) {
    if (!(samples instanceof Uint8Array || samples instanceof Uint8ClampedArray) || picture.width !== width || picture.height !== height ||
        samples.length !== n * 4)
      throw fault('JXL_PLATFORM', 'decoder result: {data, width, height} RGBA8');
    return {...read, data: samples};
  }
  const channels = samples instanceof Float32Array && picture.width === width && picture.height === height ? samples.length / n : 0;
  if (channels !== 3 && channels !== 4)
    throw fault('JXL_PLATFORM', 'decoder result: {data, width, height} float32');
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
