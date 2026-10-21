// SPDX-License-Identifier: MIT
import {PHOTO_LIMITS, complete, part} from './bits.mjs';
import {admitOptions, admitPixels, admitSampleFormat, fault, job} from './admit.mjs';
import {admitEffort} from './effort-level.mjs';
import {losslessSteps, nativeSteps} from './lossless.mjs';
import {varDCTSteps} from './vardct.mjs';
import {strategyCoefficientSteps, admitStrategyOptions, TRANSFORMS} from './vardct-strategies.mjs';
import {buildAnsCoding, writeModularAnsHistograms} from './ans.mjs';
import {progressivePasses} from './vardct-progressive.mjs';
import {admitNoise, photonNoise} from './noise.mjs';
import {photoCoefficientSteps} from './photo-dct.mjs';
import {photoXYBSteps, preferXYB} from './photo-xyb.mjs';
import {admitPhotoFilter} from './photo-job.mjs';
import {coefficientEffortSteps} from './coefficient-effort.mjs';
import {coefficientAnsSteps} from './coefficient-ans.mjs';
import {admitLFFrames, lfFrameSteps, prependLFFrames} from './lf-frames.mjs';
import {padPhotoTiles, cropPhotoCanvas, photoLevelContainer} from './photo-crop.mjs';
import {readImageHeader} from './framing.mjs';
import {quantParamCoding} from './quantization-params.mjs';

export {TRANSFORMS, photonNoise};
export {PHOTO_LIMITS as LIMITS};
export function encodePhoto(data, width, height, options) { return complete(encodePhotoSteps(data, width, height, options)); }
export function encodePhotoSteps(data, width, height, options = {}) {
  const {quality, colorSpace} = admitOptions(options, 90), effort = admitEffort(options);
  admitPixels(data, width, height, PHOTO_LIMITS);
  const samples = admitSampleFormat(data, options), progression = progressivePasses(options.progressive), noiseLut = admitNoise(options.noise, width, height);
  const lfLevels = admitLFFrames(options.lfFrames);
  const strategyOptions = admitStrategyOptions(options), filter = admitPhotoFilter(options);
  if (!samples.native8 && quality < 100 && (strategyOptions.variable || progression || noiseLut || lfLevels))
    throw fault('JXL_INPUT', 'Advanced VarDCT transforms require eight-bit RGB samples with sRGB transfer.');
  if (quality < 100 && lfLevels) {
    if (colorSpace !== 'srgb') throw fault('JXL_INPUT', 'Low-frequency frame pyramids currently require sRGB photographic pixels.');
  }
  return job(steps(data, width, height, {quality, colorSpace, effort, samples, options, progression, noiseLut, strategyOptions, filter, lfLevels}));
}

function* steps(data, width, height, {quality, colorSpace, effort, samples, options, progression, noiseLut, strategyOptions, filter, lfLevels}) {
  if (!samples.native8) return yield* nativeSteps(data, width, height, {quality, samples, effort});
  if (quality >= 100) return yield* losslessSteps(data, width, height, {colorSpace});
  const originalWidth = width, originalHeight = height, padded = noiseLut && padPhotoTiles(data, width, height);
  if (padded) ({data, width, height} = padded);
  const variable = strategyOptions.variable;
  let frames;
  const finish = bytes => {
    if (frames) bytes = prependLFFrames(bytes, frames);
    if (variable && bytes[0] === 255 && !readImageHeader(bytes).modular16) bytes = photoLevelContainer(bytes, 10);
    return padded ? cropPhotoCanvas(bytes, originalWidth, originalHeight) : bytes;
  };
  const producer = variable ? strategyCoefficientSteps(data, width, height, quality, colorSpace, options, strategyOptions) :
    colorSpace === 'srgb' && (lfLevels || noiseLut || preferXYB(data, width, height)) ? photoXYBSteps(data, width, height, quality, {filter}) :
    photoCoefficientSteps(data, width, height, quality, colorSpace);
  const image = yield* part(producer, 0, lfLevels ? 3 : 2);
  image.orientation = options.orientation ?? 1;
  image.progression = progression;
  image.noiseLut = noiseLut;
  frames = lfLevels && (yield* part(lfFrameSteps(image, lfLevels), 1, 3));
  if (!variable) {
    const bytes = yield* part(effort >= 5 ? coefficientAnsSteps(image, effort) : coefficientEffortSteps(image, effort), lfLevels ? 2 : 1, lfLevels ? 3 : 2);
    return finish(bytes);
  }
  const shared = {}, plan = effort >= 3 ? {clusters: {maxClusters: 32, newClusterCost: 160}} : {};
  if (image.wideCoefficients) return finish(yield* part(varDCTSteps(image, {...plan, coding: quantParamCoding}, shared), lfLevels ? 2 : 1, lfLevels ? 3 : 2));
  if (effort < 2) return finish(yield* part(varDCTSteps(image, plan, shared), lfLevels ? 2 : 1, lfLevels ? 3 : 2));
  const prefix = yield* part(varDCTSteps(image, plan, shared), lfLevels ? 4 : 2, lfLevels ? 6 : 4), searchAt = lfLevels ? 5 / 6 : .75;
  if (yield searchAt) return finish(prefix);
  try {
    const candidate = varDCTSteps(image, {...plan, coding: buildAnsCoding, modularAns: writeModularAnsHistograms}, shared);
    let step;
    while (!(step = candidate.next()).done) if ((yield searchAt + step.value * (1 - searchAt)) && step.value < 1) {
      candidate.return(); return finish(prefix);
    }
    return finish(step.value.length < prefix.length ? step.value : prefix);
  } catch (error) {
    if (!(error instanceof RangeError && !error.code) && error.code !== 'JXL_SIZE') throw error;
    return finish(prefix);
  }
}
