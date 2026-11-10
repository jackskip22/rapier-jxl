// SPDX-License-Identifier: MIT
import {memoryPlan} from './memory-plan.mjs';
import {fault} from './fault.mjs';
import {complete, part, scaled} from './bits.mjs';
import {transformDCT8, dct8Basis} from './photo-dct.mjs';
import {photoXYBSteps, gaborishPlanes, FAST_RANGE, XYB_TABLES} from './photo-xyb.mjs';
import {photoXYBBands, photoXYBBand, appendPhotoBand, PHOTO_BAND_MARGIN, photoFastBands} from './photo-bands.mjs';
import {screenLike} from './screen.mjs';
import {offloading} from './offload.mjs';
import {photoSplitSteps, photoSplitCandidates, splitRoute, encodeSplit} from './photo-split.mjs';
import {fastBudgets, fastSmallSteps} from './photo-low-ladder.mjs';
import {coefficientAnsSteps} from './coefficient-ans.mjs';
const effortOne = (width, height, quality, effort, screen) => effort === 1 && quality < 100 && !screen && splitRoute(width, height);
import {SPLIT_HOOKS} from './split-hooks.mjs';
import {stage, unit} from './step-journal.mjs';
import {V6, v6For, smallPicture, GABORISH, UPLOAD_PICTURE, UPLOAD_FLAT_PICTURE, uploadFlat, uploadGrain, uploadBandPicture} from './photo-v6-settings.mjs';

export {V6, GABORISH, UPLOAD_PICTURE, UPLOAD_FLAT_PICTURE};

export const blockSearchOptions = (data, width, height, deadzone = v6For(width, height).deadzone) => ({perceptual: true, deadzone,
  ids: screenLike(data, width, height) ? [4, 5, 6, 7, 3, 12, 13] : [4, 5, 6, 7], model: 'simple', rate: [1.0, 3, 2, 0.6], lambda: 0.28, sizeScale: 1.03});

const JOURNAL_JOIN = Symbol.for('rapier-jxl.journal.join');
export function admitV6Memory(rgba, width, height, memory) {
  const inputBytes = rgba[JOURNAL_JOIN] ? rgba.byteLength : rgba.buffer?.byteLength ?? rgba.byteLength;
  if (memory?.inputBytes !== undefined && memory.inputBytes < inputBytes) throw fault('JXL_MEMORY', 'Memory reservation omits retained input bytes.');
  const plan = memoryPlan(width * height, {...memory, inputBytes: memory?.inputBytes ?? inputBytes, width, height});
  if (plan.known && !plan.fits) throw fault('JXL_MEMORY', 'Photo encoding exceeds the supplied memory reservation.');
  return plan;
}
export const prepareV6 = (typeof __RAPIER_JXL_UPLOAD__ !== 'undefined' && __RAPIER_JXL_UPLOAD__ === true) ? null : function prepareV6(rgba, width, height, color = {}, memory = {}, {banded = false, upload = false} = {}) {
  const plan = admitV6Memory(rgba, width, height, memory), cache = plan.dct, whole = !(banded && plan.banded);
  const prepared = {rgba, width, height, color, memory: plan, pre: null, whole, pres: new Map(), upload,
    dct: whole && cache ? {} : null, dctPlain: cache ? {} : null};
  if (whole) prepared.pre = prePlanes(prepared, v6Options(prepared, 75));
  return prepared;
};
export const v6Options = (typeof __RAPIER_JXL_UPLOAD__ !== 'undefined' && __RAPIER_JXL_UPLOAD__ === true) ? null : function v6Options(prepared, quality) {
  if (!prepared.upload) return {...v6For(prepared.width, prepared.height), ...GABORISH, ...prepared.color};
  const {rgba, width, height} = prepared;
  prepared.facts ??= {flat: uploadFlat(rgba, width, height), grain: uploadGrain(rgba, width, height)};
  const {fastGaborish, uploadGrain: _, ...picture} = uploadBandPicture(prepared.facts.flat, prepared.facts.grain, quality);
  return {...picture, ...prepared.color};
};
const prePlanes = (prepared, options) => {
  let planes = prepared.pres.get(options.gaborish);
  if (!planes) prepared.pres.set(options.gaborish, planes = gaborishPlanes(prepared.rgba, prepared.width, prepared.height, options));
  return planes;
};

