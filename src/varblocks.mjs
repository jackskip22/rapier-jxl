// SPDX-License-Identifier: MIT
import {exactExp, exactLog, exactLog2, exactPow} from './exact-math.mjs';
import {complete} from './bits.mjs';
import {photoXYBSteps} from './photo-xyb.mjs';
import {scaledDCT, scaledDCTAt, smallTransform, naturalOrder, lowFrequencies, TRANSFORMS} from './vardct-strategies.mjs';
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
export const VB_DOUBT = 2130706432;
function vbSettle(certified, id, bx, by, w, h, bw, bh, area, size, table, comps, planes, W, cfl, fine, dead) {
  const high = highOf(id, size), order = naturalOrder(bw, bh), ti = (by >> 3) * cfl.width + (bx >> 3), factor = [cfl.x[ti] / 84, 0, cfl.b[ti] / 84];
  const pixelsOf = c => { const p = new Float64Array(size); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) p[y * w + x] = planes[c][(by * 8 + y) * W + bx * 8 + x]; return p; };
  const pixels = [], exact = [null, null, null], need = [new Set(), new Set(), new Set()];
  const low = Array.from({length: area}, (_, k) => order[k]);
  for (let c = 0; c < 3; c++) {
    const q = certified.coeffs[c];
    for (let k = area; k < size; k++) if (q[order[k]] === VB_DOUBT) { need[c].add(order[k]); if (c !== 1) need[1].add(order[k]); }
    if (certified.dc[c].includes(VB_DOUBT)) for (const at of low) need[c].add(at);
  }
  for (let c = 0; c < 3; c++) if (need[c].size) { pixels[c] = pixelsOf(c); exact[c] = scaledDCTAt(pixels[c], w, h, need[c]); }
  for (let c = 0; c < 3; c++) {
    const q = certified.coeffs[c], steps = table.planes[c];
    for (let k = area; k < size; k++) {
      const pos = order[k];
      if (q[pos] !== VB_DOUBT) continue;
      const coefficient = exact[c].get(pos) - (c !== 1 ? factor[c] * exact[1].get(pos) : 0);
      const v = coefficient * 8 * VB_QS / steps[pos] * fine, a = Math.abs(v);
      const level = a < (dead ? dead[c * 2 + high[pos]] : 0.5) ? 0 : Math.round(a);
      q[pos] = v < 0 ? -level : level;
    }
    const dc = certified.dc[c];
    if (dc.includes(VB_DOUBT)) {
      const tr = new Float64Array(size);
      for (const at of low) tr[at] = exact[c].get(at);
      const lows = lowFrequencies(tr, bw, bh), dcStep = comps[c].quant[0] / VB_QS;
      for (let i = 0; i < area; i++) if (dc[i] === VB_DOUBT) dc[i] = Math.round(lows[i] * 8 / dcStep);
    }
  }
}
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

export class TransformCache extends Map {
  constructor(maxBytes) { super(); this.maxBytes = maxBytes; this.bytes = 0; this.source = null; }
  forSource(planes, width, height, stride, rows) {
    if (!(this.maxBytes > 0)) return null;
    if (!this.source) {
      try { this.source = [new WeakRef(planes[0]), new WeakRef(planes[1]), new WeakRef(planes[2]), width, height, stride, rows]; }
      catch (error) { if (error instanceof RangeError && !error.code) return null; throw error; }
    }
    const source = this.source;
    return source[0].deref() === planes[0] && source[1].deref() === planes[1] && source[2].deref() === planes[2]
      && source[3] === width && source[4] === height && source[5] === stride && source[6] === rows ? this : null;
  }
  set(key, planes) {
    if (this.has(key)) return this;
    const bytes = 1024 + planes.reduce((n, p) => n + p.byteLength, 0);
    if (this.bytes + bytes <= this.maxBytes) {
      try { super.set(key, planes); }
      catch (error) { if (error instanceof RangeError && !error.code) return this; throw error; }
      this.bytes += bytes;
    }
    return this;
  }
  delete(key) {
    const planes = this.get(key);
    if (!planes) return false;
    this.bytes -= 1024 + planes.reduce((n, p) => n + p.byteLength, 0);
    return super.delete(key);
  }
  clear() { super.clear(); this.bytes = 0; this.source = null; }
}

