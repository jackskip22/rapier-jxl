// SPDX-License-Identifier: MIT
import {fault} from './admit.mjs';

export const FAST_EFFORT = 1;
export const BALANCED_EFFORT = 7;

export function admitEffort(options = {}, fallback = FAST_EFFORT) {
  if (options === null || typeof options !== 'object') throw fault('JXL_INPUT', 'Options are an object.');
  const effort = options.effort === undefined ? fallback : options.effort;
  if (!Number.isInteger(effort) || effort < 1 || effort > 9) throw fault('JXL_INPUT', 'Effort is a whole number from 1 to 9.');
  return effort;
}
