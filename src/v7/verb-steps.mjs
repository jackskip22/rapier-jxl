// SPDX-License-Identifier: MIT
import {imageResult} from './result.mjs';

export const STEPS = Symbol.for('rapier-jxl.steps');
export const verbSteps = (id, verb, {taken, admit, rows = false, files = false}) => Object.freeze({kind: 'verb', id, verb, taken, admit, rows, files, result: imageResult});
