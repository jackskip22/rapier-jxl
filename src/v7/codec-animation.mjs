// SPDX-License-Identifier: MIT
import {door} from './codec-door.mjs';
import {ANIMATION_SPEC} from './codec-spec-animation.mjs';
export const createCodec = door(ANIMATION_SPEC);
