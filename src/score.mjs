// SPDX-License-Identifier: MIT
import {PHOTO_LIMITS, complete} from './bits.mjs';
import {admitPixels, fault} from './admit.mjs';
import {admitEffort} from './effort-level.mjs';
import {prepareV6, scoreSteps, cpuMeasure, runAsync, CANDIDATES} from './photo-v6-search.mjs';
import {GpuMeasure} from './gpu-reconstruct.mjs';
import {attachVarblocks} from './gpu-varblocks.mjs';

export {PHOTO_LIMITS as LIMITS};

function scoreTarget(target) {
  if (!target || typeof target !== 'object') throw fault('JXL_INPUT', 'Target is an object naming ssimulacra2, butteraugli or butteraugli3.');
  const out = {};
  for (const [key, value] of Object.entries(target)) {
    if (!['ssimulacra2', 'butteraugli', 'butteraugli3'].includes(key)) throw fault('JXL_INPUT', `Target ${key} is not ssimulacra2, butteraugli or butteraugli3.`);
    if (typeof value !== 'number' || !Number.isFinite(value) || (key === 'ssimulacra2' ? value > 100 : value <= 0)) throw fault('JXL_INPUT', `Target ${key} is out of range.`);
    out[key] = value;
  }
  if (!Object.keys(out).length) throw fault('JXL_INPUT', 'Target names ssimulacra2, butteraugli or butteraugli3.');
  return out;
}

function admitScore(data, width, height, options) {
  if (!(data instanceof Uint8Array || data instanceof Uint8ClampedArray)) throw fault('JXL_INPUT', 'Encoding to a score takes 8-bit sRGB RGBA.');
  admitPixels(data, width, height, PHOTO_LIMITS);
  if (width < 8 || height < 8) throw fault('JXL_INPUT', 'Encoding to a score needs a picture of at least 8 x 8 pixels.');
  const candidates = options?.candidates ?? CANDIDATES;
  if (!Array.isArray(candidates) || !candidates.length || candidates.some(c => !CANDIDATES.includes(c))) throw fault('JXL_INPUT', `Candidates are some of ${CANDIDATES.join(', ')}.`);
  return {target: scoreTarget(options?.target), effort: options?.effort === undefined ? 7 : admitEffort(options), candidates};
}

function scoreAnswer(r) {
  if (!r) throw fault('JXL_TARGET_UNMET', 'No searched candidate meets every requested quality target.');
  return {bytes: r.bytes, quality: r.quality, candidate: r.candidate, butteraugli: r.butteraugli, butteraugli3: r.butteraugli3,
    ...(r.ssimulacra2 !== undefined ? {ssimulacra2: r.ssimulacra2} : {})};
}

export function* encodeToScoreSteps(data, width, height, options) {
  const {target, effort, candidates} = admitScore(data, width, height, options), measure = cpuMeasure(data, width, height);
  const steps = scoreSteps(prepareV6(data, width, height), target, {candidates, effort});
  let step, reply, n = 0;
  while (!(step = steps.next(reply)).done) {
    reply = step.value?.measure ? measure(step.value.measure, step.value.want) : undefined;
    if (step.value?.measure) yield Math.min(0.95, ++n / 30);
  }
  return scoreAnswer(step.value);
}

export async function encodeToScore(data, width, height, options) {
  const {target, effort, candidates} = admitScore(data, width, height, options), gpu = options?.gpu;
  if (!gpu) return complete(encodeToScoreSteps(data, width, height, options));
  const measurer = await attachVarblocks(await GpuMeasure.create(gpu, data, width, height), gpu), cpu = target.ssimulacra2 !== undefined ? cpuMeasure(data, width, height) : null;
  try {
    const measure = async (image, want) => want?.ssimulacra2 ? {...await measurer.measure(image, want), ssimulacra2: cpu(image, want).ssimulacra2} : measurer.measure(image, want);
    measure.varblocks = measurer.varblocks;
    return scoreAnswer(await runAsync(scoreSteps(prepareV6(data, width, height), target, {candidates, effort}), measure, options?.onProgress));
  } finally { measurer.destroy(); }
}
