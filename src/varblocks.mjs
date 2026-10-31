// SPDX-License-Identifier: MIT
import {exactExp, exactLog, exactLog2, exactPow} from './exact-math.mjs';
import {complete} from './bits.mjs';
import {photoXYBSteps} from './photo-xyb.mjs';
import {perceptualMaskField, maskDoubtOver} from './aq.mjs';
import {scaledDCT, scaledDCTAt, smallTransform, naturalOrder, lowFrequencies, TRANSFORMS, scaledDCTBases} from './vardct-strategies.mjs';
import {kernelHooks} from './kernel-hooks.mjs';
import {zeroDensityContext} from './vardct.mjs';
import {strategyAnsSteps} from './coefficient-ans.mjs';
import {prepareCoefficientOrders, COEFFICIENT_ORDER_BUCKETS} from './coefficient-orders.mjs';
import {prepareQuantParams, quantParamSteps} from './quantization-params.mjs';
import {ZIGZAG} from './jpeg-tables.mjs';
import {hybridToken, uintConfig} from './prefix.mjs';
import {populationBits} from './entropy.mjs';

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
    const {planes: rowsOf, top} = planeRows(by * 8, by * 8 + h, bx * 8, bx * 8 + w), p = new Float64Array(size);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) p[y * w + x] = rowsOf[c][(by * 8 + y - top) * W + bx * 8 + x];
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
function highOf(id, size) {
  let h = VB_HIGH.get(id);
  if (!h) { h = Uint8Array.from({length: size}, (_, pos) => { const [fx, fy] = freqOf(id, pos, 1); return fx >= 4 || fy >= 4 ? 1 : 0; }); VB_HIGH.set(id, h); }
  return h;
}
function stepAt(quant, id, pos, sizeScale, env) {
  const [fx, fy, scale] = freqOf(id, pos, sizeScale, env.smallScale);
  const x0 = Math.min(7, Math.floor(fx)), y0 = Math.min(7, Math.floor(fy)), x1 = Math.min(7, x0 + 1), y1 = Math.min(7, y0 + 1);
  const ax = fx - x0, ay = fy - y0, q = (y, x) => quant[y * 8 + x];
  const v = (q(y0, x0) * (1 - ax) + q(y0, x1) * ax) * (1 - ay) + (q(y1, x0) * (1 - ax) + q(y1, x1) * ax) * ay;
  return id === 0 ? Math.max(1, Math.round(v * scale)) : v * scale;
}

const searchTables = (base, options) => Object.assign(new Map(), {env: {field: base.quantFields ? base.quantFieldBase : 32,
  smallScale: options.smallScale ?? 1, activeBands: options.perceptual ? 8 : VB_BANDS}});
const VB_BANDS = 12;

