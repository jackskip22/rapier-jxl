// SPDX-License-Identifier: MIT
// The photo entry point's per-block AC quantization candidate. DC and alpha keep their original coefficients/samples.
// Eight block candidates: the original, three rate/error roundings at its field, and four coarser/finer fields.
// An admitted candidate mutates the supplied coefficient planes, avoiding a second whole-image allocation;
// callers keep the already-written previous stream before entering this search.
import {PHOTO_LIMITS, float16Bits} from './bits.mjs';
import {dctBlocks} from './photo-dct.mjs';

const FIELDS = [4, 4, 4, 4, 3, 2, 6, 8], BASE = 4;
const PENALTIES = [0, 0.125, 0.25, 0.5, 0.25, 0.25, 0.25, 0.25];
const BIASES = [0.9299455010825141, 0.945349926692846, 0.9500648966626563];
// The existing 40 MP photo envelope, including input, measured at about 10.5 bytes per pixel. This is a
// deterministic allocation estimate for optional work, not a promise about an engine's resident-set high water.
const QUANT_MEMORY_BUDGET = PHOTO_LIMITS.pixels * 10.5;
const unbiased = (q, c) => Math.abs(q) < 2 ? q * BIASES[c] : q - 0.145 / q;

// Only normal positive half floats are needed: the writer raises its matrix scale to avoid subnormal decoders.
function half(value) {
  const bits = float16Bits(value);
  let out = 1 + (bits & 1023) / 1024, exponent = (bits >> 10) - 15;
  while (exponent < 0) { out /= 2; exponent++; }
  while (exponent > 0) { out *= 2; exponent--; }
  return out;
}

// Reconstruction model: squared RGB coefficient error across edge-replicated DCT8 blocks, before clipping and
// output rounding. The stored half-precision matrix and the default quantization bias are included. The transform
// is orthonormal, so this is the full padded block's RGB sample error (Parseval); DC is unchanged. The source
// samples are encoded sRGB or Display P3 values, not linear-light values.
const rgbError = (y, cb, cr) => {
  const r = y + 1.402 * cr, g = y - 0.344136286 * cb - 0.714136286 * cr, b = y + 1.772 * cb;
  return r * r + g * g + b * b;
};

