// SPDX-License-Identifier: MIT
import {exactCos, exactPow, exactLog2, EXACT_PI} from './exact-math.mjs';
import {QUANT_SHAPE, FAST_SCALE, transformDCT8Blocks, transformDCT8BlocksFast, dct8Basis} from './photo-dct.mjs';
import {kernelHooks} from './kernel-hooks.mjs';
import {complete, LITTLE_ENDIAN} from './bits.mjs';
import {calibration} from './quality-calibration.mjs';

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
    if (!kernelHooks.gaborish?.(t, orig, W, H, w, iterations)) for (let i = 0; i < iterations; i++) gaborishStep(t, orig, W, H, w, ring);
    if (adapt) for (let k = 0; k < n; k++) t[k] = orig[k] + s * scale[((k / W) >> 3) * bw + ((k % W) >> 3)] * (t[k] - orig[k]);
    else if (s !== 1) for (let k = 0; k < n; k++) t[k] = orig[k] + s * (t[k] - orig[k]);
  }
  return planes;
}

const COLOR_SLOTS = 1 << 17;
const SRGB_MIX = Float64Array.of(0.3, 0.622, 0.078, 0.23, 0.692, 0.078, 0.24342268924547819, 0.20476744424496821, 0.5518098665095536);
export const XYB_TABLES = Object.freeze({linear: LINEAR, mix: SRGB_MIX, bias: BIAS, rootBias: ROOT_BIAS});
function xybPlanes(data, width, height, T, W, H) {
  const planes = [0, 1, 2].map(() => new Float64Array(W * H)), [X, Y, B] = planes, lms = T?.lms;
  if (!T && kernelHooks.xybPlanes?.(data, width, height, W, H, planes, ROOTS, LINEAR, SRGB_MIX, BIAS, ROOT_BIAS)) {
    for (const p of planes) for (let y = height; y < H; y++) p.copyWithin(y * W, (height - 1) * W, height * W);
    return planes;
  }
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

const FAST_SCALE32 = Float32Array.from(FAST_SCALE);
const f = Math.fround, THIRD = f(1 / 3), C707 = f(0.7071067811865476), C382 = f(0.3826834333650898), C541 = f(0.5411961001461969), C1306 = f(1.3065629648763766);
function dct32(x, o, scale) {
  for (let pass = 0; pass < 2; pass++) {
    const stride = pass ? 1 : 8, step = pass ? 8 : 1;
    for (let i = 0; i < 8; i++) {
      const p = o + i * step;
      const x0 = x[p], x1 = x[p + stride], x2 = x[p + 2 * stride], x3 = x[p + 3 * stride], x4 = x[p + 4 * stride], x5 = x[p + 5 * stride], x6 = x[p + 6 * stride], x7 = x[p + 7 * stride];
      const t0 = f(x0 + x7), t7 = f(x0 - x7), t1 = f(x1 + x6), t6 = f(x1 - x6), t2 = f(x2 + x5), t5 = f(x2 - x5), t3 = f(x3 + x4), t4 = f(x3 - x4);
      const a0 = f(t0 + t3), a3 = f(t0 - t3), a1 = f(t1 + t2), a2 = f(t1 - t2);
      x[p] = a0 + a1; x[p + 4 * stride] = a0 - a1;
      const z1 = f(f(a2 + a3) * C707);
      x[p + 2 * stride] = a3 + z1; x[p + 6 * stride] = a3 - z1;
      const b0 = f(t4 + t5), b1 = f(t5 + t6), b2 = f(t6 + t7);
      const z5 = f(f(b0 - b2) * C382), z2 = f(f(C541 * b0) + z5), z4 = f(f(C1306 * b2) + z5), z3 = f(b1 * C707);
      const z11 = f(t7 + z3), z13 = f(t7 - z3);
      x[p + 5 * stride] = z13 + z2; x[p + 3 * stride] = z13 - z2; x[p + stride] = z11 + z4; x[p + 7 * stride] = z11 - z4;
    }
  }
  for (let k = 0; k < 64; k++) x[o + k] *= scale[k];
}
function fastGaborishBand(data, width, total, top, height, job) {
  const {linear, mix, bias, rootBias, weights, iterations, scale, steps, thresholds, c84, components, cfl, nonZero} = job;
  const stride = Math.ceil(width / 8), rows = Math.ceil(height / 8), W = stride * 8, H = Math.ceil(total / 8) * 8;
  const lin = Float32Array.from(linear), mx = Float32Array.from(mix), b32 = f(bias), rb32 = f(rootBias), word = new Float32Array(1), bits = new Int32Array(word.buffer);
  const cbrt = v => {
    word[0] = v; bits[0] = Math.trunc(f(f(bits[0]) * THIRD)) + 0x2a5137a0 | 0;
    let r = word[0];
    for (let i = 0; i < 3; i++) r = f(f(f(r + r) + f(v / f(r * r))) * THIRD);
    return r;
  };
  const mixed = (k, r, g, b) => f(f(f(f(mx[k] * r) + f(mx[k + 1] * g)) + f(mx[k + 2] * b)) + b32);
  const planes = [0, 1, 2].map(() => new Float32Array(W * H));
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const at = (Math.min(y, total - 1) * width + Math.min(x, width - 1)) * 4, r = lin[data[at]], g = lin[data[at + 1]], b = lin[data[at + 2]];
    const l = f(cbrt(mixed(0, r, g, b)) - rb32), m = f(cbrt(mixed(3, r, g, b)) - rb32), s = f(cbrt(mixed(6, r, g, b)) - rb32), luma = f(f(l + m) * 127.5);
    planes[0][y * W + x] = f(l - m) * 127.5; planes[1][y * W + x] = luma; planes[2][y * W + x] = f(s * 255) - luma;
  }
  const ring = new Float32Array(2 * W);
  planes.forEach((p, c) => {
    const orig = p.slice(), [w1, w2] = weights[c].map(f), norm = f(1 / (1 + 4 * weights[c][0] + 4 * weights[c][1]));
    for (let i = 0; i < iterations; i++) {
      for (let y = 0; y < H; y++) {
        const u = (y ? y - 1 : 0) * W, m = y * W, d = (y < H - 1 ? y + 1 : y) * W, o = (y & 1) * W;
        for (let x = 0; x < W; x++) {
          const l = x ? x - 1 : 0, r = x < W - 1 ? x + 1 : x;
          ring[o + x] = f(f(f(p[m + x] + f(w1 * f(f(f(p[u + x] + p[d + x]) + p[m + l]) + p[m + r]))) + f(w2 * f(f(f(p[u + l] + p[u + r]) + p[d + l]) + p[d + r]))) * norm);
        }
        if (y) for (let x = 0, r = W - o; x < W; x++) p[u + x] = f(p[u + x] + f(orig[u + x] - ring[r + x]));
      }
      for (let x = 0, at = (H - 1) * W, r = ((H - 1) & 1) * W; x < W; x++) p[at + x] = f(p[at + x] + f(orig[at + x] - ring[r + x]));
    }
  });
  const tile = new Float32Array(64 * 192), tileWidth = cfl.width;
  for (let ty = 0; ty < Math.ceil(rows / 8); ty++) for (let tx = 0; tx < tileWidth; tx++) {
    const bx0 = tx * 8, by0 = ty * 8, bw = Math.min(8, stride - bx0), bh = Math.min(8, rows - by0), count = bw * bh;
    for (let by = 0; by < bh; by++) for (let bx = 0; bx < bw; bx++) for (let c = 0; c < 3; c++) {
      const o = (by * bw + bx) * 192 + c * 64;
      for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) tile[o + y * 8 + x] = planes[c][(top + (by0 + by) * 8 + y) * W + (bx0 + bx) * 8 + x];
      dct32(tile, o, scale);
    }
    let yy = 0, xy = 0, bs = 0;
    for (let n = 0; n < count; n++) for (let k = 1; k < 64; k++) {
      const at = n * 192, l = tile[at + 64 + k];
      yy += l * l; xy += tile[at + k] * l; bs += tile[at + 128 + k] * l;
    }
    const fx = Math.max(-128, Math.min(127, Math.round(c84 * xy / (yy + 1)))), fb = Math.max(-128, Math.min(127, Math.round(c84 * bs / (yy + 1))));
    cfl.x[ty * tileWidth + tx] = fx; cfl.b[ty * tileWidth + tx] = fb;
    for (let n = 0; n < count; n++) {
      const block = (by0 + Math.floor(n / bw)) * stride + bx0 + n % bw;
      for (let c = 0; c < 3; c++) {
        const ratio = f((c ? fb : fx) / 84), base = n * 192 + c * 64, out = components[c].coeffs, step = steps[c], thr = thresholds[c];
        let nz = 0;
        for (let k = 0; k < 64; k++) {
          const v = f((k && c !== 1 ? f(tile[base + k] - f(ratio * tile[n * 192 + 64 + k])) : tile[base + k]) * step[k]);
          let level = 0;
          if (!(Math.abs(v) < thr[k])) { const fl = Math.floor(v); level = Math.max(-32768, Math.min(32767, fl + (v - fl >= 0.5 ? 1 : 0))); }
          out[block * 64 + k] = level;
          if (k && level) nz++;
        }
        nonZero[c][block] = nz;
      }
    }
  }
}

