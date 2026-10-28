// SPDX-License-Identifier: MIT
import {PHOTO_LIMITS} from './limits.mjs';
import {BitWriter, complete, part, packSigned} from './bits.mjs';
import {admitOptions, admitPixels, admitSampleFormat, fault, job} from './admit.mjs';
import {admitEffort} from './effort-level.mjs';
import {admitPhotoFilter} from './photo-job.mjs';
import {photoXYBSteps} from './photo-xyb.mjs';
import {coefficientAnsSteps} from './coefficient-ans.mjs';
import {buildCode, uintConfig, countToken, writeHistograms, writeHybrid} from './prefix.mjs';

const SPLINE_WEIGHTS = [.0042, .075, .07, .3333], SPLINE_COORDINATE = 8388608;
const splineRound = value => Math.sign(value) * Math.floor(Math.abs(value) + .5);
const splineVector = value => Array.isArray(value) || ArrayBuffer.isView(value) && typeof value.length === 'number';
function splineInteger(value, label) {
  if (!Number.isInteger(value) || Math.abs(value) > 2147483647) throw fault('JXL_INPUT', label + ' is a signed 32-bit integer other than -2147483648.');
  return value;
}
function splinePointValues(points) {
  if (!Array.isArray(points) || points.length < 2 || points.length > 1048576)
    throw fault('JXL_INPUT', 'A spline has from 2 to 1048576 control points; one-point curves render differently in current decoders.');
  const values = new Int32Array(points.length * 2);
  let distance = 0;
  for (let i = 0; i < points.length; i++) {
    const point = points[i];
    if (!splineVector(point) || point.length !== 2 || ![point[0], point[1]].every(v => Number.isInteger(v) && Math.abs(v) < SPLINE_COORDINATE))
      throw fault('JXL_INPUT', 'A spline control point is [x, y] with integer coordinates strictly between -8388608 and 8388608.');
    values.set(point, i * 2);
    if (i) {
      const dx = point[0] - values[i * 2 - 2], dy = point[1] - values[i * 2 - 1];
      if ((!dx && !dy) || Math.abs(dx) >= SPLINE_COORDINATE || Math.abs(dy) >= SPLINE_COORDINATE)
        throw fault('JXL_INPUT', 'Adjacent spline points differ and their coordinate differences are strictly below 8388608.');
      distance += Math.abs(dx) + Math.abs(dy);
    }
  }
  return {values, distance};
}
function splineDct(values, label) {
  if (!splineVector(values) || values.length !== 32) throw fault('JXL_INPUT', label + ' contains 32 quantized integer DCT coefficients.');
  return Int32Array.from(values, value => splineInteger(value, label));
}
function splineAdjustment(value) { return splineInteger(value ?? 0, 'quantizationAdjustment'); }

export function splineStroke(controlPoints, options) {
  if (!options || typeof options !== 'object') throw fault('JXL_INPUT', 'A spline stroke needs colorXYB and sigma.');
  const {colorXYB, sigma} = options, quantizationAdjustment = splineAdjustment(options.quantizationAdjustment);
  if (!splineVector(colorXYB) || colorXYB.length !== 3 || !colorXYB.every(Number.isFinite) || !Number.isFinite(sigma) || sigma <= 0)
    throw fault('JXL_INPUT', 'colorXYB has three finite normalized XYB values; sigma is positive Gaussian width in pixels.');
  const {values} = splinePointValues(controlPoints), colorDct = [new Int32Array(32), new Int32Array(32), new Int32Array(32)], sigmaDct = new Int32Array(32);
  const adjustment = quantizationAdjustment >= 0 ? 1 + quantizationAdjustment / 8 : 1 / (1 - quantizationAdjustment / 8);
  const quantize = (value, weight) => splineInteger(splineRound(value * adjustment / weight), 'The quantized stroke');
  colorDct[1][0] = quantize(colorXYB[1], SPLINE_WEIGHTS[1]);
  colorDct[0][0] = quantize(colorXYB[0], SPLINE_WEIGHTS[0]);
  colorDct[2][0] = quantize(colorXYB[2] - colorDct[1][0] * SPLINE_WEIGHTS[1] / adjustment, SPLINE_WEIGHTS[2]);
  sigmaDct[0] = quantize(sigma, SPLINE_WEIGHTS[3]);
  if (!sigmaDct[0]) throw fault('JXL_INPUT', 'sigma rounds to zero at this quantizationAdjustment; increase either value.');
  return {controlPoints: Array.from({length: values.length / 2}, (_, i) => [values[i * 2], values[i * 2 + 1]]), colorDct, sigmaDct, quantizationAdjustment};
}

