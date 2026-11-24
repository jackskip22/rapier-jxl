// SPDX-License-Identifier: MIT
import {jpegEffortSteps} from './jpeg-effort.mjs';
import {coefficientEffortSteps, coefficientOrderSteps, candidateSteps, prefetch} from './coefficient-effort.mjs';
import {buildAnsCoding, writeModularAnsHistograms} from './ans.mjs';
import {JPEG_ANS} from './jpeg-ans-configs.mjs';
import {lfCoderFor, fixedLfCoder, quickOrFixedLfCoder, richLfCoder, jpegFastLfCoder, jpegBroadOrFastLfCoder, jpegTenLfCoder} from './lf-coding.mjs';
import {BitWriter, part, scaled} from './bits.mjs';
import {uintConfig, countToken, buildCode, writeHistograms, writeHybrid} from './prefix.mjs';
import {TokenCounts, buildTokenCoding} from './entropy.mjs';
import {predictICC} from './icc-profile.mjs';
import {prepareICC, lzICC, writeLength as writeIccLength} from './icc-write.mjs';
import {kernelHooks, ensured, missing, declined} from './kernel-hooks.mjs';
import {SCAN} from './dct8-contexts.mjs';
import {offloading} from './offload.mjs';
import {jpegJob} from './jpeg-job.mjs';
import {GROUP_DIM} from './frame.mjs';
import {varDCTLayout} from './vardct-header.mjs';
import {unit, journaling} from './step-journal.mjs';

export const PREFIX_LADDER_PIXELS = 512 * 512;
const SMALL_PIXELS = 1 << 21;
const twins = (jpeg, clusters, keepFloor = false) => {
  const list = [clusters];
  if (keepFloor && clusters.jpeg && clusters.headerAware)
    list.push({...clusters, headerAware: false, shapedMerge: false});
  if (jpeg.width * jpeg.height <= SMALL_PIXELS && clusters.jpeg)
    list.push({maxClusters: clusters.maxClusters, seeds: clusters.seeds, newClusterCost: clusters.newClusterCost, ...clusters.everyConfig && {everyConfig: true}});
  return list;
};
const WIDE = {maxClusters: 128, seeds: 255, newClusterCost: 160, jpeg: JPEG_ANS};
const SHAPED_WIDE = {...WIDE, headerAware: true, shapedMerge: true};
const WIDEST = {maxClusters: 255, seeds: 255, newClusterCost: 80, headerAware: true, shapedMerge: true, jpeg: JPEG_ANS};
const NARROW = {maxClusters: 48};
const EVERY_WIDE = {...SHAPED_WIDE, everyConfig: true}, EVERY_WIDEST = {...WIDEST, everyConfig: true};
const FINE_WIDE = {...SHAPED_WIDE, switchCost: 6.5, postMerge: 5}, FINE_WIDEST = {...WIDEST, newClusterCost: 64, switchCost: 6.5, postMerge: 4};
const EVERY_FINE_WIDE = {...FINE_WIDE, everyConfig: true}, EVERY_FINE_WIDEST = {...FINE_WIDEST, everyConfig: true};
const DC3D_SHAPES = [[2, 16, 2], [2, 12, 2], [4, 8, 2]];
const NATURAL_ORDER = /* @__PURE__ */ Array.from({length: 64}, (_, k) => k);
function compactOrderWriter(orders, map, limitBits) {
  const values = [];
  for (const c of map) {
    const available = Array.from({length: 64}, (_, k) => k), lehmer = orders[c].map(k => {
      const at = available.indexOf(k); available.splice(at, 1); return at;
    });
    let end = 64;
    while (end > 1 && !lehmer[end - 1]) end--;
    values.push(end - 1, ...lehmer.slice(1, end));
  }
  const n = values.length, uCtxs = new Uint16Array(n), uVals = Uint16Array.from(values);
  let best = null, bestBits = limitBits;
  for (const split of [1, 2, 3]) {
    const config = uintConfig(split), freqs = new Uint32Array(64);
    for (const v of values) countToken(config, v, freqs);
    const code = buildCode(freqs), w = new BitWriter(128);
    writeHistograms(w, {contextMap: new Uint8Array(8), histograms: [{config, code}]});
    for (const v of values) writeHybrid(w, code, config, v);
    if (w.bitLength < bestBits) { best = w; bestBits = w.bitLength; }
  }
  const counts = new TokenCounts(8);
  for (const v of values) counts.add(0, v);
  const ans = buildAnsCoding(counts, {maxClusters: 1, seeds: 1, newClusterCost: 24, smallestMap: false}), aw = new BitWriter(128);
  ans.writeHistograms(aw); ans.writeTokens(aw, uCtxs, uVals, n); ans.flush(aw);
  if (aw.bitLength < bestBits) { best = aw; bestBits = aw.bitLength; }
  return best;
}

const lfFor = effort => (typeof __RAPIER_JXL_UPLOAD__ !== 'undefined' && __RAPIER_JXL_UPLOAD__ === true) || effort <= 3 ? fixedLfCoder : effort >= 9 ? jpegBroadOrFastLfCoder : effort === 8 ? jpegFastLfCoder : effort === 7 ? richLfCoder : effort >= 5 ? lfCoderFor(effort) : quickOrFixedLfCoder;

const CFL_FIT_COST8 = /* @__PURE__ */ (() => {
  const out = new Int32Array(2049);
  for (let a = 1; a <= 2048; a++) {
    const v = a + 1, e = 31 - Math.clz32(v);
    out[a] = 16 + (e << 3) + (((v - (1 << e)) << 3) >> e);
  }
  return out;
})();
const CFL_SCAN = /* @__PURE__ */ Int32Array.from(SCAN);
export const CFL_GAIN_THRESHOLD = 96;

