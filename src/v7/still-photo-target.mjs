// SPDX-License-Identifier: MIT
import {measuredLook, LAND_KEEP} from '../photo-quality-table.mjs';
import {part} from '../bits.mjs';
import {admitSampleFormat, statedSpace} from '../admit-samples.mjs';
import {screenLike} from '../screen.mjs';
import {smallPicture} from '../photo-v6-settings.mjs';
import {wholePhotoSteps, planGate, lowPlanPictureSteps} from '../photo-whole-search.mjs';
import {prepareV6} from '../photo-v6.mjs';
import {stillPhotoProvider} from '../photo-v6-provider.mjs';
import {plainLayout} from '../photo-plane-levels.mjs';
import {fixedStrategyImage} from '../varblock-core.mjs';
import {writeImageSteps} from '../photo-image-write.mjs';
import {deadzoneMapSteps} from '../deadzone-map.mjs';
import {wholeRebuildMeasure} from '../photo-whole-rebuild.mjs';
import {alphaRebuildMeasure} from '../photo-alpha-measure.mjs';
import {captureFillClear} from '../capture-kernels.mjs';
import {fail} from './primitives.mjs';
import {MEASURED_EFFORT} from '../effort-level.mjs';
import {textFloorEligible, textFloorCapture} from '../text-floor.mjs';
import {unit} from '../step-journal.mjs';
import {inspectPixels} from '../lossless.mjs';
import {lowPhotoSteps, lowPhotoRoute} from './low-photo.mjs';
import {seedLexer} from '../visual-lexer-plan.mjs';

export function stillPhotoTargetSteps(data, width, height, settings, {intent, signal, exact, selected, maxPixels, fit, preview, lexer, onLexerEvaluated, lowLook, lowPlan} = {}) {
  const low = settings.effort < MEASURED_EFFORT;
  if (intent === undefined || settings.lowIntent === undefined || (low && !(lexer && settings.effort >= 3)) || settings.quality >= 100 ||
      !(data instanceof Uint8Array || data instanceof Uint8ClampedArray) ||
      settings.orientation !== undefined || settings.extraChannels !== undefined) return null;
  const samples = admitSampleFormat(data, settings);
  const stated = statedSpace(samples);
  if (!samples.native8 && !stated || screenLike(data, width, height)) return null;
  if (stated) settings = {...settings, colorSpace: stated};
  if (low) {
    if ((settings.colorSpace ?? 'srgb') !== 'srgb' || settings.quality >= 95 || smallPicture(width, height) || !opaque(data) ||
      inspectPixels(data, width, height).palette || textFloorEligible(data, width, height, settings)) return null;
    const route = lowPhotoRoute(data, width, height, settings);
    if (!route) return null;
    const {plan, limit} = lowPlan ?? planGate(lexer, data, width, height, settings.quality, intent, settings.effort);
    return plan ? lowMeasuredSteps(data, width, height, settings, {signal, selected, intent, route, lowLook, limit}, plan) : null;
  }
  const options = {intent, signal, exact, selected, maxPixels, fit, preview, lexer, onLexerEvaluated};
  const ladder = settings.effort >= 7 && !fit && smallPicture(width, height);
  return ladder ? ladderSteps(data, width, height, settings, options) : measuredSteps(data, width, height, settings, options);
}

function* ladderSteps(data, width, height, settings, options) {
  const efforts = [];
  for (let effort = 6; effort <= settings.effort; effort++) efforts.push(effort);
  let best = null, bestFacts = null;
  for (const [i, effort] of efforts.entries()) {
    let facts = null;
    const bytes = yield* part(measuredSteps(data, width, height, {...settings, effort}, {...options, selected: f => { facts = f; }}), i, efforts.length);
    if (bytes && (!best || bytes.length < best.length)) { best = bytes; bestFacts = facts; }
  }
  if (bestFacts) options.selected?.(bestFacts);
  return best;
}

export const LOW_MEASURED_PIXELS = 400000;
const lowDesigns = quality => quality >= 90 ? ['standard:0', 'dcBuckets:wanted'] : ['standard:0'];
const opaque = data => { for (let at = 3; at < data.length; at += 4) if (data[at] !== 255) return false; return true; };

