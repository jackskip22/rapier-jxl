// SPDX-License-Identifier: MIT
import {measureFormatOptions} from './format-option-measurements.mjs';
import {quantizationCases, quantizationPixels} from '../test/quantization-cases.mjs';
await measureFormatOptions({name: 'Quantization Patterns v1', kind: 'quantization', cases: quantizationCases(), pixels: quantizationPixels, out: process.argv[2]});
