// SPDX-License-Identifier: MIT
import {memoryPlan, s2Admitted, S2_SEARCH_PIXELS} from './memory-plan.mjs';
import {fault} from './fault.mjs';
import {exactPow} from './exact-math.mjs';
import {complete, part, scaled} from './bits.mjs';
import {QUANT_SHAPE, transformDCT8, dct8Basis} from './photo-dct.mjs';
import {photoXYBSteps, gaborishPlanes, FAST_RANGE, XYB_TABLES} from './photo-xyb.mjs';
import {photoXYBBands, photoXYBBand, appendPhotoBand, PHOTO_BAND_MARGIN, photoFastBands} from './photo-bands.mjs';
import {screenLike} from './screen.mjs';
import {offloading} from './offload.mjs';

const DEFAULT_DCT8 = [[3150.0, 0.0, -0.4, -0.4, -0.4, -2.0], [560.0, 0.0, -0.3, -0.3, -0.3, -0.3], [512.0, -2.0, -1.0, 0.0, -1.0, -2.0]];
function defaultWeight(c, x, y) {
  const p = DEFAULT_DCT8[c], bands = [p[0]];
  for (let i = 1; i < p.length; i++) bands.push(bands[i - 1] * (p[i] > 0 ? 1 + p[i] : 1 / (1 - p[i])));
  const dx = x / 7, dy = y / 7, at = Math.sqrt(dx * dx + dy * dy) * (bands.length - 1) / 1.4142135623730951;
  const i = Math.min(bands.length - 2, Math.floor(at));
  return bands[i] * exactPow(bands[i + 1] / bands[i], at - i);
}
const baseStep = (c, k) => [0.84, 7, 5.6][c] * QUANT_SHAPE[k] * (1 + [1, 0, 5][c] * Math.sqrt(((k & 7) * (k & 7) + (k >> 3) * (k >> 3)) / 98));
const LUMA = (1 / defaultWeight(1, 1, 0)) / baseStep(1, 1);
const CHROMA = Float64Array.from({length: 192}, (_, i) => {
  const c = i >> 6, k = i & 63; return k ? (1 / defaultWeight(c, k & 7, k >> 3)) / baseStep(c, k) / LUMA : 1;
});

export const blockSearchOptions = (data, width, height) => ({perceptual: true, deadzone: V6.deadzone,
  ids: screenLike(data, width, height) ? [4, 5, 6, 7, 3, 12, 13] : [4, 5, 6, 7], model: 'simple', rate: [1.0, 3, 2, 0.6], lambda: 0.28, sizeScale: 1.03});

export const V6 = {
  tune: (c, k) => {
    const r = Math.sqrt(((k & 7) * (k & 7) + (k >> 3) * (k >> 3)) / 98);
    return CHROMA[c * 64 + k] * [1.3, 1, 1.675][c] * (1 + [0.45, 0.45, 0][c] * r) * (1 + [-0.15, 0.05, 0][c] * r * r);
  },
  deadzone: [0.72, 0.76, 0.485, 0.575, 0.54, 0.6], epfScale: 3, filterAlways: true, dcScale: [1.675, 1.35, 1.675], cflScale: 0.7,
};
export const GABORISH = {gaborish: {strength: 1, tilt: 1}, epfScale: 2};
export const UPLOAD_PICTURE = {...V6, ...GABORISH, fastGaborish: true};

export function admitV6Memory(rgba, width, height, memory) {
  const inputBytes = rgba.buffer?.byteLength ?? rgba.byteLength;
  if (memory?.inputBytes !== undefined && memory.inputBytes < inputBytes) throw fault('JXL_MEMORY', 'Memory reservation omits retained input bytes.');
  const plan = memoryPlan(width * height, {...memory, inputBytes: memory?.inputBytes ?? inputBytes, width, height});
  if (plan.known && !plan.fits) throw fault('JXL_MEMORY', 'Photo encoding exceeds the supplied memory reservation.');
  return plan;
}
export function prepareV6(rgba, width, height, color = {}, memory = {}, {banded = false} = {}) {
  const plan = admitV6Memory(rgba, width, height, memory), cache = plan.dct, whole = !(banded && plan.banded);
  return {rgba, width, height, color, memory: plan, pre: whole ? gaborishPlanes(rgba, width, height, {...V6, ...GABORISH, ...color}) : null,
    dct: whole && cache ? {} : null, dctPlain: cache ? {} : null};
}

