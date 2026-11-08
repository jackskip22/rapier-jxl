// Rapier's JPEG XL encoder: the self-correcting (weighted) predictor. MIT (images/jxl/LICENSE).
import {kernelHooks} from './kernel-hooks.mjs';
import {fault} from './fault.mjs';

import {WEIGHTED_PREDICTOR, WEIGHTED_PROPERTY, WEIGHTED_CUTS} from './weighted-policy.mjs';
export {WEIGHTED_PREDICTOR, WEIGHTED_PROPERTY, WEIGHTED_CUTS};
const SINGLE = new Int32Array(WEIGHTED_CUTS.length + 1);

export function codeWeighted(w, targets, plane, width, height, offset = 0, contextOf = SINGLE, residuals, properties) {
  if (!kernelHooks.weighted) kernelHooks.ensure?.();
  if (!kernelHooks.weighted) throw fault('JXL_WASM', 'The weighted predictor is unavailable: an encoder needs WebAssembly with SIMD.');
  if (!kernelHooks.weighted(w, targets, plane, width, height, offset, contextOf, residuals, properties))
    throw fault('JXL_INTERNAL', 'The weighted predictor was given a plane it does not code.');
}
