// SPDX-License-Identifier: MIT
import {fault} from './fault.mjs';
import {BitWriter, complete} from './bits.mjs';
import {unit, stage, journaling, readAll} from './step-journal.mjs';
import {lfPlanFor, monotonicLfPlanFor} from './lf-plans.mjs';
import {planeModel, planeModelOf, planeTreeSteps, weightedTrees} from './capture-trees.mjs';
import {writeCaptureStream, writeCaptureStreamExtra, runModels} from './capture-modular-stream.mjs';
import {CAPTURE_ANS, writeCrossChannelAns} from './capture-ans.mjs';
import {RUNGS} from './lf-options.mjs';
export {RUNGS} from './lf-options.mjs';
import {kernelHooks} from './kernel-hooks.mjs';
import {losslessCoding} from './lossless-coding.mjs';
import {offloading, offloadWorkers} from './offload.mjs';

const fits16 = data => {
  if (data instanceof Int16Array) return data;
  for (const value of data) if (value < -32768 || value > 32767) return null;
  return Int16Array.from(data);
};

const LEARNED = [], LEARNED_KEEP = 128;
const sameSamples = (a, b) => { if (a.length !== b.length) return false; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false; return true; };
const sameStream = (a, b) => a.at === b.at && a.pending === b.pending && a.acc === b.acc && sameSamples(a.bytes.subarray(0, a.at), b.bytes.subarray(0, b.at));
const lfDataHash = (planes, data) => {
  let h = 2166136261;
  for (let i = 0; i < planes.length; i++) {
    h = Math.imul(h ^ planes[i].w, 16777619); h = Math.imul(h ^ planes[i].h, 16777619);
    const d = data[i], step = Math.max(1, d.length >>> 5);
    for (let j = 0; j < d.length; j += step) h = Math.imul(h ^ d[j], 16777619);
    if (d.length) h = Math.imul(h ^ d[d.length - 1], 16777619);
  }
  return h >>> 0;
};

export function learnedLfStream(planes, data, options, fallback, together) {
  const hash = lfDataHash(planes, data);
  return LEARNED.find(e => e.hash === hash && e.options === options && e.together === together && e.data.length === data.length &&
    planes.every((p, i) => p.w === e.shapes[i][0] && p.h === e.shapes[i][1] && sameSamples(data[i], e.data[i])) && sameStream(fallback, e.fallback))?.chosen;
}
export function retainLearnedLfStream(planes, data, options, fallback, together, chosen) {
  LEARNED.unshift({hash: lfDataHash(planes, data), options, together, shapes: planes.map(p => [p.w, p.h]), data: data.map(d => d.slice()), fallback, chosen});
  if (LEARNED.length > LEARNED_KEEP) LEARNED.pop();
}

