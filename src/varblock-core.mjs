// SPDX-License-Identifier: MIT
import {strategyTableList} from './vardct-tables.mjs';
import {exactExp, exactLog, exactLog2, exactPow} from './exact-math.mjs';
import {perceptualMaskField, maskDoubtOver} from './photo-mask.mjs';
import {scaledDCT, scaledDCTAt, smallTransform, naturalOrder, lowFrequencies, TRANSFORMS, scaledDCTBases} from './vardct-strategies.mjs';
import {kernelHooks} from './kernel-hooks.mjs';
import {fault} from './fault.mjs';
const noSmall = () => { throw fault('JXL_INTERNAL', 'capture-complete prices no small transform.'); };
import {zeroDensityContext} from './vardct.mjs';
import {prepareQuantParams, quantParamSteps} from './quantization-params.mjs';
import {SCAN as VB_SCAN} from './dct8-contexts.mjs';
import {hybridToken, uintConfig} from './prefix.mjs';

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
      const r = row[c], predicted = strategyRatePrediction(r, bx, by);
      r[by * 32 + bx] = visit(c, (gy * 32 + by) * stride + gx * 32 + bx, predicted);
    }
  }
}

export function strategyRatePrediction(r, bx, by) {
  return bx === 0 ? (by === 0 ? 32 : r[(by - 1) * 32]) : by === 0 ? r[bx - 1] : (r[(by - 1) * 32 + bx] + r[by * 32 + bx - 1] + 1) >> 1;
}
export function addStrategyRateBlock(coeffs, at, predicted, nz, zd) {
  let count = 0;
  for (let k = 1; k < 64; k++) if (coeffs[at + k]) count++;
  nz[nzBucket(predicted) * VB_TOKENS + token(count)[0]]++;
  let prev = count > 4 ? 0 : 1, left = count;
  for (let k = 1; k < 64 && left; k++) {
    const q = coeffs[at + VB_SCAN[k]];
    zd[zeroDensityContext(left, k, prev) * VB_TOKENS + token(vbPackSigned(q))[0]]++;
    prev = q ? 1 : 0; left -= prev;
  }
  return count;
}
export function addStrategyRateTotals(table, contexts, all) {
  for (let i = 0; i < contexts; i++) for (let t = 0; t < VB_TOKENS; t++) all[t] += table[i * VB_TOKENS + t];
  return all;
}
export function finishStrategyRateTotals(all) {
  let total = 0; for (const v of all) total += v;
  return total;
}
export function fillStrategyRateBits(table, contexts, smoothing, all, total, out) {
  for (let i = 0; i < contexts; i++) {
    let n = 0; for (let t = 0; t < VB_TOKENS; t++) n += table[i * VB_TOKENS + t];
    for (let t = 0; t < VB_TOKENS; t++) out[i * VB_TOKENS + t] = -exactLog2((table[i * VB_TOKENS + t] + smoothing * all[t] / total) / (n + smoothing));
  }
  return out;
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
  vbWalk(stride, rows, (c, b, predicted) => addStrategyRateBlock(image.components[c].coeffs, b * 64, predicted, nz[c], zd[c]));
  const bits = (table, contexts) => {
    const all = new Float64Array(VB_TOKENS).fill(0.5);
    addStrategyRateTotals(table, contexts, all);
    const total = finishStrategyRateTotals(all);
    const out = new Float64Array(contexts * VB_TOKENS);
    fillStrategyRateBits(table, contexts, smoothing, all, total, out);
    return out;
  };
  return {zd: zd.map(t => bits(t, VB_ZD)), nz: nz.map(t => bits(t, VB_NZ))};
}


const VB_ONE = [1 - 0.05465007330715401, 1 - 0.07005449891748593, 1 - 0.049935103337343655];
const VB_LOG2 = new Float64Array(4096).fill(NaN);
const vbLog2 = q => { if (q >= 4096) return exactLog2(q); const v = VB_LOG2[q]; return v === v ? v : VB_LOG2[q] = exactLog2(q); };
const vbLog2Table = () => { for (let q = 1; q < 4096; q++) vbLog2(q); return VB_LOG2; };
const vbRecon = (m, c) => m === 0 ? 0 : m === 1 ? VB_ONE[c] : m - 0.145 / m;
const VB_RECON = Float64Array.from({length: 4096}, (_, m) => m > 1 ? m - 0.145 / m : 0);
const VB_QS = 256;

