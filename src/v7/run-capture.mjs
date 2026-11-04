import {encodeCaptureBytes, encodeCaptureSteps, captureBandShape, captureBand, captureBandSteps, compileCaptureKernels, image, warmCapture} from './capture-boot.mjs';
import {CAPTURE_TOOLS, CAPTURE_HELPERS, LEVELS, DEFAULT_EFFORT, captureExact, markCaptureExact} from '../capture-codec.mjs';
import {bandGroupSteps, bandFrameFile, frameBandRows} from '../capture-band-frame.mjs';
import {GROUPS} from './groups.mjs';
import {GPU_FROM} from './capture-levels.mjs';
import {check, fail, pixelLimit, LARGEST} from './primitives.mjs';
import {WHOLE, BAND_PIXELS, bandRows} from './band-size.mjs';
import {readBand, untilAborted} from './rows.mjs';
import {turn as loopTurn, exclusive} from '../turn.mjs';
import {wasmRequired} from '../capture-wasm-error.mjs';
import {admitCapture} from './capture-options.mjs';
import {admitOutputSize} from '../admit.mjs';
import {CAPTURE_FACTS} from './capture-facts.mjs';

let active = 0;
function load() {
  const kernels = compileCaptureKernels().then(ok => { if (!ok) throw wasmRequired(); });
  kernels.catch(() => {});
  return kernels;
}
export function prepareCapture() {
  return load().then(() => { if (!active) warmCapture(); });
}

export function captureDomain(picture) {
  const refuse = what => { throw fail('JXL_INPUT', `A capture takes 8-bit straight sRGB or Display P3 RGBA; this picture's ${what}. Use encode.`); };
  if (!(picture.data instanceof Uint8Array || picture.data instanceof Uint8ClampedArray)) refuse('samples are not 8-bit');
  if (picture.colorSpace !== undefined && picture.colorSpace !== 'srgb' && picture.colorSpace !== 'display-p3') refuse(`colorSpace is ${picture.colorSpace}`);
  if (picture.bitDepth !== undefined && picture.bitDepth !== 8) refuse(`bitDepth is ${picture.bitDepth}`);
  if (picture.sampleFormat !== undefined && picture.sampleFormat !== 'uint') refuse(`sampleFormat is ${picture.sampleFormat}`);
  if (picture.transferFunction !== undefined && picture.transferFunction !== 'srgb') refuse(`transferFunction is ${picture.transferFunction}`);
  if (picture.alphaPremultiplied) refuse('alpha is premultiplied');
  if (picture.intensityTarget !== undefined && picture.intensityTarget !== 255) refuse(`intensityTarget is ${picture.intensityTarget}`);
  if (picture.icc !== undefined) refuse('profile is an ICC profile');
  if (picture.orientation !== undefined && picture.orientation !== 1) refuse(`orientation is ${picture.orientation}`);
  if (picture.extraChannels?.length) refuse('extra channels are set');
}

export {admitCapture};
export async function runCapture(input, options, hooks) {
  return runCaptureUsing(input, options, hooks, {maxError: admitCapture(options)}, exactCoder);
}
const exactCoder = {ready: load, whole: encodeCaptureBytes, band: captureBand, steps: encodeCaptureSteps, bandSteps: captureBandSteps};
export const exactCoderWith = tools => ({...exactCoder, tools});

async function drive(steps, answer, hooks, from = 0, span = 1) {
  let step, reply, last = performance.now();
  try {
    check(hooks.signal);
    while (!(step = steps.next(reply)).done) {
      reply = undefined; check(hooks.signal);
      if (hooks.signal && performance.now() - last >= 8) { await loopTurn(); check(hooks.signal); last = performance.now(); }
      if (typeof step.value === 'number') hooks.onProgress?.(Math.min(0.999, from + step.value * span));
      else if (!answer) reply = null;
      else if (step.value.ahead) reply = answer(step.value);
      else { reply = await untilAborted(answer(step.value), hooks.signal); check(hooks.signal); last = performance.now(); }
    }
  } catch (error) { steps.return?.(); throw error; }
  finally { answer?.retire?.(); }
  return step.value;
}

const helped = (coder, answer, groups, signal) => {
  if (!groups || !coder.steps) return answer;
  const pending = new Map();
  return Object.assign(value => {
    if (pending.delete(value.await)) return value.await;
    const request = value.groups ?? (Array.isArray(value.regions) && {regions: value.regions});
    if (!request) return answer ? answer(value) : null;
    if (!value.ahead) return groups(request, signal);
    const controller = new AbortController(), stop = () => controller.abort(signal?.reason);
    if (signal?.aborted) stop(); else signal?.addEventListener('abort', stop, {once: true});
    let promise;
    try { promise = Promise.resolve(groups(request, controller.signal)); }
    catch (error) { signal?.removeEventListener?.('abort', stop); throw error; }
    promise = promise.finally(() => signal?.removeEventListener?.('abort', stop));
    promise.catch(() => {}); pending.set(promise, controller); return promise;
  }, {options: {...answer?.options, [CAPTURE_HELPERS]: true}, retire() {
    for (const controller of pending.values()) controller.abort(); pending.clear(); answer?.retire?.();
  }});
};

