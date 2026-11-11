// SPDX-License-Identifier: MIT
import {exactExp, exactLog, exactLog2, exactPow} from './exact-math.mjs';
import {vbPackSigned, token, VB_SMALL, VB_CONFIG, VB_ZD, VB_NZ, VB_TOKENS, tableFor, createStrategyBuilder, lazyStrategyImage} from './varblock-core.mjs';
export {nzBucket, token, rateModel, VB_DOUBT, strategyInputs, TransformCache, tokenRate, strategyImage, strategyTables, auditLevels, lazyStrategyImage, materialize} from './varblock-core.mjs';
import {complete} from './bits.mjs';
import {photoXYBSteps} from './photo-xyb.mjs';
import {maskDoubtOver} from './photo-mask.mjs';
import {scaledDCT, scaledDCTAt, smallTransform, naturalOrder, lowFrequencies, TRANSFORMS, scaledDCTBases} from './vardct-strategies.mjs';
import {kernelHooks} from './kernel-hooks.mjs';
import {zeroDensityContext} from './vardct.mjs';
import {strategyAnsSteps} from './coefficient-ans.mjs';
import {prepareCoefficientOrders, COEFFICIENT_ORDER_BUCKETS} from './coefficient-orders.mjs';
import {prepareQuantParams, quantParamSteps} from './quantization-params.mjs';
import {ZIGZAG} from './jpeg-tables.mjs';
import {hybridToken, uintConfig} from './prefix.mjs';
import {populationBits} from './entropy.mjs';

export function forcedLayout(id, stride, rows) {
  const t = TRANSFORMS[id], bw = t.width / 8, bh = t.height / 8, layout = [], fits = (bx, by) => bx + bw <= stride && by + bh <= rows;
  if (!(typeof __RAPIER_JXL_CAPTURE_PHOTO__ !== 'undefined' && __RAPIER_JXL_CAPTURE_PHOTO__ === true) && id >= 18) {
    const parts = id === 18 ? [[0, 0, 8, 8]] : id === 19 ? [[0, 0, 4, 8], [4, 0, 4, 8]] : [[0, 0, 8, 4], [0, 4, 8, 4]];
    for (let cy = 0; cy < rows; cy += 8) for (let cx = 0; cx < stride; cx += 8) for (const [dx, dy, rw, rh] of parts) {
      const bx = cx + dx, by = cy + dy;
      if (bx >= stride || by >= rows) continue;
      if (fits(bx, by)) { layout.push({id, bx, by}); continue; }
      for (let y = by; y < Math.min(rows, by + rh); y++) for (let x = bx; x < Math.min(stride, bx + rw); x++) layout.push({id: 0, bx: x, by: y});
    }
    return layout;
  }
  for (let cy = 0; cy < rows; cy += 4) for (let cx = 0; cx < stride; cx += 4) {
    if (id === 5 && fits(cx, cy)) { layout.push({id, bx: cx, by: cy}); continue; }
    if (id === 10 && fits(cx, cy) && fits(cx + 2, cy)) { layout.push({id, bx: cx, by: cy}, {id, bx: cx + 2, by: cy}); continue; }
    if (id === 11 && fits(cx, cy) && fits(cx, cy + 2)) { layout.push({id, bx: cx, by: cy}, {id, bx: cx, by: cy + 2}); continue; }
    for (const [x, y] of [[0, 0], [2, 0], [0, 2], [2, 2]]) {
      const bx = cx + x, by = cy + y;
      if (bx >= stride || by >= rows) continue;
      if (id === 4 && fits(bx, by)) { layout.push({id, bx, by}); continue; }
      if (id === 6 && fits(bx, by) && fits(bx + 1, by)) { layout.push({id, bx, by}, {id, bx: bx + 1, by}); continue; }
      if (id === 7 && fits(bx, by) && fits(bx, by + 1)) { layout.push({id, bx, by}, {id, bx, by: by + 1}); continue; }
      for (const i of [0, 1, 2, 3]) if (bx + (i & 1) < stride && by + (i >> 1) < rows) layout.push({id: 0, bx: bx + (i & 1), by: by + (i >> 1)});
    }
  }
  return layout;
}

