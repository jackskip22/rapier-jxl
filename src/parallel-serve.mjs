// SPDX-License-Identifier: MIT
import {fault} from './fault.mjs';
import {complete} from './bits.mjs';
import {varDCTSteps, seedLfSections} from './vardct.mjs';
import {coefficientOrders} from './coefficient-effort.mjs';
import {buildAnsCoding, writeModularAnsHistograms} from './ans.mjs';
import {lfCodeOf, lfCoder, lfCoderFor, monotonicLfCoderFor, fixedLfCoder, quickOrFixedLfCoder, jpegBroadOrFastLfCoder, richLfCoder} from './lf-coding.mjs';
import {photoXYBBand, placeBand} from './photo-bands.mjs';
import {photoXYBSteps} from './photo-xyb.mjs';
import {TokenCounts} from './entropy.mjs';
import {V6, GABORISH, UPLOAD_PICTURE} from './photo-v6.mjs';
import {uploadBandPicture, SMALL_V6} from './photo-v6-settings.mjs';
import {ensureKernels, disableEntropyKernels, lendEntropy} from './kernels.mjs';
import {holdEntropy, releaseEntropy} from './kernel-hooks.mjs';
import {scoreBandOutputs, scoreBandWorkspace, shapeBandChoices, maskBandEnergy, packBandRow} from './photo-band-score.mjs';
import {zoneCellsOf} from './photo-zone-cells.mjs';
import {captureGroupBytes, captureSingleCandidateBytes} from './capture-codec.mjs';
import {CAPTURE_TOOLS_COMPLETE} from './capture-ans.mjs';
import {effortTenGroup, effortTenTree} from './effort-ten.mjs';
import {acceleration} from './v7/acceleration.mjs';
import {hostGPU} from './gpu-gate.mjs';
import {EXACT_GPU_EFFORT} from './v7/webgpu.mjs';
const scoreBand = (typeof __RAPIER_JXL_CAPTURE_PHOTO__ !== 'undefined' && __RAPIER_JXL_CAPTURE_PHOTO__ === true) ||
  (typeof __RAPIER_JXL_UPLOAD__ !== 'undefined' && __RAPIER_JXL_UPLOAD__ === true) ? null : scoreBandOutputs;
const zoneCells = (typeof __RAPIER_JXL_CAPTURE_PHOTO__ !== 'undefined' && __RAPIER_JXL_CAPTURE_PHOTO__ === true) ||
  (typeof __RAPIER_JXL_UPLOAD__ !== 'undefined' && __RAPIER_JXL_UPLOAD__ === true) ? null : zoneCellsOf;
const shapeBand = (typeof __RAPIER_JXL_CAPTURE_PHOTO__ !== 'undefined' && __RAPIER_JXL_CAPTURE_PHOTO__ === true) ||
  (typeof __RAPIER_JXL_UPLOAD__ !== 'undefined' && __RAPIER_JXL_UPLOAD__ === true) ? null : shapeBandChoices;
const maskBand = (typeof __RAPIER_JXL_CAPTURE_PHOTO__ !== 'undefined' && __RAPIER_JXL_CAPTURE_PHOTO__ === true) ||
  (typeof __RAPIER_JXL_UPLOAD__ !== 'undefined' && __RAPIER_JXL_UPLOAD__ === true) ? null : maskBandEnergy;
const packBand = (typeof __RAPIER_JXL_CAPTURE_PHOTO__ !== 'undefined' && __RAPIER_JXL_CAPTURE_PHOTO__ === true) ||
  (typeof __RAPIER_JXL_UPLOAD__ !== 'undefined' && __RAPIER_JXL_UPLOAD__ === true) ? null : packBandRow;

