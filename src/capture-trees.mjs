// SPDX-License-Identifier: MIT
import {leaf, split} from './modular.mjs';
import {captureResiduals} from './capture-kernels.mjs';

const PROPERTIES = [15, 9, 10, 11, 12, 13, 14, 4, 5, 6, 7, 8, 2, 3];
const PREDICTORS = [5, 6, 1, 2, 3, 4, 0, 11, 7, 10, 12];
const BINS = 32, TOKENS = 48, SAMPLES = 65536, NP = PROPERTIES.length, NK = PREDICTORS.length;

const token = v => v < 16 ? v : 16 + ((31 - Math.clz32(v) - 4) << 1 | (v >>> (30 - Math.clz32(v))) & 1);
const rawBits = v => v < 16 ? 0 : 30 - Math.clz32(v);
const pack = r => r >= 0 ? r * 2 : -r * 2 - 1;

function prediction(p, plane, width, i, x, y, w, n, nw, weighted) {
  switch (p) {
    case 0: return 0;
    case 1: return w;
    case 2: return n;
    case 3: return (w + n) / 2 | 0;
    case 4: { const g = w + n - nw; return Math.abs(g - w) < Math.abs(g - n) ? w : n; }
    case 5: { const lo = w < n ? w : n, hi = w < n ? n : w, g = w + n - nw; return g < lo ? lo : g > hi ? hi : g; }
    case 6: return weighted;
  }
  const ne = y && x + 1 < width ? plane[i - width + 1] : n;
  if (p === 7) return ne;
  if (p === 10) return (w + nw) / 2 | 0;
  if (p === 11) return (nw + n) / 2 | 0;
  return (n + ne) / 2 | 0;
}
function property(p, plane, width, i, x, y, w, n, nw, wp) {
  switch (p) {
    case 2: return y;
    case 3: return x;
    case 4: return Math.abs(n);
    case 5: return Math.abs(w);
    case 6: return n;
    case 7: return w;
    case 9: return w + n - nw;
    case 10: return w - nw;
    case 11: return nw - n;
    case 12: return n - (y && x + 1 < width ? plane[i - width + 1] : n);
    case 13: return n - (y > 1 ? plane[i - 2 * width] : n);
    case 14: return w - (x > 1 ? plane[i - 2] : w);
    case 15: return wp;
  }
  if (!x) return w;
  const pw = x > 1 ? plane[i - 2] : y ? plane[i - width - 1] : 0, pn = y ? plane[i - width - 1] : pw, pnw = x > 1 && y ? plane[i - width - 2] : pw;
  return w - (pw + pn - pnw);
}

function weighted(plane, w, h) {
  const residuals = new Uint32Array(w * h), properties = new Int32Array(w * h);
  captureResiduals(plane, w, h, residuals, properties);
  return {residuals, properties};
}
const nlogs = new Map();
function nlogTable(n) {
  let t = nlogs.get(n);
  if (!t) { t = new Float64Array(n + 1); for (let i = 2; i <= n; i++) t[i] = i * Math.log2(i); nlogs.set(n, t); }
  return t;
}

