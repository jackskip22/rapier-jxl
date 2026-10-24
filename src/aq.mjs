// SPDX-License-Identifier: MIT

import {exactExp, exactLog, exactPow} from './exact-math.mjs';
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

export function smoothField(field, levels, switchCost) {
  const n = field.length, L = levels.length, logs = levels.map(v => exactLog(v));
  const cost = new Float64Array(L), next = new Float64Array(L), back = new Uint8Array(n * L);
  for (let i = 0; i < n; i++) {
    const lf = exactLog(field[i]);
    let bestPrev = 0;
    for (let j = 1; j < L; j++) if (cost[j] < cost[bestPrev]) bestPrev = j;
    for (let j = 0; j < L; j++) {
      const stay = cost[j], move = cost[bestPrev] + switchCost;
      const from = i === 0 || stay <= move ? j : bestPrev;
      back[i * L + j] = from;
      next[j] = (i === 0 ? 0 : Math.min(stay, move)) + (lf - logs[j]) * (lf - logs[j]);
    }
    cost.set(next);
  }
  let j = 0;
  for (let k = 1; k < L; k++) if (cost[k] < cost[j]) j = k;
  const out = new Float64Array(n);
  for (let i = n - 1; i >= 0; i--) { out[i] = levels[j]; j = back[i * L + j]; }
  return out;
}

export function* closedLoopFieldSteps(width, height, imageOf, {rounds = 3, gamma = 0.5, aimQuantile = 0.9, min = 0.6, max = 2,
  levels = [0.6, 0.7, 0.8, 0.9, 1, 1.12, 1.25, 1.4, 1.6, 1.8, 2], switchCost = 0.01, margin = 2, normalize = true, gammaDown = gamma, start = null} = {}) {
  const blocks = Math.ceil(width / 8) * Math.ceil(height / 8);
  let field = start ? Float64Array.from(start) : new Float64Array(blocks).fill(1);
  for (let round = 0; round < rounds; round++) {
    const d = (yield {measure: imageOf(round || start ? field : null), want: {margin}}).blocks;
    const sorted = Float64Array.from(d).sort(), aim = sorted[Math.min(blocks - 1, Math.floor(aimQuantile * blocks))];
    const raw = new Float64Array(blocks);
    for (let b = 0; b < blocks; b++) raw[b] = Math.max(min, Math.min(max, field[b] * exactPow(Math.max(1e-3, d[b]) / aim, d[b] > aim ? gamma : gammaDown)));
    if (normalize) {
      let s = 0; for (const v of raw) s += exactLog(v);
      const mean = exactExp(s / blocks); for (let b = 0; b < blocks; b++) raw[b] = Math.max(min, Math.min(max, raw[b] / mean));
    }
    field = smoothField(raw, levels, switchCost);
  }
  return field;
}