const LF_CODERS = [...Array.from({length: 10}, (_, e) => e ? lfCoderFor(e) : null), fixedLfCoder, quickOrFixedLfCoder, lfCoder('jpegBroad'), monotonicLfCoderFor(8), jpegBroadOrFastLfCoder, richLfCoder];
const PLAN_KEYS = new Set(['fast', 'clusters', 'orders', 'coding', 'modularAns', 'lfCoder', 'cflGroups']);
export function describePlan(plan) {
  for (const key of Object.keys(plan)) if (plan[key] !== undefined && !PLAN_KEYS.has(key)) return null;
  const ans = plan.coding === buildAnsCoding;
  if (!ans && plan.coding !== undefined || (plan.modularAns !== undefined && plan.modularAns !== writeModularAnsHistograms)) return null;
  const lf = plan.lfCoder === undefined ? 0 : LF_CODERS.indexOf(plan.lfCoder);
  if (lf < 0) return null;
  return {fast: !!plan.fast, clusters: plan.clusters ?? null, orders: plan.orders ?? null, ans, modularAns: !!plan.modularAns, lf, ...(plan.cflGroups > 64 && {cflGroups: plan.cflGroups})};
}
function rebuildPlan(d) {
  const plan = {};
  if (d.fast) plan.fast = true;
  if (d.clusters) plan.clusters = d.clusters;
  if (d.orders) plan.orders = d.orders;
  if (d.ans) plan.coding = buildAnsCoding;
  if (d.modularAns) plan.modularAns = writeModularAnsHistograms;
  if (d.lf) plan.lfCoder = LF_CODERS[d.lf];
  if (d.cflGroups > 64) plan.cflGroups = d.cflGroups;
  return plan;
}

function cacheOf(image, plan, counts) {
  return counts ? {jpeg: image, blockCounts: counts.blockCounts, countedByOrder: new Map([[plan.orders ?? null, [Object.setPrototypeOf(counts.counts, TokenCounts.prototype)]]]),
    dcSections: null, ansDcSections: null, lfSections: null, modularAns: null, lfCoder: null, modular16bit: true} : {};
}

