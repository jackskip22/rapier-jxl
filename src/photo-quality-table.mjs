// SPDX-License-Identifier: MIT
import {fault} from './fault.mjs';

export const QUALITY_TARGETS = /* @__PURE__ */ Object.freeze(/* @__PURE__ */ [
  -29.97381362, -6.940466435, -1.25470135, 3.3893708399999998, 7.09033958, 10.51464371, 12.665079515, 16.713258590000002, 18.673968705, 21.105531125,
  22.957540065, 25.223973105, 27.00507493, 27.978122579999997, 29.825917805, 31.415932750000003, 32.572708275, 33.175092295, 34.309781265, 36.30099314,
  37.208438494999996, 38.08691582, 38.7998353, 40.32459973, 40.950025395, 42.170106745, 42.883824669999996, 43.57407828, 44.420829839999996, 45.20957972,
  46.18172579, 47.134427525, 47.931344015, 48.609038235, 49.61987626, 49.979236875, 50.20559565, 51.045848305, 51.456134975, 52.06415233,
  52.861199325, 53.531656915, 54.32905192, 54.71133428, 55.176613775, 55.90871946, 56.076872475, 57.025085585, 57.467758305000004, 57.89373923,
  59.026523275, 59.48238025, 59.7317854, 60.170542575, 60.566979685, 60.566979685, 61.38655503, 61.8244871, 62.142594079999995, 62.522252935,
  62.717870965, 63.065376825, 63.533200355, 64.03046348, 64.335776255, 64.817456795, 65.15700075000001, 65.78047209, 66.17071418, 66.69645169,
  66.69645169, 67.78941277, 68.17985284, 68.45086642999999, 68.79570254000001, 68.95193511, 69.87394918999999, 71.26413471000001, 71.997727835, 73.194730445,
  74.03065663, 75.124830855, 76.03320187, 77.12701476000001, 78.305614905, 78.98458758000001, 79.99187979, 81.120978295, 82.28456064, 83.014497415,
  84.132846075, 85.044493085, 85.82950024499999, 86.81750979, 87.38892515, 88.12254154, 88.758621995, 89.20636776, 89.60070468, 90.069661795,
  100,
].map((target, quality) => Object.freeze([quality, target])));

export const QUALITY_CALIBRATION = /* @__PURE__ */ Object.freeze({
  metric: 'SSIMULACRA 2',
  metricVersion: 'libjxl 0.12.0',
  libwebp: '1.6.0',
  statistic: 'Kodak 24 median; cumulative maximum across increasing quality',
  interpolation: 'linear between adjacent integer qualities',
  measuredMinimum: 0,
  measuredMaximum: 99,
  samplesPerQuality: 24,
  exactQuality: 100,
  evidenceSha256: 'ac4ec7774a8d1fe1a9af123f108d4ff977ff4fdb64052b4cf7049a74ce91a808',
  inputsSha256: 'b58ba691c6b8bf5f69c30d9a147573841f02a3b112bfd75eb08b87a338318065',
});

function at(quality) {
  const lower = Math.floor(quality), value = QUALITY_TARGETS[lower][1];
  return lower === 100 ? value : value + (quality - lower) * (QUALITY_TARGETS[lower + 1][1] - value);
}

export function qualityTarget(quality) {
  if (typeof quality !== 'number' || !Number.isFinite(quality) || quality < 1 || quality > 100)
    throw fault('JXL_OPTIONS', 'quality must be a finite number from 1 to 100.');
  return at(quality);
}

export function askedLook(quality) {
  if (typeof quality !== 'number' || !Number.isFinite(quality) || quality < 0 || quality > 1)
    throw fault('JXL_OPTIONS', 'quality must be a finite number from 0 to 1.');
  return at(quality * 100);
}

export const REGION_OFFSETS = /* @__PURE__ */ Object.freeze({whole: 1.25, small: 0.9});
export const regionTarget = (q, small = false) => askedLook(q) + (small ? REGION_OFFSETS.small : REGION_OFFSETS.whole);

export const MEASURED_ABOVE = /* @__PURE__ */ Object.freeze([86.85, 87.88, 88.9, 89.93, 90.95, 91.98, 93]);
export function measuredLook(q) {
  const published = askedLook(q), x = q * 100;
  if (x <= 92 + 1e-9 || x >= 100) return published;
  const lower = Math.floor(x), from = lower === 92 ? QUALITY_TARGETS[92][1] : MEASURED_ABOVE[lower - 93];
  const to = lower === 99 ? 100 : MEASURED_ABOVE[lower - 92];
  return from + (to - from) * (x - lower);
}

export const SMALL_SIDE = 128;
export const smallPicture = (width, height) => Math.min(width, height) < SMALL_SIDE;
