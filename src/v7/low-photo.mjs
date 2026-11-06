// SPDX-License-Identifier: MIT
import {admitOptions, admitPixels} from '../admit.mjs';
import {admitSampleFormat} from '../admit-samples.mjs';
import {admitPhotoFilter} from '../photo-job.mjs';
import {screenLike} from '../screen.mjs';
import {preferXYB} from '../photo-xyb.mjs';
import {MEASURED_EFFORT} from '../effort-level.mjs';
import {lowPhotoPictureSteps, lowOtherPhotoSteps} from '../photo-low.mjs';
export {encodeLowSplit, makeLowUpload, finishLowUpload, closeLowUpload} from '../photo-low.mjs';

export function lowPhotoSteps(data, width, height, options) {
  if (options.lowWebp === undefined || options.effort < 1 || options.effort >= MEASURED_EFFORT || options.quality >= 100) return null;
  if (!(data instanceof Uint8Array || data instanceof Uint8ClampedArray)) return null;
  const samples = admitSampleFormat(data, options);
  if (!samples.native8 || samples.iccSpace || (options.colorSpace ?? 'srgb') !== 'srgb' ||
      options.photo === false || options.orientation !== undefined || options.extraChannels !== undefined) return null;
  admitPixels(data, width, height); admitOptions(options); admitPhotoFilter(options);
  if (screenLike(data, width, height)) return null;
  const xyb = preferXYB(data, width, height);
  if (!xyb && options.effort < 4) return null;
  for (let i = 3; i < data.length; i += 4) if (data[i] !== 255) return null;
  return xyb ? lowPhotoPictureSteps(data, width, height, options) : lowOtherPhotoSteps(data, width, height, options);
}