export function predictYcbcrCflGain(jpeg, layout = varDCTLayout(jpeg)) {
  const {comps, xsizeBlocks: bw, ysizeBlocks: bh, groupsY, grey, maxhs, maxvs, ycbcr} = layout;
  if (grey || maxhs || maxvs || !ycbcr) return 0;
  const tw = (bw + 7) >> 3;
  const qY = comps[1].quant, q0 = comps[0].quant, q2 = comps[2].quant;
  const mul = new Int32Array(64), cands = new Int32Array(4);
  const scFull0 = new Int32Array(64), scFull2 = new Int32Array(64);
  const sc60 = new Int32Array(64), sc62 = new Int32Array(64);
  for (let k = 1; k < 64; k++) {
    const f0 = ((qY[k] * 2048) / q0[k]) | 0, f2 = ((qY[k] * 2048) / q2[k]) | 0;
    scFull0[k] = f0 > 32768 ? 32768 : f0;
    scFull2[k] = f2 > 32768 ? 32768 : f2;
    const r0 = ((qY[k] << 6) / q0[k]) | 0, r2 = ((qY[k] << 6) / q2[k]) | 0;
    sc60[k] = r0 > 1024 ? 1024 : r0;
    sc62[k] = r2 > 1024 ? 1024 : r2;
  }
  const gyCount = Math.min(4, groupsY);
  let sampledTiles = 0, netEighthBits = 0;
  for (let gi = 0; gi < gyCount; gi++) {
    const gy = (((2 * gi + 1) * groupsY) / (2 * gyCount)) | 0;
    jpeg.band?.(gy);
    jpeg.unpackBand?.();
    const row0 = gy * 32, rows = Math.min(32, bh - row0), tileRows = (rows + 7) >> 3;
    const st = comps[1].stride, start = (row0 - (comps[1].row0 ?? 0)) * st * 64, len = rows * st * 64;
    const y = comps[1].coeffs.subarray(start, start + len);
    const ch0 = comps[0].coeffs.subarray(start, start + len);
    const ch2 = comps[2].coeffs.subarray(start, start + len);
    const tyCount = Math.min(2, tileRows), txCount = Math.min(8, tw);
    for (let ti = 0; ti < tyCount; ti++) {
      const ty = (((2 * ti + 1) * tileRows) / (2 * tyCount)) | 0;
      const y0 = ty * 8, y1 = Math.min(rows, y0 + 8);
      for (let xi = 0; xi < txCount; xi++) {
        const tx = (((2 * xi + 1) * tw) / (2 * txCount)) | 0;
        const x0 = tx * 8, x1 = Math.min(bw, x0 + 8);
        sampledTiles++;
        for (let ci = 0; ci < 2; ci++) {
          const c = ci === 0 ? ch0 : ch2, s6 = ci === 0 ? sc60 : sc62, sf = ci === 0 ? scFull0 : scFull2;
          let num = 0, den = 0, fit0 = 0;
          for (let by = y0; by < y1; by++) {
            for (let bx = x0; bx < x1; bx++) {
              const at = (by * st + bx) * 64;
              for (let k = 1; k < 64; k++) {
                const ck = c[at + k], yk = y[at + k];
                if (ck) {
                  const ac = ck < 0 ? -ck : ck;
                  fit0 += ac <= 2048 ? CFL_FIT_COST8[ac] : 112;
                }
                if (yk) {
                  const w = Math.imul(yk, s6[k]);
                  num += w * ck;
                  den += w * w;
                }
              }
            }
          }
          if (!fit0 || den === 0) continue;
          const nBig = BigInt(num) * 5376n, dBig = BigInt(den);
          const rBig = (nBig + (nBig >= 0n ? dBig >> 1n : -(dBig >> 1n))) / dBig;
          const fLs = rBig < -96n ? -96 : rBig > 96n ? 96 : Number(rBig);
          const step = fLs >= 0 ? -3 : 3;
          cands[0] = fLs; cands[1] = fLs + step; cands[2] = fLs - step; cands[3] = (fLs * 3) >> 2;
          let bf = 0, bestFit = fit0;
          for (let m = 0; m < 4; m++) {
            const cand = cands[m];
            if (!cand || cand < -96 || cand > 96) continue;
            const fac = ((cand * 2048) / 84) | 0;
            for (let k = 1; k < 64; k++) mul[k] = (Math.imul(fac, sf[k]) + 1024) >> 11;
            let s = 36;
            for (let by = y0; by < y1 && s < bestFit; by++) {
              for (let bx = x0; bx < x1; bx++) {
                const at = (by * st + bx) * 64;
                for (let k = 1; k < 64; k++) {
                  const ck = c[at + k], yk = y[at + k];
                  if (!ck && !yk) continue;
                  const r = ck - ((Math.imul(yk, mul[k]) + 1024) >> 11);
                  if (r < -32768 || r > 32767) { s = bestFit; break; }
                  if (r) {
                    const ar = r < 0 ? -r : r;
                    s += ar <= 2048 ? CFL_FIT_COST8[ar] : 112;
                  }
                }
              }
            }
            if (s < bestFit) { bestFit = s; bf = cand; }
          }
          if (!bf) continue;
          const fac = ((bf * 2048) / 84) | 0;
          for (let k = 1; k < 64; k++) mul[k] = (Math.imul(fac, sf[k]) + 1024) >> 11;
          let true0 = 0, true1 = 64;
          for (let by = y0; by < y1; by++) {
            for (let bx = x0; bx < x1; bx++) {
              const at = (by * st + bx) * 64;
              let nz0 = 0, last0 = 0, mag0 = 0;
              let nz1 = 0, last1 = 0, mag1 = 0;
              for (let s = 63; s >= 1; s--) {
                const k = CFL_SCAN[s], ck = c[at + k], yk = y[at + k];
                if (!ck && !yk) continue;
                const rk = ck - ((Math.imul(yk, mul[k]) + 1024) >> 11);
                if (ck) {
                  if (!last0) last0 = s;
                  nz0++;
                  const a0 = ck < 0 ? -ck : ck;
                  mag0 += 20 + (31 - Math.clz32(a0)) * 15;
                }
                if (rk) {
                  if (!last1) last1 = s;
                  nz1++;
                  const a1 = rk < 0 ? -rk : rk;
                  mag1 += 20 + (31 - Math.clz32(a1)) * 15;
                }
              }
              if (nz0) true0 += 12 + mag0 + (last0 - nz0) * 12;
              if (nz1) true1 += 12 + mag1 + (last1 - nz1) * 12;
            }
          }
          netEighthBits += true0 - true1;
        }
      }
    }
  }
  return sampledTiles > 0 ? (netEighthBits / sampledTiles) | 0 : 0;
}