const rateView = /* @__PURE__ */ new DataView(/* @__PURE__ */ new ArrayBuffer(8));
function rateRound(value, up) {
  if (!Number.isFinite(value) || value === 0 && !up) return value;
  rateView.setFloat64(0, value, false);
  let hi = rateView.getUint32(0, false), lo = rateView.getUint32(4, false);
  if (up) { if (lo === 0xffffffff) { lo = 0; hi++; } else lo++; }
  else if (lo === 0) { lo = 0xffffffff; hi--; } else lo--;
  rateView.setUint32(0, hi, false); rateView.setUint32(4, lo, false);
  return rateView.getFloat64(0, false);
}
export function sumRateError(total, error, count) {
  if (!error) return 0;
  if (!Number.isFinite(error)) return Infinity;
  const nu = count * 2 ** -53;
  if (!(nu < 1)) return Infinity;
  const gamma = rateRound(nu / rateRound(1 - nu, false), true), denominator = rateRound(1 - gamma, false);
  if (!(denominator > 0)) return Infinity;
  const sum = rateRound(total / denominator, true), bound = rateRound(error / denominator, true);
  return rateRound(bound + rateRound(gamma * rateRound(rateRound(2 * sum, true) + bound, true), true), true);
}

export function sumStrategyValues(values, from, to, total = 0) {
  for (let k = from; k < to; k++) total += values[k];
  return total;
}
export function strategyCertifiedRateError(error) {
  if (!(error >= 0 && Number.isFinite(error))) throw new Error('Certified measured rates need finite nonnegative Re.');
  return error;
}
export function addStrategyMapCells(map, stride, bx, by, bw, from, to, m = 0) {
  for (let k = from; k < to; k++) m += map[(by + Math.floor(k / bw)) * stride + bx + k % bw];
  return m;
}
export function strategyMeasuredRateTotalDoubt(exactTotal, certifiedRates, error, total, rateDoubt, totalDoubt) {
  return exactTotal ? 0 : certifiedRates ? error ? rateRound(error / total, true) : 0
    : !rateDoubt ? 0 : totalDoubt ?? rateDoubt;
}
export function strategyMeasuredPrice(m, R, lambda, mapTotal, rateTotal, doubt, exact, exactRate, certifiedRates, error, rateDoubt) {
  const r = lambda * R;
  return {J: m / mapTotal + r / rateTotal, m, me: exact ? 0 : doubt * m, r,
    re: exactRate ? 0 : certifiedRates ? Math.abs(lambda) * error : !rateDoubt ? 0 : rateDoubt * r};
}

