import {offloading} from './offload.mjs';
// SPDX-License-Identifier: MIT
import {BitWriter, part, scaled, complete} from './bits.mjs';
import {writeModularFrameHeader, groupLayout, groupRect, groupPass, assembleCodestream, GROUP_DIM} from './frame.mjs';
import {writeImageHeader} from './icc-write.mjs';
import {buildCode, writePrefixCode, jobSmall, setJobSmall} from './prefix.mjs';
import {AVERAGE_PREDICTOR, GRADIENT_PREDICTOR, ALPHABET, leaf, split, channelTree, writeTree, writeModularHeader, writeChannelHistograms} from './modular.mjs';
import {codeChannel} from './modular-channel.mjs';
import {inspectPixels, inspectPixelsSteps, losslessSteps, planeFill, nativeSteps, iccShape, shapeFloors} from './lossless.mjs';
import {encodeNativeModular} from './native-modular.mjs';
import {lossySteps} from './lossy.mjs';
import {photoSteps, admitPhotoFilter, screenImageSteps, screenRouted} from './photo-job.mjs';
import {coefficientAnsSteps} from './coefficient-ans.mjs';
import {preferXYB} from './photo-xyb.mjs';
import {softPicture} from './v7/intent-quality.mjs';
import {smallPalette, SMALL_SCREEN, SMALL_PHOTO} from './small-palette.mjs';
import {WEIGHTED_PREDICTOR, WEIGHTED_PROPERTY, WEIGHTED_CUTS, codeWeighted} from './weighted.mjs';
import {fault, admitOptions, admitPixels} from './admit.mjs';
import {admitSampleFormat, statedSpace} from './admit-samples.mjs';
import {screenLike, flatSamples, flatSurround, tilesFit, CAPTURE_FLAT} from './screen.mjs';
import {captureFillClear} from './capture-kernels.mjs';
import {filledClear} from './core-steps.mjs';
import {screenPhotoRegions} from './screen-photo-regions.mjs';
import {exactSignal, signalSpace} from './color-signal.mjs';
import {encodeCaptureSteps, captureBusy, captureExact, CAPTURE_TOOLS, CAPTURE_LIMIT, CAPTURE_LEVEL, CAPTURE_FLOOR, CAPTURE_HELPERS, LEVELS, markCaptureExact, holdCaptureMemory} from './capture-codec.mjs';
import {CAPTURE_TOOLS_COMPLETE} from './capture-ans.mjs';
import {transformRanking} from './capture-trees.mjs';
import {FAST_EFFORT} from './effort-level.mjs';
import {stage, unit, journaling, journalRequest, journalFact, JOIN} from './step-journal.mjs';
import {exclusiveActive} from './turn.mjs';
import {recall, spaceKey, capture} from './call-memo.mjs';

const UPLOAD = typeof __RAPIER_JXL_UPLOAD__ !== 'undefined' && __RAPIER_JXL_UPLOAD__ === true;
export function effortJob(data, width, height, options, gpu = false, limits, search, writer = coefficientAnsSteps, deep = null, hdr = null) {
  const {quality, colorSpace} = admitOptions(options), effort = options?.effort === undefined ? FAST_EFFORT : options.effort;
  const filter = admitPhotoFilter(options);
  if (effort === 10 && (typeof __RAPIER_JXL_EFFORT_TEN__ === 'undefined' || __RAPIER_JXL_EFFORT_TEN__ === true)) {
    if (!deep?.effortTen) throw fault('JXL_INTERNAL', 'effort-job:effort-ten');
    admitPixels(data, width, height, limits);
    return quality < 100 ? effortTenLossyFallback(data, width, height, options, gpu, limits, search, writer, deep, hdr)
      : effortTen(data, width, height, options, limits, deep, hdr);
  }
  if (!Number.isInteger(effort) || effort < 1 || effort > 9) throw fault('JXL_INPUT', 'effort: integer 1-9');
  if (effort >= 4 && !deep) throw fault('JXL_INTERNAL', 'effort-job:exact-ladder');
  admitPixels(data, width, height, limits);
  const samples = admitSampleFormat(data, options);
  if (samples.iccSpace)
    return iccShape(data, samples.iccSpace, effortSteps(data, width, height, quality, samples.iccSpace, effort, options?.photo !== false, filter, false, search, writer, deep));
  if (!samples.native8 && quality >= 100 && exactSignal(samples)) return effortSteps(data, width, height, 100, signalSpace(samples), effort, false, filter, gpu, search, writer, deep);
  const stated = quality < 100 && statedSpace(samples);
  if (stated) return iccShape(data, stated, effortSteps(data, width, height, quality, stated, effort, options?.photo !== false, filter, false, search, writer, deep));
  if (!samples.native8) return hdr?.route(data, samples, quality) ? hdr.steps(data, width, height, quality, effort, samples, ef => exactNativeSteps(data, width, height, 100, samples, ef, deep), hdr.report)
    : exactNativeSteps(data, width, height, quality, samples, effort, deep, hdr?.report);
  return quality >= 100 ? exactSteps(data, width, height, colorSpace, effort, options?.photo !== false, deep)
    : effortSteps(data, width, height, quality, colorSpace, effort, options?.photo !== false, filter, gpu, search, writer, deep);
}

function* effortTenLossyFallback(data, width, height, options, gpu, limits, search, writer, deep, hdr) {
  return yield* effortJob(data, width, height, {...options, effort: 9}, gpu, limits, search, writer, deep, hdr);
}
const NINE_SHARE = 0.6;
function* effortTen(data, width, height, options, limits, deep, hdr) {
  const release = width * height <= 262144 ? holdCaptureMemory() : null;
  try { return yield* effortTenHeld(data, width, height, options, limits, deep, hdr); } finally { release?.(); }
}
function* effortTenHeld(data, width, height, options, limits, deep, hdr) {
  let hurried = false;
  const share = function* (steps, from, span) {
    let step, reply;
    try {
      while (!(step = steps.next(reply)).done) {
        reply = yield scaled(step.value, done => from + done * span);
        hurried ||= typeof step.value === 'number' && !!reply;
      }
      return step.value;
    } finally { if (!step?.done) steps.return?.(); }
  };
  const ahead = deep.effortTenAhead?.(data, width, height, options);
  if (ahead) yield {offload: 'prefetch', tasks: ahead, at: done => done};
  const nine = yield* stage('effort-9', () => share(effortJob(data, width, height, {...options, effort: 9}, false, limits, undefined, undefined, deep, hdr), 0, NINE_SHARE));
  if (hurried) return nine;
  const ten = yield* stage('effort-10', () => share(deep.effortTen(data, width, height, options), NINE_SHARE, 1 - NINE_SHARE));
  return ten instanceof Uint8Array && ten.length < nine.length ? ten : nine;
}

