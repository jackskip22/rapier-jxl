// SPDX-License-Identifier: MIT
import {exactPow} from './exact-math.mjs';
export function blockDistances({map, width, height}, margin = 2) {
  const stride = Math.ceil(width / 8), rows = Math.ceil(height / 8), out = new Float64Array(stride * rows);
  for (let by = 0; by < rows; by++) for (let bx = 0; bx < stride; bx++) {
    let m = 0;
    for (let y = Math.max(0, by * 8 - margin); y < Math.min(height, by * 8 + 8 + margin); y++)
      for (let x = Math.max(0, bx * 8 - margin); x < Math.min(width, bx * 8 + 8 + margin); x++) m = Math.max(m, map[y * width + x]);
    out[by * stride + bx] = m;
  }
  return out;
}

export function cellSums(map, width, height, p = 3) {
  const stride = Math.ceil(width / 8), out = new Float64Array(stride * Math.ceil(height / 8));
  if (p === 3) {
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const v = map[y * width + x]; out[(y >> 3) * stride + (x >> 3)] += v * (v * v);
    }
  } else for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) out[(y >> 3) * stride + (x >> 3)] += exactPow(map[y * width + x], p);
  return out;
}