export function createStrategySelector({options = {}, lambda = 1, stride, rows, allowed, inhom = 0.08,
  useMask = false, bounded = false, maps = null, doubt = 0, rateDoubt = 0, costDoubt = 0,
  certifiedCosts = false, boundedRates = false, mapTotal = 1, rateTotal = 1,
  totalDoubt = 0, rateTotalDoubt = 0, candidate}) {
  let opened = false;
  const over = (d, e, total, t) => {
    const lo = d - e, hi = d + e;
    return [lo >= 0 ? lo / (total * (1 + t)) : lo / (total * (1 - t)), hi >= 0 ? hi / (total * (1 - t)) : hi / (total * (1 + t))];
  };
  const plainRange = !maps && !doubt && !rateDoubt && !costDoubt && !certifiedCosts;
  const beats = (b, a) => {
    const wins = b.J < a.J;
    if (plainRange) return wins;
    if ((a.Je || b.Je) && Number.isFinite(a.J) && Number.isFinite(b.J)) {
      const slack = 1e-14 * (Math.abs(a.J) + Math.abs(b.J));
      if (!(b.J + b.Je + slack < a.J - a.Je || b.J - b.Je - slack > a.J + a.Je)) opened = true;
    }
    if ((doubt || boundedRates) && Number.isFinite(a.J) && Number.isFinite(b.J) && (a.me || b.me || a.re || b.re || totalDoubt || rateTotalDoubt)) {
      const [m0, m1] = over((b.m ?? 0) - (a.m ?? 0), (b.me ?? 0) + (a.me ?? 0), mapTotal, totalDoubt);
      const [r0, r1] = over((b.r ?? 0) - (a.r ?? 0), (b.re ?? 0) + (a.re ?? 0), rateTotal, rateTotalDoubt), slack = 1e-14 * (Math.abs(a.J) + Math.abs(b.J));
      if (!(m1 + r1 < -slack || m0 + r0 > slack)) opened = true;
    }
    return wins;
  };
  const range = list => {
    if (plainRange) {
      let J = 0;
      for (let i = 0; i < list.length; i++) J += list[i].J;
      return {J, m: 0, me: 0, r: 0, re: 0, Je: 0};
    }
    return {J: list.reduce((s, b) => s + b.J, 0), m: list.reduce((s, b) => s + (b.m ?? 0), 0), me: list.reduce((s, b) => s + (b.me ?? 0), 0),
      r: list.reduce((s, b) => s + (b.r ?? 0), 0), re: list.reduce((s, b) => s + (b.re ?? 0), 0), Je: list.reduce((s, b) => s + (b.Je ?? 0), 0)};
  };
  const fits = (id, bx, by) => bx + TRANSFORMS[id].width / 8 <= stride && by + TRANSFORMS[id].height / 8 <= rows
    && (!options.validBlock || options.validBlock(id, bx, by, TRANSFORMS[id].width / 8, TRANSFORMS[id].height / 8));
  const force = options.force;
  const best8 = (bx, by) => {
    if (force !== undefined) return candidate(VB_SMALL.has(force) ? force : 0, bx, by);
    let best = candidate(0, bx, by);
    for (const id of [3, 12, 13]) if (allowed.has(id)) { const c = candidate(id, bx, by); if (beats(c, best)) best = c; }
    return best;
  };
  const largerFirst = bounded && !useMask && force === undefined && lambda >= 0 && [...allowed].every(id => id === 4 || id === 5);
  const skipped = c => c.light && c.J === Infinity;
  const subInhom = list => {
    if (!useMask || !inhom || list.length < 2) return 0;
    let maxR = 0, minR = Infinity;
    for (const b of list) { const r = (b.R ?? 0) / (b.area || 1); if (r > maxR) maxR = r; if (r < minR) minR = r; }
    return inhom * lambda * Math.max(0, maxR - 2 * minR - 8);
  };
  const penDoubt = list => {
    if (!certifiedCosts || !inhom || list.length < 2) return 0;
    let e = 0;
    for (const b of list) if (b.Re > e) e = b.Re;
    return 3 * inhom * lambda * e;
  };
  const best16 = (bx, by) => {
    if (largerFirst && allowed.has(4) && fits(4, bx, by)) {
      const c16 = candidate(4, bx, by), r16 = range([c16]), list = [];
      let sum = 0;
      for (const i of [0, 1, 2, 3]) {
        if (bx + (i & 1) >= stride || by + (i >> 1) >= rows) continue;
        const before = sum, c = candidate(0, bx + (i & 1), by + (i >> 1), J => before + J > r16.J);
        if (skipped(c)) return {list: [c16], ...r16};
        list.push(c); sum += c.J;
        if (sum > r16.J) return {list: [c16], ...r16};
      }
      const cur = range(list);
      return r16.J < cur.J ? {list: [c16], ...r16} : {list, ...cur};
    }
    if (force !== undefined && [4, 6, 7].includes(force) && fits(force, bx, by) && (force === 4 || fits(force, force === 6 ? bx + 1 : bx, force === 6 ? by : by + 1))) return {list: force === 4 ? [candidate(4, bx, by)] : force === 6 ? [candidate(6, bx, by), candidate(6, bx + 1, by)] : [candidate(7, bx, by), candidate(7, bx, by + 1)], J: -Infinity};
    let best = [0, 1, 2, 3].filter(i => bx + (i & 1) < stride && by + (i >> 1) < rows).map(i => best8(bx + (i & 1), by + (i >> 1)));
    let cur = range(best);
    if (force !== undefined) return {list: best, ...cur};
    const base8 = best;
    const tryOne = (list, pen = 0, fb = base8) => {
      const r = range(list);
      r.J += pen;
      r.Je += penDoubt(fb);
      if (beats(r, cur)) {
        for (const b of list) if (!b.fallback) b.fallback = fb;
        cur = r; best = list;
      }
    };
    if (allowed.has(4) && fits(4, bx, by)) {
      const pen = subInhom(base8);
      tryOne([candidate(4, bx, by, J => J + pen >= cur.J)], pen, base8);
    }
    if (allowed.has(6) && fits(6, bx, by) && fits(6, bx + 1, by)) {
      if (useMask && base8.length === 4) {
        const pL = [base8[0], base8[2]], pR = [base8[1], base8[3]];
        const jL = pL[0].J + pL[1].J, jR = pR[0].J + pR[1].J;
        const penL = subInhom(pL), penR = subInhom(pR);
        const cL = candidate(6, bx, by, J => J + penL >= jL);
        const cR = candidate(6, bx + 1, by, J => J + penR >= jR);
        const winL = cL.J + penL < jL, winR = cR.J + penR < jR;
        if (winL) cL.fallback = pL;
        if (winR) cR.fallback = pR;
        if (winL || winR) tryOne([...(winL ? [cL] : pL), ...(winR ? [cR] : pR)], (winL ? penL : 0) + (winR ? penR : 0), base8);
      } else tryOne([candidate(6, bx, by), candidate(6, bx + 1, by)]);
    }
    if (allowed.has(7) && fits(7, bx, by) && fits(7, bx, by + 1)) {
      if (useMask && base8.length === 4) {
        const pT = [base8[0], base8[1]], pB = [base8[2], base8[3]];
        const jT = pT[0].J + pT[1].J, jB = pB[0].J + pB[1].J;
        const penT = subInhom(pT), penB = subInhom(pB);
        const cT = candidate(7, bx, by, J => J + penT >= jT);
        const cB = candidate(7, bx, by + 1, J => J + penB >= jB);
        const winT = cT.J + penT < jT, winB = cB.J + penB < jB;
        if (winT) cT.fallback = pT;
        if (winB) cB.fallback = pB;
        if (winT || winB) tryOne([...(winT ? [cT] : pT), ...(winB ? [cB] : pB)], (winT ? penT : 0) + (winB ? penB : 0), base8);
      } else tryOne([candidate(7, bx, by), candidate(7, bx, by + 1)]);
    }
    return {list: best, ...cur};
  };
  const best32 = (cx, cy) => {
    if (force === 5 && fits(5, cx, cy)) { const c = candidate(5, cx, cy); return {list: [c], ...range([c])}; }
    if (force === 10 && fits(10, cx, cy) && fits(10, cx + 2, cy)) { const l = [candidate(10, cx, cy), candidate(10, cx + 2, cy)]; return {list: l, ...range(l)}; }
    if (force === 11 && fits(11, cx, cy) && fits(11, cx, cy + 2)) { const l = [candidate(11, cx, cy), candidate(11, cx, cy + 2)]; return {list: l, ...range(l)}; }
    const corners = [[0, 0], [2, 0], [0, 2], [2, 2]].filter(([x, y]) => cx + x < stride && cy + y < rows);
    if (largerFirst && allowed.has(5) && fits(5, cx, cy)) {
      const c32 = candidate(5, cx, cy), r32 = range([c32]), quads = [];
      let sum = 0;
      for (const [x, y] of corners) {
        const q = best16(cx + x, cy + y);
        quads.push(q); sum += q.J;
        if (sum > r32.J) return {list: [c32], ...r32};
      }
      const cur = range(quads);
      return r32.J < cur.J ? {list: [c32], ...r32} : {list: quads.flatMap(q => q.list), ...cur};
    }
    const quads = corners.map(([x, y]) => best16(cx + x, cy + y));
    let list = quads.flatMap(q => q.list), cur = range(quads);
    if (force !== undefined && [5, 10, 11].includes(force)) cur = {J: Infinity};
    const baseList = list;
    const tryOne = (l, pen = 0, fb = baseList) => {
      const r = range(l);
      r.J += pen;
      if (beats(r, cur)) {
        for (const b of l) if (!b.fallback) b.fallback = fb;
        cur = r; list = l;
      }
    };
    const allow32 = id => force === undefined ? allowed.has(id) : force === id;
    if (allow32(5) && fits(5, cx, cy)) tryOne([candidate(5, cx, cy, J => J >= cur.J)], 0, baseList);
    if (allow32(10) && fits(10, cx, cy) && fits(10, cx + 2, cy)) tryOne([candidate(10, cx, cy), candidate(10, cx + 2, cy)], 0, baseList);
    if (allow32(11) && fits(11, cx, cy) && fits(11, cx, cy + 2)) tryOne([candidate(11, cx, cy), candidate(11, cx, cy + 2)], 0, baseList);
    return {list, ...cur};
  };
  const allow64 = id => force === undefined ? allowed.has(id) && (!maps || maps[id]) : force === id;
  const big = !(typeof __RAPIER_JXL_CAPTURE_PHOTO__ !== 'undefined' && __RAPIER_JXL_CAPTURE_PHOTO__ === true) && [18, 19, 20].some(allow64);
  const region = big ? 8 : 4;
  function best64(cx, cy) {
    const cell = (x, y) => cx + x < stride && cy + y < rows ? best32(cx + x, cy + y) : {list: [], J: 0};
    const cells = [], Q = i => cells[i] ??= cell((i & 1) * 4, (i >> 1) * 4), all = () => [Q(0), Q(1), Q(2), Q(3)];
    const join = (...parts) => ({list: parts.flatMap(p => p.list), ...range(parts)});
    const pick = (a, b) => b && beats(b, a) ? b : a, one = (id, x, y) => allow64(id) && fits(id, cx + x, cy + y) ? (c => ({list: [c], ...range([c])}))(candidate(id, cx + x, cy + y)) : null;
    const half = (pair, c) => force !== undefined ? c || join(Q(pair[0]), Q(pair[1])) : pick(join(Q(pair[0]), Q(pair[1])), c);
    const tall = () => join(half([0, 2], one(19, 0, 0)), half([1, 3], one(19, 4, 0)));
    const wide = () => join(half([0, 1], one(20, 0, 0)), half([2, 3], one(20, 0, 4)));
    const best = force === 18 ? one(18, 0, 0) || join(...all()) : force === 19 ? tall() : force === 20 ? wide()
      : pick(pick(pick(join(...all()), tall()), wide()), one(18, 0, 0));
    return best;
  }
  return {fits, largerFirst, region, choose(cx, cy) {
    opened = false;
    const result = big ? best64(cx, cy) : best32(cx, cy);
    return {...result, opened};
  }};
}

