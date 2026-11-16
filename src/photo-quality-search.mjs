// SPDX-License-Identifier: MIT
import {fault} from './fault.mjs';

export {photoTarget} from './photo-target.mjs';

export function meets(scores, target) {
  return target.ssimulacra2 === undefined || scores.ssimulacra2 >= target.ssimulacra2;
}
function margin(scores, target) {
  const m = [];
  if (target.ssimulacra2 !== undefined) m.push(scores.ssimulacra2 - target.ssimulacra2);
  return Math.min(...m);
}

const RAISES = [0.15, 0.5, 1];
const SETTLES = [0.15, 0.5];

function searchStep(tried, pass, {low, high, aim, close, slope: initialSlope}) {
  const {q, m} = tried[tried.length - 1];
  if (pass && m < close) return {stop: true};
  const passes = tried.filter(t => t.m >= 0), fails = tried.filter(t => t.m < 0);
  const p = passes.length && passes.reduce((a, b) => b.q < a.q ? b : a), f = fails.length && fails.reduce((a, b) => b.q > a.q ? b : a);
  let next;
  if (p && f) {
    if (p.q - f.q < 0.02) return {stop: true};
    next = f.q + (aim - f.m) * (p.q - f.q) / (p.m - f.m);
    next = Math.min(p.q - 0.01, Math.max(f.q + 0.1, next));
  } else {
    const [a, b] = tried.length > 1 ? tried.slice(-2) : [null, null];
    const slope = a && b.q !== a.q ? Math.max(0.2, (b.m - a.m) / (b.q - a.q)) : (initialSlope ?? 0.8);
    const stepAim = !pass && initialSlope !== undefined ? Math.max(aim, 0.06) : aim;
    next = Math.max(low, Math.min(high, q + (stepAim - m) / slope));
    if (initialSlope !== undefined && !pass && next < q + 0.1 && q + 0.1 <= high) next = q + 0.1;
    if (next === q) return {stop: true};
  }
  return {next: Math.round(next * 100) / 100};
}

function marginDoubt(scores, target) {
  const d = scores.doubt;
  if (!d) return 0;
  let out = 0;
  if (target.ssimulacra2 !== undefined) out = Math.max(out, d.ssimulacra2 ?? 0);
  return out;
}

function undecided(tried, pass, options) {
  const doubtful = tried.map((t, i) => [t, i]).filter(([t]) => t.d > 0);
  if (!doubtful.length) return false;
  if (doubtful.some(([t]) => Math.abs(t.m) <= t.d)) return true;
  const key = r => r.stop ? 'stop' : String(r.next), base = key(searchStep(tried, pass, options)), last = tried.length - 1;
  for (let corner = 0; corner < 1 << Math.min(doubtful.length, 10); corner++) {
    const moved = tried.slice();
    doubtful.slice(0, 10).forEach(([t, i], k) => { moved[i] = {q: t.q, m: t.m + (corner >> k & 1 ? t.d : -t.d), d: t.d}; });
    if (key(searchStep(moved, moved[last].m >= 0 && pass, options)) !== base) return true;
  }
  return false;
}

