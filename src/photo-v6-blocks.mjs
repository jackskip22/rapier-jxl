// SPDX-License-Identifier: MIT
import {complete, scaled} from './bits.mjs';
import {transformDCT8, dct8Basis} from './photo-dct.mjs';
import {photoXYBSteps, XYB_TABLES} from './photo-xyb.mjs';
import {photoXYBBands, photoXYBBand, appendPhotoBand, PHOTO_BAND_MARGIN} from './photo-bands.mjs';
import {xybStrategies, encodeStrategyImageSteps, strategyInputs, auditCosts} from './varblocks.mjs';
import {scaledDCTBases, lowFrequencies} from './vardct-strategies.mjs';
import {coefficientAnsSteps, estimateBytes, strategyLfSteps} from './coefficient-ans.mjs';
import {perceptualMaskField, perceptualMaskSteps, maskEnergy, maskWeights, maskWeightDoubts, maskDoubtMax} from './aq.mjs';
import {offloading} from './offload.mjs';
import {pictureBlocksSplit} from './block-split.mjs';
import {V6, GABORISH, admitV6Memory, prepareV6, v6Image, gaborishRows, blockSearchOptions, v6Trace, idleWork} from './photo-v6.mjs';
import {grainRegime} from './photo-v6-settings.mjs';
import {wholeBudget, WHOLE_BYTES} from './memory-device.mjs';
import {journalRequest, unit} from './step-journal.mjs';

export function photoAnsSteps(image, effort, ...rest) { return coefficientAnsSteps(image, effort, ...rest); }
photoAnsSteps.splits = coefficientAnsSteps.splits;

function* bandsWithEnergy(data, width, height, quality, options, energy) {
  const bandHeight = Math.max(64, Math.floor(1048576 / width / 64) * 64), stride = Math.ceil(width / 8);
  let image;
  for (let y = 0; y < height; y += bandHeight) {
    const h = Math.min(bandHeight, height - y), from = Math.max(0, y - PHOTO_BAND_MARGIN), to = Math.min(height, y + h + PHOTO_BAND_MARGIN);
    const by0 = y / 8, by1 = Math.ceil((y + h) / 8);
    const {result, hf} = yield* unit('picture-band', () => {
      const made = photoXYBBand(data.subarray(from * width * 4, to * width * 4), width, h, quality, {...options, keepPlanes: true}, y - from);
      maskEnergy(made.planes, y, stride, by0, by1, energy);
      const {planes: _planes, ...result} = made;
      return {result: {...result, alpha: !!result.alpha}, hf: energy.slice(by0 * stride, by1 * stride)};
    });
    energy.set(hf, by0 * stride);
    image = appendPhotoBand(image, {...result, alpha: result.alpha ? data : null}, width, height, y, data);
    image.planes = undefined;
    yield (y + h) / height;
  }
  return image;
}

function* bandsOnly(bands) {
  let step, reply;
  try { while (!(step = bands.next(reply)).done) {
    reply = undefined;
    if (step.value?.offload === 'image') continue;
    reply = yield step.value;
  } } finally { if (!step?.done) bands.return?.(); }
  return step.value;
}

function refineEnergyOpen({hf, each}, open, planeRows, stride, rows) {
  const exact = hf.slice(), bound = each.slice(), row = new Float64Array(stride * rows);
  const done = new Set();
  for (const {bx, by, size} of open) {
    const bx0 = Math.max(0, bx - 1), bx1 = Math.min(stride, bx + size + 1);
    for (let y = Math.max(0, by - 1); y < Math.min(rows, by + size + 1); y++) {
      if (!done.has(y)) { const {planes, top} = planeRows(y * 8, y * 8 + 8); maskEnergy(planes, top, stride, y, y + 1, row); done.add(y); }
      for (let x = bx0; x < bx1; x++) { exact[y * stride + x] = row[y * stride + x]; bound[y * stride + x] = 0; }
    }
  }
  const m = maskWeights(exact, stride, rows);
  return {weight: m.weight, weightDoubt: maskWeightDoubts(bound, stride, rows, m.eroded)};
}

