// SPDX-License-Identifier: MIT
// Lossless color-transform search. Samples rank 42 reversible transforms; complete streams compete by byte length.
import {BitWriter} from './bits.mjs';
import {leaf, codeChannel, writeTransform} from './modular.mjs';
import {losslessCoding} from './lossless-coding.mjs';
import {losslessSteps} from './lossless.mjs';

// Transform `type` of the specification's 42 (a permutation, then one of seven), filling planes as planeFill does.
export function colourTransform(type, channels) {
  const permutation = Math.floor(type / 7), custom = type % 7;
  const a = permutation % 3, b = (permutation + 1 + Math.floor(permutation / 3)) % 3;
  const c = (permutation + 2 - Math.floor(permutation / 3)) % 3;
  return {type, fill(planes, rgba, stride, x0, y0, w, h) {
    for (let y = 0; y < h; y++) for (let x = 0, at = y * w, i = ((y0 + y) * stride + x0) * 4; x < w; x++, at++, i += 4) {
      const first = rgba[i + a], second = rgba[i + b], third = rgba[i + c];
      if (custom === 6) {
        const co = first - third, tmp = third + (co >> 1), cg = second - tmp;
        planes[0][at] = tmp + (cg >> 1); planes[1][at] = co; planes[2][at] = cg;
      } else {
        planes[0][at] = first;
        planes[1][at] = second - ((custom >> 1) === 1 ? first : (custom >> 1) === 2 ? (first + third) >> 1 : 0);
        planes[2][at] = third - (custom & 1 ? first : 0);
      }
      if (channels === 4) planes[3][at] = rgba[i + 3];
    }
  }};
}

// The 42 transforms contain 15 distinct scalar planes: three original channels, six ordered differences,
// three differences from the other channels' rounded-down mean, and three weighted means. In transform 6,
// third + ((first - third) >> 1) is exactly (first + third) >> 1. Equal planes have equal sampled residuals,
// predictor choices and integer-code prices, regardless of their output channel or transform.
function sampleKeys(type) {
  const permutation = Math.floor(type / 7), custom = type % 7;
  const a = permutation % 3, b = (permutation + 1 + Math.floor(permutation / 3)) % 3;
  const c = (permutation + 2 - Math.floor(permutation / 3)) % 3;
  if (custom === 6) return [15 + b, 3 + 3 * a + c, 12 + b];
  return [a, (custom >> 1) === 1 ? 3 + 3 * b + a : (custom >> 1) === 2 ? 12 + b : b,
    custom & 1 ? 3 + 3 * c + a : c];
}

export function* rctSearchSteps(rgba, width, height, shape, colorSpace, pooled) {
  if (shape.colour !== 3 || width * height < 4096) return null;
  const sw = Math.min(width, 32), sh = Math.min(height, 32);
  const planes = Array.from({length: shape.channels}, () => new Int16Array(sw * sh));
  const types = [6, ...Array.from({length: 42}, (_, i) => i).filter(i => i !== 6)];
  const prices = [];
  let best;
  for (let k = 0; k < types.length; k++) {
    const rct = colourTransform(types[k], shape.channels), keys = sampleKeys(rct.type);
    const missing = [0, 1, 2].filter(c => prices[keys[c]] === undefined);
    if (missing.length) {
      const candidates = [5, 3].map(predictor => ({predictor, freqs: missing.map(() => new Uint32Array(1057))}));
      for (let sample = 0; sample < 3; sample++) {
        rct.fill(planes, rgba, width, Math.floor((width - sw) * sample / 2), Math.floor((height - sh) * sample / 2), sw, sh);
        for (const candidate of candidates) for (let m = 0; m < missing.length; m++)
          codeChannel(null, candidate.freqs[m], planes[missing[m]], sw, sh, leaf(candidate.predictor), true);
      }
      for (let m = 0; m < missing.length; m++) prices[keys[missing[m]]] = Math.min(...candidates.map(p => losslessCoding(p.freqs[m])[1].bits));
    }
    const w = new BitWriter(32);
    if (rct.type) writeTransform(w, {type: 'rct', beginC: 0, rctType: rct.type});
    let bits = w.bitLength;
    for (let c = 0; c < 3; c++) bits += prices[keys[c]];
    if (!best || bits < best.bits) best = {rct, bits};
    if (yield (k + 1) / (4 * types.length)) return null;
  }
  if (best.rct.type === 6) return null;
  const plan = losslessSteps(rgba, width, height, {shape: {...shape, palette: null}, colorSpace, rct: best.rct, pooled});
  let step, reply;
  while (!(step = plan.next(reply)).done) {
    // The final group is already complete: finish assembly and retain it even when the caller hurries there. A pooled
    // pass ends at a hurry anywhere before that.
    const done = step.value, inner = typeof done === 'number';
    reply = yield inner ? 0.25 + 0.75 * done : {...done, at: g => 0.25 + 0.75 * done.at(g), stop: g => done.at(g) < 1};
    if (inner ? reply && done < 1 : !reply) return null;
  }
  return step.value;
}
