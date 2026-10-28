// SPDX-License-Identifier: MIT
import {exactCos, exactPow, exactLog2, EXACT_PI} from './exact-math.mjs';
import {QUANT_SHAPE, FAST_SCALE, transformDCT8Blocks, transformDCT8BlocksFast} from './photo-dct.mjs';
import {kernelHooks} from './kernel-hooks.mjs';
import {complete} from './bits.mjs';

const BIAS = 0.0037930732552754493;
function seedRoot(v) {
  let root = Math.sqrt(Math.sqrt(v));
  for (let i = 0; i < 7; i++) root = (2 * root + v / (root * root)) / 3;
  return root;
}
const ROOT_BIAS = seedRoot(BIAS);
const ROOTS = Float64Array.from({length: 4113}, (_, i) => i ? seedRoot(i / 4096) : 0);
function cubeRoot(v) {
  const scaled = v * 4096, at = Math.floor(scaled);
  let root = ROOTS[at] + (ROOTS[at + 1] - ROOTS[at]) * (scaled - at);
  for (let i = 0; i < 2; i++) root = (2 * root + v / (root * root)) / 3;
  return root;
}
function cubeRootFast(v) {
  const scaled = v * 4096, at = Math.floor(scaled);
  return ROOTS[at] + (ROOTS[at + 1] - ROOTS[at]) * (scaled - at);
}
function fillFastBlock(data, width, height, tile, offset, bx, by, {keys, values}) {
  const inside = bx + 8 <= width && by + 8 <= height;
  for (let y = 0; y < 8; y++) {
    const row = (by + y < height ? by + y : height - 1) * width;
    for (let x = 0; x < 8; x++) {
      const at = (row + (inside || bx + x < width ? bx + x : width - 1)) * 4, k = offset + y * 8 + x;
      const key = data[at] << 16 | data[at + 1] << 8 | data[at + 2], slot = Math.imul(key, 0x9e3779b1) >>> 15, v = slot * 3;
      if (keys[slot] !== key) {
        const r = LINEAR[data[at]], g = LINEAR[data[at + 1]], b = LINEAR[data[at + 2]];
        const l = cubeRootFast(0.3 * r + 0.622 * g + 0.078 * b + BIAS) - ROOT_BIAS;
        const m = cubeRootFast(0.23 * r + 0.692 * g + 0.078 * b + BIAS) - ROOT_BIAS;
        const s = cubeRootFast(0.24342268924547819 * r + 0.20476744424496821 * g + 0.5518098665095536 * b + BIAS) - ROOT_BIAS;
        const luma = (l + m) * 127.5;
        keys[slot] = key; values[v] = (l - m) * 127.5; values[v + 1] = luma; values[v + 2] = s * 255 - luma;
      }
      tile[k] = values[v]; tile[k + 64] = values[v + 1]; tile[k + 128] = values[v + 2];
    }
  }
}
const fastColors = () => ({keys: new Int32Array(COLOR_SLOTS).fill(-1), values: new Float64Array(COLOR_SLOTS * 3)});
function fillFastTile(data, width, height, tile, bx0, by0, bw, bh, colors) {
  for (let by = 0; by < bh; by++) for (let bx = 0; bx < bw; bx++) fillFastBlock(data, width, height, tile, (by * bw + bx) * 192, (bx0 + bx) * 8, (by0 + by) * 8, colors);
}
function correlate(tile, count, cfl, index, cflScale) {
  let yy = 0, xy = 0, bySum = 0;
  for (let n = 0; n < count; n++) for (let k = 1; k < 64; k++) {
    const at = n * 192;
    yy += tile[at + 64 + k] * tile[at + 64 + k];
    xy += tile[at + k] * tile[at + 64 + k];
    bySum += tile[at + 128 + k] * tile[at + 64 + k];
  }
  cfl.x[index] = Math.max(-128, Math.min(127, Math.round(cflScale * 84 * xy / (yy + 1))));
  cfl.b[index] = Math.max(-128, Math.min(127, Math.round(cflScale * 84 * bySum / (yy + 1))));
}
export const FAST_RANGE = new Error('A fast-path level is outside Int16.');
function quantFastTile(tile, bw, bh, by0, bx0, stride, components, scale, fx, fb, thresholds, nonZero, strict = false) {
  const ratios = [fx / 84, 0, fb / 84];
  for (let c = 0; c < 3; c++) {
    const sc = scale[c], out = components[c].coeffs, ratio = ratios[c], threshold = thresholds[c], counts = nonZero && nonZero[c];
    for (let by = 0; by < bh; by++) for (let bx = 0; bx < bw; bx++) {
      const at = (by * bw + bx) * 192, base = at + c * 64, luma = at + 64, block = (by0 + by) * stride + bx0 + bx, offset = block * 64;
      const dc = tile[base] * sc[0];
      if (strict && Math.abs(dc) >= 32767.5) throw FAST_RANGE;
      out[offset] = Math.abs(dc) < 0.5 ? 0 : Math.max(-32768, Math.min(32767, Math.round(dc)));
      let count = 0;
      if (c === 1) for (let k = 1; k < 64; k++) {
        const value = tile[base + k] * sc[k], q = Math.abs(value) < threshold[k] ? 0 : Math.round(value);
        if (strict && Math.abs(q) > 32767) throw FAST_RANGE;
        out[offset + k] = Math.max(-32768, Math.min(32767, q)); count += q !== 0;
      } else for (let k = 1; k < 64; k++) {
        const value = (tile[base + k] - ratio * tile[luma + k]) * sc[k], q = Math.abs(value) < threshold[k] ? 0 : Math.round(value);
        if (strict && Math.abs(q) > 32767) throw FAST_RANGE;
        out[offset + k] = Math.max(-32768, Math.min(32767, q)); count += q !== 0;
      }
      if (counts) counts[block] = count;
    }
  }
}
function quantTile(tile, bw, bh, by0, bx0, stride, components, quantScale, rx, rb, fineOf, THRESHOLDS, keep, biased) {
  for (let by = 0; by < bh; by++) for (let bx = 0; bx < bw; bx++) {
    const at = (by * bw + bx) * 192, block = (by0 + by) * stride + bx0 + bx, offset = block * 64, fine = fineOf ? fineOf(block) : 1;
    for (let c = 0; c < 3; c++) {
      const quant = components[c].quant, out = components[c].coeffs, ratio = c === 0 ? rx : rb, base = at + c * 64, thresholds = THRESHOLDS[c];
      for (let k = 0; k < 64; k++) {
        const coefficient = tile[base + k] - (k && c !== 1 ? ratio * tile[at + 64 + k] : 0) + 0;
        const value = coefficient * quantScale / quant[k] * (k ? fine : 1);
        if (keep) keep[c][offset + k] = value;
        out[offset + k] = Math.abs(value) < thresholds[k] ? 0 : Math.max(-32768, Math.min(32767, biased && k ? biasedRound(value, c) : Math.round(value)));
      }
    }
  }
}
function signedRoot(v) {
  const a = Math.abs(v), root = a <= 1 ? cubeRoot(a) : seedRoot(a);
  return v < 0 ? -root : root;
}
const LINEAR = Float64Array.from({length: 256}, (_, i) => {
  const v = i / 255;
  if (i <= 10) return v / 12.92;
  const base = (v + 0.055) / 1.055, square = base * base;
  let fifth = Math.sqrt(Math.sqrt(square));
  for (let n = 0; n < 12; n++) fifth = (4 * fifth + square / (fifth * fifth * fifth * fifth)) / 5;
  return square * fifth;
});


