// SPDX-License-Identifier: MIT

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
  if (!parts[name]) throw Object.assign(new Error('missing part: ' + name), {code: 'JXL_PART', part: name});
  return parts[name];
}

export async function loadPart(error) {
  if (error?.code !== 'JXL_PART' || !LOADERS[error.part] || parts[error.part]) return false;
  addPart(error.part, await LOADERS[error.part]());
  return true;
}

export function frameFeatures(r, h, f) {
  if (f.flags & 19n) return part('features').readFeatures(r, h, f);
  return {patches: null, splines: null, noise: null};
}
