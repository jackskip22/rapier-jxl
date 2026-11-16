// SPDX-License-Identifier: MIT
import {inspectPhone} from './phone-container.mjs';
import {preparationWith} from './preparation-with.mjs';
import {retainedFit} from './preparation-plan.mjs';
import {photoOutputExhausted} from '../photo-output-exhaustion.mjs';
import {readTexture} from './texture.mjs';


export function preparation(encode, hooks) {
  return preparationWith(encode, {retainedFit: (typeof __RAPIER_JXL_STILL__ !== 'undefined' && __RAPIER_JXL_STILL__ === true) ? undefined : retainedFit, qualityMiss: photoOutputExhausted, readTexture, phone: inspectPhone, device: true, ...hooks});
}
