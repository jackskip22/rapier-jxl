// SPDX-License-Identifier: MIT
import {packSigned} from './bits.mjs';
import {kernelHooks, ensured, missing, declined} from './kernel-hooks.mjs';
import {writeSmallestContextMap} from './context-map.mjs';
import {NONZERO_BUCKETS, ZERO_DENSITY_CONTEXTS, ORDERS} from './dct8-contexts.mjs';

const ORDER_CLASS = [0, 1, 2, 2, 3, 4, 5, 6, 7, 7, 7, 7, 7];
export const DESIGNS = {
  dcBuckets: grey => (row, ord, i, n) => row === 0 ? i : grey ? n : row === 1 ? n + (i >> 1) : n + ((n - 1) >> 1) + 1 + (i >> 1),
  sizes: grey => (row, ord) => (grey && row ? 1 : row) * 2 + (ord ? 1 : 0),
  sizesShared: () => (row, ord) => (row ? 2 : 0) + (ord ? 1 : 0),
  sizes3: grey => (row, ord) => (grey && row ? 1 : row) * 3 + (ORDER_CLASS[ord] === 0 ? 0 : ORDER_CLASS[ord] === 2 ? 1 : 2),
  sizes3Shared: () => (row, ord) => (row ? 3 : 0) + (ORDER_CLASS[ord] === 0 ? 0 : ORDER_CLASS[ord] === 2 ? 1 : 2),
  sizesDc: grey => (row, ord, i, n) => {
    const b = n <= 2 ? i : (i * 2 / n) | 0;
    if (row === 0) return (ORDER_CLASS[ord] ? 2 : 0) + b;
    if (grey) return 4 + (ORDER_CLASS[ord] ? 1 : 0);
    return 4 + (row - 1) * 2 + (ORDER_CLASS[ord] ? 1 : 0);
  },
  fine: () => (row, ord, i, n) => (row * 8 + ORDER_CLASS[ord]) * n + i,
  standard: () => (row, ord) => (row ? STANDARD_CHROMA : STANDARD_LUMA)[ord],
  dcShared: grey => (row, ord, i, n) => row === 0 ? i : grey ? n : n + (i >> 1),
  ...((typeof __RAPIER_JXL_RECOMPRESS__ === 'undefined' || __RAPIER_JXL_RECOMPRESS__ === true) && {
    dcChroma1: grey => (row, ord, i, n) => row === 0 ? i : n + (grey ? 0 : row - 1),
    dcChroma2: grey => (row, ord, i, n) => row === 0 ? i : n + (grey ? 0 : (row - 1) * Math.min(2, (n + 1) >> 1) + ((i >> 1) >= ((n + 3) >> 2) ? 1 : 0)),
  }),
};
const STANDARD_LUMA = [0, 1, 2, 2, 3, 3, 4, 5, 6, 6, 6, 6, 6], STANDARD_CHROMA = [7, 8, 9, 9, 10, 11, 12, 13, 14, 14, 14, 14, 14];
const isStandard = c => !c.thresholds.length && c.map.every((v, i) => v === DESIGNS.standard()(i >= ORDERS ? 1 : 0, i % ORDERS));
export function blockContexts(luma, thresholdsWanted, grey, design = DESIGNS.dcBuckets(grey)) {
  const thresholds = [];
  if (thresholdsWanted > 0) {
    let low = -1024, high = 1023, total = 0;
    for (const value of luma) { if (value < low) low = value; else if (value > high) high = value; }
    const counts = new Uint32Array(high - low + 1);
    for (const value of luma) { counts[value - low]++; total++; }
    let cumulative = 0, cut = total / (thresholdsWanted + 1);
    for (let j = 0; j < counts.length && thresholds.length < thresholdsWanted; j++) {
      cumulative += counts[j];
      if (cumulative > cut) { thresholds.push(j + low - 1); cut = total * (thresholds.length + 1) / (thresholdsWanted + 1); }
    }
  }
  return contextsFromThresholds(thresholds, grey, design);
}
export function contextsFromThresholds(thresholds, grey, design = DESIGNS.dcBuckets(grey)) {
  const numDc = thresholds.length + 1, map = new Uint8Array(3 * ORDERS * numDc);
  for (let row = 0; row < 3; row++) for (let ord = 0; ord < ORDERS; ord++) for (let i = 0; i < numDc; i++) map[(row * ORDERS + ord) * numDc + i] = design(row, ord, i, numDc);
  let numCtxs = 0;
  for (const v of map) numCtxs = Math.max(numCtxs, v + 1);
  const bucketOf = value => { let b = 0; for (const t of thresholds) if (value > t) b++; return b; };
  return {thresholds, numDc, map, numCtxs, bucketOf, ...acContexts(map, numDc, numCtxs)};
}

