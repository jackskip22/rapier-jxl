// SPDX-License-Identifier: MIT
import {PHOTO_LIMITS, complete} from './bits.mjs';
import {admitPixels, fault, job} from './admit.mjs';
import {admitEffort} from './effort-level.mjs';
import {effortJob} from './effort-job.mjs';
import {checkSignal} from './async-job.mjs';
import {prepareV6, scoreSteps, cpuMeasure, runAsync, gpuDoubt, CANDIDATES} from './photo-v6-search.mjs';
import {exactAnswerer, exactPool, exactScores} from './exact-region.mjs';
import {memoryPlan} from './memory-plan.mjs';
import {GpuMeasure, gpuSetup} from './gpu-reconstruct.mjs';
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
  const allowLossless = options?.allowLossless === undefined ? true : options.allowLossless, maxBytes = options?.maxBytes ?? Number.MAX_SAFE_INTEGER;
  if (typeof allowLossless !== 'boolean') throw fault('JXL_INPUT', 'allowLossless is a boolean.');
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || options?.maxBytes === null) throw fault('JXL_INPUT', 'maxBytes is a positive safe integer.');
  return {target: scoreTarget(options?.target), effort: options?.effort === undefined ? 7 : admitEffort(options), candidates, allowLossless, maxBytes};
}

function scoreMemory(data, width, height, options, exact) {
  const inputBytes = data.buffer.byteLength, metricInputBytes = width * height * 4, scope = options?.memory;
  if (scope?.inputBytes !== undefined && scope.inputBytes < inputBytes) throw fault('JXL_MEMORY', 'Memory reservation omits retained input bytes.');
  if (scope?.metricInputBytes !== undefined && scope.metricInputBytes < metricInputBytes) throw fault('JXL_MEMORY', 'Memory reservation omits the metric input snapshot.');
  const memory = {...scope, inputBytes: scope?.inputBytes ?? inputBytes, metricInputBytes: scope?.metricInputBytes ?? metricInputBytes, width, height, exact};
  const plan = memoryPlan(width * height, memory);
  if (plan.known && !plan.fits) throw fault('JXL_MEMORY', 'Score encoding exceeds the supplied memory reservation.');
  return {memory, plan};
}

const scoreAnswer = r => ({bytes: r.bytes, quality: r.quality, candidate: r.candidate, pass: r.pass, butteraugli: r.butteraugli, butteraugli3: r.butteraugli3,
  ...(r.ssimulacra2 !== undefined ? {ssimulacra2: r.ssimulacra2} : {})});

function scoreRefusal(result, target, code, reason) {
  const margin = row => Math.min(...Object.entries(target).map(([key, value]) => key === 'ssimulacra2' ? row[key] - value : (value - row[key]) / (0.04 * value)));
  const best = result.tried.map(row => row.bestObserved).reduce((a, b) => margin(b) > margin(a) ? b : a);
  const scores = Object.fromEntries(Object.keys(target).map(key => [key, best[key]]));
  return Object.assign(fault(code, reason + ' Best lossy scores: ' + Object.entries(scores).map(([key, value]) => key + ' ' + value).join(', ') + '.'),
    {target: {...target}, best: {...scores, candidate: best.candidate, quality: best.quality}});
}

function* finishScore(result, data, width, height, {target, effort, allowLossless, maxBytes}) {
  if (result.pass && result.bytes.length <= maxBytes) return scoreAnswer(result);
  if (!allowLossless) throw scoreRefusal(result, target, result.pass ? 'JXL_SIZE' : 'JXL_TARGET',
    result.pass ? 'The selected file exceeds maxBytes.' : 'The lossy search did not reach the target and lossless is disabled.');
  const exact = job(effortJob(data, width, height, {quality: 100, effort}, undefined, false, undefined, false, PHOTO_LIMITS));
  try {
    let step;
    while (!(step = exact.next()).done) yield 0.95 + 0.05 * step.value;
    if (step.value.length > maxBytes) throw scoreRefusal(result, target, 'JXL_SIZE', 'The lossless file exceeds maxBytes.');
    return scoreAnswer({bytes: step.value, quality: 100, candidate: 'lossless', pass: true, ssimulacra2: 100, butteraugli: 0, butteraugli3: 0});
  } finally { exact.return(); }
}

