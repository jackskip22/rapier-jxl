// SPDX-License-Identifier: MIT
import {localSteps} from './local.mjs';
import {rctSearchSteps} from './rct-search.mjs';
import {paletteSteps} from './palette-search.mjs';
import {localScreenSteps} from './screen-local.mjs';
import {SPLIT_HOOKS} from './split-hooks.mjs';
export const EXACT_LADDER = Object.freeze({localSteps, rctSearchSteps, screen: Object.freeze({paletteSteps, localScreenSteps})});
SPLIT_HOOKS.ladder ??= (...args) => import('./photo-split-ladder.mjs').then(({encodeSplitLadder}) => encodeSplitLadder(...args));