export function acContexts(map, numDc, numCtxs) {
  return {contextOf: (c, bucket, ord = 0) => map[((c < 2 ? c ^ 1 : 2) * ORDERS + ord) * numDc + bucket],
    nonZero: (predicted, blockCtx) => (Math.min(predicted, 64) < 8 ? Math.min(predicted, 64) : 4 + (Math.min(predicted, 64) >> 1)) * numCtxs + blockCtx,
    zeroDensityOffset: blockCtx => numCtxs * NONZERO_BUCKETS + ZERO_DENSITY_CONTEXTS * blockCtx,
    contexts: numCtxs * (NONZERO_BUCKETS + ZERO_DENSITY_CONTEXTS)};
}

export function writeBlockContexts(w, contexts) {
  if (isStandard(contexts)) { w.write(1, 1); return; }
  w.write(1, 0); w.write(4, 0);
  w.write(4, contexts.thresholds.length);
  for (const t of contexts.thresholds) w.writeU32([[4, 0], [8, 16], [16, 272], [32, 65808]], packSigned(t));
  w.write(4, 0); w.write(4, 0);
  writeSmallestContextMap(w, contexts.map);
}


export function write3DBlockContexts(w, dcThresholds, map) {
  w.write(1, 0);
  for (let c = 0; c < 3; c++) {
    const list = dcThresholds[c];
    w.write(4, list.length);
    for (const t of list) w.writeU32([[4, 0], [8, 16], [16, 272], [32, 65808]], packSigned(t));
  }
  w.write(4, 0);
  writeSmallestContextMap(w, map, true);
}

function dcSignaturePlan(dcVals, dim) {
  let low = Infinity, high = -Infinity;
  for (const v of dcVals) { if (v < low) low = v; if (v > high) high = v; }
  const span = high - low + 1, valCounts = new Uint32Array(span), cuts = [];
  for (const v of dcVals) valCounts[v - low]++;
  const M = Math.min(96, span), tot = dcVals.length;
  let cum = 0;
  for (let j = 0; j < span && cuts.length < M - 1; j++) {
    cum += valCounts[j];
    if (cum >= tot * (cuts.length + 1) / M && j < span - 1) cuts.push(j + low);
  }
  const buckets = new Uint8Array(span);
  for (let j = 0, b = 0; j < span; j++) {
    while (b < cuts.length && j + low > cuts[b]) b++;
    buckets[j] = b;
  }
  return {low, cuts, buckets, dim, histograms: new Float64Array((cuts.length + 1) * dim)};
}

function dpChannelThresholds(plan, numBins) {
  const {cuts, dim: sigDim, histograms} = plan;
  if (numBins <= 1) return [];
  if (cuts.length < numBins - 1) return cuts;
  const B = cuts.length + 1, binHist = Array.from({length: B}, (_, b) => histograms.subarray(b * sigDim, (b + 1) * sigDim));
  const pref = Array.from({length: B + 1}, () => new Float64Array(sigDim));
  for (let b = 0; b < B; b++) for (let d = 0; d < sigDim; d++) pref[b + 1][d] = pref[b][d] + binHist[b][d];
  const costMat = new Float64Array((B + 1) * (B + 1));
  for (let a = 0; a < B; a++) for (let b = a + 1; b <= B; b++) {
    let n = 0, s = 0;
    for (let d = 0; d < sigDim; d++) { const c = pref[b][d] - pref[a][d]; if (c > 0) { n += c; s += c * Math.log2(c); } }
    costMat[a * (B + 1) + b] = n > 0 ? n * Math.log2(n) - s : 0;
  }
  const K = Math.min(numBins, B);
  const dp = Array.from({length: K + 1}, () => new Float64Array(B + 1).fill(Infinity));
  const back = Array.from({length: K + 1}, () => new Int32Array(B + 1).fill(-1));
  dp[0][0] = 0;
  for (let k = 1; k <= K; k++) for (let b = k; b <= B; b++) for (let a = k - 1; a < b; a++) {
    const v = dp[k - 1][a] + costMat[a * (B + 1) + b];
    if (v < dp[k][b]) { dp[k][b] = v; back[k][b] = a; }
  }
  const chosen = [];
  for (let k = K, b = B; k > 1; k--) { const a = back[k][b]; chosen.unshift(cuts[a - 1]); b = a; }
  return chosen;
}