export function xybStrategies(base, width, height, options = {}) {
  const {lambda = 1, sizeScale = 1, ids = [5, 10, 11, 4, 6, 7], rate: rc = [4, 3, 2, 0.6], deadzone, weights = [1, 1, 1]} = options;
  const comps = base.components, stride = comps[0].stride, rows = comps[0].rows, W = stride * 8, planes = base.planes;
  const transforms = options.transforms instanceof TransformCache ? options.transforms.forSource(planes, width, height, stride, rows) : null;
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
    return {id, bx, by, bw, bh, light: true, ...measuredCost(id, bx, by, bw, bh, rates.get(id)[by * stride + bx])};
  };
  const gpuBlocks = options.blocks;
  const priced = !options.layout;
  const full = (id, bx, by) => {
    const t = TRANSFORMS[id], w = t.width, h = t.height, bw = w / 8, bh = h / 8, area = bw * bh, size = w * h;
    const certified = options.exact?.get(id + ':' + bx + ':' + by);
    if (certified) {
      const table = tableFor(id, comps, sizeScale, tables);
      if (certified.uncertain) vbSettle(certified, id, bx, by, w, h, bw, bh, area, size, table, comps, planes, W, cfl, fineOf(bx, by), dead);
      return {id, bx, by, bw, bh, area, size, order: naturalOrder(bw, bh), coeffs: certified.coeffs, dc: certified.dc, R: 0, J: 0};
    }
    if (gpuBlocks?.has(id) && !maps) {
      tableFor(id, comps, sizeScale, tables);
      const {coeffs, dc} = gpuBlocks.get(id)(bx, by), R = costs.get(id).R[by * stride + bx];
      return {id, bx, by, bw, bh, area, size, order: naturalOrder(bw, bh), coeffs, dc, R, J: costs.get(id).D[by * stride + bx] + lambda * R};
    }
    const table = tableFor(id, comps, sizeScale, tables), order = naturalOrder(bw, bh), L = Math.max(w, h);
    const ti = (by >> 3) * cfl.width + (bx >> 3), factor = [cfl.x[ti] / 84, 0, cfl.b[ti] / 84];
    const cache = transforms, key = id * 16777216 + by * stride + bx;
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
    if (maps) return {id, bx, by, bw, bh, area, size, order, coeffs, dc, ...measuredCost(id, bx, by, bw, bh, R)};
    if (rates) { if (!rates.has(id)) rates.set(id, new Float64Array(stride * rows)); rates.get(id)[by * stride + bx] = R; }
    return {id, bx, by, bw, bh, area, size, order, coeffs, dc, R, J: D + lambda * R};
  };
  let maps = options.maps;
  const rateDoubt = options.rateDoubt || 0, exactRate = new Set();
  const cpuRate = (id, bx, by) => { const m = maps; maps = null; const r = full(id, bx, by).R; maps = m; return r; };
  if (maps && rateDoubt && costs) for (const [id, c] of costs) if (c.uncertain && rates?.has(id)) for (let at = 0; at < c.uncertain.length; at++) if (c.uncertain[at]) {
    rates.get(id)[at] = cpuRate(id, at % stride, (at / stride) | 0); exactRate.add(id * 16777216 + at);
  }
  let mapTotal = 1, rateTotal = 1;
  if (maps) {
    mapTotal = maps[0].reduce((a, b) => a + b, 0);
    rateTotal = 0;
    if (rates?.has(0)) for (const r of rates.get(0)) rateTotal += r;
    else for (let by = 0; by < rows; by++) for (let bx = 0; bx < stride; bx++) rateTotal += candidateRate(bx, by);
  }
  const doubt = options.mapDoubt || 0, totalDoubt = options.exactTotal ? 0 : options.totalDoubt ?? doubt;
  const rateTotalDoubt = options.exactTotal || !rateDoubt ? 0 : options.rateTotalDoubt ?? rateDoubt;
  function measuredCost(id, bx, by, bw, bh, R) {
    let m = 0;
    for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) m += maps[id][(by + y) * stride + bx + x];
    const at = by * stride + bx, key = id * 16777216 + at, exact = exactCells?.has(at);
    if (exact && rateDoubt && rates?.has(id) && !exactRate.has(key)) { R = rates.get(id)[at] = cpuRate(id, bx, by); exactRate.add(key); }
    const r = lambda * R;
    return {J: m / mapTotal + r / rateTotal, m, me: exact ? 0 : doubt * m, r, re: !rateDoubt || exactRate.has(key) ? 0 : rateDoubt * r};
  }
  const exactCells = options.exactCells, open = [];
  let opened = false;
  const over = (d, e, total, t) => {
    const lo = d - e, hi = d + e;
    return [lo >= 0 ? lo / (total * (1 + t)) : lo / (total * (1 - t)), hi >= 0 ? hi / (total * (1 - t)) : hi / (total * (1 + t))];
  };
  const beats = (b, a) => {
    const wins = b.J < a.J;
    if ((doubt || rateDoubt) && Number.isFinite(a.J) && Number.isFinite(b.J) && (a.me || b.me || a.re || b.re || totalDoubt || rateTotalDoubt)) {
      const [m0, m1] = over((b.m ?? 0) - (a.m ?? 0), (b.me ?? 0) + (a.me ?? 0), mapTotal, totalDoubt);
      const [r0, r1] = over((b.r ?? 0) - (a.r ?? 0), (b.re ?? 0) + (a.re ?? 0), rateTotal, rateTotalDoubt), slack = 1e-14 * (Math.abs(a.J) + Math.abs(b.J));
      if (!(m1 + r1 < -slack || m0 + r0 > slack)) opened = true;
    }
    return wins;
  };
  const range = list => ({J: list.reduce((s, b) => s + b.J, 0), m: list.reduce((s, b) => s + (b.m ?? 0), 0), me: list.reduce((s, b) => s + (b.me ?? 0), 0),
    r: list.reduce((s, b) => s + (b.r ?? 0), 0), re: list.reduce((s, b) => s + (b.re ?? 0), 0)});
  const fits = (id, bx, by) => bx + TRANSFORMS[id].width / 8 <= stride && by + TRANSFORMS[id].height / 8 <= rows;
  const force = options.force;
  const best8 = (bx, by) => {
    if (force !== undefined) return candidate(VB_SMALL.has(force) ? force : 0, bx, by);
    let best = candidate(0, bx, by);
    for (const id of [3, 12, 13]) if (allowed.has(id)) { const c = candidate(id, bx, by); if (beats(c, best)) best = c; }
    return best;
  };
  const best16 = (bx, by) => {
    if (force !== undefined && [4, 6, 7].includes(force) && fits(force, bx, by) && (force === 4 || fits(force, force === 6 ? bx + 1 : bx, force === 6 ? by : by + 1))) return {list: force === 4 ? [candidate(4, bx, by)] : force === 6 ? [candidate(6, bx, by), candidate(6, bx + 1, by)] : [candidate(7, bx, by), candidate(7, bx, by + 1)], J: -Infinity};
    let best = [0, 1, 2, 3].filter(i => bx + (i & 1) < stride && by + (i >> 1) < rows).map(i => best8(bx + (i & 1), by + (i >> 1)));
    let cur = range(best);
    if (force !== undefined) return {list: best, ...cur};
    const tryOne = list => { const r = range(list); if (beats(r, cur)) { cur = r; best = list; } };
    if (allowed.has(4) && fits(4, bx, by)) tryOne([candidate(4, bx, by)]);
    if (allowed.has(6) && fits(6, bx, by) && fits(6, bx + 1, by)) tryOne([candidate(6, bx, by), candidate(6, bx + 1, by)]);
    if (allowed.has(7) && fits(7, bx, by) && fits(7, bx, by + 1)) tryOne([candidate(7, bx, by), candidate(7, bx, by + 1)]);
    return {list: best, ...cur};
  };
  const chosen = [];
  if (options.layout) for (const {id, bx, by} of options.layout) chosen.push(candidate(id, bx, by));
  else {
    const best32 = (cx, cy) => {
      if (force === 5 && fits(5, cx, cy)) { const c = candidate(5, cx, cy); return {list: [c], ...range([c])}; }
      if (force === 10 && fits(10, cx, cy) && fits(10, cx + 2, cy)) { const l = [candidate(10, cx, cy), candidate(10, cx + 2, cy)]; return {list: l, ...range(l)}; }
      if (force === 11 && fits(11, cx, cy) && fits(11, cx, cy + 2)) { const l = [candidate(11, cx, cy), candidate(11, cx, cy + 2)]; return {list: l, ...range(l)}; }
      const quads = [[0, 0], [2, 0], [0, 2], [2, 2]].filter(([x, y]) => cx + x < stride && cy + y < rows).map(([x, y]) => best16(cx + x, cy + y));
      let list = quads.flatMap(q => q.list), cur = range(quads);
      if (force !== undefined && [5, 10, 11].includes(force)) cur = {J: Infinity};
      const tryOne = l => { const r = range(l); if (beats(r, cur)) { cur = r; list = l; } };
      const allow32 = id => force === undefined ? allowed.has(id) : force === id;
      if (allow32(5) && fits(5, cx, cy)) tryOne([candidate(5, cx, cy)]);
      if (allow32(10) && fits(10, cx, cy) && fits(10, cx + 2, cy)) tryOne([candidate(10, cx, cy), candidate(10, cx + 2, cy)]);
      if (allow32(11) && fits(11, cx, cy) && fits(11, cx, cy + 2)) tryOne([candidate(11, cx, cy), candidate(11, cx, cy + 2)]);
      return {list, ...cur};
    };
    const allow64 = id => force === undefined ? allowed.has(id) && (!maps || maps[id]) : force === id;
    const big = [18, 19, 20].some(allow64);
    const region = big ? 8 : 4;
    for (let cy = 0; cy < rows; cy += region) for (let cx = 0; cx < stride; cx += region) {
      opened = false;
      if (!big) chosen.push(...best32(cx, cy).list);
      else chosen.push(...best64(cx, cy).list);
      if (opened) open.push({bx: cx, by: cy, size: region});
    }
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
  }
  if (options.chooseOnly) return {layout: chosen.map(({id, bx, by}) => ({id, bx, by})), open};
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
  return complete(encodeStrategyImageSteps(image, orders, effort));
}
export function encodeStrategyImageSteps(image, orders = true, effort = 7, pooled = false) {
  return strategyAnsSteps(image, effort, orders ? learnedOrders(image) : null, pooled);
}