const STEP_SAMPLES = 16384, ran = function* (name, run) { return run(); };
const stepped = planes => journaling() && planes.reduce((n, p) => n + p.w * p.h, 0) >= STEP_SAMPLES;
function* own(planes, steps) { return stepped(planes) ? yield* steps : complete(steps); }
const learnedSteps = (typeof __RAPIER_JXL_UPLOAD__ !== 'undefined' && __RAPIER_JXL_UPLOAD__ === true) ? null : function* learnedSteps(w, planes, options, plain, together, kernels) {
  const step = stepped(planes) ? unit : ran;
  const data = planes.map(p => fits16(p.data));
  const fallback = Object.assign(new BitWriter(0), yield* step('lf-plain', () => { const f = new BitWriter(256); plain(f); return {...f, bytes: f.bytes.slice(0, f.at + 1)}; }));
  if (data.includes(null) || planes.some(p => !p.w || !p.h)) { w.append(fallback); return; }
  const learn = learnOptions(options), hit = step === ran && learnedLfStream(planes, data, learn, fallback, together);
  if (hit) { w.append(hit); return; }
  const same = together && learn.references && planes.every(p => p.w === planes[0].w && p.h === planes[0].h);
  const references = i => {
    if (!together || !learn.references) return [];
    if (same) return data.slice(0, i).reverse();
    if (!(typeof __RAPIER_JXL_RECOMPRESS__ === 'undefined' || __RAPIER_JXL_RECOMPRESS__ === true) || !learn.subsampledReferences) return [];
    const refs = [];
    for (let j = i - 1; j >= 0; j--) if (planes[j].w === planes[i].w && planes[j].h === planes[i].h) refs.push(data[j]);
    return refs;
  };
  const models = [];
  for (let i = 0; i < planes.length; i++) models.push(step === unit ? yield* stage('lf-tree', () => planeTreeSteps(data[i], planes[i].w, planes[i].h, learn, references(i)))
    : planeModel(data[i], planes[i].w, planes[i].h, learn, references(i)));
  const written = (name, form) => step(name, () => {
    const chosen = form(readAll(models).map((model, i) => model?.pieceValue ? model : planeModelOf(data[i], planes[i].w, planes[i].h, model, references(i))));
    if (!chosen) return null;
    const c = new BitWriter(256);
    if ((typeof __RAPIER_JXL_EFFORT_TEN__ === 'undefined' || __RAPIER_JXL_EFFORT_TEN__ === true) && learn.ansExtra) writeCaptureStreamExtra(writeCrossChannelAns, c, chosen, learn.ans ? ANS : null);
    else writeCaptureStream(c, chosen, learn.ans ? (learn.crossAns && ANS_CROSS ? ANS_CROSS : ANS) : null);
    return {...c, bytes: c.bytes.slice(0, c.at + 1)};
  });
  const plainStream = Object.assign(new BitWriter(0), yield* written('lf-stream', chosen => chosen)), runs = yield* written('lf-runs', runModels);
  const runsStream = runs && Object.assign(new BitWriter(0), runs), candidate = runsStream && runsStream.bitLength < plainStream.bitLength ? runsStream : plainStream;
  const chosen = candidate.bitLength < fallback.bitLength ? candidate : fallback;
  if (step === ran) retainLearnedLfStream(planes, data, learn, fallback, together, chosen);
  w.append(chosen);
};
const learned = (typeof __RAPIER_JXL_UPLOAD__ !== 'undefined' && __RAPIER_JXL_UPLOAD__ === true) ? null : (w, planes, options, plain, together, kernels) => complete(learnedSteps(w, planes, options, plain, together, kernels));

const LEAST_SAMPLES = 8192;
const LF_CHARGE = 8;
const ANS = CAPTURE_ANS, ANS_CROSS = (typeof __RAPIER_JXL_UPLOAD__ !== 'undefined' && __RAPIER_JXL_UPLOAD__ === true) ? null
  : Object.freeze({...CAPTURE_ANS, extra: writeCrossChannelAns});
const learners = new Map();
function learnOptions(options) {
  let learn = learners.get(options);
  if (!learn) {
    const made = {nodes: 2 * options.leaves - 1, samples: Math.max(options.samples, LEAST_SAMPLES), bins: options.bins, depth: options.depth, least: options.least ?? ((typeof __RAPIER_JXL_EFFORT_TEN__ === 'undefined' || __RAPIER_JXL_EFFORT_TEN__ === true) && options.charge ? 32 : 64), charge: options.charge ?? LF_CHARGE,
      properties: options.properties.filter(p => p !== 15 || options.weighted !== false), predictors: options.predictors ?? [5, 6, 1, 2, 3, 4, 0],
      referenceKinds: options.referenceKinds ?? [0, 1, 2, 3], references: Boolean(options.references),
      ...(options.subsampledReferences && {subsampledReferences: true}), ...(options.crossAns && {crossAns: true}), ans: Boolean(options.ans), ...((typeof __RAPIER_JXL_EFFORT_TEN__ === 'undefined' || __RAPIER_JXL_EFFORT_TEN__ === true) && options.ansExtra && {ansExtra: true})};
    const key = JSON.stringify(made);
    learn = [...learners.values()].find(l => l.key === key) ?? Object.freeze({...made, key});
    learners.set(options, learn);
  }
  return learn;
}