function jpegContextKernels() {
  const kernels = (kernelHooks.entropy ?? ensured().entropy ?? missing())();
  if (!kernels?.jpegSignatureHistogram || !kernels.jpegHistograms) throw declined('jpegContexts');
  return kernels;
}

function buildDc3dSignatures(comps, dcs, hshifts, vshifts, xsizeBlocks, ysizeBlocks, loadBand = null) {
  const plans = dcs.map((dc, c) => dcSignaturePlan(dc, c === 1 ? 16 : 8));
  const kernels = jpegContextKernels(), gyCount = Math.ceil(ysizeBlocks / 32);
  for (let gy = 0; gy < gyCount; gy++) {
    loadBand?.(gy);
    for (let c = 0; c < 3; c++) {
      const width = xsizeBlocks >> hshifts[c], height = ysizeBlocks >> vshifts[c];
      const row = (gy * 32) >> vshifts[c], rows = Math.min(32 >> vshifts[c], height - row);
      const comp = comps[c], start = (row - (comp.row0 ?? 0)) * comp.stride * 64;
      kernels.jpegSignatureHistogram(comp.coeffs.subarray(start, start + rows * comp.stride * 64), width, rows,
        comp.stride, dcs[c].subarray(row * width, (row + rows) * width), plans[c]);
    }
  }
  return {xSig: plans[0], ySig: plans[1], bSig: plans[2]};
}