export function encodeXYBStrategies(rgba, width, height, quality, photoOptions, strategyOptions = {}) {
  const base = complete(photoXYBSteps(rgba, width, height, quality, {...photoOptions, keepPlanes: true}));
  const {image, counts, layout} = xybStrategies(base, width, height, {deadzone: photoOptions.deadzone, ...strategyOptions});
  return {bytes: encodeStrategyImage(image), counts, layout};
}


export function cellSums(map, width, height, p = 3) {
  const stride = Math.ceil(width / 8), out = new Float64Array(stride * Math.ceil(height / 8));
  if (p === 3) {
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const v = map[y * width + x]; out[(y >> 3) * stride + (x >> 3)] += v * (v * v);
    }
  } else for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) out[(y >> 3) * stride + (x >> 3)] += exactPow(map[y * width + x], p);
  return out;
}

const VB_LARGE = new Set([18, 19, 20]);
export const RATE_DOUBT = 3e-6, MAP_TOTAL_DOUBT = 2e-6, RATE_TOTAL_DOUBT = 1e-7;
export function sameDct8Image(plain, strategy) {
  if (!plain || plain.strategyData || !strategy.strategyData || plain.width !== strategy.width || plain.height !== strategy.height) return false;
  const same = (a, b) => Object.is(a, b) || !!a && !!b && a.length === b.length && typeof a.every === 'function'
    && a.every((v, i) => Array.isArray(v) || ArrayBuffer.isView(v) ? same(v, b[i]) : Object.is(v, b[i]));
  for (const key of ['quantScale', 'epf', 'quantFieldBase', 'epfIterations']) if (!Object.is(plain[key], strategy[key])) return false;
  for (const key of ['gab', 'quantFields', 'sharpness']) if (!same(plain[key], strategy[key])) return false;
  if (plain.cfl.width !== strategy.cfl.width || !same(plain.cfl.x, strategy.cfl.x) || !same(plain.cfl.b, strategy.cfl.b)) return false;
  const table = strategy.strategyData.tables.get(0)?.planes;
  if (!table || strategy.strategyData.blocks.length !== plain.components[0].stride * plain.components[0].rows) return false;
  for (let c = 0; c < 3; c++) {
    const a = plain.components[c], b = strategy.components[c];
    if (a.stride !== b.stride || a.rows !== b.rows || !same(a.quant, b.quant)) return false;
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) if (table[c][x * 8 + y] !== a.quant[y * 8 + x]) return false;
  }
  for (const block of strategy.strategyData.blocks) {
    if (block.id !== 0) return false;
    for (let c = 0; c < 3; c++) {
      const source = plain.components[c].coeffs, at = block.by * plain.components[c].stride + block.bx;
      if (source[at * 64] !== strategy.components[c].dc[at]) return false;
      for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) if ((x || y) && source[at * 64 + y * 8 + x] !== block.coeffs[c][x * 8 + y]) return false;
    }
  }
  return true;
}