export function gaborishRows(data, width, height, options, sparse = false) {
  const W = Math.ceil(width / 8) * 8, M = PHOTO_BAND_MARGIN;
  let band = null;
  return (y0, y1, x0, x1) => {
    if (band && y0 >= band.top && y1 <= band.top + band.rows && (!band.cols || x0 >= band.cols[0] && x1 <= band.cols[1])) return band;
    band = null;
    if (sparse && x1 !== undefined) {
      y0 = Math.floor(y0 / 32) * 32; y1 = Math.ceil(y1 / 32) * 32; x0 = Math.floor(x0 / 32) * 32; x1 = Math.ceil(x1 / 32) * 32;
      const from = Math.max(0, Math.floor((y0 - M) / 8) * 8), to = Math.min(height, y1 + M), c0 = Math.max(0, Math.floor((x0 - M) / 8) * 8), c1 = Math.min(width, x1 + M);
      const cw = c1 - c0, crop = new Uint8Array(cw * (to - from) * 4);
      for (let y = from; y < to; y++) crop.set(data.subarray((y * width + c0) * 4, (y * width + c1) * 4), (y - from) * cw * 4);
      const win = gaborishPlanes(crop, cw, to - from, options), Wc = Math.ceil(cw / 8) * 8, rows = Math.ceil((to - from) / 8) * 8;
      const planes = win.map(p => { const out = new Float64Array(rows * W); for (let y = 0; y < rows; y++) out.set(p.subarray(y * Wc, y * Wc + Math.min(Wc, W - c0)), y * W + c0); return out; });
      return band = {top: from, rows: Math.min(rows, y1 - from), cols: [x0, x1], planes};
    }
    const top = Math.floor(y0 / 64) * 64, rows = Math.max(256, Math.ceil((y1 - top) / 64) * 64);
    const from = Math.max(0, top - M), to = Math.min(height, top + rows + M);
    const planes = gaborishPlanes(data.subarray(from * width * 4, to * width * 4), width, to - from, options);
    return band = {top, rows, planes: planes.map(p => p.subarray((top - from) * W))};
  };
}

export function photoV6Image(prepared, quality, cache = true) { return v6Image(prepared, quality, {}, cache); }

export function v6Image(prepared, quality, extra = {}, cache = true) {
  const {rgba, width, height, pre, color, dct} = prepared, options = {...V6, ...GABORISH, ...color, ...(extra.calibrationRow ? {calibrationRow: extra.calibrationRow} : {})};
  if (pre) return complete(photoXYBSteps(rgba, width, height, quality, {...options, pre, dctCache: cache ? dct : null, ...extra}));
  const image = bandedImage(rgba, width, height, quality, options, extra.fieldScale);
  if (extra.keepPlanes) image.planeRows = gaborishRows(rgba, width, height, options);
  return image;
}

function bandedImage(data, width, height, quality, options, field) {
  if (!field) return complete(photoXYBBands(data, width, height, quality, options));
  const bandHeight = Math.max(64, Math.floor(1048576 / width / 64) * 64), stride = Math.ceil(width / 8), quantFields = new Int32Array(field.length);
  let image;
  for (let y = 0; y < height; y += bandHeight) {
    const h = Math.min(bandHeight, height - y), from = Math.max(0, y - PHOTO_BAND_MARGIN), to = Math.min(height, y + h + PHOTO_BAND_MARGIN);
    const result = photoXYBBand(data.subarray(from * width * 4, to * width * 4), width, h, quality,
      {...options, fieldScale: field.subarray(y / 8 * stride, Math.ceil((y + h) / 8) * stride)}, y - from);
    quantFields.set(result.quantFields, y / 8 * stride);
    image = appendPhotoBand(image, result, width, height, y, data);
  }
  image.quantFields = quantFields;
  return image;
}