const coders = new Map();
export function lfCoder(rung = 'fast') {
  if (!coders.has(rung)) {
    const options = typeof rung === 'object' ? rung : RUNGS[rung];
    coders.set(rung, Object.freeze({
      ...(typeof rung === 'string' && {rung}),
      dc: (w, planes, plain, kernels) => learned(w, planes, options, plain, true, kernels),
      dcSteps: (w, planes, plain, kernels) => learnedSteps(w, planes, options, plain, true, kernels),
      metadataSteps: (w, planes, plain, kernels) => learnedSteps(w, planes, options, plain, false, kernels),
      metadata: (w, planes, plain, kernels) => learned(w, planes, options, plain, false, kernels),
    }));
  }
  return coders.get(rung);
}

const FIXED_BINS = [[0, 0, 0]], FIXED_WRITE = Object.freeze({ans: true, hybrid: true, sharing: Object.freeze([])});
function* fixedDcSteps(w, planes, plain, kernels, write = FIXED_WRITE) {
  const data = planes.map(p => fits16(p.data));
  if (data.includes(null) || planes.some(p => !p.w || !p.h)) { plain(w); return; }
  const models = [];
  for (let i = 0; i < planes.length; i++) models.push(yield* unit('lf-trees', () => weightedTrees(data[i], planes[i].w, planes[i].h, FIXED_BINS.map(bins => bins[i] ?? bins[2]))));
  let best = null;
  for (let k = 0; k < FIXED_BINS.length; k++) {
    const written = yield* unit('lf-stream', () => {
      const candidate = new BitWriter(256);
      writeCaptureStream(candidate, readAll(models).map(m => m[k]), write.ans ? ANS : null);
      return {bytes: candidate.bytes, at: candidate.at, pending: candidate.pending, acc: candidate.acc};
    }, c => ({...c, bytes: c.bytes.slice(0, c.at + 1)}));
    const candidate = Object.assign(new BitWriter(0), written);
    if (!best || candidate.bitLength < best.bitLength) best = candidate;
  }
  w.append(best);
}
const fixedDc = (w, planes, plain, kernels, write) => complete(fixedDcSteps(w, planes, plain, kernels, write));
const PROJECTED_WRITE = Object.freeze({...FIXED_WRITE, projected: true});
export const fixedLfCoder = Object.freeze({dc: fixedDc, dcSteps: fixedDcSteps, metadata: (w, planes, plain) => plain(w), plainMetadata: true});

function* plainOrFixedDcSteps(w, planes, plain, kernels) {
  if (!planes.length || planes[0].w * planes[0].h < 256) { plain(w); return; }
  const fixed = new BitWriter(256);
  yield* fixedDcSteps(fixed, planes, plain, kernels, PROJECTED_WRITE);
  const bound = yield* unit('lf-bound', () => plainBound(planes));
  if (bound != null && fixed.bitLength < bound) { w.append(fixed); return; }
  const fallback = Object.assign(new BitWriter(0), yield* unit('lf-plain', () => { const f = new BitWriter(256); plain(f); return {...f, bytes: f.bytes.slice(0, f.at + 1)}; }));
  w.append(fixed.bitLength < fallback.bitLength ? fixed : fallback);
}
export const plainOrFixedLfCoder = /* @__PURE__ */ Object.freeze({
  dc: (w, planes, plain, kernels) => complete(plainOrFixedDcSteps(w, planes, plain, kernels)),
  dcSteps: plainOrFixedDcSteps,
  metadata: (w, _planes, plain) => plain(w),
  plainMetadata: true,
});

