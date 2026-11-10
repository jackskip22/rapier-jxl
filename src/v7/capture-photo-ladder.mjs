// SPDX-License-Identifier: MIT
import {captureExact, markCaptureExact} from '../capture-codec.mjs';
import {journaled} from '../step-journal.mjs';
import {resultFacts} from './result-reference.mjs';
import {LOW_WEBP_CALIBRATION} from './low-webp-quality.mjs';
import {measuredLevel} from '../effort-level.mjs';

const key = r => `${r.x},${r.y},${r.width},${r.height}`;
export function photoAdmission() {
  const records = new WeakMap();
  const accepts = bytes => captureExact(bytes) || records.get(bytes)?.passed === true;
  const measurements = bytes => captureExact(bytes) ? [] : records.get(bytes)?.measurements ?? [];
  const record = (bytes, passed, measured = []) => {
    records.set(bytes, {passed: passed === true, measurements: passed === true ? measured : [], scored: measured}); return bytes;
  };
  let notes = null;
  const parts = new WeakMap();
  const combine = (into, k, v) => {
    const was = into.get(k), low = v.score !== undefined && !(was?.score <= v.score) ? v : was?.score !== undefined ? was : null;
    into.set(k, {pass: was?.pass !== false && v.pass, ...(low && {score: low.score, floor: low.floor})});
  };
  const note = (bytes, source, pass, m) => {
    if (!notes.has(bytes)) notes.set(bytes, new Map());
    combine(notes.get(bytes), key(source), {pass, ...(m && {score: m.score, floor: m.floor})});
  };
  const scoredOf = bytes => captureExact(bytes) ? [] : records.get(bytes)?.scored ?? [];
  return {record, accepts, measurements, scored: scoredOf,
    join: (bytes, pieces) => { parts.set(bytes, pieces); return record(bytes, pieces.every(accepts), pieces.flatMap(measurements)); },
    frame(sources, bytes) {
      if (!notes) return;
      const scored = scoredOf(bytes), least = scored.reduce((m, s) => s.score < m.score ? s : m, scored[0]);
      for (const s of sources) note(bytes, s, accepts(bytes), least);
    },
    crops(pairs, bytes) {
      if (!notes) return;
      const scored = scoredOf(bytes), whole = accepts(bytes);
      for (const {source, crops} of pairs) {
        const found = crops.map(c => scored.find(s => s.region && s.region.x === c.x && s.region.y === c.y && s.region.width === c.width && s.region.height === c.height));
        const pass = found.every(m => m ? m.score >= m.floor : whole);
        note(bytes, source, pass, found.filter(Boolean).reduce((m, s) => !m || s.score - s.floor < m.score - m.floor ? s : m, null));
      }
    },
    watch() { notes = new Map(); },
    verdicts(file) {
      const seen = notes, out = new Map();
      notes = null;
      if (!seen) return [];
      const visit = (bytes, depth) => {
        if (!bytes || depth > 16) return;
        for (const [k, v] of seen.get(bytes) ?? []) combine(out, k, v);
        for (const p of parts.get(bytes) ?? []) visit(p, depth + 1);
      };
      visit(file, 0);
      return [...out];
    }};
}

const RAISES = [0.15, 0.5, 1], CEILING = LOW_WEBP_CALIBRATION.maximumLossy;
const ROUNDS = 5, AIM = 0.3, CLOSE = 0.75, STEP_DOWN = 1.2, STEP_UP = 0.6, DOWN = 32;
function nextQuality(s) {
  if (s.hi !== null && s.sHi !== undefined && s.sHi - s.floor < CLOSE) return null;
  const aim = s.floor + AIM;
  let q;
  if (s.hi !== null && s.lo !== null) {
    q = s.sHi !== undefined && s.sLo !== undefined && s.sHi > s.sLo ? s.lo + (aim - s.sLo) * (s.hi - s.lo) / (s.sHi - s.sLo) : (s.lo + s.hi) / 2;
    q = Math.min(s.hi - 0.1, Math.max(s.lo + 0.1, q));
    if (s.hi - s.lo < 0.25) return null;
  } else if (s.hi !== null) q = s.sHi !== undefined ? s.hi - (s.sHi - aim) / STEP_DOWN : Math.max(1, s.hi - DOWN / 2);
  else q = s.sLo !== undefined ? s.lo + (aim - s.sLo) / STEP_UP : (s.lo + CEILING) / 2;
  return Math.min(CEILING, Math.max(1, q));
}
const raise = (q, t) => typeof q === 'number' && q < CEILING ? q + (CEILING - q) * t : q;
function raised(coding, t) {
  const {regionQuality} = coding;
  return {...coding, quality: raise(coding.quality, t), ...(regionQuality && {regionQuality: (...a) => raise(regionQuality(...a), t)})};
}