const VB_SMALL = new Set([3, 12, 13]);
export const VB_DOUBT = 2130706432;
function vbSettle(certified, id, bx, by, w, h, bw, bh, area, size, table, comps, planeRows, W, cfl, fine, dead) {
  const high = highOf(id, size), order = naturalOrder(bw, bh), ti = (by >> 3) * cfl.width + (bx >> 3), factor = [cfl.x[ti] / 84, 0, cfl.b[ti] / 84];
  const pixelsOf = c => {
    const {planes: rowsOf, top, left = 0, stride: rowW = W} = planeRows(by * 8, by * 8 + h, bx * 8, bx * 8 + w), p = new Float64Array(size);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) p[y * w + x] = rowsOf[c][(by * 8 + y - top) * rowW + bx * 8 - left + x];
    return p;
  };
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
function freqOf(id, pos, sizeScale, smallScale = 1) {
  if (id === 3) {
    if (pos === 1 || pos === 8 || pos === 9) return [pos & 1, pos >> 3, smallScale];
    return [2 * ((pos & 7) >> 1), 2 * ((pos >> 3) >> 1), 2 * smallScale];
  }
  if (id === 12 || id === 13) {
    if (pos === 8) return [0, 1, smallScale];
    return [pos & 7, 2 * ((pos >> 3) >> 1), 8 / Math.sqrt(32) * smallScale];
  }
  const t = TRANSFORMS[id], w = t.width, h = t.height, L = Math.max(w, h), S = Math.min(w, h), wide = w > h;
  const fl = (pos % L) * 8 / L, fs = Math.floor(pos / L) * 8 / S;
  return [wide ? fl : fs, wide ? fs : fl, 8 / Math.sqrt(w * h) * (w * h > 64 ? sizeScale : 1)];
}
const VB_PIXEL = new Map();
export function pixelWeights(id) {
  let weights = VB_PIXEL.get(id);
  if (weights) return weights;
  const M = Array.from({length: 64}, (_, i) => { const r = new Float64Array(128); r[64 + i] = 1; return r; });
  for (let j = 0; j < 64; j++) { const px = new Float64Array(64); px[j] = 1; const c = smallTransform(px, id); for (let i = 0; i < 64; i++) M[i][j] = c[i]; }
  for (let i = 0; i < 64; i++) {
    let p = i;
    for (let r = i + 1; r < 64; r++) if (Math.abs(M[r][i]) > Math.abs(M[p][i])) p = r;
    [M[i], M[p]] = [M[p], M[i]];
    const pivot = M[i][i];
    for (let c = 0; c < 128; c++) M[i][c] /= pivot;
    for (let r = 0; r < 64; r++) if (r !== i && M[r][i]) { const f = M[r][i]; for (let c = 0; c < 128; c++) M[r][c] -= f * M[i][c]; }
  }
  weights = Float64Array.from({length: 64}, (_, j) => {
    let s = 0;
    for (let i = 0; i < 64; i++) s += M[i][64 + j] * M[i][64 + j];
    return Math.round(Math.sqrt(s / 64) * 4096) / 4096;
  });
  VB_PIXEL.set(id, weights);
  return weights;
}
const VB_HIGH = new Map();
export function fillStrategyHigh(id, out, from = 0, to = out.length, origin = 0) {
  for (let pos = from; pos < to; pos++) { const [fx, fy] = freqOf(id, pos, 1); out[pos - origin] = fx >= 4 || fy >= 4 ? 1 : 0; }
  return out;
}
function highOf(id, size) {
  let h = VB_HIGH.get(id);
  if (!h) { h = fillStrategyHigh(id, new Uint8Array(size)); VB_HIGH.set(id, h); }
  return h;
}
function stepAt(quant, id, pos, sizeScale, env) {
  const [fx, fy, scale] = freqOf(id, pos, sizeScale, env.smallScale);
  const x0 = Math.min(7, Math.floor(fx)), y0 = Math.min(7, Math.floor(fy)), x1 = Math.min(7, x0 + 1), y1 = Math.min(7, y0 + 1);
  const ax = fx - x0, ay = fy - y0, q = (y, x) => quant[y * 8 + x];
  const v = (q(y0, x0) * (1 - ax) + q(y0, x1) * ax) * (1 - ay) + (q(y1, x0) * (1 - ax) + q(y1, x1) * ax) * ay;
  return id === 0 ? Math.max(1, Math.round(v * scale)) : v * scale;
}

export const strategyTableEnvironment = (base, options) => ({field: base.quantFields ? base.quantFieldBase : 32,
  smallScale: options.smallScale ?? 1, activeBands: options.tableBands ?? (options.perceptual ? 8 : VB_BANDS)});
const searchTables = (base, options) => Object.assign(new Map(), {env: strategyTableEnvironment(base, options)});
const VB_BANDS = 12;

