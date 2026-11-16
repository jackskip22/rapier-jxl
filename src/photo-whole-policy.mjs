// SPDX-License-Identifier: MIT
import {measuredLook, askedLook} from './photo-quality-table.mjs';
import {browserMargin, measuredTarget} from './photo-browser-margin.mjs';
import {smallPicture} from './photo-v6-settings.mjs';

export const S2_MARGIN = 0.04;
export const explicitShownMargin = (score, width, height) => browserMargin(score) + S2_MARGIN + (smallPicture(width, height) ? SMALL_REBUILD_MARGIN : 0);
const SMALL_REBUILD_MARGIN = 0.2;
const smallDecodeGap = target => target <= 81.5 ? 0.18 : target <= 86 ? 0.24 : 0.3;
export const wholePhotoTarget = (score, readingIntent, browserScored = false, small = false) => readingIntent === undefined ? score + S2_MARGIN
  : small ? askedLook(readingIntent) + (browserScored ? 0 : smallDecodeGap(askedLook(readingIntent)))
  : browserScored ? measuredLook(readingIntent)
  : measuredTarget(measuredLook(readingIntent));
export const wholePhotoFloor = (score, readingIntent, target) => readingIntent === undefined ? score : target;
export const wholePhotoSmaller = (incumbentLength, candidateLength) => incumbentLength === null || candidateLength < incumbentLength;
export const wholePhotoMeasurements = (score, floor, domain = 'encoder-reconstruction') => score === null ? [] :
  [{metric: 'ssimulacra2', score, floor, domain}];
