// SPDX-License-Identifier: MIT
import {fault} from './fault.mjs';
export function photoTarget(target) {
  if (!target || typeof target !== 'object' || Array.isArray(target))
    throw fault('JXL_INPUT', 'Target names ssimulacra2.');
  const out = {};
  for (const [key, value] of Object.entries(target)) {
    if (key !== 'ssimulacra2') throw fault('JXL_INPUT', `Target ${key} is not ssimulacra2.`);
    if (typeof value !== 'number' || !Number.isFinite(value) || value > 100)
      throw fault('JXL_INPUT', `Target ${key} is out of range.`);
    out[key] = value;
  }
  if (!Object.keys(out).length) throw fault('JXL_INPUT', 'Target names ssimulacra2.');
  return out;
}
