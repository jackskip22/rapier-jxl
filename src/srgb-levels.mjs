// SPDX-License-Identifier: MIT
import {captureLinearPlanes} from './capture-kernels.mjs';

let levels;
export const srgbLevels = () => levels ??= captureLinearPlanes([Float64Array.from({length: 256}, (_, i) => i / 255)])[0];
