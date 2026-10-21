// SPDX-License-Identifier: MIT
import {complete} from './bits.mjs';

const GRAIN_BIAS = .0037930732552754493;
const GRAIN_NORMAL = .22 * Math.sqrt(1.28 * (4 * (127 / 128) * (127 / 128) + 2 * (1 / 128) * (1 / 128)));
const GRAIN_LINEAR = Float64Array.from({length: 256}, (_, i) => {
  const v = i / 255;
  if (i <= 10) return v / 12.92;
  const b = (v + .055) / 1.055, s = b * b;
  let fifth = Math.sqrt(Math.sqrt(s));
  for (let j = 0; j < 12; j++) fifth = (4 * fifth + s / (fifth * fifth * fifth * fifth)) / 5;
  return s * fifth;
});
function grainRoot(v) {
  let r = Math.sqrt(Math.sqrt(v));
  for (let i = 0; i < 10; i++) r = (2 * r + v / (r * r)) / 3;
  return r;
}
const GRAIN_ROOT_BIAS = grainRoot(GRAIN_BIAS);
function grainLinear(v) {
  const at = Math.max(0, Math.min(254, Math.floor(v)));
  return GRAIN_LINEAR[at] + (GRAIN_LINEAR[at + 1] - GRAIN_LINEAR[at]) * (v - at);
}
function grainOpsin(r, g, b) {
  const lr = grainLinear(r), lg = grainLinear(g), lb = grainLinear(b);
  const l = grainRoot(.3 * lr + .622 * lg + .078 * lb + GRAIN_BIAS);
  const m = grainRoot(.23 * lr + .692 * lg + .078 * lb + GRAIN_BIAS);
  const dr = grainLinear(Math.min(255, r + .5)) - grainLinear(Math.max(0, r - .5));
  const dg = grainLinear(Math.min(255, g + .5)) - grainLinear(Math.max(0, g - .5));
  const db = grainLinear(Math.min(255, b + .5)) - grainLinear(Math.max(0, b - .5));
  return {intensity: (l + m - 2 * GRAIN_ROOT_BIAS) / 4,
    derivative: ((.3 * dr + .622 * dg + .078 * db) / (3 * l * l) +
      (.23 * dr + .692 * dg + .078 * db) / (3 * m * m)) / 2};
}
function grainMedian(values) {
  values.sort((a, b) => a - b);
  const n = values.length;
  return n & 1 ? values[n >> 1] : (values[(n >> 1) - 1] + values[n >> 1]) / 2;
}
function grainPatch(data, luma, width, x0, y0, admission = true) {
  const high = [], levels = new Set();
  let sum = 0, square = 0, sx = 0, sy = 0, red = 0, green = 0, blue = 0, clipped = 0;
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
    const at = (y0 + y) * width + x0 + x, v = luma[at], p = at * 4;
    if (data[p + 3] !== 255) return null;
    sum += v; square += v * v; sx += v * (x - 7.5); sy += v * (y - 7.5);
    red += data[p]; green += data[p + 1]; blue += data[p + 2];
    if (v < 3 || v > 252) clipped++;
    levels.add(Math.round(v));
    if (!(x & 1) && !(y & 1)) high.push((luma[at] - luma[at + 1] - luma[at + width] + luma[at + width + 1]) / 2);
  }
  if (admission && (clipped > 32 || levels.size < 12)) return null;
  const centered = grainMedian(high);
  const sigma = grainMedian(high.map(v => Math.abs(v - centered))) * 1.482602218505602;
  const mean = sum / 256, variance = Math.max(0, square / 256 - mean * mean - (sx * sx + sy * sy) / (5440 * 256));
  return {x: x0, y: y0, mean, sigma, structure: variance / (sigma * sigma + .25),
    ...grainOpsin(red / 256, green / 256, blue / 256)};
}
function grainLuma(data, width, height, luma = new Float32Array(width * height)) {
  for (let i = 0, p = 0; i < luma.length; i++, p += 4) luma[i] = (77 * data[p] + 150 * data[p + 1] + 29 * data[p + 2]) / 256;
  return luma;
}
function grainCurve(samples) {
  const diagonal = new Float64Array(8), above = new Float64Array(7), rhs = new Float64Array(8);
  const regularize = .01 * samples.length;
  for (const sample of samples) {
    const pos = Math.max(0, Math.min(6.999999, sample.intensity * 6)), at = Math.floor(pos), hi = pos - at, lo = 1 - hi;
    const value = sample.amplitude * sample.derivative / GRAIN_NORMAL;
    diagonal[at] += lo * lo; diagonal[at + 1] += hi * hi; above[at] += lo * hi;
    rhs[at] += lo * value; rhs[at + 1] += hi * value;
  }
  for (let i = 0; i < 7; i++) { diagonal[i] += regularize; diagonal[i + 1] += regularize; above[i] -= regularize; }
  for (let i = 1; i < 8; i++) {
    const ratio = above[i - 1] / diagonal[i - 1];
    diagonal[i] -= ratio * above[i - 1]; rhs[i] -= ratio * rhs[i - 1];
  }
  const lut = new Float64Array(8);
  for (let i = 7; i >= 0; i--) lut[i] = Math.max(0, Math.min(1023 / 1024,
    (rhs[i] - (i < 7 ? above[i] * lut[i + 1] : 0)) / diagonal[i]));
  for (let i = 0; i < 8; i++) lut[i] = Math.round(lut[i] * 1024) / 1024;
  return lut.some(v => v) ? lut : null;
}