const exactSteps = (data, width, height, colorSpace, effort, photo, deep) => {
  const steps = recall(data, spaceKey(colorSpace) && `exact:${effort}:${spaceKey(colorSpace)}:${photo}:${!!deep?.frame}`,
    () => effortSteps(data, width, height, 100, colorSpace, effort, photo, undefined, false, undefined, undefined, deep));
  return colorSpace?.header ? markedExact(steps) : steps;
};
function* markedExact(steps) { return markCaptureExact(yield* steps); }

const CUTOUT_AT = [56.8, 57.8, 58.8, 60.2, 61.6, 63.3, 65, 67.5, 70, 72.5, 75, 77.5, 80, 82.5, 85, 87.5, 90, 92];
const CUTOUT_GRAY = [29.2, 30.5, 31.1, 33.6, 35.8, 38.4, 42.8, 47.3, 47.7, 51.2, 55.1, 62.8, 66.2, 71.5, 75.4, 85.8, 91.5, 91.5];
function cutoutQuality(quality, gray) {
  if (!gray) return quality + 2 * Math.max(0, Math.min(1, (quality - 80) / 2, (94 - quality) / 2));
  if (quality > CUTOUT_AT.at(-1)) return quality;
  let i = 1;
  while (i < CUTOUT_AT.length - 1 && CUTOUT_AT[i] < quality) i++;
  const u = Math.max(0, Math.min(1, (quality - CUTOUT_AT[i - 1]) / (CUTOUT_AT[i] - CUTOUT_AT[i - 1])));
  return Math.min(quality, CUTOUT_GRAY[i - 1] + u * (CUTOUT_GRAY[i] - CUTOUT_GRAY[i - 1]));
}

export const paletteCutout = (data, width, height, colorSpace, shape) => typeof colorSpace !== 'object' && !!shape.palette && !!shape.alpha &&
  flatSurround(data, width, height) && !screenLike(data, width, height);

const EXACT_BITS = 6, SMALL_PIXELS = 16384;
function* exactNativeSteps(data, width, height, quality, samples, effort, deep, report) {
  let facts = null, step, reply, hurried = false;
  const native = nativeSteps(data, width, height, {quality, samples, effort: quality < 100 ? effort : 1, deep, report: quality < 100 ? found => { facts = found; } : report});
  try { while (!(step = native.next(reply)).done) { reply = yield step.value; hurried ||= !!reply && !journalRequest(step.value); } } finally { if (!step?.done) native.return?.(); }
  const floor = step.value, answered = quality < 100 && facts?.kept !== 'pixels';
  const signal = quality < 100 && exactSignal(samples);
  const compare = answered && (effort > 1 && (!UPLOAD && effort >= 6 || width * height < SMALL_PIXELS) && floor.length * 8 >= EXACT_BITS * width * height || signal && width * height <= 65536);
  if (!hurried && signal && (!answered || compare) && !(journaling() && data instanceof Uint8Array)) {
    const sigExact = yield* effortSteps(data, width, height, 100, signalSpace(samples), effort, false, undefined, false, undefined, undefined, deep);
    if (sigExact.length <= floor.length) {
      report?.({kept: 'pixels', measurements: []});
      return markCaptureExact(sigExact);
    }
  }
  if (answered && !compare || hurried || effort < 2 || samples.icc || (journaling() && data instanceof Uint8Array)) {
    if (quality < 100 && facts) report?.(facts);
    return !answered && signal ? markCaptureExact(floor) : floor;
  }
  const shape = inspectPixels(data, width, height, {samples});
  let best = floor;
  const found = {};
  if (!shape.palette) {
    const learned = encodeNativeModular(data, width, height, samples, shape, effort, best, deep?.capture, found);
    if (learned.length < best.length) best = learned;
  }
  if (!found.compacted && !(quality < 100 && !compare)) {
    const exact = yield* nativeSteps(data, width, height, {quality: 100, samples, effort, deep});
    if (exact.length < best.length) best = exact;
  }
  if (quality < 100 && (facts || best !== floor)) report?.(best === floor ? facts : {kept: 'pixels', measurements: []});
  return best;
}

