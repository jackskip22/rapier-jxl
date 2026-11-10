// SPDX-License-Identifier: MIT
import {qualitySteps} from '../photo-quality-search.mjs';
import {preferredPhotoOutput, photoOutputMeasurements, photoOutputProgress} from '../photo-output-policy.mjs';
import {watchShown} from '../photo-shown.mjs';
import {check, fail} from './primitives.mjs';

export async function withAnnounced(produce, seen) {
  const stop = watchShown(seen);
  try { return await produce(); } finally { stop(); }
}

export async function measuredFileSearch(target, probe, measure, {start = 90, probes = 8, signal, onProgress, exact, closest = false, preview, width, height, domain = 'decoded-output'} = {}) {
  let best = null, near = null, last = null, count = 0, reply = null, search = null;
  try {
    search = qualitySteps(function* (quality) { return yield {encode: quality}; }, target, {start, probes, low: 1, high: 99.99});
    for (;;) {
      check(signal);
      const step = search.next(reply); reply = null;
      if (step.done) break;
      const request = step.value;
      if (request?.encode !== undefined) {
        if (last?.quality !== request.encode) {
          const ordinal = count++;
          last = await probe(request.encode, fraction => onProgress?.(photoOutputProgress(fraction, {ordinal, probes})));
          check(signal);
          if (!(last.bytes instanceof Uint8Array)) throw fail('JXL_INTERNAL', 'A producer must return complete bytes.');
        }
        reply = last;
      } else if (request?.measure) {
        const candidate = request.measure;
        candidate.scores ??= candidate.shown ? measure(candidate.shown, request.want) : null;
        if (!candidate.scores) break;
        preview?.(candidate.bytes, {width, height, measurements: photoOutputMeasurements(target, candidate.scores, domain)});
        reply = candidate.scores;
        if (preferredPhotoOutput(best, candidate, target)) best = candidate;
        else if (!best && (!near || candidate.scores.ssimulacra2 > near.scores.ssimulacra2)) near = candidate;
      } else throw fail('JXL_INTERNAL', 'Unknown measured quality request.');
    }
  } finally { search?.return(); }
  check(signal);
  const kept = best ?? (closest ? near : null);
  if (kept) return {bytes: kept.bytes, quality: kept.quality, exact: false, measurements: photoOutputMeasurements(target, kept.scores, domain)};
  if (!exact) throw fail('JXL_TARGET', 'No tested output could be measured against the requested quality target.');
  const bytes = await exact(fraction => onProgress?.(photoOutputProgress(fraction, {exact: true})));
  check(signal);
  preview?.(bytes, {width, height, measurements: []});
  return {bytes, quality: 100, exact: true, measurements: []};
}
