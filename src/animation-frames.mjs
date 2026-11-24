// SPDX-License-Identifier: MIT
import {LIMITS} from './limits.mjs';
import {BitWriter, part} from './bits.mjs';
import {fault, guard, admitOptions, admitPixels, admitSize} from './admit.mjs';
import {admitSampleFormat} from './admit-samples.mjs';
import {exactSignal} from './color-signal.mjs';
import {admitEffort} from './effort-level.mjs';
import {job} from './admit.mjs';
import {effortJob, exactAnswer} from './effort-job.mjs';
import {READ_GIFS} from './v7/gif-source.mjs';
import {photoAnsSteps} from './photo-v6-blocks.mjs';
import {SCREEN_LADDER} from './screen-ladder.mjs';
import {inspectPixels, shapeFloors} from './lossless.mjs';
import {halfWords} from './half-samples.mjs';
import {photoXYBSteps, preferXYB} from './photo-xyb.mjs';
import {photoCoefficientSteps} from './photo-dct.mjs';
import {coefficientAnsSteps} from './coefficient-ans.mjs';
import {admitPhotoFilter} from './photo-job.mjs';
import {V6} from './photo-v6.mjs';
import {SMALL_V6, smallPicture} from './photo-v6-settings.mjs';
import {screenLike} from './screen.mjs';
import {readStill, metadataKey, writeAnimatedImageHeader, writeAnimatedFrame, writeStillFrame, BLEND_MODES} from './framing.mjs';
import {checkSignal} from './async-job.mjs';
import {shown as markShown, watchShown, EXACT} from './photo-shown.mjs';
import {VIDEO_RATES} from './animation-timeline.mjs';
import {frameSpans, blockStats, alphaAny, unchangedShare, maskCrop, blendPaste, forgetFrame, xybPredictAndDelta, xybComposeAdd, xybAddRect} from './animation-diff.mjs';
import {captureComposeOver} from './capture-kernels.mjs';
import {perceptualMaskField} from './aq.mjs';
import {planAnimationPatches, predictedCanvas, frameViewGroups, encodeFrameView, sheetPixels, CANVAS, BACKGROUND, tallPixels, tallWindow, TALL_SLOT, MASK_SHARE, planAdditiveFrame, additiveDithered} from './animation-moves.mjs';

export const ANIMATION_LIMITS = Object.freeze({pixels: LIMITS.pixels, edge: LIMITS.edge, frames: Number.MAX_SAFE_INTEGER});
const REFERENCE_ONLY = 2;
export const ANIMATION_OBSERVER = Symbol('animation frame observer');
export const ANIMATION_FORM = Symbol('animation form');
export const ANIMATION_DIFFS = Symbol('animation diffs');
export const ANIMATION_PLAIN = Symbol('animation plain');
export const ANIMATION_FLOOR = Symbol('animation floor');

export function admitAnimation(animation, options) {
  if (animation === null || typeof animation !== 'object') throw fault('JXL_INPUT', 'animation: {width,height,loops,frames}');
  if (options === null || typeof options !== 'object') throw fault('JXL_INPUT', 'options: object');
  const {width, height, loops = 0, frames} = animation;
  admitSize(width, height);
  if (!Number.isInteger(loops) || loops < 0 || loops > 0xFFFFFFFF) throw fault('JXL_INPUT', 'loops: integer 0-4294967295, 0 infinite');
  if (!Array.isArray(frames) || !frames.length) throw fault('JXL_INPUT', 'frames: nonempty array');
  if (frames.length > ANIMATION_LIMITS.frames) throw fault('JXL_DIMENSIONS', 'frames: max ' + ANIMATION_LIMITS.frames);
  const kind = frames[0]?.data?.constructor;
  if (!READ_GIFS.has(animation)) for (const frame of frames) {
    if (frame === null || typeof frame !== 'object') throw fault('JXL_INPUT', 'frame: {data,duration}');
    if ((frame.width !== undefined && frame.width !== width) || (frame.height !== undefined && frame.height !== height))
      throw fault('JXL_INPUT', `frame dimensions: match ${width}x${height}`);
    admitPixels(frame.data, width, height);
    if (frame.data.constructor !== kind) throw fault('JXL_INPUT', 'frames: matching sample type');
    if (typeof frame.duration !== 'number' || !Number.isFinite(frame.duration) || frame.duration < 0 || frame.duration > 0xFFFFFFFF)
      throw fault('JXL_INPUT', 'duration: milliseconds >=0');
  }
  if (options.lossless !== undefined && typeof options.lossless !== 'boolean') throw fault('JXL_INPUT', 'lossless: boolean');
  const {quality, colorSpace} = admitOptions(options.lossless ? {...options, quality: 100} : options);
  const effort = admitEffort(options), filter = admitPhotoFilter(options);
  const samples = admitSampleFormat(frames[0].data, options);
  if (options.photo !== undefined && typeof options.photo !== 'boolean') throw fault('JXL_INPUT', 'photo: boolean');
  checkSignal(options.signal);
  const {progress, signal, lossless, photo, probe, [ANIMATION_OBSERVER]: observe, [ANIMATION_FORM]: form, [ANIMATION_DIFFS]: diffs, [ANIMATION_FLOOR]: keep, [ANIMATION_PLAIN]: plain, ...still} = options;
  if (observe !== undefined && typeof observe !== 'function') throw fault('JXL_INTERNAL', 'animation:observer-factory');
  if (!(typeof __RAPIER_JXL_FORMAT__ !== 'undefined' && __RAPIER_JXL_FORMAT__ === true)) {
    const {xybSteps, xybRebuild, xybTargetPlanes, additivePlans, ...cleanStill} = still;
    return {width, height, loops, frames, quality, colorSpace, effort, filter, samples, photo, signal, probe: probe === true, observe, form, diffs, keep, plain, xybSteps, xybRebuild, xybTargetPlanes, additivePlans, still: {...cleanStill, quality, effort, xybProbe: probe === true}};
  }
  return {width, height, loops, frames, quality, colorSpace, effort, filter, samples, photo, signal, probe: probe === true, observe, form, diffs, keep, plain, still: {...still, quality, effort}};
}

export const exactFiles = /* @__PURE__ */ new WeakSet();
export const additiveBytes = (width, height) => 64 * 2 ** 20 + 24 * Math.ceil(width / 8) * 8 * Math.ceil(height / 8) * 8;
export const additiveFiles = /* @__PURE__ */ new WeakSet();
export const codedModes = /* @__PURE__ */ new WeakMap();
export const quickFiles = /* @__PURE__ */ new WeakSet();
export const unprovedFrames = /* @__PURE__ */ new WeakMap();