const inputs = new Map();
let scoreWorkspace = null;
export function serveParallel(message, relay) {
  disableEntropyKernels();
  if (message.kernels !== undefined) { ensureKernels(); return null; }
  if (message.input !== undefined) { inputs.set(message.input, message.value); return null; }
  if (message.drop !== undefined) { inputs.delete(message.drop); return null; }
  const {id, task} = message;
  try {
    if (task.kind === 'score-band' && scoreBand) {
      if (!scoreWorkspace?.fits(task.width, task.height)) scoreWorkspace = scoreBandWorkspace(task.width, task.height);
      const {pack, own, rates} = scoreBand(task.recipe, task.rows, task.top, task.width, task.height, task.y0, task.y1, scoreWorkspace, task.into, !!task.rated);
      return [{id, result: {input: task.input, pack, own, ...(rates && {rates})}}, [task.input, pack.buffer, own.buffer, ...(rates ? [rates.buffer] : [])]];
    }
    if (task.kind === 'effort-ten' && (typeof __RAPIER_JXL_EFFORT_TEN__ === 'undefined' || __RAPIER_JXL_EFFORT_TEN__ === true)) {
      const steps = effortTenGroup(task.pixels ?? inputs.get(task.data), task.width, task.height, task.colorSpace, task.rect, task.part, task.shape, task.payload);
      const answered = written => [{id, result: written}, written?.bytes ? [written.bytes.buffer] : written?.global ? [written.global.buffer, ...written.sections.map(s => s.buffer)] : []];
      const missed = error => { if (error.code !== 'JXL_SIZE') throw error; return answered(null); };
      if (task.device && relay) return ownDevice(task).then(gpu => gpu ? onDevice(steps, gpu, relay) : relayed(steps, relay)).then(answered, missed).catch(error => [{id, error: {name: error?.name, code: error?.code, message: error?.message}}, []]);
      try { return answered(complete(steps)); } catch (error) { return missed(error); }
    }
    if (task.kind === 'effort-ten-tree' && (typeof __RAPIER_JXL_EFFORT_TEN__ === 'undefined' || __RAPIER_JXL_EFFORT_TEN__ === true)) {
      try { return [{id, result: complete(effortTenTree(inputs.get(task.data), task.width, task.height, task.colorSpace, task.groups, task.channel))}, []]; }
      catch (error) { if (error.code !== 'JXL_SIZE') throw error; return [{id, result: null}, []]; }
    }
    if (task.kind === 'lf-code' && (typeof __RAPIER_JXL_UPLOAD__ === 'undefined' || __RAPIER_JXL_UPLOAD__ !== true)) {
      const written = lfCodeOf(task);
      return [{id, result: written}, [written.bytes.buffer]];
    }
    if (task.kind === 'zone-cells' && zoneCells) {
      const {sums, rates} = zoneCells(task.recipe, task.rows, task.width, task.height, task.yOnly);
      return [{id, result: {sums, rates}}, [rates.buffer]];
    }
    if (task.kind === 'shape-band' && shapeBand) {
      if (!scoreWorkspace?.fits(task.width, task.height)) scoreWorkspace = scoreBandWorkspace(task.width, task.height);
      const {chosen, useMask, pruneRare} = shapeBand(task, scoreWorkspace);
      return [{id, result: {input: task.input, chosen, useMask, pruneRare}}, [task.input, chosen.buffer]];
    }
    if (task.kind === 'mask-band' && maskBand) {
      if (!scoreWorkspace?.fits(task.width, task.height)) scoreWorkspace = scoreBandWorkspace(task.width, task.height);
      const hf = maskBand(task, scoreWorkspace);
      return [{id, result: {input: task.input, hf}}, [task.input, hf.buffer]];
    }
    if (task.kind === 'pack-band' && packBand) {
      if (!scoreWorkspace?.fits(task.width, task.height)) scoreWorkspace = scoreBandWorkspace(task.width, task.height);
      const row = packBand(task, scoreWorkspace);
      const packed = {groups: row.groups, dc: row.dc, tables: row.tables, wide: row.wide, perceptual: !!row.fields?.perceptual};
      return [{id, result: {input: task.input, packed}}, [task.input, ...row.groups.map(g => g.buffer), ...row.dc.map(d => d.buffer)]];
    }
    if (task.kind === 'band' || task.kind === 'fast-band') {
      const data = inputs.get(task.data), {width, h, quality, color, from, to, y} = task, v6 = task.small ? SMALL_V6 : V6;
      const picture = task.fast ? uploadBandPicture(task.uploadFlat, task.uploadGrain, quality)
        : {...v6, ...GABORISH, ...(task.uploadProfile ? {tune: UPLOAD_PICTURE.tune, calibrationRow: 'upload'} : {})};
      const result = task.kind === 'band' ? photoXYBBand(data.subarray(from * width * 4, to * width * 4), width, h, quality, {...picture, ...color}, y - from)
        : complete(photoXYBSteps(data.subarray(y * width * 4, (y + h) * width * 4), width, h, quality, {...v6, fast: true, fastBand: true}));
      result.alpha = !!result.alpha; delete result.colorSpace;
      const target = task.target !== undefined && inputs.get(task.target);
      if (target) {
        if (!target.nonZero) result.nonZero = null;
        placeBand({components: target.coeffs.map(coeffs => ({coeffs})), cfl: target.cfl, nonZero: target.nonZero}, result, width, y);
        return [{id, result: {...result, placed: true, components: result.components.map(({coeffs, ...c}) => c), cfl: result.cfl && {width: result.cfl.width}, nonZero: undefined}}, []];
      }
      const transfer = [...result.components.map(c => c.coeffs.buffer), ...(result.nonZero ?? []).map(n => n.buffer)];
      if (result.cfl) transfer.push(result.cfl.x.buffer, result.cfl.b.buffer);
      return [{id, result}, transfer];
    }
    if (task.kind === 'capture-group') {
      const bytes = captureGroupBytes(task.pixels, task.stride, task.rect, task.level, task.shape, CAPTURE_TOOLS_COMPLETE);
      return [{id, result: bytes}, [bytes.buffer]];
    }
    if (task.kind === 'capture-single') {
      const bytes = captureSingleCandidateBytes(task.pixels, task.stride, task.rect, task.level, task.shape, task.choice, CAPTURE_TOOLS_COMPLETE);
      return [{id, result: bytes}, [bytes.buffer]];
    }
    if (task.kind === 'orders') return [{id, result: coefficientOrders(inputs.get(task.image).components)}, []];
    if (VARDCT_TASKS.has(task.kind)) { holdEntropy(lendEntropy); try { return vardctTask(id, task); } finally { releaseEntropy(); } }
    throw fault('JXL_INTERNAL', 'parallel-serve:task');
  } catch (error) { return [{id, error: {name: error?.name, code: error?.code, message: error?.message}}, []]; }
}

