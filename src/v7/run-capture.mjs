import {resultReference, RESULT_REFERENCE} from './result-reference.mjs';
import {encodeCaptureBytes, encodeCaptureSteps, captureBandShape, captureBand, captureBandSteps, compileCaptureKernels, image, warmCapture} from './capture-boot.mjs';
import {CAPTURE_TOOLS, CAPTURE_HELPERS, LEVELS, DEFAULT_EFFORT, captureExact, markCaptureExact} from '../capture-codec.mjs';
import {bandGroupSteps, bandFrameFile, frameBandRows} from '../capture-band-frame.mjs';
import {GROUPS} from './groups.mjs';
import {GPU_FROM} from './capture-levels.mjs';
import {check, pixelLimit, LARGEST} from './primitives.mjs';
import {WHOLE, BAND_PIXELS, bandRows} from './band-size.mjs';
import {readBand, untilAborted} from './rows.mjs';
import {turn as loopTurn, exclusive} from '../turn.mjs';
import {wasmRequired} from '../capture-wasm-error.mjs';
import {admitCapture} from './capture-options.mjs';
import {admitOutputSize} from '../admit.mjs';
import {CAPTURE_FACTS} from './capture-facts.mjs';
import {CAPTURE_PROTECTION} from '../capture-protection.mjs';
import {captureDomain} from '../capture-domain.mjs';
import {journalNext, journalRequest} from '../step-journal.mjs';

let active = 0;
function load() {
  const kernels = compileCaptureKernels().then(ok => { if (!ok) throw wasmRequired(); });
  kernels.catch(() => {});
  return kernels;
}
export function prepareCapture() {
  return load().then(() => { if (!active) warmCapture(); });
}

export {admitCapture};
export async function runCapture(input, options, hooks) {
  return runCaptureUsing(input, options, hooks, {maxError: admitCapture(options)}, exactCoder);
}
const exactCoder = {ready: load, whole: encodeCaptureBytes, band: captureBand, steps: encodeCaptureSteps, bandSteps: captureBandSteps};
export const exactCoderWith = tools => ({...exactCoder, tools});

async function drive(steps, answer, hooks, from = 0, span = 1) {
  let step, reply, failed = false, last = performance.now();
  const {journal} = hooks;
  try {
    check(hooks.signal);
    while (!(step = journal ? journalNext(steps, reply, journal) : steps.next(reply)).done) {
      if (journal && journalRequest(step.value)) { reply = await journal(step.value); continue; }
      const output = step.value?.photoOutput === true;
      reply = output && answer ? answer(step.value) : undefined; check(hooks.signal);
      if (hooks.signal && performance.now() - last >= 8) { await loopTurn(); check(hooks.signal); last = performance.now(); }
      if (typeof step.value === 'number') hooks.onProgress?.(Math.min(0.999, from + step.value * span));
      else if (!answer) reply = null;
      else if (step.value.ahead) reply = answer(step.value);
      else { reply = await untilAborted(output ? reply : answer(step.value), hooks.signal); check(hooks.signal); last = performance.now(); }
    }
  } catch (error) {
    failed = true;
    try { steps.return?.(); } catch {}
    throw error;
  } finally {
    try { await answer?.retire?.(); } catch (error) { if (!failed) throw error; }
  }
  return step.value;
}

const helped = (coder, answer, groups, signal) => {
  if (!groups || !coder.steps) return answer;
  const pending = (typeof __RAPIER_JXL_CAPTURE_LEAN__ !== 'undefined' && __RAPIER_JXL_CAPTURE_LEAN__ === true) ? null : new Map();
  return Object.assign(value => {
    if (!(typeof __RAPIER_JXL_CAPTURE_LEAN__ !== 'undefined' && __RAPIER_JXL_CAPTURE_LEAN__ === true) && pending.delete(value.await)) return value.await;
    const request = value.groups ?? (!(typeof __RAPIER_JXL_CAPTURE_LEAN__ !== 'undefined' && __RAPIER_JXL_CAPTURE_LEAN__ === true) && Array.isArray(value.regions) && {regions: value.regions});
    if (!request) return answer ? answer(value) : null;
    if ((typeof __RAPIER_JXL_CAPTURE_LEAN__ !== 'undefined' && __RAPIER_JXL_CAPTURE_LEAN__ === true) || !value.ahead) return groups(request, signal);
    const controller = new AbortController(), stop = () => controller.abort(signal?.reason);
    if (signal?.aborted) stop(); else signal?.addEventListener('abort', stop, {once: true});
    let promise;
    try { promise = Promise.resolve(groups(request, controller.signal)); }
    catch (error) { signal?.removeEventListener?.('abort', stop); throw error; }
    promise = promise.finally(() => signal?.removeEventListener?.('abort', stop));
    promise.catch(() => {}); pending.set(promise, controller); return promise;
  }, {options: {...answer?.options, [CAPTURE_HELPERS]: true}, async retire() {
    let failed = false, failure;
    if (!(typeof __RAPIER_JXL_CAPTURE_LEAN__ !== 'undefined' && __RAPIER_JXL_CAPTURE_LEAN__ === true)) {
      for (const controller of pending.values()) try { controller.abort(); }
      catch (error) { if (!failed) { failed = true; failure = error; } }
      pending.clear();
    }
    try { await answer?.retire?.(); } catch (error) { if (!failed) { failed = true; failure = error; } }
    if (failed) throw failure;
  }});
};