export function* animationSteps(a, shared = null, allowRegions = !(typeof __RAPIER_JXL_FORMAT__ !== 'undefined' && __RAPIER_JXL_FORMAT__ === true)) {
  if (!(typeof __RAPIER_JXL_FORMAT__ !== 'undefined' && __RAPIER_JXL_FORMAT__ === true) && a.xybSteps) xybHook = a.xybSteps;
  const observer = a.observe?.();
  try {
  const {width, height, frames, samples, quality} = a;
  const frameRead = samples.iccData ? {iccBits: samples.iccData.bitLength} : undefined;
  let first = frames.findIndex(frame => frame.duration > 0);
  if (first < 0) first = frames.length - 1;
  const modeChoice = a.form?.mode && quality < 100 ? a.form.mode : yield* frameMode(a, frames[first].data, frames);
  const chosen = typeof modeChoice === 'string' ? modeChoice : modeChoice.mode;
  const mode = a.form && quality < 100 && chosen === 'modular' ? 'xyb' : chosen;
  const checkFewExact = !a.form && typeof modeChoice === 'object' && modeChoice.closeExact && !a.probe && !observer && !shared && quality < 100 && samples.native8 && a.photo !== false;
  if (!a.form && mode === 'modular' && quality < 100 && samples.native8 && a.photo !== false) {
    const bytes = yield* animationSteps({...a, quality: 100, still: {...a.still, quality: 100}}, shared, allowRegions);
    if (bytes.length) exactFiles.add(bytes);
    return bytes;
  }
  let shown = [];
  let previous = null, source = null;
  const floor = {colour: a.form?.colour ?? 1, alpha: a.form?.alpha ?? false};
  const tolerance = mode === 'modular' ? null : toleranceOf(quality);
  try {
  for (let i = 0; i < frames.length; i++) {
    if (i && i % 16 === 0) yield 0.01 * i / frames.length;
    const {data, duration} = frames[i];
    if (!duration && (i < frames.length - 1 || shown.length) && !(i === frames.length - 1 && a.loops > 0)) continue;
    let rects = !previous ? [[0, 0, width, height]] : tolerance ? lossyChanges(source, data, width, height, tolerance) : changes(previous, data, width, height);
    if (!rects && !duration && i === frames.length - 1 && a.loops > 0) rects = [[0, 0, Math.min(8, width), Math.min(8, height)]];
    if (!rects) { shown.at(-1).duration += duration; shown.at(-1).upTo = i; continue; }
    const input = frames[i];
    shown.push({get data() { return input.data; }, duration, rects, upTo: i});
    previous = data;
    if (samples.sampleFormat === 'float32' && !floor.float32 && !halfWords(data)) floor.float32 = true;
    if (mode !== 'xyb' ? !(floor.colour === 3 && floor.alpha) : !floor.alpha) {
      if (mode === 'xyb') floor.alpha = alphaAny(data, width, height);
      else {
        const shape = inspectPixels(data, width, height, {palette: false, samples: samples.native8 ? undefined : samples});
        if (shape.colour === 3) floor.colour = 3;
        if (shape.alpha) floor.alpha = true;
      }
    }
    if (tolerance) {
      source ||= new Uint8Array(data.length);
      for (const [x, y, w, h] of rects) for (let row = y; row < y + h; row++) source.set(data.subarray((row * width + x) * 4, (row * width + x + w) * 4), (row * width + x) * 4);
    }
  }
  } finally { forgetFrame(); }
  shown.at(-1).upTo = frames.length - 1;
  const timing = ticks(shown.map(frame => frame.duration), Boolean(a.form));
  if (timing.durations.some(duration => duration >= 0xFFFFFFFF)) {
    const split = [], durations = [];
    for (let k = 0; k < shown.length; k++) {
      let remaining = timing.durations[k];
      do {
        const count = Math.min(remaining, 0xFFFFFFFE);
        split.push(shown[k]);
        durations.push(count); remaining -= count;
      } while (remaining);
    }
    shown = split; timing.durations = durations;
  }

  const maskable = mode === 'modular' && samples.native8 && !floor.alpha && a.form?.alpha !== false;
  const patchPlan = allowRegions && !shared && frames.length > 1 && samples.native8 && a.colorSpace === 'srgb' &&
    !a.still.icc && !a.still.colorEncoding && (a.still.transferFunction ?? 'srgb') === 'srgb' &&
    (mode === 'modular' && quality === 100 || mode === 'xyb' && quality >= 60)
    ? yield* planAnimationPatches(shown, width, height, {tolerance, changes, lossyChanges, masks: maskable}) : null;
  const clipTime = {width, height, loops: a.loops ?? 0, numerator: timing.numerator, denominator: timing.denominator,
    durations: timing.durations.map(d => d * timing.denominator / timing.numerator)};
  let keeper = null;
  const finished = file => { codedModes.set(file, mode); if (keeper?.unproved.length) unprovedFrames.set(file, keeper.unproved); if (!(typeof __RAPIER_JXL_FORMAT__ !== 'undefined' && __RAPIER_JXL_FORMAT__ === true) && a.still.xybProbe && mode === 'xyb' && a.effort >= 6 && a.xybSteps) quickFiles.add(file); observer?.finish(file); return file; };
  if (!(typeof __RAPIER_JXL_FORMAT__ !== 'undefined' && __RAPIER_JXL_FORMAT__ === true) &&
      allowRegions && !shared && a.effort >= 8 && !a.plain && a.xybRebuild && a.xybTargetPlanes && a.additivePlans &&
      shown.length > 1 && width >= 64 && height >= 64 && mode === 'xyb' && quality >= 60 &&
      !floor.alpha && samples.native8 && a.colorSpace === 'srgb' && !a.still.icc && !a.still.colorEncoding &&
      (a.still.transferFunction ?? 'srgb') === 'srgb' && !patchPlan?.tall) {
    const addCoder = coderOf(a, mode, floor), addProgress = done => 0.02 + 0.97 * done;
    observer?.begin({...clipTime, patches: true, alpha: false, additive: true});
    const dithered = shown[0].data instanceof Uint8Array && additiveDithered(shown[0].data);
    const maskOf = planes => perceptualMaskField(planes, Math.ceil(width / 8), Math.ceil(height / 8)).weight;
    const entries = [], wPad = Math.ceil(width / 8) * 8, hPad = Math.ceil(height / 8) * 8;
    let ref3 = null, ref2 = null, prevSrc = shown[0].data, key0 = null, fromSpan = 0;
    for (let k = 0; k < shown.length; k++) {
      const toSpan = (shown[k].upTo + 1) / frames.length, scope = {};
      let shownImage = null, shownFile = null;
      const stopImage = watchShown((bytes, picture) => {
        if (picture && picture !== EXACT) { shownFile = bytes; shownImage = picture; }
      });
      let frameBytes, plan = null, pred = null, dict = null, planRec = null;
      try {
        const crop = cropOf(shown[k].data, width, 0, 0, width, height);
        if (k > 0) {
          let targetPlanes = shown[k] === shown[k - 1] ? null : a.xybTargetPlanes(shown[k].data, width, height, quality);
          plan = planAdditiveFrame({
            previous: prevSrc, background: shown[0].data, current: shown[k].data,
            prevXYB: ref2, bgXYB: ref3, targetPlanes, width, height, frameIndex: k, dithered,
          });
          dict = yield* quiet(encodeFrameView(plan.groups, 0));
          const dictBytes = Math.ceil(dict.bitLength / 8);
          if (plan.hold) {
            const zero = [new Float64Array(wPad * hPad), new Float64Array(wPad * hPad), new Float64Array(wPad * hPad)];
            pred = ref2;
            planRec = {deltaPlanes: zero, maskWeight: maskOf(a.xybTargetPlanes(shown[k].data, width, height, quality)), dictBytes, checkPlain: false, usedAdditive: true};
          } else {
            const maskWeight = maskOf(targetPlanes);
            const built = xybPredictAndDelta({[CANVAS]: ref2, [BACKGROUND]: ref3}, plan.groups, targetPlanes, width, height);
            pred = built.pred; ref2 = null;
            planRec = {deltaPlanes: built.delta, maskWeight, dictBytes, checkPlain: dithered || plan.score > 4.0, usedAdditive: false};
            built.delta = targetPlanes = null;
          }
          a.additivePlans.set(crop, planRec);
        }
        const steps = partSteps(addCoder, crop, width, height);
        let step, reply;
        try {
          while (!(step = (observer ? observer.next(scope, steps, reply) : steps.next(reply))).done)
            reply = yield typeof step.value === 'number' ? addProgress(fromSpan + (toSpan - fromSpan) * step.value) : step.value;
        } finally {
          if (!step?.done) steps.return?.();
        }
        frameBytes = step.value;
      } finally {
        stopImage();
      }
      if (a.probe && k === 0 && shownFile !== frameBytes) return new Uint8Array(0);
      if (shownFile !== frameBytes || !shownImage) throw fault('JXL_INTERNAL', 'animation:additive-image');
      const still = readStill(frameBytes, frameRead);
      if (k === 0) key0 = metadataKey(still);
      else if (metadataKey(still) !== key0) throw fault('JXL_FRAMING', 'frames: mismatched headers');
      if (still.frames.length !== 1 || still.frames[0].modular || still.frames[0].passes !== 1 || (still.frames[0].flags & 32))
        throw fault('JXL_INTERNAL', 'animation:additive-contract');

      const last = k === shown.length - 1;
      const usedAdd = k > 0 && Boolean(planRec?.usedAdditive);
      const groups = usedAdd ? plan.groups : null;
      const chosenDict = usedAdd ? dict : null;
      const saveSlot = last ? 0 : (k === 0 ? BACKGROUND : CANVAS);

      let shownXyb = null;
      if (k === 0) {
        ref3 = shownXyb = a.xybRebuild(shownImage);
        ref2 = ref3;
      } else if (!last || observer && usedAdd) {
        let rebuiltXYB = a.xybRebuild(shownImage);
        shownXyb = !usedAdd ? rebuiltXYB : plan.hold ? xybComposeAdd(pred, rebuiltXYB, width, height) : xybAddRect(pred, width, rebuiltXYB, width, 0, 0, width, height, 0, 0, 2);
        if (!last) ref2 = shownXyb;
        rebuiltXYB = pred = null;
      }
      observer?.settlePart({scope, file: frameBytes, rect: [0, 0, width, height]});
      observer?.finishFrame(k, groups, saveSlot, shownXyb);
      shownXyb = null;
      entries.push({frame: k, file: frameBytes, still, dict: chosenDict, groups});
      prevSrc = shown[k].data;
      fromSpan = toSpan;
    }
    const out = new BitWriter(1 << 16);
    writeAnimatedImageHeader(out, entries[0].still, {width, height, ...timing, loops: a.loops},
      entries.every(entry => entry.still.image.modular16));
    const canvas = {width, height, extraChannels: entries[0].still.image.extraChannels};
    for (let k = 0; k < shown.length; k++) {
      const last = k === shown.length - 1;
      const refSlot = last ? 0 : (k === 0 ? BACKGROUND : CANVAS);
      const {still, dict} = entries[k];
      writeAnimatedFrame(out, still, still.frames[0], {
        canvas, duration: timing.durations[k], last, reference: refSlot, beforeColorTransform: !last,
        ...(dict && {patchDictionary: dict}),
      });
    }
    const raw = out.finish();
    const addFile = entries.some(entry => entry.still.level === 10) ? levelTen(raw) : raw;
    additiveFiles.add(addFile);
    return finished(markShown(addFile, {timeline: {...clipTime, additive: true,
      parts: entries.map(entry => ({frame: entry.frame, rect: [0, 0, width, height], shows: true, file: entry.file})),
      patches: entries.map(entry => entry.groups),
    }}));
  }
  const xybSheet = !(typeof __RAPIER_JXL_FORMAT__ !== 'undefined' && __RAPIER_JXL_FORMAT__ === true) &&
    allowRegions && !shared && !patchPlan?.tall && shown.length >= 3 && mode === 'xyb' && quality >= 50 &&
    !floor.alpha && samples.native8 && a.colorSpace === 'srgb' && !a.still.icc && !a.still.colorEncoding &&
    (a.still.transferFunction ?? 'srgb') === 'srgb' &&
    !patchPlan && !a.keep
    ? buildXybSheetPlan(shown, width, height, tolerance, null, a.diffs) : null;
  const patching = Boolean(patchPlan || xybSheet);
  const parts = xybSheet ? xybSheet.chapters.map(ch => ({frame: ch.start, chapterEnd: ch.end, data: ch.sheet, sheetPixels: ch.sheet,
    previous: null, rect: [0, 0, ch.width, ch.height], slot: BACKGROUND, shows: false})) : shown.flatMap((frame, k) => {
    const plan = patching ? patchPlan.frames[k] : null;
    const own = (plan ? plan.rects : frame.rects).map((rect, r) =>
      ({frame: k, get data() { return frame.data; }, get previous() { return !patching && k ? shown[k - 1].data : null; }, rect,
        ...(plan ? {slot: k || plan.window ? 0 : BACKGROUND, shows: false, sheet: plan.sheet} : {shows: r === frame.rects.length - 1})}));
    return plan?.tall ? [{frame: k, data: null, tall: plan.tall, previous: null, rect: [0, 0, plan.tall.width, plan.tall.height], slot: TALL_SLOT, shows: false}, ...own] : own;
  });
  const partsByFrame = Array.from({length: shown.length}, () => []);
  for (const part of parts) partsByFrame[part.frame].push(part);
  keeper = !(typeof __RAPIER_JXL_FORMAT__ !== 'undefined' && __RAPIER_JXL_FORMAT__ === true) && a.keep && !patchPlan?.tall && !shared &&
    mode !== 'modular' ? frameKeeper(a.keep, shown, frames, width, height, patching, a.loops, floor.alpha) : null;
  let predicted = null, predictedFrame = -1, tall = null, tallOf = null;
  const tallPicture = recipe => { if (tallOf !== recipe) { tall = tallPixels(recipe, shown, width); tallOf = recipe; } return tall; };
  const previousOf = part => {
    if (!patching) return part.previous;
    const plan = patchPlan.frames[part.frame];
    if (part.tall || !part.frame && !plan.window) return null;
    if (predictedFrame !== part.frame) {
      predictedFrame = part.frame;
      predicted = plan.window ? tallWindow(tallPicture(plan.window), plan.window, plan.copies, width, height)
        : predictedCanvas(shown[part.frame - 1].data, plan.copies, width, shown[0].data);
    }
    return predicted;
  };
  const releasePrediction = () => { predicted = null; predictedFrame = -1; };
  const pixels = job => {
    const part = job.part ?? job;
    return part.sheetPixels ? part.sheetPixels : part.tall ? tallPicture(part.tall).slice() : part.sheet ? sheetPixels(part.data, width, part.sheet)
      : pixelsOf({data: part.data, rect: part.rect, masked: job.masked, fill: part.fill,
        previous: job.masked ? previousOf(part) : null}, width);
  };
  for (const part of parts) part.candidates = [false];
  if (maskable) {
    const eligible = parts.filter(part => !part.sheet && previousOf(part) && (part.kept = unchangedShare(previousOf(part), part.data, width, part.rect)) >= MASK_SHARE);
    releasePrediction();
    const trial = eligible.reduce((best, part) => !best || part.kept * part.rect[2] * part.rect[3] > best.kept * best.rect[2] * best.rect[3] ? part : best, null);
    if (trial) {
      const [, , w, h] = trial.rect, code = function* (masked, alpha) {
        const steps = partSteps(coderOf(a, mode, {...floor, alpha}), pixels({part: trial, masked}), w, h);
        let step;
        let reply; try { while (!(step = steps.next(reply)).done) reply = typeof step.value === 'number' ? (yield 0, undefined) : yield step.value; } finally { if (!step?.done) steps.return?.(); }
        return step.value;
      };
      const fill = inspectPixels(shown[0].data, width, height).palette ? 'zero' : 'up';
      for (const part of eligible) part.fill = fill;
      const masked = yield* code(true, true), plain = yield* code(false, false);
      if (masked.length < 0.97 * plain.length) {
        floor.alpha = true;
        for (const part of eligible) part.candidates = a.effort >= 2 ? [false, true] : [true];
        if (!shared) trial.tried = {masked: true, bytes: masked};
      } else if (!shared) trial.tried = {masked: false, bytes: plain};
      releasePrediction();
      yield 0.02;
    }
  }
  const jobs = parts.flatMap(part => part.candidates.map(masked => ({part, masked, rect: part.rect, get data() { return part.data; }, get previous() { return part.previous; }, fill: part.fill})));
  const byFrame = Array.from({length: shown.length}, () => []);
  for (const job of jobs) byFrame[job.part.frame].push(job);
  for (let k = 0, from = 0; k < shown.length; k++) {
    const own = byFrame[k], area = own.reduce((n, {rect}) => n + rect[2] * rect[3], 0);
    const endK = xybSheet && own.length === 1 ? own[0].part.chapterEnd : k, to = (shown[endK].upTo + 1) / frames.length;
    let at = from;
    for (const job of own) { const next = at + (to - from) * job.rect[2] * job.rect[3] / area; job.span = [at, next]; at = next; }
    if (!xybSheet || own.length) from = to;
  }
  const paletteSearch = !shared && quality === 100 && a.effort >= 8 && samples.native8 && a.colorSpace === 'srgb';
  const coder = coderOf(a, mode, floor), progress = done => 0.02 + (paletteSearch ? 0.8 : 0.97) * done;
  const viewGroups = patching ? new Array(shown.length) : null;
  observer?.begin({...clipTime, patches: patching, alpha: floor.alpha});
  let pictured = a.probe ? new Set() : null, firstFile = null;
  const advance = (scope, steps, reply) => {
    const stop = pictured ? watchShown((bytes, picture) => { if (picture !== EXACT) pictured.add(bytes); })
      : keeper ? watchShown(keeper.seen) : null;
    try { return observer ? observer.next(scope, steps, reply) : steps.next(reply); }
    finally { stop?.(); }
  };
  const baseSheetEligible = !(typeof __RAPIER_JXL_FORMAT__ !== 'undefined' && __RAPIER_JXL_FORMAT__ === true) &&
    allowRegions && !shared && !patchPlan?.tall && shown.length > 1 && mode === 'modular' && quality === 100 &&
    samples.native8 && a.colorSpace === 'srgb' && !a.still.icc && !a.still.colorEncoding &&
    (a.still.transferFunction ?? 'srgb') === 'srgb';
  const sheetCanPay = baseSheetEligible && (a.effort >= 5 || floor.alpha || Boolean(inspectPixels(shown[0].data, width, height).palette));
  const fastSheetFirst = sheetCanPay && !observer && shown.length >= 3 && a.effort >= 3 && a.effort <= 4;
  function* encodePartsWith(activeCoder) {
    const memo = !shared && !observer && !keeper ? new Map() : null;
    try {
      for (let k = 0; k < shown.length; k++) {
        keeper?.begin(k);
        for (let round = 0; ; round++) {
          const ownJobs = byFrame[k];
          for (let j = 0; j < ownJobs.length; j++) {
            const job = ownJobs[j];
            if (pictured && job !== jobs[0]) {
              const kept = pictured.has(firstFile); pictured = null;
              if (!kept) return false;
            }
            const [, , w, h] = job.rect, [from, to] = job.span;
            if (!shared && job.part.tried?.masked === job.masked && activeCoder === coder) {
              job.bytes = job.part.tried.bytes; delete job.part.tried;
              yield progress(to);
            } else {
              const crop = pixels(job), hKey = memo ? hashCropBytes(w, h, job.masked, crop) : 0;
              const bucket = memo?.get(hKey), hit = bucket?.find(e => e.w === w && e.h === h && e.masked === job.masked && equalCropBytes(e.crop, crop));
              if (hit) {
                job.bytes = hit.bytes;
                yield progress(to);
              } else {
                const steps = shared ? shared.partSteps(activeCoder, crop, w, h, job) : partSteps(job.part.coder ?? keeper?.coder ?? activeCoder, crop, w, h);
                let step, reply;
                try { while (!(step = advance(job.part, steps, reply)).done) reply = yield typeof step.value === 'number' ? progress(from + (to - from) * step.value) : step.value; }
                finally { if (!step?.done) steps.return?.(); }
                job.bytes = step.value;
                if (memo && memo.size < 256 && crop.byteLength <= 262144) {
                  if (bucket) bucket.push({w, h, masked: job.masked, crop, bytes: job.bytes});
                  else memo.set(hKey, [{w, h, masked: job.masked, crop, bytes: job.bytes}]);
                }
              }
            }
            firstFile ||= job.bytes;
            if (!job.part.still || job.bytes.length < job.part.bytes)
              Object.assign(job.part, {still: job.bytes, bytes: job.bytes.length, masked: job.masked});
            if (j + 1 === ownJobs.length || ownJobs[j + 1].part !== job.part) {
              const part = job.part;
              part.file = part.still; part.still = readStill(part.file, frameRead);
              observer?.settlePart({scope: part, file: part.file, rect: part.rect, masked: Boolean(part.masked), saveSlot: patching ? part.slot : undefined});
              keeper?.paste(part.file, part.rect, Boolean(part.masked));
            }
          }
          const repair = keeper?.repair(k, round, keeper.coder ?? activeCoder);
          if (keeper?.exact) return true;
          if (!repair) break;
          const at = parts.indexOf(partsByFrame[k][0]), {slot, shows} = partsByFrame[k][0], own = repair.rects.map((rect, r) => ({frame: k,
            get data() { return shown[k].data; }, previous: null, rect, shows: patching ? shows : r === repair.rects.length - 1, candidates: [false],
            ...(patching && {slot}), ...(repair.coder && {coder: repair.coder})}));
          parts.splice(at, partsByFrame[k].length, ...own);
          partsByFrame[k] = own;
          const [from, to] = [byFrame[k][0].span[0], byFrame[k].at(-1).span[1]], area = own.reduce((n, {rect}) => n + rect[2] * rect[3], 0);
          let spanAt = from;
          byFrame[k] = own.map(part => { const next = spanAt + (to - from) * part.rect[2] * part.rect[3] / area, job = {part, masked: false, rect: part.rect,
            get data() { return part.data; }, previous: null, span: [spanAt, next]}; spanAt = next; return job; });
        }
        if (patching) viewGroups[k] = xybSheet ? xybSheet.groups[k] : frameViewGroups({width, height, first: k === 0 || Boolean(patchPlan.frames[k].window),
          copies: patchPlan.frames[k].copies, parts: partsByFrame[k]}, parts[0].still.image.extraChannels);
        observer?.finishFrame(k, patching ? viewGroups[k] : null);
        for (const job of byFrame[k]) delete job.bytes;
        releasePrediction();
      }
    } finally { keeper?.destroy(); }
    return true;
  }
  if (!(yield* encodePartsWith(fastSheetFirst ? {...coder, effort: 1, still: {...coder.still, effort: 1}} : coder)))
    return new Uint8Array(0);
  if (keeper?.exact) {
    const bytes = yield* animationSteps({...a, quality: 100, keep: undefined, still: {...a.still, quality: 100}}, shared, allowRegions);
    if (bytes.length) { exactFiles.add(bytes); unprovedFrames.set(bytes, keeper.unproved); }
    return bytes;
  }
  const key = metadataKey(parts[0].still);
  if (parts.some(({still}) => metadataKey(still) !== key)) {
    if (!a.form && mode === 'modular' && quality < 100 && samples.native8 && a.photo !== true) return yield* animationSteps({...a, photo: true}, shared, allowRegions);
    throw fault('JXL_FRAMING', 'frames: mismatched headers');
  }
  const xyb = mode === 'xyb';
  const patchable = ({image, frames: children}) => image.xyb === xyb && children.every((frame, i) =>
    (xyb || frame.modular) && !frame.ycbcr && frame.passes === 1 && !(frame.flags & 32) &&
    (i === children.length - 1 ? frame.type === 0 : frame.type === REFERENCE_ONLY && frame.reference === 1));
  let view = null, viewPatches = null;
  if (patching) {
    const flat = new Uint8Array(width * height * 4).fill(255), viewCoder = {...coder, mode: 'modular', quality: 100, effort: 1,
      floor: xyb ? {...floor, colour: 3} : floor, still: {...coder.still, quality: 100, effort: 1}};
    const viewBytes = yield* quiet(partSteps(viewCoder, flat, width, height));
    view = readStill(viewBytes, frameRead);
    const extraChannels = parts[0].still.image.extraChannels;
    const fits = view.frames.length === 1 && view.frames[0].modular && !view.frames[0].ycbcr &&
      view.frames[0].passes === 1 && !(view.frames[0].flags & 32) && !view.image.xyb &&
      view.image.extraChannels === extraChannels && (xyb || metadataKey(view) === key);
    if (!fits || !parts.every(part => patchable(part.still)))
      throw fault('JXL_INTERNAL', 'animation:motion-contract');
    viewPatches = [];
    for (const groups of viewGroups) viewPatches.push(yield* quiet(encodeFrameView(groups, extraChannels)));
  }
  const write = parts => {
    const out = new BitWriter(1 << 16);
    writeAnimatedImageHeader(out, parts[0].still, {width, height, ...timing, loops: a.loops}, parts.every(({still}) => still.image.modular16));
    const canvas = {width, height, extraChannels: parts[0].still.image.extraChannels};
    if (patching) {
      const grouped = Array.from({length: shown.length}, () => []);
      for (const part of parts) grouped[part.frame].push(part);
      for (let k = 0; k < shown.length; k++) {
        if (new Set(grouped[k].map(part => part.slot)).size < grouped[k].length)
          throw fault('JXL_INTERNAL', 'animation:duplicate-reference-slot');
        for (const {still, slot} of grouped[k]) still.frames.forEach((frame, i) => {
          if (i < still.frames.length - 1) writeAnimatedFrame(out, still, frame, {canvas, reference: CANVAS});
          else writeStillFrame(out, still, frame, {canvas, frameType: REFERENCE_ONLY, reference: slot, beforeColorTransform: true});
        });
        const last = k === shown.length - 1;
        writeAnimatedFrame(out, view, view.frames[0], {canvas, duration: timing.durations[k], last, reference: last ? 0 : CANVAS,
          beforeColorTransform: true, patchDictionary: viewPatches[k], dropYCbCr: xyb});
      }
      const codestream = out.finish();
      return parts.some(({still}) => still.level === 10) ? levelTen(codestream) : codestream;
    }
    shared?.writeReferences(out, canvas, key);
    parts.forEach(({frame: k, rect: [x0, y0], shows, still, masked}, p) => {
      const next = parts[p + 1], last = !next;
      const keep = !last && !(next.rect[2] === width && next.rect[3] === height && !next.masked);
      still.frames.forEach((frame, f) => {
        writeAnimatedFrame(out, still, frame, f === still.frames.length - 1
          ? {canvas, x0, y0, duration: shows ? timing.durations[k] : 0, last, reference: keep ? CANVAS : 0, source: CANVAS, mode: masked ? BLEND_MODES.blend : BLEND_MODES.replace}
          : {canvas, reference: CANVAS});
      });
    });
    const codestream = out.finish();
    return parts.some(({still}) => still.level === 10) ? levelTen(codestream) : codestream;
  };
  const timeline = parts => ({timeline: {...clipTime,
    parts: parts.map(({frame, rect, shows, file, slot, masked}) => ({frame, rect, shows, file, ...(masked && {masked: true}), ...(patching && {saveSlot: slot})})),
    ...(patching && {patches: viewGroups})}});
  const exactWhole = (file, list) => { if (quality < 100 && list.every(part => exactAnswer(part.file))) exactFiles.add(file); return file; };
  let bytes = exactWhole(markShown(write(parts), timeline(parts)), parts);
  let sheetBuilt = null;
  const sheetPartLimit = a.effort === 1 || fastSheetFirst ? 9216 : SHEET_PART;
  const tryModularSheet = (typeof __RAPIER_JXL_FORMAT__ !== 'undefined' && __RAPIER_JXL_FORMAT__ === true) ? null : function* tryModularSheet(maxSheetPixels, effortCap = a.effort) {
    const allowChapters = true;
    const chapters = [], drawsByFrame = Array.from({length: shown.length}, () => []);
    const frame0 = shown[0].data;
    let start = 0, validChapters = true, sheetBytesTotal = 0;
    while (start < shown.length) {
      const hasFrame0 = start === 0 || patching && patchPlan.frames.slice(start).some(f => f.copies.some(cp => cp.reference === BACKGROUND));
      const items = hasFrame0 ? [{x: 0, y: 0, w: width, h: height, masked: false, data: cropOf(frame0, width, 0, 0, width, height), sx: 0, sy: 0}] : [];
      const byHash = new Map();
      let bestLayout = hasFrame0 ? {sw: width, sh: height, coords: [{sx: 0, sy: 0}]} : null;
      let end = start === 0 ? 0 : start - 1;
      for (let k = Math.max(1, start); k < shown.length; k++) {
        const rawDraws = [];
        for (const p of partsByFrame[k]) {
          if (p.sheet) {
            for (const cell of p.sheet.cells)
              rawDraws.push({x: cell.x, y: cell.y, w: cell.w, h: cell.h, masked: false, data: cropOf(shown[k].data, width, cell.x, cell.y, cell.w, cell.h)});
          } else {
            const [rx, ry, rw, rh] = p.rect;
            rawDraws.push({x: rx, y: ry, w: rw, h: rh, masked: Boolean(p.masked), data: pixels({part: p, masked: Boolean(p.masked)})});
          }
        }
        releasePrediction();
        const frameNew = [], frameDraws = [];
        for (const d of rawDraws) {
          if (hasFrame0 && !d.masked && matchesCanvasRect(frame0, width, d.x, d.y, d.w, d.h, d.data)) {
            frameDraws.push({x: d.x, y: d.y, w: d.w, h: d.h, masked: false, directSx: d.x, directSy: d.y});
            continue;
          }
          const h = hashCropBytes(d.w, d.h, d.masked, d.data);
          const existing = byHash.get(h)?.find(m => m.w === d.w && m.h === d.h && m.masked === d.masked && equalCropBytes(m.data, d.data))
            ?? frameNew.find(m => m.hash === h && m.w === d.w && m.h === d.h && m.masked === d.masked && equalCropBytes(m.data, d.data));
          if (existing) {
            frameDraws.push({x: d.x, y: d.y, w: d.w, h: d.h, masked: d.masked, ref: existing});
            continue;
          }
          const ni = {x: d.x, y: d.y, w: d.w, h: d.h, masked: d.masked, data: d.data, hash: h};
          frameNew.push(ni);
          frameDraws.push({x: d.x, y: d.y, w: d.w, h: d.h, masked: d.masked, ref: ni});
        }
        if (!frameNew.length) {
          drawsByFrame[k] = frameDraws;
          end = k;
          continue;
        }
        const candItems = items.concat(frameNew);
        const candLayout = packSheetItems(candItems, hasFrame0 ? width : 0, hasFrame0 ? height : 0, width, maxSheetPixels);
        if (!candLayout) {
          if (end >= start && allowChapters) break;
          validChapters = false;
          break;
        }
        bestLayout = candLayout;
        for (const ni of frameNew) {
          items.push(ni);
          const bucket = byHash.get(ni.hash);
          if (bucket) bucket.push(ni); else byHash.set(ni.hash, [ni]);
        }
        drawsByFrame[k] = frameDraws;
        end = k;
      }
      if (!validChapters || end < start || (chapters.length === 0 && end === shown.length - 1 && items.length <= 1 && !drawsByFrame.some(d => d.length))) {
        validChapters = false;
        break;
      }
      if (!bestLayout) { validChapters = false; break; }
      const {sw: sheetW, sh: sheetH, coords} = bestLayout;
      const sheet = new Uint8Array(sheetW * sheetH * 4), filled = new Uint8Array(sheetW * sheetH);
      for (let i = 0; i < items.length; i++) {
        const c = items[i], {sx, sy} = coords[i];
        c.sx = sx; c.sy = sy;
        for (let r = 0; r < c.h; r++) {
          sheet.set(c.data.subarray(r * c.w * 4, (r + 1) * c.w * 4), ((sy + r) * sheetW + sx) * 4);
          filled.fill(1, (sy + r) * sheetW + sx, (sy + r) * sheetW + sx + c.w);
        }
        c.data = null;
      }
      for (let r = 0; r < sheetH; r++) {
        const base = r * sheetW;
        let firstCol = -1;
        for (let c = 0; c < sheetW; c++) if (filled[base + c]) { firstCol = c; break; }
        if (firstCol < 0) { if (r > 0) sheet.copyWithin(base * 4, (base - sheetW) * 4, base * 4); continue; }
        for (let c = 0; c < firstCol; c++) sheet.copyWithin((base + c) * 4, (base + firstCol) * 4, (base + firstCol + 1) * 4);
        for (let c = firstCol + 1; c < sheetW; c++) if (!filled[base + c]) sheet.copyWithin((base + c) * 4, (base + c - 1) * 4, (base + c) * 4);
      }
      const candEfforts = [Math.min(effortCap, 3)];
      if (effortCap >= 2 && !candEfforts.includes(1)) candEfforts.unshift(1);
      if (effortCap >= 5 && sheetW * sheetH <= 131072 && !inspectPixels(sheet, sheetW, sheetH, {palette: true}).palette && !candEfforts.includes(5)) candEfforts.push(5);
      if (effortCap >= 6 && !candEfforts.includes(effortCap)) candEfforts.push(effortCap);
      let sheetBytes = null;
      for (const eff of candEfforts) {
        const sb = yield* quiet(partSteps(eff === coder.effort ? coder : {...coder, effort: eff, still: {...coder.still, effort: eff}}, sheet, sheetW, sheetH));
        if (!sheetBytes || sb.length < sheetBytes.length) sheetBytes = sb;
      }
      sheetBytesTotal += sheetBytes.length;
      if (!fastSheetFirst && sheetBytesTotal + shown.length * 16 >= bytes.length) { validChapters = false; break; }
      const sheetStill = readStill(sheetBytes, frameRead);
      if (metadataKey(sheetStill) !== key || !patchable(sheetStill)) { validChapters = false; break; }
      chapters.push({start, end, sheetW, sheetH, sheetBytes, sheetStill});
      start = end + 1;
    }
    if (validChapters && chapters.length) {
      const extra = chapters[0].sheetStill.image.extraChannels;
      let sheetView = view;
      if (!sheetView) {
        const flat = new Uint8Array(width * height * 4).fill(255), viewCoder = {...coder, mode: 'modular', quality: 100, effort: 1, still: {...coder.still, quality: 100, effort: 1}};
        sheetView = readStill(yield* quiet(partSteps(viewCoder, flat, width, height)), frameRead);
      }
      const viewOk = sheetView.frames.length === 1 && sheetView.frames[0].modular && !sheetView.frames[0].ycbcr &&
        sheetView.frames[0].passes === 1 && !(sheetView.frames[0].flags & 32) && !sheetView.image.xyb &&
        sheetView.image.extraChannels === extra && metadataKey(sheetView) === key &&
        chapters.every(ch => ch.sheetStill.image.extraChannels === extra);
      if (viewOk) {
        const blending = m => Array.from({length: 1 + extra}, () => ({mode: m, alpha: 0, clamp: false}));
        const sGroups = [], sDicts = [];
        for (let k = 0; k < shown.length; k++) {
          const g = [];
          if (k === 0) g.push({reference: BACKGROUND, sx: 0, sy: 0, w: width, h: height, positions: [{x: 0, y: 0, blending: blending(1)}]});
          else {
            g.push({reference: CANVAS, sx: 0, sy: 0, w: width, h: height, positions: [{x: 0, y: 0, blending: blending(1)}]});
            if (patching) for (const cp of patchPlan.frames[k].copies)
              g.push({reference: cp.reference, sx: cp.sx, sy: cp.sy, w: cp.w, h: cp.h, positions: [{x: cp.x, y: cp.y, blending: blending(1)}]});
            for (const dr of drawsByFrame[k]) {
              const sx = dr.ref ? dr.ref.sx : dr.directSx, sy = dr.ref ? dr.ref.sy : dr.directSy;
              g.push({reference: BACKGROUND, sx, sy, w: dr.w, h: dr.h, positions: [{x: dr.x, y: dr.y, blending: blending(dr.masked ? 4 : 1)}]});
            }
          }
          sGroups.push(g);
          sDicts.push(yield* quiet(encodeFrameView(g, extra)));
        }
        const out = new BitWriter(1 << 16);
        writeAnimatedImageHeader(out, chapters[0].sheetStill, {width, height, ...timing, loops: a.loops},
          chapters.every(ch => ch.sheetStill.image.modular16));
        const canvas = {width, height, extraChannels: extra};
        for (const ch of chapters) {
          ch.sheetStill.frames.forEach((frame, i) => {
            if (i < ch.sheetStill.frames.length - 1) writeAnimatedFrame(out, ch.sheetStill, frame, {canvas, reference: CANVAS});
            else writeStillFrame(out, ch.sheetStill, frame, {canvas, frameType: REFERENCE_ONLY, reference: BACKGROUND, beforeColorTransform: true});
          });
          for (let k = ch.start; k <= ch.end; k++) {
            const last = k === shown.length - 1;
            writeAnimatedFrame(out, sheetView, sheetView.frames[0], {canvas, duration: timing.durations[k], last, reference: last ? 0 : CANVAS,
              beforeColorTransform: true, patchDictionary: sDicts[k], dropYCbCr: false});
          }
        }
        const raw = out.finish(), sheetCand = chapters.some(ch => ch.sheetStill.level === 10) ? levelTen(raw) : raw;
        const sParts = chapters.map(ch => ({frame: ch.start, rect: [0, 0, ch.sheetW, ch.sheetH], shows: false, file: ch.sheetBytes, saveSlot: BACKGROUND}));
        return {cand: sheetCand, parts: sParts, groups: sGroups, maxArea: Math.max(...chapters.map(ch => ch.sheetW * ch.sheetH))};
      }
    }
    return null;
  }
  if (sheetCanPay && sheetPays(bytes.length, partsByFrame, sheetPartLimit)) {
    sheetBuilt = yield* tryModularSheet(a.effort === 1 ? 524288 : 1048576);
    if (a.effort >= 2 && sheetBuilt && sheetBuilt.parts.length === 1 && sheetBuilt.maxArea > 524288) {
      const splitBuilt = yield* tryModularSheet(524288, Math.min(a.effort, 3));
      if (splitBuilt && splitBuilt.cand.length < sheetBuilt.cand.length) sheetBuilt = splitBuilt;
    }
  }
  if (fastSheetFirst) {
    if (sheetBuilt && sheetBuilt.cand.length <= 0.5 * bytes.length) {
      return finished(exactWhole(markShown(sheetBuilt.cand, {timeline: {...clipTime, parts: sheetBuilt.parts, patches: sheetBuilt.groups}}), sheetBuilt.parts));
    }
    const fastBytes = bytes;
    for (const p of parts) { delete p.still; delete p.bytes; delete p.file; }
    if (!(yield* encodePartsWith(coder))) return new Uint8Array(0);
    bytes = exactWhole(markShown(write(parts), timeline(parts)), parts);
    if (fastBytes.length < bytes.length) bytes = fastBytes;
  }
  if (sheetBuilt && sheetBuilt.cand.length < bytes.length) {
    bytes = exactWhole(markShown(sheetBuilt.cand, {timeline: {...clipTime, parts: sheetBuilt.parts, patches: sheetBuilt.groups}}), sheetBuilt.parts);
  }
  if (checkFewExact || (!a.form && mode === 'modular' && quality < 100 && exactSignal(samples))) {
    const exactEffort = exactSignal(samples) ? a.effort : Math.min(a.effort, 3);
    const exactCand = yield* animationSteps({...a, quality: 100, effort: exactEffort, still: {...a.still, quality: 100, effort: exactEffort}}, shared, allowRegions);
    if (exactCand.length && exactCand.length <= bytes.length) {
      exactFiles.add(exactCand);
      return finished(exactCand);
    }
  }
  if (!paletteSearch) return finished(bytes);
  let alternative = null;
  for (let i = 0; i < parts.length; i++) {
    const current = parts[i], [, , w, h] = current.rect, crop = pixels(current);
    if (screenLike(crop, w, h)) continue;
    shapeFloors.set(crop, floor);
    const shape = inspectPixels(crop, w, h);
    if (!shape.palette) continue;
    const steps = SCREEN_LADDER.screen.paletteSteps(crop, w, h, shape, a.colorSpace, {ceiling: current.bytes});
    let step, reply;
    try { while (!(step = steps.next(reply)).done) reply = yield 0.82 + 0.17 * (i + step.value) / parts.length; } finally { if (!step?.done) steps.return?.(); }
    if (!step.value) continue;
    const still = readStill(step.value, frameRead);
    if (metadataKey(still) !== key || patching && !patchable(still)) continue;
    alternative ||= parts.slice();
    alternative[i] = Object.assign(Object.defineProperties({}, Object.getOwnPropertyDescriptors(current)), {still, file: step.value});
  }
  if (!alternative) return finished(bytes);
  const candidate = write(alternative);
  const winner = candidate.length < bytes.length ? exactWhole(markShown(candidate, timeline(alternative)), alternative) : bytes;
  return finished(winner);
  } finally { observer?.destroy(); forgetFrame(); }
}

