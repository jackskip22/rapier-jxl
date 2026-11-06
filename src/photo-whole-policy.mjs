// SPDX-License-Identifier: MIT
import {webpTarget} from './photo-quality-table.mjs';
import {measuredTarget} from './photo-browser-margin.mjs';

export const S2_MARGIN = 0.04;
export const wholePhotoTarget = (score, readingWebp, browserScored = false) => readingWebp === undefined ? score + S2_MARGIN
  : browserScored ? webpTarget(readingWebp) : measuredTarget(webpTarget(readingWebp));
export const wholePhotoFloor = (score, readingWebp, target) => readingWebp === undefined ? score : target;
export const wholePhotoSmaller = (incumbentLength, candidateLength) => incumbentLength === null || candidateLength < incumbentLength;
export const wholePhotoMeasurements = (score, floor, domain = 'encoder-reconstruction') => score === null ? [] :
  [{metric: 'ssimulacra2', score, floor, domain}];
