// SPDX-License-Identifier: MIT
import {measureFormatOptions} from './format-option-measurements.mjs';
import {lfCombinationCases, lfCombinationPixels} from '../test/lf-combination-cases.mjs';
await measureFormatOptions({name: 'LF Combinations v1', kind: 'lf', cases: lfCombinationCases(), pixels: lfCombinationPixels, out: process.argv[2]});
