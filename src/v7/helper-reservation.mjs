// SPDX-License-Identifier: MIT
import {fail as error, snapshotOptions} from './primitives.mjs';

export function deviceHelpers(nav = globalThis.navigator) {
  const reported = nav?.deviceMemory > 0, os = reported ? null : globalThis.process?.getBuiltinModule?.('node:os'), each = 2 ** 28;
  const count = Math.min((nav?.hardwareConcurrency || os?.availableParallelism() || 1) - 1,
    (reported ? nav.deviceMemory * 2 ** 27 : os ? os.freemem() / 4 : 2 * each) / each | 0);
  return count > 0 ? Object.freeze({count, memoryBytes: count * each}) : undefined;
}

export function helperReservation(value) {
  if (value === undefined) return undefined;
  if (value === true) return deviceHelpers();
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw error('JXL_OPTIONS', 'helpers: true or {count, memoryBytes}');
  const snap = snapshotOptions(value, 'helpers', [], true);
  for (const key of Object.keys(snap)) if (key !== 'count' && key !== 'memoryBytes') throw error('JXL_OPTIONS', `unknown helpers field: ${key}`);
  const {count, memoryBytes} = snap;
  if (!Number.isSafeInteger(count) || count < 0) throw error('JXL_OPTIONS', 'helpers.count: nonnegative integer');
  if (count ? (!Number.isSafeInteger(memoryBytes) || memoryBytes < 1)
      : (memoryBytes !== undefined && (!Number.isSafeInteger(memoryBytes) || memoryBytes < 0)))
    throw error('JXL_OPTIONS', count ? 'helpers.memoryBytes: positive integer' : 'helpers.memoryBytes: nonnegative integer');
  return count ? Object.freeze({count, memoryBytes}) : undefined;
}

