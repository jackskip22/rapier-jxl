// SPDX-License-Identifier: MIT
import {QUANT_SHAPE, FAST_SCALE, dct8Basis, bandCoefficients} from './photo-dct.mjs';
import {kernelHooks, ensured, missing} from './kernel-hooks.mjs';
import {fault} from './fault.mjs';
import {quantFieldValue, fitRawSteps} from './vardct-planes.mjs';
import {calibration} from './quality-calibration.mjs';
import {bandScratch} from './band-scratch.mjs';
export {preferXYB} from './photo-preference.mjs';

const BIAS = 0.0037930732552754493;
function seedRoot(v) {
  let root = Math.sqrt(Math.sqrt(v));
  for (let i = 0; i < 7; i++) root = (2 * root + v / (root * root)) / 3;
  return root;
}
const ROOT_BIAS = /* @__PURE__ */ seedRoot(BIAS);
const ROOTS = /* @__PURE__ */ Float64Array.from({length: 4113}, (_, i) => i ? seedRoot(i / 4096) : 0);

export const FAST_RANGE = /* @__PURE__ */ new Error('fast level overflow');

const LINEAR = /* @__PURE__ */ Float64Array.from({length: 256}, (_, i) => {
  const v = i / 255;
  if (i <= 10) return v / 12.92;
  const base = (v + 0.055) / 1.055, square = base * base;
  let fifth = Math.sqrt(Math.sqrt(square));
  for (let n = 0; n < 12; n++) fifth = (4 * fifth + square / (fifth * fifth * fifth * fifth)) / 5;
  return square * fifth;
});

const GAB_DEFAULT = [0.115169525, 0.061248592];
function gaborishInverse(planes, W, H, {weights, strength = 1, iterations = 4, adapt = 0, floor = 0.3, boost = 1}, scratch = null) {
  const bw = W / 8, scale = adapt && new Float64Array((W / 8) * (H / 8)).fill(1);
  if (adapt) {
    const Y = planes[1], tex = new Float64Array(scale.length);
    for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
      const i = y * W + x;
      tex[(y >> 3) * bw + (x >> 3)] += Math.abs(4 * Y[i] - Y[i - 1] - Y[i + 1] - Y[i - W] - Y[i + W]);
    }
    const median = Float64Array.from(tex).sort()[tex.length >> 1] || 1;
    for (let b = 0; b < tex.length; b++) scale[b] = Math.max(floor, Math.min(1, 1 - adapt * Math.log2(Math.max(1, tex[b] / median))));
  }
  if (scratch && scratch.original.length < planes[0].length) throw fault('JXL_INTERNAL', 'photo-xyb:workspace');
  const orig = scratch ? scratch.original.subarray(0, planes[0].length) : bandScratch(Float64Array, 'gaborish-orig', planes[0].length);
  for (let c = 0; c < planes.length; c++) {
    const t = planes[c], w = weights?.[c] ?? GAB_DEFAULT, s = Array.isArray(strength) ? strength[c] : strength, n = t.length;
    orig.set(t);
    if (!(kernelHooks.gaborish ?? ensured().gaborish ?? missing())(t, orig, W, H, w, iterations, orig, boost))
      throw fault('JXL_PLATFORM', 'gaborish: declined');
    if (adapt) for (let k = 0; k < n; k++) t[k] = orig[k] + s * scale[((k / W) >> 3) * bw + ((k % W) >> 3)] * (t[k] - orig[k]);
    else if (s !== 1) for (let k = 0; k < n; k++) t[k] = orig[k] + s * (t[k] - orig[k]);
  }
  return planes;
}

const SRGB_MIX = /* @__PURE__ */ Float64Array.of(0.3, 0.622, 0.078, 0.23, 0.692, 0.078, 0.24342268924547819, 0.20476744424496821, 0.5518098665095536);
const SRGB_LINEAR3 = /* @__PURE__ */ [LINEAR, LINEAR, LINEAR];
export const XYB_TABLES = /* @__PURE__ */ Object.freeze({linear: LINEAR, mix: SRGB_MIX, bias: BIAS, rootBias: ROOT_BIAS});

const kernelColor = (T, samples = null) => samples ? {linear: samples.curve, mix: samples.mix}
  : !T ? {linear: SRGB_LINEAR3, mix: SRGB_MIX}
  : {linear: T.tables, mix: T.lms};