const FAST_V6_TABLES = new Map();
function fastV6Tables(q, distance, strength, stepScale, acScale, quantScale, options) {
  let entry = FAST_V6_TABLES.get(q);
  if (entry) return entry;
  const tune = options.tune, dcScale = options.dcScale, dead = options.deadzone;
  const quants = [0, 1, 2].map(c => Int32Array.from(QUANT_SHAPE, (shape, k) => Math.max(1, Math.round(quantScale * distance * stepScale *
    (k ? acScale * [0.84, 7, 5.6][c] * shape * (1 + [1, 0, 5][c] * Math.sqrt(((k & 7) * (k & 7) + (k >> 3) * (k >> 3)) / 98)) * tune(c, k) : [1.05, 7, 12.6][c] * 0.25 * dcScale[c])))));
  const fastScale = quants.map(quant => Float64Array.from(quant, v => quantScale / v));
  const thresholds = [0, 1, 2].map(c => Float64Array.from({length: 64}, (_, k) => {
    const high = (k & 7) >= 4 || (k >> 3) >= 4;
    return k ? dead[c * 2 + (high ? 1 : 0)] : 0.5;
  }));
  const tileKernel = {
    roots: ROOTS, linear: LINEAR, scale: FAST_SCALE, bias: BIAS, rootBias: ROOT_BIAS, steps: fastScale,
    limits: [0, 1, 2].map(c => Float64Array.from({length: 64}, (_, k) => (k & 7) >= 4 || k >= 32 ? dead[c * 2 + 1] : dead[c * 2])),
  };
  entry = {quants, fastScale, thresholds, tileKernel, tune, dc0: dcScale[0], dc1: dcScale[1], dc2: dcScale[2], dead};
  FAST_V6_TABLES.set(q, entry);
  return entry;
}

