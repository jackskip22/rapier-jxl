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
  levels = [0.6, 0.7, 0.8, 0.9, 1, 1.12, 1.25, 1.4, 1.6, 1.8, 2], switchCost = 0.01, margin = 2, normalize = true, gammaDown = gamma, start = null, initial = null} = {}) {
  const blocks = Math.ceil(width / 8) * Math.ceil(height / 8), options = {gamma, aimQuantile, min, max, normalize, gammaDown};
  let field = start ? Float64Array.from(start) : new Float64Array(blocks).fill(1);
  for (let round = 0; round < rounds; round++) {
    const first = !round && !start && initial, image = first ? first.image : imageOf(round || start ? field : null);
    const reply = first ? first.scores : yield {measure: image, want: {margin}}, d = reply.blocks, bound = reply.doubt?.blocks ?? 0;
    if (!bound) { field = smoothField(fieldRaw(d, field, blocks, options), levels, switchCost); continue; }
    const doubt = new Float64Array(blocks).fill(bound), dist = Float64Array.from(d);
    let next = null;
    for (let attempt = 0; attempt < 3 && !next; attempt++) {
      const raw = fieldRaw(dist, field, blocks, options), path = smoothField(raw, levels, switchCost);
      const {lo, hi, aimOpen} = fieldRanges(dist, doubt, field, blocks, {...options, meanDoubt: MEAN_DOUBT}), open = certifyPath(lo, hi, path, levels, switchCost);
      if (!open.length) { next = path; break; }
      for (const b of aimOpen) open.push(b);
      const exact = attempt < 2 ? yield {exact: {kind: 'blocks', image, margin, regions: blockRegions(open, width, height)}} : yield {exact: {kind: 'whole', image, margin}};
      if (!exact) { next = path; break; }
      if (exact.blocks instanceof Map) for (const [k, v] of exact.blocks) { dist[k] = v; doubt[k] = 0; }
      else { dist.set(exact.blocks); doubt.fill(0); }
    }
    field = next ?? smoothField(fieldRaw(dist, field, blocks, options), levels, switchCost);
  }
  return field;
}

function fieldRaw(d, field, blocks, {gamma, aimQuantile, min, max, normalize, gammaDown}) {
  const sorted = Float64Array.from(d).sort(), aim = sorted[Math.min(blocks - 1, Math.floor(aimQuantile * blocks))];
  const raw = new Float64Array(blocks);
  for (let b = 0; b < blocks; b++) raw[b] = Math.max(min, Math.min(max, field[b] * exactPow(Math.max(1e-3, d[b]) / aim, d[b] > aim ? gamma : gammaDown)));
  if (normalize) {
    let s = 0; for (const v of raw) s += exactLog(v);
    const mean = exactExp(s / blocks); for (let b = 0; b < blocks; b++) raw[b] = Math.max(min, Math.min(max, raw[b] / mean));
  }
  return raw;
}

export const MEAN_DOUBT = 1e-6;

