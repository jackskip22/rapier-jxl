// SPDX-License-Identifier: MIT
import {shapeScan, shapeScanPixels, shapeScanNext, shapeResult} from '../lossless.mjs';
import {gradientRows} from './webp-quality.mjs';
import {flatSampleAt, flatSampleY} from '../screen-samples.mjs';
import {photoPreferenceDifference} from '../photo-preference.mjs';

export const settleScans = {shapeScan, shapeScanPixels, shapeScanNext, shapeResult, gradientRows, flatSampleAt, flatSampleY, photoPreferenceDifference};
