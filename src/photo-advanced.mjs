// SPDX-License-Identifier: MIT
import {LIMITS} from './limits.mjs';
import {complete, part} from './bits.mjs';
import {GABORISH, v6For} from './photo-v6-settings.mjs';
import {encodePhotoSteps as encodeOrdinaryPhotoSteps} from './photo.mjs';
import {photoXYBBands} from './photo-bands.mjs';
import {admitOptions, admitPixels, fault, job} from './admit.mjs';
import {admitSampleFormat} from './admit-samples.mjs';
import {admitEffort} from './effort-level.mjs';
import {losslessSteps, nativeSteps} from './lossless.mjs';
import {varDCTSteps} from './vardct.mjs';
import {strategyCoefficientSteps, admitStrategyOptions, TRANSFORMS} from './vardct-strategies.mjs';
import {buildAnsCoding, writeModularAnsHistograms} from './ans.mjs';
import {progressivePasses, progressiveOrders} from './vardct-progressive.mjs';
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
import {shown} from './photo-shown.mjs';

export {TRANSFORMS, photonNoise, COEFFICIENT_ORDER_BUCKETS};
export {LIMITS};
const STILL = typeof __RAPIER_JXL_STILL__ !== 'undefined' && __RAPIER_JXL_STILL__ === true;
export function admitFeatures(options, width, height, quality) {
  if (options.level !== undefined && options.level !== 5 && options.level !== 10) throw fault('JXL_INPUT', 'level: 5 or 10');
  admitPhotoLayout(width, height, options, quality);
  const progression = progressivePasses(options.progressive);
  admitNoise(options.noise, width, height); admitLFFrames(options.lfFrames);
  prepareCoefficientOrders(options.coefficientOrders, progression?.count || 1); admitStrategyOptions(options);
}
export function encodePhoto(data, width, height, options) { return complete(encodePhotoSteps(data, width, height, options)); }
export function encodePhotoSteps(data, width, height, options = {}) {
  const {quality, colorSpace} = admitOptions(options, 90), effort = admitEffort(options);
  if (options.level !== undefined && options.level !== 5 && options.level !== 10) throw fault('JXL_INPUT', 'level: 5 or 10');
  const layout = STILL ? {width, height, factor: 1, codedWidth: width, codedHeight: height} : admitPhotoLayout(width, height, options, quality);
  admitPixels(data, layout.codedWidth, layout.codedHeight, LIMITS);
  const samples = admitSampleFormat(data, options), progression = STILL ? null : progressivePasses(options.progressive);
  const noiseLut = STILL ? null : admitNoise(options.noise, width, height), lfLevels = STILL ? 0 : admitLFFrames(options.lfFrames);
  const authoredOrderPasses = STILL ? null : prepareCoefficientOrders(options.coefficientOrders, progression?.count || 1);
  if (STILL && options.orientation !== undefined && (!Number.isInteger(options.orientation) || options.orientation < 1 || options.orientation > 8))
    throw fault('JXL_INPUT', 'orientation: integer 1-8');
  const strategyOptions = STILL ? {variable: false} : admitStrategyOptions(options), filter = admitPhotoFilter(options);
  if (quality === 100 && options.extraChannels !== undefined && (!Array.isArray(options.extraChannels) || options.extraChannels.length)) {
    if (typeof __RAPIER_JXL_STILL__ !== 'undefined' && __RAPIER_JXL_STILL__ === true)
      throw fault('JXL_UNSUPPORTED', 'exact extraChannels: use jpegxl/format');
    else return exactPhotoExtraSteps(data, width, height, options, samples);
  }
  const extras = admitPhotoExtras(data, layout, options);
  if (options.orientation !== undefined && options.orientation !== 1 && (quality >= 100 || !samples.native8))
    throw fault('JXL_UNSUPPORTED', 'orientation: 8-bit lossy sRGB only');
  if (!samples.native8 && quality < 100 && (strategyOptions.variable || progression || noiseLut || lfLevels || authoredOrderPasses || extras || layout.factor !== 1 || layout.colorTransform))
    throw fault('JXL_INPUT', 'transforms: 8-bit sRGB only');
  if (quality < 100 && lfLevels) {
    if (colorSpace !== 'srgb') throw fault('JXL_INPUT', 'lfFrames: sRGB only');
  }
  return job(steps(data, layout.codedWidth, layout.codedHeight, {quality, colorSpace, effort, samples, options, progression, noiseLut, strategyOptions, filter, lfLevels, authoredOrderPasses, layout, extras}));
}

function* photoV6Producer(data, width, height, quality, gaborish = true, effort = 7) {
  const v6 = v6For(width, height);
  if (gaborish && effort <= 3) { yield 0; return complete(photoXYBSteps(data, width, height, quality, {...v6, fast: true, fastBand: true})); }
  if (gaborish) return yield* photoXYBBands(data, width, height, quality, {...v6, ...GABORISH});
  yield 0;
  return complete(photoXYBSteps(data, width, height, quality, v6));
}