export function* fullBlocksOnDevice({base, data, width, height, row, blockSearch, mask, own, ownWork, refineOpen, whileLevels, label = ''}) {
  const request = {data, width, height, options: {...V6, ...GABORISH, ...row}, input: strategyInputs(base, width, height, blockSearch), search: blockSearch, ids: blockSearch.ids, scaledDCTBases, lowFrequencies,
    lib: {complete, photoXYBSteps, transformDCT8, dct8Basis, xyb: XYB_TABLES}};
  v6Trace(label + ' inputs and mask');
  let priced = yield {gpu: {kind: 'blocks', ...request, ...mask}};
  v6Trace(label + ' GPU costs');
  if (priced?.costs && !(auditCosts(base, width, height, blockSearch, priced) <= 1)) { yield {gpu: {kind: 'audit-failed'}}; priced = null; }
  v6Trace(label + ' audit');
  let choice = priced?.costs ? xybStrategies(base, width, height, {...blockSearch, costs: priced.costs, maskWeight: priced.weight, costDoubt: priced.weightDoubt, priceOnly: true, chooseOnly: true}) : null;
  v6Trace(`${label} choice (open ${choice?.open.length ?? '-'}, repriced ${choice?.reprices.length ?? '-'}, settled ${choice?.settled ?? '-'}, mask doubt ${maskDoubtMax(priced?.weightDoubt ?? 0).toExponential(1)})`);
  if (choice?.open.length && maskDoubtMax(priced.weightDoubt) && refineOpen) {
    const refined = refineOpen(choice.open);
    choice = xybStrategies(base, width, height, {...blockSearch, costs: priced.costs, maskWeight: refined.weight, costDoubt: refined.weightDoubt, priceOnly: true, chooseOnly: true});
    v6Trace(`${label} refined (open ${choice.open.length})`);
  }
  if (choice?.open.length && maskDoubtMax(priced.weightDoubt)) {
    if (ownWork && !ownWork.done) { yield {idle: ownWork}; yield {await: ownWork.finished}; }
    choice = xybStrategies(base, width, height, {...blockSearch, costs: priced.costs, maskWeight: own(), priceOnly: true, chooseOnly: true});
  }
  if (!choice || choice.open.length) return null;
  v6Trace(label + ' audit and choice');
  const asked = yield {gpu: {kind: 'blocks-levels', ...request, layout: choice.layout}, later: true};
  whileLevels?.();
  const made = asked && typeof asked.then === 'function' ? yield {await: asked} : asked;
  v6Trace(label + ' GPU levels');
  return xybStrategies(base, width, height, {...blockSearch, layout: choice.layout, ...(made?.exact ? {exact: made.exact} : {})}).image;
}

export const E7_LOW = Object.freeze([0.62, 0.62, 0.58, 0.72]);
export const E7_SCALE = Array.from({length: 192}, (_, i) => { const c = i >> 6, k = i & 63; return k && (k & 7) < 2 && k < 16 ? E7_LOW[c] : c > 1 && k && (k & 7) < 3 && k < 24 ? E7_LOW[3] : 1; });

const pairMask = (pair, data, width, height, stride, rows) => pair.mask ??= idleWork(perceptualMaskSteps(stride, rows,
  (rowsOf => by => rowsOf(by * 8, by * 8 + 8))(gaborishRows(data, width, height, {...V6, ...GABORISH}))));

function* sharedDeviceImage(pair, ask) {
  pair.deviceImage ??= yield {...ask, later: true};
  const answer = pair.deviceImage && typeof pair.deviceImage.then === 'function' ? yield {await: pair.deviceImage} : pair.deviceImage;
  return answer ? {...answer} : null;
}

