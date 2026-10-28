// SPDX-License-Identifier: MIT
import {PHOTO_LIMITS} from './limits.mjs';
import {complete, part} from './bits.mjs';
import {V6, GABORISH} from './photo-v6.mjs';
import {photoXYBBands} from './photo-bands.mjs';
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
import {coefficientAnsSteps} from './coefficient-ans.mjs';
import {admitLFFrames, lfFrameSteps, prependLFFrames} from './lf-frames.mjs';
import {cropPhotoCanvas, photoLevelContainer} from './photo-crop.mjs';
import {readImageHeader} from './framing.mjs';
import {quantParamCoding} from './quantization-params.mjs';
import {prepareCoefficientOrders, COEFFICIENT_ORDER_BUCKETS} from './coefficient-orders.mjs';
import {admitPhotoLayout, padPhotoLayout, applyPhotoLayout} from './photo-layout.mjs';
import {admitPhotoExtras, applyPhotoExtras, exactPhotoExtraSteps} from './photo-extras.mjs';

export {TRANSFORMS, photonNoise, COEFFICIENT_ORDER_BUCKETS};
export {PHOTO_LIMITS as LIMITS};
export function encodePhoto(data, width, height, options) { return complete(encodePhotoSteps(data, width, height, options)); }
export function encodePhotoSteps(data, width, height, options = {}) {
  const {quality, colorSpace} = admitOptions(options, 90), effort = admitEffort(options);
  const layout = admitPhotoLayout(width, height, options, quality);
  admitPixels(data, layout.codedWidth, layout.codedHeight, PHOTO_LIMITS);
  const samples = admitSampleFormat(data, options), progression = progressivePasses(options.progressive), noiseLut = admitNoise(options.noise, width, height);
  const lfLevels = admitLFFrames(options.lfFrames);
  const authoredOrderPasses = prepareCoefficientOrders(options.coefficientOrders, progression?.count || 1);
  const strategyOptions = admitStrategyOptions(options), filter = admitPhotoFilter(options);
  if (quality === 100 && options.extraChannels !== undefined && (!Array.isArray(options.extraChannels) || options.extraChannels.length))
    return exactPhotoExtraSteps(data, width, height, options, samples);
  const extras = admitPhotoExtras(data, layout, options);
  if (!samples.native8 && quality < 100 && (strategyOptions.variable || progression || noiseLut || lfLevels || authoredOrderPasses || extras || layout.factor !== 1 || layout.colorTransform))
    throw fault('JXL_INPUT', 'Advanced VarDCT transforms require eight-bit RGB samples with sRGB transfer.');
  if (quality < 100 && lfLevels) {
    if (colorSpace !== 'srgb') throw fault('JXL_INPUT', 'Low-frequency frame pyramids currently require sRGB photographic pixels.');
  }
  return job(steps(data, layout.codedWidth, layout.codedHeight, {quality, colorSpace, effort, samples, options, progression, noiseLut, strategyOptions, filter, lfLevels, authoredOrderPasses, layout, extras}));
}

function* photoV6Producer(data, width, height, quality, gaborish = true, effort = 7) {
  if (gaborish && effort <= 3) { yield 0; return complete(photoXYBSteps(data, width, height, quality, {...V6, fast: true})); }
  if (gaborish) return yield* photoXYBBands(data, width, height, quality, {...V6, ...GABORISH});
  yield 0;
  return complete(photoXYBSteps(data, width, height, quality, V6));
}

function* steps(data, width, height, {quality, colorSpace, effort, samples, options, progression, noiseLut, strategyOptions, filter, lfLevels, authoredOrderPasses, layout, extras}) {
  if (!samples.native8) return yield* nativeSteps(data, width, height, {quality, samples, effort});
  if (quality >= 100) return yield* losslessSteps(data, width, height, {colorSpace, fast: effort < 2});
  const padded = padPhotoLayout(data, width, height, layout, noiseLut);
  if (padded) ({data, width, height} = padded);
  const variable = strategyOptions.variable;
  let frames;
  const finish = bytes => {
    if (frames) bytes = prependLFFrames(bytes, frames);
    if (variable && bytes[0] === 255 && !readImageHeader(bytes).modular16) bytes = photoLevelContainer(bytes, 10);
    return padded ? cropPhotoCanvas(bytes, layout.width, layout.height) : bytes;
  };
  const producer = variable ? strategyCoefficientSteps(data, width, height, quality, colorSpace, options, strategyOptions) :
    colorSpace === 'srgb' && (lfLevels || noiseLut || preferXYB(data, width, height)) ? photoV6Producer(data, width, height, quality, !lfLevels && !noiseLut, effort) :
    photoCoefficientSteps(data, width, height, quality, colorSpace);
  const image = yield* part(producer, 0, lfLevels ? 3 : 2);
  applyPhotoLayout(image, layout, !!padded);
  applyPhotoExtras(image, extras, layout);
  image.orientation = options.orientation ?? 1;
  image.progression = progression;
  image.noiseLut = noiseLut;
  image.authoredOrderPasses = authoredOrderPasses;
  frames = lfLevels && (yield* part(lfFrameSteps(image, lfLevels), 1, 3));
  if (!variable) {
    const bytes = yield* part(coefficientAnsSteps(image, effort), lfLevels ? 2 : 1, lfLevels ? 3 : 2);
    const ordinary = effort >= 4 && !padded && layout.factor === 1 && !layout.colorTransform && !layout.xybTransform && !extras &&
      !progression && !noiseLut && !lfLevels && !authoredOrderPasses && options.orientation === undefined && colorSpace === 'srgb' &&
      preferXYB(data, width, height);
    if (!ordinary) return finish(bytes);
    const floor = complete(coefficientAnsSteps(complete(photoXYBSteps(data, width, height, quality, {...V6, fast: true})), 1));
    return finish(floor.length <= bytes.length ? floor : bytes);
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
