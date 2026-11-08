// SPDX-License-Identifier: MIT
import {QUANT_SHAPE, transformDCT8BlocksFast} from './photo-dct.mjs';
import {V6} from './photo-v6-settings.mjs';
import {calibration} from './quality-calibration.mjs';
import {screenLike} from './screen.mjs';

const BIAS = 0.0037930732552754493, ROOT_BIAS = Math.cbrt(BIAS);
const ROOTS = Float64Array.from({length: 4113}, (_, i) => i ? Math.cbrt(i / 4096) : 0);
const LINEAR = Float64Array.from({length: 256}, (_, i) => {
  const v = i / 255;
  return i <= 10 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
});
const cubeRootFast = v => { const s = v * 4096, a = Math.floor(s); return ROOTS[a] + (ROOTS[a + 1] - ROOTS[a]) * (s - a); };
const W_AC = [0, 1, 2].map(c => Float64Array.from({length: 64}, (_, k) =>
  k ? [0.84, 7, 5.6][c] * QUANT_SHAPE[k] * (1 + [1, 0, 5][c] * Math.sqrt(((k & 7) * (k & 7) + (k >> 3) * (k >> 3)) / 98)) * V6.tune(c, k) : 1
));
const W_DC = [0, 1, 2].map(c => [1.05, 7, 12.6][c] * 0.25 * V6.dcScale[c]);
const THRESH = [0, 1, 2].map(c => Float64Array.from({length: 64}, (_, k) => {
  const high = (k & 7) >= 4 || (k >> 3) >= 4;
  return k ? V6.deadzone[c * 2 + (high ? 1 : 0)] : 0.5;
}));
const INV_STEP = [0, 1, 2].map(c => Float64Array.from({length: 64}, (_, k) =>
  k ? 1 / (THRESH[c][k] * W_AC[c][k]) : 1 / (0.5 * W_DC[c])
));
const BINS = 128, MIN_LOG = -6, SCALE_LOG = 8, BIAS_BIN = (127 << 3) + MIN_LOG * SCALE_LOG;
const scratchTile = new Float64Array(256 * 192), f32 = new Float32Array(1), i32 = new Int32Array(f32.buffer);

const XYB = new Float64Array(3);
function xyb(data, at) {
  const r = LINEAR[data[at]], g = LINEAR[data[at + 1]], b = LINEAR[data[at + 2]];
  const l = cubeRootFast(0.3 * r + 0.622 * g + 0.078 * b + BIAS) - ROOT_BIAS;
  const m = cubeRootFast(0.23 * r + 0.692 * g + 0.078 * b + BIAS) - ROOT_BIAS;
  const s = cubeRootFast(0.24342268924547819 * r + 0.20476744424496821 * g + 0.5518098665095536 * b + BIAS) - ROOT_BIAS;
  XYB[0] = (l - m) * 127.5; XYB[1] = (l + m) * 127.5; XYB[2] = s * 255 - XYB[1];
}
export function extractFitStats(picture) {
  const data = picture?.data, width = picture?.width ?? 0, height = picture?.height ?? 0;
  if (!(data instanceof Uint8Array || data instanceof Uint8ClampedArray) || (picture?.bitDepth ?? 8) !== 8 ||
      width < 1 || height < 1 || data.length < width * height * 4) return null;
  const bwTotal = Math.max(1, Math.floor(width / 8)), bhTotal = Math.max(1, Math.floor(height / 8));
  const gx = Math.min(bwTotal, 16), gy = Math.min(bhTotal, 16), N = gx * gy;
  const adjDc = new Float64Array(N * 3);
  for (let iy = 0; iy < gy; iy++) {
    const by = Math.min(bhTotal - 1, Math.floor((iy + 0.5) * bhTotal / gy));
    const top = Math.min(height - 1, by * 8), rows = data.subarray(top * width * 4, Math.min(height, by * 8 + 8) * width * 4);
    for (let ix = 0; ix < gx; ix++) {
      const bx = Math.min(bwTotal - 1, Math.floor((ix + 0.5) * bwTotal / gx));
      const idx = iy * gx + ix, offset = idx * 192;
      for (let y = 0; y < 8; y++) {
        const row = (Math.min(height - 1, by * 8 + y) - top) * width;
        for (let x = 0; x < 8; x++) {
          const k = offset + y * 8 + x;
          xyb(rows, (row + Math.min(width - 1, bx * 8 + x)) * 4);
          scratchTile[k] = XYB[0]; scratchTile[k + 64] = XYB[1]; scratchTile[k + 128] = XYB[2];
        }
      }
      const bxNext = Math.min(bwTotal - 1, bx + 1);
      let sx = 0, sy = 0, sb = 0;
      for (let y = 0; y < 8; y++) {
        const row = (Math.min(height - 1, by * 8 + y) - top) * width;
        for (let x = 0; x < 8; x++) {
          xyb(rows, (row + Math.min(width - 1, bxNext * 8 + x)) * 4);
          sx += XYB[0]; sy += XYB[1]; sb += XYB[2];
        }
      }
      adjDc[idx * 3] = sx * 0.125; adjDc[idx * 3 + 1] = sy * 0.125; adjDc[idx * 3 + 2] = sb * 0.125;
    }
  }
  transformDCT8BlocksFast(scratchTile, N);
  const acHist = new Float64Array(BINS), dcHist = new Float64Array(BINS), blkMaxHist = new Float64Array(BINS);
  for (let n = 0; n < N; n++) {
    const at = n * 192;
    let yy = 0, xy = 0, bySum = 0;
    for (let k = 1; k < 64; k++) {
      const l = scratchTile[at + 64 + k];
      yy += l * l; xy += scratchTile[at + k] * l; bySum += scratchTile[at + 128 + k] * l;
    }
    const rx = Math.max(-128, Math.min(127, Math.round(0.7 * 84 * xy / (yy + 1)))) / 84;
    const rb = Math.max(-128, Math.min(127, Math.round(0.7 * 84 * bySum / (yy + 1)))) / 84;
    for (let c = 0; c < 3; c++) {
      const base = at + c * 64, ratio = c === 0 ? rx : c === 2 ? rb : 0, inv = INV_STEP[c];
      f32[0] = Math.abs(scratchTile[base] - adjDc[n * 3 + c]) * inv[0];
      if (f32[0] > 0) { const bin = (i32[0] >> 20) - BIAS_BIN; if (bin >= 0) dcHist[bin < BINS ? bin : BINS - 1]++; }
      let maxBin = -1;
      for (let k = 1; k < 64; k++) {
        f32[0] = Math.abs(scratchTile[base + k] - ratio * scratchTile[at + 64 + k]) * inv[k];
        if (f32[0] > 0) { const bin = (i32[0] >> 20) - BIAS_BIN; if (bin >= 0) { const cl = bin < BINS ? bin : BINS - 1; acHist[cl]++; if (cl > maxBin) maxBin = cl; } }
      }
      if (maxBin >= 0) blkMaxHist[maxBin]++;
    }
  }
  const totalBlocks = Math.ceil(width / 8) * Math.ceil(height / 8), scale = totalBlocks / N;
  for (let i = 0; i < BINS; i++) { acHist[i] *= scale; dcHist[i] *= scale; blkMaxHist[i] *= scale; }
  return {acHist, dcHist, blkMaxHist, blocks: totalBlocks, isScreen: screenLike(data, width, height)};
}