export function learnTree(plane, w, h, {nodes = 119, gain = 64, min = 64, samples = SAMPLES} = {}, answer = null) {
  const n = w * h;
  if (n < 4096) return null;
  nodes = Math.min(nodes, 2 * Math.ceil(Math.min(n, samples) / 1024) + 1);
  const {residuals, properties: wpProperty} = answer || weighted(plane, w, h);
  const k = Math.max(1, Math.ceil(n / Math.min(samples, Math.max(8192, samples > SAMPLES ? n : n >> 2)))), m = Math.ceil(n / k);
  const values = Array.from({length: NP}, () => new Int32Array(m)), bins = Array.from({length: NP}, () => new Uint8Array(m));
  const tokens = Array.from({length: NK}, () => new Uint8Array(m)), raws = Array.from({length: NK}, () => new Uint8Array(m));
  for (let s = 0, i = 0; s < m; s++, i += k) {
    const x = i % w, y = i / w | 0, W = x ? plane[i - 1] : y ? plane[i - w] : 0, N = y ? plane[i - w] : W, NW = x && y ? plane[i - w - 1] : W;
    const v = plane[i], wpPred = v - ((residuals[i] & 1 ? -((residuals[i] + 1) >> 1) : residuals[i] >> 1));
    for (let q = 0; q < NP; q++) values[q][s] = property(PROPERTIES[q], plane, w, i, x, y, W, N, NW, wpProperty[i]);
    for (let q = 0; q < NK; q++) {
      const r = PREDICTORS[q] === 6 ? residuals[i] : pack(v - prediction(PREDICTORS[q], plane, w, i, x, y, W, N, NW, wpPred));
      tokens[q][s] = token(r); raws[q][s] = rawBits(r);
    }
  }
  const cuts = values.map((column, q) => {
    const sorted = Int32Array.from(column).sort(), list = [];
    for (let b = 1; b < BINS; b++) { const c = sorted[Math.floor(b * m / BINS)]; if (!list.length || c > list[list.length - 1]) list.push(c); }
    if (list.length && list[list.length - 1] >= sorted[m - 1]) list.pop();
    for (let s = 0; s < m; s++) {
      let lo = 0, hi = list.length;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (column[s] > list[mid]) lo = mid + 1; else hi = mid; }
      bins[q][s] = lo;
    }
    return list;
  });
  let span = 1;
  for (let q = 0; q < NK; q++) for (let s = 0; s < m; s++) if (tokens[q][s] >= span) span = tokens[q][s] + 1;
  const nlog = nlogTable(m), counts = new Uint32Array(NP * BINS * NK * TOKENS), rawCounts = new Float64Array(NP * BINS * NK);
  const order = new Int32Array(m).map((_, s) => s), scratch = new Int32Array(m);
  const cost = (hist, at, total, raw) => {
    if (!total) return 0;
    let bits = nlog[total] + raw, used = 0;
    for (let t = 0; t < span; t++) { const c = hist[at + t]; if (c) { bits -= nlog[c]; used++; } }
    return bits + 5 * used;
  };
  const low = new Uint32Array(NK * TOKENS), all = new Uint32Array(NK * TOKENS), lowRaw = new Float64Array(NK), allRaw = new Float64Array(NK);
  let made = 1;
  const ranked = new Int32Array(NK), costs = new Float64Array(NK), TOP = 3;
  const grow = (from, to) => {
    const size = to - from;
    all.fill(0); allRaw.fill(0);
    for (let j = from; j < to; j++) { const s = order[j]; for (let q = 0; q < NK; q++) { all[q * TOKENS + tokens[q][s]]++; allRaw[q] += raws[q][s]; } }
    for (let q = 0; q < NK; q++) { costs[q] = cost(all, q * TOKENS, size, allRaw[q]); ranked[q] = q; }
    ranked.sort((a, b) => costs[a] - costs[b]);
    const best = ranked[0], here = costs[best], node = leaf(PREDICTORS[best]);
    if (made + 2 > nodes || size < 2 * min) return node;
    const top = ranked.subarray(0, TOP);
    counts.fill(0, 0, NP * BINS * TOP * TOKENS); rawCounts.fill(0, 0, NP * BINS * TOP);
    const t0 = tokens[top[0]], t1 = tokens[top[1]], t2 = tokens[top[2]], r0 = raws[top[0]], r1 = raws[top[1]], r2 = raws[top[2]];
    for (let j = from; j < to; j++) {
      const s = order[j], a = t0[s], b = TOKENS + t1[s], c = 2 * TOKENS + t2[s], ra = r0[s], rb = r1[s], rc = r2[s];
      for (let p = 0; p < NP; p++) {
        const base = (p * BINS + bins[p][s]) * TOP, at = base * TOKENS;
        counts[at + a]++; counts[at + b]++; counts[at + c]++;
        rawCounts[base] += ra; rawCounts[base + 1] += rb; rawCounts[base + 2] += rc;
      }
    }
    let saving = gain, property = -1, cut = 0;
    for (let p = 0; p < NP; p++) {
      const used = cuts[p].length;
      if (!used) continue;
      low.fill(0, 0, TOP * TOKENS); lowRaw.fill(0, 0, TOP);
      let lowSize = 0;
      for (let c = 0; c < used; c++) {
        const base = (p * BINS + c) * TOP;
        for (let r = 0; r < TOP; r++) {
          for (let t = 0; t < span; t++) { const v = counts[(base + r) * TOKENS + t]; if (v) low[r * TOKENS + t] += v; }
          lowRaw[r] += rawCounts[base + r];
        }
        for (let t = 0; t < span; t++) lowSize += counts[base * TOKENS + t];
        if (lowSize < min || size - lowSize < min) continue;
        let lowCost = Infinity, highCost = Infinity;
        for (let r = 0; r < TOP; r++) {
          const q = top[r], a = cost(low, r * TOKENS, lowSize, lowRaw[r]);
          if (a < lowCost) lowCost = a;
          let bits = nlog[size - lowSize] + allRaw[q] - lowRaw[r], usedHigh = 0;
          for (let t = 0; t < span; t++) { const v = all[q * TOKENS + t] - low[r * TOKENS + t]; if (v) { bits -= nlog[v]; usedHigh++; } }
          bits += 5 * usedHigh;
          if (bits < highCost) highCost = bits;
        }
        const save = here - lowCost - highCost;
        if (save > saving) { saving = save; property = p; cut = c; }
      }
    }
    if (property < 0) return node;
    let a = from, z = 0;
    for (let j = from; j < to; j++) { const s = order[j]; if (bins[property][s] > cut) order[a++] = s; else scratch[z++] = s; }
    order.set(scratch.subarray(0, z), a);
    made += 2;
    const left = grow(from, a), right = grow(a, to);
    return split(PROPERTIES[property], cuts[property][cut], left, right);
  };
  const tree = grow(0, m), leaves = [];
  const collect = node => { if (node.left) { collect(node.left); collect(node.right); } else { node.local = leaves.length; leaves.push(node); } };
  collect(tree);
  if (leaves.length === 1) return null;
  return {tree, leaves, ...codePlane(tree, plane, w, h, residuals, wpProperty)};
}
function codePlane(tree, plane, w, h, residuals, wpProperty) {
  const n = w * h, coded = new Uint16Array(n), contexts = new Uint8Array(n);
  for (let i = 0, x = 0, y = 0; i < n; i++, x++) {
    if (x === w) { x = 0; y++; }
    const W = x ? plane[i - 1] : y ? plane[i - w] : 0, N = y ? plane[i - w] : W, NW = x && y ? plane[i - w - 1] : W;
    let node = tree;
    while (node.left) node = property(node.property, plane, w, i, x, y, W, N, NW, wpProperty[i]) > node.splitval ? node.left : node.right;
    contexts[i] = node.local;
    const p = node.predictor, v = plane[i];
    if (p === 6) coded[i] = residuals[i];
    else coded[i] = pack(v - prediction(p, plane, w, i, x, y, W, N, NW, 0));
  }
  return {values: coded, contexts};
}

