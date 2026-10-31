// SPDX-License-Identifier: MIT
import {complete} from './bits.mjs';
import {encodeChannelsSteps} from './channels.mjs';
import {encodeLayersSteps as layerSteps, LIMITS, LAYER_BLEND_MODES} from './layers-core.mjs';
export {LIMITS, LAYER_BLEND_MODES};
export function encodeLayers(input, options = {}) { return complete(encodeLayersSteps(input, options)); }
export function encodeLayersSteps(input, options = {}) { return layerSteps(input, options, encodeChannelsSteps); }
