// SPDX-License-Identifier: MIT
import {configuredDecoder} from '../shown-picture.mjs';
export const ownDecoder = {readJPEGSteps:() => configuredDecoder()?.restore?.[Symbol.for('rapier-jxl.verify.source')]};
