// SPDX-License-Identifier: MIT
import {regionQuality} from './webp-quality.mjs';
import {lowPhotoReading} from './low-webp-quality.mjs';

const FROM = 30;
const ROW = [40, 40, 40, 40, 40, 40, 40, 40, 40, 40, 40, 40, 40, 40, 40, 40, 40, 40, 40, 40, 40, 40, 40, 40, 40, 40, 40, 40, 40,
  40, 40, 40, 40.6, 42.2, 43.1, 44.7, 45.8, 47.8, 49.3, 50.7, 50.7, 54, 55.4, 56.2, 57.5, 57.8, 59.6, 63.2, 65.1, 67.9, 69.8, 72,
  73.5, 75.6, 77.8, 79.2, 81.1, 82.9, 84.8, 85.9, 87.5, 88.8, 89.9, 91.1, 91.8, 92.6, 93.3, 93.8, 94.2];

export function smallTableReading(q, rect, offGrid = false) {
  if (q >= 1) return 100;
  const at = q * 100;
  let reading;
  if (at > 98) reading = ROW.at(-1) + (99.99 - ROW.at(-1)) * Math.min(1, at - 98);
  else {
    const x = Math.max(FROM, at) - FROM, i = Math.min(ROW.length - 2, Math.floor(x));
    reading = ROW[i] + (ROW[i + 1] - ROW[i]) * (x - i);
  }
  const grid = offGrid ? regionQuality(q, null, 0, rect, true) - regionQuality(q, null, 0, rect, false) : 0;
  return Math.min(99.99, reading + grid);
}

export function captureSmallReading(q, data, width, rect, offGrid = false, colorSpace = 'srgb') {
  return lowPhotoReading(q, {data, width: rect.width, height: rect.height, colorSpace}, smallTableReading(q, rect, offGrid),
    {stride: width, origin: rect.y * width + rect.x});
}
