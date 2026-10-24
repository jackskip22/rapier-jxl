// SPDX-License-Identifier: MIT
import {exactExp, exactLog, exactLog2, exactPow} from './exact-math.mjs';
import {complete} from './bits.mjs';
import {photoXYBSteps} from './photo-xyb.mjs';
import {scaledDCT, smallTransform, naturalOrder, lowFrequencies, TRANSFORMS} from './vardct-strategies.mjs';
import {zeroDensityContext} from './vardct.mjs';
import {strategyAnsSteps} from './coefficient-ans.mjs';
import {prepareCoefficientOrders, COEFFICIENT_ORDER_BUCKETS} from './coefficient-orders.mjs';
import {prepareQuantParams, quantParamSteps} from './quantization-params.mjs';
import {ZIGZAG} from './jfif.mjs';
import {hybridToken, uintConfig} from './prefix.mjs';

const VB_SCAN = ZIGZAG.map(n => ((n & 7) << 3) | (n >> 3));
const VB_CONFIG = uintConfig(4, 1, 0), VB_ZD = 458, VB_NZ = 37, VB_TOKENS = 64;
const vbPackSigned = v => v < 0 ? -2 * v - 1 : 2 * v;
export const nzBucket = p => { p = Math.min(p, 64); return p < 8 ? p : 4 + (p >> 1); };
const vbSlots = [0, 0, 0];
export function token(value) { hybridToken(VB_CONFIG, value, vbSlots); return [Math.min(VB_TOKENS - 1, vbSlots[0]), vbSlots[1]]; }

function vbWalk(stride, rows, visit) {
  const row = [0, 1, 2].map(() => new Int32Array(32 * 32));
  for (let gy = 0; gy < Math.ceil(rows / 32); gy++) for (let gx = 0; gx < Math.ceil(stride / 32); gx++) {
    const bw = Math.min(32, stride - gx * 32), bh = Math.min(32, rows - gy * 32);
    for (let by = 0; by < bh; by++) for (let bx = 0; bx < bw; bx++) for (const c of [1, 0, 2]) {
      const r = row[c], predicted = bx === 0 ? (by === 0 ? 32 : r[(by - 1) * 32]) : by === 0 ? r[bx - 1] : (r[(by - 1) * 32 + bx] + r[by * 32 + bx - 1] + 1) >> 1;
      r[by * 32 + bx] = visit(c, (gy * 32 + by) * stride + gx * 32 + bx, predicted);
    }
  }
}

const VB_RATE_MODELS = new WeakMap();
export function rateModel(image, stride, rows, smoothing) {
  const kept = VB_RATE_MODELS.get(image)?.get(smoothing);
  if (kept) return kept;
  const model = buildRateModel(image, stride, rows, smoothing);
  (VB_RATE_MODELS.get(image) || VB_RATE_MODELS.set(image, new Map()).get(image)).set(smoothing, model);
  return model;
}
function buildRateModel(image, stride, rows, smoothing) {
  const zd = [0, 1, 2].map(() => new Float64Array(VB_ZD * VB_TOKENS)), nz = [0, 1, 2].map(() => new Float64Array(VB_NZ * VB_TOKENS));
  vbWalk(stride, rows, (c, b, predicted) => {
    const coeffs = image.components[c].coeffs, at = b * 64;
    let count = 0;
    for (let k = 1; k < 64; k++) if (coeffs[at + k]) count++;
    nz[c][nzBucket(predicted) * VB_TOKENS + token(count)[0]]++;
    let prev = count > 4 ? 0 : 1, left = count;
    for (let k = 1; k < 64 && left; k++) {
      const q = coeffs[at + VB_SCAN[k]];
      zd[c][zeroDensityContext(left, k, prev) * VB_TOKENS + token(vbPackSigned(q))[0]]++;
      prev = q ? 1 : 0; left -= prev;
    }
    return count;
  });
  const bits = (table, contexts) => {
    const all = new Float64Array(VB_TOKENS).fill(0.5);
    for (let i = 0; i < contexts; i++) for (let t = 0; t < VB_TOKENS; t++) all[t] += table[i * VB_TOKENS + t];
    let total = 0; for (const v of all) total += v;
    const out = new Float64Array(contexts * VB_TOKENS);
    for (let i = 0; i < contexts; i++) {
      let n = 0; for (let t = 0; t < VB_TOKENS; t++) n += table[i * VB_TOKENS + t];
      for (let t = 0; t < VB_TOKENS; t++) out[i * VB_TOKENS + t] = -exactLog2((table[i * VB_TOKENS + t] + smoothing * all[t] / total) / (n + smoothing));
    }
    return out;
  };
  return {zd: zd.map(t => bits(t, VB_ZD)), nz: nz.map(t => bits(t, VB_NZ))};
}