export function* encodeToScoreSteps(data, width, height, options) {
  checkSignal(options?.signal);
  const settings = admitScore(data, width, height, options), {target, effort, candidates} = settings;
  const {memory, plan} = scoreMemory(data, width, height, options, target.ssimulacra2 !== undefined);
  let whole = null, steps = null;
  try {
    whole = cpuMeasure(data, width, height, {cacheBytes: plan.cacheBytes});
    const measure = (image, want) => {
      const out = exactScores(whole, {rgba: data}, width, height, image, want, plan);
      if (options?.stats) {
        options.stats.cpuProbes = (options.stats.cpuProbes ?? 0) + 1;
        options.stats.metricCacheBytes = Math.max(options.stats.metricCacheBytes ?? 0, whole.cacheBytes ?? 0);
        options.stats.metricReferenceBytes = Math.max(options.stats.metricReferenceBytes ?? 0, whole.referenceBytes ?? 0);
      }
      return out;
    };
    steps = scoreSteps(prepareV6(data, width, height, {}, memory), target, {candidates, effort});
    let step, reply, n = 0;
    while (!(step = steps.next(reply)).done) {
      checkSignal(options?.signal);
      reply = step.value?.measure ? measure(step.value.measure, step.value.want) : undefined;
      if (step.value?.measure) yield Math.min(0.95, ++n / 30);
    }
    steps.return(); whole.destroy?.(); reply = undefined; steps = whole = null;
    return yield* finishScore(step.value, data, width, height, settings);
  } finally { steps?.return(); whole?.destroy?.(); }
}

export const S2_DOUBT = 2e-4;

