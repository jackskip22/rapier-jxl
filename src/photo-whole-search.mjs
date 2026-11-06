// SPDX-License-Identifier: MIT
import {shown} from './photo-shown.mjs';
import {complete} from './bits.mjs';
import {prepareV6, blockSearchOptions} from './photo-v6.mjs';
import {stillPhotoProvider} from './photo-v6-provider.mjs';
import {photoXYBSteps} from './photo-xyb.mjs';
import {lowWholePhoto} from './photo-low.mjs';
import {qualitySteps} from './photo-quality-search.mjs';
import {plainLayout, planeLayoutSteps} from './photo-plane-levels.mjs';
import {planeSearchSteps} from './photo-plane-search.mjs';
import {planeMeasuredSteps} from './photo-plane-measured.mjs';
import {scoreSteps, AQ, CANDIDATES} from './photo-search.mjs';
import {gcPlaneBound} from './gpu-arithmetic.mjs';
import {memoryPlan} from './memory-plan.mjs';
import {wholePhotoTarget, wholePhotoFloor, wholePhotoSmaller, wholePhotoMeasurements} from './photo-whole-policy.mjs';
import {admitSize} from './admit.mjs';
import {s2Dimensions, s2RGBA} from './ssimulacra2-input.mjs';
import {EDGE} from './limits.mjs';
import {fault} from './fault.mjs';
import {MEASURED_EFFORT, measuredLevel} from './effort-level.mjs';

const check = signal => { if (signal?.aborted) throw signal.reason; };
const ROWS = 256;

function plainRows(data, width, height, color) {
  let held = null;
  return (from, to) => {
    if (held && from >= held.top && to <= held.top + held.planes[0].length / held.stride) return held;
    const top = Math.floor(from / ROWS) * ROWS, end = Math.min(height, Math.max(top + ROWS, to));
    const {planes} = complete(photoXYBSteps(data.subarray(top * width * 4, end * width * 4), width, end - top, 85,
      {...color, planesOnly: true}));
    return held = {planes, top, stride: Math.ceil(width / 8) * 8};
  };
}

function wholeProvider(prepared, signal) {
  const {rgba, width, height, color} = prepared, still = stillPhotoProvider(prepared), sources = new Map();
  const canonical = (image, filter) => {
    let source = sources.get(filter);
    if (!source) {
      const W = image.components[0].stride * 8, H = image.components[0].rows * 8;
      const planes = image.planes;
      const rows = planes ? () => ({planes, top: 0, stride: W})
        : image.planeRows ?? plainRows(rgba, width, height, color);
      const planeRows = (from, to) => ({stride: W, ...rows(from, to)});
      let planeBound = 0;
      for (let from = 0; from < H; from += ROWS) {
        check(signal);
        const to = Math.min(H, from + ROWS), band = planeRows(from, to), start = (from - band.top) * W, end = start + (to - from) * W;
        planeBound = Math.max(planeBound, gcPlaneBound(band.planes.map(p => p.subarray(start, end))));
      }
      source = {planeRows, planeBound}; sources.set(filter, source);
    }
    return {...image, ...source};
  };
  const provider = {...still,
    blockOptions(base) { return {...still.blockOptions(base), model: 'simple'}; },
    base(quality, options = {}) {
      check(signal);
      const filter = options.filter ?? 'gaborish';
      const image = still.base(quality, {...options, ...(filter === 'plain' && {keepPlanes: false})});
      return options.keepPlanes ? canonical(image, filter) : image;
    },
    *image(quality, options = {}) {
      const base = this.base(quality, {...options, keepPlanes: true});
      return yield* planeLayoutSteps(base, width, height, plainLayout(base), this.blockOptions(base), signal);
    },
    *layout(base, layout, options) { return yield* planeLayoutSteps(canonical(base, 'gaborish'), width, height, layout, options, signal); },
  };
  return {provider, release: () => sources.clear()};
}

const SHARED_SEARCH = {blocks: planeSearchSteps, options: blockSearchOptions, measured: planeMeasuredSteps,
  score: scoreSteps, aq: AQ, candidates: CANDIDATES};
const WANT_S2 = {ssimulacra2: true, butteraugli: false};
const DOWN_FROM = 1, DOWN_PROBES = [2, 4, 6], FLOOR_EFFORT = MEASURED_EFFORT - 1;

export function* wholePhotoSteps(data, width, height, options) {
  const steps = wholeSteps(data, width, height, options), signal = options.signal;
  let step, reply, failed = false;
  try {
    for (;;) {
      check(signal);
      step = steps.next(reply);
      if (step.done) return step.value;
      reply = yield step.value;
    }
  } catch (error) { failed = true; throw error; }
  finally { try { steps.return?.(); } catch (error) { if (!failed) throw error; } }
}

