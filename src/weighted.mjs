// Rapier's JPEG XL encoder: the self-correcting (weighted) predictor. MIT (images/jxl/LICENSE).
import {kernelHooks} from './kernel-hooks.mjs';
import {packSigned} from './bits.mjs';
import {countToken, writeHybrid} from './prefix.mjs';
import {LZ77, RESIDUAL_CONFIG} from './modular.mjs';

import {WEIGHTED_PREDICTOR, WEIGHTED_PROPERTY, WEIGHTED_CUTS, WEIGHTED_BUCKET} from './weighted-policy.mjs';
export {WEIGHTED_PREDICTOR, WEIGHTED_PROPERTY, WEIGHTED_CUTS};
const DIVISORS = Int32Array.from({length: 64}, (_, i) => Math.floor(16777216 / (i + 1)));
const calculateWeight = (sum, most) => { const shift = Math.max(0, 26 - Math.clz32(sum + 1)); return 4 + ((most * DIVISORS[sum >> shift]) >> shift); };
const WEIGHTS = [12, 13].map(most => Int32Array.from({length: 2048}, (_, sum) => calculateWeight(sum, most)));
const WEIGHTS12 = WEIGHTS[0], WEIGHTS13 = WEIGHTS[1];
const SINGLE = new Int32Array(WEIGHTED_CUTS.length + 1);
let weightedScratch;

export function codeWeighted(w, targets, plane, width, height, offset = 0, contextOf = SINGLE, residuals, properties) {
  if (kernelHooks.weighted?.(w, targets, plane, width, height, offset, contextOf, residuals, properties)) return;
  const stride = width + 2;
  const state = weightedScratch && weightedScratch[0].length >= 2 * stride ? weightedScratch : Array.from({length: 6}, (_, i) => new Int32Array(i < 5 ? 2 * stride : 8));
  weightedScratch = null;
  for (const array of state) array.fill(0);
  const [errors0, errors1, errors2, errors3, error, runContexts] = state;
  let run = 0;
  const emit = (context, value, config = RESIDUAL_CONFIG, base = 0) => { if (w) writeHybrid(w, targets[context], config, value, base); else countToken(config, value, targets[context], base); };
  const flush = () => {
    if (!run) return;
    if (run > LZ77.minLength) { emit(runContexts[0], 0); emit(runContexts[1], run - LZ77.minLength - 1, LZ77.lengthConfig, LZ77.minSymbol); }
    else for (let i = 0; i < run; i++) emit(runContexts[i], 0);
    run = 0;
  };
  for (let y = 0, index = 0; y < height; y++) {
    const cur = y & 1 ? 0 : stride, prev = y & 1 ? stride : 0, lastX = width - 1;
    let W = y ? plane[index - width] * 8 : 0, N = W, teW = 0, teN = error[prev], teNW = teN;
    for (let x = 0; x < width; x++, index++) {
      const NE = x < lastX && y ? plane[index - width + 1] * 8 : N;
      const n = prev + x, ne = x < lastX ? n + 1 : n, nw = x ? n - 1 : n;
      const s0 = errors0[n] + errors0[ne] + errors0[nw], s1 = errors1[n] + errors1[ne] + errors1[nw];
      const s2 = errors2[n] + errors2[ne] + errors2[nw], s3 = errors3[n] + errors3[ne] + errors3[nw];
      let w0 = s0 < 2048 ? WEIGHTS13[s0] : calculateWeight(s0, 13), w1 = s1 < 2048 ? WEIGHTS12[s1] : calculateWeight(s1, 12);
      let w2 = s2 < 2048 ? WEIGHTS12[s2] : calculateWeight(s2, 12), w3 = s3 < 2048 ? WEIGHTS12[s3] : calculateWeight(s3, 12);
      const teNE = error[ne], sumWN = teN + teW;
      let most = teW, absMost = teW < 0 ? -teW : teW;
      let a = teN < 0 ? -teN : teN; if (a > absMost) { absMost = a; most = teN; }
      a = teNW < 0 ? -teNW : teNW; if (a > absMost) { absMost = a; most = teNW; }
      a = teNE < 0 ? -teNE : teNE; if (a > absMost) most = teNE;
      if (properties) properties[index] = most;
      const p0 = W + NE - N, p1 = N - (((sumWN + teNE) * 16) >> 5), p2 = W - (((sumWN + teNW) * 10) >> 5);
      const p3 = N - (((teNW + teN + teNE) * 7) >> 5);
      const shift = 27 - Math.clz32(w0 + w1 + w2 + w3);
      w0 >>= shift; w1 >>= shift; w2 >>= shift; w3 >>= shift;
      const sum = w0 + w1 + w2 + w3;
      let pred = Math.floor(((sum >> 1) - 1 + p0 * w0 + p1 * w1 + p2 * w2 + p3 * w3) * DIVISORS[sum - 1] / 16777216);
      if (((teN ^ teW) | (teN ^ teNW)) <= 0) {
        let lo = W < NE ? W : NE, hi = W < NE ? NE : W;
        if (N < lo) lo = N; else if (N > hi) hi = N;
        pred = pred < lo ? lo : pred > hi ? hi : pred;
      }
      const value = plane[index], r = value - ((pred + 3) >> 3) - offset;
      if (residuals) residuals[index] = r >= 0 ? r * 2 : -r * 2 - 1;
      else {
        const context = contextOf[WEIGHTED_BUCKET[most < -501 ? 0 : most > 501 ? 1002 : most + 501]];
        if (r === 0) { if (run < 8) runContexts[run] = context; run++; }
        else { flush(); emit(context, r >= 0 ? r * 2 : -r * 2 - 1); }
      }
      const v = value * 8;
      let d0 = p0 - v; if (d0 < 0) d0 = -d0; const e0 = (d0 + 3) >> 3;
      let d1 = p1 - v; if (d1 < 0) d1 = -d1; const e1 = (d1 + 3) >> 3;
      let d2 = p2 - v; if (d2 < 0) d2 = -d2; const e2 = (d2 + 3) >> 3;
      let d3 = p3 - v; if (d3 < 0) d3 = -d3; const e3 = (d3 + 3) >> 3;
      error[cur + x] = teW = pred - v;
      W = v; N = y ? NE : v; teNW = teN; teN = teNE;
      errors0[cur + x] = e0; errors1[cur + x] = e1; errors2[cur + x] = e2; errors3[cur + x] = e3;
      errors0[prev + x + 1] += e0; errors1[prev + x + 1] += e1; errors2[prev + x + 1] += e2; errors3[prev + x + 1] += e3;
    }
  }
  flush();
  weightedScratch = state;
}