export function* photoXYBSteps(data, width, height, quality, options) {
  const fast = !!options?.fast;
  if (fast && options?.fieldScale) throw new Error('The fast path takes no quantization field.');
  const gab = fast ? null : options?.gaborish;
  const fastGab = !!(gab && options.fastGaborish);
  const band = gab && !options.pre ? options.band ?? (fastGab ? {data, top: 0} : null) : null;
  const kernelBand = band && kernelHooks.gabBand && !options.transform && !options.keepPlanes && !options.dctCache && !options.roundtrip &&
    !options.keepValues && !options.biasedRound && !options.fieldScale && !options.noLevels && !options.planesOnly &&
    (gab.strength ?? 1) === 1 && !gab.adapt;
  if (band?.only && !kernelBand) return null;
  let pre = null;
  if (gab && !kernelBand && !fastGab) {
    const W = Math.ceil(width / 8) * 8, H = Math.ceil(height / 8) * 8;
    pre = options.pre ?? (band ? gaborishPlanes(band.data, width, band.data.length / 4 / width, options).map(p => p.subarray(band.top * W, (band.top + H) * W))
      : gaborishPlanes(data, width, height, options));
  }
  const rootFn = fast ? cubeRootFast : cubeRoot;
  const dctBlocks = fast ? transformDCT8BlocksFast : transformDCT8Blocks;
  const T = options?.transform, lms = T?.lms;
  const stride = Math.ceil(width / 8), rows = Math.ceil(height / 8), quantScale = 256;
  if (options?.planesOnly) return {planes: xybPlanes(data, width, height, T, stride * 8, rows * 8)};
  const q = Math.min(quality, 99.9);
  const distance = Math.max(fast ? 0.0248 : 0.046, calibration(q, options?.calibrationRow ?? fast) * (q >= 99 ? 0.19 - 0.16 * (q - 99) : q >= 30 ? 0.1 + (100 - q) * 0.09 : 53 / 3000 * q * q - 23 / 20 * q + 25));
  const strength = Math.max(0, Math.min(1, (90 - q) / 15)), stepScale = 1 - 0.1 * strength, acScale = 1.175 + 0.075 * strength;
  const t = options?.tune, tune = typeof t === "function" ? t : t ? (c, k) => t[c] * (1 + t[3 + c] * Math.sqrt(((k & 7) * (k & 7) + (k >> 3) * (k >> 3)) / 98)) : () => 1;
  const d = options?.dcScale, dcScale = typeof d === 'function' ? c => d(c, distance) : Array.isArray(d) ? c => d[c] : () => d ?? 1;
  const gabTilt = (c, k) => {
    if (!options?.gaborish?.tilt) return 1;
    const [w1, w2] = options.gaborish.weights?.[c] ?? GAB_DEFAULT, a = exactCos(EXACT_PI * (k & 7) / 8), b = exactCos(EXACT_PI * (k >> 3) / 8);
    return exactPow((1 + 4 * w1 + 4 * w2) / (1 + 2 * w1 * (a + b) + 4 * w2 * a * b), options.gaborish.tilt);
  };
  const cachedFast = fast && !pre && !T && !options?.gaborish?.tilt && typeof t === "function" && Array.isArray(d) && Array.isArray(options?.deadzone) && !options?.calibrationRow
    ? fastV6Tables(q, distance, strength, stepScale, acScale, quantScale, options) : null;
  const useCachedFast = cachedFast && cachedFast.tune === t && cachedFast.dead === options.deadzone && cachedFast.dc0 === d[0] && cachedFast.dc1 === d[1] && cachedFast.dc2 === d[2] ? cachedFast : null;
  const components = [0, 1, 2].map(c => ({h: 1, v: 1, stride, rows,
    quant: useCachedFast ? useCachedFast.quants[c] : Int32Array.from(QUANT_SHAPE, (shape, k) => Math.max(1, Math.round(quantScale * distance * stepScale *
      (k ? acScale * [0.84, 7, 5.6][c] * shape * (1 + [1, 0, 5][c] * Math.sqrt(((k & 7) * (k & 7) + (k >> 3) * (k >> 3)) / 98)) * tune(c, k) * gabTilt(c, k) : [1.05, 7, 12.6][c] * 0.25 * dcScale(c))))),
    coeffs: new Int16Array(stride * rows * 64)}));
  const fastScale = fast && (useCachedFast ? useCachedFast.fastScale : components.map(c => Float64Array.from(c.quant, q => quantScale / q)));
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
  const THRESHOLDS = useCachedFast ? useCachedFast.thresholds : [0, 1, 2].map(c => Float64Array.from({length: 64}, (_, k) => {
    const high = (k & 7) >= 4 || (k >> 3) >= 4;
    return dead && k ? dead[c * 2 + (high ? 1 : 0)] : k && c === 1 ? 0.5 + strength * (high ? 0.14 : 0.08) : 0.5;
  }));
  const tileKernel = fast && !pre && !T && !planes && !dctCache && !options?.planesOnly && kernelHooks.photoTile && (useCachedFast ? useCachedFast.tileKernel : {roots: ROOTS, linear: LINEAR,
    scale: FAST_SCALE, bias: BIAS, rootBias: ROOT_BIAS, steps: fastScale,
    limits: [0, 1, 2].map(c => Float64Array.from({length: 64}, (_, k) => (k & 7) >= 4 || k >= 32 ? dead[c * 2 + 1] : dead[c * 2]))});
  const fieldScale = options?.fieldScale, FIELD = 64, quantFields = fieldScale && new Int32Array(stride * rows);
  if (quantFields) for (let i = 0; i < quantFields.length; i++) quantFields[i] = Math.max(1, Math.min(256, Math.round(FIELD * fieldScale[i])));
  const cflScale = options?.cflScale ?? 1, cflPair = [0, 0];
  let nonZeroBand = null;
  if (fastGab) {
    const counts = [0, 1, 2].map(() => new Uint8Array(stride * rows)), total = band.data.length / 4 / width;
    const job = {linear: LINEAR, mix: SRGB_MIX, bias: BIAS, rootBias: ROOT_BIAS, weights: [0, 1, 2].map(c => gab.weights?.[c] ?? GAB_DEFAULT),
      iterations: gab.iterations ?? 4, fast: true, scale: FAST_SCALE32, steps: components.map(c => Float32Array.from(c.quant, q => quantScale / q)),
      thresholds: THRESHOLDS.map(t => Float32Array.from(t)), c84: cflScale * 84, components, cfl, nonZero: counts};
    if (!(kernelBand && kernelHooks.gabBand(band.data, width, total, band.top, height, job))) {
      if (band.only) return null;
      fastGaborishBand(band.data, width, total, band.top, height, job);
    }
    nonZeroBand = counts;
  } else if (kernelBand) {
    const counts = [0, 1, 2].map(() => new Uint8Array(stride * rows));
    if (kernelHooks.gabBand(band.data, width, band.data.length / 4 / width, band.top, height, {roots: ROOTS, linear: LINEAR, mix: SRGB_MIX, bias: BIAS,
      rootBias: ROOT_BIAS, weights: [0, 1, 2].map(c => gab.weights?.[c] ?? GAB_DEFAULT), iterations: gab.iterations ?? 4,
      quant: components.map(c => c.quant), thresholds: THRESHOLDS, c84: cflScale * 84, basis: dct8Basis, components, cfl, nonZero: counts})) {
      nonZeroBand = counts;
    } else if (band.only) return null;
    else {
      const W = stride * 8;
      pre = gaborishPlanes(band.data, width, band.data.length / 4 / width, options).map(p => p.subarray(band.top * W, (band.top + rows * 8) * W));
    }
  }
  let tileIndex = 0;
  const onTileCfl = (xy, yy, bySum) => {
    const fx = Math.max(-128, Math.min(127, Math.round(cflScale * 84 * xy / (yy + 1))));
    const fb = Math.max(-128, Math.min(127, Math.round(cflScale * 84 * bySum / (yy + 1))));
    cfl.x[tileIndex] = fx; cfl.b[tileIndex] = fb;
    cflPair[0] = fx; cflPair[1] = fb;
    return cflPair;
  };
  for (let ty = nonZeroBand ? tileRows : 0; ty < tileRows; ty++) {
    for (let tx = 0; tx < tileWidth; tx++) {
      const bx0 = tx * 8, by0 = ty * 8, bw = Math.min(8, stride - bx0), bh = Math.min(8, rows - by0), index = ty * tileWidth + tx;
      tileIndex = index;
      if (tileKernel && kernelHooks.photoTile?.(data, width, height, bx0, by0, bw, bh, tileKernel, onTileCfl, components, stride, nonZero)) continue;
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
        if (!options?.noLevels) quantTile(tile, bw, bh, by0, bx0, stride, components, quantScale, fx / 84, fb / 84, quantFields && (i => quantFields[i] / FIELD), THRESHOLDS, keep, biased);
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
  if (LITTLE_ENDIAN && data.byteOffset % 4 === 0 && (data.byteLength & 3) === 0) {
    const words = new Uint32Array(data.buffer, data.byteOffset, data.byteLength >> 2);
    for (let i = 0; i < words.length; i++) if (words[i] < 0xff000000) { alpha = data; break; }
  } else {
    for (let i = 3; i < data.length; i += 4) if (data[i] !== 255) { alpha = data; break; }
  }
  const epf = (q <= 90 || options?.filterAlways) && options?.filter !== 'off' ? 20 * distance : 0;
  const image = {width, height, components, quantScale, cfl, epf, xyb: true, ycbcr: false, orientation: 1, alpha, colorSpace: options?.space ?? 'srgb'};
  if (quantFields) { image.quantFields = quantFields; image.quantFieldBase = FIELD; image.epf = epf * FIELD / 32; }
  if (options?.epfScale !== undefined) image.epf *= options.epfScale;
  if (options?.sharpness) image.sharpness = options.sharpness;
  if (options?.epfIterations) image.epfIterations = options.epfIterations;
  if (nonZero || nonZeroBand) image.nonZero = nonZero || nonZeroBand;
  if (nonZeroBand) yield 1;
  if (keep) image.values = keep;
  if (planes) image.planes = planes;
  if (gab) image.gab = gab.weights ? gab.weights.map(w => w ?? GAB_DEFAULT) : true;
  return image;
}