function* quiet(steps) {
  let step, reply;
  try { while (!(step = steps.next(reply)).done) reply = typeof step.value === 'number' ? undefined : yield step.value; }
  finally { if (!step?.done) steps.return?.(); }
  return step.value;
}

let measuredSearch, xybHook;
export function useMeasuredSearch(search) { measuredSearch = search; }
const FRAME_LADDER = Object.freeze({...SCREEN_LADDER, frame: true});
const frameEncodeSteps = (data, width, height, options, probe = false) => floored(job(effortJob(data, width, height, options, false, undefined, measuredSearch, photoAnsSteps, FRAME_LADDER), true), probe);
const FRAME_CAPTURE = 16384;
function fewColors({data, width, height}) {
  const words = new Uint32Array(data.buffer, data.byteOffset, width * height), seen = [];
  for (let i = 0, last; i < words.length; i++) {
    const word = words[i];
    if (word === last) continue;
    last = word;
    if (!seen.includes(word)) { seen.push(word); if (seen.length > 4) return false; }
  }
  return seen.length > 1;
}
function* floored(steps, probe) {
  let step, reply;
  try {
    while (!(step = steps.next(reply)).done) {
      const ask = step.value?.capture;
      if (!ask) { reply = yield step.value; continue; }
      reply = probe || ask.width * ask.height < FRAME_CAPTURE || fewColors(ask) ? undefined
        : yield {capture: {...ask, floor: shapeFloors.get(ask.data), frame: true}};
    }
  } finally { if (!step?.done) steps.return?.(); }
  return step.value;
}