const learnedPlanes = new Map(), KEPT = 256;
function planeKey(plane, w, h) {
  let a = 2166136261, b = 0;
  for (let i = 0; i < plane.length; i++) { a = Math.imul(a ^ plane[i], 16777619); b = b + plane[i] * (i + 1) | 0; }
  return w + 'x' + h + ':' + (a >>> 0) + ':' + (b >>> 0);
}
export function learnedModel(plane, w, h, answer = null, options = undefined) {
  const key = planeKey(plane, w, h) + (options ? ':' + options.samples : '');
  let learned = learnedPlanes.get(key);
  if (learned === undefined) {
    if (learnedPlanes.size >= KEPT) learnedPlanes.delete(learnedPlanes.keys().next().value);
    learned = learnTree(plane, w, h, options, answer);
    learnedPlanes.set(key, learned && {tree: learned.tree, leaves: learned.leaves});
  } else if (learned) {
    const {residuals, properties} = answer || weighted(plane, w, h);
    learned = {...learned, ...codePlane(learned.tree, plane, w, h, residuals, properties)};
  }
  if (!learned) return null;
  const {tree, leaves, values, contexts} = learned, n = w * h;
  return {kind: 'smooth', tree, leaves, classes: leaves.length, width: w, height: h, stride: w, origin: 0, plane, minimum: 4,
    count: n, pieceValue: Int32Array.from(values), pieceDistance: new Int32Array(n), pieceContext: contexts};
}