const exactAnswers = new WeakSet();
export const exactAnswer = bytes => exactAnswers.has(bytes) || captureExact(bytes);
const SMALL_TOP = 4;
const LADDER_PIXELS = 16384;
function* effortSteps(...args) {
  if (args[5] <= SMALL_TOP) return yield* smallSteps(args);
  const plain = yield* effortStepsOf(...args);
  if (args[3] < 100 || args[1] * args[2] > LADDER_PIXELS || !(plain instanceof Uint8Array)) return plain;
  const low = yield* smallSteps([...args.slice(0, 5), SMALL_TOP, ...args.slice(6)]);
  return low instanceof Uint8Array && low.length < plain.length ? low : plain;
}
function* smallSteps(args) {
  const steps = effortStepsOf(...args);
  let reply, step;
  try {
    for (;;) {
      const held = jobSmall(); setJobSmall(true);
      try { step = steps.next(reply); } finally { setJobSmall(held); }
      if (step.done) break;
      const value = step.value;
      reply = yield value?.capture ? {...value, capture: {...value.capture, small: true}} : value;
    }
    return step.value;
  } finally { if (!step?.done) steps.return?.(); }
}
function* effortStepsOf(data, width, height, quality, colorSpace, effort, photo = true, filter, gpu = false, search, writer = coefficientAnsSteps, deep = null) {
  const shape = yield* inspectPixelsSteps(data, width, height);
  if (quality < 100) {
    if (!shape.palette) {
      const pixels = shape.alpha ? yield* filledClear(data, width, height) : data;
      const lossy = photo ? photoSteps(pixels, width, height, quality, colorSpace, effort,
        writer, filter, search, gpu) : lossySteps(pixels, width, height, {quality, shape, colorSpace});
      const screen = photo && effort >= 2 ? yield* screenProbe(data, width, height, quality, colorSpace, filter, search, gpu, writer) : null;
      if (screen?.exact) { lossy.return?.(); return screen.captured; }
      if (screen) {
        const shared = screen.image && screenRouted(data, width, height, colorSpace, effort);
        if (shared) lossy.return?.();
        const bytes = yield* within(shared ? coefficientAnsSteps(screen.image, effort) : lossy, 0.1, 0.9);
        let best = screen.captured.length <= bytes.length ? screen.captured : bytes;
        const regions = screenPhotoRegions(data, width, height);
        if (regions.length) {
          const mixed = yield {screenPhoto: {data, width, height, quality, regions, effort}};
          if (mixed instanceof Uint8Array && mixed.length < best.length) best = mixed;
        }
        return best;
      }
      const lower = !UPLOAD && shape.alpha && effort >= 6;
      const answer = yield* capturedFloor(data, width, height, colorSpace, yield* (lower ? within(lossy, 0, 0.5) : lossy), true);
      return lower ? yield* within(lowerFile(data, width, height, quality, colorSpace, effort, photo, filter, search, gpu, writer, deep, answer), 0.5, 0.5) : answer;
    }
    if (effort <= 5 && paletteCutout(data, width, height, colorSpace, shape)) {
      const captured = yield* capture({data, width, height, colorSpace});
      if (captured instanceof Uint8Array) {
        if (effort < 2) return captured;
        let bytes = captured;
        try { bytes = yield* lossySteps(data, width, height, {quality: cutoutQuality(quality, shape.colour === 1), shape, colorSpace}); }
        catch (error) { if (error.code !== 'JXL_SIZE') throw error; }
        return bytes.length < captured.length ? bytes : captured;
      }
    }
    const palette = (function* () {
      const screen = effort >= 2 && typeof colorSpace !== 'object' && screenLike(data, width, height);
      const small = smallPalette(data, width, height, colorSpace);
      const captured = (screen || small === SMALL_SCREEN) && !deep?.frame ? yield* capture({data, width, height, colorSpace}) : null;
      const photograph = photo && effort >= 2 && typeof colorSpace !== 'object' && (small ? small === SMALL_PHOTO : !screen && (preferXYB(data, width, height) || (yield* soft(data, width, height)))), parts = photograph ? 3 : 2;
      const exact = captured instanceof Uint8Array ? captured : yield* part(exactSteps(data, width, height, colorSpace, effort, true, deep), 0, parts);
      let bytes = exact;
      if (!small) try { bytes = yield* part(lossySteps(data, width, height, {quality, shape, colorSpace}), 1, parts); }
      catch (error) { if (error.code !== 'JXL_SIZE') throw error; bytes = exact; }
      let best = exact.length <= bytes.length ? exact : bytes;
      if (photograph) {
        const file = yield* part(photoSteps(data, width, height, quality, colorSpace, effort, writer, filter, search, gpu), 2, 3);
        if (file.length < best.length) best = file;
      }
      if (best === exact) exactAnswers.add(best);
      return best;
    })();
    return yield* palette;
  }
  if (effort < 2) {
    const steps = losslessSteps(data, width, height, {shape, colorSpace});
    if (screenLike(data, width, height) || typeof colorSpace === 'object') {
      return effort <= SMALL_TOP && width * height <= 16384 && typeof colorSpace !== 'object' && !deep?.frame
        ? yield* capturedFloor(data, width, height, colorSpace, yield* steps, false, true)
        : yield* screenFirst(data, width, height, colorSpace, steps);
    }
    const pixels = width * height, flat = flatSamples(data, width, height) >= CAPTURE_FLAT || (effort <= SMALL_TOP ? pixels <= 524288 : pixels >= 4096 && pixels <= 524288);
    return yield* (!flat || deep?.frame ? screenFirst(data, width, height, colorSpace, steps, flat)
      : capturedFloor(data, width, height, colorSpace, yield* steps, false, true));
  }
  const analysis = {};
  let made = null;
  const streamOf = function* () {
    return made ??= journaling() ? yield* stage('core-stream', () => unitsOnly(losslessSteps(data, width, height, {shape, colorSpace, units: true})))
      : complete(losslessSteps(data, width, height, {shape, colorSpace, ...(deep?.limit > 0 && {limit: deep.limit})}));
  };
  const screen = losslessScreenCandidate(data, width, height, shape, effort);
  const isScreen = journaling() ? yield* unit('screen-only', () => screenLike(data, width, height)) : screenLike(data, width, height);
  const screenish = isScreen || (journaling() ? yield* unit('screenish', () => flatSamples(data, width, height) >= CAPTURE_FLAT)
    : flatSamples(data, width, height) >= CAPTURE_FLAT);
  const stream = effort < 3 || isScreen ? yield* streamOf() : null;
  const captureSizes = {};
  const greyPalette = !isScreen && !!shape.palette && shape.colour === 1 && !deep?.frame && width * height > 65536;
  const photoPage = !isScreen && !shape.palette && !deep?.frame && effort <= 3 && width * height > 2100000;
  const tiled = !isScreen && !shape.palette && !deep?.frame && typeof colorSpace !== 'object' && tilesFit(data, width, height);
  const smallNonScreen = effort <= SMALL_TOP && !screenish && !shape.palette && width * height <= 65536;
  const captured = (!photoPage || tiled) && (screenish || (shape.palette || smallNonScreen) && !deep?.frame || tiled)
    ? yield* exactCapture({data, width, height, colorSpace, effort: greyPalette && effort <= 5 || smallNonScreen ? 3 : Math.max(effort, 3), tools: deep?.capture, small: !deep?.frame, sizes: captureSizes, ...(deep?.limit > 0 && {limit: deep.limit})}) : null;
  if (photoPage && tiled && captured instanceof Uint8Array) return captured;
  if (!deep?.frame && typeof colorSpace !== 'object' && isScreen && captured instanceof Uint8Array && captured.length <= PROBE * stream.length && (!UPLOAD && effort >= 6 || captureSizes.three <= PROBE * stream.length)) {
    if ((typeof __RAPIER_JXL_UPLOAD__ !== 'undefined' && __RAPIER_JXL_UPLOAD__ === true) || effort < 6) return captured;
    try {
      const rank = yield* rankingOf(data, width, height, shape, colorSpace);
      const bytes = yield* losslessCapture(data, width, height, colorSpace, losslessLevel(effort, ...rank, deep?.frame), smallLearnedFloor(effort, ...rank, deep?.frame), deep?.limit);
      if (bytes && bytes.length < captured.length) return bytes;
    } catch (error) { if (error.code !== 'JXL_SIZE') throw error; }
    return captured;
  }
  const fast = captured instanceof Uint8Array && (!stream || captured.length < stream.length) ? captured : stream;
  const paletteAlone = !isScreen && !!shape.palette && captured instanceof Uint8Array && !deep?.frame && !deep?.screenSteps &&
    typeof colorSpace !== 'object' && width * height > 65536;
  const alone = !screen && (effort < 4 || !shape.palette) || paletteAlone;
  const core = alone ? (function* () { return fast; })() : losslessSteps(data, width, height, {shape, colorSpace, analysis});
  let step, reply, hurried = false;
  try { while (!(step = core.next(reply)).done) { reply = yield scaled(step.value, done => done / 2); hurried ||= !!reply && !journalRequest(step.value); } } finally { if (!step?.done) core.return?.(); }
  let best = step.value !== fast && step.value && (!fast || step.value.length < fast.length) ? step.value : fast;
  if (hurried) return best ?? (yield* streamOf());
  const direct = shape.palette ? {...shape, palette: null} : shape;
  if (effort >= 4 || screen) {
    const searches = alone ? [] : [() => searchSteps(data, width, height, direct, colorSpace, 3, analysis, screen ? best.length : Infinity)];
    if (!(typeof __RAPIER_JXL_UPLOAD__ !== 'undefined' && __RAPIER_JXL_UPLOAD__ === true)) {
      if (effort >= 4 && shape.palette && !paletteAlone) searches.push(() => deep.localSteps(data, width, height, shape, colorSpace, 4, true, best?.length ?? Infinity));
      if (effort >= 6 && shape.palette) searches.push(() => deep.localSteps(data, width, height, shape, colorSpace, 6, true, best?.length ?? Infinity));
      if (effort >= 4 && !alone) searches.push(() => deep.rctSearchSteps(data, width, height, shape, colorSpace));
    }
    const [ranked, estimate, pixels] = yield* rankingOf(data, width, height, shape, colorSpace), colours = shape.palette?.colours.length ?? 0;
    const held = captured instanceof Uint8Array && !deep?.frame && typeof colorSpace !== 'object' && colours > 1 && colours * 32 <= pixels &&
      (pixels > 262144 || colours <= 512) && (estimate === undefined || estimate < 1.35 * captured.length);
    const level = held ? Object.freeze({...losslessLevel(effort, ranked, estimate, pixels, deep?.frame), paletteBytes: captured})
      : losslessLevel(effort, ranked, estimate, pixels, deep?.frame);
    searches.unshift(() => losslessCapture(data, width, height, colorSpace, level, smallLearnedFloor(effort, ranked, estimate, pixels, deep?.frame), deep?.limit > 0 ? (best ? Math.min(deep.limit, best.length) : deep.limit) : 0));
    const older = !(typeof __RAPIER_JXL_UPLOAD__ !== 'undefined' && __RAPIER_JXL_UPLOAD__ === true) && deep?.screenSteps;
    if (older && screen) searches.unshift(() => older(data, width, height, shape, colorSpace, {fastFloor: effort === 3 ? best.length : 0, effort, deep: deep.screen}));
    if (older && effort >= 4 && !screen && losslessScreenCandidate(data, width, height, shape, 3))
      searches.unshift(() => older(data, width, height, shape, colorSpace, {fastFloor: best.length, effort: 3, deep: deep.screen}));
    const count = searches.length;
    for (let i = 0; i < searches.length; i++) {
      try {
        const search = searches[i]();
        let step, reply, hurried = false;
        try { while (!(step = search.next(reply)).done) hurried = !!(reply = yield scaled(step.value, done => 0.5 + (i + done) / (2 * count))) && !journalRequest(step.value); } finally { if (!step?.done) search.return?.(); }
        if (step.value && (!best || step.value.length < best.length)) best = step.value;
        if (hurried) return best ?? (yield* streamOf());
      } catch (error) { if (error.code !== 'JXL_SIZE') throw error; }
    }
    return best ?? (yield* streamOf());
  }
  try {
    const level = losslessLevel(3, ...(yield* rankingOf(data, width, height, shape, colorSpace)));
    const bytes = yield* part(losslessCapture(data, width, height, colorSpace, level, null, deep?.limit > 0 ? (best ? Math.min(deep.limit, best.length) : deep.limit) : 0), 1, 2);
    if (bytes && (!best || bytes.length < best.length)) best = bytes;
  } catch (error) { if (error.code !== 'JXL_SIZE') throw error; }
  return best ?? (yield* streamOf());
}

