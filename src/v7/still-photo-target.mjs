// SPDX-License-Identifier: MIT
import {part} from '../bits.mjs';
import {admitSampleFormat, statedSpace} from '../admit-samples.mjs';
import {screenLike} from '../screen.mjs';
import {smallPicture} from '../photo-v6-settings.mjs';
import {wholePhotoSteps} from '../photo-whole-search.mjs';
import {deadzoneMapSteps} from '../deadzone-map.mjs';
import {wholeRebuildMeasure} from '../photo-whole-rebuild.mjs';
import {alphaRebuildMeasure} from '../photo-alpha-measure.mjs';
import {captureFillClear} from '../capture-kernels.mjs';
import {fail} from './primitives.mjs';
import {MEASURED_EFFORT} from '../effort-level.mjs';
import {textFloorEligible, textFloorCapture} from '../text-floor.mjs';
import {unit} from '../step-journal.mjs';
import {inspectPixels} from '../lossless.mjs';

export function stillPhotoTargetSteps(data, width, height, settings, {intent, signal, exact, selected, maxPixels, fit, preview} = {}) {
  if (intent === undefined || settings.lowIntent === undefined || settings.effort < MEASURED_EFFORT || settings.quality >= 100 ||
      !(data instanceof Uint8Array || data instanceof Uint8ClampedArray) ||
      settings.orientation !== undefined || settings.extraChannels !== undefined) return null;
  const samples = admitSampleFormat(data, settings);
  const stated = statedSpace(samples);
  if (!samples.native8 && !stated || screenLike(data, width, height)) return null;
  if (stated) settings = {...settings, colorSpace: stated};
  const options = {intent, signal, exact, selected, maxPixels, fit, preview};
  const ladder = settings.effort >= 7 && !fit && smallPicture(width, height);
  return ladder ? ladderSteps(data, width, height, settings, options) : measuredSteps(data, width, height, settings, options);
}

function* ladderSteps(data, width, height, settings, options) {
  const efforts = [];
  for (let effort = 6; effort <= settings.effort; effort++) efforts.push(effort);
  let best = null, bestFacts = null;
  for (const [i, effort] of efforts.entries()) {
    let facts = null;
    const bytes = yield* part(measuredSteps(data, width, height, {...settings, effort}, {...options, selected: f => { facts = f; }}), i, efforts.length);
    if (bytes && (!best || bytes.length < best.length)) { best = bytes; bestFacts = facts; }
  }
  if (bestFacts) options.selected?.(bestFacts);
  return best;
}

function* measuredSteps(data, width, height, settings, {intent, signal, exact, selected, maxPixels, fit, preview}) {
  let photoFacts = null, exactFloor = null, fitted = null;
  const admission = {record(bytes, passed, measurements) { photoFacts = {bytes, passed, measurements}; }};
  const retainFloor = function* (bytes, effort) { if (!bytes) return exactFloor = yield* exact(effort); };
  let alpha = false;
  for (let at = 3; at < data.length; at += 4) if (data[at] !== 255) { alpha = true; break; }
  const pixels = alpha ? captureFillClear(data, width, height) : data;
  const photo = yield* part(wholePhotoSteps(pixels, width, height, {
    quality: settings.quality, effort: settings.effort, colorSpace: settings.colorSpace,
    readingIntent: intent, firstEffort: MEASURED_EFFORT, retainFloor, signal, maxPixels, photoAdmission: admission, imageMeasure: alpha ? alphaRebuildMeasure : wholeRebuildMeasure, preview, alpha,
    deadzones: deadzoneMapSteps,
    ...(fit && {fit: {...fit, found: found => { fitted = found; }}}),
  }), 0, 1);
  if (photo && photo === exactFloor) {
    if (photoFacts && (photoFacts.bytes !== photo || photoFacts.passed !== true || !Array.isArray(photoFacts.measurements) || photoFacts.measurements.length))
      throw fail('JXL_INTERNAL', "Invalid output measurement; report the input and options.");
    selected?.({kept: 'pixels', measurements: [], ...(fitted && {fitted})});
    return photo;
  }
  if (!photo || photoFacts?.bytes !== photo || photoFacts.passed !== true || !Array.isArray(photoFacts.measurements))
    throw fail('JXL_INTERNAL', "Invalid output measurement; report the input and options.");
  if (!photoFacts.measurements.length) throw fail('JXL_INTERNAL', "Invalid output measurement; report the input and options.");
  if (!fit && (yield* unit('palette-floor', () => Boolean(inspectPixels(data, width, height).palette)))) {
    const exactFile = exactFloor ?? (yield* exact());
    if (exactFile instanceof Uint8Array && exactFile.length <= photo.length) { selected?.({kept: 'pixels', measurements: []}); return exactFile; }
  }
  const captured = !fit && (yield* unit('text-floor', () => textFloorEligible(data, width, height, settings))) ? yield* textFloorCapture(photo, data, width, height, settings.colorSpace) : null;
  if (captured) { selected?.({kept: 'pixels', measurements: []}); return captured; }
  selected?.({kept: 'lossy', measurements: photoFacts.measurements, ...(fitted && {fitted})});
  return photo;
}