function* lowMeasuredSteps(data, width, height, settings, {signal, selected, intent, route, lowLook, limit}, plan) {
  let plainImage = null;
  const ordinary = function* () {
    const bytes = yield* part(lowPhotoSteps(data, width, height, {...settings, observe: image => { plainImage = image; }}, route), limit === undefined ? 0 : 1, 3);
    if (!bytes) throw fail('JXL_INTERNAL', 'still-photo-target:low-own');
    return bytes;
  };
  const answer = (bytes, look) => { if (bytes) selected?.({kept: 'lossy', measurements: Number.isFinite(look) ? [{metric: 'ssimulacra2', score: look, domain: 'encoder-reconstruction'}] : []}); return bytes; };
  let own = limit === undefined ? yield* ordinary() : null;
  if (own && !plainImage) return answer(own);
  const lifted = settings;
  const defer = limit === undefined;
  const made = yield* part(lowPlanSteps(data, width, height, lifted, {signal}, plan, true, defer), limit === undefined ? 1 : 0, 3);
  try {
    if (limit !== undefined && made && made.photo.length >= limit) return answer(made.photo);
    own ??= yield* ordinary();
    if (!made || !plainImage) return answer(own);
    const meter = wholeRebuildMeasure(data, width, height, {space: 'srgb'}, signal, undefined), want = {ssimulacra2: true, butteraugli: false};
    try {
      const score = function* (image, minScore) { const v = meter.measure(image, minScore === undefined ? want : {...want, minScore}); return (typeof v?.next === 'function' ? yield* v : v).ssimulacra2; };
      const ownLook = yield* score(plainImage);
      if (defer) {
        const bar = intent !== undefined ? Math.min(ownLook, measuredLook(intent) + LAND_KEEP) : ownLook;
        const planLook = yield* score(made.image, bar);
        if (planLook < bar) { globalThis.__RAPIER_JXL_LOW_MEASURED?.({own: own.length, plan: null, ownLook, planLook}); return answer(own, ownLook); }
        let photo = yield* made.write(), kept = planLook;
        if (photo && intent !== undefined) {
          const T = measuredLook(intent);
          if (planLook > T + 0.6) {
            const slope = Math.max(0.5, 0.9 + 0.02 * (lifted.quality - 70)), lowerQ = Math.round((lifted.quality - (planLook - (T + 0.3)) / slope) * 100) / 100;
            const again = yield* lowPlanSteps(data, width, height, {...lifted, quality: lowerQ}, {signal}, plan, true, true);
            try {
              const lowerLook = again ? yield* score(again.image) : -Infinity;
              if (again && lowerLook >= T + LAND_KEEP) { const smaller = yield* again.write(); if (smaller && smaller.length < photo.length) { photo = smaller; kept = lowerLook; } }
            } finally { again?.release?.(); }
          }
        }
        globalThis.__RAPIER_JXL_LOW_MEASURED?.({own: own.length, plan: photo?.length ?? null, ownLook, planLook: photo && photo.length < own.length ? kept : -Infinity});
        if (photo && photo.length < own.length) { lowLook?.(photo, kept); return answer(photo, kept); }
        return answer(own, ownLook);
      }
      const planLook = made.photo.length < own.length ? yield* score(made.image, ownLook) : -Infinity;
      globalThis.__RAPIER_JXL_LOW_MEASURED?.({own: own.length, plan: made.photo.length, ownLook, planLook});
      if (planLook >= ownLook) { lowLook?.(made.photo, planLook); return answer(made.photo, planLook); }
      return answer(own, ownLook);
    } finally { meter.destroy?.(); }
  } finally { made?.release?.(); }
}

function* lowPlanSteps(data, width, height, settings, {signal, selected}, plan, keep = false, defer = false) {
  const quality = settings.quality, prepared = prepareV6(data, width, height, {}, {}, {banded: true, upload: true});
  const banded = yield* lowPlanPictureSteps(prepared, plan, quality, signal);
  let image;
  if (banded) image = banded.image;
  else {
    const provider = stillPhotoProvider(prepared), {field, transforms, epfScale = 1.0} = plan;
    let base = provider.base(quality, {keepPlanes: true, ...(field && {fieldScale: field})});
    if (epfScale !== 1.0 && base.epf) base = {...base, epf: base.epf * epfScale};
    const options = {...(plan.providerBlocks || !plan.options ? provider.blockOptions() : {}), ...(plan.options ?? {}), ...(quality > 85 && {gentleChromaDz: true}), ...(transforms && {transforms})};
    image = fixedStrategyImage(base, width, height, {...options, layout: plainLayout(base)}).image;
  }
  signal?.throwIfAborted();
  yield 0.5;
  if (defer) return {image, release: () => banded?.release(), write: () => part(writeImageSteps(image, settings.effort, undefined, lowDesigns(quality)), 1, 2)};
  try {
    const photo = yield* part(writeImageSteps(image, settings.effort, undefined, lowDesigns(quality)), 1, 2);
    if (!photo) { if (keep) banded?.release(); return null; }
    if (keep) return {photo, image, release: () => banded?.release()};
    selected?.({kept: 'lossy', measurements: []});
    return photo;
  } finally { if (!keep) banded?.release(); }
}