export function losslessScreenCandidate(data, width, height, shape, effort) {
  return effort === 3 ? !!shape.palette : !UPLOAD && effort >= 4 && screenLike(data, width, height);
}


function* screenFirst(data, width, height, colorSpace, steps, flat = false) {
  if (typeof colorSpace !== 'object' && (flat || screenLike(data, width, height))) {
    const captured = yield* capture({data, width, height, colorSpace});
    if (captured instanceof Uint8Array) return captured;
  }
  return yield* steps;
}

const PROBE = 0.7;
function* screenProbe(data, width, height, quality, colorSpace, filter, search, gpu, writer = coefficientAnsSteps) {
  if (typeof colorSpace === 'object' || !screenLike(data, width, height)) return null;
  const captured = yield* capture({data, width, height, colorSpace});
  if (!(captured instanceof Uint8Array)) return null;
  const image = screenRouted(data, width, height, colorSpace, 1) ? yield* part(screenImageSteps(data, width, height, quality), 0, 20) : null;
  const probe = image ? yield* part(coefficientAnsSteps(image, 1), 1, 20)
    : yield* part(photoSteps(data, width, height, quality, colorSpace, 1, writer, filter, search, gpu), 0, 10);
  return {captured, image, exact: captured.length <= PROBE * probe.length};
}

