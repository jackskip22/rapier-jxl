// SPDX-License-Identifier: MIT
import {xybStrategies, auditCosts, strategyRowsLayout} from './varblocks.mjs';
import {unit} from './step-journal.mjs';
import {perceptualMaskField} from './photo-mask.mjs';
import {planeRequest, planeLayoutSteps} from './photo-plane-levels.mjs';
export {plainLayout, planeRequest, planeLevelsSteps, planeLayoutSteps} from './photo-plane-levels.mjs';
const check = signal => { if (signal?.aborted) throw signal.reason; };
const maskOf = base => base.maskWeight ?? (base.devicePlanes ? (base.devicePlanes.maskWeight ??= perceptualMaskField(base.planes, base.components[0].stride, base.components[0].rows,
  base.planeRows ? by => base.planeRows(by * 8, by * 8 + 8) : undefined).weight) : perceptualMaskField(base.planes, base.components[0].stride, base.components[0].rows,
  base.planeRows ? by => base.planeRows(by * 8, by * 8 + 8) : undefined).weight);

export function* planeSearchSteps(base, width, height, options, signal) {
  const search = {...options, maskWeight: options.maskWeight ?? maskOf(base)}, request = planeRequest(base, width, height, search);
  const priced = yield {gpu: {kind: 'photo-block-costs', ...request, audit: answer => auditCosts(base, width, height, search, answer)}};
  check(signal);
  if (priced?.costs?.certified) {
    const chosen = xybStrategies(base, width, height, {...search, costs: priced.costs, costDoubt: priced.weightDoubt || 0, chooseOnly: true});
    const layout = chosen.open.length ? xybStrategies(base, width, height, {...search, priceOnly: true, chooseOnly: true}).layout : chosen.layout;
    return {image: yield* planeLayoutSteps(base, width, height, layout, search, signal), layout};
  }
  return xybStrategies(base, width, height, {...search, priceOnly: true, keepChosen: true});
}
export function* planeSearchLayoutSteps(base, width, height, options, signal) {
  const search = {...options, maskWeight: options.maskWeight ?? maskOf(base)}, rows = base.components[0].rows, bands = [];
  for (let by = 0; by < rows; by += 32) {
    check(signal);
    bands.push(yield* unit('shape-band', () => xybStrategies(base, width, height, {...search, priceOnly: true, chooseOnly: true, regionRows: [by, by + 32]})));
  }
  return strategyRowsLayout(bands);
}
