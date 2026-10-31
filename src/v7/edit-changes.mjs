// SPDX-License-Identifier: MIT
import {fail, object} from './primitives.mjs';
export const METADATA = ['exif', 'xmp', 'jumb', 'compression', 'compress'];
export const FRAMING = ['chunkSize', 'fragmentOrder', 'minorVersion', 'frameStarts', 'allowBufferedFrameEnds', 'iccBitLength', 'extended', 'level'];
export const BOUNDS = ['maxInputBytes', 'maxBoxes'];
export function admitEdit(changes) {
  object(changes, 'changes');
  for (const key of Object.keys(changes)) if (![...METADATA, ...FRAMING, ...BOUNDS].includes(key))
    throw fail('JXL_OPTIONS', `Unknown edit change: ${key}.`);
  const maxBytes = changes.maxInputBytes ?? Number.MAX_SAFE_INTEGER, maxBoxes = changes.maxBoxes ?? 65536;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw fail('JXL_OPTIONS', 'maxInputBytes is a positive safe integer.');
  if (!Number.isSafeInteger(maxBoxes) || maxBoxes < 1) throw fail('JXL_OPTIONS', 'maxBoxes is a positive safe integer.');
  const pick = keys => Object.fromEntries(Object.entries(changes).filter(([key, value]) => keys.includes(key) && value !== undefined));
  const bounds = pick(BOUNDS), metadata = pick(METADATA), framing = pick(FRAMING);
  if (!Object.keys(metadata).length && !Object.keys(framing).length) throw fail('JXL_OPTIONS', 'edit needs a change: metadata or framing.');
  for (const key of ['fragmentOrder', 'frameStarts']) if (Array.isArray(framing[key])) framing[key] = [...framing[key]];
  return {bounds, maxBytes, metadata, framing};
}
