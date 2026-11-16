// SPDX-License-Identifier: MIT
import {s2CellSums, s2CellMap} from './s2-cells.mjs';
import {bandedRGBA} from './photo-reconstruct-bands.mjs';
import {rebuildPicture} from './photo-rebuild.mjs';
import {rebuildKernels} from './rebuild-kernels.mjs';
import {xybKernelConstants} from './vardct-render.mjs';
import {DEFAULT_OPSIN} from './opsin.mjs';
import {nativeTables, nativeByte} from './photo-output.mjs';
import {trialDue, tryStage, leftDevice} from './device-trial.mjs';
import {TRANSFORMS} from './vardct-strategies.mjs';

const DEADZONE_SCALES = Object.freeze([1, 0.72, 0.82, 1.22, 1.44]);
const E8_SCALES = Object.freeze([1, 0.78, 1.28]);
const E7_SCALES = Object.freeze([1, 0.80, 1.26]), E7_HIGH_SCALES = Object.freeze([1, 0.80]);
const E7_THREE_TO = 0.72;

export function* deadzoneMapSteps(pictureAt, reference, width, height, signal, effort = 9, basePicture = null, reading = 0, baseQuality = 0) {
  const scales = effort >= 9 ? DEADZONE_SCALES : effort >= 8 ? E8_SCALES : reading <= E7_THREE_TO ? E7_SCALES : E7_HIGH_SCALES;
  const yOnly = effort < 8, pixels = width * height;
  const stride = Math.ceil(width / 8), rows = Math.ceil(height / 8), n = stride * rows, maps = [], rates = [], scores = [];
  const refBytes = reference?.rgba, canGpuCells = !!(refBytes && (refBytes instanceof Uint8Array || refBytes instanceof Uint8ClampedArray) && width >= 8 && height >= 8);
  const cellsHeld = {}, rebuildHeld = {};
  let constants = null;
  let layout = null, at = null, score0 = 75;
  try {
  for (let i = 0; i < scales.length; i++) {
    const scale = scales[i];
    let picture = i === 0 && basePicture?.rates ? basePicture : yield* pictureAt(new Float64Array(n).fill(scale));
    layout ??= picture.layout ?? picture.strategyData.blocks.map(({id, bx, by}) => ({id, bx, by}));
    const rate = picture.rates;
    let rgba = null;
    if (canGpuCells && !leftDevice('photo-rebuild', pixels) && !trialDue('photo-rebuild', pixels)) {
      constants ??= xybKernelConstants(DEFAULT_OPSIN.inverseMatrix.map(Math.fround), DEFAULT_OPSIN.opsinBiases, 255);
      const built = yield {gpu: {kind: 'photo-rebuild', image: picture, rebuild: rebuildPicture, kernels: rebuildKernels(), constants, native: {nativeTables, nativeByte}, held: rebuildHeld, keep: false}};
      if (built?.rgba) rgba = built.rgba;
    }
    rgba ??= bandedRGBA(picture);
    picture = null;
    let sums = null;
    if (canGpuCells && !leftDevice('s2-cells', pixels)) {
      const req = {gpu: {kind: 's2-cells', reference: refBytes, decoded: rgba, width, height, yOnly, held: cellsHeld}};
      sums = trialDue('s2-cells', pixels)
        ? yield* tryStage('s2-cells', pixels, req, function* () { return s2CellSums(reference, {rgba}, width, height, yOnly); })
        : (yield req) ?? s2CellSums(reference, {rgba}, width, height, yOnly);
    } else sums = s2CellSums(reference, {rgba}, width, height, yOnly);
    const {cells, score, norms} = s2CellMap(sums, width, height, at);
    if (!at) { at = {norms}; score0 = score; }
    maps.push(cells); rates.push(rate); scores.push(score);
    if (signal?.aborted) throw signal.reason;
  }
  let T = 0, Rt = 0, zonedCells = 0;
  for (let i = 0; i < n; i++) { T += maps[0][i]; Rt += rates[0][i]; }
  const lam = effort >= 9 ? 2.35 : 2.4;
  const lambda = lam * (30 / Math.max(8, 100 - score0)), map = new Float64Array(n).fill(1);
  if (!(T > 0 && Rt > 0)) return map;
  let mChosen = 0;
  for (const b of layout) {
    const t = TRANSFORMS[b.id], bw = Math.max(1, t.width / 8), bh = Math.max(1, t.height / 8);
    let best = 0, bestJ = Infinity, bestM = 0;
    for (let k = 0; k < scales.length; k++) {
      let m = 0;
      for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) m += maps[k][(b.by + y) * stride + b.bx + x];
      const J = m / T + lambda * rates[k][b.by * stride + b.bx] / Rt;
      if (J < bestJ) { bestJ = J; best = k; bestM = m; }
    }
    mChosen += bestM;
    if (scales[best] < 0.99) zonedCells += bw * bh;
    for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) map[(b.by + y) * stride + b.bx + x] = scales[best];
  }
  const dLnD = baseQuality > 0 ? 0.09 / Math.max(0.19, 0.1 + 0.09 * (100 - Math.min(99, baseQuality))) : 0.065;
  const dzGain = scores.length > 1 ? Math.max(0, scores[1] - score0) : 0;
  const slope = Math.max(0.45, Math.min(1.25,
    0.45 * (dzGain / Math.max(0.05, -Math.log(scales[1] ?? 0.8))) * 6.0 * dLnD +
    0.55 * Math.max(8, 100 - score0) * 0.62 * dLnD));
  const scoreZoned = score0 + dzGain * Math.min(1, (zonedCells / Math.max(1, n)) * 1.65) + 0.01;
  const sDrop = ((mChosen - T) / Math.max(1e-9, T)) * Math.max(10, 100 - score0) * 0.42;
  map.qShift = Math.max(-1.2, Math.min(1.8, sDrop));
  map.scoreZoned = scoreZoned;
  map.slope = slope;
  map.cells0 = maps[0];
  map.score0 = score0;
  return map;
  } finally { cellsHeld.release?.(); rebuildHeld.release?.(); }
}
deadzoneMapSteps.threeScalesTo = E7_THREE_TO;