export const gaborishRows = (typeof __RAPIER_JXL_UPLOAD__ !== 'undefined' && __RAPIER_JXL_UPLOAD__ === true) ? null : function gaborishRows(data, width, height, options, sparse = false) {
  const W = Math.ceil(width / 8) * 8, M = PHOTO_BAND_MARGIN, windows = sparse ? new Map() : null;
  let band = null, pool = null;
  return (y0, y1, x0, x1) => {
    if (band && y0 >= band.top && y1 <= band.top + band.rows && (!band.cols || x0 >= band.cols[0] && x1 <= band.cols[1])) return band;
    if (sparse && x1 !== undefined) {
      y0 = Math.floor(y0 / 32) * 32; y1 = Math.ceil(y1 / 32) * 32; x0 = Math.floor(x0 / 32) * 32; x1 = Math.ceil(x1 / 32) * 32;
      const key = `${x0}:${x1}:${y0}:${y1}`, kept = windows.get(key);
      if (kept) return kept;
      const from = Math.max(0, Math.floor((y0 - M) / 8) * 8), to = Math.min(height, y1 + M), c0 = Math.max(0, Math.floor((x0 - M) / 8) * 8), c1 = Math.min(width, x1 + M);
      const cw = c1 - c0, crop = new Uint8Array(cw * (to - from) * 4);
      for (let y = from; y < to; y++) crop.set(data.subarray((y * width + c0) * 4, (y * width + c1) * 4), (y - from) * cw * 4);
      const planes = gaborishPlanes(crop, cw, to - from, options), Wc = Math.ceil(cw / 8) * 8, rows = Math.ceil((to - from) / 8) * 8;
      const win = {top: from, rows: Math.min(rows, y1 - from), cols: [x0, x1], left: c0, stride: Wc, planes};
      if (windows.size >= 32) windows.delete(windows.keys().next().value);
      windows.set(key, win);
      return win;
    }
    band = null;
    const top = Math.floor(y0 / 64) * 64, rows = Math.max(256, Math.ceil((y1 - top) / 64) * 64);
    const from = Math.max(0, top - M), to = Math.min(height, top + rows + M), need = W * Math.ceil((to - from) / 8) * 8;
    if (!pool || pool[0].length < need) pool = [0, 1, 2].map(() => new Float64Array(need));
    const planes = gaborishPlanes(data.subarray(from * width * 4, to * width * 4), width, to - from, options, pool);
    return band = {top, rows, planes: planes.map(p => p.subarray((top - from) * W))};
  };
};

export const photoV6Image = (typeof __RAPIER_JXL_UPLOAD__ !== 'undefined' && __RAPIER_JXL_UPLOAD__ === true) ? null : function photoV6Image(prepared, quality, cache = true) { return v6Image(prepared, quality, {}, cache); };

export const v6Image = (typeof __RAPIER_JXL_UPLOAD__ !== 'undefined' && __RAPIER_JXL_UPLOAD__ === true) ? null : function v6Image(prepared, quality, extra = {}, cache = true) {
  const {rgba, width, height, color, dct} = prepared, options = {...v6Options(prepared, quality), ...(extra.calibrationRow ? {calibrationRow: extra.calibrationRow} : {})};
  const pre = prepared.whole === false || !prepared.pres ? prepared.pre : prePlanes(prepared, options);
  if (pre) return complete(photoXYBSteps(rgba, width, height, quality, {...options, pre, dctCache: cache ? dctOf(prepared, options) : null, ...extra}));
  const image = bandedImage(rgba, width, height, quality, options, extra.fieldScale);
  if (extra.keepPlanes) image.planeRows = gaborishRows(rgba, width, height, options);
  return image;
};

const dctOf = (prepared, options) => {
  if (!prepared.dct) return null;
  prepared.dcts ??= new Map();
  let d = prepared.dcts.get(options.gaborish);
  if (!d) prepared.dcts.set(options.gaborish, d = prepared.dcts.size ? {} : prepared.dct);
  return d;
};
const bandedImage = (typeof __RAPIER_JXL_UPLOAD__ !== 'undefined' && __RAPIER_JXL_UPLOAD__ === true) ? null : function bandedImage(data, width, height, quality, options, field) {
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
};

function* bandsThenCoefficients(bands, encode) {
  let step, reply, coefficients = null, first = null, next;
  try {
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
    next = first ?? coefficients.next();
    while (!next.done) next = coefficients.next(yield scaled(next.value, done => 0.5 + done / 2));
    return next.value;
  } finally {
    if (!step?.done) bands.return?.();
    if (coefficients && !next?.done && !first?.done) coefficients.return?.();
  }
}

