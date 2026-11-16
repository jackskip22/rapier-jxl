// SPDX-License-Identifier: MIT
import {fail, snapshotOptions, snapshotArray} from './primitives.mjs';
export const METADATA = ['exif', 'xmp', 'jumb', 'compression', 'compress'];
export const FRAMING = ['chunkSize', 'fragmentOrder', 'minorVersion', 'frameStarts', 'allowBufferedFrameEnds', 'iccBitLength', 'extended', 'level'];
export const BOUNDS = ['maxInputBytes', 'maxBoxes'];
export function admitEdit(changes) {
  changes = snapshotOptions(changes, 'changes');
  for (const key of Object.keys(changes)) if (![...METADATA, ...FRAMING, ...BOUNDS].includes(key))
    throw fail('JXL_OPTIONS', `Unknown edit change ${key}; remove it.`);
  const maxBytes = changes.maxInputBytes ?? Number.MAX_SAFE_INTEGER, maxBoxes = changes.maxBoxes ?? 65536;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw fail('JXL_OPTIONS', "Invalid maxInputBytes; use a positive safe integer.");
  if (!Number.isSafeInteger(maxBoxes) || maxBoxes < 1) throw fail('JXL_OPTIONS', "Invalid maxBoxes; use a positive safe integer.");
  const pick = keys => Object.fromEntries(Object.entries(changes).filter(([key, value]) => keys.includes(key) && value !== undefined));
  const bounds = pick(BOUNDS), metadata = pick(METADATA), framing = pick(FRAMING);
  if (!Object.keys(metadata).length && !Object.keys(framing).length) throw fail('JXL_OPTIONS', 'edit has no change; supply metadata or framing options.');
  for (const key of ['fragmentOrder', 'frameStarts']) if (Array.isArray(framing[key])) framing[key] = snapshotArray(framing[key], key, undefined, 'JXL_INPUT');
  return {bounds, maxBytes, metadata, framing};
}
