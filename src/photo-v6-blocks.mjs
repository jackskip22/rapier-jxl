// SPDX-License-Identifier: MIT
import {complete, scaled} from './bits.mjs';
import {transformDCT8, dct8Basis} from './photo-dct.mjs';
import {photoXYBSteps, XYB_TABLES} from './photo-xyb.mjs';
import {photoXYBBands, photoXYBBand, appendPhotoBand, PHOTO_BAND_MARGIN} from './photo-bands.mjs';
import {xybStrategies, encodeStrategyImageSteps, strategyInputs, auditCosts} from './varblocks.mjs';
import {scaledDCTBases, lowFrequencies} from './vardct-strategies.mjs';
import {coefficientAnsSteps, estimateBytes, strategyLfSteps} from './coefficient-ans.mjs';
import {perceptualMaskField, maskEnergy, maskWeights, maskWeightDoubts, maskDoubtMax} from './aq.mjs';
import {offloading} from './offload.mjs';
import {V6, GABORISH, admitV6Memory, prepareV6, v6Image, gaborishRows, blockSearchOptions, v6Trace} from './photo-v6.mjs';

export function photoAnsSteps(image, effort, ...rest) { return coefficientAnsSteps(image, effort, ...rest); }
photoAnsSteps.splits = coefficientAnsSteps.splits;

function* bandsWithEnergy(data, width, height, quality, options, energy) {
  const bandHeight = Math.max(64, Math.floor(1048576 / width / 64) * 64), stride = Math.ceil(width / 8);
  let image;
  for (let y = 0; y < height; y += bandHeight) {
    const h = Math.min(bandHeight, height - y), from = Math.max(0, y - PHOTO_BAND_MARGIN), to = Math.min(height, y + h + PHOTO_BAND_MARGIN);
    const result = photoXYBBand(data.subarray(from * width * 4, to * width * 4), width, h, quality, {...options, keepPlanes: true}, y - from);
    maskEnergy(result.planes, y, stride, y / 8, Math.ceil((y + h) / 8), energy);
    image = appendPhotoBand(image, result, width, height, y, data);
    image.planes = undefined;
    yield (y + h) / height;
  }
  return image;
}

function* bandsOnly(bands) {
  let step, reply;
  while (!(step = bands.next(reply)).done) {
    reply = undefined;
    if (step.value?.offload === 'image') continue;
    reply = yield step.value;
  }
  return step.value;
}

export function* fullBlocksOnDevice({base, data, width, height, row, blockSearch, mask, own, whileLevels, label = ''}) {
  const request = {data, width, height, options: {...V6, ...GABORISH, ...row}, input: strategyInputs(base, width, height, blockSearch), search: blockSearch, ids: blockSearch.ids, scaledDCTBases, lowFrequencies,
    lib: {complete, photoXYBSteps, transformDCT8, dct8Basis, xyb: XYB_TABLES}};
  v6Trace(label + ' inputs and mask');
  let priced = yield {gpu: {kind: 'blocks', ...request, ...mask}};
  v6Trace(label + ' GPU costs');
  if (priced?.costs && !(auditCosts(base, width, height, blockSearch, priced) <= 1)) { yield {gpu: {kind: 'audit-failed'}}; priced = null; }
  v6Trace(label + ' audit');
  let choice = priced?.costs ? xybStrategies(base, width, height, {...blockSearch, costs: priced.costs, maskWeight: priced.weight, costDoubt: priced.weightDoubt, priceOnly: true, chooseOnly: true}) : null;
  v6Trace(`${label} choice (open ${choice?.open.length ?? '-'}, repriced ${choice?.reprices.length ?? '-'}, settled ${choice?.settled ?? '-'}, mask doubt ${maskDoubtMax(priced?.weightDoubt ?? 0).toExponential(1)})`);
  if (choice?.open.length && maskDoubtMax(priced.weightDoubt)) choice = xybStrategies(base, width, height, {...blockSearch, costs: priced.costs, maskWeight: own(), priceOnly: true, chooseOnly: true});
  if (!choice || choice.open.length) return null;
  v6Trace(label + ' audit and choice');
  const asked = yield {gpu: {kind: 'blocks-levels', ...request, layout: choice.layout}, later: true};
  whileLevels?.();
  const made = asked && typeof asked.then === 'function' ? yield {await: asked} : asked;
  v6Trace(label + ' GPU levels');
  return xybStrategies(base, width, height, {...blockSearch, layout: choice.layout, ...(made?.exact ? {exact: made.exact} : {})}).image;
}

