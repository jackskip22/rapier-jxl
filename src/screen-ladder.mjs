// SPDX-License-Identifier: MIT
import {EXACT_LADDER} from './exact-ladder.mjs';
import {screenSteps} from './screen-search.mjs';
import {paletteSteps} from './palette-search.mjs';
import {localScreenSteps} from './screen-local.mjs';
export const SCREEN_LADDER = Object.freeze({...EXACT_LADDER, screenSteps, screen: Object.freeze({paletteSteps, localScreenSteps})});
