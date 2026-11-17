// SPDX-License-Identifier: MIT
import {fault} from './fault.mjs';
import {complete} from './bits.mjs';
import {varDCTSteps, seedLfSections} from './vardct.mjs';
import {coefficientOrders} from './coefficient-effort.mjs';
import {buildAnsCoding, writeModularAnsHistograms} from './ans.mjs';
import {lfCoder, lfCoderFor, monotonicLfCoderFor, fixedLfCoder, quickOrFixedLfCoder, jpegBroadOrFastLfCoder} from './lf-coding.mjs';
import {photoXYBBand, placeBand} from './photo-bands.mjs';
import {photoXYBSteps} from './photo-xyb.mjs';
import {TokenCounts} from './entropy.mjs';
import {V6, GABORISH, UPLOAD_PICTURE} from './photo-v6.mjs';
import {uploadBandPicture, SMALL_V6} from './photo-v6-settings.mjs';
import {ensureKernels, disableEntropyKernels, lendEntropy} from './kernels.mjs';
import {holdEntropy, releaseEntropy} from './kernel-hooks.mjs';
import {scoreBandOutputs, scoreBandWorkspace} from './photo-band-score.mjs';
const scoreBand = (typeof __RAPIER_JXL_CAPTURE_PHOTO__ !== 'undefined' && __RAPIER_JXL_CAPTURE_PHOTO__ === true) ||
  (typeof __RAPIER_JXL_UPLOAD__ !== 'undefined' && __RAPIER_JXL_UPLOAD__ === true) ? null : scoreBandOutputs;

const LF_CODERS = [...Array.from({length: 10}, (_, e) => e ? lfCoderFor(e) : null), fixedLfCoder, quickOrFixedLfCoder, lfCoder('jpegBroad'), monotonicLfCoderFor(8), jpegBroadOrFastLfCoder];
const PLAN_KEYS = new Set(['fast', 'clusters', 'orders', 'coding', 'modularAns', 'lfCoder']);
export function describePlan(plan) {
  for (const key of Object.keys(plan)) if (plan[key] !== undefined && !PLAN_KEYS.has(key)) return null;
  const ans = plan.coding === buildAnsCoding;
  if (!ans && plan.coding !== undefined || (plan.modularAns !== undefined && plan.modularAns !== writeModularAnsHistograms)) return null;
  const lf = plan.lfCoder === undefined ? 0 : LF_CODERS.indexOf(plan.lfCoder);
  if (lf < 0) return null;
  return {fast: !!plan.fast, clusters: plan.clusters ?? null, orders: plan.orders ?? null, ans, modularAns: !!plan.modularAns, lf};
}
function rebuildPlan(d) {
  const plan = {};
  if (d.fast) plan.fast = true;
  if (d.clusters) plan.clusters = d.clusters;
  if (d.orders) plan.orders = d.orders;
  if (d.ans) plan.coding = buildAnsCoding;
  if (d.modularAns) plan.modularAns = writeModularAnsHistograms;
  if (d.lf) plan.lfCoder = LF_CODERS[d.lf];
  return plan;
}

function cacheOf(image, plan, counts) {
  return counts ? {jpeg: image, blockCounts: counts.blockCounts, countedByOrder: new Map([[plan.orders ?? null, [Object.setPrototypeOf(counts.counts, TokenCounts.prototype)]]]),
    dcSections: null, ansDcSections: null, lfSections: null, modularAns: null, lfCoder: null, modular16bit: true} : {};
}

const inputs = new Map();
let scoreWorkspace = null;
export function serveParallel(message) {
  disableEntropyKernels();
  if (message.kernels !== undefined) { ensureKernels(); return null; }
  if (message.input !== undefined) { inputs.set(message.input, message.value); return null; }
  if (message.drop !== undefined) { inputs.delete(message.drop); return null; }
  const {id, task} = message;
  try {
    if (task.kind === 'score-band' && scoreBand) {
      scoreWorkspace ??= scoreBandWorkspace(task.width, task.height);
      const {pack, own} = scoreBand(task.recipe, task.rows, task.top, task.width, task.height, task.y0, task.y1, scoreWorkspace, task.into);
      return [{id, result: {input: task.input, pack, own}}, [task.input, pack.buffer, own.buffer]];
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
    if (task.kind === 'orders') return [{id, result: coefficientOrders(inputs.get(task.image).components)}, []];
    if (VARDCT_TASKS.has(task.kind)) { holdEntropy(lendEntropy); try { return vardctTask(id, task); } finally { releaseEntropy(); } }
    throw fault('JXL_INTERNAL', 'parallel-serve:task');
  } catch (error) { return [{id, error: {name: error?.name, code: error?.code, message: error?.message}}, []]; }
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