export const v6Trace = label => { const t = globalThis.__jxlTrace; if (t) t.push([label, performance.now()]); };
const SMALL_LADDER = 512 * 512;
export function* photoV6Steps(data, width, height, quality, effort, encodeCoefficients, search, color, gpu, memory, screen = false, both = false) {
  const blocks8 = !screen && effort >= 8 && quality < 100 && width >= 128 && height >= 128 && encodeCoefficients.splits;
  if (effort <= 3 || color && !blocks8) return yield* pictureSteps(data, width, height, quality, color ? Math.min(effort, 8) : effort, encodeCoefficients, color ? undefined : search, color, gpu, memory, screen, false, false, both);
  if (color) search = undefined;
  let hurry = false;
  function* share(steps, from, to) {
    let step, reply;
    try { while (!(step = steps.next(reply)).done) {
      const value = step.value;
      reply = yield typeof value === 'number' ? from + value * (to - from) : value;
      if (typeof value === 'number' && reply) hurry = true;
    } } finally { if (!step?.done) steps.return?.(); }
    return step.value;
  }
  if (!screen && (effort === 6 || effort === 7) && quality < 100 && width >= 128 && height >= 128 && encodeCoefficients.splits) {
    const bytes = yield* share(pictureSteps(data, width, height, quality, effort, encodeCoefficients, search, color, gpu, memory, screen, true, false, both), 0, 1);
    if (!hurry && bytes) return bytes;
    const late = yield* share(pictureSteps(data, width, height, quality, 1, encodeCoefficients, undefined, color, undefined, memory, screen), 1, 1);
    return bytes && bytes.length < late.length ? bytes : late;
  }
  const below = effort === 8 ? 1 : 0.85;
  function* written(made) {
    const {full} = made;
    made.full = null;
    let best = full, image = full?.image;
    if (full?.write) { v6Trace('write the full picture'); best = yield* share(full.write(), 0.8 * below, below); }
    v6Trace(`written (picture ${best?.length ?? 0} B)`);
    return best ? {bytes: best, image} : null;
  }
  if (blocks8) {
    let pair = {};
    const picture = (e, deferred = true) => pictureSteps(data, width, height, quality, e, encodeCoefficients, search, color, gpu, memory, screen, true, deferred, both, pair);
    let made;
    if (gpu) { made = yield* overlapped([picture(8, 'prelearn')], below); hurry ||= made.hurry; }
    else {
      made = {full: yield* share(picture(8), 0, 0.8 * below)};
      v6Trace('full picture done');
    }
    pair = null;
    const floor7 = hurry ? null : yield* written(made);
    made = null;
    const six = !hurry && floor7 && width * height < SMALL_LADDER ? yield* share(photoV6Steps(data, width, height, quality, 7, encodeCoefficients, undefined, color, undefined, memory, screen, both), below, below) : null;
    const least = bytes => six && six.length < bytes.length ? six : bytes;
    if (!hurry && floor7 && (effort === 8 || !search)) return least(floor7.bytes);
    if (!hurry && floor7) {
      const wantPlanes = width * height <= 2048 * 2048 && !color?.transform;
      const prepared = prepareV6(data, width, height, color, memory, {banded: !wantPlanes});
      const found = yield* share(search(prepared, () => photoV6Image(prepared, quality, true), quality, effort - 1, floor7, gpu), below, 1);
      return least(found && found.length < floor7.bytes.length ? found : floor7.bytes);
    }
    const best = floor7?.bytes ?? null;
    v6Trace('hurried: effort 1');
    const late = yield* share(pictureSteps(data, width, height, quality, 1, encodeCoefficients, undefined, color, undefined, memory, screen), 1, 1);
    return best && best.length < late.length ? best : late;
  }
  if (!screen && (effort === 4 || effort === 5) && quality < 100 && width >= 128 && height >= 128 && encodeCoefficients.splits) {
    const bytes = yield* share(pictureSteps(data, width, height, quality, effort, encodeCoefficients, search, color, gpu, memory, screen, true, false, both), 0, 1);
    if (!hurry && bytes) return bytes;
    const late = yield* share(pictureSteps(data, width, height, quality, 1, encodeCoefficients, undefined, color, undefined, memory, screen), 1, 1);
    return bytes && bytes.length < late.length ? bytes : late;
  }
  v6Trace('floor');
  const floor = yield* share(pictureSteps(data, width, height, quality, 1, encodeCoefficients, undefined, color, undefined, memory, screen), 0, 0.1);
  v6Trace('floor done');
  if (hurry) return floor;
  const bytes = yield* share(pictureSteps(data, width, height, quality, effort, encodeCoefficients, search, color, gpu, memory, screen, true, false, both), 0.1, 1);
  v6Trace('full picture done');
  return bytes && bytes.length < floor.length ? bytes : floor;
}

