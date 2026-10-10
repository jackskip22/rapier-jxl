// SPDX-License-Identifier: MIT
// Screen admission uses bounded sampling. Higher efforts also admit gradients and antialiased text.
import {screenLike, screenPlan, screenFrameSteps} from './screen.mjs';
import {screenLZ77} from './screen-lz77.mjs';
import {patchSteps} from './screen-patches.mjs';
import {scaled} from './bits.mjs';
import {paletteSteps} from './palette-search.mjs';
import {localScreenSteps} from './screen-local.mjs';
export function screenEligible(rgba, width, height, shape, effort = 3) {
  // A bounded full-colour palette already identifies an exact screen representation.
  // Similar neighbouring colours do not make its repeated indices photographic noise.
  if (effort >= 5 && shape.palette) return true;
  if (effort >= 8 && screenPlan(rgba, width, height, shape, 'global')) return true;
  if ((shape.palette || effort >= 5) && screenLike(rgba, width, height)) return true;
  if (effort < 5 || width < 32 || height < 32) return false;
  let flat = 0, soft = 0;
  for (let s = 0; s < 256; s++) {
    let p = Math.floor((s + 0.5) * width * height / 256);
    if (p % width === width - 1) p--;
    const i = p * 4, delta = Math.abs(rgba[i] - rgba[i + 4]) + Math.abs(rgba[i + 1] - rgba[i + 5]) +
      Math.abs(rgba[i + 2] - rgba[i + 6]) + Math.abs(rgba[i + 3] - rgba[i + 7]);
    if (!delta) flat++; else if (delta <= 32) soft++;
    if (flat + 255 - s < 112) return false;
  }
  return flat >= 112 && soft * 3 <= 256 - flat;
}

export function* screenSteps(rgba, width, height, shape, colorSpace, {fastFloor = 0, effort = 3, pooled = false} = {}) {
  let best = null, bestMode, deepen;
  // A palette depends on the pixels and ordering alone. Its plain, LZ77 and deeper models share the same
  // immutable plan, including a failed palette admission, while retaining their own complete-stream choices.
  const plans = new Map();
  // Try LZ77 and glyph models first so hurry can retain their completed streams.
  const modes = ['global-lz', 'patch-lz', 'scalar-lz', 'global', 'scalar'];
  if (effort >= 5) modes.push('global-deep', 'frequency-deep', 'patch-deep', 'scalar-deep', 'direct-deep');
  if (effort >= 8) modes.push('palette');
  if (effort === 9) modes.push('global-deeper', 'frequency-deeper');
  if (effort >= 8) modes.push('local-copy');
  if (effort === 9) modes.push('local-fine', 'local-deeper');
  for (let i = 0; i < modes.length; i++) {
    if (yield (i + 0.01) / modes.length) return best;
    const deeper = modes[i].endsWith('-deeper') && !modes[i].startsWith('local-');
    if (deeper) {
      // Small palettes can still improve after a learned palette win. Richer palettes only retry when the
      // shallow copied indices remain best. Latch before the pair so either ordering can improve the floor.
      deepen ??= plans.get('global')?.meta[0].width <= 64 || bestMode === 'global-deep' || bestMode === 'frequency-deep';
      if (!deepen) continue;
    }
    let steps;
    if (modes[i].startsWith('local-')) steps = localScreenSteps(rgba, width, height, shape, colorSpace,
      {dim: modes[i] === 'local-fine' ? 512 : 1024, depths: modes[i] === 'local-copy' ? [64] : [64, 256], ceiling: best?.length ?? Infinity});
    else if (modes[i] === 'patch-lz') steps = patchSteps(rgba, width, height, shape, colorSpace, {tokenCodec: screenLZ77, pooled});
    else if (modes[i] === 'patch-deep') steps = patchSteps(rgba, width, height, shape, colorSpace, {search: {}, limit: best?.length ?? Infinity, pooled});
    else if (modes[i] === 'palette') steps = paletteSteps(rgba, width, height, shape, colorSpace,
      {plan: plans.get('global'), pooled, ceiling: best?.length ?? Infinity});
    else {
      const mode = modes[i].replace(/-(lz|deep|deeper)$/, '');
      if (!plans.has(mode)) plans.set(mode, screenPlan(rgba, width, height, shape, mode));
      const plan = plans.get(mode);
      if (!plan) continue;
      steps = screenFrameSteps(rgba, width, height, shape, colorSpace, plan, {
        tokenCodec: modes[i].endsWith('-lz') ? screenLZ77 : null,
        search: deeper ? {depth: 64} : modes[i].endsWith('-deep') ? {} : null, pooled
      });
    }
    let step, reply, hurry = false;
    while (!(step = steps.next(reply)).done) {
      reply = yield scaled(step.value, done => (i + 0.01 + 0.99 * done) / modes.length);
      hurry = reply === null || (typeof reply === 'object' ? reply.hurried : reply);
    }
    if (step.value && (!best || step.value.length < best.length)) { best = step.value; bestMode = modes[i]; }
    if (hurry) return best;
    // After pricing both high-value tools, effort 3 can stop on a substantial
    // actual-byte win. Higher efforts still exhaust all candidates.
    if (i === 1 && fastFloor && best && best.length * 4 <= fastFloor * 3) return best;
  }
  return best;
}