const ANS_WORD_LOSS = 2 * Math.log2(17 / 16), ANS_STEP_LOSS = 4096 / (65536 * Math.LN2 * 15 / 16);
export function plainBound(planes) {
  const events = kernelHooks.dcEvents?.(planes);
  if (!events) return null;
  const entropy = freqs => { let n = 0, sum = 0, square = 0; for (const c of freqs) if (c) { n += c; sum += c * Math.log2(c); square += c * c; } return [n ? n * Math.log2(n) - sum : 0, Math.sqrt(square)]; };
  let prefix = 0, ans = 0, norms = 0;
  for (const plane of events) {
    const [residual, hybrid] = losslessCoding(plane), [prefixBits] = entropy(residual.freqs), [ansBits, norm] = entropy(hybrid.freqs);
    prefix += prefixBits + residual.extra; ans += ansBits + hybrid.extra; norms += norm;
  }
  const lower = Math.min(prefix, (ans - ANS_STEP_LOSS * norms + Math.log2(0x130000) + 2 * ANS_WORD_LOSS) / (1 + ANS_WORD_LOSS / 16));
  return lower - 1e-9 * Math.max(prefix, ans) - 4;
}

const quick = /* @__PURE__ */ lfCoder('quick'), kept = [], KEPT_BYTES = 8 << 20;
const planesHash = planes => {
  let h = 2166136261;
  for (const {w, h: ph, data} of planes) { h = Math.imul(h ^ w, 16777619); h = Math.imul(h ^ ph, 16777619); for (let i = 0; i < data.length; i++) h = Math.imul(h ^ data[i], 16777619); }
  return h >>> 0;
};
const samePlanes = (a, b) => a.length === b.length && a.every((p, i) => {
  const q = b[i];
  if (p.w !== q.w || p.h !== q.h || p.data.constructor !== q.data.constructor || p.data.length !== q.data.length) return false;
  for (let j = 0; j < p.data.length; j++) if (p.data[j] !== q.data[j]) return false;
  return true;
});
export const quickOrFixedLfCoder = /* @__PURE__ */ Object.freeze({
  *dcSteps(w, planes, plain, kernels) {
    const keep = !stepped(planes), hash = keep && planesHash(planes), hit = keep && kept.find(k => k.hash === hash && k.kernels === kernels && samePlanes(k.planes, planes));
    if (hit) { w.append(hit.bits); return; }
    const learnt = new BitWriter(256), fixed = new BitWriter(256);
    yield* own(planes, quick.dcSteps(learnt, planes, plain, kernels)); yield* own(planes, fixedDcSteps(fixed, planes, plain, kernels));
    const bits = learnt.bitLength <= fixed.bitLength ? learnt : fixed;
    w.append(bits);
    if (!keep) return;
    const copy = planes.map(({w, h, data}) => ({w, h, data: data.slice()}));
    kept.push({hash, kernels, planes: copy, bits, bytes: copy.reduce((s, p) => s + p.data.byteLength, 0)});
    for (let total = kept.reduce((s, k) => s + k.bytes, 0); total > KEPT_BYTES; ) total -= kept.shift().bytes;
  },
  dc: (w, planes, plain, kernels) => complete(quickOrFixedLfCoder.dcSteps(w, planes, plain, kernels)),
  metadata: quick.metadata,
  metadataSteps: quick.metadataSteps,
});
const stepsOf = (coder, stream) => coder[stream + 'Steps'] ?? function* (w, planes, plain, kernels) { coder[stream](w, planes, plain, kernels); };

