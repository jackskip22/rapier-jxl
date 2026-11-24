import {prepareCoefficientOrders} from './coefficient-orders.mjs';
// SPDX-License-Identifier: MIT
import {fault} from './fault.mjs';
import {coefficientEffortSteps, coefficientOrderSteps, candidateSteps, prefetch, prefixPlans} from './coefficient-effort.mjs';
import {offloading} from './offload.mjs';
import {varDCTSteps, vdLfGroupCount, seedLfSections} from './vardct.mjs';
import {part, complete, scaled} from './bits.mjs';
import {ansCodingsKept, buildAnsCoding, writeModularAnsHistograms} from './ans.mjs';
import {progressiveImage, progressiveSearch, progressiveWritten, lfSplitProgression} from './progressive-mode.mjs';
import {watchShown, shown} from './photo-shown.mjs';
import {lfCoderFor, monotonicLfCoderFor} from './lf-coding.mjs';
import {SMALL_PIXELS, SMALL_CLUSTERS, UPLOAD_CLUSTERS} from './photo-v6-settings.mjs';
import {journalRequest, journaling, unit, journalNext, plainJournal} from './step-journal.mjs';

const CAPTURE_PHOTO = typeof __RAPIER_JXL_CAPTURE_PHOTO__ !== 'undefined' && __RAPIER_JXL_CAPTURE_PHOTO__ === true;

const PHOTO_CLUSTERS = {maxClusters: 64, newClusterCost: 100, seeds: 128};
export const BUDGETS = [{maxClusters: 64, newClusterCost: 80, seeds: 128, switchCost: 5}, {maxClusters: 48, newClusterCost: 130, seeds: 128}, {maxClusters: 64, newClusterCost: 90, seeds: 128, everyConfig: true}];
const EXTRA_BUDGETS = [{maxClusters: 64, newClusterCost: 70, seeds: 128, switchCost: 4, everyConfig: true}, {maxClusters: 64, newClusterCost: 58, seeds: 128, switchCost: 4, everyConfig: true}, {maxClusters: 64, newClusterCost: 44, seeds: 128, switchCost: 3, everyConfig: true}, {maxClusters: 32, newClusterCost: 175, seeds: 128, everyConfig: true}];
const SHAPED_BUDGETS = (typeof __RAPIER_JXL_UPLOAD__ !== 'undefined' && __RAPIER_JXL_UPLOAD__ === true) ? [] : [
  {maxClusters: 64, newClusterCost: 24, seeds: 128, switchCost: 2.5, everyConfig: true, passes: 6, shapedMerge: true},
  {maxClusters: 64, newClusterCost: 38, seeds: 128, switchCost: 3, everyConfig: true, passes: 6, shapedMerge: true},
];
const E10_BUDGETS = (typeof __RAPIER_JXL_EFFORT_TEN__ === 'undefined' || __RAPIER_JXL_EFFORT_TEN__ === true) ? [
  {maxClusters: 64, newClusterCost: 58, seeds: 128, switchCost: 3.5, passes: 6, everyConfig: true, shapedMerge: true},
  {maxClusters: 64, newClusterCost: 38, seeds: 128, switchCost: 3, passes: 6, everyConfig: true, shapedMerge: true},
  {maxClusters: 64, newClusterCost: 24, seeds: 128, switchCost: 2.5, passes: 6, everyConfig: true, shapedMerge: true},
  {maxClusters: 64, newClusterCost: 95, seeds: 128, switchCost: 4.5, passes: 6, everyConfig: true, shapedMerge: true},
  {maxClusters: 48, newClusterCost: 125, seeds: 128, switchCost: 4.5, passes: 6, everyConfig: true, shapedMerge: true},
] : [];

export function rungs(effort) {
  if ((typeof __RAPIER_JXL_UPLOAD__ !== 'undefined' && __RAPIER_JXL_UPLOAD__ === true) || effort < 4) return [{orders: true, lf: 3, clusters: UPLOAD_CLUSTERS}];
  const lf = effort >= 7 ? 7 : 5, list = [...(effort >= 5 ? [{orders: true}] : []), {orders: true, lf}, {lf}];
  for (let i = 0; i < (effort >= 5 ? Math.min(3, effort - 4) : 0); i++) list.push({orders: 'best', lf, clusters: BUDGETS[i]});
  if (effort >= 8) list.push({orders: 'best', lf: 9});
  if (effort >= 9) list.push({orders: 'best', lf: 8}, {orders: 'best', lf: 7});
  if (effort >= 8 && effort < 10) for (const clusters of SHAPED_BUDGETS.slice(0, effort - 7)) list.push({orders: 'best', lf: 9, clusters});
  if ((typeof __RAPIER_JXL_EFFORT_TEN__ === 'undefined' || __RAPIER_JXL_EFFORT_TEN__ === true) && effort >= 10) for (const clusters of E10_BUDGETS) list.push({orders: 'best', lf: 10, clusters});
  return list;
}