export function preferXYB(data, width, height) {
  let lumaEnergy = 0, chromaEnergy = 0;
  const pair = (a, b) => {
    const r = data[a] - data[b], g = data[a + 1] - data[b + 1], blue = data[a + 2] - data[b + 2];
    const y = 77 * r + 150 * g + 29 * blue, cb = 256 * blue - y, cr = 256 * r - y;
    lumaEnergy += y * y; chromaEnergy += cb * cb + cr * cr;
  };
  for (let y = 0; y < height; y += Math.max(1, height / 32 | 0)) for (let x = 0; x < width; x += Math.max(1, width / 32 | 0)) {
    const at = (y * width + x) * 4;
    if (x + 1 < width) pair(at, at + 4);
    if (y + 1 < height) pair(at, at + width * 4);
  }
  return chromaEnergy <= lumaEnergy;
}

const ONE = [1 - 0.05465007330715401, 1 - 0.07005449891748593, 1 - 0.049935103337343655];
function biasedRound(value, c) {
  const a = Math.abs(value), sign = value < 0 ? -1 : 1;
  let n = Math.max(1, Math.round(a));
  const point = m => m === 1 ? ONE[c] : m - 0.145 / m;
  if (n > 1 && Math.abs(a - point(n - 1)) < Math.abs(a - point(n))) n--;
  else if (Math.abs(a - point(n + 1)) < Math.abs(a - point(n))) n++;
  return sign * n;
}