function admitSplines(width, height, options) {
  const supplied = options.splines;
  if (!Array.isArray(supplied) || !supplied.length) throw fault('JXL_INPUT', 'splines is a nonempty array of authored curves.');
  const pixelCount = width * height, pointLimit = Math.min(1048576, Math.floor(pixelCount / 2));
  if (options.level !== undefined && options.level !== 5 && options.level !== 10) throw fault('JXL_INPUT', 'JPEG XL level is 5 or 10.');
  if (supplied.length > Math.min(pointLimit, Math.floor(pixelCount / 4))) throw fault('JXL_INPUT', 'There are too many splines for this image; at most one per four pixels.');
  const quantizationAdjustment = splineAdjustment(options.quantizationAdjustment ?? supplied[0]?.quantizationAdjustment);
  const inverse = quantizationAdjustment >= 0 ? 1 / (1 + quantizationAdjustment / 8) : 1 - quantizationAdjustment / 8;
  const areaLimit = Math.min(4398046511104, 1024 * pixelCount + 4294967296);
  let points = 0, estimatedArea = 0;
  const splines = Array.from(supplied, (spline, index) => {
    if (!spline || typeof spline !== 'object' || !Array.isArray(spline.colorDct) || spline.colorDct.length !== 3)
      throw fault('JXL_INPUT', 'Each spline has controlPoints, three colorDct arrays, and sigmaDct.');
    if (spline.quantizationAdjustment !== undefined && spline.quantizationAdjustment !== quantizationAdjustment)
      throw fault('JXL_INPUT', 'Every spline in a frame uses the same quantizationAdjustment.');
    points += spline.controlPoints?.length ?? 0;
    if (points > pointLimit) throw fault('JXL_INPUT', 'The frame has too many spline control points; the limit is min(1048576, pixels / 2).');
    const {values, distance} = splinePointValues(spline.controlPoints);
    if (!index && (values[0] < 0 || values[1] < 0)) throw fault('JXL_INPUT', 'The first spline starts at nonnegative x and y; later curves may start outside the image.');
    const colorDct = [0, 1, 2].map(c => splineDct(spline.colorDct[c], 'colorDct[' + c + ']'));
    const sigmaDct = splineDct(spline.sigmaDct, 'sigmaDct');
    const colors = colorDct.map(values => values.reduce((sum, value) => sum + Math.ceil(Math.abs(value) * inverse), 0));
    colors[2] += colors[1];
    const colorBound = 1 + Math.max(...colors);
    let logColor = 1, colorPower = 2;
    while (colorPower < colorBound) { colorPower *= 2; logColor++; }
    let widthBound = 0;
    for (const value of sigmaDct) {
      const sigmaBound = 1 + Math.ceil(Math.abs(value) * inverse);
      widthBound += sigmaBound * sigmaBound;
    }
    estimatedArea += distance ? distance * widthBound * logColor : 0;
    if (distance > areaLimit || estimatedArea > areaLimit)
      throw fault('JXL_INPUT', 'The spline geometry, width and color exceed the JPEG XL decoder area budget.');
    return {values, colorDct, sigmaDct};
  });
  const requiredLevel = estimatedArea > Math.min(1073741824, 8 * pixelCount + 33554432) ? 10 : 5;
  if ((options.level ?? 5) === 5 && requiredLevel === 10)
    throw fault('JXL_INPUT', 'These spline curves require explicit level: 10; Chrome 155 enforces the smaller level-5 spline area budget.');
  return {splines, quantizationAdjustment, level: options.level ?? 5, tokens: 2 + supplied.length * 129 + points * 2};
}