const plainOnce = plain => {
  let kept = null;
  const made = () => { if (!kept) { kept = new BitWriter(256); plain(kept); } return kept; };
  return Object.assign(target => target.append(made()), {made});
};
const helpedLf = planes => !journaling() && !stepped(planes) && offloading('score-band') && offloadWorkers() >= 1;
const leavesOf = (coder, out = []) => { if (coder.pair) { leavesOf(coder.pair[0], out); leavesOf(coder.pair[1], out); } else out.push(coder); return out; };
const writerData = w => ({bytes: w.bytes.slice(0, w.at + 1), at: w.at, pending: w.pending, acc: w.acc});
function* treeSteps(coder, stream, w, planes, once, kernels, remote, local) {
  if (coder.pair) {
    const a = new BitWriter(256), b = new BitWriter(256);
    yield* treeSteps(coder.pair[0], stream, a, planes, once, kernels, remote, local); yield* treeSteps(coder.pair[1], stream, b, planes, once, kernels, remote, local);
    w.append(a.bitLength <= b.bitLength ? a : b);
    return;
  }
  if (local.has(coder)) { w.append(local.get(coder)); return; }
  const task = remote.get(coder), got = task && (yield {offload: 'run', task});
  if (got) { w.append(Object.assign(new BitWriter(0), got)); return; }
  yield* own(planes, stepsOf(coder, stream)(w, planes, once, kernels));
}
function* smallerSteps(higher, lower, stream, w, planes, plain, kernels) {
  const a = new BitWriter(256), b = new BitWriter(256), once = plainOnce(plain);
  if (helpedLf(planes)) {
    const root = {pair: [higher, lower]}, leaves = leavesOf(root), remote = new Map(), local = new Map();
    const shown = planes.map(({w, h, data}) => ({w, h, data}));
    for (const leaf of leaves) if (leaf.rung && remote.size < offloadWorkers() && !remote.has(leaf))
      remote.set(leaf, {kind: 'lf-code', rung: leaf.rung, stream, planes: shown, plain: writerData(once.made())});
    if (remote.size) {
      yield {offload: 'prefetch', tasks: [...remote.values()]};
      for (const leaf of leaves) if (!remote.has(leaf) && !local.has(leaf)) {
        const bits = new BitWriter(256);
        yield* own(planes, stepsOf(leaf, stream)(bits, planes, once, kernels));
        local.set(leaf, bits);
      }
      return yield* treeSteps(root, stream, w, planes, once, kernels, remote, local);
    }
  }
  yield* own(planes, stepsOf(higher, stream)(a, planes, once, kernels)); yield* own(planes, stepsOf(lower, stream)(b, planes, once, kernels));
  w.append(a.bitLength <= b.bitLength ? a : b);
}
export function lfCodeOf({rung, stream, planes, plain}) {
  const w = new BitWriter(256), bits = Object.assign(new BitWriter(0), plain);
  complete(stepsOf(lfCoder(rung), stream)(w, planes, target => target.append(bits), null));
  return writerData(w);
}
const smallerLf = (higher, lower) => Object.freeze({pair: [higher, lower], ...Object.fromEntries([
  ['dc', 'dcSteps'], ['metadata', 'metadataSteps'],
].flatMap(([stream, stepName]) => {
  const steps = (w, planes, plain, kernels) => smallerSteps(higher, lower, stream, w, planes, plain, kernels);
  return [[stream, (...args) => complete(steps(...args))], [stepName, steps]];
}))});
const richPair = /* @__PURE__ */ smallerLf(/* @__PURE__ */ lfCoder('richAll'), /* @__PURE__ */ lfCoder('rich'));
const fastPair = /* @__PURE__ */ smallerLf(/* @__PURE__ */ lfCoder('fastAll'), /* @__PURE__ */ lfCoder('fast'));
const broadPair = /* @__PURE__ */ smallerLf(/* @__PURE__ */ lfCoder('broadAll'), /* @__PURE__ */ lfCoder('broad'));
const photoRichLfCoder = /* @__PURE__ */ smallerLf(richPair, quickOrFixedLfCoder);
export const richLfCoder = /* @__PURE__ */ smallerLf(/* @__PURE__ */ lfCoder('rich'), quickOrFixedLfCoder);
export const jpegBroadLfCoder = /* @__PURE__ */ smallerLf(/* @__PURE__ */ lfCoder('jpegBroad'), richLfCoder);
const fastLfCoder = /* @__PURE__ */ smallerLf(/* @__PURE__ */ lfCoder('fast'), richLfCoder);
const photoFastLfCoder = /* @__PURE__ */ smallerLf(fastPair, photoRichLfCoder);
const broadLfCoder = /* @__PURE__ */ smallerLf(/* @__PURE__ */ smallerLf(/* @__PURE__ */ lfCoder('jpegBroad'), broadPair), photoFastLfCoder);
const tenLfCoder = (typeof __RAPIER_JXL_EFFORT_TEN__ === 'undefined' || __RAPIER_JXL_EFFORT_TEN__ === true) ? /* @__PURE__ */ smallerLf(/* @__PURE__ */ lfCoder('ten'), broadLfCoder) : null;
const jpegRichLfCoder = /* @__PURE__ */ smallerLf(/* @__PURE__ */ lfCoder('jpegRich'), richLfCoder);
export const jpegFastLfCoder = /* @__PURE__ */ smallerLf(/* @__PURE__ */ lfCoder('jpegFast'), /* @__PURE__ */ smallerLf(jpegRichLfCoder, fastLfCoder));
export const jpegBroadOrFastLfCoder = /* @__PURE__ */ smallerLf(/* @__PURE__ */ smallerLf(/* @__PURE__ */ lfCoder('jpegFine'), /* @__PURE__ */ lfCoder('jpegAll')), /* @__PURE__ */ smallerLf(/* @__PURE__ */ lfCoder('broad'), jpegFastLfCoder));
export const jpegTenLfCoder = (typeof __RAPIER_JXL_EFFORT_TEN__ === 'undefined' || __RAPIER_JXL_EFFORT_TEN__ === true) &&
  (typeof __RAPIER_JXL_RECOMPRESS__ === 'undefined' || __RAPIER_JXL_RECOMPRESS__ === true)
  ? /* @__PURE__ */ smallerLf(/* @__PURE__ */ lfCoder('jpegTen'), jpegBroadOrFastLfCoder) : null;

