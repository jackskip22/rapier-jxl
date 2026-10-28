// SPDX-License-Identifier: MIT
import {losslessSteps} from './lossless.mjs';
import {admitOptions, admitPixels, admitSampleFormat, fault, job} from './admit.mjs';

export function admitPaintingProfile(quality, samples) {
  if (quality !== 100 || !samples.native8) throw fault('JXL_INPUT', 'The painting profile requires quality 100 and straight RGBA8 in sRGB or Display P3.');
}

export function encodePaintingSteps(data, width, height, options) {
  const {quality, colorSpace} = admitOptions(options);
  admitPixels(data, width, height);
  const samples = admitSampleFormat(data, options);
  admitPaintingProfile(quality, samples);
  return job(paintingSteps(data, width, height, {colorSpace}));
}

export function* paintingSteps(data, width, height, {colorSpace} = {}) {
  return yield* losslessSteps(data, width, height, {colorSpace});
}
