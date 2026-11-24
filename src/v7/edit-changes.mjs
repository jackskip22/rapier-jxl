// SPDX-License-Identifier: MIT
import {fail, snapshotOptions, snapshotArray} from './primitives.mjs';
export const METADATA = ['exif', 'xmp', 'jumb', 'compression', 'compress'];
export const FRAMING = ['chunkSize', 'fragmentOrder', 'minorVersion', 'frameStarts', 'allowBufferedFrameEnds', 'iccBitLength', 'extended', 'level'];
export const BOUNDS = ['maxInputBytes', 'maxBoxes'];
export function admitEdit(changes) {
  changes = snapshotOptions(changes, 'changes', [], true);
  for (const key of Object.keys(changes)) if (![...METADATA, ...FRAMING, ...BOUNDS].includes(key))
    throw fail('JXL_OPTIONS', `unknown change: ${key}`);
  const {maxInputBytes: maxBytes = Number.MAX_SAFE_INTEGER} = changes, maxBoxes = changes.maxBoxes ?? 65536;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw fail('JXL_OPTIONS', 'maxInputBytes: positive integer');
  if (!Number.isSafeInteger(maxBoxes) || maxBoxes < 1) throw fail('JXL_OPTIONS', 'maxBoxes: positive integer');
  const pick = keys => Object.fromEntries(Object.entries(changes).filter(([key, value]) => keys.includes(key) && value !== undefined));
  const bounds = pick(BOUNDS), metadata = pick(METADATA), framing = pick(FRAMING);
  if (!Object.keys(metadata).length && !Object.keys(framing).length) throw fail('JXL_OPTIONS', 'changes: supply metadata or framing');
  for (const key of ['extended', 'allowBufferedFrameEnds'])
    if (framing[key] !== undefined && typeof framing[key] !== 'boolean') throw fail('JXL_OPTIONS', `${key}: boolean`);
  for (const [key, values] of [['level', [5, 10]], ['minorVersion', [0, 1]]])
    if (framing[key] !== undefined && !values.includes(framing[key])) throw fail('JXL_OPTIONS', `${key}: ${values.join('|')}`);
  for (const [key, maximum] of [['chunkSize', 0x7fffffff], ['iccBitLength', Number.MAX_SAFE_INTEGER]])
    if (framing[key] !== undefined && !(Number.isSafeInteger(framing[key]) && framing[key] >= 1 && framing[key] <= maximum))
      throw fail('JXL_OPTIONS', `${key}: integer 1-${maximum}`);
  for (const key of ['fragmentOrder', 'frameStarts']) if (framing[key] !== undefined) {
    const values = framing[key] = snapshotArray(framing[key], key, undefined, 'JXL_OPTIONS'), starts = key === 'frameStarts';
    if (!values.length || values.some((value, i) => !Number.isSafeInteger(value) || value < (starts ? 2 : 0) || starts && i > 0 && value <= values[i - 1]))
      throw fail('JXL_OPTIONS', `${key}: ${starts ? 'increasing integer offsets >=2' : 'nonempty nonnegative integer array'}`);
  }
  return {bounds, maxBytes, metadata, framing};
}
