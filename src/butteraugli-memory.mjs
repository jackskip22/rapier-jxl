// SPDX-License-Identifier: MIT
import {LIMITS} from './limits.mjs';
import {fault} from './fault.mjs';
export const BA_MEMORY = Object.freeze({linear:131072, gaussian:132096, base:132544, maximumPages:32767,
  gaussianBytes:448, rowHalo:80, rowCore:256, rowTargetBytes:256 * 1024 * 1024});
const LIMIT = BA_MEMORY.maximumPages * 65536;
export function butteraugliDimensions(width, height) {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 8 || height < 8
      || width > LIMITS.edge || height > LIMITS.edge || width * height > LIMITS.pixels)
    throw fault('JXL_DIMENSIONS', 'Butteraugli needs pictures of at least 8 × 8 pixels within the picture limits.');
  return width * height;
}
function layout(width, height, {operation = 'score', cacheBytes = 0} = {}, limit = LIMIT) {
  const pixels = butteraugliDimensions(width, height);
  if (!['reference', 'score', 'rows'].includes(operation)) throw fault('JXL_INPUT', 'Unknown Butteraugli operation.');
  if (!Number.isSafeInteger(cacheBytes) || cacheBytes < 0)
    throw fault('JXL_INPUT', 'Butteraugli cacheBytes must be a nonnegative safe integer.');
  const halfWidth = Math.ceil(width / 2), halfHeight = Math.ceil(height / 2);
  const halfPixels = halfWidth >= 8 && halfHeight >= 8 ? halfWidth * halfHeight : 0;
  let cacheMask = 0, retainedCacheBytes = 0, stagedCacheBytes = 0;
  for (const [level, n] of [pixels, halfPixels].entries()) if (n && n * 12 <= cacheBytes - retainedCacheBytes) {
    cacheMask |= 1 << level; retainedCacheBytes += n * 12; stagedCacheBytes = Math.max(stagedCacheBytes, n * 12);
  }
  let cursor = BA_MEMORY.base;
  const take = bytes => {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > limit - cursor - 15)
      throw fault('JXL_MEMORY', 'Butteraugli exceeds its memory allowance.');
    const at = cursor; cursor += Math.ceil(bytes / 16) * 16; return at;
  };
  const input = take(pixels * 12), reference = take(pixels * 40);
  const distorted = operation === 'reference' ? 0 : take(pixels * 40);
  const scratch = take(pixels * (operation === 'reference' ? 8 : 40));
  const output = operation === 'reference' ? 0 : take(pixels * 4);
  const cache = stagedCacheBytes && operation !== 'rows' ? take(stagedCacheBytes) : 0;
  const halfReference = operation === 'rows' && halfPixels ? take(halfPixels * 40) : 0;
  return {width, height, pixels, halfWidth, halfHeight, halfPixels, operation, input, reference, distorted, scratch,
    output, cache, halfReference, cacheMask, cacheBytes:operation === 'rows' ? 0 : retainedCacheBytes,
    referenceBytes:40 * (pixels + halfPixels), arenaBytes:cursor, residentBytes:Math.ceil(cursor / 65536) * 65536};
}
export const butteraugliLayout = (width, height, options) => layout(width, height, options);
export function butteraugliRowsLayout(width, height) {
  butteraugliDimensions(width, height);
  const targetRows = Math.floor((BA_MEMORY.rowTargetBytes - BA_MEMORY.base) / (146 * width));
  const coreRows = Math.max(2, Math.min(BA_MEMORY.rowCore, 2 * Math.floor((targetRows - 2 * BA_MEMORY.rowHalo) / 2)));
  const bandHeight = Math.min(height, coreRows + 2 * BA_MEMORY.rowHalo);
  const plan = butteraugliLayout(width, bandHeight, {operation:'rows'});
  return {...plan, coreRows, bandHeight, halo:BA_MEMORY.rowHalo, wholeHeight:height,
    referenceBytes:0, cacheBytes:0, mapBytes:width * 4,
    workBytes:plan.residentBytes + width * 4, retainedArenaBytes:0, fixedTableBytes:BA_MEMORY.gaussianBytes};
}
export function butteraugliAllocation(width, height, options = {}) {
  const score = layout(width, height, {...options, operation:'score'}, Number.MAX_SAFE_INTEGER);
  const prepare = layout(width, height, {...options, operation:'reference'}, Number.MAX_SAFE_INTEGER);
  return {referenceBytes:score.referenceBytes, cacheBytes:score.cacheBytes, mapBytes:score.pixels * 4,
    workBytes:score.residentBytes + score.pixels * 4, residentBytes:score.residentBytes,
    prepareWorkBytes:prepare.residentBytes,
    preparePeakBytes:prepare.residentBytes + score.referenceBytes + score.cacheBytes,
    available:score.residentBytes <= LIMIT && prepare.residentBytes <= LIMIT,
    retainedArenaBytes:0, fixedTableBytes:BA_MEMORY.gaussianBytes};
}
export const butteraugliWorkBytes = (width, height, options) => butteraugliAllocation(width, height, options).workBytes;