export function fitTerms(stats, quality, effort = 3) {
  const qc = Math.min(quality, 99.9);
  const dRaw = qc >= 99 ? 0.19 - 0.16 * (qc - 99) : qc >= 30 ? 0.1 + (100 - qc) * 0.09 : 53 / 3000 * qc * qc - 23 / 20 * qc + 25;
  const dist = Math.max(0.046, calibration(qc, effort === 1 ? 'fast' : 'full') * dRaw);
  if (!stats) return {dist};
  const strength = Math.max(0, Math.min(1, (90 - qc) / 15));
  const stepScale = 1 - 0.1 * strength, acScale = 1.175 + 0.075 * strength;
  const tauAc = Math.log2(dist * stepScale * acScale), tauDc = Math.log2(dist * stepScale);
  const evalH = (hist, tau) => {
    const pos = (tau - MIN_LOG) * SCALE_LOG, idx = Math.floor(pos), rem = 1 - (pos - idx);
    let nz = 0, mag = 0;
    if (idx >= 0 && idx < BINS) { const h = hist[idx]; nz += h * rem; mag += h * 0.5 * rem * rem / SCALE_LOG; }
    for (let i = Math.max(0, idx + 1); i < BINS; i++) { const h = hist[i]; nz += h; mag += h * (i + 0.5 - pos) / SCALE_LOG; }
    return {nz, mag};
  };
  const ac = evalH(stats.acHist, tauAc), dc = evalH(stats.dcHist, tauDc), blk = evalH(stats.blkMaxHist, tauAc);
  const totalAc = stats.blocks * 189, rho = Math.max(1e-6, Math.min(0.5, ac.nz / totalAc));
  const posEntropy = totalAc * (-rho * Math.log2(rho) - (1 - rho) * Math.log2(1 - rho));
  const baseHdr = 45 + 515 * (1 - Math.exp(-(stats.blocks - 1) / 4));
  const hdr = baseHdr + 0.377 * Math.min(stats.blocks, 6144) + 0.255 * Math.max(0, stats.blocks - 6144);
  return {dist, hdr, terms: [ac.nz, ac.mag, posEntropy, blk.nz, dc.mag]};
}
const COEFFICIENTS = [0.170656, 0.135745, 0.04367, 0.55092, 0.14114];
export const fitScale = (q, effort) => Math.exp(-(effort >= 6 ? 0.315 + 0.01516 * Math.max(0, 50 - q) : 0.0388));
export function predictFitBytes(stats, quality, effort = 3) {
  const {dist, hdr, terms} = fitTerms(stats, quality, effort);
  if (!stats) {
    const varBytes = 1000 * Math.pow(dist, -0.78);
    return {hdr: 100, varBytes, total: 100 + varBytes};
  }
  const c = COEFFICIENTS;
  const varBytes = c[0] * terms[0] + c[1] * terms[1] + c[2] * terms[2] + c[3] * terms[3] + c[4] * terms[4];
  return {hdr, varBytes, total: hdr + varBytes};
}