function* blockPictureSteps({data, width, height, quality, effort, encodeCoefficients, color, gpu, memory, screen, floored, blockDesign, deferred, both, pair}) {
  const plan = admitV6Memory(data, width, height, memory);
  let hurried = false;
  function* watch(steps, index, count) {
    let step, reply, completed = false;
    try {
      while (!(step = steps.next(reply)).done) {
        const v = step.value;
        reply = yield scaled(v, done => (index + done) / count);
        if (typeof v === 'number' ? reply : !v?.gpu && !journalRequest(v) && (reply === null || reply?.hurried)) hurried = true;
      }
      completed = true;
      return step.value;
    } finally {
      try { steps.return?.(); } catch (error) { if (completed) throw error; }
    }
  }
  const whole = !offloading() && (!plan.banded || effort === 7 && !pair && !gpu && memory == null &&
    Math.ceil(width / 8) * Math.ceil(height / 8) * 64 * WHOLE_BYTES <= wholeBudget(undefined, 0));
  let prepared = null;
  if (pair && pair.grain === undefined) pair.grain = (yield* unit('grain', () => grainRegime(data, width, height))) ?? false;
  const fast = blockDesign === 'fast', row = {calibrationRow: screen ? 'screenFull' : pair ? 'e7' : fast ? 'blocksFast' : 'blocks', ...(pair ? {lowScale: E7_SCALE, ...(pair.grain ??= grainRegime(data, width, height) ?? false)} : {}), ...(fast && floored ? {noLevels: true} : {})}, rowColor = {...color, ...row};
  let splitMade = null;
  if (fast && floored && !gpu && !color && !screen && width * height > 512 * 512 && encodeCoefficients.splits) {
    const options = {...blockSearchOptions(data, width, height), ids: [4], ...(pair ? {lowScale: E7_SCALE} : {})};
    const write = deferred ? null : {effort, steps: image => encodeStrategyImageSteps(image, effort >= 7, effort, 'split', null, both)};
    splitMade = (yield {split: {pixels: width * height, run: (leased, signal) => pictureBlocksSplit(data, width, height, quality, row, options, leased, signal, write)}}) ?? null;
    if (splitMade?.bytes) { v6Trace(effort + ' picture, blocks and write on helpers'); return splitMade.bytes; }
    if (splitMade) v6Trace(effort + ' picture and blocks on helpers');
  }
  const prepare = () => pair ? pair.prepared ??= prepareV6(data, width, height, color, memory) : prepareV6(data, width, height, color, memory);
  const idle = whole ? () => { try { prepared = prepare(); } catch {} } : undefined;
  const ask = {gpu: {kind: 'v6image', data, width, height, quality, options: {...V6, ...GABORISH, ...row, ...(pair ? {noLevels: false} : {})}, idle, ...(fast || blockDesign === 'full' ? {energy: true} : {}), lib: {complete, photoXYBSteps, transformDCT8, dct8Basis, xyb: XYB_TABLES}}};
  let image = splitMade ? splitMade.image : gpu && !color && !screen ? pair ? yield* sharedDeviceImage(pair, ask) : yield ask : null;
  let deviceEnergy = null;
  if (image?.maskEnergy !== undefined) { deviceEnergy = image.maskEnergy; delete image.maskEnergy; }
  v6Trace(effort + ' DCT8 picture');
  if (whole && !splitMade) prepared ??= prepare();
  let kept = !image && whole ? v6Image(prepared, quality, {keepPlanes: true, ...row}, false) : null;
  if (kept) { const {planes: _planes, ...picture} = kept; image = picture; }
  const stride = Math.ceil(width / 8), rows = Math.ceil(height / 8), energy = !image && !whole && !offloading() ? new Float64Array(stride * rows) : null;
  image ||= whole ? v6Image(prepared, quality, row, false)
    : energy ? yield* watch(bandsWithEnergy(data, width, height, quality, {...V6, ...GABORISH, ...rowColor}, energy), 0, 4)
    : yield* watch(bandsOnly(photoXYBBands(data, width, height, quality, {...V6, ...GABORISH, ...rowColor}, offloading() ? rowColor : undefined)), 0, 4);
  if (hurried) return floored ? null : yield* watch(encodeCoefficients(image, effort), 1, 4);
  const blockSearch = {...blockSearchOptions(data, width, height), ...(fast ? {ids: [4]} : {}), ...(pair ? {lowScale: E7_SCALE} : {})};
  let base = kept ?? (prepared ? {...image, planes: prepared.pre} : {...image, planeRows: gaborishRows(data, width, height, {...V6, ...GABORISH, ...color})});
  const denseRows = base.planeRows;
  if (denseRows && gpu && !color && !screen && blockDesign) base.planeRows = gaborishRows(data, width, height, {...V6, ...GABORISH, ...color}, true);
  kept = null; prepared = null;

  let varImage = splitMade?.varImage ?? null, dct8Estimate = null;
  if (splitMade) blockSearch.maskWeight = splitMade.mask;
  if (fast && gpu && !color && !screen) {
    const input = strategyInputs(base, width, height, blockSearch), weight = base.planes ? perceptualMaskField(base.planes, stride, rows).weight : null;
    const m16 = !weight && deviceEnergy ? maskWeights(deviceEnergy.hf, stride, rows) : null;
    const fromEnergy = m16 ? {weight: m16.weight, weightDoubt: deviceEnergy.each ? maskWeightDoubts(deviceEnergy.each, stride, rows, m16.eroded) : 0.75 * deviceEnergy.bound + 1e-12} : null;
    const source = {data, width, height, options: {...V6, ...GABORISH, ...row}, ...(weight ? {weight} : fromEnergy ?? {maskWeights}),
      lib: {complete, photoXYBSteps, transformDCT8, dct8Basis, xyb: XYB_TABLES}};
    v6Trace(effort + ' inputs');
    let priced = yield {gpu: {kind: 'blocks16', ...source, input, search: blockSearch, scaledDCTBases, lowFrequencies}};
    v6Trace(effort + ' GPU costs');
    if (priced?.costs && !(auditCosts(base, width, height, blockSearch, priced) <= 1)) { yield {gpu: {kind: 'audit-failed'}}; priced = null; }
    let choice = priced?.costs ? xybStrategies(base, width, height, {...blockSearch, costs: priced.costs, maskWeight: priced.weight, costDoubt: priced.weightDoubt, priceOnly: true, chooseOnly: true}) : null;
    if (choice?.open.length && maskDoubtMax(priced.weightDoubt) && deviceEnergy?.each && base.planeRows) {
      const refined = refineEnergyOpen(deviceEnergy, choice.open, base.planeRows, stride, rows);
      choice = xybStrategies(base, width, height, {...blockSearch, costs: priced.costs, maskWeight: refined.weight, costDoubt: refined.weightDoubt, priceOnly: true, chooseOnly: true});
    }
    if (choice?.open.length && maskDoubtMax(priced.weightDoubt)) {
      const work = pair && !base.planes ? pairMask(pair, data, width, height, stride, rows) : null;
      if (work && !work.done) { yield {idle: work}; yield {await: work.finished}; }
      const own = work ? work.run().weight : perceptualMaskField(null, stride, rows, by => base.planeRows(by * 8, by * 8 + 8)).weight;
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
    const ownWork = pair && !base.planes && deviceEnergy ? pairMask(pair, data, width, height, stride, rows) : null;
    if (ownWork) yield {idle: ownWork};
    const own = () => cpuMask ??= base.planes ? perceptualMaskField(base.planes, stride, rows).weight : ownWork ? ownWork.run().weight : perceptualMaskField(null, stride, rows, by => base.planeRows(by * 8, by * 8 + 8)).weight;
    const mFull = !base.planes && deviceEnergy ? maskWeights(deviceEnergy.hf, stride, rows) : null;
    const mask = mFull ? {weight: mFull.weight, weightDoubt: deviceEnergy.each ? maskWeightDoubts(deviceEnergy.each, stride, rows, mFull.eroded) : 0.75 * deviceEnergy.bound + 1e-12} : {weight: own(), weightDoubt: 0};
    const refineOpen = mFull && deviceEnergy.each && base.planeRows ? open => refineEnergyOpen(deviceEnergy, open, base.planeRows, stride, rows) : null;
    varImage = yield* fullBlocksOnDevice({base, data, width, height, row, blockSearch, mask, own, ownWork, refineOpen, label: effort, whileLevels: () => { dct8Estimate = estimateBytes(image); }});
    if (!varImage && cpuMask && !base.planes) blockSearch.maskWeight = cpuMask;
  }
  if (!varImage && denseRows) base.planeRows = denseRows;
  if (!varImage && !base.planes && !blockSearch.maskWeight) blockSearch.maskWeight = (energy ? maskWeights(energy, stride, rows) : perceptualMaskField(null, stride, rows, by => base.planeRows(by * 8, by * 8 + 8))).weight;
  varImage ??= xybStrategies(base, width, height, {...blockSearch, priceOnly: true, keepChosen: true}).image;
  v6Trace(effort + ' blocks assembled');
  base = null;
  const primed = {};
  if (fast && deferred) { const est = estimateBytes(varImage, primed); v6Trace(effort + ' estimate'); return {est, image: varImage, write: blockWriter(varImage, effort >= 7, effort, primed, both)}; }
  if (fast) return yield* watch(encodeStrategyImageSteps(varImage, effort >= 7, effort, false, null, both), 1, 2);
  const estBlocks = estimateBytes(varImage, primed), estDct8 = dct8Estimate ?? estimateBytes(image), blocksWin = estBlocks < estDct8;
  v6Trace(effort + ' estimates');
  if (deferred) {
    const est = blocksWin ? estBlocks : estDct8;
    if (blocksWin && gpu && deferred === 'prelearn') {
      for (const _ of strategyLfSteps(varImage, Math.min(effort, 7))) if (yield 0.99) { hurried = true; return null; }
      v6Trace(effort + ' LF learned');
    }
    return {est, image: blocksWin ? varImage : image, write: blocksWin ? blockWriter(varImage, effort >= 7, Math.min(effort, 7), primed, both) : dct8Writer(image, encodeCoefficients, Math.min(effort, 7))};
  }
  if (blocksWin) return yield* watch(encodeStrategyImageSteps(varImage, effort >= 7, Math.min(effort, 7), false, primed, both), 1, 2);
  return yield* watch(encodeCoefficients(image, Math.min(effort, 7)), 1, 2);
}
photoAnsSteps.blocks = blockPictureSteps;
const blockWriter = (image, learned, effort, primed, both) => () => encodeStrategyImageSteps(image, learned, effort, false, primed, both);
const dct8Writer = (image, encodeCoefficients, effort) => () => encodeCoefficients(image, effort);