const GAB_DEFAULT = [0.115169525, 0.061248592];
function gaborishStep(p, orig, W, H, [w1, w2], ring) {
  const norm = 1 / (1 + 4 * w1 + 4 * w2), last = W - 1;
  for (let y = 0; y < H; y++) {
    const u = (y ? y - 1 : 0) * W, m = y * W, d = (y < H - 1 ? y + 1 : y) * W, o = (y & 1) * W;
    let ul = p[u], uc = p[u], ml = p[m], mc = p[m], dl = p[d], dc = p[d];
    for (let x = 0; x < W; x++) {
      const right = x < last ? x + 1 : last, ur = p[u + right], mr = p[m + right], dr = p[d + right];
      ring[o + x] = (mc + w1 * (uc + dc + ml + mr) + w2 * (ul + ur + dl + dr)) * norm;
      ul = uc; uc = ur; ml = mc; mc = mr; dl = dc; dc = dr;
    }
    if (y) for (let x = 0, at = u, r = W - o; x < W; x++) p[at + x] += orig[at + x] - ring[r + x];
  }
  for (let x = 0, at = (H - 1) * W, r = ((H - 1) & 1) * W; x < W; x++) p[at + x] += orig[at + x] - ring[r + x];
}
function gaborishInverse(planes, W, H, {weights, strength = 1, iterations = 4, adapt = 0, floor = 0.3}) {
  const bw = W / 8, scale = adapt && new Float64Array((W / 8) * (H / 8)).fill(1);
  if (adapt) {
    const Y = planes[1], tex = new Float64Array(scale.length);
    for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
      const i = y * W + x;
      tex[(y >> 3) * bw + (x >> 3)] += Math.abs(4 * Y[i] - Y[i - 1] - Y[i + 1] - Y[i - W] - Y[i + W]);
    }
    const median = Float64Array.from(tex).sort()[tex.length >> 1] || 1;
    for (let b = 0; b < tex.length; b++) scale[b] = Math.max(floor, Math.min(1, 1 - adapt * exactLog2(Math.max(1, tex[b] / median))));
  }
  const ring = new Float64Array(2 * W), orig = new Float64Array(planes[0].length);
  for (let c = 0; c < planes.length; c++) {
    const t = planes[c], w = weights?.[c] ?? GAB_DEFAULT, s = Array.isArray(strength) ? strength[c] : strength, n = t.length;
    orig.set(t);
    for (let i = 0; i < iterations; i++) gaborishStep(t, orig, W, H, w, ring);
    if (adapt) for (let k = 0; k < n; k++) t[k] = orig[k] + s * scale[((k / W) >> 3) * bw + ((k % W) >> 3)] * (t[k] - orig[k]);
    else if (s !== 1) for (let k = 0; k < n; k++) t[k] = orig[k] + s * (t[k] - orig[k]);
  }
  return planes;
}

const COLOR_SLOTS = 1 << 17;
function xybPlanes(data, width, height, T, W, H) {
  const planes = [0, 1, 2].map(() => new Float64Array(W * H)), [X, Y, B] = planes, lms = T?.lms;
  const keys = new Int32Array(COLOR_SLOTS).fill(-1), values = new Float64Array(COLOR_SLOTS * 3);
  for (let y = 0; y < height; y++) {
    const row = y * W;
    for (let x = 0, at = y * width * 4; x < width; x++, at += 4) {
      const key = data[at] << 16 | data[at + 1] << 8 | data[at + 2], slot = Math.imul(key, 0x9e3779b1) >>> 15;
      if (keys[slot] !== key) {
        let l, m, s;
        if (T) {
          const r = T.tables[0][data[at]], g = T.tables[1][data[at + 1]], b = T.tables[2][data[at + 2]];
          l = signedRoot(lms[0] * r + lms[1] * g + lms[2] * b + BIAS) - ROOT_BIAS;
          m = signedRoot(lms[3] * r + lms[4] * g + lms[5] * b + BIAS) - ROOT_BIAS;
          s = signedRoot(lms[6] * r + lms[7] * g + lms[8] * b + BIAS) - ROOT_BIAS;
        } else {
          const r = LINEAR[data[at]], g = LINEAR[data[at + 1]], b = LINEAR[data[at + 2]];
          l = cubeRoot(0.3 * r + 0.622 * g + 0.078 * b + BIAS) - ROOT_BIAS;
          m = cubeRoot(0.23 * r + 0.692 * g + 0.078 * b + BIAS) - ROOT_BIAS;
          s = cubeRoot(0.24342268924547819 * r + 0.20476744424496821 * g + 0.5518098665095536 * b + BIAS) - ROOT_BIAS;
        }
        const luma = (l + m) * 127.5;
        keys[slot] = key; values[slot * 3] = (l - m) * 127.5; values[slot * 3 + 1] = luma; values[slot * 3 + 2] = s * 255 - luma;
      }
      X[row + x] = values[slot * 3]; Y[row + x] = values[slot * 3 + 1]; B[row + x] = values[slot * 3 + 2];
    }
    for (const p of planes) p.fill(p[row + width - 1], row + width, row + W);
  }
  for (const p of planes) for (let y = height; y < H; y++) p.copyWithin(y * W, (height - 1) * W, height * W);
  return planes;
}