export async function keepSmaller({input, options, hooks, coding, photo, runCaptureUsing, finished, wholePhotoRoute}, candidates, exact = null) {
  const admission = exact && photoAdmission(), n = candidates.length + (admission ? ROUNDS + 1 + RAISES.length + 2 : 0), span = 1 / n;
  let best = null, record = null;
  let slot = 0;
  const run = async (candidate, coder = photo, ownOptions = options) => {
    const from = slot++ * span;
    const made = await journaled(hooks.journal, 'candidate', async () => {
      let got = null;
      const asked = new Map(), read = candidate.regionQuality;
      if (admission && coder === photo) admission.watch();
      const bytes = await runCaptureUsing(input, ownOptions, {
        ...hooks,
        onProgress: hooks.onProgress && (f => { if (f < 1) hooks.onProgress(from + f * span); }),
        onEncoded: r => { got = r; },
      }, read ? {...candidate, regionQuality: (...a) => { const q = read(...a); if (a[2]) asked.set(key(a[2]), q); return q; }} : candidate, coder);
      return {bytes, got, exact: captureExact(bytes), passed: admission ? admission.accepts(bytes) : null, measured: admission ? admission.measurements(bytes) : null,
        asked: [...asked], frames: admission && coder === photo ? admission.verdicts(bytes) : []};
    });
    const {bytes, got} = made;
    if (made.exact && !captureExact(bytes)) markCaptureExact(bytes);
    if (admission && made.passed !== admission.accepts(bytes)) admission.record(bytes, made.passed, made.measured);
    hooks.preview?.(bytes, {measurements: admission?.measurements(bytes) ?? []});
    if ((!admission || admission.accepts(bytes)) && (!best || bytes.length < best.length)) { best = bytes; record = got; }
    return made;
  };
  const searchRegions = async (floor, read) => {
    const state = new Map(), learn = (made, start) => {
      const seen = new Map(made.frames);
      for (const [k, q] of made.asked) {
        const v = seen.get(k);
        if (!v) continue;
        if (start) state.set(k, {hi: null, lo: null, floor: v.floor ?? NaN});
        const s = state.get(k);
        if (!s) continue;
        if (v.floor !== undefined) s.floor = v.floor;
        if (v.pass) { s.hi = q; s.sHi = v.score; } else { s.lo = q; s.sLo = v.score; }
      }
    };
    learn(floor, true);
    for (const s of state.values()) if (Number.isNaN(s.floor)) { s.sHi = s.sLo = undefined; s.floor = -Infinity; }
    if (!state.size) return null;
    const table = pick => (...a) => a[2] && state.has(key(a[2])) ? pick(key(a[2]), state.get(key(a[2]))) : read(...a);
    const settled = (_k, s) => s.hi ?? CEILING;
    let last = null;
    for (let round = 0; round < ROUNDS; round++) {
      const next = new Map([...state].map(([k, s]) => [k, nextQuality(s)]));
      if (![...next.values()].some(q => q !== null)) break;
      last = await run({...coding, ...candidates[0], photoAdmission: admission, regionQuality: table((k, s) => next.get(k) ?? settled(k, s))});
      learn(last, false);
    }
    const searched = table(settled);
    const held = last && new Map(last.asked);
    if (!held || [...state].some(([k, s]) => held.get(k) !== settled(k, s)))
      await run({...coding, ...candidates[0], photoAdmission: admission, regionQuality: searched});
    return searched;
  };
  let searched = null;
  for (let i = 0; i < candidates.length; i++) {
    const made = await run({...coding, ...candidates[i], ...(admission && {photoAdmission: admission}), ...(searched && {regionQuality: searched})});
    if (admission && i === 0 && coding.regionQuality) searched = await searchRegions(made, coding.regionQuality);
    if (admission && i === 0) for (const t of RAISES) if (!best) await run(raised({...coding, ...candidates[0], photoAdmission: admission}, t));
    if (admission && i === 0 && !best) await run({maxError: 0}, exact, {...options, effort: photo.effortCap});
    if (wholePhotoRoute?.complete) break;
  }
  if (admission && !best) await run({maxError: 0}, exact, {...options, effort: photo.effortCap});
  if (admission && best && captureExact(best) && (options.effort ?? 3) > photo.effortCap) await run({maxError: 0}, exact, options);
  const measurements = admission?.measurements(best);
  if (measurements) resultFacts(options, {measurements});
  return finished(best, hooks, {bands: record?.bands ?? 1, ...(measurements && {measurements})});
}

export async function runPhotoLadder(call) {
  const {policy, input, options, exact} = call, asked = options.effort ?? 3;
  const looks = policy.qualityLooks(input);
  let failed = false;
  try {
    const wholePhotoRoute = {effort: asked, complete: false, preview: call.hooks.preview};
    const engine = {photoBlocks: policy.regionPhotoFrameSteps, photoSearch: policy.photoSearch, photoScoreMemo: looks.scoreMemo, wholePhotoRoute};
    const level = measuredLevel(asked), candidates = [{...engine, photoBlockEffort: 4}];
    if (level >= 5) candidates.push({look: looks.coarse, ...engine, photoBlockEffort: 5});
    if (level >= 6) candidates.push({look: looks.fine, ...engine, photoBlockEffort: 6});
    for (let e = 7; e <= level; e++) candidates.push({look: looks.fine, ...engine, photoBlockEffort: e});
    return await keepSmaller({...call, wholePhotoRoute}, candidates, exact);
  } catch (error) { failed = true; throw error; }
  finally { try { looks.destroy(); } catch (error) { if (!failed) throw error; } }
}