const VB_ONE = [1 - 0.05465007330715401, 1 - 0.07005449891748593, 1 - 0.049935103337343655];
const vbRecon = (m, c) => m === 0 ? 0 : m === 1 ? VB_ONE[c] : m - 0.145 / m;
const VB_QS = 256;

const VB_SMALL = new Set([3, 12, 13]);
function freqOf(id, pos, sizeScale) {
  if (id === 3) {
    if (pos === 1 || pos === 8 || pos === 9) return [pos & 1, pos >> 3, VB_SMALL_SCALE];
    return [2 * ((pos & 7) >> 1), 2 * ((pos >> 3) >> 1), 2 * VB_SMALL_SCALE];
  }
  if (id === 12 || id === 13) {
    if (pos === 8) return [0, 1, VB_SMALL_SCALE];
    return [pos & 7, 2 * ((pos >> 3) >> 1), 8 / Math.sqrt(32) * VB_SMALL_SCALE];
  }
  const t = TRANSFORMS[id], w = t.width, h = t.height, L = Math.max(w, h), S = Math.min(w, h), wide = w > h;
  const fl = (pos % L) * 8 / L, fs = Math.floor(pos / L) * 8 / S;
  return [wide ? fl : fs, wide ? fs : fl, 8 / Math.sqrt(w * h) * (w * h > 64 ? sizeScale : 1)];
}
const VB_HIGH = new Map();
function highOf(id, size) {
  let h = VB_HIGH.get(id);
  if (!h) { h = Uint8Array.from({length: size}, (_, pos) => { const [fx, fy] = freqOf(id, pos, 1); return fx >= 4 || fy >= 4 ? 1 : 0; }); VB_HIGH.set(id, h); }
  return h;
}
function stepAt(quant, id, pos, sizeScale) {
  const [fx, fy, scale] = freqOf(id, pos, sizeScale);
  const x0 = Math.min(7, Math.floor(fx)), y0 = Math.min(7, Math.floor(fy)), x1 = Math.min(7, x0 + 1), y1 = Math.min(7, y0 + 1);
  const ax = fx - x0, ay = fy - y0, q = (y, x) => quant[y * 8 + x];
  const v = (q(y0, x0) * (1 - ax) + q(y0, x1) * ax) * (1 - ay) + (q(y1, x0) * (1 - ax) + q(y1, x1) * ax) * ay;
  return id === 0 ? Math.max(1, Math.round(v * scale)) : v * scale;
}

let VB_FIELD = 32, VB_SMALL_SCALE = 1;
const VB_BANDS = 12;

function fitBands(target, L, S) {
  const B = VB_BANDS, scale = (B - 1) / (1.4142135623730951 + .000001), A = new Float64Array(B * B), y = new Float64Array(B);
  for (let k = 1; k < L * S; k++) {
    const x = (k % L) / (L - 1), yy = Math.floor(k / L) / (S - 1), p = Math.sqrt(x * x + yy * yy) * scale;
    const i = Math.min(B - 2, Math.floor(p)), t = p - i, lw = exactLog(8 * 255 * VB_QS / (VB_FIELD * target[k]));
    const a = [[i, 1 - t], [i + 1, t]];
    for (const [r, wr] of a) { y[r] += wr * lw; for (const [c2, wc] of a) A[r * B + c2] += wr * wc; }
  }
  for (let i = 0; i < B; i++) A[i * B + i] += 1e-6;
  for (let i = 0; i < B; i++) {
    for (let r = i + 1; r < B; r++) { const f = A[r * B + i] / A[i * B + i]; for (let c2 = i; c2 < B; c2++) A[r * B + c2] -= f * A[i * B + c2]; y[r] -= f * y[i]; }
  }
  const beta = new Float64Array(B);
  for (let i = B - 1; i >= 0; i--) { let v = y[i]; for (let c2 = i + 1; c2 < B; c2++) v -= A[i * B + c2] * beta[c2]; beta[i] = v / A[i * B + i]; }
  const bands = [exactExp(beta[0])];
  for (let i = 1; i < B; i++) { const r = exactExp(beta[i] - beta[i - 1]); bands.push(r >= 1 ? r - 1 : 1 - 1 / r); }
  return bands;
}

