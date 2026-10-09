// SPDX-License-Identifier: MIT
// Small deterministic pictures for the sampled tree search: one photograph-like, one screen-like with partial alpha,
// and two frames wider than a group, so the searches run per group and across group boundaries.
import {SAMPLE_RUNGS, sampleTransformRanking} from '../src/sampled.mjs';

// Every rung, and the precise rung under the colour transforms the ranking puts first and second for the picture.
export function searchRungs(rgba, width, height) {
  const ranking = sampleTransformRanking(rgba, width, height);
  return {...SAMPLE_RUNGS, ranked: {...SAMPLE_RUNGS.precise, rctType: ranking[0]}, ranked2: {...SAMPLE_RUNGS.precise, rctType: ranking[1]}};
}

export function searchPictures() {
  let seed = 20261009;
  const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) >>> 24;
  const picture = (name, width, height, pixel) => {
    const rgba = new Uint8Array(width * height * 4);
    for (let y = 0, i = 0; y < height; y++) for (let x = 0; x < width; x++, i += 4) rgba.set(pixel(x, y), i);
    return {name, width, height, rgba};
  };
  return [
    picture('photograph', 96, 80, (x, y) => [(x * 2 + y + (random() >> 4)) & 255, (y * 3 + (random() >> 3)) & 255, ((x + y) * 2 + (random() >> 4)) & 255, 255]),
    picture('screen', 120, 64, (x, y) => {
      const box = (x >> 4) % 3 === 0 && (y >> 3) % 2 === 0, glyph = (x * 7 + y * 13) % 11 < 2 && y > 40;
      return glyph ? [20, 20, 20, 255] : box ? [200 + (x & 7), 220, 240 - (y & 15), 255 - (x > 100 ? (x - 100) * 9 : 0)] : [250, 250, 250, 255];
    }),
    picture('wide-stripes', 300, 40, (x, y) => [(x * 5 + (random() >> 6)) & 255, (y * 9) & 255, ((x >> 2) * 3) & 255, 255]),
    picture('wide-group', 1100, 20, (x, y) => [(x + y * 3 + (random() >> 5)) & 255, (x >> 1) & 255, (y * 11 + (random() >> 6)) & 255, 255]),
  ];
}
