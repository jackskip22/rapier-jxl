// SPDX-License-Identifier: MIT
import {strategyTableList} from './vardct-tables.mjs';
import {fitRawSteps} from './vardct-planes.mjs';
import {perceptualMaskField, maskDoubtOver} from './photo-mask.mjs';
import {scaledDCT, scaledDCTAt, smallTransform, naturalOrder, lowFrequenciesScratch, lowFrequencyTable, TRANSFORMS, scaledDCTBases} from './vardct-strategies.mjs';
import {kernelHooks} from './kernel-hooks.mjs';
import {timed} from './stage-trace.mjs';
import {fault, outOfMemory} from './fault.mjs';
const noSmall = () => { throw fault('JXL_INTERNAL', 'varblock-core:small'); };
import {zeroDensityContext} from './vardct.mjs';
import {prepareQuantParams, quantParamSteps} from './quantization-params.mjs';
import {SCAN as VB_SCAN} from './dct8-contexts.mjs';
import {hybridToken, uintConfig} from './prefix.mjs';

const VB_CONFIG = /* @__PURE__ */ uintConfig(4, 1, 0), VB_ZD = 458, VB_NZ = 37, VB_TOKENS = 64;
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

function strategyRatePrediction(r, bx, by) {
  return bx === 0 ? (by === 0 ? 32 : r[(by - 1) * 32]) : by === 0 ? r[bx - 1] : (r[(by - 1) * 32 + bx] + r[by * 32 + bx - 1] + 1) >> 1;
}
function addStrategyRateBlock(coeffs, at, predicted, nz, zd) {
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
function addStrategyRateTotals(table, contexts, all) {
  for (let i = 0; i < contexts; i++) for (let t = 0; t < VB_TOKENS; t++) all[t] += table[i * VB_TOKENS + t];
  return all;
}
function finishStrategyRateTotals(all) {
  let total = 0; for (const v of all) total += v;
  return total;
}
function fillStrategyRateBits(table, contexts, smoothing, all, total, out) {
  for (let i = 0; i < contexts; i++) {
    let n = 0; for (let t = 0; t < VB_TOKENS; t++) n += table[i * VB_TOKENS + t];
    for (let t = 0; t < VB_TOKENS; t++) out[i * VB_TOKENS + t] = -Math.log2((table[i * VB_TOKENS + t] + smoothing * all[t] / total) / (n + smoothing));
  }
  return out;
}

const VB_RATE_MODELS = new WeakMap();
export const rateModel = (typeof __RAPIER_JXL_CAPTURE_PHOTO__ !== 'undefined' && __RAPIER_JXL_CAPTURE_PHOTO__ === true) ? null : function rateModel(image, stride, rows, smoothing) {
  const kept = VB_RATE_MODELS.get(image)?.get(smoothing);
  if (kept) return kept;
  const model = buildRateModel(image, stride, rows, smoothing);
  (VB_RATE_MODELS.get(image) || VB_RATE_MODELS.set(image, new Map()).get(image)).set(smoothing, model);
  return model;
};
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
const VB_LOG2 = /* @__PURE__ */ new Float64Array(4096).fill(NaN);
const vbLog2 = q => { if (q >= 4096) return Math.log2(q); const v = VB_LOG2[q]; return v === v ? v : VB_LOG2[q] = Math.log2(q); };
const vbLog2Table = () => { for (let q = 1; q < 4096; q++) vbLog2(q); return VB_LOG2; };
const vbRecon = (m, c) => m === 0 ? 0 : m === 1 ? VB_ONE[c] : m - 0.145 / m;
const VB_RECON = /* @__PURE__ */ Float64Array.from({length: 4096}, (_, m) => m > 1 ? m - 0.145 / m : 0);
const VB_QS = 256;

const VB_SMALL = new Set([3, 12, 13]);
export const VB_DOUBT = 2130706432;
export function deadZoneThresholds(dead, gentleDz, c, z) {
  const d0 = dead ? dead[c * 2] : 0.5, d1 = dead ? dead[c * 2 + 1] : 0.5;
  if (z === 1) return [d0, d1];
  if (gentleDz) return [d0 * z, d1 * z];
  if (z > 1) {
    const zc = c === 1 ? z : 1 + 1.18 * (z - 1);
    return [d0 * (1 + 0.90 * (zc - 1)), d1 * (1 + 1.10 * (zc - 1))];
  }
  const zc = c === 1 ? z : 1 + 0.55 * (z - 1);
  return [d0 * zc, d1 * (1 + 0.90 * (zc - 1))];
}
function vbSettle(certified, id, bx, by, w, h, bw, bh, area, size, table, comps, planeRows, W, cfl, fine, dead, zone = 1, gentleDz = false) {
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
    const q = certified.coeffs[c], steps = table.planes[c], [lo, hi] = deadZoneThresholds(dead, gentleDz, c, zone);
    for (let k = area; k < size; k++) {
      const pos = order[k];
      if (q[pos] !== VB_DOUBT) continue;
      const coefficient = exact[c].get(pos) - (c !== 1 ? factor[c] * exact[1].get(pos) : 0);
      const v = coefficient * 8 * VB_QS / steps[pos] * fine, a = Math.abs(v);
      const level = a < (high[pos] ? hi : lo) ? 0 : Math.round(a);
      q[pos] = v < 0 ? -level : level;
    }
    const dc = certified.dc[c];
    if (dc.includes(VB_DOUBT)) {
      const tr = new Float64Array(size);
      for (const at of low) tr[at] = exact[c].get(at);
      const lows = lowFrequenciesScratch(tr, bw, bh), dcStep = comps[c].quant[0] / VB_QS;
      for (let i = 0; i < area; i++) if (dc[i] === VB_DOUBT) dc[i] = Math.round(lows[i] * 8 / dcStep);
    }
  }
}
function freqOf(id, pos, sizeScale, smallScale = 1) {
  if (!(typeof __RAPIER_JXL_CAPTURE_PHOTO__ !== 'undefined' && __RAPIER_JXL_CAPTURE_PHOTO__ === true) && id === 3) {
    if (pos === 1 || pos === 8 || pos === 9) return [pos & 1, pos >> 3, smallScale];
    return [2 * ((pos & 7) >> 1), 2 * ((pos >> 3) >> 1), 2 * smallScale];
  }
  if (!(typeof __RAPIER_JXL_CAPTURE_PHOTO__ !== 'undefined' && __RAPIER_JXL_CAPTURE_PHOTO__ === true) && (id === 12 || id === 13)) {
    if (pos === 8) return [0, 1, smallScale];
    return [pos & 7, 2 * ((pos >> 3) >> 1), 8 / Math.sqrt(32) * smallScale];
  }
  const t = TRANSFORMS[id], w = t.width, h = t.height, L = Math.max(w, h), S = Math.min(w, h), wide = w > h;
  const fl = (pos % L) * 8 / L, fs = Math.floor(pos / L) * 8 / S;
  return [wide ? fl : fs, wide ? fs : fl, 8 / Math.sqrt(w * h) * (w * h > 64 ? sizeScale : 1)];
}
const VB_PIXEL = new Map();
function pixelWeights(id) {
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
function fillStrategyHigh(id, out, from = 0, to = out.length, origin = 0) {
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
  return id === 0 && !env.compactDct8 ? Math.max(1, Math.round(v * scale)) : v * scale;
}

const strategyTableEnvironment = (base, options) => ({field: base.quantFields ? base.quantFieldBase : 32,
  smallScale: options.smallScale ?? 1, activeBands: options.tableBands ?? (options.perceptual ? 8 : VB_BANDS),
  dct8Bands: options.dct8Bands ?? 8, compactDct8: !!options.compactDct8});
const searchTables = (base, options) => Object.assign(new Map(), {env: strategyTableEnvironment(base, options)});
const VB_BANDS = 12;

function addStrategyBandFit(target, L, S, env, A, y, from = 1, to = L * S, origin = 0) {
  const B = env.activeBands, scale = (B - 1) / (1.4142135623730951 + .000001);
  for (let k = from; k < to; k++) {
    const x = (k % L) / (L - 1), yy = Math.floor(k / L) / (S - 1), p = Math.sqrt(x * x + yy * yy) * scale;
    const i = Math.min(B - 2, Math.floor(p)), t = p - i, lw = Math.log(8 * 255 * VB_QS / (env.field * target[k - origin]));
    const a = [[i, 1 - t], [i + 1, t]];
    for (const [r, wr] of a) { y[r] += wr * lw; for (const [c2, wc] of a) A[r * B + c2] += wr * wc; }
  }
}
function finishStrategyBandFit(A, y, B) {
  for (let i = 0; i < B; i++) A[i * B + i] += 1e-6;
  for (let i = 0; i < B; i++) {
    for (let r = i + 1; r < B; r++) { const f = A[r * B + i] / A[i * B + i]; for (let c2 = i; c2 < B; c2++) A[r * B + c2] -= f * A[i * B + c2]; y[r] -= f * y[i]; }
  }
  const beta = new Float64Array(B);
  for (let i = B - 1; i >= 0; i--) { let v = y[i]; for (let c2 = i + 1; c2 < B; c2++) v -= A[i * B + c2] * beta[c2]; beta[i] = v / A[i * B + i]; }
  const bands = [Math.exp(beta[0])];
  for (let i = 1; i < B; i++) { const r = Math.exp(beta[i] - beta[i - 1]); bands.push(r >= 1 ? r - 1 : 1 - 1 / r); }
  return bands;
}

function fitBands(target, L, S, env) {
  const B = env.activeBands, A = new Float64Array(B * B), y = new Float64Array(B);
  addStrategyBandFit(target, L, S, env, A, y);
  return finishStrategyBandFit(A, y, B);
}
function fillStrategyTableTargets(quant, id, sizeScale, env, out, from = 0, to = out.length, origin = 0) {
  for (let k = from; k < to; k++) out[k - origin] = stepAt(quant, id, k, sizeScale, env);
  return out;
}
function strategyBandTarget(id, target) {
  if (!(typeof __RAPIER_JXL_CAPTURE_PHOTO__ !== 'undefined' && __RAPIER_JXL_CAPTURE_PHOTO__ === true) && id === 3) return Float64Array.from({length: 16}, (_, k) => target[2 * (k >> 2) * 8 + 2 * (k & 3)]);
  if (!(typeof __RAPIER_JXL_CAPTURE_PHOTO__ !== 'undefined' && __RAPIER_JXL_CAPTURE_PHOTO__ === true) && (id === 12 || id === 13)) return Float64Array.from({length: 32}, (_, k) => target[2 * (k >> 3) * 8 + (k & 7)]);
  return target;
}
function strategyTableParameters(id, targets, bands, env) {
  const weight = step => 8 * 255 * VB_QS / (env.field * step);
  if (!(typeof __RAPIER_JXL_CAPTURE_PHOTO__ !== 'undefined' && __RAPIER_JXL_CAPTURE_PHOTO__ === true) && id === 3) return {mode: 'dct4', bands, multipliers: targets.map((p, c) => [bands[c][0] / weight(p[1]), bands[c][0] / weight(p[9])])};
  if (!(typeof __RAPIER_JXL_CAPTURE_PHOTO__ !== 'undefined' && __RAPIER_JXL_CAPTURE_PHOTO__ === true) && (id === 12 || id === 13)) return {mode: 'dct4x8', bands, multipliers: targets.map((p, c) => bands[c][0] / weight(p[8]))};
  return {mode: 'dct', bands};
}

function tableFor(id, components, sizeScale, cache) {
  const env = cache.env;
  if (cache.has(TRANSFORMS[id].table)) return cache.get(TRANSFORMS[id].table);
  const t = TRANSFORMS[id], w = t.width, h = t.height, L = Math.max(w, h), S = Math.min(w, h);
  const targets = components.map(comp => fillStrategyTableTargets(comp.quant, id, sizeScale, env, new Float64Array(L * S)));
  let table, input;
  if (id === 0 && !env.compactDct8) table = {w: L, h: S, planes: fitRawSteps(targets.map(p => Int32Array.from(p)))};
  else {
    const lowW = id === 3 ? 4 : id === 12 || id === 13 ? 8 : L, lowH = id === 3 || id === 12 || id === 13 ? 4 : S;
    const bandEnv = id === 0 ? {...env, activeBands: env.dct8Bands} : env;
    const bands = targets.map(p => fitBands(strategyBandTarget(id, p), lowW, lowH, bandEnv));
    input = strategyTableParameters(id, targets, bands, bandEnv);
  }
  if (input) {
    const parameters = prepareQuantParams(input, L, S, t.table);
    table = {w: L, h: S, parameters, planes: quantParamSteps(parameters, VB_QS, env.field, [0, 1, 2])};
  }
  cache.set(t.table, table);
  return table;
}

function channelNorm(comps, weights, lowScale) {
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
  const fine = new Float64Array(stride * rows).fill(1);
  if (base.quantFields) for (let i = 0; i < fine.length; i++) fine[i] = base.quantFields[i] / base.quantFieldBase;
  let zones = null;
  if (!(typeof __RAPIER_JXL_CAPTURE_PHOTO__ !== 'undefined' && __RAPIER_JXL_CAPTURE_PHOTO__ === true) && !options.costs && options.deadzoneMap && options.gpuDeadzone) {
    const map = options.deadzoneMap, gentle = !!options.gentleChromaDz, byScale = new Map(), list = [];
    const indices = new Uint32Array(stride * rows);
    for (let i = 0; i < indices.length; i++) {
      const z = map[i];
      let idx = byScale.get(z);
      if (idx === undefined) {
        idx = list.length / 6;
        byScale.set(z, idx);
        for (let c = 0; c < 3; c++) list.push(...deadZoneThresholds(deadzone, gentle, c, z));
      }
      indices[i] = idx;
    }
    zones = {indices, thresholds: Float64Array.from(list)};
  }
  return {stride, rows, planes: base.planes, transforms, tokens: !(typeof __RAPIER_JXL_CAPTURE_PHOTO__ !== 'undefined' && __RAPIER_JXL_CAPTURE_PHOTO__ === true) && options.model !== 'simple' ? rateModel(base, stride, rows, 8) : null,
    norm, dead: deadzone || null, zones, fine, cfl: base.cfl, one: VB_ONE, dcSteps: comps.map(comp => comp.quant[0] / VB_QS), recon: VB_RECON, log2: vbLog2Table()};
}

export class TransformCache extends Map {
  constructor(maxBytes) { super(); this.maxBytes = maxBytes; this.bytes = 0; this.source = null; }
  forSource(planes, width, height, stride, rows) {
    if (!(this.maxBytes > 0)) return null;
    if (!this.source) {
      try { this.source = [new WeakRef(planes[0]), new WeakRef(planes[1]), new WeakRef(planes[2]), width, height, stride, rows]; }
      catch (error) { if (outOfMemory(error)) return null; throw error; }
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
      catch (error) { if (outOfMemory(error)) return this; throw error; }
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
export const tokenRate = (typeof __RAPIER_JXL_CAPTURE_PHOTO__ !== 'undefined' && __RAPIER_JXL_CAPTURE_PHOTO__ === true) ? null : function tokenRate(block, tokens, rc = [4, 3, 2, 0.6]) {
  const {area, size, order, coeffs} = block;
  let R = 0;
  for (const c of [1, 0, 2]) {
    const plane = coeffs[c], R0 = R;
    for (let k = area; k < size; k++) { const q = plane[order[k]]; if (q) R += rc[1] + rc[2] * vbLog2(q < 0 ? -q : q); }
    R += tokenBitsOf(tokens, c, plane, order, area, size) - (R - R0);
  }
  return R;
};
export function slabAllocator() {
  let slab = null, slabAt = 0, slabSize = 16384;
  return n => {
    if (n > 262144) return new Int32Array(n);
    if (!slab || slabAt + n > slab.length) { slab = new Int32Array(Math.max(slabSize, n)); slabAt = 0; slabSize = Math.min(1 << 20, slabSize * 2); }
    slabAt += n;
    return slab.subarray(slabAt - n, slabAt);
  };
}
export function createStrategyBuilder(base, width, height, options = {}, storage = null) {
  let maps = options.maps, repricing = false, settled = 0, measuredCost = null;
  const {lambda = 1, sizeScale = 1, ids = [5, 10, 11, 4, 6, 7], rate: rc = [4, 3, 2, 0.6], deadzone, weights = [1, 1, 1],
    detailWeight: detailW = 1.25, inhom = 0.08} = options;
  const comps = base.components, stride = comps[0].stride, rows = comps[0].rows, W = stride * 8, planes = base.planes;
  const transforms = !(typeof __RAPIER_JXL_CAPTURE_PHOTO__ !== 'undefined' && __RAPIER_JXL_CAPTURE_PHOTO__ === true) && options.transforms instanceof TransformCache ? options.transforms.forSource(planes, width, height, stride, rows) : null;
  const fineOf = (bx, by) => base.quantFields ? base.quantFields[by * stride + bx] / base.quantFieldBase : 1;
  const tables = searchTables(base, options), cfl = base.cfl, dead = deadzone;
  const still = !(typeof __RAPIER_JXL_CAPTURE_PHOTO__ !== 'undefined' && __RAPIER_JXL_CAPTURE_PHOTO__ === true);
  const zoneMap = still && !options.costs && options.deadzoneMap || null, zoneAt = (bx, by) => zoneMap ? zoneMap[by * stride + bx] : 1;
  const gentleDz = !!options.gentleChromaDz;
  const deadPairScratch = new Float64Array(2), runZones = new Float64Array(6);
  let runZonesAt = NaN;
  const deadZonePair = (c, z) => {
    const d0 = dead ? dead[c * 2] : 0.5, d1 = dead ? dead[c * 2 + 1] : 0.5;
    if (z === 1) { deadPairScratch[0] = d0; deadPairScratch[1] = d1; return deadPairScratch; }
    if (gentleDz) { deadPairScratch[0] = d0 * z; deadPairScratch[1] = d1 * z; return deadPairScratch; }
    if (z > 1) {
      const zc = c === 1 ? z : 1 + 1.18 * (z - 1);
      deadPairScratch[0] = d0 * (1 + 0.90 * (zc - 1)); deadPairScratch[1] = d1 * (1 + 1.10 * (zc - 1));
      return deadPairScratch;
    }
    const zc = c === 1 ? z : 1 + 0.55 * (z - 1);
    deadPairScratch[0] = d0 * zc; deadPairScratch[1] = d1 * (1 + 0.90 * (zc - 1));
    return deadPairScratch;
  };
  const zonesOf = z => {
    if (z === runZonesAt) return runZones;
    runZonesAt = z;
    for (let c = 0; c < 3; c++) { const p = deadZonePair(c, z); runZones[c * 2] = p[0]; runZones[c * 2 + 1] = p[1]; }
    return runZones;
  };
  const rated = still && !!options.layout && !!options.rated;
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
    throw fault('JXL_INTERNAL', 'varblock-core:args');
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
    if (id === 0 && !loses && priceOnly && !keepChosen && canPriceRow8) {
      const slotRow = by & 7;
      if (pricedRowDone?.[slotRow] !== by) fillPriceRow8(by);
      const idx = slotRow * stride + bx;
      if (pricedValid[idx]) {
        const D = pricedDR[idx * 2], R = pricedDR[idx * 2 + 1];
        return {id: 0, bx, by, bw: 1, bh: 1, area: 1, light: true, R, D, J: D + lambda * R, Je: doubtOf(bx, by, 1, 1) * D};
      }
    }
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
  const kept = storage ?? (stride * rows >= 16384 ? slabAllocator() : n => new Int32Array(n));
  const keepsAll = !!options.layout;
  const lowScratch = new Map();
  const make = c => {
    let b;
    if (c.slot >= 0 && c.epoch === vkKernel.epoch()) {
      const {id, bx, by, bw, bh, area, size} = c, order = naturalOrder(bw, bh), levels = kept(3 * (size + area)), coeffs = [], dc = [];
      vkKernel.copyLevels(c.slot, size, levels);
      const L = Math.max(bw, bh), S = Math.min(bw, bh), tr = area > 1 ? lowScratch.get(size) || lowScratch.set(size, new Float64Array(size)).get(size) : null;
      for (let ch = 0; ch < 3; ch++) {
        coeffs[ch] = levels.subarray(ch * size, (ch + 1) * size);
        const out = dc[ch] = levels.subarray(3 * size + ch * area, 3 * size + (ch + 1) * area), dcStep = comps[ch].quant[0] / VB_QS;
        if (area === 1) { out[0] = Math.round(c.lows[ch] * 8 / dcStep); continue; }
        for (let y = 0; y < S; y++) for (let x = 0; x < L; x++) tr[y * L * 8 + x] = c.lows[ch * area + y * L + x];
        const low = lowFrequenciesScratch(tr, bw, bh);
        for (let k = 0; k < area; k++) out[k] = Math.round(low[k] * 8 / dcStep);
      }
      b = {id, bx, by, bw, bh, area, size, order, coeffs, dc, levels: levels.subarray(0, 3 * size), R: c.R, J: c.J, narrow: true};
    } else {
      priceOnly = false;
      const t = TRANSFORMS[c.id];
      b = kernelBlock(c.id, c.bx, c.by, t.width, t.height, c.bw, c.bh, c.bw * c.bh, t.width * t.height, tableFor(c.id, comps, sizeScale, tables), naturalOrder(c.bw, c.bh), null);
      priceOnly = true;
    }
    if (c.fallback) b.fallback = c.fallback;
    return b;
  };
  const bounded = priced && !priceOnly && !tokens && !options.maps && !rates && !costs && !transforms && !gpuBlocks && !options.exact;
  if (!kernelHooks.varblock) kernelHooks.ensure?.();
  const vkKernel = kernelHooks.varblock?.(vbLog2Table(), scaledDCTBases) ?? null;
  if (!vkKernel) throw Object.assign(new Error('WebAssembly SIMD required'), {code: 'JXL_WASM'});
  const vk = !tokens && !options.maps && !rates && (!costs || certifiedCosts) && !transforms && !gpuBlocks && !options.exact ? vkKernel : null, sums = new Float64Array(3);
  const dctPack = vk && !priced && base.dctPack || null, needSums = priced || rated;
  const canPriceRow8 = priced && !!vk?.priceRow8 && !zoneMap;
  let pricedRowDone = null, pricedDR = null, pricedValid = null, priceParams = null, priceOnes = null, priceZones = null;
  const fillPriceRow8 = by => {
    if (!pricedDR) {
      pricedRowDone = new Int32Array(8).fill(-1);
      pricedDR = new Float64Array(8 * stride * 2);
      pricedValid = new Uint8Array(8 * stride);
      priceParams = new Float64Array(stride * 5);
      priceZones = Float64Array.from(zonesOf(1));
      priceOnes = Float64Array.from([VB_ONE[0], VB_ONE[1], VB_ONE[2], norm[0], norm[1], norm[2], useMask ? detailW : 1]);
    }
    const slotRow = by & 7, vBase = slotRow * stride, drBase = vBase * 2;
    pricedRowDone[slotRow] = by;
    const {planes: rowsOf, top, left = 0, stride: rowW = W} = planeRows(by * 8, by * 8 + 8, 0, stride * 8);
    const table = tableFor(0, comps, sizeScale, tables), order = naturalOrder(1, 1);
    const slot = vk.table(0, table, 64, order, highOf(0, 64));
    if (!slot) { pricedValid.fill(0, vBase, vBase + stride); return; }
    const tiRow = (by >> 3) * cfl.width;
    for (let bx = 0; bx < stride; bx++) {
      const ti = tiRow + (bx >> 3), fine = fineOf(bx, by), o = bx * 5;
      priceParams[o] = cfl.x[ti] / 84; priceParams[o + 1] = cfl.b[ti] / 84;
      priceParams[o + 2] = fine; priceParams[o + 3] = 8 * VB_QS * fine;
      priceParams[o + 4] = useMask ? cellMW(bx, by) : 1;
    }
    for (let bx0 = 0; bx0 < stride;) {
      const rem = stride - bx0;
      const made = vk.priceRow8(rowsOf, top, bx0 * 8 - left, by * 8, rowW, rem, slot,
        bx0 ? priceParams.subarray(bx0 * 5) : priceParams, priceZones, priceOnes, rc[0], rc[1], rc[2], rc[3]);
      if (!made) { pricedValid.fill(0, vBase + bx0, vBase + stride); break; }
      const done = made.done;
      if (done > 0) {
        pricedDR.set(made.dr, drBase + bx0 * 2);
        pricedValid.fill(1, vBase + bx0, vBase + bx0 + done);
      }
      if (done === rem) break;
      pricedValid[vBase + bx0 + done] = 0;
      bx0 += done + 1;
    }
  };
  const smallWeights = id => VB_SMALL.has(id) ? ((typeof __RAPIER_JXL_CAPTURE_PHOTO__ !== 'undefined' && __RAPIER_JXL_CAPTURE_PHOTO__ === true) ? noSmall() : pixelWeights(id)) : null;
  const kernelBlock = (id, bx, by, w, h, bw, bh, area, size, table, order, loses) => {
    let rowsOf = null, top = 0, left = 0, rowW = W, slot = null;
    const packedAt = dctPack ? dctPack.at[by * stride + bx] : 0xffffffff;
    if (packedAt !== 0xffffffff) {
      slot = vkKernel.table(id, table, size, order, highOf(id, size), smallWeights(id));
      if (!slot) throw fault('JXL_PLATFORM', 'varblock:table-size');
      vkKernel.load(dctPack.planes, packedAt, size);
    } else {
      ({planes: rowsOf, top, left = 0, stride: rowW = W} = planeRows(by * 8, by * 8 + h, bx * 8, bx * 8 + w));
      slot = vkKernel.table(id, table, size, order, highOf(id, size), smallWeights(id));
      if (!slot) throw fault('JXL_PLATFORM', 'varblock:table-size');
      if (loses) vkKernel.block(rowsOf, top, bx * 8 - left, by * 8, rowW, w, h, 1, 1, id);
      else vkKernel.block(rowsOf, top, bx * 8 - left, by * 8, rowW, w, h, 0, 2, id);
    }
    const ti = (by >> 3) * cfl.width + (bx >> 3), fine = fineOf(bx, by), unit = 8 * VB_QS * fine;
    const levels = priceOnly ? null : keepsAll ? kept(3 * (size + area)) : new Int32Array(3 * (size + area)), coeffs = priceOnly ? null : [null, null, null], dc = priceOnly ? null : [null, null, null];
    let keep = priceOnly && keepChosen ? vkKernel.reserve(size) : -1, lows = null, wide = false;
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
      const fc = c === 0 ? cfl.x[ti] / 84 : c === 2 ? cfl.b[ti] / 84 : 0, dzp = deadZonePair(c, zoneAt(bx, by)), lo = dzp[0], hi = dzp[1];
      if (levels) {
        const tr = vkKernel.coefficients(c, size), dcStep = comps[c].quant[0] / VB_QS, out = dc[c] = levels.subarray(3 * size + c * area, 3 * size + (c + 1) * area);
        if (area === 1) out[0] = Math.round(tr[0] * 8 / dcStep);
        else {
          const lAt = packedAt !== 0xffffffff && dctPack.lowAt ? dctPack.lowAt[by * stride + bx] : 0xffffffff;
          if (lAt !== 0xffffffff) {
            const pLow = dctPack.lows, baseLow = lAt + c * area;
            for (let k = 0; k < area; k++) out[k] = Math.round(pLow[baseLow + k] * 8 / dcStep);
          } else {
            const low = lowFrequenciesScratch(tr, bw, bh);
            for (let k = 0; k < low.length; k++) out[k] = Math.round(low[k] * 8 / dcStep);
          }
        }
      }
      const qRes = vkKernel.quant(c, slot, area, size, fc, lo, hi, fine, unit, VB_ONE[c], useMask ? detailW : 1, rc[1], rc[2], R, plane, needSums ? sums : null, keep);
      if (!qRes) throw fault('JXL_PLATFORM', 'varblock:quant');
      if (qRes === 2) { if (keep >= 0) vkKernel.unreserve(keep); keep = -1; lows = null; wide = true; }
      if (needSums) {
        const d = sums[0], zeros = sums[2]; R = sums[1];
        D += norm[c] * d * w * h * blockMW;
        R += rc[0] + rc[3] * zeros;
      }
      if (coeffs) coeffs[c] = plane;
      if (c === 1 && loses) {
        if (loses(D + lambda * R)) { if (keep >= 0) vkKernel.unreserve(keep); return {id, bx, by, bw, bh, light: true, J: Infinity}; }
        vkKernel.block(rowsOf, top, bx * 8 - left, by * 8, rowW, w, h, 0, 0, id); vkKernel.block(rowsOf, top, bx * 8 - left, by * 8, rowW, w, h, 2, 2, id);
      }
      if (keep >= 0) {
        lows ||= new Float64Array(3 * area);
        const tr = vkKernel.coefficients(c, size);
        if (area === 1) lows[c] = tr[0];
        else for (let y = 0; y < S; y++) for (let x = 0; x < L; x++) lows[c * area + y * L + x] = tr[y * L * 8 + x];
      }
    }
    if (!priced && rateBlock && by >= rateFrom) {
      if (id === 0) rateBlock({id, bx, by, area, size, order, coeffs});
      else {
        const pTable = tableFor(id, comps, sizeScale, plainTables), pSlot = vkKernel.table(id + 32, pTable, size, order, highOf(id, size));
        const pLevels = scratch.get(size) || scratch.set(size, new Int32Array(3 * size)).get(size), pCoeffs = [null, null, null];
        for (let i = 0; i < 3; i++) {
          const c = i === 0 ? 1 : i === 1 ? 0 : 2, pPlane = pLevels.subarray(c * size, (c + 1) * size);
          const fc = c === 0 ? cfl.x[ti] / 84 : c === 2 ? cfl.b[ti] / 84 : 0, lo = dead ? dead[c * 2] : 0.5, hi = dead ? dead[c * 2 + 1] : 0.5;
          if (!pSlot || !vkKernel.quant(c, pSlot, area, size, fc, lo, hi, fine, unit, VB_ONE[c], 1, rc[1], rc[2], 0, pPlane, null, -1))
            throw fault('JXL_PLATFORM', 'varblock:quant');
          pCoeffs[c] = pPlane;
        }
        rateBlock({id, bx, by, area, size, order, coeffs: pCoeffs});
      }
    }
    if (priceOnly) return keep >= 0 ? {id, bx, by, bw, bh, area, size, light: true, R, D, J: D + lambda * R, Je: doubtOf(bx, by, bw, bh) * D, slot: keep, lows, epoch: vkKernel.epoch()}
      : {id, bx, by, bw, bh, area, light: true, R, D, J: D + lambda * R, Je: doubtOf(bx, by, bw, bh) * D};
    if (!priced) return !rated && !wide ? {id, bx, by, bw, bh, area, size, order, coeffs, dc, levels: levels.subarray(0, 3 * size)}
      : {id, bx, by, bw, bh, area, size, order, coeffs, dc, levels: levels.subarray(0, 3 * size), R: rated ? R : 0, J: 0, narrow: !wide};
    return {id, bx, by, bw, bh, area, size, order, coeffs, dc, levels: levels.subarray(0, 3 * size), R, D, J: D + lambda * R, Je: doubtOf(bx, by, bw, bh) * D, narrow: !wide};
  };
  const full = (id, bx, by, loses = null) => {
    const t = TRANSFORMS[id], w = t.width, h = t.height, bw = w / 8, bh = h / 8, area = bw * bh, size = w * h;
    const known = built?.get(id * 16777216 + by * stride + bx);
    if (known) { tableFor(id, comps, sizeScale, tables); return known; }
    const certified = options.exact?.get(id * 16777216 + by * stride + bx) ?? options.exact?.get(id + ':' + bx + ':' + by);
    if (certified) {
      const table = tableFor(id, comps, sizeScale, tables);
      if (certified.uncertain) vbSettle(certified, id, bx, by, w, h, bw, bh, area, size, table, comps, planeRows, W, cfl, fineOf(bx, by), dead, zoneAt(bx, by), gentleDz);
      const order = naturalOrder(bw, bh);
      let R = 0;
      if (rated) for (const c of [1, 0, 2]) {
        const plane = certified.coeffs[c];
        let zeros = 0, run = 0;
        for (let k = area; k < size; k++) { const q = Math.abs(plane[order[k]]); if (q) { R += rc[1] + rc[2] * vbLog2(q); zeros += run; run = 0; } else run++; }
        R += rc[0] + rc[3] * zeros;
      }
      return {id, bx, by, bw, bh, area, size, order, coeffs: certified.coeffs, dc: certified.dc, R, J: 0, narrow: !!certified.narrow && !certified.uncertain};
    }
    if (gpuBlocks?.has(id) && !maps) {
      tableFor(id, comps, sizeScale, tables);
      const {coeffs, dc} = gpuBlocks.get(id)(bx, by), R = costs.get(id).R[by * stride + bx];
      return {id, bx, by, bw, bh, area, size, order: naturalOrder(bw, bh), coeffs, dc, R, J: costs.get(id).D[by * stride + bx] + lambda * R};
    }
    const table = tableFor(id, comps, sizeScale, tables), order = naturalOrder(bw, bh);
    if (vk && w <= 32 && h <= 32) {
      const block = kernelBlock(id, bx, by, w, h, bw, bh, area, size, table, order, loses);
      if (!priced) built?.set(id * 16777216 + by * stride + bx, block);
      return block;
    }
    const cache = transforms, key = id * 16777216 + by * stride + bx;
    let transformed = cache?.get(key), transformChannel = null;
    if (!transformed) {
      const pixels = blockPixels.get(size) || blockPixels.set(size, new Float64Array(size)).get(size);
      const outputs = blockOutputs.get(size) || blockOutputs.set(size, [0, 1, 2].map(() => new Float64Array(size))).get(size);
      transformed = [];
      const {planes: rowsOf, top, left = 0, stride: rowW = W} = planeRows(by * 8, by * 8 + h, bx * 8, bx * 8 + w);
      transformChannel = c => {
        if (w <= 32 && h <= 32) {
          if (VB_SMALL.has(id) && typeof __RAPIER_JXL_CAPTURE_PHOTO__ !== 'undefined' && __RAPIER_JXL_CAPTURE_PHOTO__ === true) noSmall();
          vkKernel.block(rowsOf, top, bx * 8 - left, by * 8, rowW, w, h, c, c, id);
          const src = vkKernel.coefficients(c, size), dst = cache ? new Float64Array(size) : outputs[c];
          dst.set(src); transformed[c] = dst; return;
        }
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) pixels[y * w + x] = rowsOf[c][(by * 8 + y - top) * rowW + bx * 8 - left + x];
        transformed[c] = scaledDCT(pixels, w, h, cache ? undefined : outputs[c]);
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
        const low = lowFrequenciesScratch(tr, bw, bh), dcStep = comps[c].quant[0] / VB_QS, out = dc[c] = levels.subarray(3 * size + c * area, 3 * size + (c + 1) * area);
        for (let i = 0; i < low.length; i++) out[i] = Math.round(low[i] * 8 / dcStep);
      }
      let nz = 0, zeros = 0, run = 0, d = 0;
      const R0 = R;
      if (!priced) {
        const fc = factor[c], luma = transformed[1], zone = zoneAt(bx, by);
        for (let k = area; k < size; k++) {
          const pos = order[k], step = steps[pos];
          const coefficient = tr[pos] - (c !== 1 ? fc * luma[pos] : 0);
          const v = coefficient * 8 * VB_QS / step * fine, a = Math.abs(v);
          const q = a < (dead ? dead[c * 2 + high[pos]] : 0.5) * zone ? 0 : Math.round(a);
          plane[pos] = v < 0 ? -q : q;
          if (!(typeof __RAPIER_JXL_CAPTURE_PHOTO__ !== 'undefined' && __RAPIER_JXL_CAPTURE_PHOTO__ === true) && rated) { if (q) { R += rc[1] + rc[2] * vbLog2(q); zeros += run; run = 0; } else run++; }
        }
        if (!(typeof __RAPIER_JXL_CAPTURE_PHOTO__ !== 'undefined' && __RAPIER_JXL_CAPTURE_PHOTO__ === true) && rated) R += rc[0] + rc[3] * zeros;
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
  const run8 = (typeof __RAPIER_JXL_CAPTURE_PHOTO__ !== 'undefined' && __RAPIER_JXL_CAPTURE_PHOTO__ === true) ? () => null : (by, bx0, n) => {
    if (!vk?.row8 || priced || rateBlock && by + 1 > rateFrom) return null;
    const table = tableFor(0, comps, sizeScale, tables), order = naturalOrder(1, 1);
    const packedAt = dctPack ? dctPack.at[by * stride + bx0] : 0xffffffff;
    const fromPack = packedAt !== 0xffffffff && dctPack.at[by * stride + bx0 + n - 1] === packedAt + (n - 1) * 64;
    let rowsOf = null, top = 0, left = 0, rowW = W;
    if (!fromPack) ({planes: rowsOf, top, left = 0, stride: rowW = W} = planeRows(by * 8, by * 8 + 8, bx0 * 8, (bx0 + n) * 8));
    const slot = vkKernel.table(0, table, 64, order, highOf(0, 64));
    if (!slot) return null;
    const params = runParams[0]?.length >= n * 4 ? runParams[0] : (runParams[0] = new Float64Array(n * 4));
    for (let j = 0; j < n; j++) {
      const bx = bx0 + j, ti = (by >> 3) * cfl.width + (bx >> 3), fine = fineOf(bx, by);
      params[j * 4] = cfl.x[ti] / 84; params[j * 4 + 1] = cfl.b[ti] / 84; params[j * 4 + 2] = fine; params[j * 4 + 3] = 8 * VB_QS * fine;
    }
    const zones = zonesOf(zoneAt(bx0, by));
    const made = fromPack
      ? vk.row8(dctPack.planes, 0, packedAt, 0, 0, n, slot, params, zones, VB_ONE, rc[1], rc[2], rated ? [rc[0], rc[3]] : null)
      : vk.row8(rowsOf, top, bx0 * 8 - left, by * 8, rowW, n, slot, params, zones, VB_ONE, rc[1], rc[2], rated ? [rc[0], rc[3]] : null);
    if (!made) return null;
    const done = made.done, out = [];
    if (!done) return out;
    const step0 = comps[0].quant[0] / VB_QS, step1 = comps[1].quant[0] / VB_QS, step2 = comps[2].quant[0] / VB_QS;
    const rowLevels = keepsAll ? kept(done * 195) : new Int32Array(done * 195), dcBase = done * 192;
    rowLevels.set(made.levels.subarray(0, dcBase));
    for (let j = 0; j < done; j++) {
      const lOff = j * 192, dOff = dcBase + j * 3, mOff = j * 3;
      rowLevels[dOff] = Math.round(made.dc[mOff] * 8 / step0);
      rowLevels[dOff + 1] = Math.round(made.dc[mOff + 1] * 8 / step1);
      rowLevels[dOff + 2] = Math.round(made.dc[mOff + 2] * 8 / step2);
      const block = rated
        ? {id: 0, bx: bx0 + j, by, bw: 1, bh: 1, area: 1, size: 64, order,
            coeffs: [rowLevels.subarray(lOff, lOff + 64), rowLevels.subarray(lOff + 64, lOff + 128), rowLevels.subarray(lOff + 128, lOff + 192)],
            dc: [rowLevels.subarray(dOff, dOff + 1), rowLevels.subarray(dOff + 1, dOff + 2), rowLevels.subarray(dOff + 2, dOff + 3)],
            levels: rowLevels.subarray(lOff, lOff + 192), R: made.rates[j], J: 0, narrow: true}
        : {id: 0, bx: bx0 + j, by, bw: 1, bh: 1, area: 1, size: 64, order,
            coeffs: [rowLevels.subarray(lOff, lOff + 64), rowLevels.subarray(lOff + 64, lOff + 128), rowLevels.subarray(lOff + 128, lOff + 192)],
            dc: [rowLevels.subarray(dOff, dOff + 1), rowLevels.subarray(dOff + 1, dOff + 2), rowLevels.subarray(dOff + 2, dOff + 3)],
            levels: rowLevels.subarray(lOff, lOff + 192)};
      built?.set(by * stride + bx0 + j, block);
      out.push(block);
    }
    return out;
  };
  const compactRun8 = (by, bx0, n, by0, meta, mPos, levelsOut, lOff, dcsOut, dc0, dc1, dc2) => {
    if (!vk?.row8 || priced || rated || rateBlock) return 0;
    const table = tableFor(0, comps, sizeScale, tables), order = naturalOrder(1, 1);
    const packedAt = dctPack ? dctPack.at[by * stride + bx0] : 0xffffffff;
    const fromPack = packedAt !== 0xffffffff && dctPack.at[by * stride + bx0 + n - 1] === packedAt + (n - 1) * 64;
    let rowsOf = null, top = 0, left = 0, rowW = W;
    if (!fromPack) ({planes: rowsOf, top, left = 0, stride: rowW = W} = planeRows(by * 8, by * 8 + 8, bx0 * 8, (bx0 + n) * 8));
    const slot = vk.table(0, table, 64, order, highOf(0, 64));
    if (!slot) return 0;
    const params = runParams[0]?.length >= n * 4 ? runParams[0] : (runParams[0] = new Float64Array(n * 4));
    for (let j = 0; j < n; j++) {
      const bx = bx0 + j, ti = (by >> 3) * cfl.width + (bx >> 3), fine = fineOf(bx, by);
      params[j * 4] = cfl.x[ti] / 84; params[j * 4 + 1] = cfl.b[ti] / 84; params[j * 4 + 2] = fine; params[j * 4 + 3] = 8 * VB_QS * fine;
    }
    const zones = zonesOf(zoneAt(bx0, by));
    const made = fromPack
      ? vk.row8(dctPack.planes, 0, packedAt, 0, 0, n, slot, params, zones, VB_ONE, rc[1], rc[2], null)
      : vk.row8(rowsOf, top, bx0 * 8 - left, by * 8, rowW, n, slot, params, zones, VB_ONE, rc[1], rc[2], null);
    if (!made || !made.done) return 0;
    const done = made.done, byRel = by - by0, rowBase = byRel * stride;
    const step0 = comps[0].quant[0] / VB_QS, step1 = comps[1].quant[0] / VB_QS, step2 = comps[2].quant[0] / VB_QS;
    levelsOut.set(made.levels.subarray(0, done * 192), lOff);
    for (let j = 0; j < done; j++) {
      const mp = mPos + j * 6, u = lOff + j * 192, pos = rowBase + bx0 + j, mOff = j * 3;
      meta[mp] = 0; meta[mp + 1] = bx0 + j; meta[mp + 2] = byRel; meta[mp + 3] = 1; meta[mp + 4] = 1; meta[mp + 5] = u;
      const d0 = Math.round(made.dc[mOff] * 8 / step0), d1 = Math.round(made.dc[mOff + 1] * 8 / step1), d2 = Math.round(made.dc[mOff + 2] * 8 / step2);
      dc0[pos] = d0; dc1[pos] = d1; dc2[pos] = d2;
      if (dcsOut) { const dOff = u >> 6; dcsOut[dOff] = d0; dcsOut[dOff + 1] = d1; dcsOut[dOff + 2] = d2; }
    }
    return done;
  };
  const compactBlock = (id, bx, by, by0, meta, mPos, levelsOut, lOff, dcsOut, dc0, dc1, dc2) => {
    const t = TRANSFORMS[id], w = t.width, h = t.height, bw = w >> 3, bh = h >> 3, area = bw * bh, size = area * 64;
    const table = tableFor(id, comps, sizeScale, tables), order = naturalOrder(bw, bh), high = highOf(id, size);
    const ti = (by >> 3) * cfl.width + (bx >> 3), fine = fineOf(bx, by), unit = 8 * VB_QS * fine, zone = zoneAt(bx, by);
    let wide = false, usedVk = false;
    if (vk) {
      const packedAt = dctPack ? dctPack.at[by * stride + bx] : 0xffffffff;
      let slot = null;
      if (packedAt !== 0xffffffff) {
        slot = vk.table(id, table, size, order, high);
        if (slot) vk.load(dctPack.planes, packedAt, size);
      } else {
        const {planes: rowsOf, top, left = 0, stride: rowW = W} = planeRows(by * 8, by * 8 + h, bx * 8, bx * 8 + w);
        slot = vk.table(id, table, size, order, high);
        if (slot) vk.block(rowsOf, top, bx * 8 - left, by * 8, rowW, w, h, 0, 2);
      }
      if (slot) {
        usedVk = true;
        const lAt = packedAt !== 0xffffffff && dctPack.lowAt ? dctPack.lowAt[by * stride + bx] : 0xffffffff;
        for (let i = 0; i < 3; i++) {
          const c = i === 0 ? 1 : i === 1 ? 0 : 2, plane = levelsOut.subarray(lOff + c * size, lOff + (c + 1) * size);
          const fc = c === 0 ? cfl.x[ti] / 84 : c === 2 ? cfl.b[ti] / 84 : 0, dzp = deadZonePair(c, zone), lo = dzp[0], hi = dzp[1];
          const tr = vk.coefficients(c, size), dcStep = comps[c].quant[0] / VB_QS, dcArr = c === 0 ? dc0 : c === 1 ? dc1 : dc2;
          const dOff = dcsOut ? (lOff >> 6) + c * area : -1;
          if (area === 1) {
            const dv = Math.round(tr[0] * 8 / dcStep);
            dcArr[(by - by0) * stride + bx] = dv;
            if (dcsOut) dcsOut[dOff] = dv;
          } else if (lAt !== 0xffffffff) {
            const pLow = dctPack.lows, baseLow = lAt + c * area;
            for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) {
              const k = y * bw + x, dv = Math.round(pLow[baseLow + k] * 8 / dcStep);
              dcArr[(by - by0 + y) * stride + bx + x] = dv;
              if (dcsOut) dcsOut[dOff + k] = dv;
            }
          } else {
            const low = lowFrequenciesScratch(tr, bw, bh);
            for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) {
              const k = y * bw + x, dv = Math.round(low[k] * 8 / dcStep);
              dcArr[(by - by0 + y) * stride + bx + x] = dv;
              if (dcsOut) dcsOut[dOff + k] = dv;
            }
          }
          if (!vk.quant(c, slot, area, size, fc, lo, hi, fine, unit, VB_ONE[c], 1, rc[1], rc[2], 0, plane, null, -1)) {
            const luma = vk.coefficients(1, size), steps = table.planes[c];
            for (let k = 0; k < area; k++) plane[order[k]] = 0;
            for (let k = area; k < size; k++) {
              const pos = order[k], step = steps[pos];
              const coefficient = tr[pos] - (c !== 1 ? fc * luma[pos] : 0);
              const v = coefficient * 8 * VB_QS / step * fine, a = Math.abs(v);
              const q = a < (high[pos] ? hi : lo) ? 0 : Math.round(a), sv = v < 0 ? -q : q;
              plane[pos] = sv;
              if (sv < -32768 || sv > 32767) wide = true;
            }
          }
        }
      }
    }
    if (!usedVk) {
      const b = full(id, bx, by);
      for (let c = 0; c < 3; c++) {
        const plane = b.coeffs[c];
        levelsOut.set(plane, lOff + c * size);
        for (let k = 0; k < size; k++) if (plane[k] < -32768 || plane[k] > 32767) { wide = true; break; }
        const dcArr = c === 0 ? dc0 : c === 1 ? dc1 : dc2, dOff = dcsOut ? (lOff >> 6) + c * area : -1;
        for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) {
          const k = y * bw + x, dv = b.dc[c][k];
          dcArr[(by - by0 + y) * stride + bx + x] = dv;
          if (dcsOut) dcsOut[dOff + k] = dv;
        }
      }
    }
    meta[mPos] = id; meta[mPos + 1] = bx; meta[mPos + 2] = by - by0; meta[mPos + 3] = bw; meta[mPos + 4] = bh; meta[mPos + 5] = lOff;
    return wide;
  };
  let rowJobs = new ArrayBuffer(0), rowI32 = null, rowF64 = null, rowU8 = null;
  const NONE = [0, 0];
  let packSizes = new Int32Array(0);
  const compactRow = (layout, i0, i1, by0, meta, mPos, levelsOut, lOff0, dcsOut, dc0, dc1, dc2, zones, used, pk = null) => {
    if (!vk?.band || !vk.row8 || priced || rated || rateBlock || dctPack) return NONE;
    const by = layout[i0].by;
    let h = 8, end = i0;
    for (; end < i1; end++) { const t = TRANSFORMS[layout[end].id]; if (t.width * t.height > 1024) break; if (t.height > h) h = t.height; }
    if (end === i0) return NONE;
    const {planes: rowsOf, top, left = 0, stride: rowW = W} = planeRows(by * 8, by * 8 + h, 0, stride * 8);
    if (left !== 0 || rowW !== W) return NONE;
    const slots = new Map();
    for (let i = i0; i < end; i++) {
      const id = layout[i].id;
      if (slots.has(id)) continue;
      const t = TRANSFORMS[id], bw = t.width >> 3, bh = t.height >> 3, size = t.width * t.height;
      const slot = vk.table(id, tableFor(id, comps, sizeScale, tables), size, naturalOrder(bw, bh), highOf(id, size));
      if (!slot) return NONE;
      slots.set(id, slot);
    }
    let count = 0, extra = 0, maxRun = 0;
    const lows = new Map();
    for (let i = i0; i < end; count++) {
      const {id, bx} = layout[i];
      let n = 1;
      if (id === 0) {
        const zone = zones ? zones[by * stride + bx] : 1;
        while (i + n < end && layout[i + n].id === 0 && layout[i + n].bx === bx + n && (!zones || zones[by * stride + bx + n] === zone)) n++;
      }
      if (n > 1) { extra += n * 32 + 48; if (n > maxRun) maxRun = n; }
      else { const t = TRANSFORMS[id], bw = t.width >> 3, bh = t.height >> 3; if (bw * bh > 1 && !lows.has(bw * 64 + bh)) { lows.set(bw * 64 + bh, -1); extra += 8 * lowFrequencyTable(bw, bh).length; } }
      i += n;
    }
    const bytes = count * 192 + extra;
    if (rowJobs.byteLength < bytes) { rowJobs = new ArrayBuffer(Math.max(bytes, 2 * rowJobs.byteLength)); rowI32 = new Int32Array(rowJobs); rowF64 = new Float64Array(rowJobs); rowU8 = new Uint8Array(rowJobs); }
    const step0 = comps[0].quant[0] / VB_QS, step1 = comps[1].quant[0] / VB_QS, step2 = comps[2].quant[0] / VB_QS;
    let at = count * 192, lRel = 0;
    for (const key of lows.keys()) { const table = lowFrequencyTable(key >> 6, key & 63); rowF64.set(table, at >> 3); lows.set(key, at); at += 8 * table.length; }
    for (let i = i0, j = 0; i < end; j++) {
      const {id, bx} = layout[i], J = j * 48, F = j * 24;
      let n = 1;
      if (id === 0) {
        const zone = zones ? zones[by * stride + bx] : 1;
        while (i + n < end && layout[i + n].id === 0 && layout[i + n].bx === bx + n && (!zones || zones[by * stride + bx + n] === zone)) n++;
      }
      const t = TRANSFORMS[id], bw = t.width >> 3, bh = t.height >> 3, size = n > 1 ? 64 : t.width * t.height, slot = slots.get(id);
      rowI32[J] = n > 1 ? 0 : 1; rowI32[J + 1] = n > 1 ? n : id; rowI32[J + 2] = bx * 8; rowI32[J + 3] = t.width; rowI32[J + 4] = t.height;
      rowI32[J + 5] = bw; rowI32[J + 6] = bh; rowI32[J + 7] = slot.order; rowI32[J + 8] = slot.steps; rowI32[J + 9] = slot.high;
      rowI32[J + 10] = size; rowI32[J + 11] = lRel; rowI32[J + 12] = 0;
      rowF64[F + 18] = step0; rowF64[F + 19] = step1; rowF64[F + 20] = step2;
      if (n > 1) {
        rowI32[J + 13] = at; rowI32[J + 14] = at + n * 32;
        for (let k = 0, p = at >> 3; k < n; k++, p += 4) {
          const x = bx + k, ti = (by >> 3) * cfl.width + (x >> 3), fine = fineOf(x, by);
          rowF64[p] = cfl.x[ti] / 84; rowF64[p + 1] = cfl.b[ti] / 84; rowF64[p + 2] = fine; rowF64[p + 3] = 8 * VB_QS * fine;
        }
        rowF64.set(zonesOf(zoneAt(bx, by)), (at + n * 32) >> 3);
        at += n * 32 + 48; lRel += n * 192;
      } else {
        const ti = (by >> 3) * cfl.width + (bx >> 3), zone = zoneAt(bx, by);
        if (bw * bh > 1) rowI32[J + 12] = lows.get(bw * 64 + bh);
        rowF64[F + 8] = cfl.x[ti] / 84; rowF64[F + 9] = cfl.b[ti] / 84; rowF64[F + 10] = fineOf(bx, by);
        for (let c = 0; c < 3; c++) { const pair = deadZonePair(c, zone); rowF64[F + 12 + 2 * c] = pair[0]; rowF64[F + 13 + 2 * c] = pair[1]; }
        lRel += 3 * size;
      }
      i += n;
    }
    const made = vk.band(rowsOf, top, by * 8, W, h, rowU8.subarray(0, bytes), count, lRel, slots, maxRun, VB_ONE, rc[1], rc[2]);
    if (!made) return NONE;
    let blocks = 0, lMade = 0;
    const byRel = by - by0, rowBase = byRel * stride;
    for (let j = 0; j < count && j <= made.done; j++) {
      const J = j * 48, run = rowI32[J] === 0, bx = rowI32[J + 2] >> 3, lRelJ = rowI32[J + 11];
      if (run) {
        const n = j < made.done ? rowI32[J + 1] : made.stop;
        used.add(0);
        for (let k = 0; k < n; k++) {
          const mp = mPos + (blocks + k) * 6, u = lRelJ + k * 192, d = u >> 6, pos = rowBase + bx + k;
          meta[mp] = 0; meta[mp + 1] = bx + k; meta[mp + 2] = byRel; meta[mp + 3] = 1; meta[mp + 4] = 1; meta[mp + 5] = lOff0 + u;
          dc0[pos] = made.dcs[d]; dc1[pos] = made.dcs[d + 1]; dc2[pos] = made.dcs[d + 2];
        }
        blocks += n; lMade = lRelJ + n * 192;
        if (j === made.done) break;
      } else {
        if (j === made.done) break;
        const id = rowI32[J + 1], bw = rowI32[J + 5], bh = rowI32[J + 6], area = bw * bh, size = rowI32[J + 10], d = lRelJ >> 6, mp = mPos + blocks * 6;
        used.add(TRANSFORMS[id].table);
        for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) {
          const pos = (byRel + y) * stride + bx + x, k = y * bw + x;
          dc0[pos] = made.dcs[d + k]; dc1[pos] = made.dcs[d + area + k]; dc2[pos] = made.dcs[d + 2 * area + k];
        }
        meta[mp] = id; meta[mp + 1] = bx; meta[mp + 2] = byRel; meta[mp + 3] = bw; meta[mp + 4] = bh; meta[mp + 5] = lOff0 + lRelJ;
        blocks++; lMade = lRelJ + 3 * size;
      }
    }
    if (pk && vk.pack && blocks) {
      if (packSizes.length < blocks) packSizes = new Int32Array(Math.max(blocks, 2 * packSizes.length));
      for (let b = 0, p = mPos + 3; b < blocks; b++, p += 6) packSizes[b] = meta[p] * meta[p + 1] * 64;
      const packed = vk.pack(packSizes, blocks);
      if (packed) {
        const total = packed.bytes.length, at = pk.used, first = mPos / 6;
        if (pk.bytes.length < at + total) { const next = new Uint8Array(Math.max(at + total, 2 * pk.bytes.length)); next.set(pk.bytes.subarray(0, at)); pk.bytes = next; }
        pk.bytes.set(packed.bytes, at);
        for (let b = 0, from = 0; b < blocks; b++) { const to = packed.ends[b]; pk.start[first + b] = at + from; pk.len[first + b] = to - from; from = to; }
        pk.used = at + total;
      }
    }
    levelsOut.set(made.levels.subarray(0, lMade), lOff0);
    if (dcsOut) dcsOut.set(made.dcs.subarray(0, lMade >> 6), lOff0 >> 6);
    return [blocks, lMade];
  };
  return {lambda, sizeScale, ids, inhom, comps, stride, rows, tables, allowed, rates, costs, certifiedCosts, costDoubt,
    useMask, keepChosen, bounded, vk, candidateRate, candidate, full, make, run8, compactRun8, compactBlock, compactRow,
    get settled() { return settled; },
    set repricing(value) { repricing = value; },
    setMeasuredCost(value) { measuredCost = value; },
    cpuRate(id, bx, by) { const saved = maps; maps = null; const result = full(id, bx, by).R; maps = saved; return result; },
    finish(chosen) {
      priceOnly = false;
      for (let i = 0; i < chosen.length; i++) if (chosen[i].light) chosen[i] = full(chosen[i].id, chosen[i].bx, chosen[i].by);
      const out = strategyImage(base, chosen, tables, !!options.perceptual, !!options.layout);
      if (still && options.rated && !options.layout) {
        const rs = out.image.rates = new Float64Array(stride * rows);
        for (const b of chosen) rs[b.by * stride + b.bx] = b.R;
      }
      return out;
    },
  };
}

const EMPTY_I16 = /* @__PURE__ */ new Int16Array(0);
export function fixedStrategyImage(base, width, height, options, storage = null) {
  if (!options.layout) throw fault('JXL_INTERNAL', 'varblock-core:layout');
  const builder = createStrategyBuilder(base, width, height, options, storage), layout = options.layout;
  if (options.compactBy0 !== undefined && options.compactBy1 !== undefined && builder.vk && !options.rated && !options.rateBlock && !options.exact && !options.blocks) {
    const by0 = options.compactBy0, by1 = options.compactBy1, bandRows = by1 - by0, stride = builder.stride, fullRows = builder.rows, M = layout.length;
    let ok = bandRows > 0, cellsSum = 0, maxBottom = by1, prevBy = by0;
    for (let i = 0; i < M && ok; i++) {
      const b = layout[i], t = TRANSFORMS[b.id];
      if (!t || VB_SMALL.has(b.id) || b.by < prevBy || b.by >= by1) { ok = false; break; }
      prevBy = b.by;
      const bh = t.height >> 3;
      cellsSum += (t.width >> 3) * bh;
      if (b.by + bh > maxBottom) maxBottom = b.by + bh;
    }
    if (ok) {
      const dcRows = Math.max(bandRows, Math.min(fullRows, maxBottom) - by0), dcLen = stride * dcRows;
      const holder = !storage ? options.built : null;
      let pk = null, meta, levels, dcs = null, dc0, dc1, dc2, rowBlock = null, rowLevel = null, rowWide = null, prev = null;
      if (holder) {
        const slots = holder.compactSlots ||= [null, null], turn = holder.compactTurn ? 1 : 0;
        prev = slots[1 - turn];
        let slot = slots[turn];
        if (!slot || slot.meta.length < M * 6 || slot.levels.length < cellsSum * 192 || slot.dc0.length < dcLen || slot.rowBlock.length < bandRows + 1) {
          slot = slots[turn] = {
            meta: new Int32Array(Math.max(M * 6, slot?.meta.length ?? 0)),
            levels: new Int32Array(Math.max(cellsSum * 192, slot?.levels.length ?? 0)),
            dcs: new Int32Array(Math.max(cellsSum * 3, slot?.dcs.length ?? 0)),
            dc0: new Int32Array(Math.max(dcLen, slot?.dc0.length ?? 0)),
            dc1: new Int32Array(Math.max(dcLen, slot?.dc1.length ?? 0)),
            dc2: new Int32Array(Math.max(dcLen, slot?.dc2.length ?? 0)),
            rowBlock: new Int32Array(Math.max(bandRows + 1, slot?.rowBlock.length ?? 0)),
            rowLevel: new Int32Array(Math.max(bandRows + 1, slot?.rowLevel.length ?? 0)),
            rowWide: new Uint8Array(Math.max(bandRows, slot?.rowWide.length ?? 0)),
            pk: {bytes: slot?.pk.bytes ?? new Uint8Array(0), start: new Int32Array(Math.max(M, slot?.pk.start.length ?? 0)), len: new Int32Array(Math.max(M, slot?.pk.len.length ?? 0)), used: 0},
            by0: -1, by1: -1,
          };
        }
        holder.compactTurn = 1 - turn;
        meta = slot.meta; levels = slot.levels; dcs = slot.dcs; pk = slot.pk;
        pk.used = 0; pk.start.fill(-1, 0, M);
        dc0 = slot.dc0.subarray(0, dcLen); dc1 = slot.dc1.subarray(0, dcLen); dc2 = slot.dc2.subarray(0, dcLen);
        dc0.fill(0); dc1.fill(0); dc2.fill(0);
        rowBlock = slot.rowBlock; rowLevel = slot.rowLevel; rowWide = slot.rowWide;
        rowWide.fill(0, 0, bandRows);
        slot.by0 = by0; slot.by1 = by1;
      } else {
        const alloc = storage ?? (n => new Int32Array(n));
        meta = alloc(M * 6); levels = alloc(cellsSum * 192);
        dc0 = alloc(dcLen); dc1 = alloc(dcLen); dc2 = alloc(dcLen);
      }
      const used = new Set(), zones = options.deadzoneMap;
      let i = 0, lCursor = 0, curRow = 0, wideCoefficients = false;
      if (prev && prev.by0 >= 0 && prev.by0 <= by0 && by0 < prev.by1) {
        const overEnd = Math.min(by1, prev.by1), r0 = by0 - prev.by0, r1 = overEnd - prev.by0;
        const b0 = prev.rowBlock[r0], b1 = prev.rowBlock[r1], nOver = b1 - b0;
        if (nOver >= 0 && nOver <= M && (nOver === 0 || layout[nOver - 1].by < overEnd) && (nOver === M || layout[nOver].by >= overEnd)) {
          const l0 = prev.rowLevel[r0], l1 = prev.rowLevel[r1], shiftBy = r0;
          if (l1 > l0) {
            levels.set(prev.levels.subarray(l0, l1), 0);
            dcs.set(prev.dcs.subarray(l0 >> 6, l1 >> 6), 0);
          }
          for (let r = 0; r < r1 - r0; r++) {
            rowBlock[r] = prev.rowBlock[r0 + r] - b0;
            rowLevel[r] = prev.rowLevel[r0 + r] - l0;
            const rw = prev.rowWide[r0 + r];
            rowWide[r] = rw;
            if (rw) wideCoefficients = true;
          }
          curRow = r1 - r0;
          for (let b = 0; b < nOver; b++) {
            const sp = (b0 + b) * 6, dp = b * 6;
            const id = prev.meta[sp], bx = prev.meta[sp + 1], byRel = prev.meta[sp + 2] - shiftBy, bw = prev.meta[sp + 3], bh = prev.meta[sp + 4], off = prev.meta[sp + 5] - l0;
            meta[dp] = id; meta[dp + 1] = bx; meta[dp + 2] = byRel; meta[dp + 3] = bw; meta[dp + 4] = bh; meta[dp + 5] = off;
            const fam = TRANSFORMS[id].table;
            if (!used.has(fam)) { used.add(fam); tableFor(id, builder.comps, builder.sizeScale, builder.tables); }
            const dOff = off >> 6, area = bw * bh;
            if (area === 1) {
              const pos = byRel * stride + bx;
              dc0[pos] = dcs[dOff]; dc1[pos] = dcs[dOff + 1]; dc2[pos] = dcs[dOff + 2];
            } else {
              for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) {
                const pos = (byRel + y) * stride + bx + x, k = y * bw + x;
                dc0[pos] = dcs[dOff + k]; dc1[pos] = dcs[dOff + area + k]; dc2[pos] = dcs[dOff + 2 * area + k];
              }
            }
          }
          i = nOver; lCursor = l1 - l0;
        }
      }
      let tried = -1;
      while (i < M) {
        const {id, bx, by} = layout[i], byRel = by - by0;
        if (rowBlock) while (curRow <= byRel) { rowBlock[curRow] = i; rowLevel[curRow] = lCursor; curRow++; }
        if (tried !== i) {
          tried = i;
          let rowEnd = i + 1;
          while (rowEnd < M && layout[rowEnd].by === by) rowEnd++;
          const [madeBlocks, madeLevels] = builder.compactRow(layout, i, rowEnd, by0, meta, i * 6, levels, lCursor, dcs, dc0, dc1, dc2, zones, used, pk);
          if (madeBlocks > 0) { i += madeBlocks; lCursor += madeLevels; continue; }
        }
        let n = 1;
        if (id === 0) {
          const zone = zones ? zones[by * stride + bx] : 1;
          while (i + n < M && layout[i + n].id === 0 && layout[i + n].by === by && layout[i + n].bx === bx + n && (!zones || zones[by * stride + bx + n] === zone)) n++;
          if (n > 1) {
            const done = builder.compactRun8(by, bx, n, by0, meta, i * 6, levels, lCursor, dcs, dc0, dc1, dc2);
            if (done > 0) {
              used.add(0);
              i += done; lCursor += done * 192;
              if (done === n) continue;
            }
          }
        }
        const b = layout[i], t = TRANSFORMS[b.id], size = t.width * t.height;
        used.add(t.table);
        if (builder.compactBlock(b.id, b.bx, b.by, by0, meta, i * 6, levels, lCursor, dcs, dc0, dc1, dc2)) {
          wideCoefficients = true;
          if (rowWide) rowWide[b.by - by0] = 1;
        }
        i++; lCursor += 3 * size;
      }
      if (rowBlock) while (curRow <= bandRows) { rowBlock[curRow] = M; rowLevel[curRow] = lCursor; curRow++; }
      for (const family of builder.tables.keys()) if (!used.has(family)) builder.tables.delete(family);
      const comps = base.components, components = [
        {h: 1, v: 1, stride, rows: fullRows, dcRow0: by0, quant: comps[0].quant, coeffs: EMPTY_I16, dc: dc0},
        {h: 1, v: 1, stride, rows: fullRows, dcRow0: by0, quant: comps[1].quant, coeffs: EMPTY_I16, dc: dc1},
        {h: 1, v: 1, stride, rows: fullRows, dcRow0: by0, quant: comps[2].quant, coeffs: EMPTY_I16, dc: dc2},
      ];
      const {planes: _p, values: _v, planeRows: _r, dctPack: _d, ...rest} = base;
      return {
        image: {...rest, components, wideCoefficients, ...(options.perceptual ? {perceptual: true} : {}),
          strategyData: {compact: {meta: meta.subarray(0, M * 6), levels: levels.subarray(0, lCursor), by0, rows: bandRows, ...(pk?.used && {packed: pk})}, tables: strategyTableList(builder.tables), stride}},
        counts: {}, layout: null, open: [], reprices: [], reverted: 0, settled: builder.settled,
      };
    }
  }
  const chosen = [];
  for (let i = 0; i < layout.length;) {
    const {id, bx, by} = layout[i];
    let n = 1;
    const known = (x, y) => options.built?.has(y * builder.stride + x);
    const zones = options.deadzoneMap, zone = zones ? zones[by * builder.stride + bx] : 1, same = x => !zones || zones[by * builder.stride + x] === zone;
    if (id === 0 && !known(bx, by)) while (i + n < layout.length && layout[i + n].id === 0 && layout[i + n].by === by && layout[i + n].bx === bx + n && !known(bx + n, by) && same(bx + n)) n++;
    const run = n > 1 ? builder.run8(by, bx, n) : null;
    if (run) { for (const block of run) chosen.push(block); i += run.length; if (run.length === n) continue; n = 1; }
    for (const end = i + n; i < end; i++) chosen.push(builder.candidate(layout[i].id, layout[i].bx, layout[i].by));
  }
  const made = builder.finish(chosen);
  if (options.rated) {
    const rates = made.image.rates = options.ratesOut ?? new Float64Array(builder.stride * builder.rows);
    for (const b of chosen) rates[b.by * builder.stride + b.bx] = b.R;
  }
  return {...made, open: [], reprices: [], reverted: 0, settled: builder.settled};
}