export async function runCaptureUsing(input, options, hooks, fidelity, coder) {
  const {fidelity: _fidelity, readAs: _readAs, maxPixels, [GROUPS]: groups, ...rest} = options;
  if (coder.tools) fidelity = {...fidelity, [CAPTURE_TOOLS]: coder.tools};
  const asked = rest.effort ?? 3, needs = pixels => coder.device && rest.webgpu === 'required' && asked >= GPU_FROM && pixels >= (coder.tools?.gpu?.pixels ?? 0);
  const known = input?.width * input?.height >= 0;
  if (known && needs(input.width * input.height)) {
    check(hooks.signal);
    await untilAborted(coder.device(), hooks.signal);
  }
  const capped = coder.effortCap && asked > coder.effortCap;
  if (capped) rest.effort = coder.effortCap;
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
      check(hooks.signal); await kernels;
      const read = async (y, rows) => { const band = await readBand(input, y, rows, hooks.signal); captureDomain(band); return band.data; };
      const coding = {...rest, ...fidelity, colorSpace: input.description.colorSpace, signal: hooks.signal};
      const result = await exclusive(async () => {
        check(hooks.signal);
        const answer = helped(coder, await coder.answerer?.(coding, width * height), groups, hooks.signal);
        return captureLarge(read, width, height, coding, hooks, coder, answer);
      }, hooks.signal);
      return finished(result, hooks, facts);
    }
    const picture = await image(input, options, hooks);
    captureDomain(picture);
    const {data, width, height, colorSpace} = picture;
    if (capped && !known && needs(width * height)) { check(hooks.signal); await untilAborted(coder.device(), hooks.signal); }
    check(hooks.signal);
    await kernels;
    check(hooks.signal);
    const coding = {...rest, ...fidelity, colorSpace, signal: hooks.signal};
    const result = await exclusive(async () => {
      check(hooks.signal);
      const answer = helped(coder, await coder.answerer?.(coding, width * height), groups, hooks.signal);
      return width * height > WHOLE ? captureLarge((y, rows) => data.subarray(y * width * 4, (y + rows) * width * 4), width, height, coding, hooks, coder, answer, data)
        : answer || hooks.signal ? drive(coder.steps(data, width, height, {...coding, ...answer?.options}), answer, hooks) : coder.whole(data, width, height, coding);
    }, hooks.signal);
    return finished(result, hooks, facts);
  } finally { active--; }
}

async function captureLarge(read, width, height, coding, hooks, coder, answer = null, whole = null) {
  const rows = bandRows(width), parts = [], found = coder.regions ? [] : null;
  if (rows >= height) {
    const {signal: _signal, ...options} = coding, data = await read(0, height); check(hooks.signal);
    return answer || hooks.signal ? drive(coder.steps(data, width, height, {...options, ...answer?.options, signal: hooks.signal}), answer, hooks)
      : coder.whole(data, width, height, {...options, signal: hooks.signal});
  }
  let shape, size = 0;
  coding[CAPTURE_FACTS].bands = Math.ceil(height / rows);
  for (let y = 0; y < height; y += rows) {
    const count = Math.min(rows, height - y), data = await read(y, count);
    const inBand = rects => rects?.filter(r => r.y < y + count && r.y + r.height > y).map(r => ({...r, y: r.y - y}));
    shape = captureBandShape(data, shape);
    found?.push(coder.regions(data, width, count, inBand(coding.photoRects), inBand(coding.exactRects?.filter(e => e.edge !== true))));
    check(hooks.signal);
  }
  const photos = found?.some(regions => regions.length);
  if (!photos && !(coding.maxError > 0)) return oneFrame(read, width, height, coding, shape, hooks, answer);
  if (whole && photos && coder.large && !shape.alpha && coding.quality < 100 && coding.exactRects?.some(e => e.edge !== true)) {
    const {signal: _signal, ...options} = coding;
    const page = await drive(coder.large(whole, width, height, {...options, ...answer?.options, signal: hooks.signal}), answer, hooks);
    if (page) { coding[CAPTURE_FACTS].bands = 1; return page; }
  }
  if (photos && coding.quality < 100) shape = {...shape, alpha: true};
  for (let y = 0, i = 0; y < height; y += rows, i++) {
    const count = Math.min(rows, height - y), data = await read(y, count);
    check(hooks.signal);
    const band = {...coding, y, imageHeight: height, shape};
    const plain = found && !photos && {colorSpace: coding.colorSpace, maxError: 0, effort: coding.effort, [CAPTURE_TOOLS]: coding[CAPTURE_TOOLS], signal: hooks.signal, y, imageHeight: height, shape};
    const part = plain ? (answer || hooks.signal ? await drive(captureBandSteps(data, width, count, {...plain, ...answer?.options}), answer, hooks, y / height, count / height) : captureBand(data, width, count, plain))
      : answer || hooks.signal ? await drive(coder.bandSteps(data, width, count, {...band, ...(found && {regions: found[i]}), ...answer?.options}), answer, hooks, y / height, count / height)
      : coder.band(data, width, count, {...band, ...(found && {regions: found[i]})});
    check(hooks.signal); parts.push(part); size += part.length; admitOutputSize(size);
    hooks.onProgress?.(Math.min(0.999, (y + rows) / height)); check(hooks.signal);
  }
  const bytes = new Uint8Array(size);
  for (let i = 0, at = 0; i < parts.length; at += parts[i++].length) bytes.set(parts[i], at);
  return parts.every(captureExact) ? markCaptureExact(bytes) : bytes;
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
function finished(result, hooks, facts) {
  check(hooks.signal); hooks.onEncoded?.({exact: captureExact(result), ...facts});
  check(hooks.signal); hooks.onProgress?.(1); check(hooks.signal); return result;
}