function* bandsThenCoefficients(bands, encode) {
  let step, reply, coefficients = null, first = null;
  while (!(step = bands.next(reply)).done) {
    reply = undefined;
    if (step.value?.offload === 'image') {
      coefficients = encode(step.value.image); first = coefficients.next();
      if (!first.done && first.value?.offload === 'prefetch') { yield {...first.value, after: step.value.bands, at: () => 0}; first = null; }
      continue;
    }
    reply = yield scaled(step.value, done => done / 2);
  }
  const image = step.value;
  yield {offload: 'placed', image, at: () => 0.5};
  coefficients ??= encode(image);
  let next = first ?? coefficients.next();
  while (!next.done) next = coefficients.next(yield scaled(next.value, done => 0.5 + done / 2));
  return next.value;
}

export const v6Trace = label => { const t = globalThis.__jxlTrace; if (t) t.push([label, performance.now()]); };
export function* photoV6Steps(data, width, height, quality, effort, encodeCoefficients, search, color, gpu, memory, screen = false, both = false) {
  if (effort <= 3 || color) return yield* pictureSteps(data, width, height, quality, color ? Math.min(effort, 8) : effort, encodeCoefficients, color ? undefined : search, color, gpu, memory, screen, false, false, both);
  let hurry = false;
  function* share(steps, from, to) {
    let step, reply;
    while (!(step = steps.next(reply)).done) {
      const value = step.value;
      reply = yield typeof value === 'number' ? from + value * (to - from) : value;
      if (typeof value === 'number' && reply) hurry = true;
    }
    return step.value;
  }
  if (!screen && (effort === 6 || effort === 7) && quality < 100 && width >= 128 && height >= 128 && encodeCoefficients.splits) {
    const bytes = yield* share(pictureSteps(data, width, height, quality, effort, encodeCoefficients, search, color, gpu, memory, screen, true, false, both), 0, 1);
    if (!hurry && bytes) return bytes;
    const late = yield* share(pictureSteps(data, width, height, quality, 1, encodeCoefficients, undefined, color, undefined, memory, screen), 1, 1);
    return bytes && bytes.length < late.length ? bytes : late;
  }
  const blocks8 = !screen && effort >= 8 && quality < 100 && width >= 128 && height >= 128 && encodeCoefficients.splits;
  const below = effort === 8 ? 1 : 0.85;
  function* written(seven, full) {
    let best, image;
    if (seven?.write && full?.write) {
      const pick = seven.est <= full.est ? seven : full;
      v6Trace(pick === seven ? 'write the 16x16 picture' : 'write the full picture');
      best = yield* share(pick.write(), 0.8 * below, below); image = pick.image;
    } else {
      const a = seven?.write ? yield* share(seven.write(), 0.8 * below, 0.9 * below) : seven, b = full?.write ? yield* share(full.write(), 0.9 * below, below) : full;
      best = a && (!b || a.length <= b.length) ? a : b; image = best === a ? seven?.image : full?.image;
    }
    v6Trace(`written (picture ${best?.length ?? 0} B)`);
    return best ? {bytes: best, image} : null;
  }
  if (blocks8 && effort >= 9 && search && !color?.transform && width * height <= S2_SEARCH_PIXELS && !s2Admitted(admitV6Memory(data, width, height, memory), width, height, effort - 1))
    throw fault('JXL_MEMORY', 'The effort 8-9 search exceeds the memory reservation.');
  if (blocks8) {
    const picture = (e, deferred = true) => pictureSteps(data, width, height, quality, e, encodeCoefficients, search, color, gpu, memory, screen, true, deferred, both);
    let made;
    if (gpu) { made = yield* overlapped([picture(8, 'prelearn'), picture(7)], below); hurry ||= made.hurry; }
    else {
      const seven = yield* share(picture(7), 0, 0.4 * below);
      v6Trace('16x16 picture done');
      const full = hurry ? null : yield* share(picture(8), 0.4 * below, 0.8 * below);
      v6Trace('full picture done');
      made = {seven, full};
    }
    const floor7 = hurry ? null : yield* written(made.seven, made.full);
    made = null;
    if (!hurry && floor7 && (effort === 8 || !search)) return floor7.bytes;
    if (!hurry && floor7) {
      const wantPlanes = width * height <= 2048 * 2048 && !color?.transform;
      let made = null;
      const prepare = Object.assign(() => made ??= prepareV6(data, width, height, color, memory, {banded: !wantPlanes}), {width, height, color, memory});
      const found = yield* share(search(prepare, () => photoV6Image(prepare(), quality, true), quality, effort - 1, floor7, gpu), below, 1);
      return found && found.length < floor7.bytes.length ? found : floor7.bytes;
    }
    const best = floor7?.bytes ?? null;
    v6Trace('hurried: effort 1');
    const late = yield* share(pictureSteps(data, width, height, quality, 1, encodeCoefficients, undefined, color, undefined, memory, screen), 1, 1);
    return best && best.length < late.length ? best : late;
  }
  v6Trace('floor');
  const floor = yield* share(pictureSteps(data, width, height, quality, 1, encodeCoefficients, undefined, color, undefined, memory, screen), 0, 0.1);
  v6Trace('floor done');
  if (hurry) return floor;
  const bytes = yield* share(pictureSteps(data, width, height, quality, effort, encodeCoefficients, search, color, gpu, memory, screen, true, false, both), 0.1, 1);
  v6Trace('full picture done');
  return bytes && bytes.length < floor.length ? bytes : floor;
}

