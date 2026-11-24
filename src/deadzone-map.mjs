// SPDX-License-Identifier: MIT
import {s2CellMap} from './s2-cells.mjs';
import {pictureCellSums, pictureCellSumsBatch} from './photo-cell-sums.mjs';
import {bandedRGBA} from './photo-reconstruct-bands.mjs';
import {leftDevice, trialDue, phoneLumaSkip} from './device-trial.mjs';
import {TRANSFORMS} from './vardct-strategies.mjs';
import {zoneCellsTask} from './photo-zone-cells.mjs';

const DEADZONE_SCALES = Object.freeze([1, 0.72, 0.82, 1.22, 1.44]);

const E8_SCALES = Object.freeze([1, 0.78, 1.28]);
const E7_SCALES = Object.freeze([1, 0.80, 1.26]), E7_HIGH_SCALES = Object.freeze([1, 0.80]);
const E7_THREE_TO = 0.72, E7_THREE_FROM = 0.85;

export function* deadzoneMapSteps(pictureAt, reference, width, height, signal, effort = 9, basePicture = null, reading = 0, baseQuality = 0, scale0 = null, firstOnly = false) {
  const scales = effort >= 9 ? DEADZONE_SCALES : effort >= 8 ? E8_SCALES : (reading <= E7_THREE_TO || reading > E7_THREE_FROM) ? E7_SCALES : E7_HIGH_SCALES;
  const yOnly = effort < 8, pixels = width * height;
  const stride = Math.ceil(width / 8), rows = Math.ceil(height / 8), n = stride * rows, maps = [], rates = [], scores = [];
  const held = {cells: {}, rebuild: {}, constants: null};
  let layout = null, at = null, score0 = 75;
  const made = new Map();
  try {
  const due = Array.from({length: firstOnly ? 1 : scales.length}, (_, i) => i).filter(i => !(i === 0 && scale0?.cells && scale0.rate && scale0.norms && scale0.layout));
  if (due.length) {
    const picture = due[0] === 0 && basePicture?.rates ? basePicture : yield* pictureAt(new Float64Array(n).fill(scales[due[0]])), task = zoneCellsTask(picture, reference, width, height, yOnly);
    made.set(due[0], {picture, task});
    if (task) {
      for (const i of due.slice(1)) { const p = yield* pictureAt(new Float64Array(n).fill(scales[i])); made.set(i, {picture: p, task: zoneCellsTask(p, reference, width, height, yOnly)}); }
      yield {offload: 'prefetch', tasks: [...made.values()].map(m => m.task).filter(Boolean)};
    }
  }
  const canBatchGpu = !firstOnly && due.length > 1 && !made.get(due[0])?.task &&
    (leftDevice('photo-rebuild', pixels) || trialDue('photo-rebuild', pixels)) && !leftDevice('s2-cells', pixels) && !phoneLumaSkip(pixels, yOnly);
  if (canBatchGpu) {
    if (scale0?.cells && scale0.rate && scale0.norms && scale0.layout) {
      layout = scale0.layout; at = {norms: scale0.norms}; score0 = scale0.score;
      maps.push(scale0.cells); rates.push(scale0.rate); scores.push(scale0.score);
    }
    const maxChunk = Math.max(1, Math.floor((32 * 1024 * 1024) / Math.max(4, pixels * 4)));
    for (let pos = 0; pos < due.length; pos += maxChunk) {
      const chunkIdx = due.slice(pos, pos + maxChunk), rgbas = [], chunkRates = [];
      for (const i of chunkIdx) {
        const early = made.get(i);
        made.delete(i);
        let picture = early ? early.picture : i === 0 && basePicture?.rates ? basePicture : yield* pictureAt(new Float64Array(n).fill(scales[i]));
        layout ??= picture.layout ?? picture.strategyData.blocks.map(({id, bx, by}) => ({id, bx, by}));
        const streamed = picture.zoneSteps ? yield* picture.zoneSteps(yOnly) : null;
        const rgba = streamed && !(streamed.scales) ? streamed : bandedRGBA(picture);
        chunkRates.push(picture.rates);
        rgbas.push(rgba);
        picture = null;
        if (signal?.aborted) throw signal.reason;
      }
      const sumsList = yield* pictureCellSumsBatch(rgbas, reference, width, height, yOnly, held);
      for (let k = 0; k < sumsList.length; k++) {
        const {cells, score, norms} = s2CellMap(sumsList[k], width, height, at);
        if (!at) { at = {norms}; score0 = score; }
        maps.push(cells); rates.push(chunkRates[k]); scores.push(score);
      }
      if (signal?.aborted) throw signal.reason;
    }
  } else for (let i = 0; i < scales.length; i++) {
    if (i === 0 && scale0?.cells && scale0.rate && scale0.norms && scale0.layout) {
      layout = scale0.layout; at = {norms: scale0.norms}; score0 = scale0.score;
      maps.push(scale0.cells); rates.push(scale0.rate); scores.push(scale0.score);
      if (signal?.aborted) throw signal.reason;
      continue;
    }
    const scale = scales[i];
    const early = made.get(i);
    made.delete(i);
    let picture = early ? early.picture : i === 0 && basePicture?.rates ? basePicture : yield* pictureAt(new Float64Array(n).fill(scale));
    layout ??= picture.layout ?? picture.strategyData.blocks.map(({id, bx, by}) => ({id, bx, by}));
    const reply = early?.task ? yield {offload: 'run', task: early.task} : null;
    const rate = reply ? reply.rates : picture.rates;
    const sums = reply ? reply.sums : yield* pictureCellSums(picture, reference, width, height, yOnly, held, true);
    picture = null;
    const {cells, score, norms} = s2CellMap(sums, width, height, at);
    if (!at) { at = {norms}; score0 = score; }
    maps.push(cells); rates.push(rate); scores.push(score);
    if (signal?.aborted) throw signal.reason;
    if (firstOnly) return {cells, rate, norms: at.norms, layout, score: score0};
  }
  const totals = new Float64Array(scales.length), deltas = new Float64Array(scales.length);
  let T = 0, Rt = 0, zonedCells = 0;
  for (let i = 0; i < n; i++) {
    T += maps[0][i]; Rt += rates[0][i];
    for (let k = 1; k < scales.length; k++) totals[k] += maps[k][i];
  }
  const lam = effort >= 9 ? 2.35 : 2.4;
  const lambda = lam * (30 / Math.max(8, 100 - score0)), map = new Float64Array(n).fill(1);
  if (!(T > 0 && Rt > 0)) return map;
  let mChosen = 0;
  for (const b of layout) {
    const t = TRANSFORMS[b.id], bw = Math.max(1, t.width / 8), bh = Math.max(1, t.height / 8);
    let best = 0, bestJ = Infinity, bestM = 0, m0 = 0;
    for (let k = 0; k < scales.length; k++) {
      let m = 0;
      for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) m += maps[k][(b.by + y) * stride + b.bx + x];
      if (k === 0) m0 = m;
      const J = m / T + lambda * rates[k][b.by * stride + b.bx] / Rt;
      if (J < bestJ) { bestJ = J; best = k; bestM = m; }
    }
    mChosen += bestM;
    if (best) deltas[best] += bestM - m0;
    if (scales[best] < 0.99) zonedCells += bw * bh;
    for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) map[(b.by + y) * stride + b.bx + x] = scales[best];
  }
  const dLnD = baseQuality > 0 ? 0.09 / Math.max(0.19, 0.1 + 0.09 * (100 - Math.min(99, baseQuality))) : 0.065;
  const dzGain = scores.length > 1 ? Math.max(0, scores[1] - score0) : 0;
  const slope = Math.max(0.45, Math.min(1.25,
    0.45 * (dzGain / Math.max(0.05, -Math.log(scales[1] ?? 0.8))) * 6.0 * dLnD +
    0.55 * Math.max(8, 100 - score0) * 0.62 * dLnD));
  let scoreZoned = score0;
  if (scores.length > 2) {
    for (let k = 1; k < scales.length; k++) {
      scoreZoned += (scales[k] < 1 ? totals[k] < T : totals[k] > T)
        ? (deltas[k] / (totals[k] - T)) * (scores[k] - score0) : 0;
    }
  } else scoreZoned = score0 + dzGain * Math.min(1, (zonedCells / Math.max(1, n)) * 1.65) + 0.01;
  const sDrop = ((mChosen - T) / Math.max(1e-9, T)) * Math.max(10, 100 - score0) * 0.42;
  map.qShift = Math.max(-1.2, Math.min(1.8, sDrop));
  map.scoreZoned = scoreZoned;
  map.slope = slope;
  map.cells0 = maps[0];
  map.rates0 = rates[0];
  map.norms0 = at?.norms ?? null;
  map.layout0 = layout;
  map.score0 = score0;
  return map;
  } finally { held.cells.release?.(); held.rebuild.release?.(); }
}
deadzoneMapSteps.threeScalesTo = E7_THREE_TO;
deadzoneMapSteps.cellSums = pictureCellSums;
