// SPDX-License-Identifier: MIT
import {PHOTO_LIMITS, complete, part, scaled} from './bits.mjs';
import {admitOptions, admitPixels, admitSampleFormat, fault, guard, job, answer} from './admit.mjs';
import {admitEffort} from './effort-level.mjs';
import {admitPhotoFilter} from './photo-job.mjs';
import {strategyCoefficientSteps, requantizeStrategySteps, admitStrategyOptions, TRANSFORMS} from './vardct-strategies.mjs';
import {progressivePasses} from './vardct-progressive.mjs';
import {admitNoise} from './noise.mjs';
import {admitLFFrames, lfFrameSteps, prependLFFrames} from './lf-frames.mjs';
import {cropPhotoCanvas, photoLevelContainer} from './photo-crop.mjs';
import {readImageHeader} from './framing.mjs';
import {varDCTSteps} from './vardct.mjs';
import {buildAnsCoding, writeModularAnsHistograms} from './ans.mjs';
import {quantParamCoding} from './quantization-params.mjs';
import {prepareCoefficientOrders} from './coefficient-orders.mjs';
import {admitPhotoLayout, padPhotoLayout, applyPhotoLayout} from './photo-layout.mjs';
import {admitPhotoExtras, snapshotPhotoExtras, applyPhotoExtras} from './photo-extras.mjs';

const PLAN_LIMITS = Object.freeze({...PHOTO_LIMITS, retainedBytes: 256 * 1024 * 1024});
export {PLAN_LIMITS as LIMITS};

function planQuality(value) {
  if (!Number.isFinite(value) || value < 1 || value >= 100)
    throw fault('JXL_INPUT', 'A retained lossy plan uses quality from 1 through less than 100; exact images use the ordinary lossless entry.');
  return value;
}

function retainedMemory(...values) {
  const visited = new Set(), buffers = new Set();
  const visit = value => {
    if (!value || typeof value !== 'object' || visited.has(value)) return 0;
    visited.add(value);
    if (ArrayBuffer.isView(value)) {
      if (buffers.has(value.buffer)) return 0;
      buffers.add(value.buffer); return value.buffer.byteLength;
    }
    if (value instanceof Map) return [...value.values()].reduce((sum, entry) => sum + visit(entry), 0);
    return Object.values(value).reduce((sum, entry) => sum + visit(entry), 0);
  };
  return values.reduce((sum, value) => sum + visit(value), 0);
}

function planJob(steps) {
  const it = (function* () {
    let next, previous = 0;
    while (!(next = guard(() => steps.next(it.hurry))).done) yield previous = next.value;
    it.plan = next.value;
    if (previous < 1) yield 1;
    return it.plan;
  })();
  it.plan = null; it.hurry = false;
  return it;
}

export function createPhotoPlan(data, width, height, options) { return complete(createPhotoPlanSteps(data, width, height, options)); }
export function createPhotoPlanSteps(data, width, height, options = {}) {
  const {quality, colorSpace} = admitOptions(options, 90), effort = admitEffort(options);
  planQuality(quality);
  const layout = admitPhotoLayout(width, height, options, quality);
  admitPixels(data, layout.codedWidth, layout.codedHeight, PHOTO_LIMITS);
  const samples = admitSampleFormat(data, options);
  if (!samples.native8) throw fault('JXL_INPUT', 'Retained photographic plans require eight-bit RGB samples with sRGB transfer and no ICC profile.');
  const extras = admitPhotoExtras(data, layout, options);
  const admitted = admitStrategyOptions(options), progression = progressivePasses(options.progressive);
  const authoredOrderPasses = prepareCoefficientOrders(options.coefficientOrders, progression?.count || 1);
  const noiseLut = admitNoise(options.noise, width, height), lfLevels = admitLFFrames(options.lfFrames);
  admitPhotoFilter(options);
  if (lfLevels && colorSpace !== 'srgb') throw fault('JXL_INPUT', 'Low-frequency frame pyramids currently require sRGB photographic pixels.');
  const maxRetainedBytes = options.maxRetainedBytes ?? PLAN_LIMITS.retainedBytes;
  if (!Number.isSafeInteger(maxRetainedBytes) || maxRetainedBytes < 1 || maxRetainedBytes > 2147483648)
    throw fault('JXL_INPUT', 'maxRetainedBytes is a positive whole number of bytes, at most 2 GiB.');
  const codedPixels = Math.ceil(layout.codedWidth / 8) * Math.ceil(layout.codedHeight / 8) * 64;
  const shapes = new Map(admitted.ids.map(id => {
    const shape = TRANSFORMS[id]; return [Math.max(shape.width, shape.height) + ':' + Math.min(shape.width, shape.height), shape.width * shape.height * 4];
  }));
  const estimate = codedPixels * (24 + 3 / 8 + 1 / 16 + 4) + [...shapes.values()].reduce((a, b) => a + b, 0)
    + retainedMemory(admitted.custom, noiseLut, authoredOrderPasses, layout, extras);
  if (estimate > maxRetainedBytes) throw fault('JXL_MEMORY', 'The retained coefficient estimate exceeds maxRetainedBytes (' + Math.ceil(estimate) + ' bytes required).');
  return planJob(preparePlanSteps(data, layout.codedWidth, layout.codedHeight, {quality, colorSpace, effort, admitted, progression, noiseLut,
    lfLevels, maxRetainedBytes, authoredOrderPasses, orientation: options.orientation ?? 1, layout, extras: snapshotPhotoExtras(extras)}));
}