const isPlainPicture = input => input && typeof input === 'object' && Object.getPrototypeOf(input) === Object.prototype && input.data !== undefined;

export async function runCaptureUsing(input, options, hooks, fidelity, coder) {
  const {[RESULT_REFERENCE]: _reference, fidelity: _fidelity, readAs: _readAs, maxPixels, [GROUPS]: groups, ...rest} = options;
  if (!(typeof __RAPIER_JXL_CAPTURE_LEAN__ !== 'undefined' && __RAPIER_JXL_CAPTURE_LEAN__ === true) && coder.tools) fidelity = {...fidelity, [CAPTURE_TOOLS]: coder.tools};
  const asked = rest.effort ?? 3, needs = pixels => coder.device && rest.webgpu === 'required' && asked >= GPU_FROM && pixels >= (coder.tools?.gpu?.pixels ?? 0);
  const known = input?.width * input?.height >= 0;
  if (!(typeof __RAPIER_JXL_CAPTURE_LEAN__ !== 'undefined' && __RAPIER_JXL_CAPTURE_LEAN__ === true) && known && coder.rectangles) {
    const prior = hooks.normalizedRects;
    if (!prior || prior.normalize !== coder.rectangles || prior.width !== input.width || prior.height !== input.height ||
        prior.exactRects !== rest.exactRects || prior.photoRects !== rest.photoRects)
      Object.assign(rest, coder.rectangles(rest, input.width, input.height));
  }
  if (known && needs(input.width * input.height)) {
    check(hooks.signal);
    await untilAborted(coder.device(), hooks.signal);
  }
  const capped = !(typeof __RAPIER_JXL_CAPTURE_LEAN__ !== 'undefined' && __RAPIER_JXL_CAPTURE_LEAN__ === true) && coder.effortCap && asked > coder.effortCap;
  if (!(typeof __RAPIER_JXL_CAPTURE_LEAN__ !== 'undefined' && __RAPIER_JXL_CAPTURE_LEAN__ === true) && capped) rest.effort = coder.effortCap;
  if (maxPixels !== undefined) hooks = {...hooks, maxPixels: Math.min(pixelLimit(maxPixels, LARGEST), hooks.maxPixels ?? Infinity)};
  const facts = {bands: 1};
  fidelity = {...fidelity, [CAPTURE_FACTS]: facts};
  active++;
  try {
    const kernels = coder.ready();
    kernels.catch(() => {});
    if (input?.description && typeof input.rows === 'function') {
      captureDomain({...input.description, data: new Uint8Array(0)});
      const {width, height} = input;
      resultReference(options, input);
      check(hooks.signal); await kernels;
      const read = async (y, rows) => { const band = await readBand(input, y, rows, hooks.signal); captureDomain(band);
        options[CAPTURE_PROTECTION]?.referenceRows(y, band); return band.data; };
      const coding = {...rest, ...fidelity, colorSpace: input.description.colorSpace, signal: hooks.signal};
      const result = await exclusive(async () => {
        check(hooks.signal);
        const answer = helped(coder, await ((typeof __RAPIER_JXL_CAPTURE_LEAN__ !== 'undefined' && __RAPIER_JXL_CAPTURE_LEAN__ === true) ? undefined : coder.answerer?.(coding, width * height)), groups, hooks.signal);
        return captureLarge(read, width, height, coding, hooks, coder, answer);
      }, hooks.signal);
      if (captureExact(result)) options[CAPTURE_PROTECTION]?.full(result, width, height);
      return finished(result, hooks, facts);
    }
    const picture = hooks.journal && isPlainPicture(input) ? input : await image(input, options, hooks);
    captureDomain(picture);
    resultReference(options, picture, typeof Blob === 'function' && input instanceof Blob ? input : picture);
    const {data, width, height, colorSpace} = picture;
    if (!(typeof __RAPIER_JXL_CAPTURE_LEAN__ !== 'undefined' && __RAPIER_JXL_CAPTURE_LEAN__ === true) && !known && coder.rectangles) Object.assign(rest, coder.rectangles(rest, width, height));
    if (capped && !known && needs(width * height)) { check(hooks.signal); await untilAborted(coder.device(), hooks.signal); }
    check(hooks.signal);
    await kernels;
    check(hooks.signal);
    const coding = {...rest, ...fidelity, colorSpace, signal: hooks.signal};
    const result = await exclusive(async () => {
      check(hooks.signal);
      const answer = helped(coder, await ((typeof __RAPIER_JXL_CAPTURE_LEAN__ !== 'undefined' && __RAPIER_JXL_CAPTURE_LEAN__ === true) ? undefined : coder.answerer?.(coding, width * height)), groups, hooks.signal);
      return width * height > WHOLE ? captureLarge((y, rows) => data.subarray(y * width * 4, (y + rows) * width * 4), width, height, coding, hooks, coder, answer, data)
        : answer || hooks.signal ? drive(coder.steps(data, width, height, {...coding, ...answer?.options}), answer, hooks) : coder.whole(data, width, height, coding);
    }, hooks.signal);
    if (captureExact(result)) options[CAPTURE_PROTECTION]?.full(result, width, height);
    return finished(result, hooks, facts);
  } finally { active--; }
}

