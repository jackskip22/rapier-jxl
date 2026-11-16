// SPDX-License-Identifier: MIT
import {shapeScan, shapeScanPixels, shapeScanNext, shapeResult} from '../lossless.mjs';
import {gradientRows, blockFacts, exactlyPredicted, softEdges} from './intent-quality.mjs';
import {flatSampleAt, flatSampleY, screenFromFlags} from '../screen-samples.mjs';
import {photoPreferenceDifference} from '../photo-preference.mjs';

export const settleScans = {shapeScan, shapeScanPixels, shapeScanNext, shapeResult, gradientRows, blockFacts, exactlyPredicted, softEdges, flatSampleAt, flatSampleY, screenFromFlags, photoPreferenceDifference};