function* lowerFile(data, width, height, quality, colorSpace, effort, photo, filter, search, gpu, writer, deep, answer) {
  const lower = yield* effortSteps(data, width, height, quality, colorSpace, 5, photo, filter, false, search, writer, deep);
  return lower.length < answer.length ? lower : answer;
}

function* soft(data, width, height) {
  return journaling() ? yield* unit('soft', () => softPicture(data, width, height)) : softPicture(data, width, height);
}

function* within(steps, from, span) {
  let step, reply;
  try {
    while (!(step = steps.next(reply)).done) reply = yield scaled(step.value, done => from + done * span);
    return step.value;
  } finally { steps.return?.(); }
}

function* capturedFloor(data, width, height, colorSpace, bytes, lossy = false, flat = false) {
  if (typeof colorSpace === 'object' || !flat && !screenLike(data, width, height)) return bytes;
  const captured = yield* capture({data, width, height, colorSpace});
  return captured instanceof Uint8Array && (lossy ? captured.length <= bytes.length : captured.length < bytes.length) ? captured : bytes;
}

const LOSSLESS = Object.freeze({...LEVELS[3], lane: false, channelsToo: false, ans: true, trees: 'learned', references: true, noRuns: true, fixedFallback: true, needs: ['trees', 'ans'], floor: false, patches: false, patchesAbove: false, routes: 'one', fineTiles: false, compareTiles: false, finerTiles: false});
const PRECISE = /* @__PURE__ */ Object.freeze([5, 3, 6, 1, 2, 4, 7, 8, 9, 10, 11, 12, 13, 0]);
const BROAD = /* @__PURE__ */ Object.freeze([5, 3, 6, 1, 2, 4, 13, 0]);
const SMALL_FAST = Object.freeze({referenceKinds: Object.freeze([]), properties: Object.freeze([15, 9, 10, 11, 12, 13, 14])});
export function losslessSets(effort, ranked = [6, 6]) {
  const [first, second] = ranked, small = !(typeof __RAPIER_JXL_UPLOAD__ !== 'undefined' && __RAPIER_JXL_UPLOAD__ === true) && effort >= 6 ? Object.freeze({charge: 0, predictors: PRECISE, bins: 255, nodes: 255, clustered: false}) : SMALL_FAST;
  const set = (rcts, learn) => Object.freeze({rcts: [...new Set(rcts)], learn: Object.freeze({...learn, leaf: true, small})});
  if (typeof __RAPIER_JXL_UPLOAD__ !== 'undefined' && __RAPIER_JXL_UPLOAD__ === true) return [set([first], {samples: 4096, nodes: 31})];
  const five = {samples: 32768, nodes: 127}, six = {samples: 65536, nodes: 169}, seven = {samples: 196608, nodes: 1023, bins: 64, charge: 8, predictors: BROAD};
  const grown = {...seven, samples: 262144};
  const eight = {samples: 131072, nodes: 575, predictors: PRECISE, bins: 128, charge: 8, clustered: true, clusters: 80, histBase: 38, histSym: 4.2}, nine = {...eight, samples: 393216, nodes: 1919, bins: 192, charge: 4, leafBits: 18, clusters: 84};
  if (effort >= 9) return [set([first], nine), set([first], grown), set([first, second], eight), set([first], seven)];
  if (effort >= 8) return [set([first], grown), set([first, second], eight), set([first], seven)];
  if (effort >= 7) return [set([first], seven), set([first], six)];
  if (effort >= 6) return [set([first], six), set([first], five)];
  return [effort >= 5 ? set([first], five)
    : effort >= 4 ? set([first], {samples: 16384, nodes: 63}) : set([first], {samples: 4096, nodes: 31})];
}
const PUBLISHED_SEVEN = /* @__PURE__ */ Object.freeze({samples: 131072, nodes: 255, bins: 128, predictors: BROAD}), PUBLISHED_PIXELS = 8192;
function publishedSeven(ranked) {
  const [own] = losslessSets(7, ranked);
  return Object.freeze({rcts: own.rcts, learn: Object.freeze({...PUBLISHED_SEVEN, leaf: true, small: own.learn.small})});
}
function smallSets(effort, ranked, pixels) {
  const seen = new Map(), wide = !(typeof __RAPIER_JXL_UPLOAD__ !== 'undefined' && __RAPIER_JXL_UPLOAD__ === true) && pixels <= 4096 && effort >= 6 ? 16 : 2;
  for (let e = pixels <= 4096 && effort <= 5 ? effort : 2; e <= effort; e++) for (const set of losslessSets(e, ranked)) seen.set(JSON.stringify(set), set);
  if (!(typeof __RAPIER_JXL_UPLOAD__ !== 'undefined' && __RAPIER_JXL_UPLOAD__ === true) && effort >= 7 && pixels <= PUBLISHED_PIXELS) { const set = publishedSeven(ranked); seen.set(JSON.stringify(set), set); }
  return [...seen.values()].map(set => Object.freeze({...set, rcts: [...new Set([...set.rcts, ...ranked.slice(0, wide), 6])]}));
}
function frameSets(effort, ranked, pixels) {
  const seen = new Map();
  for (const set of [...losslessSets(effort, ranked), ...smallSets(5, ranked, pixels)]) seen.set(JSON.stringify(set), set);
  if (effort === 7 && pixels <= PUBLISHED_PIXELS) { const set = publishedSeven(ranked); seen.set(JSON.stringify(set), set); }
  return [...seen.values()];
}
export const NOISE = Object.freeze({rcts: Object.freeze([0]), learn: Object.freeze({leaf: true, whole: true, least: Infinity})});
export const retained = sets => sets.reduce((n, set) => n + set.rcts.length, 0) > 1
  ? sets.map(set => Object.freeze({...set, learn: Object.freeze({...set.learn, retainWeighted: true})})) : sets;