export function* jpegAnsFirstSteps(jpeg, effort, fallback, retain, shared = {}, every = effort >= 9) {
  const wide = effort === 2 ? NARROW : !(typeof __RAPIER_JXL_UPLOAD__ !== 'undefined' && __RAPIER_JXL_UPLOAD__ === true) && every ? EVERY_WIDE : !(typeof __RAPIER_JXL_UPLOAD__ !== 'undefined' && __RAPIER_JXL_UPLOAD__ === true) && effort >= 5 ? SHAPED_WIDE : WIDE;
  if (effort < 2) return yield* coefficientEffortSteps(jpeg, effort, fallback, retain, shared);
  let cflGroups = 0;
  if (!(typeof __RAPIER_JXL_UPLOAD__ !== 'undefined' && __RAPIER_JXL_UPLOAD__ === true) &&
      (typeof __RAPIER_JXL_RECOMPRESS__ === 'undefined' || __RAPIER_JXL_RECOMPRESS__ === true) &&
      (effort === 6 || effort === 7) && jpeg.jpegReconstruction && !jpeg.strategyData && !jpeg.progression && !jpeg.cfl &&
      jpeg.components.length === 3) {
    const layout = varDCTLayout(jpeg);
    if (!layout.grey && !layout.maxhs && !layout.maxvs && layout.ycbcr && layout.numGroups > 64 &&
        (jpeg.band || layout.comps.every(c => c.coeffs))) {
      const gain = !journaling() && shared.ycbcrCflJpeg === jpeg ? shared.ycbcrCflGain
        : yield* unit('jpeg-cfl', () => predictYcbcrCflGain(jpeg, layout));
      if (!journaling()) { shared.ycbcrCflJpeg = jpeg; shared.ycbcrCflGain = gain; }
      if (gain >= CFL_GAIN_THRESHOLD) cflGroups = layout.numGroups;
    }
  }
  const cflPlan = cflGroups > 64 ? {cflGroups} : null;
  let ladder = jpeg.width * jpeg.height <= PREFIX_LADDER_PIXELS, best = fallback;
  const learn = !(typeof __RAPIER_JXL_UPLOAD__ !== 'undefined' && __RAPIER_JXL_UPLOAD__ === true) && effort >= 5 && !ladder;
  const first = effort <= 4 && !ladder ? 'learned' : undefined;
  if (!(typeof __RAPIER_JXL_JPEG__ !== 'undefined' && __RAPIER_JXL_JPEG__ === true || typeof __RAPIER_JXL_UPLOAD__ !== 'undefined' && __RAPIER_JXL_UPLOAD__ === true) && offloading()) yield prefetch(jpeg, [{orders: first, coding: buildAnsCoding, clusters: wide, modularAns: writeModularAnsHistograms, lfCoder: lfFor(effort), ...cflPlan},
    ...(learn ? [{orders: 'learned', coding: buildAnsCoding, clusters: wide, modularAns: writeModularAnsHistograms, lfCoder: lfFor(effort), ...cflPlan}] : [])]);
  try {
    let orders, step, hurry, reply;
    if (first) {
      const learning = coefficientOrderSteps(jpeg.components);
      try { while (!(step = learning.next()).done) yield step.value / 20; } finally { if (!step?.done) learning.return(); }
      orders = step.value;
    }
    const firsts = twins(jpeg, wide, ladder);
    for (const [k, clusters] of firsts.entries()) {
      const at = done => (orders ? 0.05 + 0.95 * done : ladder || learn ? done / 2 : done) * (k + 1) / firsts.length;
      const plan = {orders, coding: buildAnsCoding, clusters, modularAns: writeModularAnsHistograms, lfCoder: lfFor(effort), ...cflPlan};
      const candidate = candidateSteps(jpeg, plan, shared);
      while (!(step = candidate.next(reply)).done) {
        reply = undefined;
        if (typeof step.value !== 'number') { reply = yield scaled(step.value, at); continue; }
        hurry = yield at(step.value);
        if (hurry && best && step.value < 1) { candidate.return(); return best; }
      }
      if (!best || step.value.length < best.length) best = step.value;
      retain?.(step.value, plan);
      if (hurry) return best;
    }
  } catch (error) {
    if (error.code !== 'JXL_SIZE') throw error;
    if (!best) ladder = true;
  }
  if (ladder) {
    if ((yield 0.5) && best) return best;
    return yield* part(coefficientEffortSteps(jpeg, effort, best, retain, shared), 1, 2);
  }
  if (!learn || (yield 0.5)) return best;
  try {
    const learning = coefficientOrderSteps(jpeg.components);
    let step;
    while (!(step = learning.next()).done) if (yield 0.5 + step.value / 4) { learning.return(); return best; }
    const orders = step.value, list = twins(jpeg, wide, true);
    for (const [k, clusters] of list.entries()) {
      const plan = {orders, coding: buildAnsCoding, clusters, modularAns: writeModularAnsHistograms, lfCoder: lfFor(effort), ...cflPlan}, at = done => 0.75 + (k + done) / (4 * list.length);
      const candidate = candidateSteps(jpeg, plan, shared);
      let reply;
      while (!(step = candidate.next(reply)).done) {
        reply = undefined;
        if (typeof step.value !== 'number') { reply = yield scaled(step.value, at); continue; }
        if ((yield at(step.value)) && step.value < 1) { candidate.return(); return best; }
      }
      if (step.value.length < best.length) best = step.value;
      retain?.(step.value, plan);
    }
  } catch (error) {
    if (error.code !== 'JXL_SIZE') throw error;
  }
  return best;
}