export function fieldRanges(d, doubt, field, blocks, {gamma, aimQuantile, min, max, normalize, gammaDown, meanDoubt}) {
  const k = Math.min(blocks - 1, Math.floor(aimQuantile * blocks)), dl = new Float64Array(blocks), dh = new Float64Array(blocks);
  for (let b = 0; b < blocks; b++) { dl[b] = d[b] * (1 - doubt[b]); dh[b] = d[b] * (1 + doubt[b]); }
  const aimLo = Float64Array.from(dl).sort()[k], aimHi = Float64Array.from(dh).sort()[k];
  const rl = new Float64Array(blocks), rh = new Float64Array(blocks), clamp = v => Math.max(min, Math.min(max, v));
  for (let b = 0; b < blocks; b++) {
    const lowRatio = Math.max(1e-3, dl[b]) / aimHi, highRatio = Math.max(1e-3, dh[b]) / aimLo;
    const es = dh[b] <= aimLo ? [gammaDown] : dl[b] > aimHi ? [gamma] : [gamma, gammaDown];
    rl[b] = clamp(field[b] * Math.min(...es.map(e => exactPow(lowRatio, e))));
    rh[b] = clamp(field[b] * Math.max(...es.map(e => exactPow(highRatio, e))));
  }
  if (normalize) {
    let meanLo, meanHi;
    if (meanDoubt !== undefined) {
      const sorted = Float64Array.from(d).sort(), aim = sorted[k];
      let s = 0; for (let b = 0; b < blocks; b++) s += exactLog(clamp(field[b] * exactPow(Math.max(1e-3, d[b]) / aim, d[b] > aim ? gamma : gammaDown)));
      meanLo = exactExp(s / blocks - meanDoubt); meanHi = exactExp(s / blocks + meanDoubt);
    } else {
      let sl = 0, sh = 0; for (let b = 0; b < blocks; b++) { sl += exactLog(rl[b]); sh += exactLog(rh[b]); }
      meanLo = exactExp(sl / blocks); meanHi = exactExp(sh / blocks);
    }
    for (let b = 0; b < blocks; b++) { const l = clamp(rl[b] / meanHi), h = clamp(rh[b] / meanLo); rl[b] = l; rh[b] = h; }
  }
  const lo = new Float64Array(blocks), hi = new Float64Array(blocks), slack = 1e-12, aimOpen = [];
  for (let b = 0; b < blocks; b++) { lo[b] = exactLog(rl[b]) - slack; hi[b] = exactLog(rh[b]) + slack; }
  if (aimLo < aimHi) for (let b = 0; b < blocks; b++) if (doubt[b] && dl[b] <= aimHi && dh[b] >= aimLo) aimOpen.push(b);
  return {lo, hi, aimOpen};
}

export function certifyPath(lo, hi, path, levels, switchCost) {
  const n = lo.length, L = levels.length, logs = levels.map(v => exactLog(v)), level = new Uint8Array(n);
  for (let i = 0; i < n; i++) level[i] = levels.indexOf(path[i]);
  const term = (i, j) => {
    const a = lo[i] - logs[j], b = hi[i] - logs[j], least = a <= 0 && b >= 0 ? 0 : Math.min(a * a, b * b), most = Math.max(a * a, b * b);
    return j === level[i] ? most : least;
  };
  const F = new Float64Array(n * L), B = new Float64Array(n * L);
  for (let i = 0; i < n; i++) {
    let best = Infinity; if (i) for (let j = 0; j < L; j++) best = Math.min(best, F[(i - 1) * L + j]);
    for (let j = 0; j < L; j++) F[i * L + j] = term(i, j) + (i ? Math.min(F[(i - 1) * L + j], best + switchCost) : 0);
  }
  for (let i = n - 1; i >= 0; i--) {
    let best = Infinity; if (i < n - 1) for (let j = 0; j < L; j++) best = Math.min(best, B[(i + 1) * L + j]);
    for (let j = 0; j < L; j++) B[i * L + j] = term(i, j) + (i < n - 1 ? Math.min(B[(i + 1) * L + j], best + switchCost) : 0);
  }
  let own = 0;
  for (let i = 0; i < n; i++) own += term(i, level[i]) + (i && level[i] !== level[i - 1] ? switchCost : 0);
  const margin = 1e-13 * n * (1 + own), open = [];
  for (let i = 0; i < n; i++) for (let j = 0; j < L; j++)
    if (j !== level[i] && F[i * L + j] + B[i * L + j] - term(i, j) <= own + margin) { open.push(i); break; }
  return open;
}

function blockRegions(open, width, height) {
  const stride = Math.ceil(width / 8), tiles = new Set();
  for (const b of open) tiles.add(Math.floor((b / stride | 0) / 4) * 65536 + Math.floor((b % stride) / 4));
  return [...tiles].map(t => { const ty = Math.floor(t / 65536), tx = t % 65536; return {x0: tx * 32, y0: ty * 32, x1: Math.min(width, tx * 32 + 32), y1: Math.min(height, ty * 32 + 32)}; });
}