function closeCandidate(steps, preserveOutcome) {
  try { steps?.return(); }
  catch (error) { if (!preserveOutcome) throw error; }
}

function* quiet(steps) { let step; try { while (!(step = steps.next()).done) yield step.value; } finally { if (!step?.done) steps.return?.(); } return step.value; }

const FAST_LAST = 3;

export const ansPlan = (rung, orders, effort) => ({coding: buildAnsCoding, modularAns: writeModularAnsHistograms, ...((typeof __RAPIER_JXL_UPLOAD__ !== 'undefined' && __RAPIER_JXL_UPLOAD__ === true) || effort <= FAST_LAST ? {fast: true} : {}),
  ...(rung.lf ? {lfCoder: lfCoderFor(rung.lf)} : {}), ...(orders ? {orders} : {}), clusters: rung.clusters ?? PHOTO_CLUSTERS});

const isSizeFailure = error => error?.code === 'JXL_SIZE';

const PREFIX_PIXELS = 128 * 128;
const FLOOR_BYTES = 2048;

export function coefficientAnsPolicy(jpeg, effort) {
  const list = effort <= 3 && jpeg.xyb && jpeg.width * jpeg.height < SMALL_PIXELS ? [{orders: true, clusters: SMALL_CLUSTERS}] : rungs(effort), learn = list.some(rung => rung.orders) ? 1 : 0, small = jpeg.width * jpeg.height <= PREFIX_PIXELS;
  const lazyFloor = !(typeof __RAPIER_JXL_UPLOAD__ !== 'undefined' && __RAPIER_JXL_UPLOAD__ === true) && effort >= 4 && effort <= 6 && !small && !!jpeg.xyb, floorFirst = !(typeof __RAPIER_JXL_UPLOAD__ !== 'undefined' && __RAPIER_JXL_UPLOAD__ === true) && effort >= 4 && !lazyFloor, parts = learn + list.length + 1;
  return {list, learn, small, lazyFloor, floorFirst, parts, adaptiveFast: !!(jpeg.xyb && !jpeg.strategyData && effort <= FAST_LAST)};
}
export const coefficientAnsKey = (rung, use, orders) => (use === orders && use ? 'o' : use ? '?' : 'n') + ':' + (rung.lf ?? 0) + ':' + (rung.clusters ? (SHAPED_BUDGETS.includes(rung.clusters) ? 200 + SHAPED_BUDGETS.indexOf(rung.clusters) : (typeof __RAPIER_JXL_EFFORT_TEN__ === 'undefined' || __RAPIER_JXL_EFFORT_TEN__ === true) && BUDGETS.indexOf(rung.clusters) < 0 ? 100 + E10_BUDGETS.indexOf(rung.clusters) : BUDGETS.indexOf(rung.clusters)) : -1);
export const coefficientAnsNeedsFloor = ({floorFirst, small, lazyFloor}, best, hurry) =>
  !floorFirst && (small || best && best.length <= FLOOR_BYTES) && !(hurry && best) || lazyFloor && hurry || !best;
export {isSizeFailure as coefficientSizeFailure};