export function strategyFamilyCount(chosen, family) {
  let count = 0;
  for (const b of chosen) if (TRANSFORMS[b.id].table === family) count++;
  return count;
}
export function revertStrategyFamily(chosen, family) {
  for (let i = chosen.length - 1; i >= 0; i--) {
    if (TRANSFORMS[chosen[i].id].table === family && chosen[i].fallback) chosen.splice(i, 1, ...chosen[i].fallback);
  }
  return chosen;
}

const REVERTED = new Set([5, 4, 6]);
function packChoices(chosen) {
  const out = [], open = new Set();
  const put = list => {
    for (const block of list) {
      const {id, bx, by} = block, fallback = REVERTED.has(TRANSFORMS[id].table) && !open.has(block) ? block.fallback : null;
      out.push(id, bx, by, fallback?.length ?? 0);
      if (fallback) { open.add(block); put(fallback); open.delete(block); }
    }
  };
  put(chosen);
  return Int32Array.from(out);
}
function unpackChoices(packed) {
  let at = 0;
  const take = n => Array.from({length: n}, () => {
    const id = packed[at], bx = packed[at + 1], by = packed[at + 2], count = packed[at + 3];
    at += 4;
    return count ? {id, bx, by, fallback: take(count)} : {id, bx, by};
  });
  const list = [];
  while (at < packed.length) list.push(...take(1));
  return list;
}
export function strategyRowsLayout(bands) {
  const chosen = bands.flatMap(band => unpackChoices(band.chosen));
  if (bands[0]?.useMask) for (const fam of [5, 4, 6]) {
    const count = strategyFamilyCount(chosen, fam);
    if (count > 0 && count < 8) revertStrategyFamily(chosen, fam);
  }
  return chosen.map(({id, bx, by}) => ({id, bx, by}));
}

