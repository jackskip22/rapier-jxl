// SPDX-License-Identifier: MIT
import {BitWriter} from './bits.mjs';
import {sampledPlanes, SAMPLE_RUNGS} from './sampled.mjs';

const BROAD = {...SAMPLE_RUNGS.broad, references: true, referenceKinds: [0, 1, 2, 3]};
export const RUNGS = {broad: BROAD, fast: {...BROAD, samples: 16384, bins: 64},
  rich: {...BROAD, samples: 4096, bins: 32, leaves: 32, depth: 8}, quick: {...BROAD, samples: 2048, bins: 16, leaves: 16, depth: 6}};

const fits16 = data => {
  if (data instanceof Int16Array) return data;
  for (const value of data) if (value < -32768 || value > 32767) return null;
  return Int16Array.from(data);
};

function learned(w, planes, options, plain, together) {
  const data = planes.map(p => fits16(p.data));
  const fallback = new BitWriter(256);
  plain(fallback);
  if (data.includes(null) || planes.some(p => !p.w || !p.h)) { w.append(fallback); return; }
  const same = together && planes.every(p => p.w === planes[0].w && p.h === planes[0].h && p.w * p.h > 0);
  const plans = same ? sampledPlanes.prepareSet(data, planes[0].w, planes[0].h, options)
    : planes.map((p, i) => sampledPlanes.prepare(data[i], p.w, p.h, {...options, references: false}));
  const candidate = new BitWriter(256);
  sampledPlanes.write(candidate, plans, options);
  w.append(candidate.bitLength < fallback.bitLength ? candidate : fallback);
}

const coders = new Map();
export function lfCoder(rung = 'fast') {
  if (!coders.has(rung)) {
    const options = typeof rung === 'object' ? rung : RUNGS[rung];
    coders.set(rung, Object.freeze({
      dc: (w, planes, plain) => learned(w, planes, options, plain, true),
      metadata: (w, planes, plain) => learned(w, planes, options, plain, false),
    }));
  }
  return coders.get(rung);
}

export const lfCoderFor = effort => effort >= 5 ? lfCoder(effort >= 9 ? 'broad' : effort >= 8 ? 'fast' : effort >= 7 ? 'rich' : 'quick') : undefined;