export function strategyImage(base, chosen, tables, perceptual, skipLayout = false) {
  const comps = base.components, stride = comps[0].stride, rows = comps[0].rows;
  let wideCoefficients = false, top = rows, bottom = 0;
  for (let i = 0; i < chosen.length; i++) {
    const choice = chosen[i];
    if (choice.by < top) top = choice.by;
    if (choice.by + choice.bh > bottom) bottom = choice.by + choice.bh;
  }
  const at = new Int32Array(stride * rows).fill(-1), byFirst = top < bottom ? new Array((bottom - top) * stride) : [];
  const dc0 = new Int32Array(stride * rows), dc1 = new Int32Array(stride * rows), dc2 = new Int32Array(stride * rows);
  const components = [
    {h: 1, v: 1, stride, rows, quant: comps[0].quant, coeffs: new Int16Array(0), dc: dc0},
    {h: 1, v: 1, stride, rows, quant: comps[1].quant, coeffs: new Int16Array(0), dc: dc1},
    {h: 1, v: 1, stride, rows, quant: comps[2].quant, coeffs: new Int16Array(0), dc: dc2},
  ];
  for (let i = 0; i < chosen.length; i++) {
    const choice = chosen[i];
    const block = choice.J === undefined ? choice : {id: choice.id, bx: choice.bx, by: choice.by, bw: choice.bw, bh: choice.bh,
      area: choice.area, size: choice.size, order: choice.order,
      coeffs: [choice.coeffs[0], choice.coeffs[1], choice.coeffs[2]], dc: [choice.dc[0], choice.dc[1], choice.dc[2]], levels: choice.levels};
    byFirst[(block.by - top) * stride + block.bx] = block;
    const d0 = block.dc[0], d1 = block.dc[1], d2 = block.dc[2], bw = block.bw, bh = block.bh, bx = block.bx, by = block.by;
    if (bw === 1 && bh === 1) {
      const pos = by * stride + bx;
      at[pos] = -2; dc0[pos] = d0[0]; dc1[pos] = d1[0]; dc2[pos] = d2[0];
    } else for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) {
      const pos = (by + y) * stride + bx + x, k = y * bw + x;
      at[pos] = -2; dc0[pos] = d0[k]; dc1[pos] = d1[k]; dc2[pos] = d2[k];
    }
    if (!wideCoefficients && choice.J !== undefined && !choice.narrow) for (const plane of block.coeffs) for (let k = 0; k < plane.length; k++) if (plane[k] < -32768 || plane[k] > 32767) { wideCoefficients = true; break; }
  }
  const groups = [], blocks = [], gCols = Math.ceil(stride / 32), gRows = Math.ceil(rows / 32);
  const used = new Set(), counts = {};
  for (let gy = 0; gy < gRows; gy++) {
    const y0 = Math.max(gy * 32, top), y1 = Math.min(rows, gy * 32 + 32, bottom);
    if (y0 >= y1) { for (let gx = 0; gx < gCols; gx++) groups.push([]); continue; }
    for (let gx = 0; gx < gCols; gx++) {
      const group = [], x1 = Math.min(stride, gx * 32 + 32);
      for (let by = y0; by < y1; by++) {
        const rowOff = (by - top) * stride, outOff = by * stride;
        for (let bx = gx * 32; bx < x1; bx++) {
          const block = byFirst[rowOff + bx];
          if (block) {
            at[outOff + bx] = blocks.length; blocks.push(block); group.push(block);
            const t = TRANSFORMS[block.id];
            used.add(t.table); counts[t.name] = (counts[t.name] || 0) + 1;
          }
        }
      }
      groups.push(group);
    }
  }
  for (const family of tables.keys()) if (!used.has(family)) tables.delete(family);
  const {planes: _p, values: _v, planeRows: _r, dctPack: _d, ...rest} = base;
  return {image: {...rest, components, wideCoefficients, ...(perceptual ? {perceptual: true} : {}), strategyData: {groups, blocks, at, tables: strategyTableList(tables), stride}}, counts,
    layout: skipLayout ? null : blocks.map(({id, bx, by}) => ({id, bx, by}))};
}