function* frameMode(a, first, frames) {
  const {width, height, quality, samples, photo, colorSpace} = a;
  if (quality >= 100 || !samples.native8 || photo === false) return 'modular';
  let rich = photo === true ? first : undefined;
  if (photo !== true) for (let i = 0; i < frames.length; i++) {
    if (i && i % 16 === 0) yield 0;
    const {data, duration} = frames[i];
    if ((duration > 0 || i === frames.length - 1) && !inspectPixels(data, width, height).palette) { rich = data; break; }
  }
  const dct = colorSpace === 'srgb' && preferXYB(rich ?? first, width, height) ? 'xyb' : 'ycbcr';
  if (rich) return dct;
  const alpha = alphaAny(first, width, height);
  const shrink = steps => (function* () { let step, reply; try { while (!(step = steps.next(reply)).done) reply = yield typeof step.value === 'number' ? 0.01 + 0.01 * step.value : step.value; } finally { if (!step?.done) steps.return?.(); } return step.value; })();
  const exact = yield* shrink(part(frameEncodeSteps(first, width, height, {...a.still, quality: 100, effort: 1}, true), 0, 2));
  const lossy = yield* shrink(part(frameSteps(a, dct, first, width, height, {alpha}), 1, 2));
  return exact.length <= lossy.length ? 'modular' : {mode: dct, closeExact: frames.length > 1 && exact.length <= 1.55 * lossy.length};
}