function* measuredSteps(data, width, height, settings, {intent, signal, exact, selected, maxPixels, fit, preview, lexer, onLexerEvaluated}) {
  let photoFacts = null, exactFloor = null, fitted = null;
  const admission = {record(bytes, passed, measurements) { photoFacts = {bytes, passed, measurements}; }};
  const retainFloor = function* (bytes, effort) { if (!bytes) return exactFloor = yield* exact(effort); };
  let alpha = false;
  for (let at = 3; at < data.length; at += 4) if (data[at] !== 255) { alpha = true; break; }
  const pixels = alpha ? captureFillClear(data, width, height) : data;
  let floorGroup;
  const chooseFloorGroup = !(typeof __RAPIER_JXL_CAPTURE_PHOTO__ !== 'undefined' && __RAPIER_JXL_CAPTURE_PHOTO__ === true) &&
    !(typeof __RAPIER_JXL_UPLOAD__ !== 'undefined' && __RAPIER_JXL_UPLOAD__ === true) && lexer && !fit && !alpha &&
    settings.effort === MEASURED_EFFORT && intent !== undefined && width * height > LOW_MEASURED_PIXELS &&
    (settings.colorSpace ?? 'srgb') === 'srgb' ? () => {
      if (floorGroup === undefined) {
        floorGroup = textFloorEligible(data, width, height, settings) ? -1 :
          (lexer.seed ? lexer : seedLexer()).lfGroup(data, width, height, intent);
      }
      return floorGroup;
    } : undefined;
  const photo = yield* part(wholePhotoSteps(pixels, width, height, {
    quality: settings.quality, effort: settings.effort, colorSpace: settings.colorSpace,
    readingIntent: intent, firstEffort: MEASURED_EFFORT, retainFloor, signal, maxPixels, photoAdmission: admission, imageMeasure: alpha ? alphaRebuildMeasure : wholeRebuildMeasure, preview, alpha,
    deadzones: deadzoneMapSteps, chooseFloorGroup, ...(lexer && {lexer}), ...(onLexerEvaluated && {onLexerEvaluated}),
    ...((typeof __RAPIER_JXL_TEACH__ === 'undefined' || __RAPIER_JXL_TEACH__ === true) && typeof globalThis.__RAPIER_JXL_TEACH === 'function'
      && {onRecipes: (file, recipe) => globalThis.__RAPIER_JXL_TEACH({decision: 'recipe', effort: settings.effort, bytes: file.length, recipe})}),
    ...(fit && {fit: {...fit, found: found => { fitted = found; }}}),
  }), 0, 1);
  if (photo && photo === exactFloor) {
    if (photoFacts && (photoFacts.bytes !== photo || photoFacts.passed !== true || !Array.isArray(photoFacts.measurements) || photoFacts.measurements.length))
      throw fail('JXL_INTERNAL', 'still-photo-target:measure-1');
    selected?.({kept: 'pixels', measurements: [], ...(fitted && {fitted})});
    return photo;
  }
  if (!photo || photoFacts?.bytes !== photo || photoFacts.passed !== true || !Array.isArray(photoFacts.measurements))
    throw fail('JXL_INTERNAL', 'still-photo-target:measure-2');
  if (!photoFacts.measurements.length) throw fail('JXL_INTERNAL', 'still-photo-target:measure-3');
  if (!fit && (yield* unit('palette-floor', () => Boolean(inspectPixels(data, width, height).palette)))) {
    const exactFile = exactFloor ?? (yield* exact(5, photo.length + 1));
    if (exactFile instanceof Uint8Array && exactFile.length <= photo.length) { selected?.({kept: 'pixels', measurements: []}); return exactFile; }
  }
  const captured = !fit && (yield* unit('text-floor', () => textFloorEligible(data, width, height, settings))) ? yield* textFloorCapture(photo, data, width, height, settings.colorSpace) : null;
  if (captured) { selected?.({kept: 'pixels', measurements: []}); return captured; }
  selected?.({kept: 'lossy', measurements: photoFacts.measurements, ...(fitted && {fitted})});
  return photo;
}