const sent = new WeakMap();
let sids = 0;
async function relayed(steps, relay) {
  let step, reply;
  while (!(step = steps.next(reply)).done) {
    reply = undefined;
    const request = step.value?.gpu;
    if (!request) continue;
    const samples = request.samples;
    let sid = samples && sent.get(samples);
    const first = samples && sid === undefined;
    if (first) sent.set(samples, sid = ++sids);
    reply = await relay(samples ? {...request, samples: first ? samples : undefined, sid} : request);
  }
  return step.value;
}

let device = null;
function ownDevice(task) {
  if (!(typeof __RAPIER_JXL_TEN_DEVICE__ === 'undefined' || __RAPIER_JXL_TEN_DEVICE__ === true) || !hostGPU()) return Promise.resolve(null);
  device ??= acceleration('required', task.width, task.height, EXACT_GPU_EFFORT, 'still', undefined, undefined, true).catch(() => null);
  return task.device === 'required' ? device : device.then(gpu => gpu && (request => Promise.resolve().then(() => gpu(request)).catch(() => null)));
}
async function onDevice(steps, gpu, relay) {
  let step, reply, told = false;
  try {
    while (!(step = steps.next(reply)).done) {
      reply = undefined;
      const request = step.value?.gpu;
      if (!request) continue;
      reply = await gpu(request);
      if (reply != null && !told && !request.end && !request.failed) { told = true; relay({used: true}); }
    }
    return step.value;
  } catch (error) {
    if (error?.code !== 'JXL_WEBGPU') throw error;
    await relay({failure: {code: error.code, message: error.message}});
    return null;
  } finally { if (!step?.done) steps.return?.(); }
}

const VARDCT_TASKS = new Set(['count', 'lf', 'vardct', 'write']);
function vardctTask(id, task) {
  if (task.kind === 'count') {
    const image = inputs.get(task.image), part = complete(varDCTSteps(image, {...rebuildPlan(task.plan), countGroups: [task.from, task.to]}));
    return [{id, result: part}, [part.counts.small.buffer, part.counts.totals.buffer, ...part.blockCounts.filter(Boolean).map(b => b.buffer)]];
  }
  if (task.kind === 'lf') {
    const image = inputs.get(task.image), group = complete(varDCTSteps(image, {...rebuildPlan(task.plan), lfGroup: task.g}));
    return [{id, result: group}, [group.bytes.buffer]];
  }
  if (task.kind === 'vardct') {
    const image = inputs.get(task.image), plan = rebuildPlan(task.plan);
    if (task.lf) seedLfSections(image, plan, task.lf);
    const bytes = complete(varDCTSteps(image, plan, cacheOf(image, plan, task.counts)));
    return [{id, result: bytes}, [bytes.buffer]];
  }
  if (task.kind === 'write') {
    const image = inputs.get(task.image), plan = rebuildPlan(task.plan);
    const written = complete(varDCTSteps(image, {...plan, writeGroups: [task.from, task.to]}, cacheOf(image, plan, task.counts)));
    return [{id, result: written}, written.map(w => w.bytes.buffer)];
  }
}