function fitBands(target, L, S, env) {
  const B = env.activeBands, scale = (B - 1) / (1.4142135623730951 + .000001), A = new Float64Array(B * B), y = new Float64Array(B);
  for (let k = 1; k < L * S; k++) {
    const x = (k % L) / (L - 1), yy = Math.floor(k / L) / (S - 1), p = Math.sqrt(x * x + yy * yy) * scale;
    const i = Math.min(B - 2, Math.floor(p)), t = p - i, lw = exactLog(8 * 255 * VB_QS / (env.field * target[k]));
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
  const env = cache.env;
  if (cache.has(TRANSFORMS[id].table)) return cache.get(TRANSFORMS[id].table);
  const t = TRANSFORMS[id], w = t.width, h = t.height, L = Math.max(w, h), S = Math.min(w, h);
  const targets = components.map(comp => Float64Array.from({length: L * S}, (_, k) => stepAt(comp.quant, id, k, sizeScale, env)));
  const weight = step => 8 * 255 * VB_QS / (env.field * step);
  let table, input;
  if (id === 0) table = {w: L, h: S, planes: targets.map(p => Int32Array.from(p))};
  else if (id === 3) {
    const bands = targets.map(p => fitBands(Float64Array.from({length: 16}, (_, k) => p[2 * (k >> 2) * 8 + 2 * (k & 3)]), 4, 4, env));
    input = {mode: 'dct4', bands, multipliers: targets.map((p, c) => [bands[c][0] / weight(p[1]), bands[c][0] / weight(p[9])])};
  } else if (id === 12 || id === 13) {
    const bands = targets.map(p => fitBands(Float64Array.from({length: 32}, (_, k) => p[2 * (k >> 3) * 8 + (k & 7)]), 8, 4, env));
    input = {mode: 'dct4x8', bands, multipliers: targets.map((p, c) => bands[c][0] / weight(p[8]))};
  } else input = {mode: 'dct', bands: targets.map(p => fitBands(p, L, S, env))};
  if (input) {
    const parameters = prepareQuantParams(input, L, S, t.table);
    table = {w: L, h: S, parameters, planes: quantParamSteps(parameters, VB_QS, env.field, [0, 1, 2])};
  }
  cache.set(t.table, table);
  return table;
}

export function strategyInputs(base, width, height, options = {}) {
  const {sizeScale = 1, ids = [5, 10, 11, 4, 6, 7], deadzone, weights = [1, 1, 1]} = options;
  const comps = base.components, stride = comps[0].stride, rows = comps[0].rows;
  const yStep = comps[1].quant[1] / VB_QS, norm = [0, 1, 2].map(c => weights[c] * (yStep / (comps[c].quant[1] / VB_QS)) * (yStep / (comps[c].quant[1] / VB_QS)) / (yStep * yStep));
  const tables = searchTables(base, options), transforms = new Map();
  for (const id of [0, ...ids]) {
    if (VB_SMALL.has(id) || transforms.has(id)) continue;
    const t = TRANSFORMS[id], bw = t.width / 8, bh = t.height / 8, table = tableFor(id, comps, sizeScale, tables);
    transforms.set(id, {w: t.width, h: t.height, bw, bh, order: naturalOrder(bw, bh), high: highOf(id, t.width * t.height), steps: [0, 1, 2].map(c => table.planes[c])});
  }
  const fine = new Float32Array(stride * rows).fill(1);
  if (base.quantFields) for (let i = 0; i < fine.length; i++) fine[i] = base.quantFields[i] / base.quantFieldBase;
  return {stride, rows, planes: base.planes, transforms, tokens: options.model !== 'simple' ? rateModel(base, stride, rows, 8) : null,
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
export function forcedLayout(id, stride, rows) {
  const t = TRANSFORMS[id], bw = t.width / 8, bh = t.height / 8, layout = [], fits = (bx, by) => bx + bw <= stride && by + bh <= rows;
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

export function xybStrategies(base, width, height, options = {}) {
  const {lambda = 1, sizeScale = 1, ids = [5, 10, 11, 4, 6, 7], rate: rc = [4, 3, 2, 0.6], deadzone, weights = [1, 1, 1],
    detailWeight: detailW = 1.25, inhom = 0.08} = options;
  const comps = base.components, stride = comps[0].stride, rows = comps[0].rows, W = stride * 8, planes = base.planes;
  const transforms = options.transforms instanceof TransformCache ? options.transforms.forSource(planes, width, height, stride, rows) : null;
  const fineOf = (bx, by) => base.quantFields ? base.quantFields[by * stride + bx] / base.quantFieldBase : 1;
  const tables = searchTables(base, options), cfl = base.cfl, dead = deadzone;
  const yStep = comps[1].quant[1] / VB_QS, norm = [0, 1, 2].map(c => weights[c] * (yStep / (comps[c].quant[1] / VB_QS)) * (yStep / (comps[c].quant[1] / VB_QS)) / (yStep * yStep));
  tableFor(0, comps, sizeScale, tables);
  const allowed = new Set(ids);
  const tokens = !options.layout && options.model !== 'simple' && rateModel(base, stride, rows, 8);
  const tokenBits = (c, plane, order, area, size) => tokenBitsOf(tokens, c, plane, order, area, size);
  const candidateRate = (bx, by) => { const m = maps; maps = null; const r = full(0, bx, by).R; maps = m; return r; };
  const rates = options.rates;
  const costs = options.costs;
  const certifiedCosts = !!costs?.certified;
  if (options.perceptual && (options.maps || options.rates || costs && !(certifiedCosts && options.maskWeight)))
    throw new Error('The perceptual block search takes no maps or rates, and only certified costs with their mask.');
  let repricing = false;
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
  const lowScratch = new Map();
  const make = c => {
    let b;
    if (c.slot >= 0 && c.epoch === vk.epoch()) {
      const {id, bx, by, bw, bh, area, size} = c, order = naturalOrder(bw, bh), levels = new Int32Array(3 * (size + area)), coeffs = [], dc = [];
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
  const vk = !tokens && !options.maps && !rates && (!costs || certifiedCosts) && !transforms && !gpuBlocks && !options.exact && !built
    ? kernelHooks.varblock?.(vbLog2Table(), scaledDCTBases) : null, sums = new Float64Array(3);
  const kernelBlock = (id, bx, by, w, h, bw, bh, area, size, table, order, loses) => {
    const {planes: rowsOf, top} = planeRows(by * 8, by * 8 + h, bx * 8, bx * 8 + w), slot = vk.table(id, table, size, order, highOf(id, size));
    if (!slot) return null;
    if (loses) vk.block(rowsOf, top, bx * 8, by * 8, W, w, h, 1, 1);
    else vk.block(rowsOf, top, bx * 8, by * 8, W, w, h, 0, 2);
    const ti = (by >> 3) * cfl.width + (bx >> 3), fine = fineOf(bx, by), unit = 8 * VB_QS * fine;
    const levels = priceOnly ? null : new Int32Array(3 * (size + area)), coeffs = priceOnly ? null : [], dc = priceOnly ? null : [];
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
        vk.block(rowsOf, top, bx * 8, by * 8, W, w, h, 0, 0); vk.block(rowsOf, top, bx * 8, by * 8, W, w, h, 2, 2);
      }
      if (keep >= 0) {
        lows ||= new Float64Array(3 * area);
        const tr = vk.coefficients(c, size);
        if (area === 1) lows[c] = tr[0];
        else for (let y = 0; y < S; y++) for (let x = 0; x < L; x++) lows[c * area + y * L + x] = tr[y * L * 8 + x];
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
    const certified = options.exact?.get(id + ':' + bx + ':' + by);
    if (certified) {
      const table = tableFor(id, comps, sizeScale, tables);
      if (certified.uncertain) vbSettle(certified, id, bx, by, w, h, bw, bh, area, size, table, comps, planeRows, W, cfl, fineOf(bx, by), dead);
      return {id, bx, by, bw, bh, area, size, order: naturalOrder(bw, bh), coeffs: certified.coeffs, dc: certified.dc, R: 0, J: 0};
    }
    if (gpuBlocks?.has(id) && !maps) {
      tableFor(id, comps, sizeScale, tables);
      const {coeffs, dc} = gpuBlocks.get(id)(bx, by), R = costs.get(id).R[by * stride + bx];
      return {id, bx, by, bw, bh, area, size, order: naturalOrder(bw, bh), coeffs, dc, R, J: costs.get(id).D[by * stride + bx] + lambda * R};
    }
    const table = tableFor(id, comps, sizeScale, tables), order = naturalOrder(bw, bh);
    if (vk && !VB_SMALL.has(id)) {
      const block = kernelBlock(id, bx, by, w, h, bw, bh, area, size, table, order, loses);
      if (block) return block;
    }
    const cache = transforms, key = id * 16777216 + by * stride + bx;
    let transformed = cache?.get(key), transformChannel = null;
    if (!transformed) {
      const pixels = blockPixels.get(size) || blockPixels.set(size, new Float64Array(size)).get(size);
      const outputs = blockOutputs.get(size) || blockOutputs.set(size, [0, 1, 2].map(() => new Float64Array(size))).get(size);
      transformed = [];
      const {planes: rowsOf, top} = planeRows(by * 8, by * 8 + h, bx * 8, bx * 8 + w);
      transformChannel = c => {
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) pixels[y * w + x] = rowsOf[c][(by * 8 + y - top) * W + bx * 8 + x];
        transformed[c] = VB_SMALL.has(id) ? smallTransform(pixels, id, cache ? undefined : outputs[c]) : scaledDCT(pixels, w, h, cache ? undefined : outputs[c]);
      };
      const early = bounded && !!loses;
      for (let c = 0; c < 3; c++) if (!early || c === 1) transformChannel(c);
      cache?.set(key, transformed);
    }
    const ti = (by >> 3) * cfl.width + (bx >> 3), factor = [cfl.x[ti] / 84, 0, cfl.b[ti] / 84];
    const high = highOf(id, size);
    const coeffs = [], dc = [], fine = fineOf(bx, by), levels = priceOnly ? scratch.get(size) || scratch.set(size, new Int32Array(3 * size)).get(size) : new Int32Array(3 * (size + area));
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
      const pixel = VB_SMALL.has(id) ? pixelWeights(id) : null;
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
    const block = {id, bx, by, bw, bh, area, size, order, coeffs, dc, R, D, J: D + lambda * R, Je: doubtOf(bx, by, bw, bh) * D};
    built?.set(id * 16777216 + by * stride + bx, block);
    return block;
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
  const exactCells = options.exactCells, open = [], reprices = [];
  let reverted = 0, settled = 0;
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
    if ((doubt || rateDoubt) && Number.isFinite(a.J) && Number.isFinite(b.J) && (a.me || b.me || a.re || b.re || totalDoubt || rateTotalDoubt)) {
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
  const fits = (id, bx, by) => bx + TRANSFORMS[id].width / 8 <= stride && by + TRANSFORMS[id].height / 8 <= rows;
  const force = options.force;
  const best8 = (bx, by) => {
    if (force !== undefined) return candidate(VB_SMALL.has(force) ? force : 0, bx, by);
    let best = candidate(0, bx, by);
    for (const id of [3, 12, 13]) if (allowed.has(id)) { const c = candidate(id, bx, by); if (beats(c, best)) best = c; }
    return best;
  };
  const largerFirst = bounded && !useMask && force === undefined && lambda >= 0 && [...allowed].every(id => id === 4 || id === 5);
  if (largerFirst) for (const id of [4, 5]) if (allowed.has(id)) tableFor(id, comps, sizeScale, tables);
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
  if (options.priceAll) {
    const out = Object.assign(new Map(), {certified: true});
    const wanted = options.cells && new Set(options.cells.flatMap(({bx, by}) => Array.from({length: 16}, (_, i) => (by + (i >> 2)) * stride + bx + (i & 3))));
    for (const id of new Set([0, ...ids])) {
      const t = TRANSFORMS[id], D = new Float64Array(stride * rows).fill(NaN), R = new Float64Array(stride * rows).fill(NaN);
      const bw = t.width / 8, bh = t.height / 8;
      for (let by = 0; by < rows; by++) for (let bx = 0; bx < stride; bx++) if (fits(id, bx, by) && (!wanted || wanted.has(by * stride + bx) && bx % bw === 0 && by % bh === 0)) {
        const c = full(id, bx, by);
        D[by * stride + bx] = c.D; R[by * stride + bx] = c.R;
      }
      out.set(id, {D, R, w: t.width / 8, h: t.height / 8});
    }
    return out;
  }
  const chosen = [];
  if (options.layout) for (const {id, bx, by} of options.layout) chosen.push(candidate(id, bx, by));
  else {
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
    const big = [18, 19, 20].some(allow64);
    const region = big ? 8 : 4;
    for (let cy = 0; cy < rows; cy += region) for (let cx = 0; cx < stride; cx += region) {
      opened = false;
      if (keepChosen && vk) vk.region();
      let list = (big ? best64(cx, cy) : best32(cx, cy)).list;
      if (opened && certifiedCosts) {
        opened = false; repricing = true;
        if (keepChosen && vk) vk.region();
        list = (big ? best64(cx, cy) : best32(cx, cy)).list;
        repricing = false; reprices.push({bx: cx, by: cy, size: region});
      }
      chosen.push(...(keepChosen ? list.map(c => c.light ? make(c) : c) : list));
      if (opened) open.push({bx: cx, by: cy, size: region});
    }
    if (useMask) {
      for (const fam of [5, 4, 6]) {
        let count = 0;
        for (const b of chosen) if (TRANSFORMS[b.id].table === fam) count++;
        if (count > 0 && count < 8) {
          reverted += count;
          for (let i = chosen.length - 1; i >= 0; i--) {
            if (TRANSFORMS[chosen[i].id].table === fam && chosen[i].fallback) {
              chosen.splice(i, 1, ...chosen[i].fallback);
            }
          }
        }
      }
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
  if (options.chooseOnly) return {layout: chosen.map(({id, bx, by}) => ({id, bx, by})), open, reprices, reverted, settled};
  priceOnly = false;
  for (let i = 0; i < chosen.length; i++) if (chosen[i].light) chosen[i] = full(chosen[i].id, chosen[i].bx, chosen[i].by);
  const at = new Int32Array(stride * rows).fill(-1), byFirst = new Map();
  const components = comps.map(comp => ({h: 1, v: 1, stride, rows, quant: comp.quant, coeffs: new Int16Array(0), dc: new Int32Array(stride * rows)}));
  let wideCoefficients = false;
  for (const choice of chosen) {
    const {id, bx, by, bw, bh, area, size, order, coeffs, dc, levels} = choice, block = {id, bx, by, bw, bh, area, size, order, coeffs, dc, levels};
    byFirst.set(block.by * stride + block.bx, block);
    for (let y = 0; y < block.bh; y++) for (let x = 0; x < block.bw; x++) {
      const pos = (block.by + y) * stride + block.bx + x;
      at[pos] = -2;
      for (let c = 0; c < 3; c++) components[c].dc[pos] = block.dc[c][y * block.bw + x];
    }
    if (!wideCoefficients && !choice.narrow) for (const plane of block.coeffs) for (let k = 0; k < plane.length; k++) if (plane[k] < -32768 || plane[k] > 32767) { wideCoefficients = true; break; }
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
  const {planes: _p, values: _v, planeRows: _r, ...rest} = base;
  return {image: {...rest, components, wideCoefficients, ...(options.perceptual ? {perceptual: true} : {}), strategyData: {groups, blocks, at, tables, stride}}, counts,
    layout: blocks.map(({id, bx, by}) => ({id, bx, by})), open, reprices, reverted, settled};
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
    for (let at = 0; at < mine.D.length; at++) {
      if (Number.isNaN(mine.D[at])) continue;
      if (theirs.De?.[at] === Infinity) continue;
      if (theirs.De && !(theirs.De[at] >= 0 && Number.isFinite(theirs.De[at]) && theirs.Re?.[at] >= 0 && Number.isFinite(theirs.D[at]) && Number.isFinite(theirs.R[at]))) return Infinity;
      const ratio = (d, bound) => d === 0 ? 0 : d / (bound || 0);
      const bound = (theirs.De?.[at] ?? 0) - maskDoubtOver(priced.weightDoubt || 0, stride, at % stride, Math.floor(at / stride), mine.w, mine.h) * Math.abs(theirs.D[at]);
      worst = Math.max(worst, ratio(Math.abs(mine.D[at] - theirs.D[at]), bound), ratio(Math.abs(mine.R[at] - theirs.R[at]), theirs.Re?.[at]));
    }
  }
  return worst;
}

export function lazyStrategyImage(base, width, height, options, layout) {
  const stride = base.components[0].stride, built = new Map();
  let byRow = null;
  const rows = (by0, by1) => {
    if (!byRow) { byRow = Array.from({length: base.components[0].rows}, () => []); for (const entry of layout) byRow[entry.by].push(entry); }
    for (const key of built.keys()) if (((key % 16777216) / stride | 0) < by0) built.delete(key);
    const entries = [];
    for (let by = by0; by < Math.min(by1, byRow.length); by++) entries.push(...byRow[by]);
    return xybStrategies(base, width, height, {...options, layout: entries, built}).image;
  };
  return {width, height, components: base.components, layout, lazyStrategy: {rows, materialize: () => xybStrategies(base, width, height, {...options, layout}).image}};
}
export const materialize = image => image?.lazyStrategy ? image.lazyStrategy.materialize() : image;

const ORDER_BUCKET = TRANSFORMS.map(t => COEFFICIENT_ORDER_BUCKETS.find(b => b.strategies.includes(t.name)));
export function learnedOrders(image) {
  const byBucket = new Array(COEFFICIENT_ORDER_BUCKETS.length);
  for (const block of image.strategyData.blocks) {
    const bucket = ORDER_BUCKET[block.id];
    if (!bucket || bucket.id === 1) continue;
    let c3 = byBucket[bucket.id];
    if (!c3) byBucket[bucket.id] = c3 = [new Uint32Array(block.size), new Uint32Array(block.size), new Uint32Array(block.size)];
    const {area, size, order, coeffs} = block;
    for (let c = 0; c < 3; c++) {
      const plane = coeffs[c], n = c3[c];
      for (let k = area; k < size; k++) if (plane[order[k]]) n[k]++;
    }
  }
  const value = {};
  for (let id = 0; id < byBucket.length; id++) {
    const c3 = byBucket[id];
    if (!c3) continue;
    const bucket = COEFFICIENT_ORDER_BUCKETS[id], skip = bucket.lowFrequencyCount, size = c3[0].length;
    value[bucket.name] = c3.map(n => {
      const rest = Array.from({length: size - skip}, (_, i) => i + skip).sort((a, b) => (n[b] >>> 2) - (n[a] >>> 2) || a - b);
      return [...Array.from({length: skip}, (_, i) => i), ...rest];
    });
  }
  return prepareCoefficientOrders(value, 1);
}

export function encodeStrategyImage(image, orders = true, effort = 7) {
  return complete(encodeStrategyImageSteps(image, orders, effort));
}
export function optimalLearnedOrders(image) {
  const byBucket = new Map();
  for (const block of image.strategyData.blocks) {
    const bucket = ORDER_BUCKET[block.id];
    if (!bucket || bucket.name === 'small') continue;
    let entry = byBucket.get(bucket.name);
    if (!entry) byBucket.set(bucket.name, entry = {bucket, blocks: [], counts: [0, 1, 2].map(() => new Float64Array(block.size))});
    entry.blocks.push(block);
    const {area, size, order} = block;
    for (let c = 0; c < 3; c++) {
      const plane = block.coeffs[c], n = entry.counts[c];
      for (let k = area; k < size; k++) if (plane[order[k]]) n[k]++;
    }
  }
  const priceChannelTokens = (blocks, c, rankPerm) => {
    const nat = blocks[0].order;
    const scan = rankPerm ? Uint32Array.from(rankPerm, r => nat[r]) : nat;
    const freq = new Uint32Array(VB_ZD * VB_TOKENS);
    let extraBits = 0;
    for (const block of blocks) {
      const {area, size} = block, coeffs = block.coeffs[c];
      let count = 0;
      for (let k = area; k < size; k++) if (coeffs[scan[k]]) count++;
      let prev = count > size / 16 ? 0 : 1, left = count;
      for (let k = area; k < size && left; k++) {
        const q = coeffs[scan[k]], [t, eb] = token(vbPackSigned(q));
        freq[zeroDensityContext(Math.ceil(left / area), Math.floor(k / area), prev) * VB_TOKENS + t]++;
        extraBits += eb;
        prev = q ? 1 : 0; left -= prev;
      }
    }
    let bits = extraBits;
    for (let ctx = 0; ctx < VB_ZD; ctx++) {
      const base = ctx * VB_TOKENS;
      let tot = 0, b = 0;
      for (let t = 0; t < VB_TOKENS; t++) { const f = freq[base + t]; if (f) { tot += f; b -= populationBits(f); } }
      if (tot > 1) bits += b + populationBits(tot);
    }
    return bits;
  };
  const value = {};
  for (const [name, {bucket, blocks, counts}] of byBucket) {
    const skip = bucket.lowFrequencyCount, size = bucket.width * bucket.height;
    const baseBits = [0, 1, 2].map(c => priceChannelTokens(blocks, c, null));
    const bestPerms = [null, null, null], bestGain = [0, 0, 0];
    for (let c = 0; c < 3; c++) {
      const n = counts[c];
      for (const div of [1, 2, 4, 8, 16]) {
        const rest = Array.from({length: size - skip}, (_, i) => i + skip).sort((a, b) => Math.floor(n[b] / div) - Math.floor(n[a] / div) || a - b);
        if (!rest.some((r, i) => r !== i + skip)) continue;
        const perm = [...Array.from({length: skip}, (_, i) => i), ...rest];
        const testObj = {[name]: [c === 0 ? perm : null, c === 1 ? perm : null, c === 2 ? perm : null]};
        const hBits = prepareCoefficientOrders(testObj, 1)[0].header.bitLength - 4;
        const tBits = priceChannelTokens(blocks, c, perm);
        const gain = baseBits[c] - (tBits + hBits * 0.85);
        if (gain > bestGain[c]) { bestGain[c] = gain; bestPerms[c] = perm; }
      }
    }
    if (bestPerms.some(Boolean)) {
      const combined = {[name]: bestPerms};
      const totalH = prepareCoefficientOrders(combined, 1)[0].header.bitLength - 4;
      const rawGain = [0, 1, 2].reduce((s, c) => s + (bestPerms[c] ? baseBits[c] - priceChannelTokens(blocks, c, bestPerms[c]) : 0), 0);
      if (rawGain > totalH) value[name] = bestPerms;
    }
  }
  return Object.keys(value).length ? prepareCoefficientOrders(value, 1) : null;
}

export function encodeStrategyImageSteps(image, orders = true, effort = 7, pooled = false, primed = null, both = true) {
  if (!orders) return strategyAnsSteps(image, effort, null, pooled, primed, both);
  const std = learnedOrders(image);
  if (effort < 8) return strategyAnsSteps(image, effort, std, pooled, primed, both);
  return strategyAnsSteps(image, effort, [std, optimalLearnedOrders(image)].filter(Boolean), pooled, primed, both);
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
export function sameDct8Image(plain, strategy, part = false) {
  if (strategy?.lazyStrategy) {
    if (!plain || plain.strategyData || plain.width !== strategy.width || plain.height !== strategy.height) return false;
    const rows = plain.components[0].rows, stride = plain.components[0].stride;
    if (strategy.layout.length !== stride * rows || strategy.layout.some(entry => entry.id !== 0)) return false;
    for (let by = 0; by < rows; by += 64) if (!sameDct8Image(plain, strategy.lazyStrategy.rows(by, by + 64), true)) return false;
    return true;
  }
  if (!plain || plain.strategyData || !strategy.strategyData || plain.width !== strategy.width || plain.height !== strategy.height) return false;
  const same = (a, b) => Object.is(a, b) || !!a && !!b && a.length === b.length && typeof a.every === 'function'
    && a.every((v, i) => Array.isArray(v) || ArrayBuffer.isView(v) ? same(v, b[i]) : Object.is(v, b[i]));
  for (const key of ['quantScale', 'epf', 'quantFieldBase', 'epfIterations']) if (!Object.is(plain[key], strategy[key])) return false;
  for (const key of ['gab', 'quantFields', 'sharpness']) if (!same(plain[key], strategy[key])) return false;
  if (plain.cfl.width !== strategy.cfl.width || !same(plain.cfl.x, strategy.cfl.x) || !same(plain.cfl.b, strategy.cfl.b)) return false;
  const table = strategy.strategyData.tables.get(0)?.planes;
  if (!table || !part && strategy.strategyData.blocks.length !== plain.components[0].stride * plain.components[0].rows) return false;
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
  const lazy = !costs && !!base.planeRows, {p: _p, initial: _initial, ...build} = options;
  for (const id of [0, ...ids]) {
    let forced = {...options, force: id, maps: null, rates, ...(costs ? {costs} : {})};
    if (costs?.has(id)) {
      const certified = yield {varblocks: {kind: 'exact', layout: xybStrategies(base, width, height, {...forced, chooseOnly: true}).layout}};
      if (certified) forced = {...forced, exact: certified};
    }
    const image = lazy ? lazyStrategyImage(base, width, height, build, xybStrategies(base, width, height, {...forced, chooseOnly: true, priceOnly: true}).layout)
      : xybStrategies(base, width, height, forced).image;
    const initial = id === 0 && p === 3 && options.initial?.scores.cells && !options.initial.scores.doubt?.cells
      && sameDct8Image(options.initial.image, image) ? options.initial.scores : null;
    const reply = initial || (yield {measure: image, want: {p}});
    maps[id] = initial ? Float64Array.from(reply.cells) : reply.cells; mapDoubt = Math.max(mapDoubt, reply.doubt?.cells ?? 0);
  }
  if (lazy && !mapDoubt) {
    const {layout} = xybStrategies(base, width, height, {...options, maps, rates, chooseOnly: true});
    return {layout, image: lazyStrategyImage(base, width, height, build, layout)};
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
