// SPDX-License-Identifier: MIT
import {spectralPasses, progressiveOrders} from './vardct-progressive.mjs';

let active = false, cachedProgression = null, cachedOrders = undefined;

export const progressiveActive = () => active;

export function spectralProgression() {
  return cachedProgression ||= spectralPasses();
}

export function spectralOrders() {
  if (cachedOrders === undefined) cachedOrders = progressiveOrders(spectralProgression());
  return cachedOrders;
}

export function applyProgressive(jpeg) {
  if (!active || !jpeg || jpeg.progression || jpeg.jpegReconstruction || jpeg.useDCFrame) return jpeg;
  const p = jpeg.placement;
  if (p && (p.isFirstFrame === false || p.isLastFrame === false || p.crop)) return jpeg;
  return {
    ...jpeg,
    progression: spectralProgression(),
    progressiveOrders: spectralOrders(),
  };
}

export function* withProgressive(enabled, steps) {
  if (!enabled) return yield* steps;
  let step, reply, failed = false;
  try {
    for (;;) {
      const prev = active;
      active = true;
      try { step = steps.next(reply); } finally { active = prev; }
      if (step.done) return step.value;
      reply = yield step.value;
    }
  } catch (error) {
    failed = true;
    const prev = active;
    active = true;
    try { if (typeof steps.throw === 'function') return steps.throw(error); } finally { active = prev; }
    throw error;
  } finally {
    if (!failed && !step?.done) {
      const prev = active;
      active = true;
      try { steps.return?.(); } finally { active = prev; }
    }
  }
}
