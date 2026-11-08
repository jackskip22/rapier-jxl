// SPDX-License-Identifier: MIT
import {progressiveValue} from './vardct-progressive.mjs';
import {DCT8_DENSITY, zeroDensityContext} from './dct8-contexts.mjs';

const CAPTURE_PHOTO = typeof __RAPIER_JXL_CAPTURE_PHOTO__ !== 'undefined' && __RAPIER_JXL_CAPTURE_PHOTO__ === true;

export function countACRanks(coeffs, base, order, from, to, progression, pass = 0, width = 8, height = 8, transpose = false) {
  let count = 0;
  if (!CAPTURE_PHOTO && progression) {
    for (let k = from; k < to; k++) {
      const pos = order ? order[k] : k;
      if (progressiveValue(progression.passes, coeffs[base + pos], transpose ? ((pos & 7) << 3) | (pos >> 3) : pos, width, height, pass)) count++;
    }
  } else if (order) {
    for (let k = from; k < to; k++) if (coeffs[base + order[k]]) count++;
  } else for (let k = from; k < to; k++) { const value = coeffs[base + k]; count += (value | -value) >>> 31; }
  return count;
}

export function predictDCT8NonZero(row, x, y, count) {
  const predicted = x === 0 ? (y === 0 ? 32 : row[(y - 1) * 32]) : y === 0 ? row[y * 32 + x - 1] :
    (row[(y - 1) * 32 + x] + row[y * 32 + x - 1] + 1) >> 1;
  row[y * 32 + x] = count;
  return predicted;
}

export function predictStrategyNonZero(row, x, y, count, width, height, area) {
  const predicted = x === 0 ? (y === 0 ? 32 : row[(y - 1) * 32]) : y === 0 ? row[x - 1] :
    (row[(y - 1) * 32 + x] + row[y * 32 + x - 1] + 1) >> 1;
  const average = Math.ceil(count / area);
  for (let by = 0; by < height; by++) for (let bx = 0; bx < width; bx++) row[(y + by) * 32 + x + bx] = average;
  return predicted;
}

export function emitACRanks(coeffs, base, order, from, to, left, prev, offset, area, ctxs, values, n,
  progression, pass = 0, width = 8, height = 8, transpose = false, tail) {
  let k = from;
  for (; k < to && left; k++) {
    const pos = order[k], coefficient = !CAPTURE_PHOTO && progression ? progressiveValue(progression.passes, coeffs[base + pos],
      transpose ? ((pos & 7) << 3) | (pos >> 3) : pos, width, height, pass) : coeffs[base + pos];
    ctxs[n] = offset + (area === 1 ? DCT8_DENSITY[left << 6 | k] + prev :
      zeroDensityContext(Math.ceil(left / area), Math.floor(k / area), prev));
    values[n++] = coefficient >= 0 ? coefficient * 2 : -coefficient * 2 - 1;
    prev = coefficient ? 1 : 0; left -= prev;
  }
  if (tail) { tail.rank = k; tail.left = left; tail.prev = prev; }
  return n;
}
