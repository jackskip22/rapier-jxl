// SPDX-License-Identifier: MIT
import {fail as error} from './primitives.mjs';

export function deviceHelpers(nav = globalThis.navigator) {
  const reported = nav?.deviceMemory > 0, os = reported ? null : globalThis.process?.getBuiltinModule?.('node:os'), each = 3 * 2 ** 25;
  const count = Math.min((nav?.hardwareConcurrency || os?.availableParallelism() || 1) - 1,
    (reported ? nav.deviceMemory * 2 ** (nav.userAgentData?.mobile === false ? 27 : 26) : os ? os.freemem() / 4 : 2 * each) / each | 0);
  return count > 0 ? Object.freeze({count, memoryBytes: count * each}) : undefined;
}

export function helperReservation(value) {
  if (value === undefined) return undefined;
  if (value === true) return deviceHelpers();
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw error('JXL_OPTIONS', "Invalid helpers; use true or {count, memoryBytes}.");
  for (const key of Object.keys(value)) if (key !== 'count' && key !== 'memoryBytes') throw error('JXL_OPTIONS', `Unknown helpers field ${key}; remove it.`);
  const {count, memoryBytes} = value;
  if (!Number.isInteger(count) || count < 0) throw error('JXL_OPTIONS', "Invalid helpers.count; use a whole number, 0 or more.");
  if (count && (!Number.isSafeInteger(memoryBytes) || memoryBytes < 1)) throw error('JXL_OPTIONS', "Invalid helpers.memoryBytes; use a positive safe integer.");
  return count ? Object.freeze({count, memoryBytes}) : undefined;
}