export function addStrategyBandFit(target, L, S, env, A, y, from = 1, to = L * S, origin = 0) {
  const B = env.activeBands, scale = (B - 1) / (1.4142135623730951 + .000001);
  for (let k = from; k < to; k++) {
    const x = (k % L) / (L - 1), yy = Math.floor(k / L) / (S - 1), p = Math.sqrt(x * x + yy * yy) * scale;
    const i = Math.min(B - 2, Math.floor(p)), t = p - i, lw = exactLog(8 * 255 * VB_QS / (env.field * target[k - origin]));
    const a = [[i, 1 - t], [i + 1, t]];
    for (const [r, wr] of a) { y[r] += wr * lw; for (const [c2, wc] of a) A[r * B + c2] += wr * wc; }
  }
}
export function finishStrategyBandFit(A, y, B) {
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

function fitBands(target, L, S, env) {
  const B = env.activeBands, A = new Float64Array(B * B), y = new Float64Array(B);
  addStrategyBandFit(target, L, S, env, A, y);
  return finishStrategyBandFit(A, y, B);
}
export function fillStrategyTableTargets(quant, id, sizeScale, env, out, from = 0, to = out.length, origin = 0) {
  for (let k = from; k < to; k++) out[k - origin] = stepAt(quant, id, k, sizeScale, env);
  return out;
}
export function strategyBandTarget(id, target) {
  if (id === 3) return Float64Array.from({length: 16}, (_, k) => target[2 * (k >> 2) * 8 + 2 * (k & 3)]);
  if (id === 12 || id === 13) return Float64Array.from({length: 32}, (_, k) => target[2 * (k >> 3) * 8 + (k & 7)]);
  return target;
}
export function strategyTableParameters(id, targets, bands, env) {
  const weight = step => 8 * 255 * VB_QS / (env.field * step);
  if (id === 3) return {mode: 'dct4', bands, multipliers: targets.map((p, c) => [bands[c][0] / weight(p[1]), bands[c][0] / weight(p[9])])};
  if (id === 12 || id === 13) return {mode: 'dct4x8', bands, multipliers: targets.map((p, c) => bands[c][0] / weight(p[8]))};
  return {mode: 'dct', bands};
}

function tableFor(id, components, sizeScale, cache) {
  const env = cache.env;
  if (cache.has(TRANSFORMS[id].table)) return cache.get(TRANSFORMS[id].table);
  const t = TRANSFORMS[id], w = t.width, h = t.height, L = Math.max(w, h), S = Math.min(w, h);
  const targets = components.map(comp => fillStrategyTableTargets(comp.quant, id, sizeScale, env, new Float64Array(L * S)));
  let table, input;
  if (id === 0) table = {w: L, h: S, planes: targets.map(p => Int32Array.from(p))};
  else {
    const lowW = id === 3 ? 4 : id === 12 || id === 13 ? 8 : L, lowH = id === 3 || id === 12 || id === 13 ? 4 : S;
    const bands = targets.map(p => fitBands(strategyBandTarget(id, p), lowW, lowH, env));
    input = strategyTableParameters(id, targets, bands, env);
  }
  if (input) {
    const parameters = prepareQuantParams(input, L, S, t.table);
    table = {w: L, h: S, parameters, planes: quantParamSteps(parameters, VB_QS, env.field, [0, 1, 2])};
  }
  cache.set(t.table, table);
  return table;
}

export function channelNorm(comps, weights, lowScale) {
  const step = c => comps[c].quant[1] / (lowScale?.[c * 64 + 1] ?? 1) / VB_QS, yStep = step(1);
  return [0, 1, 2].map(c => weights[c] * (yStep / step(c)) * (yStep / step(c)) / (yStep * yStep));
}
export function strategyInputs(base, width, height, options = {}) {
  const {sizeScale = 1, ids = [5, 10, 11, 4, 6, 7], deadzone, weights = [1, 1, 1]} = options;
  const comps = base.components, stride = comps[0].stride, rows = comps[0].rows;
  const norm = channelNorm(comps, weights, options.lowScale);
  const tables = searchTables(base, options), transforms = new Map();
  for (const id of [0, ...ids]) {
    if (VB_SMALL.has(id) || transforms.has(id)) continue;
    const t = TRANSFORMS[id], bw = t.width / 8, bh = t.height / 8, table = tableFor(id, comps, sizeScale, tables);
    transforms.set(id, {w: t.width, h: t.height, bw, bh, order: naturalOrder(bw, bh), high: highOf(id, t.width * t.height), steps: [0, 1, 2].map(c => table.planes[c])});
  }
  const fine = new Float32Array(stride * rows).fill(1);
  if (base.quantFields) for (let i = 0; i < fine.length; i++) fine[i] = base.quantFields[i] / base.quantFieldBase;
  return {stride, rows, planes: base.planes, transforms, tokens: !(typeof __RAPIER_JXL_CAPTURE_PHOTO__ !== 'undefined' && __RAPIER_JXL_CAPTURE_PHOTO__ === true) && options.model !== 'simple' ? rateModel(base, stride, rows, 8) : null,
    norm, dead: deadzone || null, fine, cfl: base.cfl, one: VB_ONE, dcSteps: comps.map(comp => comp.quant[0] / VB_QS), recon: VB_RECON, log2: vbLog2Table()};
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

function tokenBitsOf(tokens, c, plane, order, area, size) {
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
}
export function tokenRate(block, tokens, rc = [4, 3, 2, 0.6]) {
  const {area, size, order, coeffs} = block;
  let R = 0;
  for (const c of [1, 0, 2]) {
    const plane = coeffs[c], R0 = R;
    for (let k = area; k < size; k++) { const q = plane[order[k]]; if (q) R += rc[1] + rc[2] * vbLog2(q < 0 ? -q : q); }
    R += tokenBitsOf(tokens, c, plane, order, area, size) - (R - R0);
  }
  return R;
}
export function slabAllocator() {
  let slab = null, slabAt = 0, slabSize = 16384;
  return n => {
    if (n > 262144) return new Int32Array(n);
    if (!slab || slabAt + n > slab.length) { slab = new Int32Array(Math.max(slabSize, n)); slabAt = 0; slabSize = Math.min(1 << 20, slabSize * 2); }
    slabAt += n;
    return slab.subarray(slabAt - n, slabAt);
  };
}
export function createStrategyBuilder(base, width, height, options = {}) {
  let maps = options.maps, repricing = false, settled = 0, measuredCost = null;
  const {lambda = 1, sizeScale = 1, ids = [5, 10, 11, 4, 6, 7], rate: rc = [4, 3, 2, 0.6], deadzone, weights = [1, 1, 1],
    detailWeight: detailW = 1.25, inhom = 0.08} = options;
  const comps = base.components, stride = comps[0].stride, rows = comps[0].rows, W = stride * 8, planes = base.planes;
  const transforms = !(typeof __RAPIER_JXL_CAPTURE_PHOTO__ !== 'undefined' && __RAPIER_JXL_CAPTURE_PHOTO__ === true) && options.transforms instanceof TransformCache ? options.transforms.forSource(planes, width, height, stride, rows) : null;
  const fineOf = (bx, by) => base.quantFields ? base.quantFields[by * stride + bx] / base.quantFieldBase : 1;
  const tables = searchTables(base, options), cfl = base.cfl, dead = deadzone;
  const rateBlock = !(typeof __RAPIER_JXL_CAPTURE_PHOTO__ !== 'undefined' && __RAPIER_JXL_CAPTURE_PHOTO__ === true) && options.rateBlock || null, rateFrom = options.rateFrom ?? 0;
  const plainTables = rateBlock ? searchTables(base, {...options, perceptual: false}) : null;
  if (plainTables) tableFor(0, comps, sizeScale, plainTables);
  const norm = channelNorm(comps, weights, options.lowScale);
  tableFor(0, comps, sizeScale, tables);
  const allowed = new Set(ids);
  const tokens = !(typeof __RAPIER_JXL_CAPTURE_PHOTO__ !== 'undefined' && __RAPIER_JXL_CAPTURE_PHOTO__ === true) && !options.layout && options.model !== 'simple' && rateModel(base, stride, rows, 8);
  const tokenBits = (c, plane, order, area, size) => tokenBitsOf(tokens, c, plane, order, area, size);
  const candidateRate = (bx, by) => { const m = maps; maps = null; const r = full(0, bx, by).R; maps = m; return r; };
  const rates = options.rates;
  const costs = options.costs;
  const certifiedCosts = !!costs?.certified;
  if (options.perceptual && (options.maps || options.rates || costs && !(certifiedCosts && options.maskWeight)))
    throw new Error('The block search takes no maps or rates, and only certified costs with their mask.');
  const costDoubt = options.costDoubt || 0, doubtOf = (bx, by, bw, bh) => maskDoubtOver(costDoubt, stride, bx, by, bw, bh);
  if (costs && rates) for (const [id, c] of costs) if (!rates.has(id)) rates.set(id, c.R);
  const candidate = (id, bx, by, loses = null) => {
    const t = TRANSFORMS[id], bw = t.width / 8, bh = t.height / 8;
    if (costs?.has(id) && !maps && !repricing) {
      const c = costs.get(id), at = by * stride + bx, R = c.R[at];
      if (c.De && c.De[at] === Infinity) { settled++; return full(id, bx, by); }
      return {id, bx, by, bw, bh, area: bw * bh, light: true, R, Re: c.Re ? c.Re[at] : 0, J: c.D[at] + lambda * R, Je: c.De ? c.De[at] + lambda * c.Re[at] : 0};
    }
    if (repricing) return full(id, bx, by);
    if (!maps || !rates?.has(id)) return full(id, bx, by, loses);
    return {id, bx, by, bw, bh, light: true, ...measuredCost(id, bx, by, bw, bh, rates.get(id)[by * stride + bx])};
  };
  const gpuBlocks = options.blocks;
  const priced = !options.layout;
  const blockPixels = new Map(), blockOutputs = new Map();
  const planeRows = base.planeRows || (() => ({planes, top: 0}));
  const useMask = !!options.perceptual && priced && !options.maps && (!costs || certifiedCosts) && options.force === undefined && !!(planes || options.maskWeight);
  const wholeMask = useMask ? options.maskWeight ?? perceptualMaskField(planes, stride, rows).weight : null;
  const cellMW = (bx, by) => wholeMask[by * stride + bx];
  let priceOnly = !!options.priceOnly && priced;
  const built = priced ? null : options.built, scratch = new Map(), keepChosen = priceOnly && !!options.keepChosen && !options.chooseOnly;
  const kept = stride * rows >= 16384 ? slabAllocator() : n => new Int32Array(n);
  const keepsAll = !!options.layout;
  const lowScratch = new Map();
  const make = c => {
    let b;
    if (c.slot >= 0 && c.epoch === vk.epoch()) {
      const {id, bx, by, bw, bh, area, size} = c, order = naturalOrder(bw, bh), levels = kept(3 * (size + area)), coeffs = [], dc = [];
      vk.copyLevels(c.slot, size, levels);
      const L = Math.max(bw, bh), S = Math.min(bw, bh), tr = area > 1 ? lowScratch.get(size) || lowScratch.set(size, new Float64Array(size)).get(size) : null;
      for (let ch = 0; ch < 3; ch++) {
        coeffs[ch] = levels.subarray(ch * size, (ch + 1) * size);
        const out = dc[ch] = levels.subarray(3 * size + ch * area, 3 * size + (ch + 1) * area), dcStep = comps[ch].quant[0] / VB_QS;
        if (area === 1) { out[0] = Math.round(c.lows[ch] * 8 / dcStep); continue; }
        for (let y = 0; y < S; y++) for (let x = 0; x < L; x++) tr[y * L * 8 + x] = c.lows[ch * area + y * L + x];
        const low = lowFrequencies(tr, bw, bh);
        for (let k = 0; k < area; k++) out[k] = Math.round(low[k] * 8 / dcStep);
      }
      b = {id, bx, by, bw, bh, area, size, order, coeffs, dc, levels: levels.subarray(0, 3 * size), R: c.R, J: c.J, narrow: true};
    } else { priceOnly = false; b = full(c.id, c.bx, c.by); priceOnly = true; }
    if (c.fallback) b.fallback = c.fallback;
    return b;
  };
  const bounded = priced && !priceOnly && !tokens && !options.maps && !rates && !costs && !transforms && !gpuBlocks && !options.exact;
  const vk = !tokens && !options.maps && !rates && (!costs || certifiedCosts) && !transforms && !gpuBlocks && !options.exact
    ? kernelHooks.varblock?.(vbLog2Table(), scaledDCTBases) : null, sums = new Float64Array(3);
  const kernelBlock = (id, bx, by, w, h, bw, bh, area, size, table, order, loses) => {
    const {planes: rowsOf, top, left = 0, stride: rowW = W} = planeRows(by * 8, by * 8 + h, bx * 8, bx * 8 + w), slot = vk.table(id, table, size, order, highOf(id, size));
    if (!slot) return null;
    if (loses) vk.block(rowsOf, top, bx * 8 - left, by * 8, rowW, w, h, 1, 1);
    else vk.block(rowsOf, top, bx * 8 - left, by * 8, rowW, w, h, 0, 2);
    const ti = (by >> 3) * cfl.width + (bx >> 3), fine = fineOf(bx, by), unit = 8 * VB_QS * fine;
    const levels = priceOnly ? null : keepsAll ? kept(3 * (size + area)) : new Int32Array(3 * (size + area)), coeffs = priceOnly ? null : [], dc = priceOnly ? null : [];
    let keep = priceOnly && keepChosen ? vk.reserve(size) : -1, lows = null, wide = false;
    const L = Math.max(bw, bh), S = Math.min(bw, bh);
    let blockMW = 1;
    if (useMask) {
      let sumMW = 0, maxMW = 0;
      for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) {
        const wCell = cellMW(bx + x, by + y);
        sumMW += wCell;
        if (wCell > maxMW) maxMW = wCell;
      }
      blockMW = area === 1 ? sumMW : 0.70 * (sumMW / area) + 0.30 * maxMW;
    }
    let D = 0, R = 0;
    for (let i = 0; i < 3; i++) {
      const c = i === 0 ? 1 : i === 1 ? 0 : 2, plane = levels && levels.subarray(c * size, (c + 1) * size);
      const fc = c === 0 ? cfl.x[ti] / 84 : c === 2 ? cfl.b[ti] / 84 : 0, lo = dead ? dead[c * 2] : 0.5, hi = dead ? dead[c * 2 + 1] : 0.5;
      if (levels) {
        const tr = vk.coefficients(c, size), dcStep = comps[c].quant[0] / VB_QS, out = dc[c] = levels.subarray(3 * size + c * area, 3 * size + (c + 1) * area);
        if (area === 1) out[0] = Math.round(tr[0] * 8 / dcStep);
        else { const low = lowFrequencies(tr, bw, bh); for (let k = 0; k < low.length; k++) out[k] = Math.round(low[k] * 8 / dcStep); }
      }
      let d = 0, zeros = 0;
      if (vk.quant(c, slot, area, size, fc, lo, hi, fine, unit, VB_ONE[c], useMask ? detailW : 1, rc[1], rc[2], R, plane, sums, keep)) { d = sums[0]; R = sums[1]; zeros = sums[2]; }
      else {
        if (keep >= 0) vk.unreserve(keep);
        keep = -1; lows = null; wide = true;
        const tr = vk.coefficients(c, size), luma = vk.coefficients(1, size), steps = table.planes[c], high = highOf(id, size), into = plane || new Int32Array(size);
        let run = 0;
        for (let k = area; k < size; k++) {
          const pos = order[k], step = steps[pos];
          const coefficient = tr[pos] - (c !== 1 ? fc * luma[pos] : 0);
          const v = coefficient * 8 * VB_QS / step * fine, a = Math.abs(v);
          const q = a < (high[pos] ? hi : lo) ? 0 : Math.round(a);
          into[pos] = v < 0 ? -q : q;
          const e = (a - (q > 1 && q < 4096 ? VB_RECON[q] : vbRecon(q, c))) * step / unit;
          d += e * e * (q === 0 && useMask ? detailW : 1);
          if (q) { R += rc[1] + rc[2] * vbLog2(q); zeros += run; run = 0; } else run++;
        }
      }
      D += norm[c] * d * w * h * blockMW;
      R += rc[0] + rc[3] * zeros;
      if (coeffs) coeffs[c] = plane;
      if (c === 1 && loses) {
        if (loses(D + lambda * R)) { if (keep >= 0) vk.unreserve(keep); return {id, bx, by, bw, bh, light: true, J: Infinity}; }
        vk.block(rowsOf, top, bx * 8 - left, by * 8, rowW, w, h, 0, 0); vk.block(rowsOf, top, bx * 8 - left, by * 8, rowW, w, h, 2, 2);
      }
      if (keep >= 0) {
        lows ||= new Float64Array(3 * area);
        const tr = vk.coefficients(c, size);
        if (area === 1) lows[c] = tr[0];
        else for (let y = 0; y < S; y++) for (let x = 0; x < L; x++) lows[c * area + y * L + x] = tr[y * L * 8 + x];
      }
    }
    if (!priced && rateBlock && by >= rateFrom) {
      if (id === 0) rateBlock({id, bx, by, area, size, order, coeffs});
      else {
        const pTable = tableFor(id, comps, sizeScale, plainTables), pSlot = vk.table(id + 32, pTable, size, order, highOf(id, size));
        const pLevels = scratch.get(size) || scratch.set(size, new Int32Array(3 * size)).get(size), pCoeffs = [];
        for (let i = 0; i < 3; i++) {
          const c = i === 0 ? 1 : i === 1 ? 0 : 2, pPlane = pLevels.subarray(c * size, (c + 1) * size);
          const fc = c === 0 ? cfl.x[ti] / 84 : c === 2 ? cfl.b[ti] / 84 : 0, lo = dead ? dead[c * 2] : 0.5, hi = dead ? dead[c * 2 + 1] : 0.5;
          if (!pSlot || !vk.quant(c, pSlot, area, size, fc, lo, hi, fine, unit, VB_ONE[c], 1, rc[1], rc[2], 0, pPlane, sums, -1)) {
            pPlane.fill(0);
            const tr = vk.coefficients(c, size), luma = vk.coefficients(1, size), pSteps = pTable.planes[c], high = highOf(id, size);
            for (let k = area; k < size; k++) {
              const pos = order[k], coefficient = tr[pos] - (c !== 1 ? fc * luma[pos] : 0);
              const v = coefficient * 8 * VB_QS / pSteps[pos] * fine, a = Math.abs(v), q = a < (high[pos] ? hi : lo) ? 0 : Math.round(a);
              pPlane[pos] = v < 0 ? -q : q;
            }
          }
          pCoeffs[c] = pPlane;
        }
        rateBlock({id, bx, by, area, size, order, coeffs: pCoeffs});
      }
    }
    if (priceOnly) return keep >= 0 ? {id, bx, by, bw, bh, area, size, light: true, R, D, J: D + lambda * R, Je: doubtOf(bx, by, bw, bh) * D, slot: keep, lows, epoch: vk.epoch()}
      : {id, bx, by, bw, bh, area, light: true, R, D, J: D + lambda * R, Je: doubtOf(bx, by, bw, bh) * D};
    if (!priced) return {id, bx, by, bw, bh, area, size, order, coeffs, dc, levels: levels.subarray(0, 3 * size), R: 0, J: 0, narrow: !wide};
    return {id, bx, by, bw, bh, area, size, order, coeffs, dc, levels: levels.subarray(0, 3 * size), R, D, J: D + lambda * R, Je: doubtOf(bx, by, bw, bh) * D, narrow: !wide};
  };
  const full = (id, bx, by, loses = null) => {
    const t = TRANSFORMS[id], w = t.width, h = t.height, bw = w / 8, bh = h / 8, area = bw * bh, size = w * h;
    const known = built?.get(id * 16777216 + by * stride + bx);
    if (known) { tableFor(id, comps, sizeScale, tables); return known; }
    const certified = options.exact?.get(id * 16777216 + by * stride + bx) ?? options.exact?.get(id + ':' + bx + ':' + by);
    if (certified) {
      const table = tableFor(id, comps, sizeScale, tables);
      if (certified.uncertain) vbSettle(certified, id, bx, by, w, h, bw, bh, area, size, table, comps, planeRows, W, cfl, fineOf(bx, by), dead);
      return {id, bx, by, bw, bh, area, size, order: naturalOrder(bw, bh), coeffs: certified.coeffs, dc: certified.dc, R: 0, J: 0, narrow: !!certified.narrow && !certified.uncertain};
    }
    if (gpuBlocks?.has(id) && !maps) {
      tableFor(id, comps, sizeScale, tables);
      const {coeffs, dc} = gpuBlocks.get(id)(bx, by), R = costs.get(id).R[by * stride + bx];
      return {id, bx, by, bw, bh, area, size, order: naturalOrder(bw, bh), coeffs, dc, R, J: costs.get(id).D[by * stride + bx] + lambda * R};
    }
    const table = tableFor(id, comps, sizeScale, tables), order = naturalOrder(bw, bh);
    if (vk && !VB_SMALL.has(id)) {
      const block = kernelBlock(id, bx, by, w, h, bw, bh, area, size, table, order, loses);
      if (block) { if (!priced) built?.set(id * 16777216 + by * stride + bx, block); return block; }
    }
    const cache = transforms, key = id * 16777216 + by * stride + bx;
    let transformed = cache?.get(key), transformChannel = null;
    if (!transformed) {
      const pixels = blockPixels.get(size) || blockPixels.set(size, new Float64Array(size)).get(size);
      const outputs = blockOutputs.get(size) || blockOutputs.set(size, [0, 1, 2].map(() => new Float64Array(size))).get(size);
      transformed = [];
      const {planes: rowsOf, top, left = 0, stride: rowW = W} = planeRows(by * 8, by * 8 + h, bx * 8, bx * 8 + w);
      transformChannel = c => {
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) pixels[y * w + x] = rowsOf[c][(by * 8 + y - top) * rowW + bx * 8 - left + x];
        transformed[c] = VB_SMALL.has(id) ? (typeof __RAPIER_JXL_CAPTURE_PHOTO__ !== 'undefined' && __RAPIER_JXL_CAPTURE_PHOTO__ === true) ? noSmall() : smallTransform(pixels, id, cache ? undefined : outputs[c]) : scaledDCT(pixels, w, h, cache ? undefined : outputs[c]);
      };
      const early = bounded && !!loses;
      for (let c = 0; c < 3; c++) if (!early || c === 1) transformChannel(c);
      cache?.set(key, transformed);
    }
    const ti = (by >> 3) * cfl.width + (bx >> 3), factor = [cfl.x[ti] / 84, 0, cfl.b[ti] / 84];
    const high = highOf(id, size);
    const coeffs = [], dc = [], fine = fineOf(bx, by), levels = priceOnly ? scratch.get(size) || scratch.set(size, new Int32Array(3 * size)).get(size) : keepsAll ? kept(3 * (size + area)) : new Int32Array(3 * (size + area));
    if (priceOnly) levels.fill(0);
    let blockMW = 1;
    if (useMask) {
      let sumMW = 0, maxMW = 0;
      for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) {
        const wCell = cellMW(bx + x, by + y);
        sumMW += wCell;
        if (wCell > maxMW) maxMW = wCell;
      }
      blockMW = area === 1 ? sumMW : 0.70 * (sumMW / area) + 0.30 * maxMW;
    }
    let D = 0, R = 0;
    for (const c of [1, 0, 2]) {
      const tr = transformed[c], plane = levels.subarray(c * size, (c + 1) * size), steps = table.planes[c];
      if (!priceOnly) {
        const low = lowFrequencies(tr, bw, bh), dcStep = comps[c].quant[0] / VB_QS, out = dc[c] = levels.subarray(3 * size + c * area, 3 * size + (c + 1) * area);
        for (let i = 0; i < low.length; i++) out[i] = Math.round(low[i] * 8 / dcStep);
      }
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
      const fc = factor[c], luma = transformed[1], lo = dead ? dead[c * 2] : 0.5, hi = dead ? dead[c * 2 + 1] : 0.5, unit = 8 * VB_QS * fine;
      const pixel = VB_SMALL.has(id) ? (typeof __RAPIER_JXL_CAPTURE_PHOTO__ !== 'undefined' && __RAPIER_JXL_CAPTURE_PHOTO__ === true) ? noSmall() : pixelWeights(id) : null;
      for (let k = area; k < size; k++) {
        const pos = order[k], step = steps[pos];
        const coefficient = tr[pos] - (c !== 1 ? fc * luma[pos] : 0);
        const v = coefficient * 8 * VB_QS / step * fine, a = Math.abs(v);
        const q = a < (high[pos] ? hi : lo) ? 0 : Math.round(a);
        plane[pos] = v < 0 ? -q : q;
        const e = (a - (q > 1 && q < 4096 ? VB_RECON[q] : vbRecon(q, c))) * step / unit;
        d += e * e * (q === 0 && useMask ? detailW : 1) * (pixel ? pixel[pos] : 1);
        if (q) { nz++; R += rc[1] + rc[2] * vbLog2(q); zeros += run; run = 0; } else run++;
      }
      D += norm[c] * d * w * h * blockMW;
      if (!priced) {} else if (tokens) R += tokenBits(c, plane, order, area, size) - (R - R0);
      else R += rc[0] + rc[3] * zeros;
      coeffs[c] = plane;
      if (c === 1 && !transformed[0]) {
        if (loses(D + lambda * R)) return {id, bx, by, bw, bh, light: true, J: Infinity};
        transformChannel(0); transformChannel(2);
      }
    }
    if (maps) return {id, bx, by, bw, bh, area, size, order, coeffs, dc, ...measuredCost(id, bx, by, bw, bh, R)};
    if (rates) { if (!rates.has(id)) rates.set(id, new Float64Array(stride * rows)); rates.get(id)[by * stride + bx] = R; }
    if (priceOnly) return {id, bx, by, bw, bh, area, light: true, R, D, J: D + lambda * R, Je: doubtOf(bx, by, bw, bh) * D};
    if (!priced && rateBlock && by >= rateFrom) {
      if (id === 0) rateBlock({id, bx, by, area, size, order, coeffs});
      else {
        const pTable = tableFor(id, comps, sizeScale, plainTables), pLevels = scratch.get(size) || scratch.set(size, new Int32Array(3 * size)).get(size), pCoeffs = [];
        pLevels.fill(0);
        for (const c of [1, 0, 2]) {
          const tr = transformed[c], luma = transformed[1], pPlane = pLevels.subarray(c * size, (c + 1) * size), pSteps = pTable.planes[c], fc = factor[c];
          for (let k = area; k < size; k++) {
            const pos = order[k], coefficient = tr[pos] - (c !== 1 ? fc * luma[pos] : 0);
            const v = coefficient * 8 * VB_QS / pSteps[pos] * fine, a = Math.abs(v), q = a < (dead ? dead[c * 2 + high[pos]] : 0.5) ? 0 : Math.round(a);
            pPlane[pos] = v < 0 ? -q : q;
          }
          pCoeffs[c] = pPlane;
        }
        rateBlock({id, bx, by, area, size, order, coeffs: pCoeffs});
      }
    }
    const block = {id, bx, by, bw, bh, area, size, order, coeffs, dc, R, D, J: D + lambda * R, Je: doubtOf(bx, by, bw, bh) * D};
    built?.set(id * 16777216 + by * stride + bx, block);
    return block;
  };
  const runParams = [];
  const run8 = (by, bx0, n) => {
    if (!vk?.row8 || priced || rateBlock && by + 1 > rateFrom) return null;
    const table = tableFor(0, comps, sizeScale, tables), order = naturalOrder(1, 1);
    const {planes: rowsOf, top, left = 0, stride: rowW = W} = planeRows(by * 8, by * 8 + 8, bx0 * 8, (bx0 + n) * 8);
    const slot = vk.table(0, table, 64, order, highOf(0, 64));
    if (!slot) return null;
    const params = runParams[0]?.length >= n * 4 ? runParams[0] : (runParams[0] = new Float64Array(n * 4));
    for (let j = 0; j < n; j++) {
      const bx = bx0 + j, ti = (by >> 3) * cfl.width + (bx >> 3), fine = fineOf(bx, by);
      params[j * 4] = cfl.x[ti] / 84; params[j * 4 + 1] = cfl.b[ti] / 84; params[j * 4 + 2] = fine; params[j * 4 + 3] = 8 * VB_QS * fine;
    }
    const zones = [0, 1, 2].flatMap(c => [dead ? dead[c * 2] : 0.5, dead ? dead[c * 2 + 1] : 0.5]);
    const made = vk.row8(rowsOf, top, bx0 * 8 - left, by * 8, rowW, n, slot, params, zones, VB_ONE, rc[1], rc[2]);
    if (!made) return null;
    const out = [], steps = [0, 1, 2].map(c => comps[c].quant[0] / VB_QS);
    for (let j = 0; j < made.done; j++) {
      const levels = keepsAll ? kept(195) : new Int32Array(195);
      levels.set(made.levels.subarray(j * 192, j * 192 + 192));
      for (let c = 0; c < 3; c++) levels[192 + c] = Math.round(made.dc[j * 3 + c] * 8 / steps[c]);
      const block = {id: 0, bx: bx0 + j, by, bw: 1, bh: 1, area: 1, size: 64, order,
        coeffs: [levels.subarray(0, 64), levels.subarray(64, 128), levels.subarray(128, 192)],
        dc: [levels.subarray(192, 193), levels.subarray(193, 194), levels.subarray(194, 195)], levels: levels.subarray(0, 192), R: 0, J: 0, narrow: true};
      built?.set(by * stride + bx0 + j, block);
      out.push(block);
    }
    return out;
  };
  return {lambda, sizeScale, ids, inhom, comps, stride, rows, tables, allowed, rates, costs, certifiedCosts, costDoubt,
    useMask, keepChosen, bounded, vk, candidateRate, candidate, full, make, run8,
    get settled() { return settled; },
    set repricing(value) { repricing = value; },
    setMeasuredCost(value) { measuredCost = value; },
    cpuRate(id, bx, by) { const saved = maps; maps = null; const result = full(id, bx, by).R; maps = saved; return result; },
    finish(chosen) {
      priceOnly = false;
      for (let i = 0; i < chosen.length; i++) if (chosen[i].light) chosen[i] = full(chosen[i].id, chosen[i].bx, chosen[i].by);
      return strategyImage(base, chosen, tables, !!options.perceptual);
    },
  };
}