export function* qualitySteps(imageAt, target, {start = 85, probes = 8, low = 20, high = 99.99, aim = 0.05, lastAim = aim, close = 0.12, slope, targetDoubt = null, initial = null, first = null, measureSteps = null, seen = null, settle = Infinity} = {}) {
  const want = {ssimulacra2: target.ssimulacra2 !== undefined, butteraugli: false}, tried = [];
  const options = {low, high, aim, close, ...(slope !== undefined && {slope})};
  const targetBound = () => targetDoubt ? marginDoubt({doubt: targetDoubt}, target) : 0;
  const view = () => tried.map(t => ({q: t.q, m: margin(t.scores, target), d: (t.exact ? 0 : marginDoubt(t.scores, target)) + targetBound()}));
  let q = start, best = null, bestObserved = null;
  const read = measureSteps ?? function* (image, want) { return {scores: yield {measure: image, want}}; };
  const remember = (quality, scores) => {
    if (!bestObserved || margin(scores, target) > margin(bestObserved, target))
      bestObserved = {quality, ...Object.fromEntries(Object.keys(target).map(key => [key, scores[key]]))};
  };
  for (let i = 0; i < probes; i++) {
    options.aim = i === probes - 2 ? lastAim : aim;
    const known = !i && initial?.scores && initial.quality === q ? initial : null, kept = known ? null : seen?.get(q);
    let image = known ? known.image : kept ? null : yield* imageAt(q);
    let observed = known ?? kept ?? (yield* read(image, want, {quality: q}));
    if (!known && !kept) seen?.set(q, observed);
    let scores = observed.scores, output = observed.output, pass = meets(scores, target);
    tried.push({q, scores, exact: !scores.doubt});
    if (undecided(view(), pass, options)) {
      if (scores.doubt) {
        observed = yield* read(image ??= yield* imageAt(q), {...want, exact: true}, {quality: q});
        scores = observed.scores; output = observed.output; pass = meets(scores, target);
        tried[tried.length - 1] = {q, scores, exact: true};
        seen?.set(q, observed);
      }
      if (targetBound() > 0 && undecided(view(), pass, options)) { yield {exactTarget: true}; pass = meets(scores, target); }
      for (let k = tried.length - 2; k >= 0; k--) if (!tried[k].exact && undecided(view(), pass, options)) {
        const again = yield* read(yield* imageAt(tried[k].q), {...want, exact: true}, {quality: tried[k].q});
        tried[k] = {q: tried[k].q, scores: again.scores, exact: true};
        seen?.set(tried[k].q, again);
      }
    }
    if (!i && first) Object.assign(first, {quality: q, image: image ?? (yield* imageAt(q)), scores});
    remember(q, scores);
    if (pass && (!best || q < best.quality)) best = {quality: q, scores, ...(output && {output})};
    image = observed = output = initial = null;
    const step = searchStep(view(), pass, options);
    if (step.stop) break;
    q = step.next;
  }
  if (best && margin(best.scores, target) >= settle) {
    const start = Math.max(-Infinity, ...tried.filter(t => !meets(t.scores, target) && t.q < best.quality).map(t => t.q));
    for (const t of SETTLES) {
      const q = Math.round((start + (best.quality - start) * t) * 100) / 100;
      if (!(q > start && q < best.quality)) continue;
      const observed = yield* read(yield* imageAt(q), {...want, exact: true}, {quality: q});
      remember(q, observed.scores);
      tried.push({q, scores: observed.scores, exact: true});
      seen?.set(q, observed);
      if (meets(observed.scores, target)) { best = {quality: q, scores: observed.scores, ...(observed.output && {output: observed.output})}; break; }
    }
    let from = low, failed = false;
    for (const probe of tried) if (!meets(probe.scores, target) && probe.q >= from && probe.q < best.quality) {
      from = probe.q; failed = true;
    }
    while (margin(best.scores, target) >= settle) {
      const middle = Math.round((from + best.quality) * 50) / 100;
      const q = middle > from && middle < best.quality ? middle : failed ? NaN : from;
      if (!(q >= low && q < best.quality)) break;
      const observed = yield* read(yield* imageAt(q), {...want, exact: true}, {quality: q});
      remember(q, observed.scores);
      seen?.set(q, observed);
      if (meets(observed.scores, target)) best = {quality: q, scores: observed.scores, ...(observed.output && {output: observed.output})};
      else { from = q; failed = true; }
    }
  }
  if (!best) {
    const top = tried.reduce((a, b) => b.q > a.q ? b : a);
    let from = top.q;
    if (slope !== undefined) {
      const topM = margin(top.scores, target);
      if (topM > -1.0) {
        const q = Math.min(high, Math.round((from + Math.max(0.15, (0.05 - topM) / slope)) * 100) / 100);
        if (q > from && q < high) {
          const observed = yield* read(yield* imageAt(q), {...want, exact: true}, {quality: q});
          remember(q, observed.scores);
          if (meets(observed.scores, target)) best = {quality: q, scores: observed.scores, ...(observed.output && {output: observed.output})};
          else from = q;
        }
      }
    }
    if (!best) for (const t of RAISES) {
      const q = t < 1 ? Math.round((from + (high - from) * t) * 100) / 100 : high;
      if (t < 1 && !(q > from && q < high)) continue;
      const observed = yield* read(yield* imageAt(q), {...want, exact: true}, {quality: q});
      remember(q, observed.scores);
      if (t === 1 || meets(observed.scores, target)) { best = {quality: q, scores: observed.scores, ...(observed.output && {output: observed.output})}; break; }
    }
  }
  return {...best, bestObserved};
}

export {margin as qualityMargin, marginDoubt as qualityMarginDoubt,
  searchStep as qualitySearchStep, undecided as qualityUndecided};