function tableFor(id, components, sizeScale, cache) {
  if (cache.has(TRANSFORMS[id].table)) return cache.get(TRANSFORMS[id].table);
  const t = TRANSFORMS[id], w = t.width, h = t.height, L = Math.max(w, h), S = Math.min(w, h);
  const targets = components.map(comp => Float64Array.from({length: L * S}, (_, k) => stepAt(comp.quant, id, k, sizeScale)));
  const weight = step => 8 * 255 * VB_QS / (VB_FIELD * step);
  let table, input;
  if (id === 0) table = {w: L, h: S, planes: targets.map(p => Int32Array.from(p))};
  else if (id === 3) {
    const bands = targets.map(p => fitBands(Float64Array.from({length: 16}, (_, k) => p[2 * (k >> 2) * 8 + 2 * (k & 3)]), 4, 4));
    input = {mode: 'dct4', bands, multipliers: targets.map((p, c) => [bands[c][0] / weight(p[1]), bands[c][0] / weight(p[9])])};
  } else if (id === 12 || id === 13) {
    const bands = targets.map(p => fitBands(Float64Array.from({length: 32}, (_, k) => p[2 * (k >> 3) * 8 + (k & 7)]), 8, 4));
    input = {mode: 'dct4x8', bands, multipliers: targets.map((p, c) => bands[c][0] / weight(p[8]))};
  } else input = {mode: 'dct', bands: targets.map(p => fitBands(p, L, S))};
  if (input) {
    const parameters = prepareQuantParams(input, L, S, t.table);
    table = {w: L, h: S, parameters, planes: quantParamSteps(parameters, VB_QS, VB_FIELD, [0, 1, 2])};
  }
  cache.set(t.table, table);
  return table;
}

export function strategyInputs(base, width, height, options = {}) {
  const {sizeScale = 1, ids = [5, 10, 11, 4, 6, 7], deadzone, weights = [1, 1, 1]} = options;
  const comps = base.components, stride = comps[0].stride, rows = comps[0].rows;
  VB_FIELD = base.quantFields ? base.quantFieldBase : 32; VB_SMALL_SCALE = options.smallScale ?? 1;
  const yStep = comps[1].quant[1] / VB_QS, norm = [0, 1, 2].map(c => weights[c] * (yStep / (comps[c].quant[1] / VB_QS)) * (yStep / (comps[c].quant[1] / VB_QS)) / (yStep * yStep));
  const tables = new Map(), transforms = new Map();
  for (const id of [0, ...ids]) {
    if (VB_SMALL.has(id) || transforms.has(id)) continue;
    const t = TRANSFORMS[id], bw = t.width / 8, bh = t.height / 8, table = tableFor(id, comps, sizeScale, tables);
    transforms.set(id, {w: t.width, h: t.height, bw, bh, order: naturalOrder(bw, bh), high: highOf(id, t.width * t.height), steps: [0, 1, 2].map(c => table.planes[c])});
  }
  const fine = new Float32Array(stride * rows).fill(1);
  if (base.quantFields) for (let i = 0; i < fine.length; i++) fine[i] = base.quantFields[i] / base.quantFieldBase;
  return {stride, rows, planes: base.planes, transforms, tokens: options.model !== 'simple' ? rateModel(base, stride, rows, 8) : null,
    norm, dead: deadzone || null, fine, cfl: base.cfl, one: VB_ONE, dcSteps: comps.map(comp => comp.quant[0] / VB_QS)};
}