function coderOf({quality, filter, colorSpace, effort, still, width, height}, mode, floor) {
  if (!(typeof __RAPIER_JXL_FORMAT__ !== 'undefined' && __RAPIER_JXL_FORMAT__ === true)) {
    const {xybProbe, ...restStill} = still;
    return {mode, quality, filter, colorSpace, effort, still: restStill, floor, small: smallPicture(width, height), probe: xybProbe, xybSteps: xybHook};
  }
  return {mode, quality, filter, colorSpace, effort, still, floor, small: smallPicture(width, height)};
}

const SHEET_PART = 8192;
const sheetPays = (typeof __RAPIER_JXL_FORMAT__ !== 'undefined' && __RAPIER_JXL_FORMAT__ === true) ? null : function sheetPays(bytes, partsByFrame, limit = SHEET_PART) {
  let files = 1;
  for (let k = 1; k < partsByFrame.length; k++) for (const p of partsByFrame[k]) files += p.sheet ? p.sheet.cells.length : 1;
  return files > 1 && bytes <= limit * files;
}

function hashCropBytes(w, h, masked, data) {
  let hash = (w * 73856093 ^ h * 19349663 ^ (masked ? 83492791 : 0)) >>> 0;
  const step = Math.max(1, data.length >> 10);
  for (let i = 0; i < data.length; i += step) hash = Math.imul(hash ^ data[i], 16777619) >>> 0;
  return hash;
}

function equalCropBytes(a, b) {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false;
  return true;
}

function matchesCanvasRect(canvas, canvasW, x, y, w, h, crop) {
  const rowBytes = w * 4;
  for (let r = 0; r < h; r++) {
    const cOff = ((y + r) * canvasW + x) * 4, rOff = r * rowBytes;
    for (let i = 0; i < rowBytes; i++) if (canvas[cOff + i] !== crop[rOff + i]) return false;
  }
  return true;
}

function copyRectRgba(into, from, width, x, y, w, h) {
  for (let r = 0; r < h; r++) {
    const off = ((y + r) * width + x) * 4;
    into.set(from.subarray(off, off + w * 4), off);
  }
}

const lossySubRectsAgainstFrame0 = (typeof __RAPIER_JXL_FORMAT__ !== 'undefined' && __RAPIER_JXL_FORMAT__ === true) ? null : function lossySubRectsAgainstFrame0(stats, width, height, rx, ry, rw, rh, {mean, most, maxBias}) {
  const x0 = rx & ~7, y0 = ry & ~7;
  const x1 = Math.min(width, Math.ceil((rx + rw) / 8) * 8), y1 = Math.min(height, Math.ceil((ry + rh) / 8) * 8);
  if (x1 <= x0 || y1 <= y0) return [[rx, ry, rw, rh]];
  const subW = x1 - x0, subH = y1 - y0, tilesX = Math.ceil(subW / TILE), tilesY = Math.ceil(subH / TILE);
  const bounds = new Int32Array(tilesX * tilesY * 4).fill(-1), across = Math.ceil(width / 8);
  let any = false;
  for (let by = 0; by < subH; by += 8) for (let bx = 0; bx < subW; bx += 8) {
    const bw = Math.min(subW, bx + 8) - bx, bh = Math.min(subH, by + 8) - by, at = (((y0 + by) >> 3) * across + ((x0 + bx) >> 3)) * 4;
    const sum = stats[at] | stats[at + 1] << 8, peak = stats[at + 2], bias = stats[at + 3];
    if (sum <= mean * bw * bh && peak <= most && (maxBias === undefined || bias <= maxBias)) continue;
    const t = ((by / TILE | 0) * tilesX + (bx / TILE | 0)) * 4;
    if (bounds[t] < 0) { bounds[t] = bx; bounds[t + 1] = by; bounds[t + 2] = bx + bw - 1; bounds[t + 3] = by + bh - 1; }
    else {
      bounds[t] = Math.min(bounds[t], bx); bounds[t + 1] = Math.min(bounds[t + 1], by);
      bounds[t + 2] = Math.max(bounds[t + 2], bx + bw - 1); bounds[t + 3] = Math.max(bounds[t + 3], by + bh - 1);
    }
    any = true;
  }
  if (!any) return null;
  return regions(bounds, tilesX, tilesY, subW, subH, 8).map(([sx, sy, sw, sh]) => {
    const cx0 = Math.max(rx, x0 + sx), cy0 = Math.max(ry, y0 + sy);
    const cx1 = Math.min(rx + rw, x0 + sx + sw), cy1 = Math.min(ry + rh, y0 + sy + sh);
    return [cx0, cy0, cx1 - cx0, cy1 - cy0];
  }).filter(([, , sw, sh]) => sw > 0 && sh > 0);
}

const packXybSheetItems = (typeof __RAPIER_JXL_FORMAT__ !== 'undefined' && __RAPIER_JXL_FORMAT__ === true) ? null : function packXybSheetItems(items, initW, initH, maxPixels) {
  const align = 8, gap = 8, up = v => Math.ceil(v / align) * align;
  const startIdx = initW > 0 ? 1 : 0;
  const padW0 = initW > 0 ? up(initW) + gap : 0, padH0 = initH > 0 ? up(initH) + gap : 0;
  const areaEst = (initW > 0 ? padW0 * padH0 : 0) + items.slice(startIdx).reduce((s, c) => s + (up(c.w) + gap) * (up(c.h) + gap), 0);
  if (areaEst > maxPixels * 1.8) return null;
  const widest = Math.max(initW > 0 ? up(initW) : 16, ...items.slice(startIdx).map(c => up(c.w)));
  let best = null;
  const sumW = (initW > 0 ? padW0 : 0) + items.slice(startIdx).reduce((s, c) => s + up(c.w) + gap, 0);
  for (const targetW of [widest, Math.max(widest, up(Math.ceil(Math.sqrt(areaEst) * 1.25))), Math.min(2048, Math.max(widest, sumW))]) {
    let sx = initW > 0 ? padW0 : 0, sy = 0, rowH = initH > 0 ? padH0 : 0, sw = initW;
    const coords = initW > 0 ? [{sx: 0, sy: 0}] : [];
    for (let i = startIdx; i < items.length; i++) {
      const c = items[i], cw = up(c.w), ch = up(c.h);
      if (sx > 0 && sx + c.w > targetW) { sy += rowH; sx = 0; rowH = 0; }
      coords.push({sx, sy});
      sw = Math.max(sw, sx + c.w);
      rowH = Math.max(rowH, ch + gap);
      sx += cw + gap;
    }
    const usedH = coords.reduce((m, p, i) => Math.max(m, p.sy + items[i].h), 16);
    const sh = Math.max(16, usedH);
    sw = Math.max(16, sw);
    if (sw <= LIMITS.edge && sh <= LIMITS.edge && sw * sh <= maxPixels && (!best || sw * sh < best.sw * best.sh))
      best = {sw, sh, coords};
  }
  return best;
}

