// SPDX-License-Identifier: MIT
import {LIMITS} from './limits.mjs';
import {complete, part} from './bits.mjs';
import {admitOptions, admitPixels, admitSampleFormat, fault, job} from './admit.mjs';
import {encodeDeltaPaletteSteps} from './delta-palette.mjs';
import {graphicsProtectionSteps, graphicsPaletteSteps, graphicsUnditherSteps} from './graphics-quantize.mjs';
export {LIMITS};

function graphicsOptions(data, width, height, options = {}) {
  const {quality, colorSpace} = admitOptions(options);
  admitPixels(data, width, height);
  if (quality !== 100 || !admitSampleFormat(data, options).native8)
    throw fault('JXL_INPUT', 'Graphics uses exact RGBA8 custody with sRGB transfer; request loss using maxColorError or a graphics preset.');
  const preset = options.preset ?? 'exact';
  if (!['exact', 'screen', 'dither'].includes(preset)) throw fault('JXL_INPUT', 'The graphics preset is exact, screen or dither.');
  const maxColorError = options.maxColorError ?? (preset === 'screen' ? 2 : preset === 'dither' ? 8 : 0);
  const paletteColors = options.paletteColors ?? 256, preserveEdges = options.preserveEdges ?? true;
  const undither = options.undither ?? preset === 'dither', protectedMask = options.protectedMask;
  if (!Number.isInteger(maxColorError) || maxColorError < 0 || maxColorError > 32)
    throw fault('JXL_INPUT', 'maxColorError is an integer from 0 through 32 code values per RGB channel.');
  if (!Number.isInteger(paletteColors) || paletteColors < 1 || paletteColors > 4096)
    throw fault('JXL_INPUT', 'paletteColors is an integer search budget from 1 through 4096.');
  if (typeof preserveEdges !== 'boolean' || typeof undither !== 'boolean')
    throw fault('JXL_INPUT', 'preserveEdges and undither are booleans.');
  if (protectedMask !== undefined && (!(protectedMask instanceof Uint8Array) && !(protectedMask instanceof Uint8ClampedArray) || protectedMask.length !== width * height))
    throw fault('JXL_INPUT', 'protectedMask is a byte array with one entry per source pixel; nonzero entries preserve that pixel exactly.');
  const exact = {colorSpace, paletteMode: 'auto', deltaPredictor: options.deltaPredictor,
    maxPaletteColors: options.maxPaletteColors, groupSize: options.groupSize, screenEffort: options.screenEffort};
  const baseline = encodeDeltaPaletteSteps(data, width, height, exact);
  return {maxColorError, paletteColors, preserveEdges, undither, protectedMask, exact, baseline};
}

function* graphicsCandidateSteps(candidate) {
  let next;
  while (!(next = candidate.next()).done) if (yield next.value) candidate.hurry = true;
  return next.value;
}

function* graphicsPreparationSteps(steps, canStop) {
  let next, reply = false;
  while (!(next = steps.next(canStop && reply)).done) reply = yield next.value;
  return next.value;
}

function graphicsOptionalFailure(error) {
  return error.code === 'JXL_SIZE' || error.code === 'JXL_MEMORY' || error instanceof RangeError && !error.code;
}

function graphicsSquaredError(source, candidate) {
  let total = 0;
  for (let at = 0; at < source.length; at += 4) for (let c = 0; c < 3; c++) {
    const difference = source[at + c] - candidate[at + c]; total += difference * difference;
  }
  return total;
}

function* graphicsEncodeSteps(data, width, height, options) {
  const {maxColorError: error, paletteColors, preserveEdges, protectedMask, undither, exact, baseline} = options;
  const stages = error ? undither ? 9 : 6 : 1;
  let best, unavailable, bestError = 0;
  try { best = yield* part(graphicsCandidateSteps(baseline), 0, stages); }
  catch (failure) { if (!graphicsOptionalFailure(failure) || !error) throw failure; unavailable = failure; }
  if (!error || (yield 1 / stages) && best) return best;
  let mask;
  try {
    mask = yield* part(graphicsPreparationSteps(graphicsProtectionSteps(data, width, height, preserveEdges, protectedMask), !!best), 1, stages);
  } catch (failure) { if (!best || !graphicsOptionalFailure(failure)) throw failure; }
  if (!mask) { if (best) return best; throw unavailable; }
  for (let mode = 0; mode < (undither ? 3 : 2); mode++) {
    try {
      let pixels;
      if (mode < 2) pixels = yield* part(graphicsPreparationSteps(graphicsPaletteSteps(data, width, height, mask, error, paletteColors, data, !!mode), !!best), 2 + mode * 2, stages);
      else {
        pixels = yield* part(graphicsPreparationSteps(graphicsUnditherSteps(data, width, height, mask, error), !!best), 6, stages);
        if (pixels) pixels = (yield* part(graphicsPreparationSteps(graphicsPaletteSteps(pixels, width, height, mask, error, paletteColors, data), !!best), 7, stages)) || pixels;
      }
      const codingStage = mode === 2 ? 8 : 3 + mode * 2;
      if ((yield codingStage / stages) && best) return best;
      if (pixels) {
        const candidate = yield* part(graphicsCandidateSteps(encodeDeltaPaletteSteps(pixels, width, height, exact)), codingStage, stages);
        if (!best || candidate.length <= best.length) {
          const loss = graphicsSquaredError(data, pixels);
          if (!best || candidate.length < best.length || loss < bestError) { best = candidate; bestError = loss; }
        }
      }
    } catch (failure) {
      if (!graphicsOptionalFailure(failure)) throw failure;
      unavailable = failure;
    }
    if ((yield (mode === 2 ? 9 : 4 + mode * 2) / stages) && best) return best;
  }
  if (!best) throw unavailable;
  return best;
}

export function encodeGraphics(data, width, height, options) {
  return complete(encodeGraphicsSteps(data, width, height, options));
}
export function encodeGraphicsSteps(data, width, height, options) {
  return job(graphicsEncodeSteps(data, width, height, graphicsOptions(data, width, height, options)));
}