export function prepareNoise(data, width, height, strength = .8) { return complete(prepareNoiseSteps(data, width, height, strength)); }
export function* prepareNoiseSteps(data, width, height, strength = .8) {
  if (width < 32 || height < 32) return {data, lut: null, patches: 0, sigma: 0};
  const luma = grainLuma(data, width, height), patches = [], byIntensity = Array.from({length: 8}, () => []);
  const columns = Math.floor(width / 16), rows = Math.floor(height / 16);
  for (let by = 0; by < rows; by++) {
    for (let bx = 0; bx < columns; bx++) {
      const patch = grainPatch(data, luma, width, bx * 16, by * 16);
      if (patch && patch.sigma >= .85 && patch.structure <= 6) {
        patches.push(patch); byIntensity[Math.min(7, Math.floor(patch.mean / 32))].push(patch.sigma);
      }
    }
    yield (by + 1) / (rows * 4);
  }
  if (patches.length < Math.max(4, columns * rows * .25)) return {data, lut: null, patches: patches.length, sigma: 0};
  const sigmas = byIntensity.map(values => values.length ? grainMedian(values) : 0);
  const sigma = grainMedian(patches.map(p => p.sigma));
  if (sigma < .85) return {data, lut: null, patches: patches.length, sigma};
  for (let i = 0; i < 8; i++) if (!sigmas[i]) {
    let before = i - 1, after = i + 1;
    while (before >= 0 && !byIntensity[before].length) before--;
    while (after < 8 && !byIntensity[after].length) after++;
    sigmas[i] = before < 0 ? sigmas[after] : after >= 8 ? sigmas[before] :
      (sigmas[before] * (after - i) + sigmas[after] * (i - before)) / (after - before);
  }
  const out = new Uint8Array(data), sums = new Float64Array(width), squares = new Float64Array(width), opaque = new Uint8Array(width);
  for (let y = 0; y < 5; y++) for (let x = 0; x < width; x++) {
    const at = y * width + x, v = luma[at]; sums[x] += v; squares[x] += v * v; opaque[x] += data[at * 4 + 3] === 255;
  }
  for (let y = 2; y < height - 2; y++) {
    let sum = 0, square = 0, count = 0;
    for (let x = 0; x < 5; x++) { sum += sums[x]; square += squares[x]; count += opaque[x]; }
    for (let x = 2; x < width - 2; x++) {
      const at = y * width + x, v = luma[at], mean = sum / 25, variance = Math.max(0, square / 25 - mean * mean);
      const location = Math.max(0, Math.min(6.99999, v / 32 - .5)), lo = Math.floor(location), frac = location - lo;
      const localSigma = sigmas[lo] * (1 - frac) + sigmas[lo + 1] * frac;
      if (count === 25) {
        const gain = strength * Math.min(1, localSigma * localSigma / (variance + .000001));
        const difference = gain * (v - mean), p = at * 4;
        for (let c = 0; c < 3; c++) out[p + c] = Math.max(0, Math.min(255, Math.round(data[p + c] - difference)));
      }
      if (x + 3 < width) { sum += sums[x + 3] - sums[x - 2]; square += squares[x + 3] - squares[x - 2]; count += opaque[x + 3] - opaque[x - 2]; }
    }
    if (y + 3 < height) for (let x = 0; x < width; x++) {
      const old = (y - 2) * width + x, next = (y + 3) * width + x, a = luma[old], b = luma[next];
      sums[x] += b - a; squares[x] += b * b - a * a; opaque[x] += (data[next * 4 + 3] === 255) - (data[old * 4 + 3] === 255);
    }
    if (!(y & 15)) yield .25 + .5 * (y + 1) / height;
  }
  const cleaned = grainLuma(out, width, height, luma), observations = [];
  for (let i = 0; i < patches.length; i++) {
    const before = patches[i], after = grainPatch(out, cleaned, width, before.x, before.y, false);
    if (after) observations.push({...before, amplitude: Math.sqrt(Math.max(0, before.sigma * before.sigma - after.sigma * after.sigma))});
    if (!(i & 127)) yield .75 + .25 * (i + 1) / patches.length;
  }
  const lut = observations.length >= 4 ? grainCurve(observations) : null;
  return {data: lut ? out : data, lut, patches: patches.length, sigma};
}