export function xybStrategies(base, width, height, options = {}) {
  const {lambda = 1, sizeScale = 1, ids = [5, 10, 11, 4, 6, 7], rate: rc = [4, 3, 2, 0.6], deadzone, weights = [1, 1, 1]} = options;
  const comps = base.components, stride = comps[0].stride, rows = comps[0].rows, W = stride * 8, planes = base.planes;
  VB_FIELD = base.quantFields ? base.quantFieldBase : 32; VB_SMALL_SCALE = options.smallScale ?? 1;
  const fineOf = (bx, by) => base.quantFields ? base.quantFields[by * stride + bx] / base.quantFieldBase : 1;
  const tables = new Map(), cfl = base.cfl, dead = deadzone;
  const yStep = comps[1].quant[1] / VB_QS, norm = [0, 1, 2].map(c => weights[c] * (yStep / (comps[c].quant[1] / VB_QS)) * (yStep / (comps[c].quant[1] / VB_QS)) / (yStep * yStep));
  tableFor(0, comps, sizeScale, tables);
  const allowed = new Set(ids);
  const tokens = options.model !== 'simple' && rateModel(base, stride, rows, 8);
  const tokenBits = (c, plane, order, area, size) => {
    let count = 0;
    for (let k = area; k < size; k++) if (plane[order[k]]) count++;
    const [ct, ce] = token(count);
    let bits = tokens.nz[c][nzBucket(Math.ceil(count / area)) * 64 + ct] + ce;
    let prev = count > size / 16 ? 0 : 1, left = count;
    for (let k = area; k < size && left; k++) {
      const q = plane[order[k]], [t, e] = token(q < 0 ? -2 * q - 1 : 2 * q);
      bits += tokens.zd[c][zeroDensityContext(Math.ceil(left / area), Math.floor(k / area), prev) * 64 + t] + e;
      prev = q ? 1 : 0; left -= prev;
    }
    return bits;
  };
  const candidateRate = (bx, by) => { const m = maps; maps = null; const r = full(0, bx, by).R; maps = m; return r; };
  const rates = options.rates;
  const costs = options.costs;
  if (costs && rates) for (const [id, c] of costs) if (!rates.has(id)) rates.set(id, c.R);
  const candidate = (id, bx, by) => {
    const t = TRANSFORMS[id], bw = t.width / 8, bh = t.height / 8;
    if (costs?.has(id) && !maps) { const c = costs.get(id), at = by * stride + bx; return {id, bx, by, bw, bh, light: true, J: c.D[at] + lambda * c.R[at]}; }
    if (!maps || !rates?.has(id)) return full(id, bx, by);
    let m = 0;
    for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) m += maps[id][(by + y) * stride + bx + x];
    return {id, bx, by, bw, bh, light: true, J: m / mapTotal + lambda * rates.get(id)[by * stride + bx] / rateTotal};
  };
  const gpuBlocks = options.blocks;
  const priced = !options.layout;
  const full = (id, bx, by) => {
    const t = TRANSFORMS[id], w = t.width, h = t.height, bw = w / 8, bh = h / 8, area = bw * bh, size = w * h;
    const certified = options.exact?.get(id + ':' + bx + ':' + by);
    if (certified) { tableFor(id, comps, sizeScale, tables); return {id, bx, by, bw, bh, area, size, order: naturalOrder(bw, bh), coeffs: certified.coeffs, dc: certified.dc, R: 0, J: 0}; }
    if (gpuBlocks?.has(id) && !maps) {
      tableFor(id, comps, sizeScale, tables);
      const {coeffs, dc} = gpuBlocks.get(id)(bx, by), R = costs.get(id).R[by * stride + bx];
      return {id, bx, by, bw, bh, area, size, order: naturalOrder(bw, bh), coeffs, dc, R, J: costs.get(id).D[by * stride + bx] + lambda * R};
    }
    const table = tableFor(id, comps, sizeScale, tables), order = naturalOrder(bw, bh), L = Math.max(w, h);
    const ti = (by >> 3) * cfl.width + (bx >> 3), factor = [cfl.x[ti] / 84, 0, cfl.b[ti] / 84];
    const cache = options.transforms, key = id * 16777216 + by * stride + bx;
    let transformed = cache?.get(key);
    if (!transformed) {
      const pixels = new Float64Array(size);
      transformed = [];
      for (let c = 0; c < 3; c++) {
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) pixels[y * w + x] = planes[c][(by * 8 + y) * W + bx * 8 + x];
        transformed.push(VB_SMALL.has(id) ? smallTransform(pixels, id) : scaledDCT(pixels, w, h));
      }
      cache?.set(key, transformed);
    }
    const high = highOf(id, size);
    const coeffs = [], dc = [], fine = fineOf(bx, by);
    let D = 0, R = 0;
    for (const c of [1, 0, 2]) {
      const tr = transformed[c], plane = new Int32Array(size), steps = table.planes[c];
      const low = lowFrequencies(tr, bw, bh), dcStep = comps[c].quant[0] / VB_QS;
      dc[c] = Int32Array.from(low, v => Math.round(v * 8 / dcStep));
      let nz = 0, zeros = 0, run = 0, d = 0;
      const R0 = R;
      if (!priced) {
        const fc = factor[c], luma = transformed[1];
        for (let k = area; k < size; k++) {
          const pos = order[k], step = steps[pos];
          const coefficient = tr[pos] - (c !== 1 ? fc * luma[pos] : 0);
          const v = coefficient * 8 * VB_QS / step * fine, a = Math.abs(v);
          const q = a < (dead ? dead[c * 2 + high[pos]] : 0.5) ? 0 : Math.round(a);
          plane[pos] = v < 0 ? -q : q;
        }
        coeffs[c] = plane;
        continue;
      }
      for (let k = area; k < size; k++) {
        const pos = order[k], step = steps[pos];
        const coefficient = tr[pos] - (c !== 1 ? factor[c] * transformed[1][pos] : 0);
        const v = coefficient * 8 * VB_QS / step * fine, a = Math.abs(v);
        const threshold = dead ? dead[c * 2 + high[pos]] : 0.5;
        const q = a < threshold ? 0 : Math.round(a);
        plane[pos] = v < 0 ? -q : q;
        const e = (a - vbRecon(q, c)) * step / (8 * VB_QS * fine);
        d += e * e;
        if (q && priced) { nz++; R += rc[1] + rc[2] * exactLog2(q); zeros += run; run = 0; } else if (priced) run++;
      }
      D += norm[c] * d * w * h;
      if (!priced) {} else if (tokens) R += tokenBits(c, plane, order, area, size) - (R - R0);
      else R += rc[0] + rc[3] * zeros;
      coeffs[c] = plane;
    }
    if (maps) {
      let m = 0;
      for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) m += maps[id][(by + y) * stride + bx + x];
      return {id, bx, by, bw, bh, area, size, order, coeffs, dc, J: m / mapTotal + lambda * R / rateTotal};
    }
    if (rates) { if (!rates.has(id)) rates.set(id, new Float64Array(stride * rows)); rates.get(id)[by * stride + bx] = R; }
    return {id, bx, by, bw, bh, area, size, order, coeffs, dc, R, J: D + lambda * R};
  };
  let maps = options.maps;
  let mapTotal = 1, rateTotal = 1;
  if (maps) {
    mapTotal = maps[0].reduce((a, b) => a + b, 0);
    rateTotal = 0;
    if (rates?.has(0)) for (const r of rates.get(0)) rateTotal += r;
    else for (let by = 0; by < rows; by++) for (let bx = 0; bx < stride; bx++) rateTotal += candidateRate(bx, by);
  }
  const fits = (id, bx, by) => bx + TRANSFORMS[id].width / 8 <= stride && by + TRANSFORMS[id].height / 8 <= rows;
  const force = options.force;
  const best8 = (bx, by) => {
    if (force !== undefined) return candidate(VB_SMALL.has(force) ? force : 0, bx, by);
    let best = candidate(0, bx, by);
    for (const id of [3, 12, 13]) if (allowed.has(id)) { const c = candidate(id, bx, by); if (c.J < best.J) best = c; }
    return best;
  };
  const best16 = (bx, by) => {
    if (force !== undefined && [4, 6, 7].includes(force) && fits(force, bx, by) && (force === 4 || fits(force, force === 6 ? bx + 1 : bx, force === 6 ? by : by + 1))) return {list: force === 4 ? [candidate(4, bx, by)] : force === 6 ? [candidate(6, bx, by), candidate(6, bx + 1, by)] : [candidate(7, bx, by), candidate(7, bx, by + 1)], J: -Infinity};
    let best = [0, 1, 2, 3].filter(i => bx + (i & 1) < stride && by + (i >> 1) < rows).map(i => best8(bx + (i & 1), by + (i >> 1)));
    let J = best.reduce((s, b) => s + b.J, 0);
    if (force !== undefined) return {list: best, J};
    const tryOne = list => { const j = list.reduce((s, b) => s + b.J, 0); if (j < J) { J = j; best = list; } };
    if (allowed.has(4) && fits(4, bx, by)) tryOne([candidate(4, bx, by)]);
    if (allowed.has(6) && fits(6, bx, by) && fits(6, bx + 1, by)) tryOne([candidate(6, bx, by), candidate(6, bx + 1, by)]);
    if (allowed.has(7) && fits(7, bx, by) && fits(7, bx, by + 1)) tryOne([candidate(7, bx, by), candidate(7, bx, by + 1)]);
    return {list: best, J};
  };
  const chosen = [];
  if (options.layout) for (const {id, bx, by} of options.layout) chosen.push(candidate(id, bx, by));
  else {
    const best32 = (cx, cy) => {
      const quads = [[0, 0], [2, 0], [0, 2], [2, 2]].filter(([x, y]) => cx + x < stride && cy + y < rows).map(([x, y]) => best16(cx + x, cy + y));
      let list = quads.flatMap(q => q.list), J = quads.reduce((s, q) => s + q.J, 0);
      if (force !== undefined && [5, 10, 11].includes(force)) J = Infinity;
      const tryOne = l => { const j = l.reduce((s, b) => s + b.J, 0); if (j < J) { J = j; list = l; } };
      const allow32 = id => force === undefined ? allowed.has(id) : force === id;
      if (allow32(5) && fits(5, cx, cy)) tryOne([candidate(5, cx, cy)]);
      if (allow32(10) && fits(10, cx, cy) && fits(10, cx + 2, cy)) tryOne([candidate(10, cx, cy), candidate(10, cx + 2, cy)]);
      if (allow32(11) && fits(11, cx, cy) && fits(11, cx, cy + 2)) tryOne([candidate(11, cx, cy), candidate(11, cx, cy + 2)]);
      return {list, J};
    };
    const allow64 = id => force === undefined ? allowed.has(id) && (!maps || maps[id]) : force === id;
    const big = [18, 19, 20].some(allow64);
    for (let cy = 0; cy < rows; cy += big ? 8 : 4) for (let cx = 0; cx < stride; cx += big ? 8 : 4) {
      if (!big) { chosen.push(...best32(cx, cy).list); continue; }
      const cell = (x, y) => cx + x < stride && cy + y < rows ? best32(cx + x, cy + y) : {list: [], J: 0};
      const q = [cell(0, 0), cell(4, 0), cell(0, 4), cell(4, 4)];
      const join = (...parts) => ({list: parts.flatMap(p => p.list), J: parts.reduce((s, p) => s + p.J, 0)});
      const pick = (a, b) => b && b.J < a.J ? b : a, one = (id, x, y) => allow64(id) && fits(id, cx + x, cy + y) ? (c => ({list: [c], J: c.J}))(candidate(id, cx + x, cy + y)) : null;
      const half = (a, _, c) => force !== undefined ? c || a : pick(a, c);
      const tall = join(half(join(q[0], q[2]), null, one(19, 0, 0)), half(join(q[1], q[3]), null, one(19, 4, 0)));
      const wide = join(half(join(q[0], q[1]), null, one(20, 0, 0)), half(join(q[2], q[3]), null, one(20, 0, 4)));
      const best = force === 18 ? one(18, 0, 0) || join(...q) : force === 19 ? tall : force === 20 ? wide
        : pick(pick(pick(join(...q), tall), wide), one(18, 0, 0));
      chosen.push(...best.list);
    }
  }
  if (options.chooseOnly) return {layout: chosen.map(({id, bx, by}) => ({id, bx, by}))};
  for (let i = 0; i < chosen.length; i++) if (chosen[i].light) chosen[i] = full(chosen[i].id, chosen[i].bx, chosen[i].by);
  const at = new Int32Array(stride * rows).fill(-1), byFirst = new Map();
  const components = comps.map(comp => ({h: 1, v: 1, stride, rows, quant: comp.quant, coeffs: new Int16Array(0), dc: new Int32Array(stride * rows)}));
  let wideCoefficients = false;
  for (const block of chosen) {
    byFirst.set(block.by * stride + block.bx, block);
    for (let y = 0; y < block.bh; y++) for (let x = 0; x < block.bw; x++) {
      const pos = (block.by + y) * stride + block.bx + x;
      at[pos] = -2;
      for (let c = 0; c < 3; c++) components[c].dc[pos] = block.dc[c][y * block.bw + x];
    }
    for (const plane of block.coeffs) for (const v of plane) if (v < -32768 || v > 32767) wideCoefficients = true;
    delete block.J; delete block.R;
  }
  const groups = [], blocks = [];
  for (let gy = 0; gy < Math.ceil(rows / 32); gy++) for (let gx = 0; gx < Math.ceil(stride / 32); gx++) {
    const group = [];
    for (let by = gy * 32; by < Math.min(rows, gy * 32 + 32); by++) for (let bx = gx * 32; bx < Math.min(stride, gx * 32 + 32); bx++) {
      const block = byFirst.get(by * stride + bx);
      if (block) { at[by * stride + bx] = blocks.length; blocks.push(block); group.push(block); }
    }
    groups.push(group);
  }
  const used = new Set(blocks.map(b => TRANSFORMS[b.id].table));
  for (const family of tables.keys()) if (!used.has(family)) tables.delete(family);
  const counts = {};
  for (const b of blocks) counts[TRANSFORMS[b.id].name] = (counts[TRANSFORMS[b.id].name] || 0) + 1;
  const {planes: _p, values: _v, ...rest} = base;
  return {image: {...rest, components, wideCoefficients, strategyData: {groups, blocks, at, tables, stride}}, counts,
    layout: blocks.map(({id, bx, by}) => ({id, bx, by}))};
}