const renderXybSheet = (typeof __RAPIER_JXL_FORMAT__ !== 'undefined' && __RAPIER_JXL_FORMAT__ === true) ? null : function renderXybSheet(items, coords, sheetW, sheetH) {
  const sheet = new Uint8Array(sheetW * sheetH * 4), filled = new Uint8Array(sheetW * sheetH);
  for (let i = 0; i < items.length; i++) {
    const c = items[i], {sx, sy} = coords[i];
    c.sx = sx; c.sy = sy;
    for (let r = 0; r < c.h; r++) {
      sheet.set(c.data.subarray(r * c.w * 4, (r + 1) * c.w * 4), ((sy + r) * sheetW + sx) * 4);
      filled.fill(1, (sy + r) * sheetW + sx, (sy + r) * sheetW + sx + c.w);
    }
    const padL = Math.min(4, sx), padR = Math.min(4, sheetW - (sx + c.w));
    for (let r = 0; r < c.h; r++) {
      const rowBase = (sy + r) * sheetW;
      for (let d = 1; d <= padL; d++) if (!filled[rowBase + sx - d]) {
        sheet.copyWithin((rowBase + sx - d) * 4, (rowBase + sx) * 4, (rowBase + sx + 1) * 4);
        filled[rowBase + sx - d] = 1;
      }
      for (let d = 0; d < padR; d++) if (!filled[rowBase + sx + c.w + d]) {
        sheet.copyWithin((rowBase + sx + c.w + d) * 4, (rowBase + sx + c.w - 1) * 4, (rowBase + sx + c.w) * 4);
        filled[rowBase + sx + c.w + d] = 1;
      }
    }
    const xStart = sx - padL, spanW = c.w + padL + padR;
    const padT = Math.min(4, sy), padB = Math.min(4, sheetH - (sy + c.h));
    for (let d = 1; d <= padT; d++) {
      const dst = (sy - d) * sheetW + xStart, src = sy * sheetW + xStart;
      let free = true;
      for (let u = 0; u < spanW; u++) if (filled[dst + u]) { free = false; break; }
      if (free) { sheet.copyWithin(dst * 4, src * 4, (src + spanW) * 4); filled.fill(1, dst, dst + spanW); }
    }
    for (let d = 0; d < padB; d++) {
      const dst = (sy + c.h + d) * sheetW + xStart, src = (sy + c.h - 1) * sheetW + xStart;
      let free = true;
      for (let u = 0; u < spanW; u++) if (filled[dst + u]) { free = false; break; }
      if (free) { sheet.copyWithin(dst * 4, src * 4, (src + spanW) * 4); filled.fill(1, dst, dst + spanW); }
    }
    c.data = null;
  }
  let firstRow = -1;
  for (let r = 0; r < sheetH; r++) {
    const base = r * sheetW;
    let firstCol = -1;
    for (let c = 0; c < sheetW; c++) if (filled[base + c]) { firstCol = c; break; }
    if (firstCol < 0) continue;
    if (firstRow < 0) firstRow = r;
    for (let c = 0; c < firstCol; c++) sheet.copyWithin((base + c) * 4, (base + firstCol) * 4, (base + firstCol + 1) * 4);
    for (let c = firstCol + 1; c < sheetW; c++) if (!filled[base + c]) sheet.copyWithin((base + c) * 4, (base + c - 1) * 4, (base + c) * 4);
    filled.fill(1, base, base + sheetW);
  }
  if (firstRow >= 0) for (let r = 0; r < sheetH; r++) if (!filled[r * sheetW]) {
    const srcRow = r < firstRow ? firstRow : r - 1;
    sheet.copyWithin(r * sheetW * 4, srcRow * sheetW * 4, (srcRow + 1) * sheetW * 4);
  }
  return sheet;
}

const frame0Stats = (typeof __RAPIER_JXL_FORMAT__ !== 'undefined' && __RAPIER_JXL_FORMAT__ === true) ? null : function frame0Stats(diffs, frame0, data, width, height) {
  let byFrame = diffs.get(frame0);
  if (!byFrame) diffs.set(frame0, byFrame = /* @__PURE__ */ new WeakMap());
  let stats = byFrame.get(data);
  if (!stats) byFrame.set(data, stats = blockStats(frame0, data, width, height, {dx: 0, dy: 0, x0: 0, x1: width, y0: 0, y1: height}).stats);
  return stats;
}

const canvasStats = (typeof __RAPIER_JXL_FORMAT__ !== 'undefined' && __RAPIER_JXL_FORMAT__ === true) ? null : function canvasStats(later, working, after, base, width, height) {
  const across = Math.ceil(width / 8), down = Math.ceil(height / 8), stats = base.slice();
  for (let band = 0; band < down; band += 8) {
    const end = Math.min(down, band + 8);
    let lo = across, hi = -1;
    for (let y = band; y < end; y++) for (let x = 0; x < across; x++) if (later[y * across + x]) { if (x < lo) lo = x; if (x > hi) hi = x; }
    if (hi < 0) continue;
    const wide = hi - lo + 1;
    const part = blockStats(working, after, width, height, {dx: 0, dy: 0, x0: lo * 8, x1: Math.min(width, hi * 8 + 8), y0: band * 8, y1: Math.min(height, end * 8)}).stats;
    for (let y = band; y < end; y++) for (let x = lo; x <= hi; x++) {
      const b = y * across + x;
      if (!later[b]) continue;
      const at = ((y - band) * wide + x - lo) * 4;
      stats[b * 4] = part[at]; stats[b * 4 + 1] = part[at + 1]; stats[b * 4 + 2] = part[at + 2];
    }
  }
  return stats;
}

const markLater = (typeof __RAPIER_JXL_FORMAT__ !== 'undefined' && __RAPIER_JXL_FORMAT__ === true) ? null : function markLater(later, width, x, y, w, h, value) {
  const across = Math.ceil(width / 8);
  for (let by = y >> 3; by < Math.ceil((y + h) / 8); by++) later.fill(value, by * across + (x >> 3), by * across + Math.ceil((x + w) / 8));
}

const buildXybSheetPlan = (typeof __RAPIER_JXL_FORMAT__ !== 'undefined' && __RAPIER_JXL_FORMAT__ === true) ? null : function buildXybSheetPlan(shown, width, height, tolerance, patchPlan, diffs = /* @__PURE__ */ new WeakMap()) {
  const maxSheetPixels = 1048576, frame0 = shown[0].data;
  const f0Tol = {...tolerance, maxBias: Math.min(255, Math.max(2, Math.round(tolerance.mean * 2.8)))};
  const plainFramesCount = patchPlan
    ? 1 + patchPlan.frames.slice(1).filter(f => f.rects.length > 0).length
    : shown.reduce((s, f) => s + f.rects.length, 0);
  if (plainFramesCount < 4) return null;
  const plainTotalArea = patchPlan
    ? width * height + patchPlan.frames.slice(1).reduce((s, f) => s + f.rects.reduce((a, r) => a + r[2] * r[3], 0), 0)
    : shown.reduce((s, f) => s + f.rects.reduce((a, r) => a + r[2] * r[3], 0), 0);
  const canvas = new Uint8Array(frame0);
  const canvasLater = patchPlan ? null : new Uint8Array(Math.ceil(width / 8) * Math.ceil(height / 8));
  const chapters = [], drawsByFrame = Array.from({length: shown.length}, () => []);
  let start = 0, newCellArea = 0, totalSheetArea = 0;
  try {
    while (start < shown.length) {
      const hasFrame0 = start === 0 || Boolean(patchPlan && patchPlan.frames.slice(start).some(f => f.copies.some(cp => cp.reference === BACKGROUND)));
      const items = hasFrame0 ? [{x: 0, y: 0, w: width, h: height, data: cropOf(frame0, width, 0, 0, width, height), sx: 0, sy: 0}] : [];
      const byHash = new Map();
      let bestLayout = hasFrame0 ? {sw: width, sh: height, coords: [{sx: 0, sy: 0}]} : null;
      let end = start === 0 ? 0 : start - 1;
      for (let k = Math.max(1, start); k < shown.length; k++) {
        const copies = patchPlan ? patchPlan.frames[k].copies : [];
        const working = copies.length ? predictedCanvas(canvas, copies, width, frame0) : new Uint8Array(canvas);
        const f0 = hasFrame0 || !patchPlan ? frame0Stats(diffs, frame0, shown[k].data, width, height) : null;
        const workingLater = canvasLater?.slice();
        const rawRects = patchPlan
          ? (patchPlan.frames[k].sheet ? patchPlan.frames[k].sheet.cells.map(c => [c.x, c.y, c.w, c.h]) : patchPlan.frames[k].rects)
          : (changedBlocks(canvasStats(canvasLater, working, shown[k].data, f0, width, height), width, height, tolerance) || []);
        const frameNew = [], frameDraws = [], cellRects = [];
        for (const [rx, ry, rw, rh] of rawRects) {
          if (hasFrame0 && rw >= 8 && rh >= 8) {
            const sub = lossySubRectsAgainstFrame0(f0, width, height, rx, ry, rw, rh, f0Tol);
            if (!sub) {
              frameDraws.push({x: rx, y: ry, w: rw, h: rh, directSx: rx, directSy: ry});
              copyRectRgba(working, frame0, width, rx, ry, rw, rh);
              if (workingLater) markLater(workingLater, width, rx, ry, rw, rh, 0);
              continue;
            }
            const subArea = sub.reduce((s, r) => s + r[2] * r[3], 0);
            if (!patchPlan && subArea + 256 <= rw * rh) {
              frameDraws.push({x: rx, y: ry, w: rw, h: rh, directSx: rx, directSy: ry});
              copyRectRgba(working, frame0, width, rx, ry, rw, rh);
              markLater(workingLater, width, rx, ry, rw, rh, 0);
              for (const sr of sub) cellRects.push(sr);
              continue;
            }
          }
          cellRects.push([rx, ry, rw, rh]);
        }
        let addedArea = 0;
        for (const [cx, cy, cw, ch] of cellRects) {
          const data = cropOf(shown[k].data, width, cx, cy, cw, ch);
          copyRectRgba(working, shown[k].data, width, cx, cy, cw, ch);
          if (workingLater) markLater(workingLater, width, cx, cy, cw, ch, 1);
          const h = hashCropBytes(cw, ch, false, data);
          const existing = byHash.get(h)?.find(m => m.w === cw && m.h === ch && equalCropBytes(m.data, data))
            ?? frameNew.find(m => m.hash === h && m.w === cw && m.h === ch && equalCropBytes(m.data, data));
          if (existing) {
            frameDraws.push({x: cx, y: cy, w: cw, h: ch, ref: existing});
            continue;
          }
          const ni = {x: cx, y: cy, w: cw, h: ch, data, hash: h};
          frameNew.push(ni);
          frameDraws.push({x: cx, y: cy, w: cw, h: ch, ref: ni});
          addedArea += cw * ch;
        }
        if (!frameNew.length) {
          canvas.set(working);
          if (canvasLater) canvasLater.set(workingLater);
          drawsByFrame[k] = frameDraws;
          end = k;
          continue;
        }
        const candLayout = packXybSheetItems(items.concat(frameNew), hasFrame0 ? width : 0, hasFrame0 ? height : 0, maxSheetPixels);
        if (!candLayout) {
          if (end >= start) break;
          return null;
        }
        bestLayout = candLayout;
        canvas.set(working);
        if (canvasLater) canvasLater.set(workingLater);
        newCellArea += addedArea;
        for (const ni of frameNew) {
          items.push(ni);
          const bucket = byHash.get(ni.hash);
          if (bucket) bucket.push(ni); else byHash.set(ni.hash, [ni]);
        }
        drawsByFrame[k] = frameDraws;
        end = k;
      }
      if (!bestLayout || end < start) return null;
      if ((chapters.length + 1) * 2 > shown.length || newCellArea > 0.45 * width * height * (shown.length - 1)) return null;
      totalSheetArea += bestLayout.sw * bestLayout.sh;
      const sheet = renderXybSheet(items, bestLayout.coords, bestLayout.sw, bestLayout.sh);
      chapters.push({start, end, width: bestLayout.sw, height: bestLayout.sh, sheet});
      start = end + 1;
    }
  } finally { forgetFrame(); }
  if (!chapters.length || plainFramesCount - chapters.length < 2 || chapters.length * 2 > shown.length) return null;
  if (newCellArea > 0.45 * width * height * (shown.length - 1)) return null;
  if (totalSheetArea > plainTotalArea * 1.35 + (plainFramesCount - chapters.length) * 4096) return null;
  const blending = () => [{mode: 1, alpha: 0, clamp: false}];
  const groups = [];
  for (let k = 0; k < shown.length; k++) {
    const g = [];
    if (k === 0) g.push({reference: BACKGROUND, sx: 0, sy: 0, w: width, h: height, positions: [{x: 0, y: 0, blending: blending()}]});
    else {
      g.push({reference: CANVAS, sx: 0, sy: 0, w: width, h: height, positions: [{x: 0, y: 0, blending: blending()}]});
      if (patchPlan) for (const cp of patchPlan.frames[k].copies)
        g.push({reference: cp.reference, sx: cp.sx, sy: cp.sy, w: cp.w, h: cp.h, positions: [{x: cp.x, y: cp.y, blending: blending()}]});
      for (const dr of drawsByFrame[k]) {
        const sx = dr.ref ? dr.ref.sx : dr.directSx, sy = dr.ref ? dr.ref.sy : dr.directSy;
        g.push({reference: BACKGROUND, sx, sy, w: dr.w, h: dr.h, positions: [{x: dr.x, y: dr.y, blending: blending()}]});
      }
    }
    groups.push(g);
  }
  return {chapters, groups};
}