export function* closedLoopStrategySteps(base, width, height, options = {}) {
  const {p = 3, ids = [5, 10, 11, 4, 6, 7]} = options, maps = [], rates = new Map(), stride = base.components[0].stride, rows = base.components[0].rows;
  const costs = (yield {varblocks: {kind: 'costs', base, width, height, options: {...options, ids: ids.filter(id => !VB_LARGE.has(id))}}}) || null;
  let mapDoubt = 0;
  for (const id of [0, ...ids]) {
    let forced = {...options, force: id, maps: null, rates, ...(costs ? {costs} : {})};
    if (costs?.has(id)) {
      const certified = yield {varblocks: {kind: 'exact', layout: xybStrategies(base, width, height, {...forced, chooseOnly: true}).layout}};
      if (certified) forced = {...forced, exact: certified};
    }
    const image = xybStrategies(base, width, height, forced).image;
    const initial = id === 0 && p === 3 && options.initial?.scores.cells && !options.initial.scores.doubt?.cells
      && sameDct8Image(options.initial.image, image) ? options.initial.scores : null;
    const reply = initial || (yield {measure: image, want: {p}});
    maps[id] = initial ? Float64Array.from(reply.cells) : reply.cells; mapDoubt = Math.max(mapDoubt, reply.doubt?.cells ?? 0);
  }
  if (!costs && !mapDoubt) return xybStrategies(base, width, height, {...options, maps, rates});
  const choose = extra => xybStrategies(base, width, height, {...options, maps, rates, chooseOnly: true, ...(costs ? {costs, rateDoubt: RATE_DOUBT, rateTotalDoubt: RATE_TOTAL_DOUBT} : {}),
    mapDoubt, totalDoubt: mapDoubt && MAP_TOTAL_DOUBT, ...extra});
  let choice = choose({});
  if (choice.open.length) {
    const regions = choice.open.map(({bx, by, size}) => ({x0: bx * 8, y0: by * 8, x1: Math.min(width, (bx + size) * 8), y1: Math.min(height, (by + size) * 8)}));
    const exactCells = new Set();
    if (mapDoubt) {
      const {p: _p, initial: _initial, transforms: _transforms, ...build} = options;
      const exact = yield {exact: {kind: 'cells', regions, ids: [0, ...ids], p, base, options: build}};
      if (exact && [...exact.values()].every(e => e.whole)) {
        for (const [id, {cells}] of exact) maps[id] = Float64Array.from(cells);
        mapDoubt = 0;
        choice = choose({});
      } else if (exact) for (const [id, {cells}] of exact) for (const [k, v] of cells) { maps[id][k] = v; exactCells.add(k); }
    }
    if (!mapDoubt) for (const {bx, by, size} of choice.open) for (let y = by; y < Math.min(rows, by + size); y++) for (let x = bx; x < Math.min(stride, bx + size); x++) exactCells.add(y * stride + x);
    if (exactCells.size && choice.open.length) {
      choice = choose({exactCells});
      if (choice.open.length) {
        const whole = mapDoubt ? yield {exact: {kind: 'whole', image: xybStrategies(base, width, height, {...options, force: 0, maps: null}).image, p}} : {cells: maps[0]};
        if (whole) {
          maps[0] = Float64Array.from(whole.cells);
          const cpuRates = new Map();
          xybStrategies(base, width, height, {...options, force: 0, maps: null, rates: cpuRates});
          rates.set(0, cpuRates.get(0));
          for (let k = 0; k < stride * rows; k++) exactCells.add(k);
          choice = choose({exactCells, exactTotal: true});
        }
      }
    }
  }
  const {layout} = choice;
  if (!costs) return xybStrategies(base, width, height, {...options, layout});
  const certified = yield {varblocks: {kind: 'exact', layout}};
  yield {varblocks: {kind: 'release'}};
  return xybStrategies(base, width, height, {...options, layout, ...(certified ? {exact: certified} : {})});
}