export function* quantisationSteps(data, jpeg, storedBytes = 0) {
  const {width, height, components, quantScale} = jpeg, stride = components[0].stride, rows = components[0].rows;
  const count = stride * rows, choices = FIELDS.length;
  // Optional search stays inside the existing photo memory envelope. Account for its score tables, and reserve
  // two completed streams plus a writer's capacities, finished sections and assembly (six stream limits total),
  // with 16 MiB for metadata. The original entry point's 40 MP admission is unchanged; larger searches keep their floor.
  const pixelsBytes = data.byteLength + components.reduce((bytes, c) => bytes + c.coeffs.byteLength, 0);
  if (pixelsBytes + Math.max(count * (choices * 10 + 2) + storedBytes, 7 * PHOTO_LIMITS.bytes) > QUANT_MEMORY_BUDGET) return null;
  const errors = new Float64Array(count * choices), rates = new Uint16Array(count * choices);
  const transform = dctBlocks(data, width, height), quant = components.map(c => c.quant), coeffs = components.map(c => c.coeffs);
  const steps = FIELDS.map(field => quant.map(table => Float64Array.from(table, q => q * half(BASE / (8 * 255 * quantScale)) * 8 * 255 / field)));
  const trial = new Int16Array(192), delta = new Float64Array(3);
  const values = new Int32Array(6), differences = new Float64Array(6), bitCosts = new Float64Array(6);
  let baselineError = 0, baselineRate = 0;
  const quantise = (sums, block, choice) => {
    let error = 0, rate = 0;
    const penalty = PENALTIES[choice] * quant[0][1] * quant[0][1] / (quantScale * quantScale);
    for (let k = 1; k < 64; k++) {
      if (!choice) {
        for (let c = 0; c < 3; c++) {
          const q = coeffs[c][block * 64 + k];
          delta[c] = unbiased(q, c) * steps[choice][c][k] - sums[c * 64 + k];
          if (q) rate += 2 + 2 * (32 - Math.clz32(Math.abs(q)));
        }
        error += rgbError(delta[0], delta[1], delta[2]);
        continue;
      }
      for (let c = 0; c < 3; c++) {
        const source = sums[c * 64 + k], step = steps[choice][c][k], lo = Math.floor(source / step);
        for (let n = 0; n < 2; n++) {
          const q = lo + n;
          values[2 * c + n] = q;
          bitCosts[2 * c + n] = q ? 2 + 2 * (32 - Math.clz32(Math.abs(q))) : 0;
          differences[2 * c + n] = q < -32768 || q > 32767 ? Infinity : unbiased(q, c) * step - source;
        }
      }
      let selected = 0, best = Infinity, selectedError = 0;
      for (let i = 0; i < 8; i++) {
        const current = rgbError(differences[i & 1], differences[2 + ((i >> 1) & 1)], differences[4 + (i >> 2)]);
        const candidate = current + penalty * (bitCosts[i & 1] + bitCosts[2 + ((i >> 1) & 1)] + bitCosts[4 + (i >> 2)]);
        if (candidate < best) { best = candidate; selected = i; selectedError = current; }
      }
      if (best === Infinity) return {error: Infinity, rate: 65535};
      error += selectedError;
      for (let c = 0; c < 3; c++) {
        const q = values[2 * c + ((selected >> c) & 1)];
        trial[c * 64 + k] = q;
        if (q) rate += 2 + 2 * (32 - Math.clz32(Math.abs(q)));
      }
    }
    return {error, rate};
  };
  for (let by = 0; by < rows; by++) {
    for (let bx = 0; bx < stride; bx++) {
      const block = by * stride + bx, sums = transform(bx, by);
      for (let choice = 0; choice < choices; choice++) {
        const result = quantise(sums, block, choice), at = block * choices + choice;
        errors[at] = result.error; rates[at] = result.rate;
        if (!choice) { baselineError += result.error; baselineRate += result.rate; }
      }
      if ((block + 1) % 1024 === 0 || block + 1 === count) if (yield (block + 1) / (3 * count)) return null;
    }
  }

  // A coefficient has at most 16 magnitude bits: the per-block proxy rate fits Uint16.
  // The proxy rate only proposes a field map. Binary search finds the cheapest proxy reconstruction under the
  // baseline error; the complete written stream, with the field map and all headers, still has to beat effort 1.
  const selected = new Uint8Array(count);
  let selectionPass = 0;
  const select = function* (lambda, keep) {
    let total = 0, rate = 0;
    for (let block = 0; block < count; block++) {
      const at = block * choices;
      let chosen = 0, best = errors[at] + lambda * rates[at];
      for (let choice = 1; choice < choices; choice++) {
        const cost = errors[at + choice] + lambda * rates[at + choice];
        if (cost < best) { best = cost; chosen = choice; }
      }
      total += errors[at + chosen]; rate += rates[at + chosen];
      if (keep) selected[block] = chosen;
      if ((block + 1) % 1024 === 0 || block + 1 === count) {
        if (yield 1 / 3 + (selectionPass + (block + 1) / count) / 147) return null;
      }
    }
    selectionPass++;
    return {error: total, rate};
  };
  let lo = 0, hi = Math.max(1, baselineError / Math.max(1, baselineRate));
  for (let i = 0; i < 24; i++) {
    const chosen = yield* select(hi, false);
    if (!chosen) return null;
    if (chosen.error > baselineError) break;
    hi *= 2;
  }
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2, chosen = yield* select(mid, false);
    if (!chosen) return null;
    if (chosen.error <= baselineError) lo = mid; else hi = mid;
  }
  const chosen = yield* select(lo, true);
  if (!chosen || chosen.error > baselineError || chosen.rate >= baselineRate || !selected.some(choice => choice)) return null;
  const quantFields = new Uint8Array(count);
  for (let by = 0; by < rows; by++) {
    for (let bx = 0; bx < stride; bx++) {
      const block = by * stride + bx, choice = selected[block];
      quantFields[block] = FIELDS[choice];
      if (choice) {
        quantise(transform(bx, by), block, choice);
        for (let c = 0; c < 3; c++) for (let k = 1; k < 64; k++) coeffs[c][block * 64 + k] = trial[c * 64 + k];
      }
      if ((block + 1) % 1024 === 0 || block + 1 === count) if (yield 2 / 3 + (block + 1) / (3 * count)) return null;
    }
  }
  return {...jpeg, quantFieldBase: BASE, quantFields,
    reconstructionError: {baseline: baselineError, candidate: chosen.error}};
}
