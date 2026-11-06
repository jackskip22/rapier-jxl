// SPDX-License-Identifier: MIT
export function perceptualMaskField(planes, stride, rows, rowsOf = () => ({planes, top: 0})) {
  const steps = perceptualMaskSteps(stride, rows, rowsOf);
  for (;;) { const step = steps.next(); if (step.done) return step.value; }
}
export function* perceptualMaskSteps(stride, rows, rowsOf) {
  const hf = new Float64Array(stride * rows);
  for (let by = 0; by < rows; by++) { const {planes: p, top} = rowsOf(by); maskEnergy(p, top, stride, by, by + 1, hf); yield; }
  return maskWeights(hf, stride, rows);
}
export function maskEnergy(planes, top, stride, by0, by1, hf) {
  maskEnergyRange(planes, top, stride, by0 * stride, by1 * stride, hf);
}
export function maskEnergyRange([X, Y, B], top, stride, from, to, hf) {
  const W = stride * 8, endRow = Math.ceil(to / stride);
  for (let by = Math.floor(from / stride); by < endRow; by++) for (let bx = Math.max(0, from - by * stride); bx < Math.min(stride, to - by * stride); bx++) {
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
export function maskWeightDoubts(bound, stride, rows, eroded = null) {
  const n = stride * rows, rel = new Float64Array(n);
  const total = maskDoubtSumsRange(bound, stride, rows, eroded, rel, 0, n, 0), b = total / n;
  normalizeMaskDoubts(rel, b, 0, n);
  return rel;
}
export function maskDoubtSumsRange(bound, stride, rows, eroded, rel, from, to, total) {
  const endRow = Math.ceil(to / stride);
  for (let by = Math.floor(from / stride); by < endRow; by++) for (let bx = Math.max(0, from - by * stride); bx < Math.min(stride, to - by * stride); bx++) {
    let E = 0;
    for (let y = Math.max(0, by - 1); y <= Math.min(rows - 1, by + 1); y++) for (let x = Math.max(0, bx - 1); x <= Math.min(stride - 1, bx + 1); x++) E = Math.max(E, bound[y * stride + x]);
    const b = by * stride + bx;
    let r = 0.375 * E, w = 1;
    if (eroded) {
      const m = Math.max(0, eroded[b] - E);
      r = Math.min(r, 1.5 * E / ((0.5 * m + 2) * (0.5 * m + 5)));
      w = 1 + 3 / (0.5 * eroded[b] + 2);
    }
    rel[b] = r; total += r * w;
  }
  return total;
}
export function normalizeMaskDoubts(rel, b, from, to) {
  if (!(b < 0.5)) { rel.fill(Infinity, from, to); return; }
  for (let i = from; i < to; i++) rel[i] = (rel[i] + b) / (1 - b) + 1e-12;
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
  const wSum = maskWeightsRange(hf, stride, rows, eroded, weight, 0, n, 0), norm = n / (wSum || 1);
  normalizeMaskWeights(weight, norm, 0, n);
  return {hf, eroded, weight};
}
export function maskWeightsRange(hf, stride, rows, eroded, weight, from, to, wSum) {
  const endRow = Math.ceil(to / stride);
  for (let by = Math.floor(from / stride); by < endRow; by++) for (let bx = Math.max(0, from - by * stride); bx < Math.min(stride, to - by * stride); bx++) {
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
  return wSum;
}
export function normalizeMaskWeights(weight, norm, from, to) {
  for (let b = from; b < to; b++) weight[b] *= norm;
}

