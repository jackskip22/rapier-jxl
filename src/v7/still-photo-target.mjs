// SPDX-License-Identifier: MIT
import {part} from '../bits.mjs';
import {admitSampleFormat} from '../admit-samples.mjs';
import {screenLike} from '../screen.mjs';
import {wholePhotoSteps} from '../photo-whole-search.mjs';
import {wholeRebuildMeasure} from '../photo-whole-rebuild.mjs';
import {fail} from './primitives.mjs';
import {MEASURED_EFFORT} from '../effort-level.mjs';

export function stillPhotoTargetSteps(data, width, height, settings, {intent, signal, exact, selected, maxPixels} = {}) {
  if (intent === undefined || settings.lowWebp === undefined || settings.effort < MEASURED_EFFORT || settings.quality >= 100 ||
      !(data instanceof Uint8Array || data instanceof Uint8ClampedArray) ||
      settings.orientation !== undefined || settings.extraChannels !== undefined) return null;
  const samples = admitSampleFormat(data, settings);
  if (!samples.native8 || screenLike(data, width, height)) return null;
  return measuredSteps(data, width, height, settings, {intent, signal, exact, selected, maxPixels});
}

function* measuredSteps(data, width, height, settings, {intent, signal, exact, selected, maxPixels}) {
  let photoFacts = null, exactFloor = null;
  const admission = {record(bytes, passed, measurements) { photoFacts = {bytes, passed, measurements}; }};
  const retainFloor = function* (bytes) { if (!bytes) return exactFloor = yield* exact(); };
  const photo = yield* part(wholePhotoSteps(data, width, height, {
    quality: settings.quality, effort: settings.effort, colorSpace: settings.colorSpace,
    readingWebp: intent, firstEffort: MEASURED_EFFORT, retainFloor, signal, maxPixels, photoAdmission: admission, imageMeasure: wholeRebuildMeasure,
  }), 0, 2);
  if (photo && photo === exactFloor) {
    if (photoFacts && (photoFacts.bytes !== photo || photoFacts.passed !== true || !Array.isArray(photoFacts.measurements) || photoFacts.measurements.length))
      throw fail('JXL_INTERNAL', 'An exact winner retained a losing measurement.');
    selected?.({kept: 'pixels', measurements: []});
    return photo;
  }
  if (!photo || photoFacts?.bytes !== photo || photoFacts.passed !== true || !Array.isArray(photoFacts.measurements))
    throw fail('JXL_INTERNAL', 'The shared photo owner did not qualify its selected file.');
  if (!photoFacts.measurements.length) throw fail('JXL_INTERNAL', 'A measured photo retained no selected measurement.');
  selected?.({kept: 'lossy', measurements: photoFacts.measurements});
  return photo;
}