function inTable(T) {
  let lo = Infinity, hi = -Infinity;
  for (const v of T.tables[0]) { if (v < lo) lo = v; if (v > hi) hi = v; }
  for (let r = 0; r < 9; r += 3) for (const t of [lo, hi]) {
    const v = T.lms[r] * t + T.lms[r + 1] * t + T.lms[r + 2] * t + BIAS;
    if (!(v >= 0 && Math.floor(v * 4096) <= 4111)) return false;
  }
  return true;
}
const isSigned = (T, samples = null) => samples ? true : T ? !(T.tables[0] === T.tables[1] && T.tables[1] === T.tables[2] && T.lms.every(v => v >= 0) && inTable(T)) : false;

function xybPlanes(data, width, height, T, W, H, into = null, samples = null) {
  const planes = into === false ? null : into ? into.map(p => p.subarray(0, W * H)) : [0, 1, 2].map(() => new Float64Array(W * H));
  const color = kernelColor(T, samples), signed = isSigned(T, samples);
  const run = kernelHooks.xybPlanes ?? ensured().xybPlanes ?? missing();
  if (!run(data, width, height, W, H, planes, ROOTS, color.linear, color.mix, BIAS, ROOT_BIAS, null, signed, samples))
    throw fault('JXL_PLATFORM', 'xybPlanes: declined');
  if (planes) for (const p of planes) for (let y = height; y < H; y++) p.copyWithin(y * W, (height - 1) * W, height * W);
  return planes;
}

export function xybScanReading(data, width, height, samples) {
  xybPlanes(data, width, height, null, Math.ceil(width / 8) * 8, height, false, samples);
  return samples.reading;
}

export const gaborishXYB = (planes, W, H, gaborish) => gaborishInverse(planes, W, H, gaborish);

export function gaborishPlanes(data, width, height, options, into = null, scratch = null) {
  const W = Math.ceil(width / 8) * 8, H = Math.ceil(height / 8) * 8;
  const g = options.gaborish, s = g?.strength ?? 1, T = options.transform, samples = options.samples ?? null;
  const color = kernelColor(T, samples), signed = isSigned(T, samples);
  if (height > 1 && g && !g.adapt && (Array.isArray(s) ? s.every(v => v === 1) : s === 1)) {
    const planes = into ? into.map(p => p.subarray(0, W * H)) : [0, 1, 2].map(() => new Float64Array(W * H));
    const gab = {weights: [0, 1, 2].map(c => g.weights?.[c] ?? GAB_DEFAULT), iterations: g.iterations ?? 4, boost: g.boost ?? 1};
    const run = kernelHooks.xybPlanes ?? ensured().xybPlanes ?? missing();
    if (run(data, width, height, W, H, planes, ROOTS, color.linear, color.mix, BIAS, ROOT_BIAS, gab, signed, samples)) return planes;
    throw fault('JXL_PLATFORM', 'xybPlanes: declined');
  }
  const planes = xybPlanes(data, width, height, T, W, H, into, samples);
  return height === 1 || !g ? planes : gaborishInverse(planes, W, H, g, scratch);
}

const FAST_SCALE32 = /* @__PURE__ */ Float32Array.from(FAST_SCALE);
const FAST_V6_TABLES = new Map();
const GAB_TABLES = new Map();
const IDENTITY_GAB = {weights: [[0, 0], [0, 0], [0, 0]], iterations: 1};

function gabTables(q, distance, {tune, deadzone, dcScale, gaborish}, make) {
  const entry = GAB_TABLES.get(q);
  if (entry && entry.distance === distance && entry.tune === tune && entry.deadzone === deadzone && entry.dcScale === dcScale && entry.gaborish === gaborish) return entry;
  const made = {distance, tune, deadzone, dcScale, gaborish, ...make()};
  GAB_TABLES.clear();
  GAB_TABLES.set(q, made);
  return made;
}

