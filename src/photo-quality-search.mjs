// SPDX-License-Identifier: MIT
import {fault} from './fault.mjs';

export function photoTarget(target) {
  if (!target || typeof target !== 'object' || Array.isArray(target))
    throw fault('JXL_INPUT', 'Target names ssimulacra2, butteraugli or butteraugli3.');
  const out = {};
  for (const [key, value] of Object.entries(target)) {
    if (!['ssimulacra2', 'butteraugli', 'butteraugli3'].includes(key))
      throw fault('JXL_INPUT', `Target ${key} is not ssimulacra2, butteraugli or butteraugli3.`);
    if (typeof value !== 'number' || !Number.isFinite(value) || (key === 'ssimulacra2' ? value > 100 : value <= 0))
      throw fault('JXL_INPUT', `Target ${key} is out of range.`);
    out[key] = value;
  }
  if (!Object.keys(out).length) throw fault('JXL_INPUT', 'Target names ssimulacra2, butteraugli or butteraugli3.');
  return out;
}

export function meets(scores, target) {
  return (target.ssimulacra2 === undefined || scores.ssimulacra2 >= target.ssimulacra2)
    && (target.butteraugli3 === undefined || scores.butteraugli3 <= target.butteraugli3)
    && (target.butteraugli === undefined || scores.butteraugli <= target.butteraugli);
}
function margin(scores, target) {
  const m = [];
  if (target.ssimulacra2 !== undefined) m.push(scores.ssimulacra2 - target.ssimulacra2);
  if (target.butteraugli3 !== undefined) m.push((target.butteraugli3 - scores.butteraugli3) / (0.04 * target.butteraugli3));
  if (target.butteraugli !== undefined) m.push((target.butteraugli - scores.butteraugli) / (0.04 * target.butteraugli));
  return Math.min(...m);
}

function searchStep(tried, pass, {low, high, aim, close}) {
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
    const slope = a && b.q !== a.q ? Math.max(0.2, (b.m - a.m) / (b.q - a.q)) : 0.8;
    next = Math.max(low, Math.min(high, q + (aim - m) / slope));
    if (next === q) return {stop: true};
  }
  return {next: Math.round(next * 100) / 100};
}

function marginDoubt(scores, target) {
  const d = scores.doubt;
  if (!d) return 0;
  let out = 0;
  if (target.ssimulacra2 !== undefined) out = Math.max(out, d.ssimulacra2 ?? 0);
  if (target.butteraugli3 !== undefined) out = Math.max(out, (d.butteraugli3 ?? 0) / (0.04 * target.butteraugli3));
  if (target.butteraugli !== undefined) out = Math.max(out, (d.butteraugli ?? 0) / (0.04 * target.butteraugli));
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

export function* qualitySteps(imageAt, target, {start = 85, probes = 8, low = 20, high = 99.99, aim = 0.05, lastAim = aim, close = 0.12, targetDoubt = null, initial = null, first = null, measureSteps = null, seen = null} = {}) {
  const want = {ssimulacra2: target.ssimulacra2 !== undefined, butteraugli: target.butteraugli3 !== undefined || target.butteraugli !== undefined}, tried = [];
  const options = {low, high, aim, close};
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
  if (!best) {
    const observed = yield* read(yield* imageAt(high), {...want, exact: true}, {quality: high});
    best = {quality: high, scores: observed.scores, ...(observed.output && {output: observed.output})};
    remember(high, best.scores);
  }
  return {...best, bestObserved};
}

export {margin as qualityMargin, marginDoubt as qualityMarginDoubt,
  searchStep as qualitySearchStep, undecided as qualityUndecided};