const packSheetItems = (typeof __RAPIER_JXL_FORMAT__ !== 'undefined' && __RAPIER_JXL_FORMAT__ === true) ? null : function packSheetItems(items, initW, initH, canvasW, maxPixels) {
  const areaSum = items.reduce((s, c) => s + c.w * c.h, 0);
  if (areaSum > maxPixels) return null;
  const startIdx = initW > 0 ? 1 : 0;
  const widest = Math.max(initW || 16, ...items.map(c => c.w));
  let best = null;
  for (const targetW of [widest, Math.max(widest, Math.ceil(Math.sqrt(areaSum) * 1.3)), Math.min(2048, Math.max(widest, items.reduce((s, c) => s + c.w, 0)))]) {
    let sx = initW, sy = 0, rowH = initH, sw = initW;
    const coords = initW > 0 ? [{sx: 0, sy: 0}] : [];
    for (let i = startIdx; i < items.length; i++) {
      const c = items[i];
      if (sx > 0 && sx + c.w > targetW) { sy += rowH; sx = 0; rowH = 0; }
      coords.push({sx, sy});
      sx += c.w; rowH = Math.max(rowH, c.h); sw = Math.max(sw, sx);
    }
    const sh = Math.max(16, sy + rowH);
    sw = Math.max(16, sw);
    if (sw <= LIMITS.edge && sh <= LIMITS.edge && sw * sh <= maxPixels && (!best || sw * sh < best.sw * best.sh))
      best = {sw, sh, coords};
  }
  return best;
}

export function* partSteps(coder, crop, w, h) {
  shapeFloors.set(crop, coder.floor);
  return yield* frameSteps(coder, coder.mode, crop, w, h, coder.floor);
}

function* frameSteps(a, mode, crop, w, h, floor) {
  if (mode === 'modular') return yield* frameEncodeSteps(crop, w, h, a.still);
  if (!(typeof __RAPIER_JXL_FORMAT__ !== 'undefined' && __RAPIER_JXL_FORMAT__ === true) && mode === 'xyb' && a.xybSteps)
    return yield* a.xybSteps(a, crop, w, h, floor, measuredSearch);
  const small = a.small ?? smallPicture(a.width, a.height);
  const coefficients = yield* part(mode === 'xyb' ? photoXYBSteps(crop, w, h, a.quality, {...(small ? SMALL_V6 : V6), filter: a.filter, fast: true})
    : photoCoefficientSteps(crop, w, h, a.quality, a.colorSpace), 0, 2);
  coefficients.alpha = floor.alpha ? crop : null;
  return markShown(yield* part(coefficientAnsSteps(coefficients, a.effort), 1, 2), coefficients);
}

const SEPARATE = 4096, TILE = 16, MOST = 16;

function changes(before, after, width, height) {
  const {spans, segments, hits} = frameSpans(before, after, width, height);
  if (!hits) return null;
  const perPixel = before.BYTES_PER_ELEMENT;
  const tilesX = Math.ceil(width / TILE), tilesY = Math.ceil(height / TILE), tiles = tilesX * tilesY;
  const bounds = new Int32Array(tiles * 4).fill(-1);
  for (let y = 0; y < height; y++) {
    const row = y * segments * 2, ty = (y / TILE | 0) * tilesX;
    for (let s = 0; s < segments; s++) {
      const at = row + s * 2;
      if (spans[at] === 255) continue;
      const x0 = (s * 16 + spans[at]) / perPixel | 0, x1 = (s * 16 + spans[at + 1]) / perPixel | 0;
      const t = (ty + (x0 / TILE | 0)) * 4;
      if (bounds[t] < 0) { bounds[t] = x0; bounds[t + 2] = x1; bounds[t + 1] = bounds[t + 3] = y; }
      else { bounds[t] = Math.min(bounds[t], x0); bounds[t + 2] = Math.max(bounds[t + 2], x1); bounds[t + 3] = y; }
    }
  }
  return regions(bounds, tilesX, tilesY, width, height, 1);
}