function* wholeSteps(data, width, height, {quality, colorSpace = 'srgb', effort, readingWebp, signal,
  firstEffort = effort, retainFloor = null, photoAdmission = null, photoSearch = null, maxPixels, measureOutput = null, imageMeasure = null}) {
  if (quality >= 100) return null;
  if (effort >= MEASURED_EFFORT) {
    if (maxPixels !== undefined) {
      if (!Number.isSafeInteger(maxPixels) || maxPixels < 1)
        throw fault('JXL_INPUT', 'A whole-photo pixel limit is a positive whole number.');
      admitSize(width, height, {pixels: maxPixels, edge: EDGE});
    }
    data = s2RGBA(data, s2Dimensions(width, height), true);
  }
  const {color, steps: low} = lowWholePhoto(data, width, height, {colorSpace, signal});
  if (effort < MEASURED_EFFORT) return yield* low({quality, effort});
  firstEffort = firstEffort >= effort ? measuredLevel(effort) : Math.min(firstEffort, 5);
  effort = measuredLevel(effort);
  const search = photoSearch ?? SHARED_SEARCH, measured = search.measured;
  const plan = memoryPlan(width * height, {width, height, inputBytes: data.buffer.byteLength});
  let rebuilt = null, made = null, writerEffort = Math.max(5, firstEffort);
  if (!measureOutput && typeof imageMeasure !== 'function') throw fault('JXL_INTERNAL', 'A measured whole photo needs its picture provider.');
  const measure = measureOutput ? function* (image, want) {
    if (!made) throw fault('JXL_INTERNAL', 'A capture image measure needs its writer.');
    return yield* measureOutput(yield* made.provider.write(image, writerEffort, {pass: true}), want);
  } : (image, want) => (rebuilt ??= imageMeasure(data, width, height, color, signal, plan)).measure(image, want);
  const scoreFile = function* (file, image, want) {
    const scores = measureOutput ? yield* measureOutput(file, want) : measure(image, want); check(signal);
    return scores;
  };
  let bytes = null, selectedScore = null, release = null, admittedFloor = null, failed = false;
  const keepBytes = (candidate, score) => {
    if (candidate && wholePhotoSmaller(bytes ? bytes.length : null, candidate.length)) { bytes = candidate; selectedScore = score; }
  };
  try {
    const lowFiles = new WeakMap();
    const lowAt = function* (q) {
      let image;
      const file = yield* low({quality: q, effort: FLOOR_EFFORT, observe: selected => { image = selected; }});
      if (!image) throw new Error('The low photo writer did not expose its selected image.');
      lowFiles.set(image, shown(file, image));
      return image;
    };
    let floorImage = yield* lowAt(quality);
    const floorScores = yield* scoreFile(lowFiles.get(floorImage), floorImage, WANT_S2);
    const requested = {ssimulacra2: wholePhotoTarget(floorScores.ssimulacra2, readingWebp, !!measureOutput)};
    admittedFloor = wholePhotoFloor(floorScores.ssimulacra2, readingWebp, requested.ssimulacra2);
    const admit = () => { if (bytes) photoAdmission?.record(bytes, true, wholePhotoMeasurements(selectedScore, admittedFloor, measureOutput ? 'decoded-output' : undefined)); };
    if (readingWebp === undefined || floorScores.ssimulacra2 >= requested.ssimulacra2)
      keepBytes(lowFiles.get(floorImage), floorScores.ssimulacra2);
    const needCorrection = readingWebp !== undefined && !bytes;
    let closest = needCorrection ? {bytes: lowFiles.get(floorImage), score: floorScores.ssimulacra2} : null;
    const settle = function* () {
      if (!bytes && closest) keepBytes(closest.bytes, closest.score);
      if (!bytes && retainFloor) { const exact = yield* retainFloor(null); if (exact) keepBytes(exact, null); }
    };
    const over = readingWebp !== undefined && bytes && floorScores.ssimulacra2 - requested.ssimulacra2 >= DOWN_FROM;
    if (needCorrection || over) {
      const checkedLow = function* (image, want) {
        const scores = yield* scoreFile(lowFiles.get(image), image, want);
        if (scores.ssimulacra2 >= requested.ssimulacra2) keepBytes(lowFiles.get(image), scores.ssimulacra2);
        else if (closest && scores.ssimulacra2 > closest.score) closest = {bytes: lowFiles.get(image), score: scores.ssimulacra2};
        return {scores, output: {bytes: lowFiles.get(image), effort: FLOOR_EFFORT}};
      };
      yield* measured(qualitySteps(lowAt, requested, {start: quality, low: over ? 1 : quality, high: 99.99, probes: over ? DOWN_PROBES[Math.min(effort, 6) - 4] : 2,
        initial: {quality, image: floorImage, scores: floorScores, output: {bytes: lowFiles.get(floorImage), effort: FLOOR_EFFORT}},
        measureSteps: checkedLow}), measure, signal);
    }
    if (effort === 4) { yield* settle(); admit(); return bytes; }
    floorImage = null;

    const prepared = prepareV6(data, width, height, color, {}, {banded: true});
    made = wholeProvider(prepared, signal); const provider = made.provider; release = made.release;
    const qualify = function* (image, want) {
      const file = shown(yield* provider.write(image, writerEffort, {pass: true}), image);
      const scores = yield* scoreFile(file, image, want);
      return {scores, output: {bytes: file, effort: writerEffort}};
    };
    const keep = function* (imageAt, found, effort) {
      if (!(found.scores.ssimulacra2 >= requested.ssimulacra2)) return found;
      if (found.output?.effort !== effort)
        found = {...found, output: {bytes: yield* provider.write(yield* imageAt(found.quality), effort, {pass: true}), effort}};
      if (found.scores.ssimulacra2 >= requested.ssimulacra2)
        keepBytes(found.output.bytes, found.scores.ssimulacra2);
      return found;
    };
    const probe = (imageAt, start, probes, initial = null) => measured(qualitySteps(imageAt,
      requested, {start, low: 1, high: 99.9, probes, initial, measureSteps: qualify}), measure, signal);
    const imageAt = q => provider.image(q, {filter: 'gaborish'});
    let coarse = yield* probe(imageAt, quality, 6);
    let fine = null, block = null, blockAt = null, block16 = null, block16At = null;
    for (let rung = Math.max(5, firstEffort); rung <= effort; rung++) {
      writerEffort = rung;
      coarse = yield* keep(imageAt, coarse, rung);
      let best = coarse;
      if (rung >= 6) {
        fine ??= yield* probe(imageAt, quality, 12);
        fine = yield* keep(imageAt, fine, rung);
        best = fine;
        if (!block16) {
          const options = {...search.options(data, width, height), ids: [4]}, base = provider.base(best.quality, {keepPlanes: true});
          const searched = yield* search.blocks(base, width, height, options, signal), layout = searched.layout;
          block16At = q => planeLayoutSteps(provider.base(q, {keepPlanes: true}), width, height, layout, options, signal);
          const initial = {quality: best.quality, image: searched.image, ...yield* qualify(searched.image, WANT_S2)};
          block16 = yield* probe(block16At, best.quality, 6, initial);
        }
        block16 = yield* keep(block16At, block16, rung);
      }
      yield 0.3;
      if (rung >= 7) {
        if (!block) {
          const options = search.options(data, width, height), base = provider.base(best.quality, {keepPlanes: true});
          const searched = yield* search.blocks(base, width, height, options, signal), layout = searched.layout;
          blockAt = q => planeLayoutSteps(provider.base(q, {keepPlanes: true}), width, height, layout, options, signal);
          const initial = {quality: best.quality, image: searched.image, ...yield* qualify(searched.image, WANT_S2)};
          block = yield* probe(blockAt, best.quality, 12, initial);
        }
        block = yield* keep(blockAt, block, rung);
        yield 0.6;
      }
      if (rung >= 8) {
        const found = yield* measured(search.score(provider, requested, {candidates: ['field'], effort: rung,
          start: best.quality, aq: search.aq, exactSize: true, measureSteps: qualify}), measure, signal);
        if (found?.pass) keepBytes(found.bytes, found.ssimulacra2);
      }
      if (rung >= 9) {
        const found = yield* measured(search.score(provider, requested, {candidates: search.candidates, effort: rung,
          start: best.quality, aq: search.aq, exactSize: true, measureSteps: qualify}), measure, signal);
        if (found?.pass) keepBytes(found.bytes, found.ssimulacra2);
      }
    }
    check(signal);
    yield* settle();
    admit();
    return bytes;
  } catch (error) { failed = true; throw error; }
  finally {
    let cleanupFailed = false, cleanupError;
    try { release?.(); } catch (error) { cleanupFailed = true; cleanupError = error; }
    try { rebuilt?.destroy(); } catch (error) { if (!cleanupFailed) { cleanupFailed = true; cleanupError = error; } }
    if (!failed && cleanupFailed) throw cleanupError;
  }
}