async function captureLarge(read, width, height, coding, hooks, coder, answer = null, whole = null) {
  const rows = bandRows(width), parts = [];
  if (rows >= height) {
    const {signal: _signal, ...options} = coding, data = await read(0, height); check(hooks.signal);
    return answer || hooks.signal ? drive(coder.steps(data, width, height, {...options, ...answer?.options, signal: hooks.signal}), answer, hooks)
      : coder.whole(data, width, height, {...options, signal: hooks.signal});
  }
  const page = (typeof __RAPIER_JXL_CAPTURE_LEAN__ !== 'undefined' && __RAPIER_JXL_CAPTURE_LEAN__ === true) ? null : coder.planBands?.({read, width, height, coding, hooks, coder, answer, whole, rows,
    drive, captureLarge, exactCoder});
  let shape, size = 0;
  coding[CAPTURE_FACTS].bands = Math.ceil(height / rows);
  for (let y = 0; y < height; y += rows) {
    const count = Math.min(rows, height - y), data = await read(y, count);
    shape = captureBandShape(data, shape);
    page?.scan(data, y, count);
    check(hooks.signal);
  }
  if (!page?.photos() && !(coding.maxError > 0)) return oneFrame(read, width, height, coding, shape, hooks, answer);
  const prepared = page && await page.prepare(shape);
  if (prepared?.bytes) return prepared.bytes;
  shape = prepared?.shape ?? shape;
  for (let y = 0, i = 0; y < height; y += rows, i++) {
    const count = Math.min(rows, height - y), data = await read(y, count);
    check(hooks.signal);
    const band = {...coding, y, imageHeight: height, shape};
    const selected = page?.band(band, i), writer = selected?.coder ?? coder, options = selected?.options ?? band;
    const part = answer || hooks.signal
      ? await drive(writer.bandSteps(data, width, count, {...options, ...answer?.options}), answer, hooks, y / height, count / height)
      : writer.band(data, width, count, options);
    if (captureExact(part)) coding[CAPTURE_PROTECTION]?.full(part, width, count);
    check(hooks.signal); parts.push(part); size += part.length; admitOutputSize(size);
    hooks.onProgress?.(Math.min(0.999, (y + rows) / height)); check(hooks.signal);
  }
  const bytes = new Uint8Array(size);
  for (let i = 0, at = 0; i < parts.length; at += parts[i++].length) bytes.set(parts[i], at);
  coding[CAPTURE_PROTECTION]?.join(bytes, width, height, parts, rows);
  if (parts.every(captureExact)) markCaptureExact(bytes);
  return page ? page.finish(bytes, parts) : bytes;
}
async function oneFrame(read, width, height, coding, shape, hooks, answer) {
  const rows = frameBandRows(width, BAND_PIXELS), level = LEVELS[coding.effort ?? DEFAULT_EFFORT], groups = [];
  coding[CAPTURE_FACTS].bands = Math.ceil(height / rows);
  let size = 0;
  for (let y = 0; y < height; y += rows) {
    const count = Math.min(rows, height - y), data = await read(y, count);
    check(hooks.signal);
    const steps = bandGroupSteps(data, width, count, level, shape, coding[CAPTURE_TOOLS], answer?.options?.[CAPTURE_HELPERS] === true);
    const part = await drive(steps, answer, hooks, y / height, count / height);
    for (const bytes of part) { groups.push(bytes); size += bytes.length; }
    admitOutputSize(size); check(hooks.signal);
    hooks.onProgress?.(Math.min(0.999, (y + count) / height));
  }
  return markCaptureExact(bandFrameFile(width, height, shape, coding.colorSpace, groups));
}
export function finished(result, hooks, facts) {
  check(hooks.signal); hooks.onEncoded?.({exact: captureExact(result), ...facts});
  check(hooks.signal); hooks.onProgress?.(1); check(hooks.signal); return result;
}
