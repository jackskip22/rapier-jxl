// SPDX-License-Identifier: MIT
import {meets} from './photo-quality-search.mjs';

export function preferredPhotoOutput(best, candidate, target) {
  return meets(candidate.scores, target) && (!best || candidate.bytes.length < best.bytes.length);
}

export function photoOutputMeasurements(target, scores, domain) {
  return Object.keys(target).map(name => ({metric: name, score: scores[name], domain,
    [name === 'ssimulacra2' ? 'floor' : 'limit']: target[name]}));
}

export function photoOutputProgress(fraction, {exact = false, ordinal = 0, probes = 8}) {
  return exact ? .98 + .019 * fraction : Math.min(.97, (ordinal + fraction) / (probes + 2));
}

export function photoOutputConstraintMessage(target, reason, observed, exactConstraint) {
  const bounds = Object.keys(target).map(name => `${name} ${name === 'ssimulacra2' ? '>=' : '<='} ${target[name]}`).join(', ');
  const scores = observed && Object.keys(target).filter(name => Number.isFinite(observed[name]))
    .map(name => `${name} ${observed[name]}`).join(', ');
  return `${reason} Requested ${bounds}.` +
    (scores ? ` Best observed probe at quality ${observed.quality}: ${scores}.` : '') +
    ` Exact coding is unavailable under ${exactConstraint}.`;
}