function* blockPictureSteps({data, width, height, quality, effort, encodeCoefficients, color, gpu, memory, screen, floored, blockDesign, deferred, both}) {
  const plan = admitV6Memory(data, width, height, memory);
  let hurried = false;
  function* watch(steps, index, count) {
    let step, reply, completed = false;
    try {
      while (!(step = steps.next(reply)).done) {
        const v = step.value;
        reply = yield scaled(v, done => (index + done) / count);
        if (typeof v === 'number' ? reply : !v?.gpu && (reply === null || reply?.hurried)) hurried = true;
      }
      completed = true;
      return step.value;
    } finally {
      try { steps.return?.(); } catch (error) { if (completed) throw error; }
    }
  }
  const whole = !plan.banded && !offloading();
  let prepared = null;
  const fast = blockDesign === 'fast', row = {calibrationRow: screen ? 'screenFull' : fast ? 'blocksFast' : 'blocks', ...(fast && floored ? {noLevels: true} : {})}, rowColor = {...color, ...row};
  const idle = whole ? () => { try { prepared = prepareV6(data, width, height, color, memory); } catch {} } : undefined;
  let image = gpu && !color && !screen ? yield {gpu: {kind: 'v6image', data, width, height, quality, options: {...V6, ...GABORISH, ...row}, idle, ...(fast || blockDesign === 'full' ? {energy: true} : {}), lib: {complete, photoXYBSteps, transformDCT8, dct8Basis, xyb: XYB_TABLES}}} : null;
  let deviceEnergy = null;
  if (image?.maskEnergy !== undefined) { deviceEnergy = image.maskEnergy; delete image.maskEnergy; }
  v6Trace(effort + ' DCT8 picture');
  if (whole) prepared ??= prepareV6(data, width, height, color, memory);
  let kept = !image && whole ? v6Image(prepared, quality, {keepPlanes: true, ...row}, false) : null;
  if (kept) { const {planes: _planes, ...picture} = kept; image = picture; }
  const stride = Math.ceil(width / 8), rows = Math.ceil(height / 8), energy = !image && !whole && !offloading() ? new Float64Array(stride * rows) : null;
  image ||= whole ? v6Image(prepared, quality, row, false)
    : energy ? yield* watch(bandsWithEnergy(data, width, height, quality, {...V6, ...GABORISH, ...rowColor}, energy), 0, 4)
    : yield* watch(bandsOnly(photoXYBBands(data, width, height, quality, {...V6, ...GABORISH, ...rowColor}, offloading() ? rowColor : undefined)), 0, 4);
  if (hurried) return floored ? null : yield* watch(encodeCoefficients(image, effort), 1, 4);
  const blockSearch = fast ? {...blockSearchOptions(data, width, height), ids: [4]} : blockSearchOptions(data, width, height);
  let base = kept ?? (prepared ? {...image, planes: prepared.pre} : {...image, planeRows: gaborishRows(data, width, height, {...V6, ...GABORISH, ...color})});
  const denseRows = base.planeRows;
  if (denseRows && gpu && !color && !screen && blockDesign) base.planeRows = gaborishRows(data, width, height, {...V6, ...GABORISH, ...color}, true);
  kept = null; prepared = null;
  let varImage = null, dct8Estimate = null;
  if (fast && gpu && !color && !screen) {
    const input = strategyInputs(base, width, height, blockSearch), weight = base.planes ? perceptualMaskField(base.planes, stride, rows).weight : null;
    const fromEnergy = !weight && deviceEnergy ? {weight: maskWeights(deviceEnergy.hf, stride, rows).weight, weightDoubt: 0.75 * deviceEnergy.bound + 1e-12} : null;
    const source = {data, width, height, options: {...V6, ...GABORISH, ...row}, ...(weight ? {weight} : fromEnergy ?? {maskWeights}),
      lib: {complete, photoXYBSteps, transformDCT8, dct8Basis, xyb: XYB_TABLES}};
    v6Trace(effort + ' inputs');
    let priced = yield {gpu: {kind: 'blocks16', ...source, input, search: blockSearch, scaledDCTBases, lowFrequencies}};
    v6Trace(effort + ' GPU costs');
    if (priced?.costs && !(auditCosts(base, width, height, blockSearch, priced) <= 1)) { yield {gpu: {kind: 'audit-failed'}}; priced = null; }
    let choice = priced?.costs ? xybStrategies(base, width, height, {...blockSearch, costs: priced.costs, maskWeight: priced.weight, costDoubt: priced.weightDoubt, priceOnly: true, chooseOnly: true}) : null;
    if (choice?.open.length && priced.weightDoubt) {
      const own = perceptualMaskField(null, stride, rows, by => base.planeRows(by * 8, by * 8 + 8)).weight;
      choice = xybStrategies(base, width, height, {...blockSearch, costs: priced.costs, maskWeight: own, priceOnly: true, chooseOnly: true});
      blockSearch.maskWeight = own;
    }
    if (choice && !choice.open.length) {
      v6Trace(effort + ' audit and choice');
      const made = yield {gpu: {kind: 'blocks16-levels', ...source, input, search: blockSearch, scaledDCTBases, lowFrequencies, layout: choice.layout}};
      v6Trace(effort + ' GPU levels');
      varImage = xybStrategies(base, width, height, {...blockSearch, layout: choice.layout, ...(made?.exact ? {exact: made.exact} : {})}).image;
    }
    if (weight) blockSearch.maskWeight = weight;
  }
  if (blockDesign === 'full' && gpu && !color && !screen) {
    let cpuMask = null;
    const own = () => cpuMask ??= base.planes ? perceptualMaskField(base.planes, stride, rows).weight : perceptualMaskField(null, stride, rows, by => base.planeRows(by * 8, by * 8 + 8)).weight;
    const mask = !base.planes && deviceEnergy ? {weight: maskWeights(deviceEnergy.hf, stride, rows).weight, weightDoubt: deviceEnergy.each ? maskWeightDoubts(deviceEnergy.each, stride, rows) : 0.75 * deviceEnergy.bound + 1e-12} : {weight: own(), weightDoubt: 0};
    varImage = yield* fullBlocksOnDevice({base, data, width, height, row, blockSearch, mask, own, label: effort, whileLevels: () => { dct8Estimate = estimateBytes(image); }});
    if (!varImage && cpuMask && !base.planes) blockSearch.maskWeight = cpuMask;
  }
  if (!varImage && denseRows) base.planeRows = denseRows;
  if (!varImage && !base.planes && !blockSearch.maskWeight) blockSearch.maskWeight = (energy ? maskWeights(energy, stride, rows) : perceptualMaskField(null, stride, rows, by => base.planeRows(by * 8, by * 8 + 8))).weight;
  varImage ??= xybStrategies(base, width, height, {...blockSearch, priceOnly: true, keepChosen: true}).image;
  v6Trace(effort + ' blocks assembled');
  base = null;
  const primed = {};
  if (fast && deferred) { const est = estimateBytes(varImage, primed); v6Trace(effort + ' estimate'); return {est, image: varImage, write: () => encodeStrategyImageSteps(varImage, effort >= 7, effort, false, primed, both)}; }
  if (fast) return yield* watch(encodeStrategyImageSteps(varImage, effort >= 7, effort, false, null, both), 1, 2);
  const estBlocks = estimateBytes(varImage, primed), estDct8 = dct8Estimate ?? estimateBytes(image), blocksWin = estBlocks < estDct8;
  v6Trace(effort + ' estimates');
  if (deferred) {
    const est = blocksWin ? estBlocks : estDct8;
    if (blocksWin && gpu && deferred === 'prelearn') {
      for (const _ of strategyLfSteps(varImage, Math.min(effort, 7))) if (yield 0.99) { hurried = true; return null; }
      v6Trace(effort + ' LF learned');
    }
    return {est, image: blocksWin ? varImage : image, write: () => blocksWin ? encodeStrategyImageSteps(varImage, effort >= 7, Math.min(effort, 7), false, primed, both) : encodeCoefficients(image, Math.min(effort, 7))};
  }
  if (blocksWin) return yield* watch(encodeStrategyImageSteps(varImage, effort >= 7, Math.min(effort, 7), false, primed, both), 1, 2);
  return yield* watch(encodeCoefficients(image, Math.min(effort, 7)), 1, 2);
}
photoAnsSteps.blocks = blockPictureSteps;