export function packLayoutDct(planes, stride, rows, layout) {
  const vk = kernelHooks.varblock?.(vbLog2Table(), scaledDCTBases);
  if (!vk || planes?.length !== 3) return null;
  const W = stride * 8, H = rows * 8;
  if (planes.some(p => !(p instanceof Float64Array) || p.length < W * H)) return null;
  const byRow = Array.from({length: rows}, () => []);
  let multiAreaSum = 0;
  for (let i = 0; i < layout.length; i++) {
    const b = layout[i], t = TRANSFORMS[b.id];
    if (!t || VB_SMALL.has(b.id) || t.width > 32 || t.height > 32) return null;
    const area = (t.width >> 3) * (t.height >> 3);
    if (area > 1) multiAreaSum += area;
    byRow[b.by].push(b);
  }
  for (let by = 0; by < rows; by++) if (byRow[by].length > 1) byRow[by].sort((a, b) => a.bx - b.bx);
  const shared = typeof SharedArrayBuffer === 'function' && planes[0].buffer instanceof SharedArrayBuffer;
  const alloc = (T, n) => shared ? new T(new SharedArrayBuffer(n * T.BYTES_PER_ELEMENT)) : new T(n);
  let winTop = 0, winEnd = Math.min(H, 64), writeAt = 0, lowCursor = 0;
  const win = [0, 1, 2].map(c => { const buf = new Float64Array(64 * W); buf.set(planes[c].subarray(0, winEnd * W)); return buf; });
  const at = alloc(Uint32Array, stride * rows); at.fill(0xffffffff);
  const lowAt = multiAreaSum > 0 ? alloc(Uint32Array, stride * rows) : null;
  if (lowAt) lowAt.fill(0xffffffff);
  const lows = multiAreaSum > 0 ? alloc(Float64Array, multiAreaSum * 3) : null;
  for (let by = 0; by < rows; by++) {
    const rowBlocks = byRow[by];
    if (!rowBlocks.length) continue;
    const y = by * 8;
    if (Math.min(H, y + 32) > winEnd) {
      const keep = winEnd - y, nextEnd = Math.min(H, y + 64);
      for (let c = 0; c < 3; c++) {
        if (keep > 0) win[c].copyWithin(0, (y - winTop) * W, (winEnd - winTop) * W);
        win[c].set(planes[c].subarray(winEnd * W, nextEnd * W), keep * W);
      }
      winTop = y; winEnd = nextEnd;
    }
    for (let i = 0; i < rowBlocks.length; i++) {
      const {id, bx} = rowBlocks[i], t = TRANSFORMS[id], w = t.width, h = t.height, bw = w >> 3, bh = h >> 3, area = bw * bh, size = w * h;
      vk.block(win, winTop, bx * 8, y, W, w, h, 0, 2);
      for (let c = 0; c < 3; c++) {
        const tr = vk.coefficients(c, size);
        if (area > 1) lows.set(lowFrequenciesScratch(tr, bw, bh), lowCursor + c * area);
        planes[c].set(tr, writeAt);
      }
      const cell = by * stride + bx;
      at[cell] = writeAt;
      writeAt += size;
      if (area > 1) { lowAt[cell] = lowCursor; lowCursor += 3 * area; }
    }
  }
  return {planes, at, lows, lowAt};
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
  const rows = (by0, by1, compact = false) => {
    if (!byRow) { byRow = Array.from({length: base.components[0].rows}, () => []); for (let i = 0; i < layout.length; i++) byRow[layout[i].by].push(layout[i]); }
    for (const key of built.keys()) if (((key % 16777216) / stride | 0) < by0) built.delete(key);
    const entries = [];
    for (let by = by0; by < Math.min(by1, byRow.length); by++) entries.push(...byRow[by]);
    return fixedStrategyImage(base, width, height, {...options, layout: entries, built, ...(compact && {compactBy0: by0, compactBy1: by1})}).image;
  };
  return {width, height, components: base.components, layout, lazyStrategy: {rows, materialize: () => timed('materialize', () => fixedStrategyImage(base, width, height, {...options, layout}).image)}};
}
export const materialize = image => image?.lazyStrategy ? image.lazyStrategy.materialize() : image;

export {vbPackSigned, VB_SMALL, VB_CONFIG, VB_ZD, VB_NZ, VB_TOKENS, tableFor};