const cflGrad = (w, n, nw) => Math.max(Math.min(w, n), Math.min(Math.max(w, n), w + n - nw));
function* fitEob2DCflChannelSteps(readBand, qY, qC, bw, bh, stride, wasmSeed, progressAt, kernels) {
  const tw = (bw + 7) >> 3, th = (bh + 7) >> 3, numTiles = tw * th, totalBlocks = bw * bh;
  const sc = Int32Array.from({length: 64}, (_, k) => k ? Math.trunc(2048 * qY[k] / qC[k]) : 0);
  const mulTable = new Int32Array(256 * 64);
  for (let fi = 0; fi < 256; fi++) {
    const f = fi - 128, fac = Math.trunc(f * 2048 / 84);
    for (let k = 1; k < 64; k++) mulTable[fi * 64 + k] = (fac * sc[k] + 1024) >> 11;
  }
  const nzHist = new Uint32Array(64), posNzCounts = new Uint32Array(64), magHist = new Uint32Array(1024);
  let totalNzTokens = 0;
  const scan = Int32Array.from(SCAN), gyCount = Math.ceil(bh / 32);
  for (let gy = 0; gy < gyCount; gy++) {
    const [y, c] = readBand(gy), rows = Math.min(32, bh - gy * 32), from = gy * 4 * tw;
    totalNzTokens += kernels.cflHistogram(y, c, mulTable, wasmSeed.subarray(from, from + ((rows + 7) >> 3) * tw),
      scan, bw, rows, stride, nzHist, posNzCounts, magHist);
    if (yield progressAt(0.05 * (gy + 1) / gyCount)) return null;
  }
  const orderIdx = [0, ...Array.from({length: 63}, (_, i) => i + 1).sort((a, b) => Math.floor(posNzCounts[b] / 8) - Math.floor(posNzCounts[a] / 8) || a - b)];
  const orderNatural = Int32Array.from(orderIdx, s => SCAN[s]);
  const nzBits = new Float32Array(64), zeroCostByNz = new Float32Array(64), nzBaseByNz = new Float32Array(64);
  for (let nz = 0; nz < 64; nz++) {
    nzBits[nz] = -Math.log2((nzHist[nz] + 0.5) / (totalBlocks + 32));
    if (nz > 0) {
      const pNz = Math.min(0.92, Math.max(0.06, (nz + 0.4) / Math.min(63, Math.max(nz + 1, nz * 1.65 + 3.5))));
      zeroCostByNz[nz] = -Math.log2(1 - pNz); nzBaseByNz[nz] = -Math.log2(pNz);
    }
  }
  const magBits = new Float32Array(32769), mag1Cost = 1.0 - Math.log2((magHist[1] + 1) / (totalNzTokens + 16));
  for (let a = 1; a <= 32768; a++) magBits[a] = a < 32 && magHist[a] >= 8 ? 1.0 - Math.log2(magHist[a] / (totalNzTokens + 16)) : mag1Cost + 1.85 * Math.log2(a);

  const evaluated = new Uint32Array(numTiles * 8), rowCosts = new Float32Array(tw * 256), rowLoaded = new Uint8Array(tw * 256);
  const unpriced = new Float32Array([1e18])[0];
  const tileLo = new Int16Array(numTiles), tileHi = new Int16Array(numTiles);
  const model = {multiples: mulTable, order: orderNatural, scales: sc, nzBits, zeroCostByNz, nzBaseByNz, magBits, width: bw, rows: 0, stride};
  let rowApi;
  const loadCost = (tile, fi) => {
    if (!(evaluated[tile * 8 + (fi >>> 5)] & (1 << (fi & 31)))) return unpriced;
    const at = (tile % tw) * 256 + fi;
    if (!rowLoaded[at]) { rowCosts[at] = rowApi.cost(tile % tw, fi); rowLoaded[at] = 1; }
    return rowCosts[at];
  };
  const saveCost = (tile, fi, cost) => {
    evaluated[tile * 8 + (fi >>> 5)] |= 1 << (fi & 31);
    const at = (tile % tw) * 256 + fi; rowCosts[at] = cost; rowLoaded[at] = 1;
    return cost;
  };
  const withRow = (ty, visit) => {
    const gy = ty >> 2, [y, c] = readBand(gy), from = (ty * 8 - gy * 32) * stride * 64;
    const rows = Math.min(8, bh - ty * 8), end = from + rows * stride * 64;
    return kernels.cflEobBand(y.subarray(from, end), c.subarray(from, end), {...model, rows}, api => {
      rowApi = api; rowLoaded.fill(0);
      try { return visit(); } finally { rowApi = null; }
    });
  };
  const evalTileAt = (ty, tx, fi) => rowApi.cost(tx, fi);

  for (let ty = 0; ty < th; ty++) {
    withRow(ty, () => {
    for (let tx = 0; tx < tw; tx++) {
      const tile = ty * tw + tx, [num, den] = rowApi.moments(tx);
      const fLs = den > 0 ? Math.max(-128, Math.min(127, Math.round(84 * 2048 * num / den))) : 0, fWasm = wasmSeed[tile];
      const lo = Math.max(-128, Math.min(0, fLs, fWasm) - 24), hi = Math.min(127, Math.max(0, fLs, fWasm) + 24);
      tileLo[tile] = lo + 128; tileHi[tile] = hi + 128;
      let best1F = 128, best1C = 1e18, best2F = 128, best2C = 1e18;
      const probe = fi => {
        if (fi < 0 || fi > 255) return;
        let c = loadCost(ty * tw + tx, fi);
        if (c >= 1e17) c = saveCost(ty * tw + tx, fi, evalTileAt(ty, tx, fi));
        if (c < best1C) { best2C = best1C; best2F = best1F; best1C = c; best1F = fi; }
        else if (c < best2C && Math.abs(fi - best1F) >= 3) { best2C = c; best2F = fi; }
      };
      probe(128); probe(fLs + 128); probe(fWasm + 128);
      for (let f = lo; f <= hi; f += 3) probe(f + 128);
      for (const center of [best1F, best2F, fWasm + 128, fLs + 128, 128]) for (let fi = center - 4; fi <= center + 4; fi++) probe(fi);
    }
    });
    if (yield progressAt(0.05 + 0.30 * (ty + 1) / th)) return null;
  }

  const getACCost = (ty, tx, fi) => {
    let c = loadCost(ty * tw + tx, fi);
    if (c >= 1e17) c = saveCost(ty * tw + tx, fi, evalTileAt(ty, tx, fi));
    return c;
  };
  const resCost = new Float32Array(513);
  resCost[256] = 1.25;
  for (let d = 1; d <= 256; d++) resCost[256 + d] = resCost[256 - d] = 2.6 + 1.55 * Math.log2(d + 1);
  const map = new Int8Array(numTiles);
  const tileResAt = (tx, ty, valMap) => {
    const idx = ty * tw + tx, v = valMap[idx];
    const w = tx > 0 ? valMap[idx - 1] : ty > 0 ? valMap[idx - tw] : 0;
    const n = ty > 0 ? valMap[idx - tw] : w, nw = tx > 0 && ty > 0 ? valMap[idx - tw - 1] : w;
    return resCost[256 + (v - cflGrad(w, n, nw))];
  };
  for (let ty = 0; ty < th; ty++) {
    withRow(ty, () => { for (let tx = 0; tx < tw; tx++) {
    const idx = ty * tw + tx;
    const w = tx > 0 ? map[idx - 1] : ty > 0 ? map[idx - tw] : 0;
    const n = ty > 0 ? map[idx - tw] : w, nw = tx > 0 && ty > 0 ? map[idx - tw - 1] : w, pred = cflGrad(w, n, nw);
    for (let f = pred - 2; f <= pred + 2; f++) if (f >= -128 && f <= 127) getACCost(ty, tx, f + 128);
    const lo = Math.max(0, Math.min(tileLo[idx], pred + 128)), hi = Math.min(255, Math.max(tileHi[idx], pred + 128));
    let bestF = 0, bestC = 1e18;
    for (let fi = lo; fi <= hi; fi++) {
      const ac = loadCost(idx, fi);
      if (ac >= 1e17) continue;
      const c = ac + resCost[256 + (fi - 128 - pred)];
      if (c < bestC) { bestC = c; bestF = fi - 128; }
    }
    map[idx] = bestF;
    } });
    if (yield progressAt(0.35 + 0.10 * (ty + 1) / th)) return null;
  }
  for (let iter = 0; iter < 4; iter++) {
    const rHist = new Uint32Array(513);
    for (let ty = 0; ty < th; ty++) {
      for (let tx = 0; tx < tw; tx++) {
      const idx = ty * tw + tx;
      const w = tx > 0 ? map[idx - 1] : ty > 0 ? map[idx - tw] : 0;
      const n = ty > 0 ? map[idx - tw] : w, nw = tx > 0 && ty > 0 ? map[idx - tw - 1] : w;
      rHist[256 + (map[idx] - cflGrad(w, n, nw))]++;
      }
      if (yield progressAt(0.45 + 0.55 * (iter + 0.1 * (ty + 1) / th) / 4)) return null;
    }
    for (let d = -256; d <= 256; d++) resCost[256 + d] = -Math.log2((rHist[256 + d] + (d === 0 ? 4.0 : 1.5 / (1 + d * d))) / (numTiles + 12));
    let changes = 0;
    for (let ty = 0; ty < th; ty++) {
      withRow(ty, () => { for (let tx = 0; tx < tw; tx++) {
      const idx = ty * tw + tx, oldF = map[idx];
      const w = tx > 0 ? map[idx - 1] : ty > 0 ? map[idx - tw] : 0;
      const n = ty > 0 ? map[idx - tw] : w, nw = tx > 0 && ty > 0 ? map[idx - tw - 1] : w, pred = cflGrad(w, n, nw);
      for (let f = pred - 1; f <= pred + 1; f++) if (f >= -128 && f <= 127) getACCost(ty, tx, f + 128);
      let bestF = oldF, bestC = 1e18;
      const lo = Math.max(0, Math.min(tileLo[idx], pred + 127)), hi = Math.min(255, Math.max(tileHi[idx], pred + 129));
      for (let fi = lo; fi <= hi; fi++) {
        const ac = loadCost(idx, fi);
        if (ac >= bestC) continue;
        map[idx] = fi - 128;
        let mCost = tileResAt(tx, ty, map);
        if (tx + 1 < tw) mCost += tileResAt(tx + 1, ty, map);
        if (ty + 1 < th) { mCost += tileResAt(tx === 0 ? 0 : tx, ty + 1, map); if (tx + 1 < tw) mCost += tileResAt(tx + 1, ty + 1, map); }
        if (ac + mCost < bestC) { bestC = ac + mCost; bestF = fi - 128; }
      }
      map[idx] = bestF;
      if (bestF !== oldF) changes++;
      } });
      if (yield progressAt(0.45 + 0.55 * (iter + 0.1 + 0.9 * (ty + 1) / th) / 4)) return null;
    }
    if (!changes && iter >= 1) break;
  }
  if (yield progressAt(1)) return null;
  return map;
}

