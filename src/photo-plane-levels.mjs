// SPDX-License-Identifier: MIT
import {fixedStrategyImage, strategyInputs, auditLevels} from './varblock-core.mjs';
import {perceptualMaskField} from './photo-mask.mjs';
import {scaledDCTBases, lowFrequencies} from './vardct-strategies.mjs';

const check = signal => { if (signal?.aborted) throw signal.reason; };
const unitWeight = base => new Float64Array(base.components[0].stride * base.components[0].rows).fill(1);
export const plainLayoutBlock = (base, b) =>
  ({id: 0, bx: b % base.components[0].stride, by: Math.floor(b / base.components[0].stride)});
export const plainLayout = base => {
  const {stride, rows} = base.components[0], held = base.devicePlanes;
  if (held && held.plainStride === stride && held.plainRows === rows) return held.plainLayout;
  const layout = Array.from({length: stride * rows}, (_, b) => ({id: 0, bx: b % stride, by: (b / stride) | 0}));
  if (held) { held.plainStride = stride; held.plainRows = rows; held.plainLayout = layout; }
  return layout;
};
const maskOf = base => base.maskWeight ?? (base.devicePlanes ? (base.devicePlanes.maskWeight ??= perceptualMaskField(base.planes, base.components[0].stride, base.components[0].rows,
  base.planeRows ? by => base.planeRows(by * 8, by * 8 + 8) : undefined).weight) : perceptualMaskField(base.planes, base.components[0].stride, base.components[0].rows,
  base.planeRows ? by => base.planeRows(by * 8, by * 8 + 8) : undefined).weight);

export function planeRequest(base, width, height, search) {
  const weight = search.maskWeight ?? (search.perceptual ? maskOf(base) : unitWeight(base));
  const out = {input: strategyInputs(base, width, height, search), search, ids: search.ids, weight, weightDoubt: 0,
    width, height, planeRows: base.planeRows, devicePlanes: base.devicePlanes, scaledDCTBases, lowFrequencies};
  return Object.defineProperty(out, 'planeBound', {get: () => base.planeBound, enumerable: true, configurable: true});
}
export function* planeLevelsSteps(base, width, height, layout, options, signal) {
  const search = {...options, maskWeight: options.maskWeight ?? unitWeight(base), ids: [...new Set([4, ...layout.map(b => b.id)])]}, request = planeRequest(base, width, height, search);
  const levels = yield {gpu: {kind: 'photo-block-levels', ...request, layout,
    audit: answer => auditLevels(base, width, height, options, layout, answer)}};
  check(signal);
  return levels?.exact ?? null;
}
export function* planeLayoutSteps(base, width, height, layout, options, signal) {
  const exact = yield* planeLevelsSteps(base, width, height, layout, options, signal);
  return fixedStrategyImage(base, width, height, {...options, layout, ...(exact ? {exact} : {})}).image;
}