export const losslessLevel = (effort, ranked, estimate, pixels = Infinity, frame = false) => Object.freeze({...LOSSLESS, estimate, treeContexts: !(typeof __RAPIER_JXL_UPLOAD__ !== 'undefined' && __RAPIER_JXL_UPLOAD__ === true) && effort >= 7, gate: !(typeof __RAPIER_JXL_UPLOAD__ !== 'undefined' && __RAPIER_JXL_UPLOAD__ === true) && effort >= 6 ? 2 : 1.5,
  ...(!(typeof __RAPIER_JXL_UPLOAD__ !== 'undefined' && __RAPIER_JXL_UPLOAD__ === true) && effort === 9 && !(estimate * 8 >= 16 * pixels) && pixels > 65536 && {learnedNine: Object.freeze([ranked[0], ranked[1]])}),
  learnSets: retained(estimate * 8 >= 16 * pixels ? [...losslessSets(Math.min(effort, 3), ranked), NOISE] : pixels > 65536 ? losslessSets(effort, ranked) : !(typeof __RAPIER_JXL_UPLOAD__ !== 'undefined' && __RAPIER_JXL_UPLOAD__ === true) && frame && effort >= 6 && effort <= 7 ? frameSets(effort, ranked, pixels) : smallSets(effort, ranked, pixels))});
const smallLearnedFloor = (effort, ranked, estimate, pixels, frame) => effort > SMALL_TOP && !frame && pixels > LADDER_PIXELS && pixels <= 65536
  ? losslessLevel(SMALL_TOP, ranked, estimate, pixels) : null;
export function* rankingOf(data, width, height, shape, colorSpace) {
  if (!journaling() || shape.colour !== 3) return ranking(data, width, height, shape);
  return yield* unit('ranking', () => { const [ranked, estimate, pixels] = ranking(data, width, height, shape); return [Array.from(ranked), estimate, pixels]; });
}
function ranking(data, width, height, shape) {
  if (shape.colour !== 3) return [[6, 6], undefined, width * height];
  const ranked = transformRanking(data, width, height);
  return [ranked, ranked.bits * width * height / 8, width * height];
}
export function* exactCapture(request) {
  const {data, width, height, colorSpace, sizes} = request;
  if (typeof colorSpace !== 'object') return yield {capture: request};
  const floor = {...shapeFloors.get(data), ...request.floor, colour: colorSpace.colorChannels ?? 3};
  const bytes = yield {capture: {...request, colorSpace: 'srgb', floor}};
  if (!(bytes instanceof Uint8Array)) return null;
  const profiled = withProfile(bytes, width, height, colorSpace);
  if (profiled && sizes) for (const key of Object.keys(sizes)) sizes[key] += profiled.length - bytes.length;
  return profiled;
}

function withProfile(bytes, width, height, space) {
  const colour = space.colorChannels ?? 3;
  for (const alpha of [false, true]) {
    const plain = new BitWriter(64);
    writeImageHeader(plain, width, height, colour, alpha, {colorSpace: 'srgb'});
    const head = plain.finish();
    if (head.length >= bytes.length || head.some((byte, i) => byte !== bytes[i])) continue;
    const profiled = new BitWriter(1024);
    writeImageHeader(profiled, width, height, colour, alpha, {colorSpace: space});
    const out = profiled.finish(), file = new Uint8Array(out.length + bytes.length - head.length);
    file.set(out); file.set(bytes.subarray(head.length), out.length);
    return file;
  }
  return null;
}
export function* losslessCapture(data, width, height, colorSpace, level, smallFloor = null, limit = 0) {
  const ownSteps = losslessFile(data, width, height, colorSpace, level, jobSmall(), false, limit);
  const own = yield* (smallFloor ? within(ownSteps, 0, 1 / 2) : ownSteps);
  if (!smallFloor) return own;
  const lowLimit = limit > 0 && own instanceof Uint8Array ? Math.min(limit, own.length) : limit;
  let low;
  try { low = yield* within(losslessFile(data, width, height, colorSpace, smallFloor, true, true, lowLimit), 1 / 2, 1 / 2); }
  catch (error) { if (error.code !== 'JXL_SIZE') throw error; }
  return low instanceof Uint8Array && (!(own instanceof Uint8Array) || low.length < own.length) ? low : own;
}
function* losslessFile(data, width, height, colorSpace, level, small, localOnly = false, limit = 0) {
  if (typeof colorSpace === 'object') {
    const bytes = yield* losslessFile(data, width, height, 'srgb', level, small, localOnly);
    return bytes && withProfile(bytes, width, height, colorSpace);
  }
  while (captureBusy() || exclusiveActive()) if (yield 0) return null;
  const rowSource = journaling() && journalFact(data, JOIN);
  const source = rowSource ? {width, height, rows: (y, count) => data.subarray(y * width * 4, (y + count) * width * 4), ...(typeof data.rect === 'function' && {rect: (x, y, w, h) => data.rect(x, y, w, h), ahead: (a, b, x, w) => data.ahead?.(a, b, x, w)})} : data;
  const tasks = (typeof __RAPIER_JXL_EFFORT_TEN__ === 'undefined' || __RAPIER_JXL_EFFORT_TEN__ === true) && Boolean(level.groupTasks);
  const useHelpers = !localOnly && ((typeof __RAPIER_JXL_EFFORT_TEN__ === 'undefined' || __RAPIER_JXL_EFFORT_TEN__ === true) && tasks || !rowSource && !journaling() && offloading('capture-group'));
  const steps = encodeCaptureSteps(source, width, height, {colorSpace, effort: 3, small, [CAPTURE_TOOLS]: CAPTURE_TOOLS_COMPLETE, [CAPTURE_LEVEL]: level, [CAPTURE_FLOOR]: shapeFloors.get(data), ...(useHelpers && {[CAPTURE_HELPERS]: true}), ...(limit > 0 && {[CAPTURE_LIMIT]: limit})});
  let step;
  try {
    let reply;
    while (!(step = steps.next(reply)).done) {
      reply = undefined;
      if (journalRequest(step.value) || step.value?.gpu || (typeof __RAPIER_JXL_EFFORT_TEN__ === 'undefined' || __RAPIER_JXL_EFFORT_TEN__ === true) && tasks && (step.value?.groups || step.value?.stripTrees)) reply = yield step.value;
      else if (step.value?.groups) reply = yield {offload: 'capture-groups', ...step.value.groups};
      else if (step.value?.singleCandidates && !((typeof __RAPIER_JXL_EFFORT_TEN__ === 'undefined' || __RAPIER_JXL_EFFORT_TEN__ === true) && tasks)) reply = yield {offload: 'capture-single', ...step.value.singleCandidates};
      else if (typeof step.value === 'number' && (yield step.value) && step.value < 1) return null;
    }
  } finally { steps.return?.(); }
  return step.value;
}