export function xybStrategies(base, width, height, options = {}) {
  const builder = createStrategyBuilder(base, width, height, options);
  const {lambda, sizeScale, ids, inhom, comps, stride, rows, tables, allowed, rates, costs, certifiedCosts, costDoubt,
    useMask, keepChosen, bounded, vk, candidateRate, candidate, full, make} = builder;
  builder.setMeasuredCost(measuredCost);
  const maps = options.maps;
  const certifiedRates = !!maps && !!rates && certifiedCosts;
  const rateDoubt = certifiedRates ? 0 : options.rateDoubt || 0, boundedRates = certifiedRates || !!rateDoubt, exactRate = new Set();
  const cpuRate = builder.cpuRate;
  if (maps && boundedRates && costs) for (const [id, c] of costs) if ((certifiedRates || c.uncertain) && rates?.has(id)) for (let at = 0; at < (certifiedRates ? c.R.length : c.uncertain.length); at++) if (c.uncertain?.[at] || certifiedRates && (c.De?.[at] === Infinity || c.Re?.[at] === Infinity)) {
    rates.get(id)[at] = cpuRate(id, at % stride, (at / stride) | 0); exactRate.add(id * 16777216 + at);
  }
  const rateError = (id, at) => {
    if (exactRate.has(id * 16777216 + at)) return 0;
    const error = costs.get(id)?.Re?.[at] ?? 0;
    return strategyCertifiedRateError(error);
  };
  let mapTotal = 1, rateTotal = 1, rateTotalError = 0;
  if (maps) {
    mapTotal = sumStrategyValues(maps[0], 0, maps[0].length);
    rateTotal = 0;
    if (rates?.has(0)) rateTotal = sumStrategyValues(rates.get(0), 0, rates.get(0).length);
    else for (let by = 0; by < rows; by++) for (let bx = 0; bx < stride; bx++) rateTotal += candidateRate(bx, by);
    if (certifiedRates && !options.exactTotal) {
      let error = 0;
      for (let at = 0; at < stride * rows; at++) error += rateError(0, at);
      rateTotalError = sumRateError(rateTotal, error, stride * rows);
      if (!(rateTotalError < rateTotal)) {
        rateTotal = 0;
        for (let by = 0; by < rows; by++) for (let bx = 0; bx < stride; bx++) {
          const at = by * stride + bx, r = cpuRate(0, bx, by);
          rates.get(0)[at] = r; exactRate.add(at); rateTotal += r;
        }
        rateTotalError = 0;
      }
    }
    if (certifiedRates && !(rateTotal > 0 && Number.isFinite(rateTotal))) throw new Error('Certified measured rates need a positive finite normalizer.');
  }
  const doubt = options.mapDoubt || 0, totalDoubt = options.exactTotal ? 0 : options.totalDoubt ?? doubt;
  const rateTotalDoubt = strategyMeasuredRateTotalDoubt(options.exactTotal, certifiedRates, rateTotalError, rateTotal, rateDoubt, options.rateTotalDoubt);
  function measuredCost(id, bx, by, bw, bh, R) {
    const m = addStrategyMapCells(maps[id], stride, bx, by, bw, 0, bw * bh);
    const at = by * stride + bx, key = id * 16777216 + at, exact = exactCells?.has(at);
    if (exact && boundedRates && rates?.has(id) && !exactRate.has(key)) { R = rates.get(id)[at] = cpuRate(id, bx, by); exactRate.add(key); }
    const rateExact = exactRate.has(key);
    return strategyMeasuredPrice(m, R, lambda, mapTotal, rateTotal, doubt, exact, rateExact, certifiedRates,
      certifiedRates && !rateExact ? rateError(id, at) : 0, rateDoubt);
  }
  const exactCells = options.exactCells, open = [], reprices = [];
  let reverted = 0;
  const selector = createStrategySelector({options, lambda, stride, rows, allowed, inhom, useMask, bounded,
    maps, doubt, rateDoubt, costDoubt, certifiedCosts, boundedRates, mapTotal, rateTotal, totalDoubt, rateTotalDoubt, candidate});
  const {fits, region} = selector;
  if (selector.largerFirst) for (const id of [4, 5]) if (allowed.has(id)) tableFor(id, comps, sizeScale, tables);
  if (options.priceAll) {
    const out = Object.assign(new Map(), {certified: true}), idList = [...new Set([0, ...ids])];
    if (options.cells) {
      for (const id of idList) { const t = TRANSFORMS[id]; out.set(id, {D: [], R: [], points: [], seen: new Set(), w: t.width / 8, h: t.height / 8}); }
      for (const {bx: cx, by: cy} of options.cells) for (const id of idList) {
        const {D, R, w: bw, h: bh, points, seen} = out.get(id);
        for (let dy = 0; dy < 4; dy++) for (let dx = 0; dx < 4; dx++) {
          const bx = cx + dx, by = cy + dy, at = by * stride + bx;
          if (bx % bw === 0 && by % bh === 0 && fits(id, bx, by) && !seen.has(at)) {
            const c = full(id, bx, by);
            seen.add(at); points.push(at); D.push(c.D); R.push(c.R);
          }
        }
      }
      return out;
    }
    for (const id of idList) {
      const t = TRANSFORMS[id], D = new Float64Array(stride * rows).fill(NaN), R = new Float64Array(stride * rows).fill(NaN);
      const bw = t.width / 8, bh = t.height / 8;
      for (let by = 0; by < rows; by++) for (let bx = 0; bx < stride; bx++) if (fits(id, bx, by)) {
        const c = full(id, bx, by);
        D[by * stride + bx] = c.D; R[by * stride + bx] = c.R;
      }
      out.set(id, {D, R, w: bw, h: bh});
    }
    return out;
  }
  const chosen = [];
  if (options.layout) for (const {id, bx, by} of options.layout) chosen.push(candidate(id, bx, by));
  else {
    const [cy0, cy1] = options.regionRows ?? [0, rows];
    for (let cy = cy0; cy < Math.min(rows, cy1); cy += region) for (let cx = 0; cx < stride; cx += region) {
      if (keepChosen && vk) vk.region();
      let {list, opened} = selector.choose(cx, cy);
      if (opened && certifiedCosts) {
        builder.repricing = true;
        if (keepChosen && vk) vk.region();
        ({list, opened} = selector.choose(cx, cy));
        builder.repricing = false; reprices.push({bx: cx, by: cy, size: region});
      }
      chosen.push(...(keepChosen ? list.map(c => c.light ? make(c) : c) : list));
      if (opened) open.push({bx: cx, by: cy, size: region});
    }
    if (options.band) return {chosen};
    if (options.regionRows) return {chosen: packChoices(chosen), useMask};
    if (useMask) {
      for (const fam of [5, 4, 6]) {
        const count = strategyFamilyCount(chosen, fam);
        if (count > 0 && count < 8) {
          reverted += count;
          revertStrategyFamily(chosen, fam);
        }
      }
    }

  }
  if (options.chooseOnly) return {layout: chosen.map(({id, bx, by}) => ({id, bx, by})), open, reprices, reverted, settled: builder.settled};
  return {...builder.finish(chosen), open, reprices, reverted, settled: builder.settled};
}