function* overlapped(steps, scale = 1) {
  const names = ['full picture', '16x16 picture'], ranges = [[0.4 * scale, 0.8 * scale], [0, 0.4 * scale]];
  const jobs = steps.map((it, k) => ({it, k, reply: undefined, pending: null, done: false, value: null}));
  let shown = 0, hurry = false, idle = 0;
  try {
    for (;;) {
      const job = !hurry && jobs.find(j => !j.done && !j.pending);
      if (job) {
        for (;;) {
          const step = job.it.next(job.reply);
          job.reply = undefined;
          if (step.done) { job.done = true; job.value = step.value; v6Trace(names[job.k] + ' done'); break; }
          const value = step.value;
          if (typeof value === 'number') {
            shown = Math.max(shown, ranges[job.k][0] + value * (ranges[job.k][1] - ranges[job.k][0]));
            if (yield shown) { hurry = true; break; }
          } else if (value?.gpu && value.later) job.reply = yield value;
          else if (value?.await !== undefined) {
            if (value.await && typeof value.await.then === 'function') { job.pending = value.await; break; }
            job.reply = value.await;
          } else if (value?.gpu) {
            const started = yield {gpu: value.gpu, later: true};
            if (started && typeof started.then === 'function') job.pending = started;
            else job.reply = started;
            if (job.pending) break;
          } else job.reply = yield value;
        }
        continue;
      }
      if (hurry || jobs.every(j => j.done)) { v6Trace(`overlap: the CPU idle ${Math.round(idle)} ms`); return {seven: jobs[1].value, full: jobs[0].value, hurry}; }
      const waiting = jobs.filter(j => j.pending), since = performance.now();
      const [j, answer] = yield {await: Promise.race(waiting.map(w => w.pending.then(v => [w, v])))};
      idle += performance.now() - since;
      v6Trace(`waited ${Math.round(performance.now() - since)} ms on the device (${waiting.map(w => ['full', '16x16'][w.k]).join(', ')})`);
      j.pending = null; j.reply = answer;
    }
  } finally {
    for (const j of jobs) if (!j.done) try { j.it.return?.(); } catch {}
  }
}

