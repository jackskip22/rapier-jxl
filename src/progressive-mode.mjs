// SPDX-License-Identifier: MIT
import {spectralPasses, lfSplitPasses} from './vardct-progressive.mjs';

let requested = null, cachedProgression = null, cachedLfSplit = null;

export const progressiveRequested = () => !!requested;
export const progressiveWritten = () => requested;
export const lfSplitProgression = () => cachedLfSplit ||= lfSplitPasses();

export function progressiveImage(jpeg) {
  if (!jpeg || jpeg.progression || jpeg.jpegReconstruction || jpeg.useDCFrame) return jpeg;
  const p = jpeg.placement;
  if (p && (p.isFirstFrame === false || p.isLastFrame === false || p.crop)) return jpeg;
  return {...jpeg, progression: (cachedProgression ||= spectralPasses()), progressiveOrders: true};
}

export function* progressiveSearch(steps, written) {
  let step, reply, failed = false;
  const run = fn => { const prev = requested; requested = written; try { return fn(); } finally { requested = prev; } };
  try {
    for (;;) {
      step = run(() => steps.next(reply));
      if (step.done) return step.value;
      reply = yield step.value;
    }
  } catch (error) {
    failed = true;
    if (typeof steps.throw === 'function') return run(() => steps.throw(error));
    throw error;
  } finally {
    if (!failed && !step?.done) run(() => steps.return?.());
  }
}