function* preparePlanSteps(data, width, height, settings) {
  const originalWidth = settings.layout.width, originalHeight = settings.layout.height;
  const padded = padPhotoLayout(data, width, height, settings.layout, settings.noiseLut);
  if (padded) ({data, width, height} = padded);
  const retained = yield* strategyCoefficientSteps(data, width, height, settings.quality, settings.colorSpace,
    {orientation: settings.orientation}, settings.admitted, true);
  if (retained.alpha) retained.alpha = new Uint8Array(retained.alpha);
  for (const block of retained.strategyData.blocks) {
    delete block.coeffs; delete block.dc; delete block.cost; delete block.wide;
  }
  delete retained.components; delete retained.strategyData.tables;
  const retainedBytes = retainedMemory(retained, settings.admitted.custom, settings.noiseLut, settings.authoredOrderPasses, settings.layout, settings.extras);
  if (retainedBytes > settings.maxRetainedBytes) throw fault('JXL_MEMORY', 'Retained buffers exceed maxRetainedBytes (' + retainedBytes + ' bytes required).');
  return makePhotoPlan(retained, {...settings, originalWidth, originalHeight, padded: !!padded, retainedBytes});
}

function makePhotoPlan(retained, settings) {
  const tally = new Map();
  for (const block of retained.strategyData.blocks) tally.set(block.id, (tally.get(block.id) || 0) + 1);
  const strategies = Object.freeze([...tally].map(([id, blocks]) => Object.freeze({name: TRANSFORMS[id].name, blocks})));
  const ensure = () => { if (!retained) throw fault('JXL_INPUT', 'This photographic plan has been disposed.'); };
  const encodeSteps = (quality = settings.quality) => {
    ensure(); planQuality(quality);
    return job(encodeRetainedSteps(retained, quality, {...settings}));
  };
  const encodeTargetSteps = (targetBytes, options = {}) => {
    ensure(); const search = admitTarget(targetBytes, options);
    return targetJob(targetSteps(encodeSteps, targetBytes, search));
  };
  return Object.freeze({width: settings.originalWidth, height: settings.originalHeight, planningQuality: settings.quality,
    retainedBytes: settings.retainedBytes, blockCount: retained.strategyData.blocks.length, strategies,
    get disposed() { return retained === null; },
    encode: quality => complete(encodeSteps(quality)), encodeSteps,
    encodeTarget: (targetBytes, options) => complete(encodeTargetSteps(targetBytes, options)), encodeTargetSteps,
    dispose() { retained = null; settings.admitted = null; settings.noiseLut = null; settings.authoredOrderPasses = null; settings.layout = null; settings.extras = null; },
  });
}

function* encodeRetainedSteps(retained, quality, settings) {
  const {effort, progression, noiseLut, lfLevels} = settings;
  const image = yield* part(requantizeStrategySteps(retained, quality, settings.admitted), 0, lfLevels ? 3 : 2);
  applyPhotoLayout(image, settings.layout, settings.padded);
  applyPhotoExtras(image, settings.extras, settings.layout);
  image.progression = progression; image.noiseLut = noiseLut; image.authoredOrderPasses = settings.authoredOrderPasses;
  const frames = lfLevels && (yield* part(lfFrameSteps(image, lfLevels), 1, 3));
  const finish = bytes => {
    if (frames) bytes = prependLFFrames(bytes, frames);
    if (bytes[0] === 255 && !readImageHeader(bytes).modular16) bytes = photoLevelContainer(bytes, 10);
    return settings.padded ? cropPhotoCanvas(bytes, settings.originalWidth, settings.originalHeight) : bytes;
  };
  const shared = {}, codingPlan = effort >= 3 ? {clusters: {maxClusters: 32, newClusterCost: 160}} : {};
  if (image.wideCoefficients) return finish(yield* part(varDCTSteps(image, {...codingPlan, coding: quantParamCoding}, shared), lfLevels ? 2 : 1, lfLevels ? 3 : 2));
  if (effort < 2) return finish(yield* part(varDCTSteps(image, codingPlan, shared), lfLevels ? 2 : 1, lfLevels ? 3 : 2));
  const prefix = yield* part(varDCTSteps(image, codingPlan, shared), lfLevels ? 4 : 2, lfLevels ? 6 : 4), searchAt = lfLevels ? 5 / 6 : .75;
  if (yield searchAt) return finish(prefix);
  try {
    const candidate = varDCTSteps(image, {...codingPlan, coding: buildAnsCoding, modularAns: writeModularAnsHistograms}, shared);
    let next;
    while (!(next = candidate.next()).done) if ((yield searchAt + next.value * (1 - searchAt)) && next.value < 1) {
      candidate.return(); return finish(prefix);
    }
    return finish(next.value.length < prefix.length ? next.value : prefix);
  } catch (error) {
    if (!(error instanceof RangeError && !error.code) && error.code !== 'JXL_SIZE') throw error;
    return finish(prefix);
  }
}

