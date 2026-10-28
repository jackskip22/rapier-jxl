// SPDX-License-Identifier: MIT
import {screenLike, screenPlan, screenFrameSteps} from './screen.mjs';
import {screenLZ77} from './screen-lz77.mjs';
import {patchSteps} from './screen-patches.mjs';
import {scaled} from './bits.mjs';
import {paletteSteps} from './palette-search.mjs';
import {localScreenSteps} from './screen-local.mjs';
export function screenEligible(rgba, width, height, shape, effort = 3) {
  if (shape.palette) return true;
  if (effort >= 8 && screenPlan(rgba, width, height, shape, 'global')) return true;
  if (effort >= 5 && screenLike(rgba, width, height)) return true;
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

export function* screenSteps(rgba, width, height, shape, colorSpace, {fastFloor = 0, effort = 3} = {}) {
  let best = null;
  for (const [pass, minLength] of [7, 4].entries()) {
    const steps = screenPass(rgba, width, height, shape, colorSpace, {fastFloor, effort, minLength});
    let step, reply, hurried = false;
    while (!(step = steps.next(reply)).done) {
      reply = yield scaled(step.value, done => (pass + done) / 2);
      hurried = reply === null || (typeof reply === 'object' ? reply.hurried : reply);
    }
    if (step.value && (!best || step.value.length < best.length)) best = step.value;
    if (hurried) break;
  }
  return best;
}

function* screenPass(rgba, width, height, shape, colorSpace, {fastFloor, effort, minLength}) {
  let best = null, bestMode, deepen;
  const plans = new Map();
  const modes = ['global-lz', 'patch-lz', 'scalar-lz', 'global', 'scalar'];
  if (effort >= 5) modes.push('global-deep', 'frequency-deep', 'patch-deep', 'scalar-deep', 'direct-deep');
  if (effort >= 8) modes.push('palette');
  if (effort === 9) modes.push('global-deeper', 'frequency-deeper');
  if (effort >= 8) modes.push('local-copy');
  if (effort === 9) modes.push('local-fine', 'local-deeper');
  for (let i = 0; i < modes.length; i++) {
    if (yield (i + 0.01) / modes.length) return best;
    if (minLength === 4 && ['global', 'scalar', 'palette'].includes(modes[i])) continue;
    const deeper = modes[i].endsWith('-deeper') && !modes[i].startsWith('local-');
    if (deeper) {
      deepen ??= plans.get('global')?.meta[0].width <= 64 || bestMode === 'global-deep' || bestMode === 'frequency-deep';
      if (!deepen) continue;
    }
    let steps;
    if (modes[i].startsWith('local-')) steps = localScreenSteps(rgba, width, height, shape, colorSpace,
      {dim: modes[i] === 'local-fine' ? 512 : 1024, depths: modes[i] === 'local-copy' ? [64] : [64, 256], ceiling: best?.length ?? Infinity, minLength});
    else if (modes[i] === 'patch-lz') steps = patchSteps(rgba, width, height, shape, colorSpace, {tokenCodec: screenLZ77, minLength});
    else if (modes[i] === 'patch-deep') steps = patchSteps(rgba, width, height, shape, colorSpace, {search: {}, limit: best?.length ?? Infinity, minLength});
    else if (modes[i] === 'palette') steps = paletteSteps(rgba, width, height, shape, colorSpace,
      {plan: plans.get('global'), ceiling: best?.length ?? Infinity});
    else {
      const mode = modes[i].replace(/-(lz|deep|deeper)$/, '');
      if (!plans.has(mode)) plans.set(mode, screenPlan(rgba, width, height, shape, mode));
      const plan = plans.get(mode);
      if (!plan) continue;
      steps = screenFrameSteps(rgba, width, height, shape, colorSpace, plan, {
        tokenCodec: modes[i].endsWith('-lz') ? screenLZ77 : null,
        search: deeper ? {depth: 64} : modes[i].endsWith('-deep') ? {} : null, minLength
      });
    }
    let step, reply, hurry = false;
    while (!(step = steps.next(reply)).done) {
      reply = yield scaled(step.value, done => (i + 0.01 + 0.99 * done) / modes.length);
      hurry = reply === null || (typeof reply === 'object' ? reply.hurried : reply);
    }
    if (step.value && (!best || step.value.length < best.length)) { best = step.value; bestMode = modes[i]; }
    if (hurry) return best;
    if (i === 1 && fastFloor && best && best.length * 4 <= fastFloor * 3) return best;
  }
  return best;
}
