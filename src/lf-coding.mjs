// SPDX-License-Identifier: MIT
import {BitWriter, complete} from './bits.mjs';
import {unit} from './step-journal.mjs';
import {lfPlanFor, monotonicLfPlanFor} from './lf-plans.mjs';
import {planeModel, weightedTrees} from './capture-trees.mjs';
import {writeCaptureStream} from './capture-codec.mjs';
import {CAPTURE_TOOLS_COMPLETE} from './capture-ans.mjs';
import {RUNGS} from './lf-options.mjs';
export {RUNGS} from './lf-options.mjs';
import {kernelHooks} from './kernel-hooks.mjs';
import {losslessCoding} from './lossless-coding.mjs';

const fits16 = data => {
  if (data instanceof Int16Array) return data;
  for (const value of data) if (value < -32768 || value > 32767) return null;
  return Int16Array.from(data);
};

const LEARNED = [], LEARNED_KEEP = 32;
const sameSamples = (a, b) => { if (a.length !== b.length) return false; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false; return true; };
const sameStream = (a, b) => a.at === b.at && a.pending === b.pending && a.acc === b.acc && sameSamples(a.bytes.subarray(0, a.at), b.bytes.subarray(0, b.at));

export function learnedLfStream(planes, data, options, fallback, together) {
  return LEARNED.find(e => e.options === options && e.together === together && e.data.length === data.length &&
    planes.every((p, i) => p.w === e.shapes[i][0] && p.h === e.shapes[i][1] && sameSamples(data[i], e.data[i])) && sameStream(fallback, e.fallback))?.chosen;
}
export function retainLearnedLfStream(planes, data, options, fallback, together, chosen) {
  LEARNED.unshift({options, together, shapes: planes.map(p => [p.w, p.h]), data: data.map(d => d.slice()), fallback, chosen});
  if (LEARNED.length > LEARNED_KEEP) LEARNED.pop();
}

const learned = (typeof __RAPIER_JXL_UPLOAD__ !== 'undefined' && __RAPIER_JXL_UPLOAD__ === true) ? null : function learned(w, planes, options, plain, together, kernels) {
  const data = planes.map(p => fits16(p.data));
  const fallback = new BitWriter(256);
  plain(fallback);
  if (data.includes(null) || planes.some(p => !p.w || !p.h)) { w.append(fallback); return; }
  const learn = learnOptions(options), hit = learnedLfStream(planes, data, learn, fallback, together);
  if (hit) { w.append(hit); return; }
  const same = together && learn.references && planes.every(p => p.w === planes[0].w && p.h === planes[0].h);
  const models = planes.map((p, i) => planeModel(data[i], p.w, p.h, learn, same ? data.slice(0, i).reverse() : []));
  const candidate = new BitWriter(256);
  writeCaptureStream(candidate, models, learn.ans ? ANS : null);
  const chosen = candidate.bitLength < fallback.bitLength ? candidate : fallback;
  retainLearnedLfStream(planes, data, learn, fallback, together, chosen);
  w.append(chosen);
};

const LEAST_SAMPLES = 8192;
const LF_CHARGE = 8;
const ANS = CAPTURE_TOOLS_COMPLETE.ans;
const learners = new Map();
function learnOptions(options) {
  let learn = learners.get(options);
  if (!learn) {
    const made = {nodes: 2 * options.leaves - 1, samples: Math.max(options.samples, LEAST_SAMPLES), bins: options.bins, depth: options.depth, least: 64, charge: LF_CHARGE,
      properties: options.properties.filter(p => p !== 15 || options.weighted !== false), predictors: options.predictors ?? [5, 6, 1, 2, 3, 4, 0],
      referenceKinds: options.referenceKinds ?? [0, 1, 2, 3], references: Boolean(options.references), ans: Boolean(options.ans)};
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
      dc: (w, planes, plain, kernels) => learned(w, planes, options, plain, true, kernels),
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
      writeCaptureStream(candidate, models.map(m => m[k]), write.ans ? ANS : null);
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

export const plainOrFixedLfCoder = Object.freeze({
  dc(w, planes, plain, kernels) {
    if (!planes.length || planes[0].w * planes[0].h < 256) { plain(w); return; }
    const fixed = new BitWriter(256);
    fixedDc(fixed, planes, plain, kernels, PROJECTED_WRITE);
    const bound = plainBound(planes);
    if (bound != null && fixed.bitLength < bound) { w.append(fixed); return; }
    const fallback = new BitWriter(256);
    plain(fallback);
    w.append(fixed.bitLength < fallback.bitLength ? fixed : fallback);
  },
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

const quick = lfCoder('quick'), kept = [], KEPT_BYTES = 8 << 20;
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
export const quickOrFixedLfCoder = Object.freeze({
  dc(w, planes, plain, kernels) {
    const hash = planesHash(planes), hit = kept.find(k => k.hash === hash && k.kernels === kernels && samePlanes(k.planes, planes));
    if (hit) { w.append(hit.bits); return; }
    const learnt = new BitWriter(256), fixed = new BitWriter(256);
    quick.dc(learnt, planes, plain, kernels); fixedDc(fixed, planes, plain, kernels);
    const bits = learnt.bitLength <= fixed.bitLength ? learnt : fixed;
    w.append(bits);
    const copy = planes.map(({w, h, data}) => ({w, h, data: data.slice()}));
    kept.push({hash, kernels, planes: copy, bits, bytes: copy.reduce((s, p) => s + p.data.byteLength, 0)});
    for (let total = kept.reduce((s, k) => s + k.bytes, 0); total > KEPT_BYTES; ) total -= kept.shift().bytes;
  },
  metadata: quick.metadata,
});

const plainOnce = plain => { let kept = null; return target => { if (!kept) { kept = new BitWriter(256); plain(kept); } target.append(kept); }; };
const smallerLf = (higher, lower) => Object.freeze({
  dc(w, planes, plain, kernels) {
    const a = new BitWriter(256), b = new BitWriter(256), once = plainOnce(plain);
    higher.dc(a, planes, once, kernels); lower.dc(b, planes, once, kernels);
    w.append(a.bitLength <= b.bitLength ? a : b);
  },
  metadata(w, planes, plain, kernels) {
    const a = new BitWriter(256), b = new BitWriter(256), once = plainOnce(plain);
    higher.metadata(a, planes, once, kernels); lower.metadata(b, planes, once, kernels);
    w.append(a.bitLength <= b.bitLength ? a : b);
  },
});
const richLfCoder = smallerLf(lfCoder('rich'), quickOrFixedLfCoder);
const fastLfCoder = smallerLf(lfCoder('fast'), richLfCoder);
const broadLfCoder = smallerLf(smallerLf(lfCoder('jpegBroad'), lfCoder('broad')), fastLfCoder);

export function lfCoderForPlan(name) {
  switch (name) {
    case 'plain-or-fixed': return plainOrFixedLfCoder;
    case 'quick-or-fixed': return quickOrFixedLfCoder;
    case 'effort-7': return richLfCoder;
    case 'effort-8': return lfCoder('fast');
    case 'effort-9': return lfCoder('broad');
    case 'monotonic-8': return fastLfCoder;
    case 'monotonic-9': return broadLfCoder;
    case null: case undefined: return undefined;
    default: throw new TypeError('Unknown named LF policy.');
  }
}
export const monotonicLfCoderFor = effort => lfCoderForPlan(monotonicLfPlanFor(effort));
export const lfCoderFor = effort => lfCoderForPlan(lfPlanFor(effort));