export function gaborishPlanes(data, width, height, options) {
  const W = Math.ceil(width / 8) * 8, H = Math.ceil(height / 8) * 8;
  return gaborishInverse(xybPlanes(data, width, height, options.transform, W, H), W, H, options.gaborish);
}

export function* photoXYBSteps(data, width, height, quality, options) {
  const fast = !!options?.fast;
  const gab = fast ? null : options?.gaborish;
  const pre = gab && (options.pre ?? gaborishPlanes(data, width, height, options));
  const rootFn = fast ? cubeRootFast : cubeRoot;
  const dctBlocks = fast ? transformDCT8BlocksFast : transformDCT8Blocks;
  const T = options?.transform, lms = T?.lms;
  const stride = Math.ceil(width / 8), rows = Math.ceil(height / 8), quantScale = 256;
  if (options?.planesOnly) return {planes: xybPlanes(data, width, height, T, stride * 8, rows * 8)};
  const q = Math.min(quality, 99.9);
  const distance = (fast ? 0.539 : 1) * (q >= 99 ? 0.19 - 0.16 * (q - 99) : q >= 30 ? 0.1 + (100 - q) * 0.09 : 53 / 3000 * q * q - 23 / 20 * q + 25);
  const strength = Math.max(0, Math.min(1, (90 - q) / 15)), stepScale = 1 - 0.1 * strength, acScale = 1.175 + 0.075 * strength;
  const t = options?.tune, tune = typeof t === "function" ? t : t ? (c, k) => t[c] * (1 + t[3 + c] * Math.sqrt(((k & 7) * (k & 7) + (k >> 3) * (k >> 3)) / 98)) : () => 1;
  const d = options?.dcScale, dcScale = typeof d === 'function' ? c => d(c, distance) : Array.isArray(d) ? c => d[c] : () => d ?? 1;
  const gabTilt = (c, k) => {
    if (!options?.gaborish?.tilt) return 1;
    const [w1, w2] = options.gaborish.weights?.[c] ?? GAB_DEFAULT, a = exactCos(EXACT_PI * (k & 7) / 8), b = exactCos(EXACT_PI * (k >> 3) / 8);
    return exactPow((1 + 4 * w1 + 4 * w2) / (1 + 2 * w1 * (a + b) + 4 * w2 * a * b), options.gaborish.tilt);
  };
  const components = [0, 1, 2].map(c => ({h: 1, v: 1, stride, rows,
    quant: Int32Array.from(QUANT_SHAPE, (shape, k) => Math.max(1, Math.round(quantScale * distance * stepScale *
      (k ? acScale * [0.84, 7, 5.6][c] * shape * (1 + [1, 0, 5][c] * Math.sqrt(((k & 7) * (k & 7) + (k >> 3) * (k >> 3)) / 98)) * tune(c, k) * gabTilt(c, k) : [1.05, 7, 12.6][c] * 0.25 * dcScale(c))))),
    coeffs: new Int16Array(stride * rows * 64)}));
  const fastScale = fast && components.map(c => Float64Array.from(c.quant, q => quantScale / q));
  const nonZero = fast && [0, 1, 2].map(() => new Uint8Array(stride * rows));
  const tileWidth = Math.ceil(stride / 8), tileRows = Math.ceil(rows / 8);
  const cfl = {width: tileWidth, x: new Int8Array(tileWidth * tileRows), b: new Int8Array(tileWidth * tileRows)};
  const intermediate = new Float64Array(64), tile = new Float64Array(64 * 192);
  let colors = null;
  const roundtrip = !!options?.roundtrip, lumaBack = new Float64Array(64), dead = options?.deadzone, biased = !!options?.biasedRound;
  const planes = options?.keepPlanes && (pre || [0, 1, 2].map(() => new Float64Array(stride * rows * 64)));
  const dctCache = options?.dctCache && !options?.roundtrip ? options.dctCache : null;
  if (dctCache && !dctCache.tiles) Object.assign(dctCache, {tiles: [], x: new Int8Array(Math.ceil(stride / 8) * Math.ceil(rows / 8)), b: new Int8Array(Math.ceil(stride / 8) * Math.ceil(rows / 8))});
  const keep = options?.keepValues && [0, 1, 2].map(() => new Float32Array(stride * rows * 64));
  const THRESHOLDS = [0, 1, 2].map(c => Float64Array.from({length: 64}, (_, k) => {
    const high = (k & 7) >= 4 || (k >> 3) >= 4;
    return dead && k ? dead[c * 2 + (high ? 1 : 0)] : k && c === 1 ? 0.5 + strength * (high ? 0.14 : 0.08) : 0.5;
  }));
  const tileKernel = fast && !pre && !T && !planes && !dctCache && !options?.planesOnly && kernelHooks.photoTile && {roots: ROOTS, linear: LINEAR,
    scale: FAST_SCALE, bias: BIAS, rootBias: ROOT_BIAS, steps: fastScale,
    limits: [0, 1, 2].map(c => Float64Array.from({length: 64}, (_, k) => (k & 7) >= 4 || k >= 32 ? dead[c * 2 + 1] : dead[c * 2]))};
  const fieldScale = options?.fieldScale, FIELD = 64, quantFields = fieldScale && new Int32Array(stride * rows);
  if (quantFields) for (let i = 0; i < quantFields.length; i++) quantFields[i] = Math.max(1, Math.min(256, Math.round(FIELD * fieldScale[i])));
  for (let ty = 0; ty < tileRows; ty++) {
    for (let tx = 0; tx < tileWidth; tx++) {
      const bx0 = tx * 8, by0 = ty * 8, bw = Math.min(8, stride - bx0), bh = Math.min(8, rows - by0), index = ty * tileWidth + tx;
      if (tileKernel && kernelHooks.photoTile?.(data, width, height, bx0, by0, bw, bh, tileKernel, (xy, yy, bySum) => {
        const cflScale = options?.cflScale ?? 1;
        cfl.x[index] = Math.max(-128, Math.min(127, Math.round(cflScale * 84 * xy / (yy + 1))));
        cfl.b[index] = Math.max(-128, Math.min(127, Math.round(cflScale * 84 * bySum / (yy + 1))));
        return [cfl.x[index], cfl.b[index]];
      }, components, stride, nonZero)) continue;
      const cached = dctCache?.tiles[index];
      if (cached) { tile.set(cached); cfl.x[index] = dctCache.x[index]; cfl.b[index] = dctCache.b[index]; }
      else {
      if (fast && !pre && !T) {
        fillFastTile(data, width, height, tile, bx0, by0, bw, bh, colors ||= fastColors());
      } else for (let by = 0; by < bh; by++) for (let bx = 0; bx < bw; bx++) {
        const offset = (by * bw + bx) * 192;
        for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
          const k = y * 8 + x;
          if (pre) {
            const at = ((by0 + by) * 8 + y) * stride * 8 + (bx0 + bx) * 8 + x;
            tile[offset + k] = pre[0][at]; tile[offset + 64 + k] = pre[1][at]; tile[offset + 128 + k] = pre[2][at];
            continue;
          }
          const at = (Math.min(height - 1, (by0 + by) * 8 + y) * width + Math.min(width - 1, (bx0 + bx) * 8 + x)) * 4;
          let l, m, s;
          if (T) {
            const r = T.tables[0][data[at]], g = T.tables[1][data[at + 1]], b = T.tables[2][data[at + 2]];
            l = signedRoot(lms[0] * r + lms[1] * g + lms[2] * b + BIAS) - ROOT_BIAS;
            m = signedRoot(lms[3] * r + lms[4] * g + lms[5] * b + BIAS) - ROOT_BIAS;
            s = signedRoot(lms[6] * r + lms[7] * g + lms[8] * b + BIAS) - ROOT_BIAS;
          } else {
            const r = LINEAR[data[at]], g = LINEAR[data[at + 1]], b = LINEAR[data[at + 2]];
            l = rootFn(0.3 * r + 0.622 * g + 0.078 * b + BIAS) - ROOT_BIAS;
            m = rootFn(0.23 * r + 0.692 * g + 0.078 * b + BIAS) - ROOT_BIAS;
            s = rootFn(0.24342268924547819 * r + 0.20476744424496821 * g + 0.5518098665095536 * b + BIAS) - ROOT_BIAS;
          }
          tile[offset + k] = (l - m) * 127.5;
          tile[offset + 64 + k] = (l + m) * 127.5;
          tile[offset + 128 + k] = s * 255 - tile[offset + 64 + k];
          if (planes) for (let c = 0; c < 3; c++) planes[c][((by0 + by) * 8 + y) * stride * 8 + (bx0 + bx) * 8 + x] = tile[offset + c * 64 + k];
        }
      }
      if (fast) dctBlocks(tile, bw * bh);
      else dctBlocks(tile, bw * bh, intermediate);
      correlate(tile, bw * bh, cfl, index, options?.cflScale ?? 1);
      if (dctCache) { dctCache.tiles[index] = tile.slice(0, bw * bh * 192); dctCache.x[index] = cfl.x[index]; dctCache.b[index] = cfl.b[index]; }
      }
      const fx = cfl.x[index], fb = cfl.b[index];
      if (fast) {
        quantFastTile(tile, bw, bh, by0, bx0, stride, components, fastScale, fx, fb, THRESHOLDS, nonZero, !!T);
        continue;
      }
      if (!roundtrip) {
        quantTile(tile, bw, bh, by0, bx0, stride, components, quantScale, fx / 84, fb / 84, quantFields && (i => quantFields[i] / FIELD), THRESHOLDS, keep, biased);
        continue;
      }
      for (let by = 0; by < bh; by++) for (let bx = 0; bx < bw; bx++) {
        const at = (by * bw + bx) * 192, offset = ((by0 + by) * stride + bx0 + bx) * 64;
        const fine = quantFields ? quantFields[(by0 + by) * stride + bx0 + bx] / FIELD : 1;
        for (const c of roundtrip ? [1, 0, 2] : [0, 1, 2]) for (let k = 0; k < 64; k++) {
          const luma = roundtrip && k ? lumaBack[k] : tile[at + 64 + k];
          const coefficient = tile[at + c * 64 + k] - (k && c !== 1 ? (c === 0 ? fx : fb) / 84 * luma : 0)
            + (roundtrip && k && c === 2 ? tile[at + 64 + k] - luma : 0);
          const value = coefficient * quantScale / components[c].quant[k] * (k ? fine : 1);
          const high = (k & 7) >= 4 || (k >> 3) >= 4;
          const threshold = dead && k ? dead[c * 2 + (high ? 1 : 0)] : k && c === 1 ? 0.5 + strength * (high ? 0.14 : 0.08) : 0.5;
          if (keep) keep[c][offset + k] = value;
          const q = components[c].coeffs[offset + k] = Math.abs(value) < threshold ? 0 : Math.max(-32768, Math.min(32767, biased && k ? biasedRound(value, c) : Math.round(value)));
          if (roundtrip && c === 1 && k) lumaBack[k] = (q === 0 ? 0 : q === 1 || q === -1 ? q * 0.92994550108251407 : q - 0.145 / q)
            * components[1].quant[k] / (quantScale * fine);
        }
      }
    }
    yield (ty + 1) / tileRows;
  }
  let alpha = null;
  for (let i = 3; i < data.length; i += 4) if (data[i] !== 255) { alpha = data; break; }
  const epf = (q <= 90 || options?.filterAlways) && options?.filter !== 'off' ? 20 * distance : 0;
  const image = {width, height, components, quantScale, cfl, epf, xyb: true, ycbcr: false, orientation: 1, alpha, colorSpace: options?.space ?? 'srgb'};
  if (quantFields) { image.quantFields = quantFields; image.quantFieldBase = FIELD; image.epf = epf * FIELD / 32; }
  if (options?.epfScale !== undefined) image.epf *= options.epfScale;
  if (options?.sharpness) image.sharpness = options.sharpness;
  if (options?.epfIterations) image.epfIterations = options.epfIterations;
  if (nonZero) image.nonZero = nonZero;
  if (keep) image.values = keep;
  if (planes) image.planes = planes;
  if (gab) image.gab = gab.weights ? gab.weights.map(w => w ?? GAB_DEFAULT) : true;
  return image;
}