export function perceptualMaskField(planes, stride, rows, rowsOf = () => ({planes, top: 0})) {
  const hf = new Float64Array(stride * rows);
  for (let by = 0; by < rows; by++) { const {planes: p, top} = rowsOf(by); maskEnergy(p, top, stride, by, by + 1, hf); }
  return maskWeights(hf, stride, rows);
}
export function maskEnergy([X, Y, B], top, stride, by0, by1, hf) {
  const W = stride * 8;
  for (let by = by0; by < by1; by++) for (let bx = 0; bx < stride; bx++) {
    let s = 0;
    for (let y = 0; y < 7; y++) {
      const row = (by * 8 + y - top) * W + bx * 8;
      for (let x = 0; x < 7; x++) {
        const i = row + x;
        const dy1 = Y[i + 1] - Y[i], dy2 = Y[i + W] - Y[i], dd = Y[i + W + 1] + Y[i] - Y[i + 1] - Y[i + W];
        const dx = X[i + 1] - X[i], db = B[i + 1] - B[i];
        const eY = Math.sqrt(dy1 * dy1 + dy2 * dy2 + 0.5 * dd * dd);
        const eC = Math.sqrt(4 * dx * dx + 0.25 * db * db);
        s += (eY / (1 + 0.08 * eY)) + 0.35 * (eC / (1 + 0.08 * eC));
      }
    }
    hf[by * stride + bx] = s / 49;
  }
}
export function maskWeightDoubts(bound, stride, rows) {
  const n = stride * rows, near = new Float64Array(n);
  let total = 0;
  for (let by = 0; by < rows; by++) for (let bx = 0; bx < stride; bx++) {
    let m = 0;
    for (let y = Math.max(0, by - 1); y <= Math.min(rows - 1, by + 1); y++) for (let x = Math.max(0, bx - 1); x <= Math.min(stride - 1, bx + 1); x++) m = Math.max(m, bound[y * stride + x]);
    near[by * stride + bx] = m; total += m;
  }
  const b = 0.375 * total / n;
  if (!(b < 0.5)) return near.fill(Infinity);
  return near.map(E => (0.375 * E + b) / (1 - b) + 1e-12);
}
export function maskDoubtOver(doubt, stride, bx, by, bw, bh) {
  if (typeof doubt === 'number') return doubt;
  let m = 0;
  for (let y = by; y < by + bh; y++) for (let x = bx; x < bx + bw; x++) m = Math.max(m, doubt[y * stride + x]);
  return m;
}
export const maskDoubtMax = doubt => typeof doubt === 'number' ? doubt : doubt.reduce((m, v) => Math.max(m, v), 0);
export function maskWeights(hf, stride, rows) {
  const n = stride * rows, eroded = new Float64Array(n), weight = new Float64Array(n);
  let wSum = 0;
  for (let by = 0; by < rows; by++) for (let bx = 0; bx < stride; bx++) {
    let m0 = Infinity, m1 = Infinity, m2 = Infinity;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const ny = Math.max(0, Math.min(rows - 1, by + dy)), nx = Math.max(0, Math.min(stride - 1, bx + dx));
      const v = hf[ny * stride + nx];
      if (v < m0) { m2 = m1; m1 = m0; m0 = v; }
      else if (v < m1) { m2 = m1; m1 = v; }
      else if (v < m2) { m2 = v; }
    }
    const er = 0.45 * m0 + 0.30 * m1 + 0.25 * m2, b = by * stride + bx;
    eroded[b] = er;
    const w = 1 + 3.0 / (0.5 * er + 2.0);
    weight[b] = w;
    wSum += w;
  }
  const norm = n / (wSum || 1);
  for (let b = 0; b < n; b++) weight[b] *= norm;
  return {hf, eroded, weight};
}