function* unitsOnly(steps) {
  let step, reply;
  try {
    while (!(step = steps.next(reply)).done) reply = journalRequest(step.value) ? yield step.value : undefined;
  } finally { if (!step?.done) steps.return?.(); }
  return step.value;
}

const estimatedRawBits = s => Math.max(0, s < 224 ? s - 1 : s - 236);
function cost(freqs) {
  const code = buildCode(freqs), writer = new BitWriter(128);
  writePrefixCode(writer, code);
  let bits = writer.bitLength;
  for (let s = 0; s < freqs.length; s++) if (freqs[s]) bits += freqs[s] * (code.lengths[s] + estimatedRawBits(s));
  return bits;
}

export function minimumSearchDataBits(freqs) {
  const leaves = []; let bits = 0;
  for (let s = 0; s < freqs.length; s++) if (freqs[s]) {
    leaves.push(freqs[s]); bits += freqs[s] * (s < 224 ? Math.max(0, s - 1) : s < 240 ? 0 : s - 236);
  }
  leaves.sort((a, b) => a - b);
  const parents = []; let a = 0, b = 0;
  const take = () => a < leaves.length && (b >= parents.length || leaves[a] <= parents[b]) ? leaves[a++] : parents[b++];
  for (let i = 1; i < leaves.length; i++) { const weight = take() + take(); parents.push(weight); bits += weight; }
  return bits;
}
const sum = histograms => { const out = new Uint32Array(ALPHABET); for (const h of histograms) for (let s = 0; s < ALPHABET; s++) out[s] += h[s]; return out; };

const CONTEXTS = WEIGHTED_CUTS.length + 1, IDENTITY = Int32Array.from({length: CONTEXTS}, (_, k) => k);

function searchGroup(setup) {
  const {channels, first, plans, contexts = CONTEXTS, countFirst = true} = setup, fill = planeFill(setup), leaves = first?.map(p => leaf(p));
  const planes = Array.from({length: channels}, () => new Int16Array(GROUP_DIM * GROUP_DIM));
  return (rgba, stride, x0, y0, w, h, target) => {
    fill(planes, rgba, stride, x0, y0, w, h);
    if (!plans) {
      for (let c = 0; c < channels; c++) {
        if (countFirst) codeChannel(null, target[c], planes[c], w, h, leaves[c]);
        const base = (countFirst ? channels : 0) + c * contexts;
        codeWeighted(null, target.slice(base, base + contexts), planes[c], w, h, 0, contexts === 1 ? undefined : IDENTITY);
      }
      return;
    }
    const section = target || new BitWriter(w * h * channels + 64);
    if (!target) writeModularHeader(section, {useGlobalTree: true, transforms: []});
    plans.forEach(({leaf: l, codes, contextOf}, c) => {
      if (l.predictor === WEIGHTED_PREDICTOR) codeWeighted(section, codes, planes[c], w, h, 0, contextOf);
      else codeChannel(section, codes[0], planes[c], w, h, l);
    });
    return target ? undefined : section.finish();
  };
}