function fastV6Tables(q, distance, strength, stepScale, acScale, quantScale, options) {
  const key = options.smallFloor ? -q : q;
  let entry = FAST_V6_TABLES.get(key);
  if (entry) return entry;
  const tune = options.tune, dcScale = options.dcScale, dead = options.deadzone;
  const quants = fitRawSteps([0, 1, 2].map(c => Int32Array.from(QUANT_SHAPE, (shape, k) => Math.max(1, Math.round(quantScale * distance * stepScale *
    (k ? acScale * [0.84, 7, 5.6][c] * shape * (1 + [1, 0, 5][c] * Math.sqrt(((k & 7) * (k & 7) + (k >> 3) * (k >> 3)) / 98)) * tune(c, k, q) : [1.05, 7, 12.6][c] * 0.25 * dcScale[c]))))));
  const fastScale = quants.map(quant => Float64Array.from(quant, v => quantScale / v));
  const thresholds = [0, 1, 2].map(c => Float64Array.from({length: 64}, (_, k) => {
    const high = (k & 7) >= 4 || (k >> 3) >= 4;
    return k ? dead[c * 2 + (high ? 1 : 0)] : 0.5;
  }));
  const tileKernel = {
    roots: ROOTS, linear: SRGB_LINEAR3, mix: SRGB_MIX, signed: false, strict: false, scale: FAST_SCALE, bias: BIAS, rootBias: ROOT_BIAS, steps: fastScale,
    limits: [0, 1, 2].map(c => Float64Array.from({length: 64}, (_, k) => (k & 7) >= 4 || k >= 32 ? dead[c * 2 + 1] : dead[c * 2])),
  };
  entry = {quants, fastScale, thresholds, tileKernel, tune, dc0: dcScale[0], dc1: dcScale[1], dc2: dcScale[2], dead};
  FAST_V6_TABLES.clear();
  FAST_V6_TABLES.set(key, entry);
  return entry;
}