export function fixedStrategyImage(base, width, height, options) {
  if (!options.layout) throw new TypeError('A fixed photographic image needs its layout.');
  const builder = createStrategyBuilder(base, width, height, options), layout = options.layout, chosen = [];
  for (let i = 0; i < layout.length;) {
    const {id, bx, by} = layout[i];
    let n = 1;
    const known = (x, y) => options.built?.has(y * builder.stride + x);
    if (id === 0 && !known(bx, by)) while (i + n < layout.length && layout[i + n].id === 0 && layout[i + n].by === by && layout[i + n].bx === bx + n && !known(bx + n, by)) n++;
    const run = n > 1 ? builder.run8(by, bx, n) : null;
    if (run) { for (const block of run) chosen.push(block); i += run.length; if (run.length === n) continue; n = 1; }
    for (const end = i + n; i < end; i++) chosen.push(builder.candidate(layout[i].id, layout[i].bx, layout[i].by));
  }
  return {...builder.finish(chosen), open: [], reprices: [], reverted: 0, settled: builder.settled};
}

export function strategyImage(base, chosen, tables, perceptual) {
  const comps = base.components, stride = comps[0].stride, rows = comps[0].rows;
  const at = new Int32Array(stride * rows).fill(-1), byFirst = new Array(stride * rows);
  const components = comps.map(comp => ({h: 1, v: 1, stride, rows, quant: comp.quant, coeffs: new Int16Array(0), dc: new Int32Array(stride * rows)}));
  let wideCoefficients = false;
  for (const choice of chosen) {
    const {id, bx, by, bw, bh, area, size, order, coeffs, dc, levels} = choice, block = {id, bx, by, bw, bh, area, size, order,
      coeffs: [coeffs[0], coeffs[1], coeffs[2]], dc: [dc[0], dc[1], dc[2]], levels};
    byFirst[block.by * stride + block.bx] = block;
    for (let y = 0; y < block.bh; y++) for (let x = 0; x < block.bw; x++) {
      const pos = (block.by + y) * stride + block.bx + x;
      at[pos] = -2;
      for (let c = 0; c < 3; c++) components[c].dc[pos] = dc[c][y * block.bw + x];
    }
    if (!wideCoefficients && !choice.narrow) for (const plane of block.coeffs) for (let k = 0; k < plane.length; k++) if (plane[k] < -32768 || plane[k] > 32767) { wideCoefficients = true; break; }
  }
  const groups = [], blocks = [];
  for (let gy = 0; gy < Math.ceil(rows / 32); gy++) for (let gx = 0; gx < Math.ceil(stride / 32); gx++) {
    const group = [];
    for (let by = gy * 32; by < Math.min(rows, gy * 32 + 32); by++) for (let bx = gx * 32; bx < Math.min(stride, gx * 32 + 32); bx++) {
      const block = byFirst[by * stride + bx];
      if (block) { at[by * stride + bx] = blocks.length; blocks.push(block); group.push(block); }
    }
    groups.push(group);
  }
  const used = new Set(blocks.map(b => TRANSFORMS[b.id].table));
  for (const family of tables.keys()) if (!used.has(family)) tables.delete(family);
  const counts = {};
  for (const b of blocks) counts[TRANSFORMS[b.id].name] = (counts[TRANSFORMS[b.id].name] || 0) + 1;
  const {planes: _p, values: _v, planeRows: _r, ...rest} = base;
  return {image: {...rest, components, wideCoefficients, ...(perceptual ? {perceptual: true} : {}), strategyData: {groups, blocks, at, tables: strategyTableList(tables), stride}}, counts,
    layout: blocks.map(({id, bx, by}) => ({id, bx, by}))};
}
export function strategyTables(base, ids, options) {
  const tables = searchTables(base, options);
  for (const id of ids) tableFor(id, base.components, options.sizeScale ?? 1, tables);
  return tables;
}