export function idleWork(steps) {
  let resolve;
  const work = {done: false, value: undefined, finished: new Promise(r => { resolve = r; }),
    step() { if (work.done) return; const s = steps.next(); if (s.done) { work.done = true; work.value = s.value; resolve(s.value); } },
    run() { while (!work.done) work.step(); return work.value; }};
  return work;
}
const nextTurn = () => new Promise(resolve => {
  if (typeof MessageChannel !== 'function') return setTimeout(() => resolve(null), 0);
  const {port1, port2} = new MessageChannel();
  port1.onmessage = () => { port1.close(); port2.close(); resolve(null); };
  port2.postMessage(0);
});
const overlapped = (typeof __RAPIER_JXL_UPLOAD__ !== 'undefined' && __RAPIER_JXL_UPLOAD__ === true) ? null : function* overlapped(steps, scale = 1) {
  const names = ['full picture', '16x16 picture'], ranges = [[0, 0.8 * scale], [0, 0.4 * scale]];
  const jobs = steps.map((it, k) => ({it, k, reply: undefined, pending: null, done: false, value: null}));
  let shown = 0, hurry = false, idle = 0, worked = 0;
  const background = [];
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
          else if (value?.idle) { if (!value.idle.done) background.push(value.idle); job.reply = undefined; }
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
      if (hurry || jobs.every(j => j.done)) { v6Trace(`overlap: the CPU idle ${Math.round(idle)} ms, ${Math.round(worked)} of it on idle work`); return {full: jobs[0].value, hurry}; }
      const waiting = jobs.filter(j => j.pending), since = performance.now();
      const race = Promise.race(waiting.map(w => w.pending.then(v => [w, v])));
      let first = null;
      for (let work; !first && (work = background.find(w => !w.done));) {
        const at = performance.now();
        work.step();
        worked += performance.now() - at;
        first = yield {await: Promise.race([race, nextTurn()])};
      }
      const [j, answer] = first ?? (yield {await: race});
      idle += performance.now() - since;
      v6Trace(`waited ${Math.round(performance.now() - since)} ms on the device (${waiting.map(w => ['full', '16x16'][w.k]).join(', ')})`);
      j.pending = null; j.reply = answer;
    }
  } finally {
    for (const j of jobs) if (!j.done) try { j.it.return?.(); } catch {}
  }
};

function* uploadPictureSteps(data, width, height, quality) {
  const [flat, grain] = yield* unit('upload-facts', () => { const flat = uploadFlat(data, width, height); return [flat, !flat && uploadGrain(data, width, height)]; });
  return uploadBandPicture(flat, grain, quality);
}