export function* photoXYBSteps(data, width, height, quality, options) {
  const fast = !!options?.fast;
  if (fast && options?.fieldScale) throw fault('JXL_INTERNAL', 'photo-xyb:field');
  if (options?.roundtrip || options?.biasedRound || options?.keepValues) throw fault('JXL_PLATFORM', 'photo-xyb:unsupported-flags');
  const fastBand = fast && !!options?.fastBand;
  if (!fastBand && options?.gaborish && (options.band ? options.band.data.length / 4 / width : height) === 1)
    options = {...options, gaborish: null, pre: data.length === width * height * 4 ? undefined : options.pre, dctCache: null, band: undefined};
  const samples = options?.samples ?? null;
  const gab = fast ? fastBand ? IDENTITY_GAB : null : options?.gaborish;
  const T = options?.transform;
  const fastGab = !!(gab && !samples && !(T && !fastBand) && (options.fastGaborish || fastBand));
  const band = gab && !options?.pre ? options?.band ?? (fastGab || samples ? {data, top: 0} : null) : null;
  const runGabBand = kernelHooks.gabBand ?? ensured().gabBand ?? missing();
  const color = kernelColor(T, samples), signed = isSigned(T, samples);
  const kernelBand = !!(band && (!T || !fastGab) && !options?.keepPlanes && !options?.noLevels && !options?.planesOnly &&
    (gab.strength ?? 1) === 1 && !gab.adapt && (fastGab || (gab.boost ?? 1) === 1));
  if (band?.only && !kernelBand) return null;

  const stride = Math.ceil(width / 8), rows = Math.ceil(height / 8), quantScale = 256;
  if (!(typeof __RAPIER_JXL_UPLOAD__ !== 'undefined' && __RAPIER_JXL_UPLOAD__ === true) && options?.planesOnly)
    return {planes: xybPlanes(data, width, height, T, stride * 8, rows * 8, null, samples)};

  let pre = null;
  if (!(typeof __RAPIER_JXL_UPLOAD__ !== 'undefined' && __RAPIER_JXL_UPLOAD__ === true)) {
    if (options?.pre && !kernelBand && !fastGab) pre = options.pre;
    else if (gab && !kernelBand && !fastGab) {
      const W = stride * 8, H = rows * 8;
      pre = band ? gaborishPlanes(band.data, width, band.data.length / 4 / width, options).map(p => p.subarray(band.top * W, (band.top + H) * W))
        : gaborishPlanes(data, width, height, options);
    }
  }

  const q = Math.min(quality, 99.9);
  const distance = Math.max(0.0248, calibration(q, options?.calibrationRow ?? fast) * (q >= 99 ? 0.19 - 0.16 * (q - 99) : q >= 30 ? 0.1 + (100 - q) * 0.09 : 53 / 3000 * q * q - 23 / 20 * q + 25));
  const strength = Math.max(0, Math.min(1, (90 - q) / 15)), stepScale = 1 - 0.1 * strength, acScale = 1.175 + 0.075 * strength;
  const t = options?.tune, tune = typeof t === "function" ? t : t ? (c, k) => t[c] * (1 + t[3 + c] * Math.sqrt(((k & 7) * (k & 7) + (k >> 3) * (k >> 3)) / 98)) : () => 1;
  const d = options?.dcScale, dcBase = typeof d === 'function' ? c => d(c, distance) : Array.isArray(d) ? c => d[c] : () => d ?? 1;
  const ramp = options?.dcRamp && q < 70 ? Math.min(1, (70 - q) / 20) : 0;
  const dcScale = ramp ? c => dcBase(c) + ramp * (options.dcRamp[c] - dcBase(c)) : dcBase;
  const gabTilt = (c, k) => {
    if (!options?.gaborish?.tilt) return 1;
    const [w1, w2] = options.gaborish.weights?.[c] ?? GAB_DEFAULT, a = Math.cos(Math.PI * (k & 7) / 8), b = Math.cos(Math.PI * (k >> 3) / 8);
    return Math.pow((1 + 4 * w1 + 4 * w2) / (1 + 2 * w1 * (a + b) + 4 * w2 * a * b), options.gaborish.tilt);
  };
  const low = options?.lowScale;
  const cachedFast = fast && !ramp && !pre && !T && !samples && !low && !options?.gaborish?.tilt && typeof t === "function" && Array.isArray(d) && Array.isArray(options?.deadzone) && !options?.calibrationRow
    ? fastV6Tables(q, distance, strength, stepScale, acScale, quantScale, options) : null;
  const useCachedFast = cachedFast && cachedFast.tune === t && cachedFast.dead === options.deadzone && cachedFast.dc0 === d[0] && cachedFast.dc1 === d[1] && cachedFast.dc2 === d[2] ? cachedFast : null;
  const quantOf = c => Int32Array.from(QUANT_SHAPE, (shape, k) => Math.max(1, Math.round(quantScale * distance * stepScale *
    (k ? acScale * [0.84, 7, 5.6][c] * shape * (1 + [1, 0, 5][c] * Math.sqrt(((k & 7) * (k & 7) + (k >> 3) * (k >> 3)) / 98)) * tune(c, k, q) * gabTilt(c, k) * (low ? low[c * 64 + k] : 1) : [1.05, 7, 12.6][c] * 0.25 * dcScale(c)))));
  const dead = options?.deadzone;
  const thresholdOf = c => Float64Array.from({length: 64}, (_, k) => {
    const high = (k & 7) >= 4 || (k >> 3) >= 4;
    return dead && k ? dead[c * 2 + (high ? 1 : 0)] : k && c === 1 ? 0.5 + strength * (high ? 0.14 : 0.08) : 0.5;
  });
  const gabCached = fastGab && !fastBand && !T && !samples && !low && typeof t === 'function' && Array.isArray(d) && Array.isArray(dead)
    ? gabTables(q, distance, options, () => {
      const quants = fitRawSteps([0, 1, 2].map(quantOf)), thresholds = [0, 1, 2].map(thresholdOf);
      return {quants, thresholds, steps32: quants.map(quant => Float32Array.from(quant, v => quantScale / v)), thresholds32: thresholds.map(th => Float32Array.from(th))};
    }) : null;
  const packBand = !!(options.packed && (fastGab || (kernelBand && (data instanceof Uint8Array || data instanceof Uint8ClampedArray))));
  const own = gabCached || useCachedFast ? null : fitRawSteps([0, 1, 2].map(quantOf));
  const components = [0, 1, 2].map(c => ({h: 1, v: 1, stride, rows,
    quant: gabCached ? gabCached.quants[c] : useCachedFast ? useCachedFast.quants[c] : own[c],
    coeffs: packBand ? null : bandCoefficients(options, c, stride * rows * 64)}));
  const fastScale = fast && (useCachedFast ? useCachedFast.fastScale : components.map(c => Float64Array.from(c.quant, qv => quantScale / qv)));
  const THRESHOLDS = gabCached ? gabCached.thresholds : useCachedFast ? useCachedFast.thresholds : [0, 1, 2].map(thresholdOf);
  const tileWidth = Math.ceil(stride / 8), tileRows = Math.ceil(rows / 8);
  const cfl = {width: tileWidth, x: new Int8Array(tileWidth * tileRows), b: new Int8Array(tileWidth * tileRows)};
  const fieldScale = options?.fieldScale, FIELD = 64, quantFields = fieldScale && new Int32Array(stride * rows);
  if (quantFields) for (let i = 0; i < quantFields.length; i++) quantFields[i] = quantFieldValue(FIELD * fieldScale[i]);
  const cflScale = options?.cflScale ?? 1, cflPair = [0, 0];

  let planes = options?.keepPlanes ? pre : null;
  let nonZero = null, packedOpacity;

  if (fastGab) {
    const counts = [0, 1, 2].map(() => new Uint8Array(stride * rows)), total = band.data.length / 4 / width;
    const packed = options.packed ? {natural: new Uint32Array(192), opaque: true, channels: counts.map(c => ({at: new Uint8Array(stride * rows * 4), levels: new Int16Array(stride * rows * 4),
      total: 0, starts: null, dc: new Int16Array(stride * rows), counts: c}))} : null;
    const job = {linear: LINEAR, mix: SRGB_MIX, bias: BIAS, rootBias: ROOT_BIAS, weights: [0, 1, 2].map(c => gab.weights?.[c] ?? GAB_DEFAULT),
      iterations: gab.iterations ?? 4, boost: gab.boost ?? 1, fast: true, scale: FAST_SCALE32, steps: gabCached ? gabCached.steps32 : components.map(c => Float32Array.from(c.quant, qv => quantScale / qv)),
      thresholds: gabCached ? gabCached.thresholds32 : THRESHOLDS.map(th => Float32Array.from(th)), c84: cflScale * 84, components, cfl, nonZero: counts, packed};
    if (!kernelBand || !runGabBand(band.data, width, total, band.top, height, job)) {
      if (band.only) return null;
      throw fault('JXL_PLATFORM', 'gabBand: declined');
    }
    if (packed) {
      packedOpacity = packed.opaque;
      components.forEach((component, c) => {
        const {at, levels, total: n, starts, groupStarts, dc} = packed.channels[c];
        component.packed = {at: at.slice(0, n), levels: levels.slice(0, n), counts: counts[c], starts, groupStarts, segment: packed.segment, dc,
          natural: packed.natural.subarray(c * 64, c * 64 + 64), length: stride * rows * 64};
      });
    }
    nonZero = counts;
    yield 1;
  } else if (fast) {
    if (options?.keepPlanes) planes ??= xybPlanes(data, width, height, T, stride * 8, rows * 8, null, samples);
    const runTile = kernelHooks.photoTile ?? ensured().photoTile ?? missing();
    const tileKernel = !T && !samples && useCachedFast ? useCachedFast.tileKernel : {
      roots: ROOTS, linear: color.linear, mix: color.mix, signed: !!(T || samples), strict: !!(T || samples), scale: FAST_SCALE, bias: BIAS, rootBias: ROOT_BIAS, steps: fastScale,
      limits: THRESHOLDS, samples,
    };
    const counts = [0, 1, 2].map(() => new Uint8Array(stride * rows));
    let tileIndex = 0;
    const onTileCfl = (xy, yy, bySum) => {
      const fx = Math.max(-128, Math.min(127, Math.round(cflScale * 84 * xy / (yy + 1))));
      const fb = Math.max(-128, Math.min(127, Math.round(cflScale * 84 * bySum / (yy + 1))));
      cfl.x[tileIndex] = fx; cfl.b[tileIndex] = fb;
      cflPair[0] = fx; cflPair[1] = fb;
      return cflPair;
    };
    for (let ty = 0; ty < tileRows; ty++) {
      for (let tx = 0; tx < tileWidth; tx++) {
        const bx0 = tx * 8, by0 = ty * 8, bw = Math.min(8, stride - bx0), bh = Math.min(8, rows - by0);
        tileIndex = ty * tileWidth + tx;
        const ok = runTile(data, width, height, bx0, by0, bw, bh, tileKernel, onTileCfl, components, stride, counts);
        if (ok === 'overflow') throw FAST_RANGE;
        if (!ok) throw fault('JXL_PLATFORM', 'photoTile: declined');
      }
      yield (ty + 1) / tileRows;
    }
    nonZero = counts;
  } else if (kernelBand) {
    const counts = [0, 1, 2].map(() => new Uint8Array(stride * rows));
    const packed = packBand ? {natural: new Uint32Array(192), opaque: true, channels: counts.map(c => ({at: new Uint8Array(stride * rows * 4), levels: new Int16Array(stride * rows * 4),
      total: 0, starts: null, dc: new Int16Array(stride * rows), counts: c}))} : null;
    if (runGabBand(band.data, width, band.data.length / 4 / width, band.top, height, {roots: ROOTS, linear: color.linear, mix: color.mix, signed, samples, bias: BIAS,
      rootBias: ROOT_BIAS, weights: [0, 1, 2].map(c => gab.weights?.[c] ?? GAB_DEFAULT), iterations: gab.iterations ?? 4, quantFields,
      quant: components.map(c => c.quant), thresholds: THRESHOLDS, c84: cflScale * 84, basis: dct8Basis, components, cfl, nonZero: counts, packed})) {
      if (packed) {
        packedOpacity = packed.opaque;
        components.forEach((component, c) => {
          const {at, levels, total: n, starts, groupStarts, dc} = packed.channels[c];
          component.packed = {at: at.slice(0, n), levels: levels.slice(0, n), counts: counts[c], starts, groupStarts, segment: packed.segment, dc,
            natural: packed.natural.subarray(c * 64, c * 64 + 64), length: stride * rows * 64};
        });
      }
      nonZero = counts;
      yield 1;
    } else if (band.only) return null;
    else throw fault('JXL_PLATFORM', 'gabBand: declined');
  } else {
    if (options?.keepPlanes && !pre) pre = xybPlanes(data, width, height, T, stride * 8, rows * 8, null, samples);
    if (options?.keepPlanes) planes = pre;
    const counts = [0, 1, 2].map(() => new Uint8Array(stride * rows));
    if (!runGabBand(data, width, height, 0, height, {roots: ROOTS, linear: color.linear, mix: color.mix, signed, samples, bias: BIAS,
      rootBias: ROOT_BIAS, weights: [0, 1, 2].map(() => GAB_DEFAULT), iterations: pre ? 1 : 0, pre, quantFields,
      quant: components.map(c => c.quant), thresholds: THRESHOLDS, c84: cflScale * 84, basis: dct8Basis, components, cfl, nonZero: counts}))
      throw fault('JXL_PLATFORM', 'gabBand: declined');
    if (options?.noLevels) { for (const component of components) component.coeffs.fill(0); for (const c of counts) c.fill(0); }
    nonZero = counts;
    yield 1;
  }

  let alpha = null, alphaWords = false;
  if (packedOpacity !== undefined) {
    if (!packedOpacity) alpha = data;
  } else {
    const opaque = options?.opaque ?? (kernelHooks.opaque ?? ensured().opaque ?? missing())(data, samples);
    if (opaque === undefined) throw fault('JXL_PLATFORM', 'opaque: declined');
    if (!opaque) {
      alpha = data instanceof Float32Array ? new Int32Array(data.buffer, data.byteOffset, data.length) : data;
      alphaWords = !(data instanceof Uint8Array || data instanceof Uint8ClampedArray);
    }
  }

  const epf = (q <= 90 || options?.filterAlways) && options?.filter !== 'off' ? 20 * distance : 0;
  const image = {width, height, components, quantScale, cfl, epf, xyb: true, ycbcr: false, orientation: 1, alpha, colorSpace: options?.space ?? 'srgb'};
  if (alphaWords) image.alphaWords = true;
  if (quantFields) { image.quantFields = quantFields; image.quantFieldBase = FIELD; image.epf = epf * FIELD / 32; }
  if (options?.epfScale !== undefined) image.epf *= options.epfScale;
  if (options?.sharpness) image.sharpness = options.sharpness;
  if (options?.epfIterations) image.epfIterations = options.epfIterations;
  if (nonZero) image.nonZero = nonZero;
  if (planes) image.planes = planes;
  if (gab && !fastBand && (!(typeof __RAPIER_JXL_UPLOAD__ !== 'undefined' && __RAPIER_JXL_UPLOAD__ === true) || pre || kernelBand)) image.gab = gab.weights ? gab.weights.map(w => w ?? GAB_DEFAULT) : true;
  if ((options?.adaptiveLF ?? (q < 65)) && !options?.smallFloor && stride > 2 && rows > 2) image.adaptiveLFSmoothing = true;
  return image;
}
