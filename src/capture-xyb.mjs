// SPDX-License-Identifier: MIT
import {QUANT_SHAPE, FAST_SCALE, transformDCT8BlocksFast} from './photo-dct.mjs';
import {kernelHooks} from './kernel-hooks.mjs';
import {LITTLE_ENDIAN} from './bits.mjs';
import {calibration} from './quality-calibration.mjs';
import {V6} from './photo-v6-settings.mjs';

const BIAS = 0.0037930732552754493;
function seedRoot(v) {
  let root = Math.sqrt(Math.sqrt(v));
  for (let i = 0; i < 7; i++) root = (2 * root + v / (root * root)) / 3;
  return root;
}
const ROOT_BIAS = /* @__PURE__ */ seedRoot(BIAS);
const ROOTS = /* @__PURE__ */ Float64Array.from({length: 4113}, (_, i) => i ? seedRoot(i / 4096) : 0);
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
function signedRoot(v) {
  const a = Math.abs(v), root = a <= 1 ? cubeRoot(a) : seedRoot(a);
  return v < 0 ? -root : root;
}
const LINEAR = /* @__PURE__ */ Float64Array.from({length: 256}, (_, i) => {
  const v = i / 255;
  if (i <= 10) return v / 12.92;
  const base = (v + 0.055) / 1.055, square = base * base;
  let fifth = Math.sqrt(Math.sqrt(square));
  for (let n = 0; n < 12; n++) fifth = (4 * fifth + square / (fifth * fifth * fifth * fifth)) / 5;
  return square * fifth;
});

const COLOR_SLOTS = 1 << 17;
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
const FAST_RANGE = /* @__PURE__ */ new Error('A fast-path level is outside Int16.');
function quantFastTile(tile, bw, bh, by0, bx0, stride, components, scale, fx, fb, thresholds, nonZero, strict) {
  const ratios = [fx / 84, 0, fb / 84];
  for (let c = 0; c < 3; c++) {
    const sc = scale[c], out = components[c].coeffs, ratio = ratios[c], threshold = thresholds[c], counts = nonZero[c];
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
      counts[block] = count;
    }
  }
}

