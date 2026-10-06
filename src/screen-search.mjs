// SPDX-License-Identifier: MIT
// A conservative effort-only route: textured pictures and pictures outside the
// core's existing palette bound keep exactly their old search. No extra image
// scan or allocation on a rejected photograph or painting.
import {screenLike, screenPlan, screenFrameSteps} from './screen.mjs';
import {screenLZ77} from './screen-lz77.mjs';
import {patchSteps} from './screen-patches.mjs';
export const screenEligible = (rgba, width, height, shape) => !!shape.palette && screenLike(rgba, width, height);

export function* screenSteps(rgba, width, height, shape, colorSpace, {fastFloor = 0} = {}) {
  let best = null;
  // Measured byte gains first: a short budget can keep a completed LZ77 or
  // glyph stream before spending time on smaller palette-only differences.
  const modes = ['global-lz', 'patch-lz', 'scalar-lz', 'global', 'scalar'];
  for (let i = 0; i < modes.length; i++) {
    if (yield (i + 0.01) / modes.length) return best;
    let steps;
    if (modes[i] === 'patch-lz') steps = patchSteps(rgba, width, height, shape, colorSpace, {tokenCodec: screenLZ77});
    else {
      const plan = screenPlan(rgba, width, height, shape, modes[i].replace('-lz', ''));
      if (!plan) continue;
      steps = screenFrameSteps(rgba, width, height, shape, colorSpace, plan, {
        tokenCodec: modes[i].endsWith('-lz') ? screenLZ77 : null
      });
    }
    let step, hurry;
    while (!(step = steps.next(hurry)).done) hurry = yield (i + 0.01 + 0.99 * step.value) / modes.length;
    if (step.value && (!best || step.value.length < best.length)) best = step.value;
    if (hurry) return best;
    // After pricing both high-value tools, effort 3 can stop on a substantial
    // actual-byte win. Higher efforts still exhaust all candidates.
    if (i === 1 && fastFloor && best && best.length * 4 <= fastFloor * 3) return best;
  }
  return best;
}