function* pictureSteps(data, width, height, quality, effort, encodeCoefficients, search, color, gpu, memory, screen = false, floored = false, deferred = false, both = true, pair = null) {
  if (effort <= 5 && !color && !screen && quality < 100 && smallPicture(width, height)) {
    const budgets = fastBudgets(effort, false, width * height);
    if (splitRoute(width, height)) return yield* photoSplitCandidates(data, width, height, quality, budgets, {screen: false});
    admitV6Memory(data, width, height, memory);
    let image;
    try { image = complete(photoXYBSteps(data, width, height, quality, {...v6For(width, height), fast: true, fastBand: true})); }
    catch (error) { if (error !== FAST_RANGE) throw error; image = complete(photoXYBSteps(data, width, height, quality, {...v6For(width, height)})); }
    return yield* fastSmallSteps(image, effort, {hurried: false}, true);
  }
  if (effort <= 3 && !color) {
    const gaborish = effort === 3 && quality < 100 && !screen;
    const picture = gaborish && (yield* uploadPictureSteps(data, width, height, quality)), flat = picture === UPLOAD_FLAT_PICTURE, grain = !!picture?.uploadGrain;
    if (quality < 100 && splitRoute(width, height) && (encodeCoefficients.splits || effort === 1)) {
      const bytes = yield {split: {pixels: width * height, run: (helpers, options) =>
        encodeSplit(data, width, height, quality, helpers, {...options, gaborish, uploadFlat: flat, grain})}};
      if (bytes) return bytes;
      if (!offloading()) {
        if (gaborish) admitV6Memory(data, width, height, memory);
        return yield* photoSplitSteps(data, width, height, quality, {gaborish, uploadFlat: flat, grain});
      }
    }
    if (gaborish) {
      admitV6Memory(data, width, height, memory);
      if (offloading()) return yield* bandsThenCoefficients(photoXYBBands(data, width, height, quality, picture, {}), image => encodeCoefficients(image, 3));
      const image = yield* part(photoXYBBands(data, width, height, quality, picture), 0, 2);
      return yield* part(encodeCoefficients(image, 3), 1, 2);
    }
    const image = offloading() && !screen ? yield* part(photoFastBands(data, width, height, quality, {...v6For(width, height), fast: true, fastBand: true}), 0, 2)
      : complete(photoXYBSteps(data, width, height, quality, screen ? {...v6For(width, height), fast: true, calibrationRow: 'screen'} : {...v6For(width, height), fast: true, fastBand: true}));
    const coded = effortOne(width, height, quality, effort, screen) ? coefficientAnsSteps(image, 2) : encodeCoefficients(image, effort);
    return yield* (offloading() ? part(coded, 1, 2) : coded);
  }
  if (effort <= 3 && color?.transform && !color.transform.gray) {
    if (quality < 100 && splitRoute(width, height)) {
      try { return yield* photoSplitCandidates(data, width, height, quality, [], {color, screen: false}); } catch (error) { if (error !== FAST_RANGE) throw error; }
    }
    admitV6Memory(data, width, height, memory);
    let image = null;
    try { image = complete(photoXYBSteps(data, width, height, quality, {...v6For(width, height), fast: true, ...color})); } catch (error) { if (error !== FAST_RANGE) throw error; }
    if (image) return yield* (effortOne(width, height, quality, effort, false) ? coefficientAnsSteps(image, 2) : encodeCoefficients(image, effort));
  }
  const blockDesign = screen ? (effort >= 8 ? 'full' : null) : effort === 6 || effort === 7 ? 'fast' : effort === 8 ? 'full' : null;
  const perceptualBlocks = blockDesign !== null && quality < 100 && width >= 128 && height >= 128 &&
    (!color || color.space || color.transform && !color.transform.gray);
  if (perceptualBlocks && !encodeCoefficients.blocks) throw fault('JXL_INTERNAL', 'The block picture needs photoAnsSteps (photo-v6-blocks.mjs).');
  const commonUpload = (effort === 4 || effort === 5) && quality < 100 && !screen && (!color || color.transform && !color.transform.gray);
  const picture = commonUpload && (yield* uploadPictureSteps(data, width, height, quality));
  if (gpu && effort <= 7 && !color && !screen && !perceptualBlocks && !commonUpload) {
    const image = yield {gpu: {kind: 'v6image', data, width, height, quality, options: {...v6For(width, height), ...GABORISH}, lib: {complete, photoXYBSteps, transformDCT8, dct8Basis, xyb: XYB_TABLES}}};
    if (image) return yield* encodeCoefficients(image, effort);
  }
  if (perceptualBlocks) return yield* encodeCoefficients.blocks({data, width, height, quality, effort, encodeCoefficients, color, gpu, memory, screen, floored, blockDesign, deferred, both, pair});
  if (effort <= 7 || !search || width < 8 || height < 8) {
    if ((effort === 4 || effort === 5) && !color && !screen && quality < 100 && width * height > 512 * 512 && encodeCoefficients.splits && SPLIT_HOOKS.ladder) {
      const bytes = yield {split: {pixels: width * height, run: (leased, options) => SPLIT_HOOKS.ladder(data, width, height, quality, leased, {...options, effort, uploadFlat: picture === UPLOAD_FLAT_PICTURE, grain: !!picture?.uploadGrain})}};
      if (bytes) return bytes;
    }
    admitV6Memory(data, width, height, memory);
    const options = picture && color ? {...v6For(width, height), ...GABORISH, tune: picture.tune, calibrationRow: picture.calibrationRow, ...color}
      : picture || {...v6For(width, height), ...GABORISH, ...color};
    const write = image => encodeCoefficients(image, effort);
    if (offloading()) return yield* bandsThenCoefficients(photoXYBBands(data, width, height, quality, options, color || {}), write);
    const image = yield* part(stage('floor-picture', () => photoXYBBands(data, width, height, quality, options)), 0, 2);
    return yield* part(write(image), 1, 2);
  }
  const wantPlanes = width >= 128 && height >= 128 && width * height <= 2048 * 2048 && !color?.transform && effort >= 9;
  const prepared = prepareV6(data, width, height, color, memory, {banded: !wantPlanes});
  return yield* search(prepared, () => photoV6Image(prepared, quality, true), quality, effort >= 9 ? effort - 1 : effort, null, gpu);
}