function learnedOrders(image) {
  const counts = new Map();
  for (const block of image.strategyData.blocks) {
    const bucket = COEFFICIENT_ORDER_BUCKETS.find(b => b.strategies.includes(TRANSFORMS[block.id].name));
    if (!bucket || bucket.name === 'small') continue;
    let c3 = counts.get(bucket.name);
    if (!c3) counts.set(bucket.name, c3 = [0, 1, 2].map(() => new Float64Array(block.size)));
    for (let c = 0; c < 3; c++) for (let k = block.area; k < block.size; k++) if (block.coeffs[c][block.order[k]]) c3[c][k]++;
  }
  const value = {};
  for (const [name, c3] of counts) {
    const bucket = COEFFICIENT_ORDER_BUCKETS.find(b => b.name === name), skip = bucket.lowFrequencyCount, size = c3[0].length;
    value[name] = c3.map(n => {
      const rest = Array.from({length: size - skip}, (_, i) => i + skip).sort((a, b) => Math.floor(n[b] / 4) - Math.floor(n[a] / 4) || a - b);
      return [...Array.from({length: skip}, (_, i) => i), ...rest];
    });
  }
  return prepareCoefficientOrders(value, 1);
}

export function encodeStrategyImage(image, orders = true, effort = 7) {
  return complete(strategyAnsSteps(image, effort, orders ? learnedOrders(image) : null));
}