const coalescing = coder => Object.freeze({...coder, coalesceCfl: true});
const photoFastPair = (typeof __RAPIER_JXL_UPLOAD__ !== 'undefined' && __RAPIER_JXL_UPLOAD__ === true) ? fastPair
  : /* @__PURE__ */ smallerLf(/* @__PURE__ */ lfCoder('fastAll'), /* @__PURE__ */ lfCoder('fastCross'));
const photoBroadPair = (typeof __RAPIER_JXL_UPLOAD__ !== 'undefined' && __RAPIER_JXL_UPLOAD__ === true) ? broadPair
  : /* @__PURE__ */ smallerLf(/* @__PURE__ */ lfCoder('broadFine'), /* @__PURE__ */ smallerLf(/* @__PURE__ */ lfCoder('broadAll'), /* @__PURE__ */ lfCoder('broadCross')));
const photoFast = /* @__PURE__ */ smallerLf(photoFastPair, photoRichLfCoder);
const photoSeven = /* @__PURE__ */ coalescing(photoRichLfCoder), photoEight = /* @__PURE__ */ coalescing(photoFastPair), photoNine = /* @__PURE__ */ coalescing(photoBroadPair);
const monotonicEight = /* @__PURE__ */ coalescing(photoFast), monotonicNine = /* @__PURE__ */ coalescing(/* @__PURE__ */ smallerLf(/* @__PURE__ */ smallerLf(/* @__PURE__ */ lfCoder('jpegBroad'), photoBroadPair), photoFast));
const photoTen = (typeof __RAPIER_JXL_EFFORT_TEN__ === 'undefined' || __RAPIER_JXL_EFFORT_TEN__ === true) ? /* @__PURE__ */ coalescing(tenLfCoder) : null;

export function lfCoderForPlan(name) {
  switch (name) {
    case 'plain-or-fixed': return plainOrFixedLfCoder;
    case 'quick-or-fixed': return quickOrFixedLfCoder;
    case 'effort-7': return photoSeven;
    case 'effort-8': return photoEight;
    case 'effort-9': return photoNine;
    case 'monotonic-8': return monotonicEight;
    case 'monotonic-9': return monotonicNine;
    case null: case undefined: return undefined;
    case 'effort-10': case 'monotonic-10': if ((typeof __RAPIER_JXL_EFFORT_TEN__ === 'undefined' || __RAPIER_JXL_EFFORT_TEN__ === true)) return photoTen;
    default: throw fault('JXL_INTERNAL', 'lf-coding:policy');
  }
}
export const monotonicLfCoderFor = effort => lfCoderForPlan(monotonicLfPlanFor(effort));
export const lfCoderFor = effort => lfCoderForPlan(lfPlanFor(effort));