const DCT8_SHARED = new WeakMap();
const dct8SharedOf = (jpeg, effort) => {
  const c0 = jpeg.components?.[0];
  if (effort < 4 || !c0 || jpeg.strategyData || jpeg.placement !== undefined || jpeg.band)
    return {acCoding: buildAnsCoding};
  const hit = DCT8_SHARED.get(c0);
  if (hit && hit.quantScale === jpeg.quantScale && hit.field === jpeg.quantFieldBase && hit.cfl === jpeg.cfl && hit.epf === jpeg.epf && hit.alpha === jpeg.alpha && hit.useDCFrame === jpeg.useDCFrame)
    return hit.shared;
  const shared = {acCoding: buildAnsCoding};
  DCT8_SHARED.set(c0, {quantScale: jpeg.quantScale, field: jpeg.quantFieldBase, cfl: jpeg.cfl, epf: jpeg.epf, alpha: jpeg.alpha, useDCFrame: jpeg.useDCFrame, shared});
  return shared;
};
export function* coefficientAnsSteps(jpeg, effort, fallback, retain, pooled = false) {
  if (jpeg.progressiveOrders && effort <= 5) jpeg = {...jpeg, authoredOrderPasses: jpeg.progressiveOrders, progressiveOrders: null};
  const shared = retain ? {} : dct8SharedOf(jpeg, effort);
  if (effort < 2) return yield* part(coefficientEffortSteps(jpeg, effort, fallback, retain, shared, pooled), 0, 1);
  ansCodingsKept(true);
  try {
  const policy = coefficientAnsPolicy(jpeg, effort), {list, learn, small, lazyFloor, floorFirst, parts, adaptiveFast} = policy;
  let best = fallback, hurry = false, at = 0, orders;
  function* run(steps) {
    const from = at / parts;
    let step, reply, settled = false;
    try {
      while (!(step = steps.next(reply)).done) {
        const value = step.value, response = yield scaled(value, done => Math.min(1, from + done / parts));
        reply = response;
        if (typeof value === 'number' ? response : !value?.gpu && !journalRequest(value) && (response === null || response?.hurried)) hurry = true;
        if (typeof value === 'number' && response && best && value < 1) return null;
      }
      settled = true;
      return step.value;
    } finally { at++; closeCandidate(steps, !settled); }
  }
  let bestPlan = null;
  const keep = (bytes, plan) => {
    if (pooled && bytes === null) { if (!best) throw fault('JXL_INTERNAL', 'coefficient-ans:ac-1'); return; }
    if (bytes && (!best || bytes.length < best.length)) { best = bytes; bestPlan = plan; }
    if (bytes) retain?.(bytes, plan);
  };
  const floor = () => coefficientEffortSteps(jpeg, 1, undefined, undefined, {}, pooled);
  if (!pooled && (!CAPTURE_PHOTO && (!(typeof __RAPIER_JXL_UPLOAD__ !== 'undefined' && __RAPIER_JXL_UPLOAD__ === true) && offloading()))) yield prefetch(jpeg, [...(floorFirst || small ? prefixPlans(1) : []),
    ...list.filter(rung => rung.orders !== 'best').map(rung => ansPlan(rung, rung.orders ? 'learned' : null, effort))]);
  if (floorFirst) {
    try { keep(yield* run(floor()), {}); }
    catch (error) { if (!isSizeFailure(error)) throw error; }
  }
  if (learn) orders = yield* run(quiet(coefficientOrderSteps(jpeg.components, 8, adaptiveFast)));
  let bestOrders = null;
  const written = new Set();
  const keyOf = (rung, use) => coefficientAnsKey(rung, use, orders);
  let named = false;
  for (const rung of list) {
    if (hurry && best) break;
    if (rung.orders === 'best' && !named && !pooled && (!CAPTURE_PHOTO && (!(typeof __RAPIER_JXL_UPLOAD__ !== 'undefined' && __RAPIER_JXL_UPLOAD__ === true) && offloading()))) {
      named = true;
      const plans = list.filter(r => r.orders === 'best' && !written.has(keyOf(r, bestOrders)))
        .map(r => ansPlan(r, bestOrders && (bestOrders === orders ? 'learned' : bestOrders), effort));
      if (plans.length) yield prefetch(jpeg, plans);
    }
    const use = rung.orders === 'best' ? bestOrders : rung.orders ? orders : null;
    const key = keyOf(rung, use);
    if (rung.orders === true && !orders && !adaptiveFast || written.has(key)) { at++; continue; }
    written.add(key);
    const plan = ansPlan(rung, use, effort);
    try {
      const before = best;
      keep(yield* run(candidateSteps(jpeg, pooled ? {...plan, pooled: true, abortable: !!best} : plan, shared)), plan);
      if (best !== before) bestOrders = use;
    } catch (error) { if (!isSizeFailure(error)) throw error; }
  }
  if (!(typeof __RAPIER_JXL_UPLOAD__ !== 'undefined' && __RAPIER_JXL_UPLOAD__ === true) && jpeg.progressiveOrders && bestPlan?.coding && !hurry) {
    try { keep(yield* run(candidateSteps({...jpeg, authoredOrderPasses: jpeg.progressiveOrders}, {...bestPlan, orders: undefined}, retain ? {} : {acCoding: buildAnsCoding})), bestPlan); }
    catch (error) { if (!isSizeFailure(error)) throw error; }
  }
  if (coefficientAnsNeedsFloor(policy, best, hurry)) {
    try { keep(yield* run(floor()), {}); }
    catch (error) { if (!isSizeFailure(error) || !best) throw error; }
  }
  if (at < parts) yield 1;
  return best;
  } finally { ansCodingsKept(false); }
}