export function encodeXYBStrategies(rgba, width, height, quality, photoOptions, strategyOptions = {}) {
  const base = complete(photoXYBSteps(rgba, width, height, quality, {...photoOptions, keepPlanes: true}));
  const {image, counts, layout} = xybStrategies(base, width, height, {deadzone: photoOptions.deadzone, ...strategyOptions});
  return {bytes: encodeStrategyImage(image), counts, layout};
}


export function cellSums(map, width, height, p = 3) {
  const stride = Math.ceil(width / 8), out = new Float64Array(stride * Math.ceil(height / 8));
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) out[(y >> 3) * stride + (x >> 3)] += exactPow(map[y * width + x], p);
  return out;
}

export function* closedLoopStrategySteps(base, width, height, options = {}) {
  const {p = 3, ids = [5, 10, 11, 4, 6, 7]} = options, maps = [], rates = new Map();
  const costs = (yield {varblocks: {kind: 'costs', base, width, height, options}}) || null;
  for (const id of [0, ...ids]) {
    const blocks = costs?.has(id) ? yield {varblocks: {kind: 'blocks', id}} : null;
    const forced = {...options, force: id, maps: null, rates, ...(costs ? {costs} : {}), ...(blocks ? {blocks: new Map([[id, blocks]])} : {})};
    maps[id] = (yield {measure: xybStrategies(base, width, height, forced).image, want: {p}}).cells;
  }
  if (!costs) return xybStrategies(base, width, height, {...options, maps, rates});
  const {layout} = xybStrategies(base, width, height, {...options, maps, rates, chooseOnly: true});
  const exact = yield {varblocks: {kind: 'exact', layout}};
  yield {varblocks: {kind: 'release'}};
  return xybStrategies(base, width, height, {...options, layout, ...(exact ? {exact} : {})});
}