function admitTarget(targetBytes, options) {
  if (!Number.isSafeInteger(targetBytes) || targetBytes < 1)
    throw fault('JXL_INPUT', 'targetBytes is a positive safe integer number of bytes.');
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw fault('JXL_INPUT', 'Target search options are an object.');
  const minQuality = planQuality(options.minQuality ?? 1), maxQuality = planQuality(options.maxQuality ?? 99.9), maxProbes = options.maxProbes ?? 12;
  const initialQuality = options.initialQuality === undefined ? null : planQuality(options.initialQuality);
  if (minQuality > maxQuality) throw fault('JXL_INPUT', 'minQuality does not exceed maxQuality.');
  if (initialQuality !== null && (initialQuality < minQuality || initialQuality > maxQuality))
    throw fault('JXL_INPUT', 'initialQuality lies between minQuality and maxQuality.');
  if (!Number.isInteger(maxProbes) || maxProbes < 2 || maxProbes > 32) throw fault('JXL_INPUT', 'maxProbes is an integer from 2 through 32.');
  return {minQuality, maxQuality, maxProbes, initialQuality};
}

function targetJob(steps) {
  const it = (function* () {
    let next, previous = 0;
    while (!(next = guard(() => steps.next(it.hurry))).done) yield previous = next.value;
    it.result = next.value; it.bytes = answer(next.value.bytes);
    if (previous < 1) yield 1;
    return it.result;
  })();
  it.result = null; it.bytes = null; it.hurry = false;
  return it;
}

function* targetSteps(encodeSteps, targetBytes, {minQuality, maxQuality, maxProbes, initialQuality}) {
  let best = null, smallest = Infinity, hurry = false;
  const probes = [];
  const probe = function* (quality) {
    const encoded = encodeSteps(quality); let next, bytes = null;
    try {
      while (!(next = encoded.next()).done) hurry = (yield scaled(next.value, done => (probes.length + done) / maxProbes)) || hurry;
      bytes = next.value;
    } catch (error) { if (error.code !== 'JXL_SIZE') throw error; }
    const length = bytes?.length ?? null; probes.push(Object.freeze({quality, bytes: length}));
    if (length !== null) {
      smallest = Math.min(smallest, length);
      if (length <= targetBytes && (!best || quality > best.quality)) best = {bytes, quality};
    }
    return length;
  };
  yield* probe(maxQuality);
  if (!best && initialQuality !== null && initialQuality !== maxQuality) yield* probe(initialQuality);
  if (best?.quality !== maxQuality && probes.length < maxProbes && minQuality !== maxQuality && minQuality !== initialQuality && !(hurry && best)) yield* probe(minQuality);
  if (best?.quality !== maxQuality && minQuality !== maxQuality) {
    for (const fraction of [.75, .5, .25, .875, .625, .375, .125]) {
      if (probes.length >= maxProbes || hurry && best) break;
      const quality = minQuality + (maxQuality - minQuality) * fraction;
      if (!probes.some(row => row.quality === quality)) yield* probe(quality);
    }
    while (probes.length < maxProbes && !(hurry && best)) {
      const ordered = probes.map(row => row.quality).sort((a, b) => a - b);
      let low, high;
      if (best) {
        low = best.quality; high = ordered.find(value => value > low);
      } else {
        const anchor = probes.reduce((a, b) => (b.bytes ?? Infinity) < (a.bytes ?? Infinity) ? b : a).quality;
        const at = ordered.indexOf(anchor), left = at ? anchor - ordered[at - 1] : -1;
        const right = at + 1 < ordered.length ? ordered[at + 1] - anchor : -1;
        if (right >= left) { low = anchor; high = ordered[at + 1]; }
        else { low = ordered[at - 1]; high = anchor; }
      }
      const quality = (low + high) / 2;
      if (!Number.isFinite(quality) || quality === low || quality === high) break;
      yield* probe(quality);
    }
  }
  if (!best) throw fault('JXL_SIZE', 'No probed quality fits the ' + targetBytes + '-byte target; ' +
    (smallest === Infinity ? 'all candidates exceed the encoded-file limit.' : 'the smallest measured candidate has ' + smallest + ' bytes.'));
  return Object.freeze({...best, targetBytes, probes: Object.freeze(probes)});
}