export function* searchSteps(rgba, width, height, shape, colorSpace, effort, analysis, ceiling = Infinity) {
  const {channels} = shape, layout = groupLayout(width, height), groups = layout.groupsX * layout.groupsY;
  const setup = {channels, alpha: shape.alpha, palette: null}, fill = planeFill(setup);
  const planes = Array.from({length: channels}, () => new Int16Array(32 * 32));
  const rect = g => groupRect(layout, width, height, g);
  const sw = Math.min(width, 32), sh = Math.min(height, 32);
  const cached = analysis?.direct;
  const sampled = !cached && [GRADIENT_PREDICTOR, AVERAGE_PREDICTOR].map(predictor => ({predictor, freqs: planes.map(() => new Uint32Array(ALPHABET))}));
  if (!cached) {
    for (const fraction of [0, 0.5, 1]) {
      fill(planes, rgba, width, Math.floor((width - sw) * fraction), Math.floor((height - sh) * fraction), sw, sh);
      for (const candidate of sampled) for (let c = 0; c < channels; c++) codeChannel(null, candidate.freqs[c], planes[c], sw, sh, leaf(candidate.predictor));
    }
  }
  const first = cached ? cached.first.map(p => leaf(p)) : planes.map((_, c) => leaf(sampled[cost(sampled[1].freqs[c]) < cost(sampled[0].freqs[c]) ? 1 : 0].predictor));
  const contexts = effort < 3 ? 1 : CONTEXTS;
  const firstCounts = cached?.freqs || planes.map(() => new Uint32Array(ALPHABET)), intervals = planes.map(() => Array.from({length: contexts}, () => new Uint32Array(ALPHABET)));
  const counts = [...(cached ? [] : firstCounts), ...intervals.flat()];
  const counted = {...setup, first: first.map(l => l.predictor), contexts, countFirst: !cached}, count = searchGroup(counted);
  if (Number.isFinite(ceiling)) {
    const fixed = cached ? firstCounts.map(minimumSearchDataBits) : null;
    for (let g = 0; g < groups; g++) {
      count(rgba, width, ...rect(g), counts);
      const baseline = fixed || firstCounts.map(minimumSearchDataBits);
      const bits = intervals.reduce((n, channel, c) => n + Math.min(baseline[c], channel.reduce((sum, hist) => sum + minimumSearchDataBits(hist), 0)), 0);
      const hurried = yield (g + 1) / (2 * groups);
      if (bits >= ceiling * 8 || hurried) return null;
    }
  } else if ((yield* groupPass({at: g => (g + 1) / (2 * groups), stop: () => true}, groups, g => count(rgba, width, ...rect(g), counts))) === null) return null;
  const rung2 = planes.map((_, c) => {
    const plan = {cost: cost(firstCounts[c]), leaves: [first[c]], freqs: [firstCounts[c]], cuts: []};
    const whole = sum(intervals[c]), single = cost(whole);
    return single < plan.cost ? {cost: single, leaves: [leaf(WEIGHTED_PREDICTOR)], freqs: [whole], cuts: []} : plan;
  });
  const rung3 = effort < 3 ? rung2 : rung2.map((plan, c) => {
    const filled = intervals[c].map(h => h.some(v => v));
    const best = new Float64Array(contexts + 1).fill(Infinity), from = new Int32Array(contexts + 1);
    best[0] = 0;
    for (let j = 1; j <= contexts; j++) {
      const merged = new Uint32Array(ALPHABET);
      let bits = 0;
      for (let i = j - 1; i >= 0; i--) {
        if (filled[i]) { const h = intervals[c][i]; for (let s = 0; s < ALPHABET; s++) merged[s] += h[s]; bits = cost(merged); }
        const price = best[i] + bits + 24;
        if (price < best[j]) { best[j] = price; from[j] = i; }
      }
    }
    if (!(best[contexts] < plan.cost)) return plan;
    const groupsOf = [];
    for (let j = contexts; j > 0; j = from[j]) groupsOf.unshift([from[j], j]);
    return {cost: best[contexts], leaves: groupsOf.map(() => leaf(WEIGHTED_PREDICTOR)), freqs: groupsOf.map(([i, j]) => sum(intervals[c].slice(i, j))), cuts: groupsOf.slice(0, -1).map(([, j]) => WEIGHTED_CUTS[j - 1]),
      contextOf: Int32Array.from({length: contexts}, (_, k) => groupsOf.findIndex(([i, j]) => k >= i && k < j))};
  });
  const candidates = [rung2, rung3].filter((plans, k) => k ? plans.some((plan, c) => plan !== rung2[c]) : plans.some((plan, c) => plan.leaves[0] !== first[c]));
  if (!candidates.length) return null;
  const byError = (leaves, cuts) => {
    const build = (lo, hi) => { if (lo === hi) return leaves[lo]; const mid = (lo + hi) >> 1; return split(WEIGHTED_PROPERTY, cuts[mid], build(mid + 1, hi), build(lo, mid)); };
    return build(0, leaves.length - 1);
  };
  const assemble = plans => ({tree: channelTree(plans.map(plan => byError(plan.leaves, plan.cuts))), leaves: plans.flatMap(plan => plan.leaves), freqs: plans.flatMap(plan => plan.freqs)});
  const model = plans => {
    const {tree, leaves, freqs} = assemble(plans), w = new BitWriter(4096);
    const histograms = writeChannelHistograms(w, writeTree(w, tree), freqs, l => leaves.indexOf(l));
    let bits = w.bitLength;
    freqs.forEach((f, i) => { const {lengths} = histograms[i + 1].code; for (let s = 0; s < f.length; s++) if (f[s]) bits += f[s] * (lengths[s] + estimatedRawBits(s)); });
    return {bits, header: w, leaves, histograms};
  };
  const models = new Map(candidates.map(plans => [plans, model(plans)]));
  let chosen = candidates;
  if (candidates.length > 1) {
    const [a, b] = candidates.map(plans => models.get(plans).bits);
    if (b < a) chosen = [candidates[1], candidates[0]];
  }
  let written = 0, hurried = false;
  let smallest = null;
  for (const plans of chosen) {
    const bytes = yield* write(plans);
    if (!bytes) return smallest;
    if (!smallest || bytes.length < smallest.length || (bytes.length === smallest.length && plans === candidates[0])) smallest = bytes;
    if (hurried) return smallest;
  }
  return smallest;

  function* write(plans) {
    const {header: modelHeader, leaves, histograms} = models.get(plans);
    const transforms = channels >= 3 ? [{type: 'rct', beginC: 0, rctType: 6}] : [];
    const header = new BitWriter(256);
    writeImageHeader(header, width, height, shape.colour, shape.alpha, {colorSpace});
    writeModularFrameHeader(header, {alpha: shape.alpha});
    const global = new BitWriter(4096);
    global.write(1, 1);
    global.write(1, 1);
    global.append(modelHeader);
    writeModularHeader(global, {useGlobalTree: true, transforms});
    const coded = {...setup, plans: plans.map(plan => ({leaf: plan.leaves[0], codes: plan.leaves.map(l => histograms[leaves.indexOf(l) + 1].code), contextOf: plan.contextOf}))};
    const group = searchGroup(coded), sections = [];
    if (layout.single) {
      group(rgba, width, 0, 0, width, height, global);
      hurried = yield 0.5 + ++written / (2 * chosen.length * groups);
      sections.push(global.finish());
    } else {
      sections.push(global.finish());
      for (let i = 0; i < layout.dcGroupsX * layout.dcGroupsY + 1; i++) sections.push(new Uint8Array(0));
      const at = written, base = sections.length, place = (g, section) => { sections[base + g] = section; };
      hurried = yield* groupPass({at: g => 0.5 + (at + g + 1) / (2 * chosen.length * groups), stop: g => g + 1 < groups},
        groups, g => place(g, group(rgba, width, ...rect(g))));
      if (hurried === null) return null;
      written += groups;
    }
    return assembleCodestream(header, sections);
  }
}