export function learn3DBlockContexts(comps, dcs, hshifts, vshifts, xsizeBlocks, ysizeBlocks, shapeSpec, sigCache = null, loadBand = null) {
  const [binsX, binsY, binsB] = shapeSpec;
  const sigs = sigCache || buildDc3dSignatures(comps, dcs, hshifts, vshifts, xsizeBlocks, ysizeBlocks, loadBand);
  const threshX = dpChannelThresholds(sigs.xSig, binsX);
  const threshY = dpChannelThresholds(sigs.ySig, binsY);
  const threshB = dpChannelThresholds(sigs.bSig, binsB);
  const dcThresholds = [threshX, threshY, threshB];
  const nx = threshX.length + 1, ny = threshY.length + 1, nb = threshB.length + 1, numDc = nx * ny * nb;
  const bucketOf = (v, list) => { let n = 0; for (const t of list) if (v > t) n++; return n; };
  const lumaBuckets = new Uint8Array(xsizeBlocks * ysizeBlocks);
  const xDcWidth = xsizeBlocks >> hshifts[0], bDcWidth = xsizeBlocks >> hshifts[2];
  for (let y = 0; y < ysizeBlocks; y++) for (let x = 0; x < xsizeBlocks; x++) {
    const bx = bucketOf(dcs[0][(y >> vshifts[0]) * xDcWidth + (x >> hshifts[0])], threshX);
    const by = bucketOf(dcs[1][y * xsizeBlocks + x], threshY);
    const bb = bucketOf(dcs[2][(y >> vshifts[2]) * bDcWidth + (x >> hshifts[2])], threshB);
    lumaBuckets[y * xsizeBlocks + x] = (bx * nb + bb) * ny + by;
  }

  const HLEN = 32, rowHists = Array.from({length: 3}, () => new Float64Array(numDc * HLEN));
  const cellHists = Array.from({length: 3 * numDc}, (_, i) => rowHists[Math.floor(i / numDc)].subarray((i % numDc) * HLEN, (i % numDc + 1) * HLEN));
  const kernels = jpegContextKernels(), gyCount = Math.ceil(ysizeBlocks / 32);
  for (let gy = 0; gy < gyCount; gy++) {
    loadBand?.(gy);
    const row0 = gy * 32, lumaRows = Math.min(32, ysizeBlocks - row0);
    const buckets = lumaBuckets.subarray(row0 * xsizeBlocks, (row0 + lumaRows) * xsizeBlocks);
    for (const [row, c] of [[0, 1], [1, 0], [2, 2]]) {
      const width = xsizeBlocks >> hshifts[c], height = ysizeBlocks >> vshifts[c];
      const y0 = row0 >> vshifts[c], rows = Math.min(32 >> vshifts[c], height - y0);
      const comp = comps[c], start = (y0 - (comp.row0 ?? 0)) * comp.stride * 64;
      kernels.jpegHistograms(comp.coeffs.subarray(start, start + rows * comp.stride * 64), width, rows, comp.stride,
        buckets, xsizeBlocks, hshifts[c], vshifts[c], rowHists[row]);
    }
  }

  const entOf = f => {
    let tot = 0, sum = 0;
    for (let i = 0; i < HLEN; i++) if (f[i] > 0) { tot += f[i]; sum += f[i] * Math.log2(f[i]); }
    return tot > 0 ? tot * Math.log2(tot) - sum : 0;
  };
  const clusters = [], emptyCells = [];
  for (let id = 0; id < 3 * numDc; id++) {
    const f = cellHists[id];
    let tot = 0; for (let i = 0; i < HLEN; i++) tot += f[i];
    if (tot === 0) emptyCells.push(id);
    else clusters.push({cells: [id], kind: id < numDc ? 0 : 1, freqs: Float64Array.from(f), bits: entOf(f)});
  }
  const tmp = new Float64Array(HLEN);
  while (clusters.length > 16) {
    let bestCost = Infinity, bestA = 0, bestB = 1;
    for (let a = 0; a < clusters.length; a++) for (let b = a + 1; b < clusters.length; b++) {
      if (clusters[a].kind !== clusters[b].kind) continue;
      for (let i = 0; i < HLEN; i++) tmp[i] = clusters[a].freqs[i] + clusters[b].freqs[i];
      const delta = entOf(tmp) - clusters[a].bits - clusters[b].bits;
      if (delta < bestCost) { bestCost = delta; bestA = a; bestB = b; }
    }
    const ca = clusters[bestA], cb = clusters[bestB];
    ca.cells.push(...cb.cells);
    for (let i = 0; i < HLEN; i++) ca.freqs[i] += cb.freqs[i];
    ca.bits = entOf(ca.freqs);
    clusters.splice(bestB, 1);
  }
  clusters.sort((a, b) => a.kind - b.kind || Math.min(...a.cells) - Math.min(...b.cells));
  const cellToCtx = new Uint8Array(3 * numDc);
  clusters.forEach((cl, idx) => { cl.cells.sort((a, b) => a - b); for (const cell of cl.cells) cellToCtx[cell] = idx; });
  for (const cell of emptyCells) {
    const row = Math.floor(cell / numDc), local = cell % numDc;
    let bestDist = Infinity, chosen = row === 0 ? 0 : clusters.length - 1;
    for (let idx = 0; idx < clusters.length; idx++) for (const c2 of clusters[idx].cells) {
      if (Math.floor(c2 / numDc) === row && Math.abs((c2 % numDc) - local) < bestDist) { bestDist = Math.abs((c2 % numDc) - local); chosen = idx; }
    }
    cellToCtx[cell] = chosen;
  }
  const map = new Uint8Array(3 * ORDERS * numDc);
  for (let row = 0; row < 3; row++) for (let ord = 0; ord < ORDERS; ord++) for (let d = 0; d < numDc; d++) map[(row * ORDERS + ord) * numDc + d] = cellToCtx[row * numDc + d];
  const renOrder = new Int16Array(clusters.length).fill(-1);
  let nextId = 0;
  for (let i = 0; i < map.length; i++) {
    if (renOrder[map[i]] < 0) renOrder[map[i]] = nextId++;
    map[i] = renOrder[map[i]];
  }
  return {thresholds: [1], dcThresholds, numDc, map, numCtxs: nextId, lumaBuckets, sigs};
}
