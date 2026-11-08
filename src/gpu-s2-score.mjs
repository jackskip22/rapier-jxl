// SPDX-License-Identifier: MIT
import {S2_WEIGHTS, finalCurve} from './ssimulacra2-weights.mjs';

export const S2_GROUPS = 1024;

function assemble(sums, sizes) {
  let total = 0, i = 0;
  const norms = sizes.map(({w, h}, s) => {
    const inverse = 1 / (w * h), mean = v => inverse * v, root = v => Math.sqrt(Math.sqrt(mean(v)));
    return sums[s].map(t => [mean(t[0]), root(t[1]), mean(t[2]), root(t[3]), mean(t[4]), root(t[5])]);
  });
  for (let c = 0; c < 3; c++) for (let s = 0; s < sizes.length; s++) for (let k = 0; k < 2; k++) {
    const t = norms[s][c];
    total += S2_WEIGHTS[i++] * Math.abs(t[k]);
    total += S2_WEIGHTS[i++] * Math.abs(t[2 + k]);
    total += S2_WEIGHTS[i++] * Math.abs(t[4 + k]);
  }
  return total;
}
export function s2Interval(sums, sizes) {
  const lo = [], hi = [], u = 2 ** -53;
  for (let s = 0; s < sizes.length; s++) {
    const n = sizes[s].w * sizes[s].h, per = Math.ceil(n / (S2_GROUPS * 64)), adds = (per + 28) * 4e-14 + (n + 2) * u;
    lo.push([]); hi.push([]);
    for (const t of sums[s]) {
      if (!t.every(v => v >= 0 && Number.isFinite(v))) return null;
      const linear = 1e-13 * (n + t[2] + t[4]), fourth = v => 4e-13 * (v ** 0.75 * n ** 0.25 + v) + n * 1e-50;
      const d = [u * t[0], 2e-13 * t[1], linear, fourth(t[3]), linear, fourth(t[5])].map((e, k) => (e + adds * t[k]) * 1.01);
      lo[s].push(t.map((v, k) => Math.max(0, v - d[k]))); hi[s].push(t.map((v, k) => v + d[k]));
    }
  }
  if (lo.length !== sizes.length || lo.some(c => c.length !== 3)) return null;
  const sumHi = assemble(hi, sizes), sumLo = assemble(lo, sizes);
  if (!(sumHi < 100) || !(sumLo >= 0)) return null;
  const a = finalCurve(sumHi) - 1e-9, b = finalCurve(sumLo) + 1e-9;
  return Number.isFinite(a) && Number.isFinite(b) ? [a, b] : null;
}