export function strategyCosts(base, width, height, options) {
  return xybStrategies(base, width, height, {...options, priceOnly: true, keepChosen: false, chooseOnly: true, priceAll: true});
}

export function auditCosts(base, width, height, options, priced) {
  const stride = Math.ceil(width / 8), rows = Math.ceil(height / 8), by0 = Math.max(0, Math.floor((rows >> 1) / 32) * 32);
  const cells = [];
  for (let i = 0; i < 8; i++) {
    const bx = Math.max(0, Math.min(stride - 4, Math.floor((i + 0.5) * stride / 8))) & ~3, by = Math.max(0, Math.min(rows - 4, by0 + (i & 3) * 8)) & ~3;
    if (bx >= 0 && by >= 0) cells.push({bx, by});
  }
  const own = xybStrategies(base, width, height, {...options, maskWeight: priced.weight, priceOnly: true, keepChosen: false, chooseOnly: true, priceAll: true, cells});
  let worst = 0;
  for (const [id, mine] of own) {
    const theirs = priced.costs.get(id);
    if (!theirs) continue;
    const pts = mine.points;
    for (let k = 0; k < (pts ? pts.length : mine.D.length); k++) {
      const at = pts ? pts[k] : k, myD = mine.D[k], myR = mine.R[k];
      if (Number.isNaN(myD)) continue;
      if (theirs.De?.[at] === Infinity) continue;
      if (theirs.De && !(theirs.De[at] >= 0 && Number.isFinite(theirs.De[at]) && theirs.Re?.[at] >= 0 && Number.isFinite(theirs.D[at]) && Number.isFinite(theirs.R[at]))) return Infinity;
      const ratio = (d, bound) => d === 0 ? 0 : d / (bound || 0);
      const bound = (theirs.De?.[at] ?? 0) - maskDoubtOver(priced.weightDoubt || 0, stride, at % stride, Math.floor(at / stride), mine.w, mine.h) * Math.abs(theirs.D[at]);
      worst = Math.max(worst, ratio(Math.abs(myD - theirs.D[at]), bound), ratio(Math.abs(myR - theirs.R[at]), theirs.Re?.[at]));
    }
  }
  return worst;
}

import {encodeStrategyImage} from './varblock-write.mjs';
export {seedLearnedOrderCounts, learnedOrders, learnedOrderCounts, encodeStrategyImage, optimalLearnedOrders, encodeStrategyImageSteps} from './varblock-write.mjs';

export function encodeXYBStrategies(rgba, width, height, quality, photoOptions, strategyOptions = {}) {
  const base = complete(photoXYBSteps(rgba, width, height, quality, {...photoOptions, keepPlanes: true}));
  const {image, counts, layout} = xybStrategies(base, width, height, {deadzone: photoOptions.deadzone, ...strategyOptions});
  return {bytes: encodeStrategyImage(image), counts, layout};
}


export {cellSums} from './photo-distance-cells.mjs';


