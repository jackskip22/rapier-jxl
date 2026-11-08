// SPDX-License-Identifier: MIT
import {exactLog, exactPow} from './exact-math.mjs';

export function fieldValues(d, field, raw, active, aim, gamma, gammaDown, min, max, from, to) {
  for (let b = from; b < to; b++) if (!active || active[b])
    raw[b] = Math.max(min, Math.min(max, field[b] * exactPow(Math.max(1e-3, d[b] / aim), d[b] > aim ? gamma : gammaDown)));
}
export function fieldLogSum(raw, active, from, to, sum = 0) {
  for (let b = from; b < to; b++) if (!active || active[b]) sum += exactLog(raw[b]);
  return sum;
}
export function normalizeField(raw, active, mean, min, max, from, to) {
  for (let b = from; b < to; b++) if (!active || active[b]) raw[b] = Math.max(min, Math.min(max, raw[b] / mean));
}
export function smoothForward(field, levels, logs, switchCost, active, cost, next, back, from, to) {
  const L = levels.length;
  for (let i = from; i < to; i++) {
    const fixed = active && !active[i], lf = fixed ? 0 : exactLog(field[i]);
    let bestPrev = 0;
    for (let j = 1; j < L; j++) if (cost[j] < cost[bestPrev]) bestPrev = j;
    for (let j = 0; j < L; j++) {
      const stay = cost[j], move = cost[bestPrev] + switchCost;
      const prior = i === 0 || stay <= move ? j : bestPrev;
      back[i * L + j] = prior;
      next[j] = fixed && levels[j] !== 1 ? Infinity : (i === 0 ? 0 : Math.min(stay, move)) + (lf - logs[j]) * (lf - logs[j]);
    }
    cost.set(next);
  }
}
export function smoothBacktrack(out, levels, back, from, to, j) {
  for (let i = from; i >= to; i--) { out[i] = levels[j]; j = back[i * levels.length + j]; }
  return j;
}
export function distanceBounds(d, doubt, active, low, high, from, to) {
  for (let b = from; b < to; b++) if (!active || active[b]) { low[b] = d[b] * (1 - doubt[b]); high[b] = d[b] * (1 + doubt[b]); }
}
export function fieldRangeValues(dLow, dHigh, field, active, low, high, aimLo, aimHi, gamma, gammaDown, min, max, from, to) {
  const clamp = value => Math.max(min, Math.min(max, value));
  for (let b = from; b < to; b++) if (!active || active[b]) {
    const lowRatio = Math.max(1e-3, dLow[b] / aimHi), highRatio = Math.max(1e-3, dHigh[b] / aimLo);
    const es = dHigh[b] <= aimLo ? [gammaDown] : dLow[b] > aimHi ? [gamma] : [gamma, gammaDown];
    low[b] = clamp(field[b] * Math.min(...es.map(e => exactPow(lowRatio, e))));
    high[b] = clamp(field[b] * Math.max(...es.map(e => exactPow(highRatio, e))));
  }
}
export function centralLogSum(d, field, aim, gamma, gammaDown, min, max, from, to, sum = 0) {
  const clamp = value => Math.max(min, Math.min(max, value));
  for (let b = from; b < to; b++) sum += exactLog(clamp(field[b] * exactPow(Math.max(1e-3, d[b] / aim), d[b] > aim ? gamma : gammaDown)));
  return sum;
}
export function intervalLogSums(low, high, active, from, to, sl = 0, sh = 0) {
  for (let b = from; b < to; b++) if (!active || active[b]) { sl += exactLog(low[b]); sh += exactLog(high[b]); }
  return [sl, sh];
}
export function normalizeRanges(low, high, active, meanLo, meanHi, min, max, from, to) {
  const clamp = value => Math.max(min, Math.min(max, value));
  for (let b = from; b < to; b++) if (!active || active[b]) {
    const l = clamp(low[b] / meanHi), h = clamp(high[b] / meanLo); low[b] = l; high[b] = h;
  }
}
export function logRanges(low, high, active, lo, hi, from, to) {
  const slack = 1e-12;
  for (let b = from; b < to; b++) if (!active || active[b]) { lo[b] = exactLog(low[b]) - slack; hi[b] = exactLog(high[b]) + slack; }
}
export function appendAimOpen(low, high, doubt, active, aimLo, aimHi, from, to, output) {
  if (aimLo < aimHi) for (let b = from; b < to; b++)
    if ((!active || active[b]) && doubt[b] && low[b] <= aimHi && high[b] >= aimLo) output.push(b);
}
export function pathLevels(path, levels, active, level, from, to) {
  for (let i = from; i < to; i++) {
    if (active && !active[i] && path[i] !== 1) throw new RangeError('An AQ path must keep inactive cells at 1.');
    level[i] = levels.indexOf(path[i]);
  }
}
export function pathTerm(lo, hi, level, levels, logs, active, i, j) {
  if (active && !active[i]) return levels[j] === 1 ? 0 : Infinity;
  const a = lo[i] - logs[j], b = hi[i] - logs[j], least = a <= 0 && b >= 0 ? 0 : Math.min(a * a, b * b), most = Math.max(a * a, b * b);
  return j === level[i] ? most : least;
}
export function pathForward(lo, hi, level, levels, logs, active, switchCost, F, from, to) {
  const L = levels.length;
  for (let i = from; i < to; i++) {
    let best = Infinity; if (i) for (let j = 0; j < L; j++) best = Math.min(best, F[(i - 1) * L + j]);
    for (let j = 0; j < L; j++) F[i * L + j] = pathTerm(lo, hi, level, levels, logs, active, i, j) + (i ? Math.min(F[(i - 1) * L + j], best + switchCost) : 0);
  }
}
export function pathBackward(lo, hi, level, levels, logs, active, switchCost, B, n, from, to) {
  const L = levels.length;
  for (let i = from; i >= to; i--) {
    let best = Infinity; if (i < n - 1) for (let j = 0; j < L; j++) best = Math.min(best, B[(i + 1) * L + j]);
    for (let j = 0; j < L; j++) B[i * L + j] = pathTerm(lo, hi, level, levels, logs, active, i, j) + (i < n - 1 ? Math.min(B[(i + 1) * L + j], best + switchCost) : 0);
  }
}
export function pathOwnCost(lo, hi, level, levels, logs, active, switchCost, from, to, own = 0) {
  for (let i = from; i < to; i++) own += pathTerm(lo, hi, level, levels, logs, active, i, level[i])
    + (i && level[i] !== level[i - 1] ? switchCost : 0);
  return own;
}
export function appendPathOpen(lo, hi, level, levels, logs, active, F, B, own, margin, from, to, output) {
  const L = levels.length;
  for (let i = from; i < to; i++) if (!active || active[i]) for (let j = 0; j < L; j++)
    if (j !== level[i] && F[i * L + j] + B[i * L + j] - pathTerm(lo, hi, level, levels, logs, active, i, j) <= own + margin) {
      output.push(i); break;
    }
}

export function smoothWinner(cost) {
  let j = 0;
  for (let k = 1; k < cost.length; k++) if (cost[k] < cost[j]) j = k;
  return j;
}
export function fieldPointRange(field, active, point, from, to) {
  for (let b = from; b < to; b++) point[b] = active[b] ? exactLog(field[b]) : 0;
}
