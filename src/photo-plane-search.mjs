// SPDX-License-Identifier: MIT
import {xybStrategies, auditCosts, strategyRowsLayout} from './varblocks.mjs';
import {unit} from './step-journal.mjs';
import {perceptualMaskField} from './photo-mask.mjs';
import {trialDue, tryStage, leftDevice} from './device-trial.mjs';
import {traced, tracing} from './stage-trace.mjs';
import {planeRequest, planeMessage, planeLayoutSteps} from './photo-plane-levels.mjs';
export {plainLayout, planeRequest, planeLevelsSteps, planeLayoutSteps} from './photo-plane-levels.mjs';
const check = signal => { if (signal?.aborted) throw signal.reason; };
const maskOf = base => base.maskWeight ?? (base.devicePlanes ? (base.devicePlanes.maskWeight ??= perceptualMaskField(base.planes, base.components[0].stride, base.components[0].rows,
  base.planeRows ? by => base.planeRows(by * 8, by * 8 + 8) : undefined).weight) : perceptualMaskField(base.planes, base.components[0].stride, base.components[0].rows,
  base.planeRows ? by => base.planeRows(by * 8, by * 8 + 8) : undefined).weight);

export function* planeSearchSteps(base, width, height, options, signal, layoutOnly = false) {
  if (leftDevice('photo-block-costs', width * height))
    return layoutOnly ? {layout: yield* planeSearchLayoutSteps(base, width, height, options, signal)} : xybStrategies(base, width, height, {...options, maskWeight: options.maskWeight ?? maskOf(base), priceOnly: true, keepChosen: true});
  const search = {...options, maskWeight: options.maskWeight ?? maskOf(base)}, request = planeRequest(base, width, height, search);
  const ask = {gpu: planeMessage(request, {kind: 'photo-block-costs', audit: answer => auditCosts(base, width, height, search, answer)})};
  if (trialDue('photo-block-costs', width * height)) {
    const searched = yield* tryStage('photo-block-costs', width * height, ask, function* () {
      return layoutOnly ? {layout: yield* planeSearchLayoutSteps(base, width, height, options, signal)}
        : xybStrategies(base, width, height, {...search, priceOnly: true, keepChosen: true});
    }, {estimate: () => costsSlice(base, width, height, search), keep: priced => fromPriced(priced)});
    check(signal);
    return searched;
  }
  return yield* fromPriced(yield ask);
  function* fromPriced(priced) {
    check(signal);
    if (priced?.costs?.certified) {
      const chosen = xybStrategies(base, width, height, {...search, costs: priced.costs, costDoubt: priced.weightDoubt || 0, chooseOnly: true});
      if (layoutOnly) return {layout: chosen.open.length ? yield* planeSearchLayoutSteps(base, width, height, options, signal) : chosen.layout};
      const layout = chosen.open.length ? xybStrategies(base, width, height, {...search, priceOnly: true, chooseOnly: true}).layout : chosen.layout;
      return {image: yield* planeLayoutSteps(base, width, height, layout, search, signal), layout};
    }
    if (layoutOnly) return {layout: yield* planeSearchLayoutSteps(base, width, height, options, signal)};
    return xybStrategies(base, width, height, {...search, priceOnly: true, keepChosen: true});
  }
}
function costsSlice(base, width, height, search) {
  const rows = base.components[0].rows;
  if (rows < 64) return null;
  const t0 = performance.now();
  let ms = 0;
  for (let by = 0; by < 16; by += 8) {
    const t = performance.now();
    xybStrategies(base, width, height, {...search, priceOnly: true, chooseOnly: true, regionRows: [by, by + 8]});
    ms = (performance.now() - t) * rows / 8;
  }
  if (tracing()) traced('trial:photo-block-costs:slice', performance.now() - t0);
  return ms;
}
export function* planeSearchLayoutSteps(base, width, height, options, signal) {
  const search = {...options, maskWeight: options.maskWeight ?? maskOf(base)}, rows = base.components[0].rows, bands = [];
  for (let by = 0; by < rows; by += 32) {
    check(signal);
    bands.push(yield* unit('shape-band', () => xybStrategies(base, width, height, {...search, priceOnly: true, chooseOnly: true, regionRows: [by, by + 32]})));
  }
  return strategyRowsLayout(bands);
}
