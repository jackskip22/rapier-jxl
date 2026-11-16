// SPDX-License-Identifier: MIT
import {LIMITS} from './limits.mjs';
import {BitWriter, part} from './bits.mjs';
import {fault, guard, admitOptions, admitPixels, admitSize} from './admit.mjs';
import {admitSampleFormat} from './admit-samples.mjs';
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
import {frameSpans, blockStats, alphaAny, unchangedShare, maskCrop, forgetFrame} from './animation-diff.mjs';
import {planAnimationPatches, predictedCanvas, frameViewGroups, encodeFrameView, sheetPixels, CANVAS, BACKGROUND, tallPixels, tallWindow, TALL_SLOT, MASK_SHARE} from './animation-moves.mjs';

export const ANIMATION_LIMITS = Object.freeze({pixels: LIMITS.pixels, edge: LIMITS.edge, frames: Number.MAX_SAFE_INTEGER});
const REFERENCE_ONLY = 2;
export const ANIMATION_OBSERVER = Symbol('animation frame observer');

export function admitAnimation(animation, options) {
  if (animation === null || typeof animation !== 'object') throw fault('JXL_INPUT', 'An animation is {width, height, loops, frames}.');
  if (options === null || typeof options !== 'object') throw fault('JXL_INPUT', 'Options are an object.');
  const {width, height, loops = 0, frames} = animation;
  admitSize(width, height);
  if (!Number.isInteger(loops) || loops < 0 || loops > 0xFFFFFFFF) throw fault('JXL_INPUT', 'Loops is a whole number; 0 plays forever.');
  if (!Array.isArray(frames) || !frames.length) throw fault('JXL_INPUT', 'An animation has at least one frame.');
  if (frames.length > ANIMATION_LIMITS.frames) throw fault('JXL_DIMENSIONS', 'An animation has at most ' + ANIMATION_LIMITS.frames + ' frames.');
  const kind = frames[0]?.data?.constructor;
  if (!READ_GIFS.has(animation)) for (const frame of frames) {
    if (frame === null || typeof frame !== 'object') throw fault('JXL_INPUT', 'A frame is {data, duration}.');
    admitPixels(frame.data, width, height);
    if (frame.data.constructor !== kind) throw fault('JXL_INPUT', 'Every frame uses the same sample array type.');
    if (typeof frame.duration !== 'number' || !Number.isFinite(frame.duration) || frame.duration < 0 || frame.duration > 0xFFFFFFFF)
      throw fault('JXL_INPUT', 'A frame duration is a number of milliseconds, 0 or more.');
  }
  if (options.lossless !== undefined && typeof options.lossless !== 'boolean') throw fault('JXL_INPUT', 'lossless is a boolean.');
  const {quality, colorSpace} = admitOptions(options.lossless ? {...options, quality: 100} : options);
  const effort = admitEffort(options), filter = admitPhotoFilter(options);
  const samples = admitSampleFormat(frames[0].data, options);
  if (options.photo !== undefined && typeof options.photo !== 'boolean') throw fault('JXL_INPUT', 'photo is a boolean.');
  checkSignal(options.signal);
  const {progress, signal, lossless, photo, probe, [ANIMATION_OBSERVER]: observe, ...still} = options;
  if (observe !== undefined && typeof observe !== 'function') throw fault('JXL_INTERNAL', 'An animation observer is a per-call factory.');
  if (!(typeof __RAPIER_JXL_FORMAT__ !== 'undefined' && __RAPIER_JXL_FORMAT__ === true)) {
    const {xybSteps, ...cleanStill} = still;
    return {width, height, loops, frames, quality, colorSpace, effort, filter, samples, photo, signal, probe: probe === true, observe, xybSteps, still: {...cleanStill, quality, effort, xybProbe: probe === true}};
  }
  return {width, height, loops, frames, quality, colorSpace, effort, filter, samples, photo, signal, probe: probe === true, observe, still: {...still, quality, effort}};
}

export const exactFiles = new WeakSet();
export const quickFiles = new WeakSet();