function preferXYB(data, width, height) {
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

const TABLES = /* @__PURE__ */ new Map();
function tablesOf(q, distance, strength) {
  let entry = TABLES.get(q);
  if (entry) return entry;
  const stepScale = 1 - 0.1 * strength, acScale = 1.175 + 0.075 * strength, dead = V6.deadzone;
  const quants = [0, 1, 2].map(c => Int32Array.from(QUANT_SHAPE, (shape, k) => Math.max(1, Math.round(256 * distance * stepScale *
    (k ? acScale * [0.84, 7, 5.6][c] * shape * (1 + [1, 0, 5][c] * Math.sqrt(((k & 7) * (k & 7) + (k >> 3) * (k >> 3)) / 98)) * V6.tune(c, k) : [1.05, 7, 12.6][c] * 0.25 * V6.dcScale[c])))));
  const steps = quants.map(quant => Float64Array.from(quant, v => 256 / v));
  const thresholds = [0, 1, 2].map(c => Float64Array.from({length: 64}, (_, k) => k ? dead[c * 2 + ((k & 7) >= 4 || (k >> 3) >= 4 ? 1 : 0)] : 0.5));
  const tileKernel = {roots: ROOTS, linear: LINEAR, scale: FAST_SCALE, bias: BIAS, rootBias: ROOT_BIAS, steps,
    limits: [0, 1, 2].map(c => Float64Array.from({length: 64}, (_, k) => (k & 7) >= 4 || k >= 32 ? dead[c * 2 + 1] : dead[c * 2]))};
  entry = {quants, steps, thresholds, tileKernel};
  TABLES.set(q, entry);
  return entry;
}

function* captureXYBSteps(data, width, height, quality, {space, transform}) {
  const T = transform, lms = T?.lms, stride = Math.ceil(width / 8), rows = Math.ceil(height / 8);
  const q = Math.min(quality, 99.9);
  const distance = Math.max(0.0248, calibration(q, true) * (q >= 99 ? 0.19 - 0.16 * (q - 99) : q >= 30 ? 0.1 + (100 - q) * 0.09 : 53 / 3000 * q * q - 23 / 20 * q + 25));
  const {quants, steps, thresholds, tileKernel} = tablesOf(q, distance, Math.max(0, Math.min(1, (90 - q) / 15)));
  const components = quants.map(quant => ({h: 1, v: 1, stride, rows, quant, coeffs: new Int16Array(stride * rows * 64)}));
  const nonZero = [0, 1, 2].map(() => new Uint8Array(stride * rows));
  const tileWidth = Math.ceil(stride / 8), tileRows = Math.ceil(rows / 8), cflScale = V6.cflScale;
  const cfl = {width: tileWidth, x: new Int8Array(tileWidth * tileRows), b: new Int8Array(tileWidth * tileRows)};
  const kernel = !T && kernelHooks.photoTile, tile = new Float64Array(64 * 192), cflPair = [0, 0];
  let colors = null, tileIndex = 0;
  const onTileCfl = (xy, yy, bySum) => {
    const fx = Math.max(-128, Math.min(127, Math.round(cflScale * 84 * xy / (yy + 1))));
    const fb = Math.max(-128, Math.min(127, Math.round(cflScale * 84 * bySum / (yy + 1))));
    cfl.x[tileIndex] = fx; cfl.b[tileIndex] = fb;
    cflPair[0] = fx; cflPair[1] = fb;
    return cflPair;
  };
  for (let ty = 0; ty < tileRows; ty++) {
    for (let tx = 0; tx < tileWidth; tx++) {
      const bx0 = tx * 8, by0 = ty * 8, bw = Math.min(8, stride - bx0), bh = Math.min(8, rows - by0), index = ty * tileWidth + tx;
      tileIndex = index;
      if (kernel && kernel(data, width, height, bx0, by0, bw, bh, tileKernel, onTileCfl, components, stride, nonZero)) continue;
      if (!T) fillFastTile(data, width, height, tile, bx0, by0, bw, bh, colors ||= {keys: new Int32Array(COLOR_SLOTS).fill(-1), values: new Float64Array(COLOR_SLOTS * 3)});
      else for (let by = 0; by < bh; by++) for (let bx = 0; bx < bw; bx++) {
        const offset = (by * bw + bx) * 192;
        for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
          const k = y * 8 + x, at = (Math.min(height - 1, (by0 + by) * 8 + y) * width + Math.min(width - 1, (bx0 + bx) * 8 + x)) * 4;
          const r = T.tables[0][data[at]], g = T.tables[1][data[at + 1]], b = T.tables[2][data[at + 2]];
          const l = signedRoot(lms[0] * r + lms[1] * g + lms[2] * b + BIAS) - ROOT_BIAS;
          const m = signedRoot(lms[3] * r + lms[4] * g + lms[5] * b + BIAS) - ROOT_BIAS;
          const s = signedRoot(lms[6] * r + lms[7] * g + lms[8] * b + BIAS) - ROOT_BIAS;
          tile[offset + k] = (l - m) * 127.5;
          tile[offset + 64 + k] = (l + m) * 127.5;
          tile[offset + 128 + k] = s * 255 - tile[offset + 64 + k];
        }
      }
      transformDCT8BlocksFast(tile, bw * bh);
      correlate(tile, bw * bh, cfl, index, cflScale);
      quantFastTile(tile, bw, bh, by0, bx0, stride, components, steps, cfl.x[index], cfl.b[index], thresholds, nonZero, !!T);
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
  return {width, height, components, quantScale: 256, cfl, epf: 20 * distance * V6.epfScale, xyb: true, ycbcr: false, orientation: 1, alpha, colorSpace: space ?? 'srgb', nonZero};
}

const OWN = {steps: captureXYBSteps, prefer: preferXYB, range: FAST_RANGE};
export const captureXYB = () => kernelHooks.captureXYB ??
  (typeof __RAPIER_JXL_CAPTURE_PHOTO__ === 'undefined' || __RAPIER_JXL_CAPTURE_PHOTO__ === true ? OWN : null);
