// SPDX-License-Identifier: MIT
import {sampleTransformRanking} from './sampled.mjs';
import {colourTransform} from './rct-search.mjs';
import {screenPlan, screenLocalFrameSteps} from './screen.mjs';

function localPlan(rgba, width, height, shape, mode) {
  if (mode === 'direct-ranked' && shape.colour === 3) {
    const type = sampleTransformRanking(rgba, width, height)[0], transform = colourTransform(type, shape.channels);
    return {meta: [], count: shape.channels, transforms: [{type: 'rct', beginC: 0, rctType: type}],
      fill: (planes, x, y, w, h) => transform.fill(planes, rgba, width, x, y, w, h)};
  }
  if (mode !== 'luma' && mode !== 'scan') return screenPlan(rgba, width, height, shape, mode);
  const plan = screenPlan(rgba, width, height, shape, 'global');
  if (!plan) return null;
  const palette = plan.meta[0], n = palette.width, rows = palette.plane;
  const order = Array.from({length: n}, (_, i) => i);
  if (mode === 'scan') {
    const first = new Int32Array(n).fill(-1);
    for (let i = 0; i < rgba.length; i += 4) {
      const key = rgba[i] + rgba[i + 1] * 256 + rgba[i + 2] * 65536 + rgba[i + 3] * 16777216;
      const value = plan.setup.index.get(key);
      if (first[value] < 0) first[value] = i;
    }
    order.sort((a, b) => first[a] - first[b]);
  } else {
    const light = i => shape.colour === 3 ? 299 * rows[i] + 587 * rows[n + i] + 114 * rows[2 * n + i] : rows[i] * 1000;
    order.sort((a, b) => light(a) - light(b) || a - b);
  }
  const mapping = new Int16Array(n), table = new Int16Array(rows.length);
  order.forEach((value, i) => { mapping[value] = i; });
  for (let c = 0; c < shape.channels; c++) for (let i = 0; i < n; i++) table[c * n + i] = rows[c * n + order[i]];
  return {...plan, meta: [{...palette, plane: table}], fill(planes, x, y, w, h) {
    plan.fill(planes, x, y, w, h);
    for (let i = 0; i < w * h; i++) planes[0][i] = mapping[planes[0][i]];
  }};
}

const MODES = ['global', 'frequency', 'scalar', 'direct-ranked', 'luma', 'scan'];

export function* localScreenSteps(rgba, width, height, shape, colorSpace, options) {
  try { return yield* screenLocalFrameSteps(rgba, width, height, shape, colorSpace, {...options, modes: MODES, planner: localPlan}); }
  catch (error) {
    if (error.code === 'JXL_SIZE' || error instanceof RangeError && !error.code) return null;
    throw error;
  }
}