export function* animationSteps(a, shared = null, allowRegions = !(typeof __RAPIER_JXL_FORMAT__ !== 'undefined' && __RAPIER_JXL_FORMAT__ === true)) {
  if (!(typeof __RAPIER_JXL_FORMAT__ !== 'undefined' && __RAPIER_JXL_FORMAT__ === true) && a.xybSteps) xybHook = a.xybSteps;
  const observer = a.observe?.();
  try {
  const {width, height, frames, samples, quality} = a;
  const frameRead = samples.iccData ? {iccBits: samples.iccData.bitLength} : undefined;
  let first = frames.findIndex(frame => frame.duration > 0);
  if (first < 0) first = frames.length - 1;
  const mode = yield* frameMode(a, frames[first].data, frames);
  if (mode === 'modular' && quality < 100 && samples.native8 && a.photo !== false) {
    const bytes = yield* animationSteps({...a, quality: 100, still: {...a.still, quality: 100}}, shared, allowRegions);
    if (bytes.length) exactFiles.add(bytes);
    return bytes;
  }
  let shown = [];
  let previous = null, source = null;
  const floor = {colour: 1, alpha: false};
  const tolerance = mode === 'modular' ? null : toleranceOf(quality);
  try {
  for (let i = 0; i < frames.length; i++) {
    if (i && i % 16 === 0) yield 0.01 * i / frames.length;
    const {data, duration} = frames[i];
    if (!duration && (i < frames.length - 1 || shown.length) && !(i === frames.length - 1 && a.loops > 0)) continue;
    const rects = !previous ? [[0, 0, width, height]] : tolerance ? lossyChanges(source, data, width, height, tolerance) : changes(previous, data, width, height);
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
  const timing = ticks(shown.map(frame => frame.duration));
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

  const maskable = mode === 'modular' && samples.native8 && !floor.alpha;
  const patchPlan = allowRegions && !shared && frames.length > 1 && samples.native8 && a.colorSpace === 'srgb' &&
    !a.still.icc && !a.still.colorEncoding && (a.still.transferFunction ?? 'srgb') === 'srgb' &&
    (mode === 'modular' && quality === 100 || mode === 'xyb' && quality >= 60)
    ? yield* planAnimationPatches(shown, width, height, {tolerance, changes, lossyChanges, masks: maskable}) : null;
  const patching = Boolean(patchPlan);
  const parts = shown.flatMap((frame, k) => {
    const plan = patching ? patchPlan.frames[k] : null;
    const own = (plan ? plan.rects : frame.rects).map((rect, r) =>
      ({frame: k, get data() { return frame.data; }, get previous() { return !patching && k ? shown[k - 1].data : null; }, rect,
        ...(plan ? {slot: k || plan.window ? 0 : BACKGROUND, shows: false, sheet: plan.sheet} : {shows: r === frame.rects.length - 1})}));
    return plan?.tall ? [{frame: k, data: null, tall: plan.tall, previous: null, rect: [0, 0, plan.tall.width, plan.tall.height], slot: TALL_SLOT, shows: false}, ...own] : own;
  });
  const partsByFrame = Array.from({length: shown.length}, () => []);
  for (const part of parts) partsByFrame[part.frame].push(part);
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
    return part.tall ? tallPicture(part.tall).slice() : part.sheet ? sheetPixels(part.data, width, part.sheet)
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
    const own = byFrame[k], area = own.reduce((n, {rect}) => n + rect[2] * rect[3], 0), to = (shown[k].upTo + 1) / frames.length;
    let at = from;
    for (const job of own) { const next = at + (to - from) * job.rect[2] * job.rect[3] / area; job.span = [at, next]; at = next; }
    from = to;
  }
  const paletteSearch = !shared && quality === 100 && a.effort >= 8 && samples.native8 && a.colorSpace === 'srgb';
  const finished = file => { if (!(typeof __RAPIER_JXL_FORMAT__ !== 'undefined' && __RAPIER_JXL_FORMAT__ === true) && a.still.xybProbe && mode === 'xyb' && a.effort >= 6 && a.xybSteps) quickFiles.add(file); observer?.finish(file); return file; };
  const coder = coderOf(a, mode, floor), progress = done => 0.02 + (paletteSearch ? 0.8 : 0.97) * done;
  const viewGroups = patching ? new Array(shown.length) : null;
  observer?.begin({width, height, loops: a.loops, numerator: timing.numerator, denominator: timing.denominator,
    durations: timing.durations.map(duration => duration * timing.denominator / timing.numerator), patches: patching, alpha: floor.alpha});
  let pictured = a.probe ? new Set() : null, firstFile = null;
  const advance = (scope, steps, reply) => {
    const stop = pictured ? watchShown((bytes, picture) => { if (picture !== EXACT) pictured.add(bytes); }) : null;
    try { return observer ? observer.next(scope, steps, reply) : steps.next(reply); }
    finally { stop?.(); }
  };
  for (let k = 0; k < shown.length; k++) {
    const ownJobs = byFrame[k];
    for (let j = 0; j < ownJobs.length; j++) {
      const job = ownJobs[j];
      if (pictured && job !== jobs[0]) {
        const kept = pictured.has(firstFile); pictured = null;
        if (!kept) return new Uint8Array(0);
      }
      const [, , w, h] = job.rect, [from, to] = job.span;
      if (!shared && job.part.tried?.masked === job.masked) {
        job.bytes = job.part.tried.bytes; delete job.part.tried;
        yield progress(to);
      } else {
        const steps = shared ? shared.partSteps(coder, pixels(job), w, h, job) : partSteps(coder, pixels(job), w, h);
        let step, reply;
        try { while (!(step = advance(job.part, steps, reply)).done) reply = yield typeof step.value === 'number' ? progress(from + (to - from) * step.value) : step.value; }
        finally { if (!step?.done) steps.return?.(); }
        job.bytes = step.value;
      }
      firstFile ||= job.bytes;
      if (!job.part.still || job.bytes.length < job.part.bytes)
        Object.assign(job.part, {still: job.bytes, bytes: job.bytes.length, masked: job.masked});
      if (j + 1 === ownJobs.length || ownJobs[j + 1].part !== job.part) {
        const part = job.part;
        part.file = part.still; part.still = readStill(part.file, frameRead);
        observer?.settlePart({scope: part, file: part.file, rect: part.rect, saveSlot: patching ? part.slot : undefined});
      }
    }
    if (patching) viewGroups[k] = frameViewGroups({width, height, first: k === 0 || Boolean(patchPlan.frames[k].window),
      copies: patchPlan.frames[k].copies, parts: partsByFrame[k]}, parts[0].still.image.extraChannels);
    observer?.finishFrame(k, patching ? viewGroups[k] : null);
    for (const job of byFrame[k]) delete job.bytes;
    releasePrediction();
  }
  const key = metadataKey(parts[0].still);
  if (parts.some(({still}) => metadataKey(still) !== key)) {
    if (mode === 'modular' && quality < 100 && samples.native8 && a.photo !== true) return yield* animationSteps({...a, photo: true}, shared, allowRegions);
    throw fault('JXL_FRAMING', 'The frames of the animation need different image headers.');
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
      throw fault('JXL_INTERNAL', 'An admitted animation motion part violated its shared frame/reference contract.');
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
          throw fault('JXL_INTERNAL', 'An animation frame saves two parts to one reference slot.');
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
  const timeline = parts => ({timeline: {width, height, loops: a.loops ?? 0, numerator: timing.numerator, denominator: timing.denominator,
    durations: timing.durations.map(d => d * timing.denominator / timing.numerator),
    parts: parts.map(({frame, rect, shows, file, slot}) => ({frame, rect, shows, file, ...(patching && {saveSlot: slot})})),
    ...(patching && {patches: viewGroups})}});
  const exactWhole = (file, list) => { if (quality < 100 && list.every(part => exactAnswer(part.file))) exactFiles.add(file); return file; };
  let bytes = exactWhole(markShown(write(parts), timeline(parts)), parts);
  if (!(typeof __RAPIER_JXL_FORMAT__ !== 'undefined' && __RAPIER_JXL_FORMAT__ === true) &&
      allowRegions && !shared && !patchPlan?.tall && shown.length > 1 && mode === 'modular' && quality === 100 &&
      a.effort >= 5 && samples.native8 && a.colorSpace === 'srgb' && !a.still.icc && !a.still.colorEncoding &&
      (a.still.transferFunction ?? 'srgb') === 'srgb' && sheetPays(bytes.length, partsByFrame)) {
    const items = [{x: 0, y: 0, w: width, h: height, masked: false, data: cropOf(shown[0].data, width, 0, 0, width, height)}];
    const drawsByFrame = Array.from({length: shown.length}, () => []);
    for (let k = 1; k < shown.length; k++) {
      for (const p of partsByFrame[k]) {
        if (p.sheet) {
          for (const cell of p.sheet.cells) {
            const it = {x: cell.x, y: cell.y, w: cell.w, h: cell.h, masked: false, data: cropOf(shown[k].data, width, cell.x, cell.y, cell.w, cell.h)};
            items.push(it); drawsByFrame[k].push(it);
          }
        } else {
          const [rx, ry, rw, rh] = p.rect;
          const it = {x: rx, y: ry, w: rw, h: rh, masked: Boolean(p.masked), data: pixels({part: p, masked: Boolean(p.masked)})};
          items.push(it); drawsByFrame[k].push(it);
        }
      }
      releasePrediction();
    }
    if (items.length > 1) {
      const areaSum = items.reduce((s, c) => s + c.w * c.h, 0), widest = Math.max(width, ...items.map(c => c.w));
      let bestLayout = null;
      for (const targetW of [widest, Math.max(widest, Math.ceil(Math.sqrt(areaSum) * 1.3)), Math.min(2048, items.reduce((s, c) => s + c.w, 0))]) {
        let sx = width, sy = 0, rowH = height, sw = width;
        const coords = [{sx: 0, sy: 0}];
        for (let i = 1; i < items.length; i++) {
          const c = items[i];
          if (sx + c.w > targetW) { sy += rowH; sx = 0; rowH = 0; }
          coords.push({sx, sy});
          sx += c.w; rowH = Math.max(rowH, c.h); sw = Math.max(sw, sx);
        }
        const sh = sy + rowH;
        if (sw <= LIMITS.edge && sh <= LIMITS.edge && sw * sh <= 1048576 && (!bestLayout || sw * sh < bestLayout.sw * bestLayout.sh))
          bestLayout = {sw, sh, coords};
      }
      if (bestLayout) {
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
        const sheetCoder = a.effort >= 8 ? coder : {...coder, effort: 3, still: {...coder.still, effort: 3}};
        const sheetBytes = yield* quiet(partSteps(sheetCoder, sheet, sheetW, sheetH));
        if (sheetBytes.length + shown.length * 24 < bytes.length) {
          const sheetStill = readStill(sheetBytes, frameRead);
          const extra = sheetStill.image.extraChannels;
          let sheetView = view;
          if (!sheetView) {
            const flat = new Uint8Array(width * height * 4).fill(255), viewCoder = {...coder, mode: 'modular', quality: 100, effort: 1, still: {...coder.still, quality: 100, effort: 1}};
            sheetView = readStill(yield* quiet(partSteps(viewCoder, flat, width, height)), frameRead);
          }
          const viewOk = sheetView.frames.length === 1 && sheetView.frames[0].modular && !sheetView.frames[0].ycbcr &&
            sheetView.frames[0].passes === 1 && !(sheetView.frames[0].flags & 32) && !sheetView.image.xyb &&
            sheetView.image.extraChannels === extra && metadataKey(sheetView) === key;
          if (viewOk && metadataKey(sheetStill) === key && patchable(sheetStill)) {
            const blending = m => Array.from({length: 1 + extra}, () => ({mode: m, alpha: 0, clamp: false}));
            const sGroups = [], sDicts = [];
            for (let k = 0; k < shown.length; k++) {
              const g = [];
              if (k === 0) g.push({reference: BACKGROUND, sx: 0, sy: 0, w: width, h: height, positions: [{x: 0, y: 0, blending: blending(1)}]});
              else {
                g.push({reference: CANVAS, sx: 0, sy: 0, w: width, h: height, positions: [{x: 0, y: 0, blending: blending(1)}]});
                if (patching) for (const cp of patchPlan.frames[k].copies)
                  g.push({reference: cp.reference, sx: cp.sx, sy: cp.sy, w: cp.w, h: cp.h, positions: [{x: cp.x, y: cp.y, blending: blending(1)}]});
                for (const dr of drawsByFrame[k])
                  g.push({reference: BACKGROUND, sx: dr.sx, sy: dr.sy, w: dr.w, h: dr.h, positions: [{x: dr.x, y: dr.y, blending: blending(dr.masked ? 4 : 1)}]});
              }
              sGroups.push(g);
              sDicts.push(yield* quiet(encodeFrameView(g, extra)));
            }
            const out = new BitWriter(1 << 16);
            writeAnimatedImageHeader(out, sheetStill, {width, height, ...timing, loops: a.loops}, sheetStill.image.modular16);
            const canvas = {width, height, extraChannels: extra};
            sheetStill.frames.forEach((frame, i) => {
              if (i < sheetStill.frames.length - 1) writeAnimatedFrame(out, sheetStill, frame, {canvas, reference: CANVAS});
              else writeStillFrame(out, sheetStill, frame, {canvas, frameType: REFERENCE_ONLY, reference: BACKGROUND, beforeColorTransform: true});
            });
            for (let k = 0; k < shown.length; k++) {
              const last = k === shown.length - 1;
              writeAnimatedFrame(out, sheetView, sheetView.frames[0], {canvas, duration: timing.durations[k], last, reference: last ? 0 : CANVAS,
                beforeColorTransform: true, patchDictionary: sDicts[k], dropYCbCr: false});
            }
            const raw = out.finish(), sheetCand = sheetStill.level === 10 ? levelTen(raw) : raw;
            if (sheetCand.length < bytes.length) {
              const sParts = [{frame: 0, rect: [0, 0, sheetW, sheetH], shows: false, file: sheetBytes, saveSlot: BACKGROUND}];
              bytes = exactWhole(markShown(sheetCand, {timeline: {width, height, loops: a.loops ?? 0, numerator: timing.numerator,
                denominator: timing.denominator, durations: timing.durations.map(d => d * timing.denominator / timing.numerator),
                parts: sParts, patches: sGroups}}), sParts);
            }
          }
        }
      }
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
const frameEncodeSteps = (data, width, height, options, probe = false) => floored(job(effortJob(data, width, height, options, false, undefined, measuredSearch, photoAnsSteps, FRAME_LADDER), true), probe ? 3 : options.effort);
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
function* floored(steps, effort) {
  let step, reply;
  try {
    while (!(step = steps.next(reply)).done) {
      const ask = step.value?.capture;
      if (!ask) { reply = yield step.value; continue; }
      reply = effort > 2 || ask.width * ask.height < FRAME_CAPTURE || fewColors(ask) ? undefined
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
  return exact.length <= lossy.length ? 'modular' : dct;
}

function coderOf({quality, filter, colorSpace, effort, still, width, height}, mode, floor) {
  if (!(typeof __RAPIER_JXL_FORMAT__ !== 'undefined' && __RAPIER_JXL_FORMAT__ === true)) {
    const {xybProbe, ...restStill} = still;
    return {mode, quality, filter, colorSpace, effort, still: restStill, floor, small: smallPicture(width, height), probe: xybProbe, xybSteps: xybHook};
  }
  return {mode, quality, filter, colorSpace, effort, still, floor, small: smallPicture(width, height)};
}

const SHEET_PART = 8192;
function sheetPays(bytes, partsByFrame) {
  let files = 1;
  for (let k = 1; k < partsByFrame.length; k++) for (const p of partsByFrame[k]) files += p.sheet ? p.sheet.cells.length : 1;
  return files > 1 && bytes <= SHEET_PART * files;
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
  for (;;) {
    let best = null, waste = Infinity;
    for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) {
      const extra = size(union(rects[i], rects[j])) - size(rects[i]) - size(rects[j]);
      if (extra < waste) { waste = extra; best = [i, j]; }
    }
    if (!best || waste >= (!(typeof __RAPIER_JXL_FORMAT__ !== 'undefined' && __RAPIER_JXL_FORMAT__ === true) && block === 8 ? 384 : SEPARATE) && rects.length <= MOST) break;
    rects[best[0]] = union(rects[best[0]], rects[best[1]]); rects.splice(best[1], 1);
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
  if (!hits) return null;
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

function ticks(durations) {
  const parts = durations.map(fraction);
  let exact = null, lcm = 0;
  if (parts.every(Boolean)) {
    lcm = parts.reduce((l, [, q]) => l / gcd(l, q) * q, 1);
    if (Number.isSafeInteger(lcm)) {
      const counts = parts.map(([p, q]) => p * (lcm / q));
      const common = counts.reduce(gcd, 0) || 1;
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