function* fitHighEffortJpegCflSteps(jpeg, progressAt) {
  const kernels = (kernelHooks.entropy ?? ensured().entropy ?? missing())();
  if (!kernels?.fitCfl || !kernels.cflHistogram || !kernels.cflEobBand) throw declined('jpegCfl');
  const layout = varDCTLayout(jpeg), {comps, map: frameMap, xsizeBlocks: bw, ysizeBlocks: bh, maxhs, maxvs} = layout;
  if (layout.grey || maxhs || maxvs) return null;
  const [xComp, yComp, bComp] = comps, stride = yComp.stride;
  const tw = (bw + 7) >> 3, th = (bh + 7) >> 3, gyCount = Math.ceil(bh / 32);
  const readBand = gy => {
    jpeg.band?.(gy); jpeg.unpackBand?.();
    const row = gy * 32, rows = Math.min(32, bh - row);
    return comps.map(c => {
      const start = (row - (c.row0 ?? 0)) * c.stride * 64;
      return c.coeffs.subarray(start, start + rows * c.stride * 64);
    });
  };
  const wasmX = new Int8Array(tw * th), wasmB = new Int8Array(tw * th);
  for (let gy = 0; gy < gyCount; gy++) {
    const [x, y, b] = readBand(gy), rows = Math.min(32, bh - gy * 32), from = gy * 4 * tw, tiles = ((rows + 7) >> 3) * tw;
    kernels.fitCfl(y, Int16Array.from(x), yComp.quant, xComp.quant, bw, rows, stride, wasmX.subarray(from, from + tiles), 0);
    kernels.fitCfl(y, Int16Array.from(b), yComp.quant, bComp.quant, bw, rows, stride, wasmB.subarray(from, from + tiles), 0);
    if (yield progressAt(0.05 * (gy + 1) / gyCount)) return null;
  }
  const toX = yield* fitEob2DCflChannelSteps(gy => { const a = readBand(gy); return [a[1], a[0]]; },
    yComp.quant, xComp.quant, bw, bh, stride, wasmX, r => progressAt(0.05 + r * 0.45), kernels);
  if (!toX) return null;
  const toB = yield* fitEob2DCflChannelSteps(gy => { const a = readBand(gy); return [a[1], a[2]]; },
    yComp.quant, bComp.quant, bw, bh, stride, wasmB, r => progressAt(0.5 + r * 0.45), kernels);
  if (!toB) return null;
  const natural = jpeg.components.map(() => new Uint32Array(64)), nonzero = kernelHooks.nonzero ?? ensured().nonzero ?? missing();
  for (let gy = 0; gy < gyCount; gy++) {
    const [rawX, y, rawB] = readBand(gy), x = Int16Array.from(rawX), b = Int16Array.from(rawB);
    const rows = Math.min(32, bh - gy * 32), from = gy * 4 * tw, tiles = ((rows + 7) >> 3) * tw;
    kernels.fitCfl(y, x, yComp.quant, xComp.quant, bw, rows, stride, toX.subarray(from, from + tiles), 1);
    kernels.fitCfl(y, b, yComp.quant, bComp.quant, bw, rows, stride, toB.subarray(from, from + tiles), 1);
    for (const [c, values] of [[0, x], [1, y], [2, b]]) {
      const target = natural[frameMap[c]], st = comps[c].stride;
      if (st === bw) {
        if (!nonzero(values, 0, rows * st * 64, target)) throw declined('nonzero');
      } else for (let row = 0; row < rows; row++) {
        const start = row * st * 64;
        if (!nonzero(values, start, start + bw * 64, target)) throw declined('nonzero');
      }
    }
    if (yield progressAt(0.95 + 0.05 * (gy + 1) / gyCount)) return null;
  }
  return {cflMaps: [toX, toB], seedMaps: [wasmX, wasmB], components: jpeg.components.map((c, i) => ({...c, natural: natural[i]}))};
}

