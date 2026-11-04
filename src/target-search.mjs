// SPDX-License-Identifier: MIT
import {extractFitStats, predictFitBytes} from './fit-model.mjs';
export function* targetSearch(targetBytes, {minQuality, maxQuality, maxProbes, initialQuality = null}) {
  let best = null, smallestBytes = null, stop = false;
  const probes = [];
  function* probe(quality) {
    const reply = yield quality, bytes = reply?.bytes ?? null, length = bytes?.byteLength ?? null;
    stop ||= !!reply?.stop;
    probes.push(Object.freeze({quality, bytes: length}));
    if (length !== null) {
      smallestBytes = Math.min(smallestBytes ?? Infinity, length);
      if (length <= targetBytes && (!best || quality > best.quality)) best = {bytes, quality};
    }
  }
  yield* probe(maxQuality);
  if (!best && initialQuality !== null && initialQuality !== maxQuality && probes.length < maxProbes)
    yield* probe(initialQuality);
  if (best?.quality !== maxQuality && probes.length < maxProbes && minQuality !== maxQuality &&
      minQuality !== initialQuality && !(stop && best)) yield* probe(minQuality);
  if (best?.quality !== maxQuality && minQuality !== maxQuality) {
    for (const fraction of [.75, .5, .25, .875, .625, .375, .125]) {
      if (probes.length >= maxProbes || stop && best) break;
      const quality = minQuality + (maxQuality - minQuality) * fraction;
      if (!probes.some(row => row.quality === quality)) yield* probe(quality);
    }
    while (probes.length < maxProbes && !(stop && best)) {
      const ordered = probes.map(row => row.quality).sort((a, b) => a - b);
      let low, high;
      if (best) {
        low = best.quality; high = ordered.find(value => value > low);
      } else {
        const anchor = probes.reduce((a, b) => (b.bytes ?? Infinity) < (a.bytes ?? Infinity) ? b : a).quality;
        const at = ordered.indexOf(anchor), left = at ? anchor - ordered[at - 1] : -1;
        const right = at + 1 < ordered.length ? ordered[at + 1] - anchor : -1;
        if (right >= left) { low = anchor; high = ordered[at + 1]; }
        else { low = ordered[at - 1]; high = anchor; }
      }
      const quality = (low + high) / 2;
      if (!Number.isFinite(quality) || quality === low || quality === high) break;
      yield* probe(quality);
    }
  }
  return Object.freeze({bytes: best?.bytes ?? null, quality: best?.quality, targetBytes,
    smallestBytes, probes: Object.freeze(probes)});
}

const distance = q => q >= 30 ? 0.1 + (100 - q) * 0.09 : 53 / 3000 * q * q - 23 / 20 * q + 25;
const quality = d => d <= 6.4 ? 100 - (d - 0.1) / 0.09
  : (23 / 20 - Math.sqrt((23 / 20) ** 2 - 4 * 53 / 3000 * (25 - d))) / (2 * 53 / 3000);