export async function encodeToScore(data, width, height, options) {
  checkSignal(options?.signal);
  const settings = admitScore(data, width, height, options), {target, effort, candidates} = settings, gpu = options?.gpu;
  const {memory, plan} = scoreMemory(data, width, height, options, target.ssimulacra2 !== undefined);
  const stats = {backend: gpu ? 'gpu+cpu' : 'cpu', gpuProbes: 0, cpuProbes: 0, cpuFallbacks: 0, gpuFailures: 0,
    probes: 0, recomputed: 0, regions: 0, gpuBufferBytes: 0, hostBufferBytes: 0, cacheBytes: 0};
  const publish = () => { if (options?.stats) Object.assign(options.stats, stats); };
  if (gpu && plan.known) {
    stats.backend = 'refused'; stats.gpuFailure = 'JXL_MEMORY_GPU_UNPROVEN'; publish();
    throw fault('JXL_MEMORY_GPU_UNPROVEN', 'The supplied whole-memory envelope has no enforceable GPU allocation bound.');
  }
  if (!gpu) { try { return complete(encodeToScoreSteps(data, width, height, {...options, stats})); } finally { publish(); } }
  let measurer = null, pool = null, exactAnswer = null, steps = null, cpuOnce = null, metricRgba = null, gpuFailure, gpuFailed = false, completed = false;
  const recordMemory = () => {
    stats.gpuBufferBytes = Math.max(stats.gpuBufferBytes, measurer?.gpuBufferBytes ?? 0);
    stats.hostBufferBytes = Math.max(stats.hostBufferBytes, measurer?.hostBufferBytes ?? 0);
    stats.cacheBytes = Math.max(stats.cacheBytes, measurer?.cacheBytes ?? 0);
    stats.metricCacheBytes = Math.max(stats.metricCacheBytes ?? 0, cpuOnce?.cacheBytes ?? 0);
    stats.metricReferenceBytes = Math.max(stats.metricReferenceBytes ?? 0, cpuOnce?.referenceBytes ?? 0);
    stats.metricInputBytes = Math.max(stats.metricInputBytes ?? 0, metricRgba?.byteLength ?? 0);
  };
  const cleanup = async () => {
    const closing = [];
    for (const release of [recordMemory, () => pool?.terminate(), () => exactAnswer?.destroy(), () => measurer?.destroy(),
      () => steps?.return(), () => cpuOnce?.destroy?.()]) {
      try { closing.push(Promise.resolve(release())); } catch (error) { closing.push(Promise.reject(error)); }
    }
    const results = await Promise.allSettled(closing), failures = results.filter(result => result.status === 'rejected');
    stats.cleanupFailures = (stats.cleanupFailures ?? 0) + failures.length;
    pool = exactAnswer = measurer = steps = cpuOnce = metricRgba = null;
    return {failed: failures.length > 0, error: failures[0]?.reason};
  };
  const cpu = (image, want) => {
    stats.cpuProbes++;
    return exactScores(cpuOnce ||= cpuMeasure(metricRgba, width, height, {cacheBytes: plan.cacheBytes, immutable: true}), null, width, height, image, want, plan);
  };
  cpu.withReference = consume => (cpuOnce ||= cpuMeasure(metricRgba, width, height, {cacheBytes: plan.cacheBytes, immutable: true})).withReference(consume);
  try {
    metricRgba = new Uint8Array(width * height * 4); metricRgba.set(data.subarray(0, metricRgba.length));
    cpuOnce = cpuMeasure(metricRgba, width, height, {cacheBytes: plan.cacheBytes, immutable: true});
    try {
      measurer = await GpuMeasure.create(gpu, metricRgba, width, height, {signal: options?.signal});
      await attachVarblocks(measurer, gpu, {signal: options?.signal});
    } catch (error) { gpuFailure = error; gpuFailed = true; throw error; }
    const cpuDecisions = options?.decisions === 'cpu';
    const measure = async (image, want) => {
      checkSignal(options?.signal);
      if (want?.exact) { stats.recomputed++; return cpu(image, want); }
      if (cpuDecisions && want && ('p' in want || 'margin' in want)) {
        stats.cpuDecisions = (stats.cpuDecisions ?? 0) + 1; return cpu(image, want);
      }
      let out;
      try { out = await gpuSetup(() => measurer.measure(image, want), {signal: options?.signal, dispose: () => measurer?.destroy()}); }
      catch (error) { gpuFailure = error; gpuFailed = true; throw error; }
      stats.probes++; stats.gpuProbes++; recordMemory();
      if (!want?.ssimulacra2) return {...out, doubt: gpuDoubt(out)};
      if (out.ssimulacra2 !== undefined) return {...out, doubt: gpuDoubt(out, S2_DOUBT)};
      stats.cpuFallbacks++;
      return {...out, ssimulacra2: cpu(image, {...want, butteraugli: false}).ssimulacra2, doubt: gpuDoubt(out)};
    };
    measure.varblocks = async request => {
      const result = await gpuSetup(() => measurer.varblocks?.(request), {signal: options?.signal, dispose: () => measurer?.destroy()});
      stats.varblockGpuFailures = measurer.varblockResources?.failures ?? 0;
      if (stats.varblockGpuFailures) stats.backend = 'gpu+cpu-fallback';
      stats.varblockGpuBufferPeak = measurer.varblockResources?.peakBufferBytes ?? 0;
      recordMemory(); return result;
    };
    const admitted = plan.workers;
    if (options?.poolSize !== undefined && (!Number.isSafeInteger(options.poolSize) || options.poolSize < 0))
      throw fault('JXL_INPUT', 'poolSize is a nonnegative integer.');
    const workers = Math.min(options?.poolSize ?? admitted, admitted);
    measure.exact = async request => {
      checkSignal(options?.signal);
      stats.regions += request.regions?.length ?? 1;
      if (!exactAnswer) {
        pool = workers ? await exactPool(workers, {signal: options?.signal, reservation: plan.workerReservation}) : null;
        exactAnswer = exactAnswerer(data, width, height, pool, cpu, pool?.size ?? 0, plan, cpu, options?.signal);
      }
      const result = await exactAnswer(request);
      stats.regionFallbacks = exactAnswer.fallbacks;
      return result;
    };
    steps = scoreSteps(prepareV6(data, width, height, {}, memory), target, {candidates, effort});
    const progress = value => { checkSignal(options?.signal); options?.onProgress?.(value); checkSignal(options?.signal); };
    const result = await runAsync(steps, measure, progress);
    const released = await cleanup(); checkSignal(options?.signal); if (released.failed) throw released.error;
    const finish = finishScore(result, data, width, height, settings);
    let answer;
    try {
      let step;
      while (!(step = finish.next()).done) progress(step.value);
      answer = step.value;
    } finally { finish.return(); }
    checkSignal(options?.signal); completed = true; return answer;
  } catch (error) {
    if (options?.signal?.aborted) { stats.backend = 'canceled'; throw options.signal.reason; }
    if (error?.name === 'AbortError') throw error;
    if (!gpuFailed) throw error;
    stats.gpuFailures++; stats.backend = 'gpu-failed';
    stats.gpuFailure = gpuFailure?.code ?? gpuFailure?.name ?? 'Error';
    const released = await cleanup(); if (released.failed) throw error;
    checkSignal(options?.signal);
    stats.cpuFallbacks++; stats.cpuFallbackSearches = 1; stats.backend = 'cpu-fallback';
    const answer = complete(encodeToScoreSteps(data, width, height, {...options, stats}));
    checkSignal(options?.signal); completed = true; return answer;
  } finally {
    await cleanup();
    const canceled = completed && options?.signal?.aborted;
    if (canceled) stats.backend = 'canceled';
    publish(); if (canceled) throw options.signal.reason;
  }
}