function* jpegAnsSearchSteps(jpeg, effort, retain, shared) {
  if (effort < 8 || (typeof __RAPIER_JXL_UPLOAD__ !== 'undefined' && __RAPIER_JXL_UPLOAD__ === true)) return yield* jpegEffortSteps(jpeg, effort, retain, jpegAnsFirstSteps, shared);
  let step, hurry, best;
  const ladder = jpeg.width * jpeg.height <= SMALL_PIXELS;
  const first = effort >= 9 ? (image, e, fallback, keep, cache) => jpegAnsFirstSteps(image, e, fallback, keep, cache, true) : jpegAnsFirstSteps;
  let learnedFloor = null;
  const keepFloor = (bytes, plan) => {
    retain?.(bytes, plan);
    if (!ladder && plan.orders && plan.clusters === (effort === 9 ? EVERY_WIDE : SHAPED_WIDE)) learnedFloor = plan;
  };
  const floor = ladder ? jpegEffortSteps(jpeg, effort, retain, first, shared) : first(jpeg, effort, undefined, keepFloor, shared);
  let reply;
  try { while (!(step = floor.next(reply)).done) {
    if (typeof step.value !== 'number') { reply = yield scaled(step.value, done => done / 2); continue; }
    reply = hurry = yield step.value / 2;
  } } finally { if (!step?.done) floor.return?.(); }
  best = step.value;
  if (!best && !ladder && !hurry) {
    const backup = jpegEffortSteps(jpeg, effort, retain, coefficientEffortSteps, shared);
    try { while (!(step = backup.next()).done) { if (typeof step.value === 'number' && (hurry = yield step.value / 2)) break; } }
    finally { if (!step?.done) backup.return?.(); }
    if (step?.done) best = step.value;
  }
  if (hurry) return best;
  const fullChroma = jpeg.components.length === 3 && jpeg.components.every(c => c.h === jpeg.components[0].h && c.v === jpeg.components[0].v);
  const canEobCfl = fullChroma && (!jpeg.ycbcr || jpeg.components.every(c => c.h === 1 && c.v === 1)) && !jpeg.strategyData && !jpeg.progression && !jpeg.cfl && (jpeg.band || jpeg.components.every(c => c.coeffs && c.row0 === undefined));
  const lumaIdx = jpeg.ycbcr && !jpeg.frameOrder ? 0 : 1;
  const maxH = Math.max(...jpeg.components.map(c => c.h)), maxV = Math.max(...jpeg.components.map(c => c.v));
  const canDc3d = jpeg.components.length === 3 && !jpeg.strategyData && !jpeg.progression && (jpeg.band || jpeg.components.every(c => c.coeffs && c.row0 === undefined)) && jpeg.components[lumaIdx].h === maxH && jpeg.components[lumaIdx].v === maxV && Math.ceil(jpeg.width / 8) * Math.ceil(jpeg.height / 8) >= 256;
  const dc3dClusters = effort === 9 ? [FINE_WIDE, EVERY_FINE_WIDE, EVERY_FINE_WIDEST] : [FINE_WIDE];
  const alternate = {maxClusters: 32, newClusterCost: 160, everyConfig: effort === 9};
  const parts = (canEobCfl ? 1 : 0) + (canDc3d ? DC3D_SHAPES.length * dc3dClusters.length : 0) + (!ladder && best ? 2 : 0) + (effort === 8 ? 7 : 12) + (fullChroma ? (effort === 8 ? 1 : 2) : 0) + (jpeg.width * jpeg.height <= SMALL_PIXELS ? (effort === 8 ? 2 : 4) : 0);
  let part = 0, cflMaps = null, orderComponents = jpeg.components;
  const postShared = canEobCfl || canDc3d ? (shared.highShared ||= {}) : shared;
  function* learn(bucket) {
    const steps = coefficientOrderSteps(orderComponents, bucket);
    while (!(step = steps.next()).done) {
      hurry = yield 0.5 + (part + step.value) / (2 * parts);
      if (hurry) { steps.return(); return null; }
    }
    part++;
    return step.value;
  }
  function* write(orders, each) {
    for (const clusters of twins(jpeg, each)) { yield* writeOne(orders, clusters); if (hurry) return; }
  }
  function* writeOne(orders, clusters, fineDc = false, dc3d = null) {
    const plan = {orders, clusters, ...(fineDc && {fineDc: true}), ...(dc3d && {dc3d}), ...(cflMaps && {cflMaps}), orderWriter: compactOrderWriter, coding: buildAnsCoding, modularAns: writeModularAnsHistograms, lfCoder: lfFor(effort)};
    const steps = candidateSteps(jpeg, plan, postShared);
    let reply;
    while (!(step = steps.next(reply)).done) {
      reply = undefined;
      if (typeof step.value !== 'number') { reply = yield scaled(step.value, done => 0.5 + (part + done) / (2 * parts)); continue; }
      hurry = yield 0.5 + (part + step.value) / (2 * parts);
      if (hurry && step.value < 1) { steps.return(); return; }
    }
    if (step.value.length < best.length) best = step.value;
    retain?.(step.value, plan);
    part++;
  }
  try {
    if (canEobCfl) {
      let fitted = shared.highCfl?.source === jpeg ? shared.highCfl : null;
      if (!fitted) {
        const cflSteps = fitHighEffortJpegCflSteps(jpeg, done => 0.5 + (part + done) / (2 * parts));
        try { while (!(step = cflSteps.next()).done) {
          hurry = yield step.value;
          if (hurry) return best;
        } } finally { if (!step?.done) cflSteps.return(); }
        if (step.value) shared.highCfl = fitted = {source: jpeg, ...step.value};
      }
      if (fitted) { cflMaps = fitted.cflMaps; orderComponents = fitted.components; }
      part++;
    }
    const activeFloor = cflMaps ? null : learnedFloor;
    yield* write(undefined, alternate);
    if (hurry) return best;
    if (!ladder && best) {
      const orders16 = yield* learn(16);
      if (hurry) return best;
      yield* write(orders16, effort === 9 ? EVERY_WIDEST : WIDEST);
      if (hurry) return best;
    }
    const orders = activeFloor ? (part++, activeFloor.orders) : yield* learn(8);
    if (hurry) return best;
    for (const clusters of effort === 9 ? [EVERY_WIDE, EVERY_WIDEST] : [SHAPED_WIDE, WIDEST]) {
      if (activeFloor?.clusters === clusters) { part++; continue; }
      yield* write(orders, clusters);
      if (hurry) return best;
    }
    const fineSet = effort === 9 ? [FINE_WIDE, FINE_WIDEST, EVERY_FINE_WIDE, EVERY_FINE_WIDEST] : [FINE_WIDE, FINE_WIDEST];
    for (const clusters of fineSet) {
      yield* writeOne(orders, clusters, true);
      if (hurry) return best;
    }
    for (const clusters of effort === 9 ? [FINE_WIDE, EVERY_FINE_WIDE] : [FINE_WIDE]) {
      yield* writeOne(undefined, clusters, true);
      if (hurry) return best;
    }
    if (hurry) return best;
    if (fullChroma && orders) {
      const lumaOnly = lumaIdx === 0 ? [orders[0], NATURAL_ORDER, NATURAL_ORDER] : [NATURAL_ORDER, orders[1], NATURAL_ORDER];
      for (const clusters of effort === 9 ? [FINE_WIDE, EVERY_FINE_WIDE] : [FINE_WIDE]) {
        yield* writeOne(lumaOnly, clusters, true);
        if (hurry) return best;
      }
    }
    if (canDc3d) {
      for (const dc3d of DC3D_SHAPES) for (const clusters of dc3dClusters) {
        yield* writeOne(orders, clusters, false, dc3d);
        if (hurry) return best;
      }
    }
    if (effort === 8) return best;
    const exact = yield* learn(1);
    if (hurry) return best;
    for (const clusters of [EVERY_WIDE, EVERY_WIDEST]) {
      yield* write(exact, clusters);
      if (hurry) return best;
    }
    yield* writeOne(exact, EVERY_FINE_WIDE, true);
    if (hurry) return best;
    return best;
  } catch (error) {
    if (error.code !== 'JXL_SIZE') throw error;
    return best;
  }
}

