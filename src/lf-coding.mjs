// SPDX-License-Identifier: MIT
import {BitWriter} from './bits.mjs';
import {sampledPlanes, SAMPLE_RUNGS} from './sampled.mjs';

const BROAD = {...SAMPLE_RUNGS.broad, references: true, referenceKinds: [0, 1, 2, 3]};
export const RUNGS = {broad: BROAD, jpegBroad: {...BROAD, clustered: true}, fast: {...BROAD, samples: 16384, bins: 64},
  rich: {...BROAD, samples: 4096, bins: 32, leaves: 32, depth: 8}, quick: {...BROAD, samples: 2048, bins: 16, leaves: 16, depth: 6}};

const fits16 = data => {
  if (data instanceof Int16Array) return data;
  for (const value of data) if (value < -32768 || value > 32767) return null;
  return Int16Array.from(data);
};

const LEARNED = [], LEARNED_KEEP = 32;
const sameSamples = (a, b) => { if (a.length !== b.length) return false; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false; return true; };
const sameStream = (a, b) => a.at === b.at && a.pending === b.pending && a.acc === b.acc && sameSamples(a.bytes.subarray(0, a.at), b.bytes.subarray(0, b.at));

function learned(w, planes, options, plain, together, kernels) {
  const data = planes.map(p => fits16(p.data));
  const fallback = new BitWriter(256);
  plain(fallback);
  if (data.includes(null) || planes.some(p => !p.w || !p.h)) { w.append(fallback); return; }
  const hit = LEARNED.find(e => e.options === options && e.together === together && e.data.length === data.length &&
    planes.every((p, i) => p.w === e.shapes[i][0] && p.h === e.shapes[i][1] && sameSamples(data[i], e.data[i])) && sameStream(fallback, e.fallback));
  if (hit) { w.append(hit.chosen); return; }
  const same = together && planes.every(p => p.w === planes[0].w && p.h === planes[0].h && p.w * p.h > 0);
  const plans = same ? sampledPlanes.prepareSet(data, planes[0].w, planes[0].h, options)
    : planes.map((p, i) => sampledPlanes.prepare(data[i], p.w, p.h, {...options, references: false}));
  const candidate = new BitWriter(256);
  sampledPlanes.write(candidate, plans, kernels ? {...options, kernels} : options);
  const chosen = candidate.bitLength < fallback.bitLength ? candidate : fallback;
  LEARNED.unshift({options, together, shapes: planes.map(p => [p.w, p.h]), data: data.map(d => d.slice()), fallback, chosen});
  if (LEARNED.length > LEARNED_KEEP) LEARNED.pop();
  w.append(chosen);
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

const FIXED_BINS = [16, 8, 8], FIXED_WRITE = Object.freeze({ans: true, hybrid: true, sharing: Object.freeze([])});
function fixedDc(w, planes, plain, kernels) {
  const data = planes.map(p => fits16(p.data));
  if (data.includes(null) || planes.some(p => !p.w || !p.h)) { plain(w); return; }
  sampledPlanes.write(w, planes.map((p, i) => sampledPlanes.fixed(data[i], p.w, p.h, FIXED_BINS[i] ?? 8)), kernels ? {...FIXED_WRITE, kernels} : FIXED_WRITE);
}
export const fixedLfCoder = Object.freeze({dc: fixedDc, metadata: (w, planes, plain) => plain(w)});

export const plainOrFixedLfCoder = Object.freeze({
  dc(w, planes, plain, kernels) {
    if (!planes.length || planes[0].w * planes[0].h < 256) { plain(w); return; }
    const fallback = new BitWriter(256), fixed = new BitWriter(256);
    plain(fallback); fixedDc(fixed, planes, plain, kernels);
    w.append(fixed.bitLength < fallback.bitLength ? fixed : fallback);
  },
  metadata: (w, _planes, plain) => plain(w),
});

const quick = lfCoder('quick');
export const quickOrFixedLfCoder = Object.freeze({
  dc(w, planes, plain, kernels) {
    const learnt = new BitWriter(256), fixed = new BitWriter(256);
    quick.dc(learnt, planes, plain, kernels); fixedDc(fixed, planes, plain, kernels);
    w.append(learnt.bitLength <= fixed.bitLength ? learnt : fixed);
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

export const monotonicLfCoderFor = effort => effort >= 9 ? broadLfCoder : effort >= 8 ? fastLfCoder : richLfCoder;
export const lfCoderFor = effort => effort >= 9 ? lfCoder('broad') : effort >= 8 ? lfCoder('fast')
  : effort >= 7 ? richLfCoder : effort >= 5 ? quickOrFixedLfCoder : effort >= 3 ? plainOrFixedLfCoder : undefined;
