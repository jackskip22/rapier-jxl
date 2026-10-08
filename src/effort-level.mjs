// SPDX-License-Identifier: MIT
// Only entry points with a search read effort; keeping it here adds no work or bytes to the pixel core.
import {fault} from './admit.mjs';

export function admitEffort(options = {}) {
  if (options === null || typeof options !== 'object') throw fault('JXL_INPUT', 'Options are an object.');
  const effort = options.effort === undefined ? 1 : options.effort;
  if (!Number.isInteger(effort) || effort < 1 || effort > 9) throw fault('JXL_INPUT', 'Effort is a whole number from 1 to 9.');
  return effort;
}