function* pictureSteps(data, width, height, quality, effort, encodeCoefficients, search, color, gpu, memory, screen = false, floored = false, deferred = false, both = true) {
  if (effort <= 3 && !color) {
    const gaborish = effort === 3 && quality < 100 && !screen;
    if (effort >= 2 && quality < 100 && width * height > 512 * 512 && encodeCoefficients.splits) {
      const bytes = yield {split: {data, width, height, quality, gaborish}};
      if (bytes) return bytes;
    }
    if (gaborish) {
      admitV6Memory(data, width, height, memory);
      if (offloading()) return yield* bandsThenCoefficients(photoXYBBands(data, width, height, quality, UPLOAD_PICTURE, {}), image => encodeCoefficients(image, 3));
      const image = yield* part(photoXYBBands(data, width, height, quality, UPLOAD_PICTURE), 0, 2);
      return yield* part(encodeCoefficients(image, 3), 1, 2);
    }
    const image = offloading() && !screen ? yield* part(photoFastBands(data, width, height, quality, {...V6, fast: true}), 0, 2)
      : complete(photoXYBSteps(data, width, height, quality, screen ? {...V6, fast: true, calibrationRow: 'screen'} : {...V6, fast: true}));
    return yield* (offloading() ? part(encodeCoefficients(image, effort), 1, 2) : encodeCoefficients(image, effort));
  }
  if (effort <= 3 && color?.transform && !color.transform.gray) {
    admitV6Memory(data, width, height, memory);
    let image = null;
    try { image = complete(photoXYBSteps(data, width, height, quality, {...V6, fast: true, ...color})); } catch (error) { if (error !== FAST_RANGE) throw error; }
    if (image) return yield* encodeCoefficients(image, effort);
  }
  const blockDesign = screen ? (effort >= 8 ? 'full' : null) : effort === 6 || effort === 7 ? 'fast' : effort === 8 ? 'full' : null;
  const perceptualBlocks = blockDesign !== null && quality < 100 && width >= 128 && height >= 128 &&
    (!color || color.space || color.transform && !color.transform.gray);
  if (perceptualBlocks && !encodeCoefficients.blocks) throw fault('JXL_INTERNAL', 'The block picture needs its writer (photo-v6-blocks.mjs photoAnsSteps).');
  if (gpu && effort <= 7 && !color && !screen && !perceptualBlocks) {
    const image = yield {gpu: {kind: 'v6image', data, width, height, quality, options: {...V6, ...GABORISH}, lib: {complete, photoXYBSteps, transformDCT8, dct8Basis, xyb: XYB_TABLES}}};
    if (image) return yield* encodeCoefficients(image, effort);
  }
  if (perceptualBlocks) return yield* encodeCoefficients.blocks({data, width, height, quality, effort, encodeCoefficients, color, gpu, memory, screen, floored, blockDesign, deferred, both});
  if (effort <= 7 || !search || width < 8 || height < 8) {
    admitV6Memory(data, width, height, memory);
    if (offloading()) return yield* bandsThenCoefficients(photoXYBBands(data, width, height, quality, {...V6, ...GABORISH, ...color}, color || {}), image => encodeCoefficients(image, effort));
    const image = yield* part(photoXYBBands(data, width, height, quality, {...V6, ...GABORISH, ...color}), 0, 2);
    return yield* part(encodeCoefficients(image, effort), 1, 2);
  }
  const wantPlanes = width >= 128 && height >= 128 && width * height <= 2048 * 2048 && !color?.transform && effort >= 9;
  const prepared = prepareV6(data, width, height, color, memory, {banded: !wantPlanes});
  return yield* search(prepared, () => photoV6Image(prepared, quality, true), quality, effort >= 9 ? effort - 1 : effort, null, gpu);
}
