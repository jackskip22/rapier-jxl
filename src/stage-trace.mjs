// SPDX-License-Identifier: MIT
const BUILT = typeof __RAPIER_JXL_STAGES__ !== 'undefined' && __RAPIER_JXL_STAGES__ === true;
const stages = () => {
  if (!BUILT) return null;
  try { const t = globalThis.__RAPIER_JXL_STAGES; return t && typeof t === 'object' ? t : null; } catch { return null; }
};
export const tracing = () => stages() !== null;
export function traced(name, ms) {
  const t = stages();
  if (!t) return;
  const e = t[name] ??= {n: 0, ms: 0};
  e.n++; e.ms += ms;
}
export function timed(name, run) {
  if (!tracing()) return run();
  const t0 = performance.now();
  try { return run(); } finally { traced(name, performance.now() - t0); }
}
export function* timedSteps(name, steps) {
  if (!tracing()) return yield* steps;
  const t0 = performance.now();
  try { return yield* steps; } finally { traced(name, performance.now() - t0); }
}