export function* jpegAnsEffortSteps(jpeg, effort, retain, shared = {}) {
  if (effort < 8 || (typeof __RAPIER_JXL_UPLOAD__ !== 'undefined' && __RAPIER_JXL_UPLOAD__ === true))
    return yield* jpegAnsSearchSteps(jpeg, effort, retain, shared);
  let best = null, winner = null, hurry = false, part = 0;
  const ten = (typeof __RAPIER_JXL_EFFORT_TEN__ === 'undefined' || __RAPIER_JXL_EFFORT_TEN__ === true) && effort === 10;
  const seedCfl = effort === 9 && jpeg.jpegReconstruction && jpeg.ycbcr && !jpeg.cfl && !jpeg.strategyData && !jpeg.progression &&
    jpeg.components.length === 3 && jpeg.components.every(c => c.h === 1 && c.v === 1) &&
    Math.ceil(jpeg.width / GROUP_DIM) * Math.ceil(jpeg.height / GROUP_DIM) > 64;
  const parts = (effort === 8 ? 3 : ten ? 8 : 6) + (seedCfl ? 1 : 0);
  const keep = (bytes, plan) => {
    if (!best || bytes.length < best.length) { best = bytes; winner = plan; }
    retain?.(bytes, plan);
  };
  function* run(steps) {
    let step, reply;
    try {
      while (!(step = steps.next(reply)).done) {
        reply = yield scaled(step.value, done => (part + done) / parts);
        if (typeof step.value === 'number' && reply) {
          hurry = true;
          if (best && step.value < 1) return null;
        }
      }
      part++;
      return step.value;
    } finally { if (!step?.done) steps.return(); }
  }
  if (effort > 8) {
    yield* run(jpegAnsEffortSteps(jpeg, effort - 1, keep, shared));
    if (hurry) return best;
  }
  if (!ten) {
    try {
      yield* run(jpegAnsSearchSteps(jpeg, effort, keep, shared));
    } catch (error) {
      if (!best || error.code !== 'JXL_SIZE') throw error;
      part++;
    }
    if (hurry) return best;
  }
  const floor = winner, every = effort >= 9;
  const common = {orders: floor?.orders, coding: buildAnsCoding, modularAns: writeModularAnsHistograms,
    ...(floor?.cflMaps && {cflMaps: floor.cflMaps}), orderWriter: compactOrderWriter, lfCoder: ten ? jpegTenLfCoder : lfFor(effort)};
  const sameContexts = floor?.dc3d ? {dc3d: floor.dc3d} : {fineDc: floor?.fineDc};
  const widest = {...(every ? EVERY_WIDEST : WIDEST), maxClusters: 223};
  const fine = {...(every ? EVERY_FINE_WIDEST : FINE_WIDEST), maxClusters: 223};
  const plainFloor = {...floor}; delete plainFloor.cflMaps;
  const plans = ten ? [{...plainFloor, lfCoder: jpegTenLfCoder},
    ...(floor?.cflMaps ? [{...floor, lfCoder: jpegTenLfCoder}] : []), {...common, clusters: widest, ...sameContexts},
    ...[true, 11, 13].map(fineDc => ({...common, clusters: fine, fineDc})), {...common, clusters: EVERY_FINE_WIDEST, fineDc: 13}]
    : [{...common, clusters: widest, ...sameContexts}, {...common, clusters: fine, fineDc: true},
      ...(effort >= 9 ? [11, 13].map(fineDc => ({...common, clusters: fine, fineDc})) : [])];
  if (ten && !floor?.cflMaps) part++;
  const seedMaps = shared.highCfl?.source === jpeg ? shared.highCfl.seedMaps : null;
  if (seedCfl && !seedMaps) part++;
  for (let i = 0; i < plans.length + (seedCfl && seedMaps ? 1 : 0); i++) {
    const plan = i < plans.length ? plans[i] : {...winner, cflMaps: seedMaps};
    try {
      const bytes = yield* run(candidateSteps(jpeg, plan, shared));
      if (bytes) keep(bytes, plan);
    } catch (error) {
      if (!best || error.code !== 'JXL_SIZE') throw error;
      part++;
    }
    if (hurry) return best;
  }
  return best;
}