export function auditLevels(base, width, height, options, layout, answer) {
  const exact = answer?.exact;
  if (!(exact instanceof Map) || !Array.isArray(layout)) return Infinity;
  if (!layout.length) return 0;
  const stride = base.components[0].stride, exactOf = (id, bx, by) => exact.get(id * 16777216 + by * stride + bx) ?? exact.get(id + ':' + bx + ':' + by);
  const indices = new Set([0, layout.length - 1]), shapes = new Set([...indices].map(i => layout[i]?.id));
  const add = i => { if (indices.size < 8) indices.add(i); };
  for (let i = 0; i < layout.length; i++) {
    const b = layout[i];
    if (!b || !TRANSFORMS[b.id] || !exactOf(b.id, b.bx, b.by)) return Infinity;
    if (!shapes.has(b.id)) { shapes.add(b.id); add(i); }
  }
  for (let i = 1; i < 8; i++) add(Math.floor(i * (layout.length - 1) / 7));
  const selected = [...indices].map(i => layout[i]);
  for (const {id, bx, by} of selected) {
    const t = TRANSFORMS[id], size = t.width * t.height, area = size / 64, block = exactOf(id, bx, by);
    if (block.coeffs?.length !== 3 || block.dc?.length !== 3) return Infinity;
    for (let c = 0; c < 3; c++) if (block.coeffs[c]?.length !== size || block.dc[c]?.length !== area) return Infinity;
  }
  const fixed = {...options, layout: selected, chooseOnly: false, priceOnly: false, exact: null,
    built: null, blocks: null, transforms: null, maps: null, rates: null, costs: null, rateBlock: null};
  const device = fixedStrategyImage(base, width, height, {...fixed, exact}).image.strategyData.blocks;
  const own = fixedStrategyImage(base, width, height, fixed).image.strategyData.blocks;
  if (device.length !== selected.length || own.length !== selected.length) return Infinity;
  for (let i = 0; i < own.length; i++) {
    const a = own[i], b = device[i];
    if (a.id !== b.id || a.bx !== b.bx || a.by !== b.by) return Infinity;
    for (let c = 0; c < 3; c++) {
      for (let k = 0; k < a.coeffs[c].length; k++) if (a.coeffs[c][k] !== b.coeffs[c][k]) return Infinity;
      for (let k = 0; k < a.dc[c].length; k++) if (a.dc[c][k] !== b.dc[c][k]) return Infinity;
    }
  }
  return 0;
}

export function lazyStrategyImage(base, width, height, options, layout) {
  const stride = base.components[0].stride, built = new Map();
  let byRow = null;
  const rows = (by0, by1) => {
    if (!byRow) { byRow = Array.from({length: base.components[0].rows}, () => []); for (const entry of layout) byRow[entry.by].push(entry); }
    for (const key of built.keys()) if (((key % 16777216) / stride | 0) < by0) built.delete(key);
    const entries = [];
    for (let by = by0; by < Math.min(by1, byRow.length); by++) entries.push(...byRow[by]);
    return fixedStrategyImage(base, width, height, {...options, layout: entries, built}).image;
  };
  return {width, height, components: base.components, layout, lazyStrategy: {rows, materialize: () => fixedStrategyImage(base, width, height, {...options, layout}).image}};
}
export const materialize = image => image?.lazyStrategy ? image.lazyStrategy.materialize() : image;

export {vbPackSigned, VB_SMALL, VB_CONFIG, VB_ZD, VB_NZ, VB_TOKENS, tableFor};
