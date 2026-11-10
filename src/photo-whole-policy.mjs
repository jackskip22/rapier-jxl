// SPDX-License-Identifier: MIT
import {webpTarget} from './photo-quality-table.mjs';
import {browserMargin, measuredTarget} from './photo-browser-margin.mjs';
import {smallPicture} from './photo-v6-settings.mjs';

export const S2_MARGIN = 0.04;
export const explicitShownMargin = (score, width, height) => browserMargin(score) + S2_MARGIN + (smallPicture(width, height) ? SMALL_REBUILD_MARGIN : 0);
export const SMALL_REBUILD_MARGIN = 0.2;
export const wholePhotoTarget = (score, readingWebp, browserScored = false, small = false) => readingWebp === undefined ? score + S2_MARGIN
  : browserScored ? webpTarget(readingWebp) : measuredTarget(webpTarget(readingWebp)) + (small ? SMALL_REBUILD_MARGIN : 0);
export const wholePhotoFloor = (score, readingWebp, target) => readingWebp === undefined ? score : target;
export const wholePhotoSmaller = (incumbentLength, candidateLength) => incumbentLength === null || candidateLength < incumbentLength;
export const wholePhotoMeasurements = (score, floor, domain = 'encoder-reconstruction') => score === null ? [] :
  [{metric: 'ssimulacra2', score, floor, domain}];
