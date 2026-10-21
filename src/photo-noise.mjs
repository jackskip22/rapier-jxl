// SPDX-License-Identifier: MIT
import {PHOTO_LIMITS, complete, scaled} from './bits.mjs';
import {job} from './admit.mjs';
import {encodePhotoSteps as plainPhotoSteps} from './photo-advanced.mjs';
import {prepareNoiseSteps} from './noise-estimation.mjs';
import {photonNoise} from './noise.mjs';

export {PHOTO_LIMITS as LIMITS, photonNoise};
export function encodePhoto(data, width, height, options) { return complete(encodePhotoSteps(data, width, height, options)); }
export function encodePhotoSteps(data, width, height, options = {}) {
  if (options === null || typeof options !== 'object') return plainPhotoSteps(data, width, height, options);
  const mode = options.noise === undefined ? 'auto' : options.noise;
  const normalized = mode === 'auto' || mode === 'off' ? false : typeof mode === 'number' ? {iso: mode} : mode;
  const cleanOptions = {...options, noise: normalized}, ordinary = plainPhotoSteps(data, width, height, cleanOptions);
  const quality = options.quality ?? 90;
  if (mode !== 'auto' || quality < 25 || quality > 52 || (options.colorSpace ?? 'srgb') !== 'srgb' ||
      (options.transferFunction ?? 'srgb') !== 'srgb' || (options.intensityTarget ?? 255) !== 255 || options.icc || options.alphaPremultiplied ||
      !(data instanceof Uint8Array || data instanceof Uint8ClampedArray)) return ordinary;
  return job(sourceGrainSteps(data, width, height, cleanOptions, ordinary));
}

function* sourceGrainSteps(data, width, height, options, ordinary) {
  const analysis = prepareNoiseSteps(data, width, height, .5);
  let next, hurry = false;
  while (!(next = analysis.next()).done) hurry = (yield next.value / 8) || hurry;
  const prepared = next.value;
  const lut = prepared.lut && Float64Array.from(prepared.lut, value => Math.round(value * .1 * 1024) / 1024);
  const encoded = lut?.some(value => value) ? plainPhotoSteps(prepared.data, width, height, {...options, noise: lut}) : ordinary;
  encoded.hurry = hurry;
  while (!(next = encoded.next()).done) {
    hurry = (yield scaled(next.value, done => .125 + .875 * done)) || hurry;
    encoded.hurry = hurry;
  }
  return next.value;
}
