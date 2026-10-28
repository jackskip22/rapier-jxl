// SPDX-License-Identifier: MIT
import {admitSize, fault} from './admit.mjs';
import {PHOTO_LIMITS} from './limits.mjs';

const NOISE_MAX = 1023 / 1024, PHOTON_BIAS = .0037930732552754493;
function noiseCubeRoot(value) {
  const magnitude = Math.abs(value);
  if (!magnitude) return 0;
  let root = Math.sqrt(Math.sqrt(magnitude));
  for (let i = 0; i < 10; i++) root = (2 * root + magnitude / (root * root)) / 3;
  return value < 0 ? -root : root;
}

export function photonNoise(width, height, iso = 800) {
  admitSize(width, height, PHOTO_LIMITS);
  if (!Number.isFinite(iso) || iso < 1 || iso > 1000000000) throw fault('JXL_INPUT', 'Photon noise ISO is a finite number from one through one billion.');
  const exposure = 10 / iso, area = 36000 * 24000 / (width * height), electrons18 = .2 * 11260 * exposure * area;
  const biasRoot = noiseCubeRoot(PHOTON_BIAS), norm = .22 * 1.4142135623730951 * 1.13;
  return Float64Array.from({length: 8}, (_, i) => {
    const y = i / 3 - biasRoot, linear = Math.max(0, y * y * y + PHOTON_BIAS), electrons = electrons18 * linear / .18;
    const sensorNoise = Math.sqrt(9 + electrons + .005 * .005 * electrons * electrons);
    const root = noiseCubeRoot(linear - PHOTON_BIAS), amplitude = sensorNoise * (.18 / electrons18) / (3 * root * root * norm);
    return Math.round(Math.min(NOISE_MAX, amplitude) * 1024) / 1024;
  });
}

export function admitNoise(option, width, height) {
  if (option === undefined || option === false) return null;
  if (option === 'photon') return photonNoise(width, height);
  if (option && typeof option === 'object' && !Array.isArray(option) && !ArrayBuffer.isView(option) && Object.hasOwn(option, 'iso'))
    return photonNoise(width, height, option.iso);
  if ((!Array.isArray(option) && !(option instanceof Float32Array) && !(option instanceof Float64Array)) || option.length !== 8)
    throw fault('JXL_INPUT', 'noise is false, photon, {iso}, or eight strength values from zero through 1023/1024.');
  return Float64Array.from(option, value => {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > NOISE_MAX)
      throw fault('JXL_INPUT', 'Every noise strength is finite and in [0, 1023/1024].');
    return Math.round(value * 1024) / 1024;
  });
}