function regions(bounds, tilesX, tilesY, width, height, block) {
  const tiles = tilesX * tilesY;
  const label = new Uint8Array(tiles), rects = [], stack = [];
  for (let t = 0; t < tiles; t++) {
    if (bounds[t * 4] < 0 || label[t]) continue;
    const r = [width, height, 0, 0];
    label[t] = 1; stack.push(t);
    while (stack.length) {
      const u = stack.pop(), ux = u % tilesX, uy = u / tilesX | 0;
      r[0] = Math.min(r[0], bounds[u * 4]); r[1] = Math.min(r[1], bounds[u * 4 + 1]);
      r[2] = Math.max(r[2], bounds[u * 4 + 2] + 1); r[3] = Math.max(r[3], bounds[u * 4 + 3] + 1);
      for (let vy = Math.max(0, uy - 1); vy <= Math.min(tilesY - 1, uy + 1); vy++) for (let vx = Math.max(0, ux - 1); vx <= Math.min(tilesX - 1, ux + 1); vx++) {
        const v = vy * tilesX + vx;
        if (bounds[v * 4] >= 0 && !label[v]) { label[v] = 1; stack.push(v); }
      }
    }
    rects.push([Math.floor(r[0] / block) * block, Math.floor(r[1] / block) * block, Math.min(width, Math.ceil(r[2] / block) * block), Math.min(height, Math.ceil(r[3] / block) * block)]);
  }
  const size = r => (r[2] - r[0]) * (r[3] - r[1]);
  const union = (a, b) => [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
  const limit = !(typeof __RAPIER_JXL_FORMAT__ !== 'undefined' && __RAPIER_JXL_FORMAT__ === true) && block === 8 ? 384 : SEPARATE;
  const extra = (a, b) => size(union(a, b)) - size(a) - size(b), waste = [], partner = [];
  const row = i => {
    let least = Infinity, at = -1;
    for (let j = i + 1; j < rects.length; j++) { const e = extra(rects[i], rects[j]); if (e < least) { least = e; at = j; } }
    waste[i] = least; partner[i] = at;
  };
  for (let i = 0; i < rects.length; i++) row(i);
  for (;;) {
    let a = -1;
    for (let i = 0; i < rects.length; i++) if (partner[i] >= 0 && (a < 0 || waste[i] < waste[a])) a = i;
    if (a < 0 || waste[a] >= limit && rects.length <= MOST) break;
    const b = partner[a];
    rects[a] = union(rects[a], rects[b]); rects.splice(b, 1); waste.splice(b, 1); partner.splice(b, 1);
    for (let i = 0; i < rects.length; i++) {
      const p = partner[i];
      if (i === a || p === a || p === b) { row(i); continue; }
      if (p > b) partner[i] = p - 1;
      if (i < a) { const e = extra(rects[i], rects[a]); if (e < waste[i] || e === waste[i] && a < partner[i]) { waste[i] = e; partner[i] = a; } }
    }
  }
  return rects.map(([x0, y0, x1, y1]) => [x0, y0, x1 - x0, y1 - y0]);
}

const TOLERANCE = {mean: 1.25, most: 7};
function toleranceOf(quality) {
  const distance = quality >= 30 ? 0.1 + (100 - quality) * 0.09 : 53 / 3000 * quality * quality - 23 / 20 * quality + 25;
  return {mean: TOLERANCE.mean * distance, most: TOLERANCE.most * distance};
}

function lossyChanges(source, after, width, height, {mean, most, maxBias}) {
  const {stats, hits} = maxBias === undefined ? blockStats(source, after, width, height)
    : blockStats(source, after, width, height, {dx: 0, dy: 0, x0: 0, x1: width, y0: 0, y1: height});
  return hits ? changedBlocks(stats, width, height, {mean, most, maxBias}) : null;
}

function changedBlocks(stats, width, height, {mean, most, maxBias}) {
  const tilesX = Math.ceil(width / TILE), tilesY = Math.ceil(height / TILE), bounds = new Int32Array(tilesX * tilesY * 4).fill(-1);
  let any = false, at = 0;
  for (let y0 = 0; y0 < height; y0 += 8) for (let x0 = 0; x0 < width; x0 += 8) {
    const y1 = Math.min(height, y0 + 8), x1 = Math.min(width, x0 + 8);
    const sum = stats[at] | stats[at + 1] << 8, peak = stats[at + 2], bias = stats[at + 3];
    at += 4;
    if (sum <= mean * (x1 - x0) * (y1 - y0) && peak <= most && (maxBias === undefined || bias <= maxBias)) continue;
    const t = ((y0 / TILE | 0) * tilesX + (x0 / TILE | 0)) * 4;
    if (bounds[t] < 0) { bounds[t] = x0; bounds[t + 1] = y0; bounds[t + 2] = x1 - 1; bounds[t + 3] = y1 - 1; }
    else { bounds[t] = Math.min(bounds[t], x0); bounds[t + 1] = Math.min(bounds[t + 1], y0); bounds[t + 2] = Math.max(bounds[t + 2], x1 - 1); bounds[t + 3] = Math.max(bounds[t + 3], y1 - 1); }
    any = true;
  }
  return any ? regions(bounds, tilesX, tilesY, width, height, 8) : null;
}

const KEPT_SHARES = [0.125, 0.5, 1], RAISES = 4;
const DRIFT = {at: 0.3, slope: 40};
const frameKeeper = (typeof __RAPIER_JXL_FORMAT__ !== 'undefined' && __RAPIER_JXL_FORMAT__ === true) ? null : function frameKeeper(keep, shown, frames, width, height, firstOnly, loops, hasAlpha = false) {
  const across = Math.ceil(width / 8), down = Math.ceil(height / 8);
  const cover = rects => {
    const blocks = new Uint8Array(across * down);
    for (const [x, y, w, h] of rects) for (let by = y >> 3; by < Math.ceil((y + h) / 8); by++)
      blocks.fill(1, by * across + (x >> 3), by * across + Math.ceil((x + w) / 8));
    return blocks;
  };
  const sources = k => {
    const from = k ? shown[k - 1].upTo + 1 : 0, list = [];
    for (let i = from; i <= shown[k].upTo; i++)
      if (frames[i].duration > 0 || i === frames.length - 1 && loops > 0 || i === shown[k].upTo && !list.length) list.push(frames[i].data);
    return list;
  };
  const keeps = shown.map((frame, k) => !k || !firstOnly && frame !== shown[k - 1] && (cover(frame.rects).includes(0) || sources(k).length > 1)),
    last = keeps.lastIndexOf(true);
  const canvas = new Uint8Array(width * height * 4), before = new Uint8Array(width * height * 4);
  let pictures = new Map(), current = -1, lost = false, state = null, readers = [], lifted = null, anchor = null, exact = false, compA = null, compB = null;
  const unproved = [], first = k => k ? shown[k - 1].upTo + 1 : 0;
  const errors = data => {
    if (!hasAlpha) {
      const {stats} = blockStats(canvas, data, width, height), sums = new Uint16Array(stats.length / 4);
      for (let b = 0; b < sums.length; b++) sums[b] = stats[b * 4] | stats[b * 4 + 1] << 8;
      return sums;
    }
    compA ??= new Uint8Array(width * height * 4);
    compB ??= new Uint8Array(width * height * 4);
    const sums = new Uint16Array(across * down);
    for (const bg of [255, 0]) {
      compA.set(canvas);
      compB.set(data.subarray(0, compB.length));
      if (!captureComposeOver(compA, canvas, width, height, bg) || !captureComposeOver(compB, data, width, height, bg)) {
        const {stats} = blockStats(canvas, data, width, height);
        for (let b = 0; b < sums.length; b++) sums[b] = stats[b * 4] | stats[b * 4 + 1] << 8;
        return sums;
      }
      const {stats} = blockStats(compA, compB, width, height);
      for (let b = 0; b < sums.length; b++) {
        const sum = stats[b * 4] | stats[b * 4 + 1] << 8;
        if (sum > sums[b]) sums[b] = sum;
      }
    }
    return sums;
  };
  const close = () => { for (const reader of readers) reader.destroy(); readers = []; };
  return {
    seen: (bytes, picture) => { pictures.set(bytes, picture); },
    begin(k) { close(); current = k; if (keeps[k]) before.set(canvas); pictures.clear(); },
    destroy() { close(); compA = compB = null; },
    get coder() { return lifted; },
    get exact() { return exact; },
    unproved,
    paste(file, [x, y, w, h], masked = false) {
      if (current > last) return;
      const picture = x + w <= width && y + h <= height ? pictures.get(file) : null;
      const rgba = picture && !lost ? keep.render(picture, x, y) : null;
      pictures.clear();
      if (!rgba) { lost = true; return; }
      blendPaste(canvas, width, rgba, x, y, w, h, masked);
    },
    repair(k, round, coder) {
      if (k !== current || !keeps[k]) return null;
      if (lost) { exact = true; unproved.push({frame: first(k), done: 'exact file'}); return null; }
      if (!round) {
        state = {share: 0, raises: 0, quality: coder.quality};
        if (anchor) {
          let change = 0;
          for (const source of sources(k)) {
            const now = errors(source);
            let sum = 0;
            for (let b = 0; b < now.length; b++) sum += Math.abs(now[b] - anchor.errors[b]);
            change = Math.max(change, sum / (width * height));
          }
          if (anchor.reading - DRIFT.at - DRIFT.slope * change >= keep.floor) return null;
        }
        readers = sources(k).map(source => keep.reader(source));
      }
      let reading = Infinity;
      for (const reader of readers) reading = Math.min(reading, reader.score(canvas));
      if (reading >= keep.floor) {
        if (state.top) unproved.push({frame: first(k), done: 'raised'});
        anchor = {reading, errors: errors(shown[k].data)};
        return null;
      }
      const blocks = cover(shown[k].rects);
      if (state.share < KEPT_SHARES.length && blocks.includes(0)) {
        const sums = errors(shown[k].data), kept = [];
        for (let b = 0; b < blocks.length; b++) if (!blocks[b]) kept.push([sums[b], b]);
        kept.sort((p, q) => q[0] - p[0] || p[1] - q[1]);
        const take = Math.ceil(kept.length * KEPT_SHARES[state.share++]);
        for (let i = 0; i < take; i++) blocks[kept[i][1]] = 1;
        const tilesX = Math.ceil(width / TILE), bounds = new Int32Array(tilesX * Math.ceil(height / TILE) * 4).fill(-1);
        for (let b = 0; b < blocks.length; b++) {
          if (!blocks[b]) continue;
          const x0 = b % across * 8, y0 = (b / across | 0) * 8, x1 = Math.min(width, x0 + 8) - 1, y1 = Math.min(height, y0 + 8) - 1;
          const t = ((y0 / TILE | 0) * tilesX + (x0 / TILE | 0)) * 4;
          if (bounds[t] < 0) { bounds[t] = x0; bounds[t + 1] = y0; bounds[t + 2] = x1; bounds[t + 3] = y1; }
          else { bounds[t] = Math.min(bounds[t], x0); bounds[t + 1] = Math.min(bounds[t + 1], y0); bounds[t + 2] = Math.max(bounds[t + 2], x1); bounds[t + 3] = Math.max(bounds[t + 3], y1); }
        }
        canvas.set(before);
        return {rects: shown[k].rects = regions(bounds, tilesX, Math.ceil(height / TILE), width, height, 8)};
      }
      if (state.top) { exact = true; unproved.push({frame: first(k), done: 'exact file'}); return null; }
      state.quality = state.raises++ >= RAISES ? 99.99 : Math.min(99.99, state.quality + Math.max(1, Math.ceil(keep.floor - reading)));
      state.top = state.quality >= 99.99;
      canvas.set(before);
      const raised = {...coder, quality: state.quality, still: {...coder.still, quality: state.quality}};
      if (!k && !state.top) lifted = raised;
      return {rects: shown[k].rects = [[0, 0, width, height]], coder: raised};
    },
  };
};

export function pixelsOf({data, previous, rect: [x, y, w, h], masked, fill}, width) {
  const crop = cropOf(data, width, x, y, w, h);
  return masked ? maskCrop(previous, crop, width, [x, y, w, h], fill) : crop;
}

export function cropOf(data, width, x, y, w, h) {
  const kind = data instanceof Uint8ClampedArray ? Uint8ClampedArray : data instanceof Uint8Array ? Uint8Array : data instanceof Uint16Array ? Uint16Array : data.constructor;
  if (x === 0 && y === 0 && w === width && h * width * 4 === data.length) return new kind(data);
  const out = new kind(w * h * 4);
  for (let row = 0; row < h; row++) out.set(data.subarray(((y + row) * width + x) * 4, ((y + row) * width + x + w) * 4), row * w * 4);
  return out;
}

const gcd = (a, b) => { while (b) [a, b] = [b, a % b]; return a; };

function fraction(value) {
  let [p0, q0, p1, q1] = [0, 1, 1, 0], x = value;
  for (let i = 0; i < 32; i++) {
    const a = Math.floor(x), p = a * p1 + p0, q = a * q1 + q0;
    if (q > 100000) break;
    [p0, q0, p1, q1] = [p1, q1, p, q];
    if (Math.abs(p / q - value) <= 1e-6) return [p, q];
    if (x === a) break;
    x = 1 / (x - a);
  }
  return null;
}

function ticks(durations, windowed = false) {
  const parts = durations.map(fraction);
  let exact = null, lcm = 0;
  if (parts.every(Boolean)) {
    lcm = parts.reduce((l, [, q]) => l / gcd(l, q) * q, 1);
    if (Number.isSafeInteger(lcm)) {
      const counts = parts.map(([p, q]) => p * (lcm / q));
      const common = windowed ? 1 : counts.reduce(gcd, 0) || 1;
      const n = 1000 * lcm, g = gcd(n, common), numerator = n / g, denominator = common / g;
      if (numerator <= 1073741824 && denominator <= 1024 && counts.every(c => c / common <= 0xFFFFFFFF))
        return {numerator, denominator, durations: counts.map(c => c / common)};
      if (numerator <= 1073741824 && counts.every(c => c / g <= 0xFFFFFFFF))
        exact = {numerator, denominator: 1, durations: counts.map(c => c / g)};
    }
  }
  if (!exact || lcm >= 1000) {
    let best = null, least = 0.05;
    for (const [numerator, denominator] of VIDEO_RATES) {
      const tick = 1000 * denominator / numerator;
      const error = durations.reduce((most, d) => d === 0 ? most : Math.max(most, d / tick < 0.5 ? Infinity : Math.abs(d / tick - Math.round(d / tick)) * tick), 0);
      if (error < least) { least = error; best = [numerator, denominator]; }
    }
    if (best) return carried(durations, ...best);
  }
  return exact ?? carried(durations, 1000, 1);
}

export function animationTiming(durations) {
  const {numerator, denominator, durations: counts} = ticks(durations), tick = 1000 * denominator / numerator;
  return counts.some((n, i) => Math.abs(n * tick - durations[i]) > 1e-6 * Math.max(1, durations[i])) ? 'rounded' : 'exact';
}


function carried(durations, numerator, denominator) {
  let total = 0, at = 0;
  return {numerator, denominator, durations: durations.map(d => {
    total += d * numerator / (1000 * denominator);
    const ticks = Math.max(d > 0 ? 1 : 0, Math.round(total) - at); at += ticks; return ticks;
  })};
}

function levelTen(codestream) {
  const out = new Uint8Array(49 + codestream.length);
  out.set([0,0,0,12,74,88,76,32,13,10,135,10, 0,0,0,20,102,116,121,112,106,120,108,32,0,0,0,0,106,120,108,32,
    0,0,0,9,106,120,108,108,10, 0,0,0,0,106,120,108,99]);
  new DataView(out.buffer).setUint32(41, codestream.length + 8);
  out.set(codestream, 49);
  return out;
}