coefficientAnsSteps.splits = true;

export function* strategyLfSteps(image, effort = 7) {
  const plan = {clusters: BUDGETS[0], coding: buildAnsCoding, modularAns: writeModularAnsHistograms, lfCoder: lfCoderFor(Math.max(5, effort))};
  const n = vdLfGroupCount(image), groups = [];
  for (let g = 0; g < n; g++) { groups.push(complete(varDCTSteps(image, {...plan, lfGroup: g}))); yield (g + 1) / n; }
  seedLfSections(image, plan, groups);
}
export function strategyLfLowerBound(image, effort = 7) {
  if (image.width * image.height <= PREFIX_PIXELS) return 0;
  const lf = effort >= 8 ? monotonicLfCoderFor(effort) : lfCoderFor(Math.max(5, effort));
  const plan = {clusters: BUDGETS[0], coding: buildAnsCoding, modularAns: writeModularAnsHistograms, lfCoder: lf};
  const n = vdLfGroupCount(image), groups = new Array(n);
  let bits = 0;
  for (let g = 0; g < n; g++) {
    const group = complete(varDCTSteps(image, {...plan, lfGroup: g}));
    groups[g] = group;
    bits += group.at * 8 + group.pending;
  }
  seedLfSections(image, plan, groups);
  return bits;
}
export const PLAN_LF = Symbol();
const STRATEGY_SHARED = new WeakMap();
export const strategyOrderEntry = (image, authored) => {
  const sd = image.strategyData;
  if (!sd || image.placement !== undefined) return {img: {...image, authoredOrderPasses: authored}, shared: {acCoding: buildAnsCoding}};
  let byOrder = STRATEGY_SHARED.get(sd);
  if (!byOrder) STRATEGY_SHARED.set(sd, byOrder = new Map());
  let entry = byOrder.get(authored ?? null);
  if (!entry) byOrder.set(authored ?? null, entry = {img: {...image, authoredOrderPasses: authored}, shared: {acCoding: buildAnsCoding}});
  return entry;
};
export function strategyAnsRuns(image, effort = 7, learned = null, primed = null, both = true) {
  const budgets = (typeof __RAPIER_JXL_EFFORT_TEN__ === 'undefined' || __RAPIER_JXL_EFFORT_TEN__ === true) && effort >= 10 ? [...BUDGETS, ...EXTRA_BUDGETS, ...E10_BUDGETS] : effort >= 9 ? [...BUDGETS, ...EXTRA_BUDGETS] : effort >= 8 ? [...BUDGETS, EXTRA_BUDGETS[0]] : BUDGETS.slice(0, Math.max(1, Math.min(3, effort - 6)));
  if (effort >= 8 && effort < 10) budgets.push(...SHAPED_BUDGETS.slice(0, effort - 7));
  const lf = effort >= 8 ? monotonicLfCoderFor(effort) : lfCoderFor(Math.max(5, effort)), richContexts = effort >= 8;
  const plain = () => primed?.image === image ? {img: primed.img, shared: primed.shared} : strategyOrderEntry(image, null);
  const authoredOrders = Array.isArray(learned) && (learned.length === 0 || Array.isArray(learned[0])) ? learned.filter(Boolean) : learned ? [learned] : [];
  const skipNatural = !(typeof __RAPIER_JXL_CAPTURE_PHOTO__ !== 'undefined' && __RAPIER_JXL_CAPTURE_PHOTO__ === true) && effort === 7 && both && authoredOrders.length && image.width * image.height > 65536 && !image.alpha && !image.extraChannels?.length;
  const orderList = authoredOrders.length ? (both && !skipNatural ? [null, ...authoredOrders] : authoredOrders) : [null];
  const runs = [];
  if (effort <= 6) for (const authored of orderList) {
    const entry = authored ? strategyOrderEntry(image, authored) : plain();
    const seedLf = effort === 6 && authoredOrders.length ? lfCoderFor(7) : lf;
    runs.push({...entry, plan: {clusters: BUDGETS[0], coding: buildAnsCoding, modularAns: writeModularAnsHistograms, lfCoder: image[PLAN_LF] ?? seedLf, ...(image.lowDesigns && {designs: image.lowDesigns})}});
  }
  else for (const authored of orderList) {
    const {img, shared} = authored ? strategyOrderEntry(image, authored) : plain();
    if (image.width * image.height <= PREFIX_PIXELS) runs.push({img, shared, plan: {clusters: BUDGETS[0]}});
    if (richContexts) runs.push({img, shared, plan: {clusters: BUDGETS[0], coding: buildAnsCoding, modularAns: writeModularAnsHistograms, lfCoder: lf}});
    for (const clusters of budgets) runs.push({img, shared, plan: {clusters, coding: buildAnsCoding, modularAns: writeModularAnsHistograms, lfCoder: lf, ...(richContexts || effort >= 7 ? {richContexts: true} : {})}});
  }
  return runs;
}
export function* strategyAnsSteps(image, effort = 7, learned = null, pooled = false, primed = null, both = true) {
  const runs = strategyAnsRuns(image, effort, learned, primed, both);
  let best = null;
  ansCodingsKept(true);
  if (!pooled && journaling()) try {
    const plain = plainJournal({aborted: false}), drain = steps => { let step; while (!(step = journalNext(steps, undefined, plain)).done); return step.value; };
    const smallest = list => {
      let kept = null;
      list.forEach(({img, shared, plan}, k) => { const file = drain(varDCTSteps(img, plan, shared)); if (!kept || file.length < kept.length) kept = {length: file.length, file, k}; });
      return kept;
    };
    for (let at = 0; at < runs.length;) {
      let end = at + 1;
      while (end < runs.length && runs[end].shared === runs[at].shared) end++;
      for (const list of [runs.slice(at, at + 1), runs.slice(at + 1, end)]) {
        if (!list.length) continue;
        const run = yield* unit('ans-run', () => smallest(list));
        if (!best || run.length < best.length) best = {...run, written: list[run.k]};
      }
      at = end;
    }
    return shown(best.file, best.written.img, best.written.plan);
  } finally { ansCodingsKept(false); }
  try {
    for (let at = 0; at < runs.length; at++) {
      const {img, shared, plan} = runs[at], candidate = varDCTSteps(img, pooled ? {...plan, pooled: true, abortable: !!best, ...(pooled === 'split' ? {splitGroups: true} : {})} : plan, shared);
      let settled = false, hurry = false;
      try {
        let step, reply;
        while (!(step = candidate.next(reply)).done) {
          const value = step.value, response = yield scaled(value, done => (at + done) / runs.length);
          reply = typeof value === 'number' ? undefined : response;
          if (typeof value === 'number' ? response : !value?.gpu && !journalRequest(value) && (response === null || response?.hurried)) hurry = true;
        }
        if (pooled && step.value === null) {
          if (!best) throw fault('JXL_INTERNAL', 'coefficient-ans:ac-2');
          settled = true; return best;
        }
        if (!best || step.value.length < best.length) best = step.value;
        settled = true;
        if (hurry) return best;
      } finally {
        closeCandidate(candidate, !settled);
      }
    }
  } finally { ansCodingsKept(false); }
  return best;
}

