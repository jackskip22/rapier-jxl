// SPDX-License-Identifier: MIT
import {fault} from './fault.mjs';
export function photoTarget(target) {
  if (!target || typeof target !== 'object' || Array.isArray(target))
    throw fault('JXL_INPUT', 'target: {ssimulacra2}');
  const out = {};
  for (const [key, value] of Object.entries(target)) {
    if (key !== 'ssimulacra2') throw fault('JXL_INPUT', `unknown target: ${key}`);
    if (typeof value !== 'number' || !Number.isFinite(value) || value > 100)
      throw fault('JXL_INPUT', `${key}: finite <= 100`);
    out[key] = value;
  }
  if (!Object.keys(out).length) throw fault('JXL_INPUT', 'target: {ssimulacra2}');
  return out;
}
