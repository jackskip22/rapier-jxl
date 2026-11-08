// SPDX-License-Identifier: MIT
import {captureExact, markCaptureExact} from '../capture-codec.mjs';
import {journaled} from '../step-journal.mjs';
import {resultFacts} from './result-reference.mjs';
import {LOW_WEBP_CALIBRATION} from './low-webp-quality.mjs';
import {measuredLevel} from '../effort-level.mjs';

export function photoAdmission() {
  const records = new WeakMap();
  const accepts = bytes => captureExact(bytes) || records.get(bytes)?.passed === true;
  const measurements = bytes => captureExact(bytes) ? [] : records.get(bytes)?.measurements ?? [];
  const record = (bytes, passed, measured = []) => {
    records.set(bytes, {passed: passed === true, measurements: passed === true ? measured : []}); return bytes;
  };
  return {record, accepts, measurements,
    join: (bytes, parts) => record(bytes, parts.every(accepts), parts.flatMap(measurements))};
}

const RAISES = [0.15, 0.5, 1], CEILING = LOW_WEBP_CALIBRATION.maximumLossy;
const raise = (q, t) => typeof q === 'number' && q < CEILING ? q + (CEILING - q) * t : q;
function raised(coding, t) {
  const {regionQuality} = coding;
  return {...coding, quality: raise(coding.quality, t), ...(regionQuality && {regionQuality: (...a) => raise(regionQuality(...a), t)})};
}

export async function keepSmaller({input, options, hooks, coding, photo, runCaptureUsing, finished, wholePhotoRoute}, candidates, exact = null) {
  const admission = exact && photoAdmission(), n = candidates.length + (admission ? 2 + RAISES.length : 0), span = 1 / n;
  let best = null, record = null;
  let slot = 0;
  const run = async (candidate, coder = photo, ownOptions = options) => {
    const from = slot++ * span;
    const made = await journaled(hooks.journal, 'candidate', async () => {
      let got = null;
      const bytes = await runCaptureUsing(input, ownOptions, {
        ...hooks,
        onProgress: hooks.onProgress && (f => { if (f < 1) hooks.onProgress(from + f * span); }),
        onEncoded: r => { got = r; },
      }, candidate, coder);
      return {bytes, got, exact: captureExact(bytes), passed: admission ? admission.accepts(bytes) : null, measured: admission ? admission.measurements(bytes) : null};
    });
    const {bytes, got} = made;
    if (made.exact && !captureExact(bytes)) markCaptureExact(bytes);
    if (admission && made.passed !== admission.accepts(bytes)) admission.record(bytes, made.passed, made.measured);
    hooks.preview?.(bytes, {measurements: admission?.measurements(bytes) ?? []});
    if ((!admission || admission.accepts(bytes)) && (!best || bytes.length < best.length)) { best = bytes; record = got; }
  };
  for (let i = 0; i < candidates.length; i++) {
    await run({...coding, ...candidates[i], ...(admission && {photoAdmission: admission})});
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