const iccKind1 = b => (b >= 97 && b <= 122) || (b >= 65 && b <= 90) ? 0 : (b >= 48 && b <= 57) || b === 46 || b === 44 ? 1 : b === 0 ? 2 : b === 1 ? 3 : b < 16 ? 4 : b === 255 ? 6 : b > 240 ? 5 : 7;
const iccKind2 = b => (b >= 97 && b <= 122) || (b >= 65 && b <= 90) ? 0 : (b >= 48 && b <= 57) || b === 46 || b === 44 ? 1 : b < 16 ? 2 : b > 240 ? 3 : 4;
function encodeReconstructedICC(profile, effort) {
  let best = prepareICC(profile, {compression: 'auto'}).iccData;
  const transformed = predictICC(profile), n = transformed.length, kernels = (kernelHooks.entropy ?? ensured().entropy ?? missing())() ?? missing();
  if (!(typeof __RAPIER_JXL_UPLOAD__ !== 'undefined' && __RAPIER_JXL_UPLOAD__ === true) && effort >= 8) {
    try {
      const copied = lzICC(transformed);
      if (copied.bitLength < best.bitLength) best = copied;
    } catch (error) { if (error.code !== 'JXL_SIZE') throw error; }
  }
  const counts = new TokenCounts(41), ctxs = new Uint16Array(n), values = new Uint16Array(n);
  for (let i = 0, prev = 0, older = 0; i < n; i++) {
    const ctx = i <= 128 ? 0 : 1 + iccKind1(prev) + iccKind2(older) * 8, v = transformed[i];
    ctxs[i] = ctx; values[i] = v; counts.add(ctx, v);
    older = prev; prev = v;
  }
  for (const [maxClusters, newClusterCost] of effort >= 7 ? [[16, 80], [8, 120], [1, 0]] : [[16, 80]]) {
    const prefix = buildTokenCoding(counts, {maxClusters, newClusterCost, kernels});
    const pw = new BitWriter(n + 128);
    writeIccLength(pw, n); prefix.writeHistograms(pw); prefix.writeTokens(pw, ctxs, values, n);
    if (pw.bitLength < best.bitLength) best = pw;
  }
  if (effort >= 2) {
    const everyConfig = !(typeof __RAPIER_JXL_UPLOAD__ !== 'undefined' && __RAPIER_JXL_UPLOAD__ === true) && effort >= 9;
    const budgets = !(typeof __RAPIER_JXL_UPLOAD__ !== 'undefined' && __RAPIER_JXL_UPLOAD__ === true) && effort >= 7
      ? [[16, 64], [8, 96], [32, 32], [4, 140], [1, 0]] : [[16, 64], [4, 140]];
    for (const every of everyConfig ? [false, true] : [false]) for (const [maxClusters, newClusterCost] of budgets) {
      const coding = buildAnsCoding(counts, {maxClusters, seeds: 41, newClusterCost, smallestMap: true, headerAware: true, shapedMerge: true, everyConfig: every, kernels});
      const aw = new BitWriter(n + 128);
      writeIccLength(aw, n); coding.writeHistograms(aw); coding.writeTokens(aw, ctxs, values, n); coding.flush(aw);
      if (aw.bitLength < best.bitLength) best = aw;
    }
  }
  return best;
}
jpegAnsEffortSteps.contextsFrom = 2;
jpegAnsEffortSteps.effortTen = true;
jpegAnsEffortSteps.iccCoder = encodeReconstructedICC;
export function ansTranscodeSteps(jpeg, options) { return jpegJob(jpeg, options, jpegAnsEffortSteps); }
