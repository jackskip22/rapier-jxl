// Rapier's JPEG XL encoder: the self-correcting (weighted) predictor. MIT (LICENSE).
// The specification's modular predictor 6 under the default header every Rapier stream writes (p1 16, p2 10, p3 7, 7,
// 7, 0, 0; weights 13, 12, 12, 12): four sub-predictions in eighths of a level, each weighted by its error on the
// pixels above and to the left, clamped to the neighbours when their errors disagree in sign. The decoder keeps the
// same state for each channel of each group, so the encoder runs it over the plane it codes, and with it the
// property it offers a tree (15: of the errors to the west, north, north-west and north-east, the one largest in
// size). Integer arithmetic only: every engine predicts alike.
import {packSigned} from './bits.mjs';
import {countToken, writeHybrid} from './prefix.mjs';
import {LZ77, RESIDUAL_CONFIG} from './modular.mjs';

export const WEIGHTED_PREDICTOR = 6, WEIGHTED_PROPERTY = 15;
// libjxl's cut points on that property for its fixed weighted tree: 34 contexts, from which a coder merges neighbours.
export const WEIGHTED_CUTS = [-500, -392, -255, -191, -127, -95, -63, -47, -31, -23, -15, -11, -7, -4, -3, -1, 0, 1, 3, 5, 7, 11, 15, 23, 31, 47,
  63, 95, 127, 191, 255, 392, 500];
// The context of a property value: how many cut points lie below it.
const BUCKET = Int8Array.from({length: 1003}, (_, i) => WEIGHTED_CUTS.filter(cut => cut < i - 501).length);
const DIVISORS = Int32Array.from({length: 64}, (_, i) => Math.floor(16777216 / (i + 1)));
const calculateWeight = (sum, most) => { const shift = Math.max(0, 26 - Math.clz32(sum + 1)); return 4 + ((most * DIVISORS[sum >> shift]) >> shift); };
// Common error sums use the same fixed arithmetic, computed once. Larger sums take the original formula.
const WEIGHTS = [12, 13].map(most => Int32Array.from({length: 2048}, (_, sum) => calculateWeight(sum, most)));
const errorWeight = (sum, most) => sum < 2048 ? WEIGHTS[most - 12][sum] : calculateWeight(sum, most);
const SINGLE = new Int32Array(WEIGHTED_CUTS.length + 1);
let weightedScratch;

// Codes one channel plane with the weighted predictor, as codeChannel codes the others (a residual per pixel, eight
// or more zero residuals as one zero and an LZ77 copy), each token through the target of its pixel's context:
// `contextOf[k]` is the target of the k-th cut interval (all one target when absent). Counting when `w` is null
// (targets are histograms), writing otherwise (targets are prefix codes). Exact planes only: the offset applies, the
// multiplier is one. The effort-only local modeller can request the raw unsigned residuals and signed property in
// caller-owned arrays instead; it then owns tokenisation, while this one loop remains the predictor's state owner.
export function codeWeighted(w, targets, plane, width, height, offset = 0, contextOf = SINGLE, residuals, properties) {
  const stride = width + 2;
  // A call owns its state until it returns; a nested writer call gets a separate scratch allocation.
  const state = weightedScratch && weightedScratch[0].length >= 2 * stride ? weightedScratch : Array.from({length: 6}, (_, i) => new Int32Array(i < 5 ? 2 * stride : 8));
  weightedScratch = null;
  for (const array of state) array.fill(0);
  const [errors0, errors1, errors2, errors3, error, runContexts] = state;
  let run = 0;
  const emit = (context, value, config = RESIDUAL_CONFIG, base = 0) => { if (w) writeHybrid(w, targets[context], config, value, base); else countToken(config, value, targets[context], base); };
  // A run's first zero goes through its own pixel's context and the copy's length through the next pixel's, where the
  // decoder reads them.
  const flush = () => {
    if (!run) return;
    if (run > LZ77.minLength) { emit(runContexts[0], 0); emit(runContexts[1], run - LZ77.minLength - 1, LZ77.lengthConfig, LZ77.minSymbol); }
    else for (let i = 0; i < run; i++) emit(runContexts[i], 0);
    run = 0;
  };
  for (let y = 0, index = 0; y < height; y++) {
    const cur = y & 1 ? 0 : stride, prev = y & 1 ? stride : 0;
    for (let x = 0; x < width; x++, index++) {
      const left = x ? plane[index - 1] : y ? plane[index - width] : 0, top = y ? plane[index - width] : left;
      const topright = x + 1 < width && y ? plane[index - width + 1] : top;
      const n = prev + x, ne = x < width - 1 ? n + 1 : n, nw = x ? n - 1 : n;
      let w0 = errorWeight(errors0[n] + errors0[ne] + errors0[nw], 13), w1 = errorWeight(errors1[n] + errors1[ne] + errors1[nw], 12);
      let w2 = errorWeight(errors2[n] + errors2[ne] + errors2[nw], 12), w3 = errorWeight(errors3[n] + errors3[ne] + errors3[nw], 12);
      const N = top * 8, W = left * 8, NE = topright * 8;
      const teW = x ? error[cur + x - 1] : 0, teN = error[n], teNW = error[nw], teNE = error[ne], sumWN = teN + teW;
      let most = teW;
      if (Math.abs(teN) > Math.abs(most)) most = teN;
      if (Math.abs(teNW) > Math.abs(most)) most = teNW;
      if (Math.abs(teNE) > Math.abs(most)) most = teNE;
      const context = contextOf[BUCKET[most < -501 ? 0 : most > 501 ? 1002 : most + 501]];
      if (properties) properties[index] = most;
      const p0 = W + NE - N, p1 = N - (((sumWN + teNE) * 16) >> 5), p2 = W - (((sumWN + teNW) * 10) >> 5);
      const p3 = N - (((teNW + teN + teNE) * 7) >> 5);
      // The weighted average: the weights scaled to sum between 16 and 64, then a division by table.
      const shift = 27 - Math.clz32(w0 + w1 + w2 + w3);
      w0 >>= shift; w1 >>= shift; w2 >>= shift; w3 >>= shift;
      const sum = w0 + w1 + w2 + w3;
      let pred = Math.floor(((sum >> 1) - 1 + p0 * w0 + p1 * w1 + p2 * w2 + p3 * w3) * DIVISORS[sum - 1] / 16777216);
      if (((teN ^ teW) | (teN ^ teNW)) <= 0) {
        const lo = Math.min(W, NE, N), hi = Math.max(W, NE, N);
        pred = pred < lo ? lo : pred > hi ? hi : pred;
      }
      const value = plane[index], r = value - ((pred + 3) >> 3) - offset;
      if (residuals) residuals[index] = packSigned(r);
      else if (r === 0) { if (run < 8) runContexts[run] = context; run++; }
      else { flush(); emit(context, packSigned(r)); }
      // The state the decoder keeps: the prediction's error, and each sub-prediction's, added into the next row's view.
      const v = value * 8, e0 = (Math.abs(p0 - v) + 3) >> 3, e1 = (Math.abs(p1 - v) + 3) >> 3, e2 = (Math.abs(p2 - v) + 3) >> 3, e3 = (Math.abs(p3 - v) + 3) >> 3;
      error[cur + x] = pred - v;
      errors0[cur + x] = e0; errors1[cur + x] = e1; errors2[cur + x] = e2; errors3[cur + x] = e3;
      errors0[prev + x + 1] += e0; errors1[prev + x + 1] += e1; errors2[prev + x + 1] += e2; errors3[prev + x + 1] += e3;
    }
  }
  flush();
  weightedScratch = state;
}