export function estimateBytes(image, primed = null) {
  const plan = {clusters: BUDGETS[0], coding: buildAnsCoding, modularAns: writeModularAnsHistograms, lfCoder: lfCoderFor(5), estimate: true};
  const img = {...image, authoredOrderPasses: null}, shared = {};
  if (primed) Object.assign(primed, {image, img, shared});
  const value = complete(varDCTSteps(img, plan, shared));
  return typeof value === 'number' ? value : value.length;
}

export function* withProgressive(enabled, steps, effort) {
  if (!enabled) return yield* steps;
  const written = new WeakMap();
  return yield* progressiveLayout(yield* progressiveProbe(steps, written), written, effort);
}
export function* progressiveProbe(steps, written) {
  const stop = watchShown((bytes, picture, plan) => { if (plan && !plan.pooled) written.set(bytes, {picture, plan}); });
  try { return yield* progressiveSearch(steps, written); } finally { stop(); }
}
export function* progressiveLayout(value, written, effort) {
  const bytes = value instanceof Uint8Array ? value : value?.bytes;
  if (!bytes) return value;
  const plain = written.get(bytes) ?? written.kept?.find(kept => sameBytes(kept.bytes, bytes));
  const image = plain && progressiveImage(plain.picture);
  const laid = journaling() ? yield* unit('progressive', () => plain?.laid ?? (image?.progressiveOrders ? complete(passes(image, plain.plan, effort, bytes.length)) : bytes), undefined, true)
    : plain?.laid ?? (image?.progressiveOrders ? yield* passes(image, plain.plan, effort, bytes.length) : bytes);
  return value instanceof Uint8Array ? laid : {...value, bytes: laid};
}
export function* progressiveTwin(bytes, effort) {
  const laid = yield* passesKept(bytes, effort);
  return laid ? {progressiveValue: bytes, progressiveLaid: laid} : bytes;
}
export function* passesKept(bytes, effort) {
  if (!(typeof __RAPIER_JXL_PROGRESSIVE__ === 'undefined' || __RAPIER_JXL_PROGRESSIVE__ === true)) return null;
  const plain = journaling() && progressiveWritten()?.get(bytes), image = plain && progressiveImage(plain.picture);
  return image?.progressiveOrders ? yield* unit('progressive-twin', () => complete(passes(image, plain.plan, effort, bytes.length))) : null;
}
export const progressiveCarried = body => !(typeof __RAPIER_JXL_PROGRESSIVE__ === 'undefined' || __RAPIER_JXL_PROGRESSIVE__ === true) ? body : function* () {
  const value = yield* body(), written = journaling() && progressiveWritten(), bytes = value instanceof Uint8Array ? value : value?.bytes;
  const laid = written && bytes && (written.get(bytes) ?? written.kept?.find(kept => sameBytes(kept.bytes, bytes)))?.laid;
  return laid ? {progressiveValue: value, progressiveLaid: laid} : value;
};
export function progressiveKept(stored) {
  if (!(typeof __RAPIER_JXL_PROGRESSIVE__ === 'undefined' || __RAPIER_JXL_PROGRESSIVE__ === true) || !stored?.progressiveLaid) return stored;
  const value = stored.progressiveValue;
  keptPasses(value instanceof Uint8Array ? value : value.bytes, stored.progressiveLaid);
  return value;
}
export function keptPasses(bytes, laid) {
  const written = (typeof __RAPIER_JXL_PROGRESSIVE__ === 'undefined' || __RAPIER_JXL_PROGRESSIVE__ === true) && progressiveWritten();
  if (!written || !laid) return;
  const kept = {bytes, laid};
  written.set(bytes, kept);
  (written.kept ??= []).push(kept);
}
const sameBytes = (a, b) => { if (a.length !== b.length) return false; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false; return true; };
let p0Ord = null;
const passCoding = !(typeof __RAPIER_JXL_PROGRESSIVE__ === 'undefined' || __RAPIER_JXL_PROGRESSIVE__ === true) ? null : (counts, opts) => buildAnsCoding(counts, {...opts, passes: Math.max(opts.passes ?? 2, 2), everyConfig: true, switchCost: opts.switchCost ?? 5, mapLz: true});
function* passes(image, {pooled, abortable, splitGroups, countGroups, lfGroup, writeGroups, estimate, ...plan}, effort, plainLen = 0) {
  if (!(typeof __RAPIER_JXL_PROGRESSIVE__ === 'undefined' || __RAPIER_JXL_PROGRESSIVE__ === true)) return null;
  const upload = typeof __RAPIER_JXL_UPLOAD__ !== 'undefined' && __RAPIER_JXL_UPLOAD__ === true;
  const lfCoder = !upload && effort >= 6 ? monotonicLfCoderFor(9) : (plan.lfCoder ?? (effort >= 2 ? lfCoderFor(Math.min(effort, 3)) : undefined));
  const ord1 = !upload && image.authoredOrderPasses?.[0];
  const ord = ord1 ? [p0Ord ||= prepareCoefficientOrders({}, 1)[0], ord1] : null;
  const base = {...plan, fast: plan.fast, lfCoder, orders: ord ? undefined : (plan.orders ?? (effort >= 2 && !image.strategyData ? complete(coefficientOrderSteps(image.components)) : undefined)), coding: effort < 6 ? plan.coding : passCoding}, img = {...image, authoredOrderPasses: ord, progressiveOrders: null};
  const quick = effort >= 2 && effort < 6;
  let laid = yield* varDCTSteps(quick ? {...img, progression: lfSplitProgression()} : img, base);
  if (!quick && plainLen && laid.length * 1000 >= plainLen * 1009) {
    const split = yield* varDCTSteps({...img, progression: lfSplitProgression()}, base);
    if (laid.length * 1000 >= (plainLen && plan.lfCoder ? plainLen : split.length) * 1009 && split.length < laid.length) laid = split;
  }
  return laid;
}
