// SPDX-License-Identifier: MIT
import {admitOptions, admitPixels} from '../admit.mjs';
import {admitSampleFormat} from '../admit-samples.mjs';
import {admitPhotoFilter} from '../photo-job.mjs';
import {screenLike} from '../screen.mjs';
import {preferXYB} from '../photo-xyb.mjs';
import {MEASURED_EFFORT} from '../effort-level.mjs';
import {lowPhotoPictureSteps, lowOtherPhotoSteps} from '../photo-low.mjs';
import {gradient} from './webp-quality.mjs';
import {grainSample} from '../photo-v6-settings.mjs';
export {encodeLowSplit, makeLowUpload, finishLowUpload, closeLowUpload} from '../photo-low.mjs';

export const smoothDecides = ({effort, quality}) => effort >= 3 && quality < 80;
export const smoothPhoto = (data, width, height, facts = null) => (facts?.gradient ?? gradient({data, width, height})) < 8 ||
  grainSample(data, width, height).curvature > 1.25;
export function lowPhotoSteps(data, width, height, options, route = lowPhotoRoute(data, width, height, options)) {
  return route === 'xyb' || route === 'xyb-smooth' ? lowPhotoPictureSteps(data, width, height, {...options, screen: false, smooth: route === 'xyb-smooth'})
    : route === 'other' ? lowOtherPhotoSteps(data, width, height, options) : null;
}
export function lowPhotoRoute(data, width, height, options, facts = null) {
  if (options.lowWebp === undefined || options.effort < 1 || options.effort >= MEASURED_EFFORT || options.quality >= 100) return null;
  if (!(data instanceof Uint8Array || data instanceof Uint8ClampedArray)) return null;
  const samples = admitSampleFormat(data, options);
  if (!samples.native8 || samples.iccSpace || (options.colorSpace ?? 'srgb') !== 'srgb' ||
      options.photo === false || options.orientation !== undefined || options.extraChannels !== undefined) return null;
  admitPixels(data, width, height); admitOptions(options); admitPhotoFilter(options);
  if (facts ? facts.screenLike : screenLike(data, width, height)) return null;
  const xyb = facts ? facts.preferXYB : Math.min(width, height) < 128 || preferXYB(data, width, height);
  if (!xyb && options.effort < 4) return null;
  if (facts) { if (facts.alpha) return null; }
  else for (let i = 3; i < data.length; i += 4) if (data[i] !== 255) return null;
  return xyb ? smoothDecides(options) && smoothPhoto(data, width, height, facts) ? 'xyb-smooth' : 'xyb' : 'other';
}