function* visitSplineTokens(plan, emit) {
  const {splines, quantizationAdjustment, tokens} = plan;
  let done = 0, yielded = 0;
  const write = (ctx, value) => { emit(ctx, value); done++; };
  write(2, splines.length - 1);
  let px = 0, py = 0;
  for (let i = 0; i < splines.length; i++) {
    const [x, y] = splines[i].values;
    write(1, i ? packSigned(x - px) : x); write(1, i ? packSigned(y - py) : y); px = x; py = y;
    if (done - yielded >= 4096) { yielded = done; yield done / tokens; }
  }
  write(0, packSigned(quantizationAdjustment));
  for (const {values, colorDct, sigmaDct} of splines) {
    write(3, values.length / 2 - 1);
    let dx = 0, dy = 0;
    for (let at = 2; at < values.length; at += 2) {
      const nextX = values[at] - values[at - 2], nextY = values[at + 1] - values[at - 1];
      write(4, packSigned(nextX - dx)); write(4, packSigned(nextY - dy)); dx = nextX; dy = nextY;
      if (done - yielded >= 4096) { yielded = done; yield done / tokens; }
    }
    for (const dct of [...colorDct, sigmaDct]) for (const value of dct) write(5, packSigned(value));
    if (done - yielded >= 4096) { yielded = done; yield done / tokens; }
  }
  yield 1;
}
function* splineEntropySteps(plan) {
  const config = uintConfig(0), frequencies = Array.from({length: 6}, () => new Uint32Array(33));
  yield* part(visitSplineTokens(plan, (ctx, value) => countToken(config, value, frequencies[ctx])), 0, 2);
  const codes = frequencies.map(buildCode), writer = new BitWriter();
  writeHistograms(writer, {contextMap: Uint8Array.from([0, 1, 2, 3, 4, 5]), histograms: codes.map(code => ({config, code}))});
  yield* part(visitSplineTokens(plan, (ctx, value) => writeHybrid(writer, codes[ctx], config, value)), 1, 2);
  return writer;
}

function* splineImageSteps(data, width, height, quality, effort, filter, orientation, plan) {
  const splineBits = yield* part(splineEntropySteps(plan), 0, 3);
  const image = yield* part(photoXYBSteps(data, width, height, quality, {filter}), 1, 3);
  image.splineBits = splineBits; image.orientation = orientation; image.level = plan.level;
  return yield* part(coefficientAnsSteps(image, effort), 2, 3);
}

export function encodeSplines(data, width, height, options) { return complete(encodeSplinesSteps(data, width, height, options)); }
export function encodeSplinesSteps(data, width, height, options = {}) {
  const {quality, colorSpace} = admitOptions(options, 90), effort = admitEffort(options), filter = admitPhotoFilter(options);
  admitPixels(data, width, height, PHOTO_LIMITS);
  if (quality === 100 || colorSpace !== 'srgb' || !admitSampleFormat(data, options).native8)
    throw fault('JXL_INPUT', 'Authored splines require straight sRGB8 pixels and quality below 100; curves add to the source image.');
  const orientation = options.orientation ?? 1;
  if (!Number.isInteger(orientation) || orientation < 1 || orientation > 8) throw fault('JXL_INPUT', 'orientation is an integer from 1 to 8.');
  const plan = admitSplines(width, height, options);
  return job(splineImageSteps(data, width, height, quality, effort, filter, orientation, plan));
}
