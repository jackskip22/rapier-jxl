// SPDX-License-Identifier: MIT
import {complete} from './bits.mjs';
import {varDCTSteps, seedLfSections} from './vardct.mjs';
import {coefficientOrders} from './coefficient-effort.mjs';
import {buildAnsCoding, writeModularAnsHistograms} from './ans.mjs';
import {lfCoder, lfCoderFor, fixedLfCoder, quickOrFixedLfCoder} from './lf-coding.mjs';
import {photoXYBBand, placeBand} from './photo-bands.mjs';
import {photoXYBSteps} from './photo-xyb.mjs';
import {TokenCounts} from './entropy.mjs';
import {acGroupEncoder} from './ac-group.mjs';
import {V6, GABORISH} from './photo-v6.mjs';
import {configureKernels, disableEntropyKernels} from './kernels.mjs';

const LF_CODERS = [...Array.from({length: 10}, (_, e) => e ? lfCoderFor(e) : null), fixedLfCoder, quickOrFixedLfCoder, lfCoder('jpegBroad')];
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

const inputs = new Map(), encoders = new Map();
export function serveParallel(message) {
  disableEntropyKernels();
  if (message.kernels !== undefined) { configureKernels(message.kernels); return null; }
  if (message.input !== undefined) { inputs.set(message.input, message.value); return null; }
  if (message.drop !== undefined) { inputs.delete(message.drop); encoders.delete(message.drop); return null; }
  const {id, task} = message;
  try {
    if (task.kind === 'band' || task.kind === 'fast-band') {
      const data = inputs.get(task.data), {width, h, quality, color, from, to, y} = task;
      const result = task.kind === 'band' ? photoXYBBand(data.subarray(from * width * 4, to * width * 4), width, h, quality, {...V6, ...GABORISH, ...color, ...(task.fast ? {fastGaborish: true} : {})}, y - from)
        : complete(photoXYBSteps(data.subarray(y * width * 4, (y + h) * width * 4), width, h, quality, {...V6, fast: true}));
      result.alpha = !!result.alpha; delete result.colorSpace;
      const target = task.target !== undefined && inputs.get(task.target);
      if (target) {
        placeBand({components: target.coeffs.map(coeffs => ({coeffs})), cfl: target.cfl, nonZero: target.nonZero}, result, width, y);
        return [{id, result: {...result, placed: true, components: result.components.map(({coeffs, ...c}) => c), cfl: result.cfl && {width: result.cfl.width}, nonZero: undefined}}, []];
      }
      const transfer = [...result.components.map(c => c.coeffs.buffer), ...(result.nonZero ?? []).map(n => n.buffer)];
      if (result.cfl) transfer.push(result.cfl.x.buffer, result.cfl.b.buffer);
      return [{id, result}, transfer];
    }
    if (task.kind === 'count') {
      const image = inputs.get(task.image), part = complete(varDCTSteps(image, {...rebuildPlan(task.plan), countGroups: [task.from, task.to]}));
      return [{id, result: part}, [part.counts.small.buffer, part.counts.totals.buffer, ...part.blockCounts.filter(Boolean).map(b => b.buffer)]];
    }
    if (task.kind === 'ac') {
      let encoder = encoders.get(task.model);
      if (!encoder) encoders.set(task.model, encoder = acGroupEncoder(inputs.get(task.model)));
      const results = task.groups.map(data => encoder(data));
      return [{id, result: results}, results.map(r => r.bytes.buffer)];
    }
    if (task.kind === 'orders') return [{id, result: coefficientOrders(inputs.get(task.image).components)}, []];
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
    throw new Error('Unknown parallel task.');
  } catch (error) { return [{id, error: {name: error?.name, code: error?.code, message: error?.message}}, []]; }
}