const SLOPE = -0.8, AREA = 0.82, FRACTIONS = 2, AIM = .999;
export function* fitSearch(targetBytes, {minQuality, maxQuality, maxProbes, rates, area, picture, effort = 3}) {
  let best = null, smallestBytes = null, stop = false, halve = false, poor = 0, fractions = 0;
  const stats = picture && extractFitStats(picture), model = stats && !stats.isScreen ? q => predictFitBytes(stats, q, effort).total : null;
  const solve = (size, cap) => {
    if (!(size(minQuality) <= cap)) return NaN;
    let low = minQuality, high = maxQuality;
    for (let i = 0; i < 28; i++) { const mid = (low + high) / 2; if (size(mid) <= cap) low = mid; else high = mid; }
    return low;
  };
  const probes = [];
  function* probe(q) {
    const reply = yield q, bytes = reply?.bytes ?? null, length = bytes?.byteLength ?? null;
    stop ||= !!reply?.stop;
    probes.push(Object.freeze({quality: q, bytes: length}));
    if (length !== null) {
      rates?.push({quality: q, bytes: length, area});
      smallestBytes = Math.min(smallestBytes ?? Infinity, length);
      if (length <= targetBytes && (!best || q > best.quality)) best = {bytes, quality: q};
    }
  }
  const aim = (a, b, cap) => {
    if (!a) return NaN;
    if (!b && model && probes.length === 1) {
      const at = model(a.quality);
      return solve(q => { const ratio = model(q) / at; return a.bytes * ratio ** (ratio >= 1 ? 1.08 : .95); }, cap);
    }
    const slope = b ? Math.log(b.bytes / a.bytes) / Math.log(distance(b.quality) / distance(a.quality)) : SLOPE;
    return slope < -0.2 ? quality(distance(a.quality) * (cap / a.bytes) ** (1 / slope)) : NaN;
  };
  const bracket = () => {
    const low = best?.quality ?? minQuality;
    const misses = probes.filter(row => (row.bytes ?? Infinity) > targetBytes && row.quality > low)
      .sort((a, b) => a.quality - b.quality);
    const top = misses[0]?.quality ?? (probes.some(row => row.quality === maxQuality) ? maxQuality : maxQuality + 1);
    return {misses: misses.filter(row => row.bytes !== null), first: Math.floor(low) + 1, last: Math.ceil(top) - 1, top};
  };
  const start = () => {
    const scaled = rates.map(row => ({quality: row.quality, bytes: row.bytes * (area / row.area) ** AREA}));
    const over = scaled.filter(row => row.bytes > targetBytes).reduce((a, b) => !a || b.quality < a.quality ? b : a, null);
    const under = scaled.filter(row => row.bytes <= targetBytes).reduce((a, b) => !a || b.quality > a.quality ? b : a, null);
    const q = Math.floor(aim(over ?? under, over && under, targetBytes));
    return !(q < maxQuality) ? maxQuality : q > minQuality ? q : minQuality;
  };
  const nearest = miss => {
    const fit = probes.find(row => row.quality === best.quality);
    const below = probes.filter(row => row.bytes !== null && row.quality < fit.quality && row.bytes < fit.bytes)
      .reduce((a, b) => !a || b.quality > a.quality ? b : a, null);
    return [fit, below && (!miss || fit.quality - below.quality < miss.quality - fit.quality) ? below : miss];
  };
  const first = model && !(model(maxQuality) <= targetBytes * 1.3) ? Math.floor(solve(model, targetBytes * .988)) : NaN;
  yield* probe(rates?.length ? start() : first >= minQuality && first < maxQuality ? first : maxQuality);
  while (best?.quality !== maxQuality && minQuality !== maxQuality && probes.length < maxProbes && !(stop && best)) {
    if (!best && probes.some(row => row.quality === minQuality)) {
      const untried = [];
      for (let q = Math.floor(minQuality) + 1; q < maxQuality; q++) if (!probes.some(row => row.quality === q)) untried.push(q);
      const last = probes.at(-1);
      if (!untried.length || untried.length > maxProbes - probes.length && !(last.bytes !== null && last.bytes <= targetBytes * 1.05)) break;
      yield* probe(untried[0]);
      continue;
    }
    const {misses, first, last, top} = bracket();
    if (first > last) {
      if (!best) { yield* probe(minQuality); continue; }
      if (fractions++ === FRACTIONS || top > maxQuality) break;
      const fit = probes.find(row => row.quality === best.quality), aimed = aim(misses[0], fit, targetBytes * AIM);
      let q = Number.isNaN(aimed) ? (best.quality + top) / 2 : aimed;
      if (!(q > best.quality && q < top)) q = (best.quality + top) / 2;
      if (!(q > best.quality && q < top)) break;
      yield* probe(q);
      continue;
    }
    let next = Math.floor((first + last) / 2);
    if (!halve) next = Math.floor(best ? aim(...nearest(misses[0]), targetBytes)
      : aim(misses[0], misses[1], targetBytes * .95));
    if (Number.isNaN(next) && best) next = Math.floor((first + last) / 2);
    if (next > last) next = last;
    if (next >= maxQuality) next = maxQuality;
    if (!(next >= first)) { if (!best) { yield* probe(minQuality); continue; } next = first; }
    const span = last - first;
    yield* probe(next);
    const {first: low, last: high} = bracket();
    if (!halve && high - low > Math.max(1, span / 2) && ++poor === 3) halve = true;
  }
  return Object.freeze({bytes: best?.bytes ?? null, quality: best?.quality, targetBytes,
    smallestBytes, probes: Object.freeze(probes)});
}
