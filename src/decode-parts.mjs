// SPDX-License-Identifier: MIT
import {requireDecode} from './decode-bits.mjs';

const parts = {};
const LOADERS = {
  features: () => import('./decode-features.mjs'),
  icc: () => import('./decode-icc.mjs'),
  iccColor: () => import('./decode-color-icc.mjs'),
  upsample: () => import('./decode-upsample.mjs'),
  brotli: () => import('./decode-brotli.mjs'),
  transforms: () => import('./decode-modular-transforms.mjs'),
};

export function addPart(name, module) { parts[name] = module; }

export function part(name) {
  if (!parts[name]) throw Object.assign(new Error('This JPEG XL file needs the decoder part ' + name + '.'), {code: 'JXL_PART', part: name});
  return parts[name];
}

export async function loadPart(error) {
  if (error?.code !== 'JXL_PART' || !LOADERS[error.part] || parts[error.part]) return false;
  addPart(error.part, await LOADERS[error.part]());
  return true;
}

export function frameFeatures(r, h, f, options = {}) {
  if (f.flags & 19n) return part('features').readFeatures(r, h, f, options);
  const {maxFeatureBytes = 268435456, maxFeatureWork = 268435456} = options;
  requireDecode(Number.isSafeInteger(maxFeatureBytes) && maxFeatureBytes >= 0 && Number.isSafeInteger(maxFeatureWork) && maxFeatureWork >= 0,
    'Invalid JPEG XL feature resource budget.');
  return {patches: null, splines: null, noise: null};
}