function* steps(data, width, height, call) {
  const {effort, strategyOptions, layout, options, extras, progression, noiseLut, lfLevels, authoredOrderPasses, colorSpace, samples, quality} = call;
  const stream = yield* stepsAt(data, width, height, call), bytes = !STILL && options.level === 10 && stream[0] === 255 ? photoLevelContainer(stream, 10) : stream;
  if (effort < 3 || !samples.native8 || quality >= 100 || strategyOptions.variable || layout.factor !== 1 || layout.colorTransform || layout.xybTransform ||
    extras || progression || noiseLut || lfLevels || authoredOrderPasses || options.orientation !== undefined || colorSpace !== 'srgb') return bytes;
  const lower = yield* steps(data, width, height, {...call, effort: effort >= 6 ? 5 : 2});
  return lower.length < bytes.length ? lower : bytes;
}

function* stepsAt(data, width, height, {quality, colorSpace, effort, samples, options, progression, noiseLut, strategyOptions, filter, lfLevels, authoredOrderPasses, layout, extras}) {
  if (!samples.native8) return yield* nativeSteps(data, width, height, {quality, samples, effort});
  if (quality >= 100) return yield* losslessSteps(data, width, height, {colorSpace, fast: effort < 2});
  const padded = STILL ? null : padPhotoLayout(data, width, height, layout, noiseLut);
  if (padded) ({data, width, height} = padded);
  const variable = !STILL && strategyOptions.variable;
  const ordinary = !variable && effort >= 4 && !padded && layout.factor === 1 && !layout.colorTransform && !layout.xybTransform && !extras &&
    !progression && !noiseLut && !lfLevels && !authoredOrderPasses && options.orientation === undefined && colorSpace === 'srgb' &&
    preferXYB(data, width, height);
  if (ordinary) return yield* encodeOrdinaryPhotoSteps(data, width, height, {quality, effort});
  let frames;
  const finish = bytes => {
    if (!STILL && frames) bytes = prependLFFrames(bytes, frames);
    if (!STILL && variable && bytes[0] === 255 && !readImageHeader(bytes).modular16) bytes = photoLevelContainer(bytes, 10);
    return !STILL && padded ? cropPhotoCanvas(bytes, layout.width, layout.height) : bytes;
  };
  const done = (bytes, shows) => shown(finish(bytes), padded || frames ? null : shows);
  const producer = !STILL && variable ? strategyCoefficientSteps(data, width, height, quality, colorSpace, options, strategyOptions) :
    colorSpace === 'srgb' && (lfLevels || noiseLut || preferXYB(data, width, height)) ? photoV6Producer(data, width, height, quality, !lfLevels && !noiseLut, effort) :
    photoCoefficientSteps(data, width, height, quality, colorSpace);
  const image = yield* part(producer, 0, lfLevels ? 3 : 2);
  applyPhotoLayout(image, layout, !!padded);
  applyPhotoExtras(image, extras, layout);
  image.orientation = options.orientation ?? 1;
  image.progression = progression;
  image.noiseLut = noiseLut;
  image.authoredOrderPasses = authoredOrderPasses;
  image.progressiveOrders = STILL || authoredOrderPasses ? null : progressiveOrders(progression);
  frames = !STILL && lfLevels && (yield* part(lfFrameSteps(image, lfLevels), 1, 3));
  if (STILL || !variable) {
    return done(yield* part(coefficientAnsSteps(image, effort), lfLevels ? 2 : 1, lfLevels ? 3 : 2), image);
  }
  const shared = {}, plan = effort >= 3 ? {clusters: {maxClusters: 32, newClusterCost: 160}} : {};
  if (image.wideCoefficients) return done(yield* part(varDCTSteps(image, {...plan, coding: quantParamCoding}, shared), lfLevels ? 2 : 1, lfLevels ? 3 : 2), image);
  if (effort < 2) return done(yield* part(varDCTSteps(image, plan, shared), lfLevels ? 2 : 1, lfLevels ? 3 : 2), image);
  const prefix = yield* part(varDCTSteps(image, plan, shared), lfLevels ? 4 : 2, lfLevels ? 6 : 4), searchAt = lfLevels ? 5 / 6 : .75;
  if (yield searchAt) return done(prefix, image);
  try {
    const candidate = varDCTSteps(image, {...plan, coding: buildAnsCoding, modularAns: writeModularAnsHistograms}, shared);
    let step;
    while (!(step = candidate.next()).done) if ((yield searchAt + step.value * (1 - searchAt)) && step.value < 1) {
      candidate.return(); return done(prefix, image);
    }
    return done(step.value.length < prefix.length ? step.value : prefix, image);
  } catch (error) {
    if (error.code !== 'JXL_SIZE') throw error;
    return done(prefix, image);
  }
}
