// SPDX-License-Identifier: MIT
import {BitWriter, scaled} from './bits.mjs';
import {fault, guard} from './admit.mjs';
import {checkSignal} from './async-job.mjs';
import {admitAnimation, animationSteps, partSteps} from './animation-frames.mjs';
import {losslessSteps, inspectPixels, shapeFloors} from './lossless.mjs';
import {writeImageHeader} from './frame.mjs';
import {readStill, readFrames, metadataKey, writeStillFrame} from './framing.mjs';
import {authoredPatchEntropy, authoredPatchFrame} from './patch-code.mjs';
import {atlasSearchOptions, discoverAtlasSteps, validateAtlasPlan, atlasCropPlan, buildAnimationAtlas} from './atlas-plan.mjs';

export {buildAnimationAtlas};

function* span(steps, start, length) {
  let step, reply;
  while (!(step = steps.next(reply)).done) reply = yield scaled(step.value, fraction => start + length * fraction);
  return step.value;
}

function sharedAtlas(plan, forced) {
  let reference = null, used = false;
  const rejectSlot = still => {
    if (still.frames.some(frame => frame.reference === 3)) throw fault('JXL_FRAMING', 'Reference slot 3 is already in use.');
  };
  return {
    *partSteps(coder, crop, width, height, job) {
      const baseline = yield* span(partSteps(coder, crop, width, height), 0, .4), ordinary = readStill(baseline);
      rejectSlot(ordinary);
      if (coder.mode !== 'modular') { yield 1; return baseline; }
      const patch = atlasCropPlan(plan, crop, width, height, job, coder.floor.alpha);
      if (!patch) { yield 1; return baseline; }
      const shape = {...coder.floor, channels: coder.floor.colour + Number(coder.floor.alpha)}, options = {shape, colorSpace: coder.colorSpace, effort: coder.effort};
      const dictionary = yield* span(authoredPatchEntropy(patch), .4, .05);
      const frame = yield* span(authoredPatchFrame(patch.body, width, height, options, {dictionary}), .45, .35);
      const header = new BitWriter(128);
      writeImageHeader(header, width, height, shape.colour, shape.alpha, {colorSpace: coder.colorSpace});
      header.append({bytes: frame, at: frame.length, pending: 0, acc: 0});
      const candidate = header.finish(), still = readStill(candidate);
      if (metadataKey(still) !== metadataKey(ordinary)) throw fault('JXL_FRAMING', 'The shared atlas requires the animation\'s exact color and channel metadata.');
      if (!forced && candidate.length >= baseline.length) { yield 1; return baseline; }
      if (!reference) {
        const pixels = new Uint8Array(plan.atlas.data);
        for (let i = 0; i < pixels.length; i += 4) {
          if (shape.colour === 1) pixels[i + 1] = pixels[i + 2] = pixels[i];
          if (!shape.alpha) pixels[i + 3] = 255;
        }
        let atlasShape;
        shapeFloors.set(pixels, coder.floor);
        try { atlasShape = inspectPixels(pixels, plan.atlas.width, plan.atlas.height); }
        finally { shapeFloors.delete(pixels); }
        const bytes = yield* span(losslessSteps(pixels, plan.atlas.width, plan.atlas.height,
          {shape: atlasShape, colorSpace: coder.colorSpace}), .8, .2);
        reference = readStill(bytes); rejectSlot(reference);
        if (reference.frames.length !== 1 || metadataKey(reference) !== metadataKey(ordinary))
          throw fault('JXL_FRAMING', 'The shared atlas must have one compatible Modular reference frame.');
      }
      used = true; yield 1; return candidate;
    },
    writeReferences(writer, canvas, key) {
      if (!used) return;
      if (!reference || metadataKey(reference) !== key) throw fault('JXL_FRAMING', 'The atlas and animation metadata differ.');
      writeStillFrame(writer, reference, reference.frames[0], {canvas, frameType: 2, reference: 3, beforeColorTransform: true});
    },
    get used() { return used; }
  };
}

function* atlasAnimationSteps(animation, search, mode, supplied) {
  const baseline = yield* span(animationSteps(animation), 0, mode === 'off' ? 1 : .45);
  if (mode === 'off') return baseline;
  if ((yield .45) && mode !== 'force') { yield 1; return baseline; }
  if (!animation.samples.native8 || animation.quality !== 100) {
    if (mode === 'force') throw fault('JXL_INPUT', 'A forced shared atlas uses exact straight RGBA8 animation.');
    yield 1; return baseline;
  }
  const original = readFrames(baseline);
  if (original.frames.some(frame => frame.reference === 3)) throw fault('JXL_FRAMING', 'Reference slot 3 is already in use.');
  let plan = supplied;
  if (!plan) {
    const discovered = yield* span(discoverAtlasSteps(animation, search), .45, .1);
    if (discovered) plan = validateAtlasPlan(animation, discovered);
  }
  if ((yield .55) && mode !== 'force') { yield 1; return baseline; }
  if (!plan) {
    if (mode === 'force') throw fault('JXL_INPUT', 'No repeated atlas rectangles meet the search bounds.');
    yield 1; return baseline;
  }
  const shared = sharedAtlas(plan, mode === 'force');
  let candidate;
  try { candidate = yield* span(animationSteps(animation, false, shared), .55, .45); }
  catch (error) { if (mode === 'force' || error.code !== 'JXL_SIZE') throw error; }
  if (mode === 'force' && !shared.used) throw fault('JXL_INPUT', 'No atlas placement fits a displayed animation rectangle.');
  yield 1;
  return candidate && shared.used && (mode === 'force' || candidate.length < baseline.length) ? candidate : baseline;
}

export function encodeAnimationAtlas(animation, options) {
  const steps = encodeAnimationAtlasSteps(animation, options), progress = options?.progress;
  for (const fraction of steps) if (progress && fraction < 1) progress(fraction);
  progress?.(1); return steps.bytes;
}

export function encodeAnimationAtlasSteps(animation, options = {}) {
  const admitted = admitAnimation(animation, options), mode = options.atlasMode ?? 'auto', search = atlasSearchOptions(options.atlasSearch);
  if (!['auto', 'force', 'off'].includes(mode)) throw fault('JXL_INPUT', 'atlasMode is auto, force or off.');
  if (options.progress !== undefined && typeof options.progress !== 'function') throw fault('JXL_INPUT', 'progress is a function.');
  if (mode === 'force' && (!admitted.samples.native8 || admitted.quality !== 100))
    throw fault('JXL_INPUT', 'A forced shared atlas uses exact straight RGBA8 animation.');
  const supplied = options.atlas === undefined ? null : validateAtlasPlan(admitted, options.atlas);
  const iterator = (function* () {
    const steps = atlasAnimationSteps(admitted, search, mode, supplied);
    let step, last = 0;
    while (!(step = guard(() => steps.next(iterator.hurry))).done) {
      checkSignal(admitted.signal); last = step.value; yield last;
    }
    if (last < 1) yield 1;
    return iterator.bytes = step.value;
  })();
  iterator.bytes = null; iterator.hurry = false; return iterator;
}
