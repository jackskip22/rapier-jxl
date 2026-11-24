// SPDX-License-Identifier: MIT
import {encodeSplitLadder} from './photo-split-ladder.mjs';
import {localSteps, nativeLocalSteps} from './local.mjs';
import {rctSearchSteps} from './rct-search.mjs';
import {CAPTURE_TOOLS_COMPLETE} from './capture-ans.mjs';
import {effortTenSteps, effortTenAhead} from './effort-ten.mjs';
import {SPLIT_HOOKS} from './split-hooks.mjs';
export const EXACT_LADDER = Object.freeze({localSteps, nativeLocalSteps, rctSearchSteps, capture: CAPTURE_TOOLS_COMPLETE,
  ...((typeof __RAPIER_JXL_EFFORT_TEN__ === 'undefined' || __RAPIER_JXL_EFFORT_TEN__ === true) ? {effortTen: effortTenSteps, effortTenAhead} : {})});
SPLIT_HOOKS.ladder ??= (...args) => Promise.resolve().then(() => encodeSplitLadder(...args));
