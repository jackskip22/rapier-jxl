// SPDX-License-Identifier: MIT
import {cpuMeasure} from './photo-measure.mjs';
import {materialize} from './varblock-core.mjs';
import {reconstruct, reconstructYCbCr, toRGBA} from './reconstruct.mjs';
import {bandedRGBA, bandedOutputs, exactScores, subImage, RECON_MARGIN} from './photo-reconstruct-bands.mjs';
import {rebuildable, rebuildPicture} from './photo-rebuild.mjs';
import {linearFromRGBA} from './ssimulacra2.mjs';
import {linearFromTransformPlanes} from './color-transform.mjs';

import {linearFromTransform, linearOfCodedBytes} from './color-bytes.mjs';
import {finitePlanes} from './ssimulacra2-input.mjs';
import {photoReference} from './photo-reference.mjs';
import {nativeRGBA, nativeGammaRGBA, nativeTables, nativeByte} from './photo-output.mjs';
const NATIVE = {nativeTables, nativeByte};
import {rebuildKernels} from './rebuild-kernels.mjs';
import {xybKernelConstants} from './vardct-render.mjs';
import {DEFAULT_OPSIN} from "./opsin-defaults.mjs";
import {gaussianCoefficients, s2DeviceTables, bandsAtSpeed} from './ssimulacra2-arithmetic.mjs';
import {GAUSS} from './ssimulacra2-constants.mjs';
import {s2Interval} from './gpu-s2-score.mjs';
import {s2Stream} from './photo-s2-stream.mjs';
import {journaling, carried, unit, readAll, PASSED} from './step-journal.mjs';
import {s2CellStream, s2CellMap} from './s2-cells.mjs';
import {memoryPlan} from './memory-plan.mjs';
import {retainsWhole, BAND_PIXELS, WHOLE_BYTES, BANDED_BYTES, RETAINED_BYTES, ONE_PLANE_BYTES, BAND_CACHE_BYTES} from './memory-device.mjs';
import {bandScratch} from './band-scratch.mjs';
import {offloading, offloadWorkers} from './offload.mjs';
import {nativeBandOf} from './photo-band-score.mjs';
import {bandRecipe} from './photo-layout-picture.mjs';
import {scoreBandStorage, SCORE_BAND_ROWS} from './photo-band-storage.mjs';
import {fault} from './fault.mjs';
import {trialDue, trialRecord, leftDevice, trialGeneration} from './device-trial.mjs';
import {timed, timedSteps, traced, tracing} from './stage-trace.mjs';

const check = signal => { if (signal?.aborted) throw signal.reason; };
const ROWS = SCORE_BAND_ROWS, STEP = 512;
const SLICE = 128;
const edgeAt = (k, height) => Math.min(height, k ? k * STEP + RECON_MARGIN : 0);
const f32x3 = n => [0, 1, 2].map(() => new Float32Array(n));
const bandSub = (image, y0, y1, opts) => {
  const {width, components: [{stride, rows}]} = image, by1 = Math.min(rows, Math.ceil((y1 + RECON_MARGIN) / 64) * 8);
  const at = Math.max(0, Math.floor((y0 - RECON_MARGIN) / 64) * 8), by0 = by1 - at < 8 ? Math.max(0, at - 8) : at;
  return {made: rebuildPicture(subImage(image, 0, by0, stride, by1), opts), skip: (y0 - by0 * 8) * width, count: (y1 - y0) * width};
};

const eachYCbCr = (image, signal, fn) => {
  const {height, components: [{stride, rows}]} = image;
  for (let y = 0; y < height; y += ROWS) { check(signal); fn(y, subImage(image, 0, y / 8, stride, Math.min(rows, (y + ROWS) / 8))); }
};
export function selectedYCbCrRGBA(image, color, signal, native = false) {
  if (!native && !color.transform && rebuildable(image)) return bandedRGBA(image, ROWS);
  const out = new Uint8Array(image.width * image.height * 4);
  eachYCbCr(image, signal, (y, sub) => {
    const gamma = color.transform || native ? reconstructYCbCr(sub, {planes: true}) : null;
    out.set(color.transform ? (native ? nativeRGBA : toRGBA)(linearFromTransformPlanes(gamma, sub.width * sub.height, color.transform), sub.width, sub.height, {y})
      : native ? nativeGammaRGBA(gamma, sub.width, sub.height, {y}) : reconstructYCbCr(sub), y * image.width * 4);
  });
  return out;
}
export function selectedYCbCrLinear(image, color, signal) {
  const planes = [0, 1, 2].map(() => new Float64Array(image.width * image.height));
  eachYCbCr(image, signal, (y, sub) => {
    linearFromTransformPlanes(reconstructYCbCr(sub, {planes: true}), sub.width * sub.height, color.transform).forEach((p, c) => planes[c].set(p, y * image.width));
  });
  return planes;
}

const s2Scores = (lo, hi) => ({ssimulacra2: (lo + hi) / 2, doubt: {ssimulacra2: (hi - lo) / 2 * (1 + 1e-12) + 1e-12}});

export function wholeRebuildMeasure(data, width, height, color, signal, plan) {
  const nativeBand = nativeBandOf(width), pixels = width * height;
  const bandedPlan = journaling() || (plan ?? memoryPlan(pixels, {width, height})).banded;
  const retain = bandedPlan && !journaling() && !plan?.known && !offloading('score-band') && retainsWhole(pixels, RETAINED_BYTES);
  const cacheBytes = retain ? pixels * 64 : bandedPlan ? 0 : Math.min(64 * 1024 * 1024, Math.max(8 * 1024 * 1024, pixels * 64));
  const keepBand = !plan?.known && retainsWhole(pixels, (retain ? RETAINED_BYTES : bandedPlan ? BANDED_BYTES - WHOLE_BYTES : ONE_PLANE_BYTES) + (color.transform ? 12 : BAND_CACHE_BYTES));
  let probe32 = null, refCache = keepBand ? [] : null, outs = [null, null], outTurn = 0, pinned = null;
  const tagOf = image => image?.lookTag ?? image, findOut = image => outs.find(e => e?.img === tagOf(image))?.buf ?? null;
  const makeBuf = tr => tr ? [new Uint8Array(pixels * 4)] : [new Uint8ClampedArray(pixels * 4), new Uint8ClampedArray(pixels * 4)];
  const takeSlot = init => outs[outs[0]?.img === pinned ? 1 : outs[1]?.img === pinned ? 0 : (outTurn ^= 1) ^ 1] ??= {img: null, buf: init()};
  const openSlot = tr => { const sl = takeSlot(() => makeBuf(tr)); sl.img = null; if (sl.buf?.length !== (tr ? 1 : 2) || sl.buf[0].length !== pixels * 4) sl.buf = makeBuf(tr); return sl; };
  const finishStream = (stream, slot, filled, image, tr) => { const [pack, own] = stream.finish(); if (slot && filled === height) slot.img = tagOf(image); return tr ? {ssimulacra2: pack} : {ssimulacra2: Math.min(pack, own), nativeScores: {package: pack, native: own, minimum: Math.min(pack, own)}}; };
  const linBand = (u8, n, tag = 'cl') => linearFromTransform(u8, n, color.transform, [0, 1, 2].map(c => bandScratch(Float32Array, tag + c, n)));
  const refBand = (y, rows) => linBand(data.subarray(y * width * 4, (y + rows) * width * 4), rows * width, 'rl');
  const trBand = (img, y0, y1, out8) => { const {made, skip, count} = bandSub(img, y0, y1, {rgba: false, linear: true, views: true}); return linearOfCodedBytes(made.linear.map(x => x.subarray(skip, skip + count)), count, color.transform, [0, 1, 2].map(c => bandScratch(Float32Array, 'cl' + c, count)), out8); };
  const reference = color.transform ? () => finitePlanes(linearFromTransform(data, pixels, color.transform, f32x3(pixels))) : null;
  let cpu = null, device = null, constants = null, s2Tables = null, audits = 0, refused = false, bandStorage = null;
  const rebuildHeld = {}, s2Held = {}, s2Ok = !color.transform && width >= 8 && height >= 8 && ArrayBuffer.isView(data) && data.BYTES_PER_ELEMENT === 1;
  let s2Checked = false, s2Refused = false, s2Pending = null;
  let s2Later = false;
  const settleCheck = () => {
    if (!s2Pending) return;
    const {image, want, pictures, scores} = s2Pending;
    s2Pending = null; device = pictures;
    let exact;
    try { exact = cpuScores(image, want); } finally { device = null; }
    if (!(Math.abs(exact.ssimulacra2 - scores.ssimulacra2) <= scores.doubt.ssimulacra2)) {
      s2Refused = true;
      throw Object.assign(fault('JXL_WEBGPU', 'device score out of bounds'), {again: true});
    }
  };
  const auditRows = () => {
    const g0 = (audits++ * 7919 % Math.ceil(height / 64)) * 64, g1 = Math.min(height, g0 + 64), y0 = g0 + 24 < g1 ? g0 + 24 : g0;
    return [y0, Math.min(g1, y0 + 16)];
  };
  const expect = (image, [y0, y1]) => {
    const {made, skip, count} = bandSub(image, y0, y1, {rgba: true, linear: true});
    return {y0, skip, count, rgba: made.rgba, own: nativeRGBA(made.linear.map(p => p.subarray(skip, skip + count)), width, y1 - y0, {y: y0})};
  };
  const audit = (pictures, {y0, skip, count, rgba: made, own}) => {
    const at = pictures.band ? 0 : y0 * width * 4, rgba = pictures.band?.rgba ?? pictures.rgba, native = pictures.band?.native ?? pictures.native;
    for (let i = 0; i < count; i++) for (let c = 0; c < 3; c++)
      if (made[(skip + i) * 4 + c] !== rgba[at + i * 4 + c] || own[i * 4 + c] !== native[at + i * 4 + c]) return Infinity;
    return 0;
  };
  const reconstruction = () => cpu ??= cpuMeasure(data, width, height, {native: !color.transform, immutable: true, reference, cacheBytes,
    reconstruct: image => {
      if (!color.transform) return image.ycbcr ? linearFromRGBA(selectedYCbCrRGBA(image, color, signal), width * height)
        : reconstruct(materialize(image));
      if (image.ycbcr) return finitePlanes(linearOfCodedBytes(selectedYCbCrLinear(image, color, signal), pixels, color.transform, f32x3(pixels)));
      const out = probe32 ??= f32x3(pixels), reuse = keepBand && !journaling(), hit = reuse ? findOut(image) : null;
      if (hit) return finitePlanes(linearFromTransform(hit[0], pixels, color.transform, out));
      const slot = reuse ? openSlot(true) : null;
      if (rebuildable(image)) {
        if (pixels <= BAND_PIXELS) {
          check(signal);
          linearOfCodedBytes(rebuildPicture(image, {rgba: false, linear: true, views: true}).linear, pixels, color.transform, out, slot?.buf[0]);
        } else {
          for (let k = 0, y0 = 0; y0 < height; y0 = edgeAt(++k, height)) {
            check(signal);
            const y1 = edgeAt(k + 1, height), {made, skip, count} = bandSub(image, y0, y1, {rgba: false, linear: true, views: true});
            linearOfCodedBytes(made.linear.map(x => x.subarray(skip, skip + count)), count, color.transform, out.map(p => p.subarray(y0 * width, y1 * width)), slot?.buf[0].subarray(y0 * width * 4, y1 * width * 4));
          }
        }
      } else linearOfCodedBytes(reconstruct(materialize(image)), pixels, color.transform, out, slot?.buf[0]);
      finitePlanes(out);
      if (slot) slot.img = tagOf(image);
      return out;
    },
    bandedRGBA: image => image.ycbcr ? selectedYCbCrRGBA(image, color, signal) : bandedRGBA(image, ROWS),
    streamedScores(image) {
      if (device || image.ycbcr || color.transform || !okBytes
        || !bandsAtSpeed() || width * height * 36 <= cacheBytes) return null;
      const stream = s2Stream({rgba: data}, width, height, 2, false, false, refCache);
      try {
        bandedOutputs(image, ROWS, nativeBand, (y0, rows, pack, own) => { check(signal); stream.push(y0, rows, [pack, own]); });
        const [pack, own] = stream.finish();
        return {package: pack, native: own, minimum: Math.min(pack, own)};
      } finally { stream.release(); }
    },
    *rgbaOutputs(image, output) {
      const {banded} = output, reuse = !device && !image.ycbcr && keepBand && !journaling();
      const hit = reuse ? findOut(image) : null;
      let a, b;
      if (hit) [a, b] = hit;
      else {
        [a, b] = device ? [device.rgba, device.native]
          : image.ycbcr ? [selectedYCbCrRGBA(image, color, signal), selectedYCbCrRGBA(image, color, signal, true)]
          : banded ? (o => [o.package, o.native])(bandedOutputs(image, retain && pixels <= BAND_PIXELS ? Math.ceil(height / 64) * 64 : ROWS, nativeBand))
          : (lin => [toRGBA(lin, width, height), nativeRGBA(lin, width, height)])(output.linear);
        if (reuse) Object.assign(takeSlot(() => null), {img: tagOf(image), buf: [a, b]});
      }
      yield {kind: 'package', rgba: a};
      yield {kind: 'native', rgba: b};
    },
  });
  const cpuScores = (image, want) => timed(`cpu-score:${want?.arithmetic ?? 'binary64'}${device ? '+device-pictures' : ''}`,
    () => image.coefficientRows || image.ycbcr ? reconstruction().banded(image, {...want, butteraugli: false})
      : exactScores(reconstruction(), null, width, height, image, want, plan));
  const okBytes = width >= 8 && height >= 8 && (data instanceof Uint8Array || data instanceof Uint8ClampedArray);
  const canStream = image => !image.ycbcr && (!color.transform || !!findOut(image) || rebuildable(image)) && okBytes;
  const plainS2 = want => !!want?.ssimulacra2 && !want.butteraugli && want.p === undefined && want.margin === undefined;
  const streamsInJournal = (image, want) => canStream(image) && plainS2(want) && (want.arithmetic ?? 'binary64') === 'binary64' &&
    bandedPlan && (color.transform ? pixels * 36 > cacheBytes : bandsAtSpeed() && pixels * 36 > cacheBytes);
  const cpuSlice = (image, want) => {
    if (image.ycbcr || color.transform || !want?.ssimulacra2 || want.butteraugli || (want.arithmetic ?? 'binary64') !== 'binary64' ||
      want.p !== undefined || want.margin !== undefined || width < 8 || !(data instanceof Uint8Array || data instanceof Uint8ClampedArray) ||
      height < 8 * SLICE) return null;
    const stream = s2Stream({rgba: data}, width, height, 2, true, false);
    const t0 = performance.now();
    try {
      let ms = 0;
      for (let k = 0; k < 2; k++) {
        const y0 = k ? k * SLICE + RECON_MARGIN : 0, y1 = (k + 1) * SLICE + RECON_MARGIN, t = performance.now();
        bandedOutputs(image, y1 - y0, nativeBand, (y, rows, pack, own) => { check(signal); stream.push(y, rows, [pack, own]); }, y0, y1);
        ms = (performance.now() - t) * height / (y1 - y0);
      }
      if (tracing()) traced('trial:photo-rebuild:slice', performance.now() - t0);
      return ms;
    } finally { stream.release(); }
  };
  function* streamedSteps(image, libjxl = false) {
    const resume = journaling(), tr = !!color.transform, nOut = tr ? 1 : 2, ref = tr ? refBand : {rgba: data}, cache = resume ? null : refCache;
    const reuse = keepBand && !resume, hit = reuse ? findOut(image) : null;
    const slot = reuse && !hit ? openSlot(tr) : null;
    let stream = null, place = null, filled = 0;
    try {
      for (let k = 0, y0 = 0; y0 < height; y0 = edgeAt(++k, height)) {
        const y1 = edgeAt(k + 1, height);
        const saved = yield* carried('score-band', () => {
          if (!stream) { stream = s2Stream(ref, width, height, nOut, resume, libjxl, cache); if (place) stream.restore(place); }
          if (stream.rows !== y0) throw fault('JXL_INTERNAL', 'photo-whole-rebuild:order');
          if (hit) {
            check(signal);
            stream.push(y0, y1 - y0, tr ? [linBand(hit[0].subarray(y0 * width * 4, y1 * width * 4), (y1 - y0) * width)] : hit.map(b => b.subarray(y0 * width * 4, y1 * width * 4)));
          } else if (tr) {
            check(signal);
            stream.push(y0, y1 - y0, [trBand(image, y0, y1, slot && filled === y0 ? (filled = y1, slot.buf[0].subarray(y0 * width * 4, y1 * width * 4)) : null)]);
          } else bandedOutputs(image, y1 - y0, nativeBand, (y, r, pack, own) => {
            check(signal);
            if (slot && filled === y) { slot.buf[0].set(pack.subarray(0, r * width * 4), y * width * 4); slot.buf[1].set(own.subarray(0, r * width * 4), y * width * 4); filled = y + r; }
            stream.push(y, r, [pack, own]);
          }, y0, y1);
          return resume ? stream.save() : null;
        });
        if (saved !== PASSED && saved !== null && !stream) place = saved;
        if (!resume) yield 0;
      }
      if (!stream) { stream = s2Stream(ref, width, height, nOut, resume, libjxl, cache); stream.restore(place); }
      return finishStream(stream, slot, filled, image, tr);
    } finally { stream?.release(); }
  }
  const mapsInJournal = (image, want) => !image.ycbcr && !color.transform && (want?.p !== undefined || want?.margin !== undefined) &&
    !want.ssimulacra2 && !want.butteraugli && okBytes &&
    (plan ?? memoryPlan(width * height, {width, height})).banded;
  function* mapSteps(image) {
    let stream = null, place = null;
    const parts = [], open = () => { stream = s2CellStream({rgba: data}, width, height); if (place) stream.restore(place); };
    for (let y0 = 0; y0 < height; y0 += ROWS) {
      parts.push(yield* unit('map-band', () => {
        if (!stream) open();
        check(signal);
        return stream.push(y0, Math.min(ROWS, height - y0), bandedRGBA(image, ROWS, undefined, y0, y0 + ROWS));
      }, undefined, false, true));
      const saved = yield* carried('map-place', () => stream.save(), undefined, true);
      if (saved !== PASSED && !stream) place = saved;
    }
    readAll(parts.flatMap(part => part.flatMap(({sums}) => sums)));
    if (!stream) open();
    const {cells} = s2CellMap(stream.finish(parts), width, height);
    return {cells, blocks: cells.slice()};
  }
  const helped = image => image.recipe && image.lazyStrategy && offloading('score-band') && canStream(image) && bandedPlan &&
    (color.transform ? pixels * 36 > cacheBytes : bandsAtSpeed() && pixels * 36 > cacheBytes);
  function* helpedSteps(image, libjxl = false) {
    const tr = !!color.transform, reuse = keepBand && !journaling();
    if (reuse && findOut(image)) return yield* streamedSteps(image, libjxl);
    const slot = reuse ? openSlot(tr) : null;
    const look = {}, count = Math.ceil(height / ROWS), ahead = Math.min(count, offloadWorkers()), tasks = new Map();
    bandStorage ??= scoreBandStorage(width, height, ahead, bandRecipe);
    if (bandStorage.count !== ahead) throw fault('JXL_INTERNAL', 'photo-whole-rebuild:ahead');
    const storage = bandStorage;
    const taskAt = k => {
      const y0 = k * ROWS, y1 = Math.min(height, y0 + ROWS), task = storage.take({data, recipe: image.recipe, look, y0, y1});
      tasks.set(k, task);
      return task;
    };
    const stream = s2Stream(tr ? refBand : {rgba: data}, width, height, tr ? 1 : 2, false, libjxl, refCache);
    let finished = false, filled = 0;
    try {
      yield {offload: 'prefetch', tasks: Array.from({length: ahead}, (_, k) => taskAt(k))};
      for (let k = 0; k < count; k++) {
        const task = tasks.get(k), made = yield {offload: 'run', task};
        check(signal);
        const box = made ? (storage.receive(task, made), made) : storage.lost(task), {y0, y1} = task, rows = y1 - y0;
        tasks.delete(k);
        if (made && k + ahead < count) yield {offload: 'prefetch', tasks: [taskAt(k + ahead)]};
        if (!made && tr) stream.push(y0, rows, [trBand(image, y0, y1, slot && filled === y0 ? (filled = y1, slot.buf[0].subarray(y0 * width * 4, y1 * width * 4)) : null)]);
        else {
          if (!made) bandedOutputs(image, ROWS, nativeBand, null, y0, y1, {package: box.pack, native: box.own});
          if (slot && filled === y0) { slot.buf[0].set(box.pack, y0 * width * 4); if (!tr) slot.buf[1].set(box.own, y0 * width * 4); filled = y1; }
          stream.push(y0, rows, tr ? [linBand(box.pack, rows * width, 'hl')] : [box.pack, box.own]);
        }
        storage.release(box);
        if (!made && k + ahead < count) yield {offload: 'prefetch', tasks: [taskAt(k + ahead)]};
      }
      const out = finishStream(stream, slot, filled, image, tr);
      finished = true;
      return out;
    } finally {
      stream.release(); tasks.clear();
      if (!finished) { storage.destroy(); bandStorage = null; }
    }
  }
  const cpuOnly = (image, want) => canStream(image) && plainS2(want) && (want.arithmetic ?? 'binary64') === 'binary64';
  const cpuLook = function* (image, want) {
    return helped(image) ? yield* timedSteps('helper-score', helpedSteps(image)) : streamsInJournal(image, want) ? yield* timedSteps('band-score', streamedSteps(image)) : cpuScores(image, want);
  };
  const libjxlStreams = (image, want) => !refused && canStream(image) && plainS2(want) && want.arithmetic === 'libjxl';
  const helperReading = (image, want) => plainS2(want) &&
    ((want.arithmetic ?? 'binary64') === 'libjxl' || !want.doubt) && helped(image);
  const cpuRoute = (image, want) => refused || image.ycbcr || color.transform || !plainS2(want) || (want.arithmetic ?? 'binary64') !== 'binary64';
  const started = new WeakMap();
  const startLook = function* (image, want) {
    const kernels = rebuildKernels();
    constants ??= xybKernelConstants(DEFAULT_OPSIN.inverseMatrix.map(Math.fround), DEFAULT_OPSIN.opsinBiases, 255);
    const s2 = (want.doubt || !s2Checked) && s2Ok && !s2Refused ? {held: s2Held, tables: s2Tables ??= s2DeviceTables(gaussianCoefficients(GAUSS)), reference: data, width, height} : null;
    const rows = auditRows(), keep = !!(want.doubt && s2 && s2Checked);
    let submitted;
    const request = {kind: 'photo-rebuild', image, rebuild: rebuildPicture, kernels, constants, native: NATIVE,
      held: rebuildHeld, band: rows, keep, ...(s2 && {s2}), submitted: new Promise(done => { submitted = done; })};
    request.onSubmit = submitted;
    const t0 = performance.now();
  return {image, want, s2, rows, request, t0, from: trialGeneration(), pending: yield {gpu: request, later: true}};
  };
  const finishLook = function* ({image, want, s2, rows, request, t0, from, pending}) {
    if (!pending) return yield* cpuLook(image, want);
    const answer = Promise.resolve(pending);
    let tried = null, resolved;
    const safeAnswer = answer.then(value => (resolved = value), () => (resolved = null));
    if (trialDue('photo-rebuild', width * height)) {
      yield {await: safeAnswer};
      const t1 = performance.now(), ok = !!(resolved?.rgba || resolved?.px), sliced = ok ? cpuSlice(image, want) : null;
      if (!ok) return yield* cpuLook(image, want);
      if (sliced === null) {
        tried = yield* cpuLook(image, want);
        if (!trialRecord('photo-rebuild', width * height, t1 - t0, performance.now() - t1, from)) return tried;
      } else if (!trialRecord('photo-rebuild', width * height, t1 - t0, sliced, from)) return yield* cpuLook(image, want);
    }
    yield {await: Promise.race([request.submitted, safeAnswer])};
    const expected = timed('audit-rows', () => expect(image, rows));
    settleCheck();
    let pictures = yield {await: safeAnswer};
    if (!pictures?.rgba && !pictures?.px) return tried ?? (yield* cpuLook(image, want));
    if (!(audit(pictures, expected) <= 1)) { refused = true; traced('refuse:audit-rows', 0); yield {gpu: {kind: 'refuse'}}; return tried ?? (yield* cpuLook(image, want)); }
    const range = (answer, o) => answer && !answer.flagged && answer.sums[o] ? s2Interval(answer.sums[o], answer.sizes) : null;
    let scores = null;
    if (s2) {
      const ranges = [0, 1].map(o => range(pictures.s2, o));
      if (ranges.every(Boolean)) scores = s2Scores(Math.min(...ranges.map(r => r[0])), Math.min(...ranges.map(r => r[1])));
    }
    if (scores && want.doubt && s2Checked) return scores;
    if (!pictures.rgba) {
      const t0 = tracing() ? performance.now() : 0;
      pictures = yield {await: pictures.readAll()};
      if (t0) traced('device-readback', performance.now() - t0);
    }
    if (scores && !tried && !s2Checked && s2Later && want.doubt && !journaling()) {
      s2Checked = true; s2Pending = {image, want, pictures: {rgba: pictures.rgba, native: pictures.native}, scores};
      return scores;
    }
    device = pictures;
    try {
      const exact = tried ?? cpuScores(image, want);
      if (scores) {
        s2Checked = true;
        if (!(Math.abs(exact.ssimulacra2 - scores.ssimulacra2) <= scores.doubt.ssimulacra2)) s2Refused = true;
      }
      return exact;
    } finally { device = null; }
    };
  return {
    pin(image, set) { if (set) pinned = tagOf(image); return keepBand && !journaling() && !!findOut(image); },
    *measureSteps(image, want) {
      if (journaling() && streamsInJournal(image, want)) return yield* timedSteps('band-score', streamedSteps(image));
      if (journaling() && mapsInJournal(image, want)) return yield* mapSteps(image);
      const value = this.measure(image, want);
      return typeof value?.next === 'function' ? yield* value : value;
    },
    measure: (image, want) => helperReading(image, want) ? timedSteps('helper-score', helpedSteps(image, (want.arithmetic ?? 'binary64') === 'libjxl'))
      : libjxlStreams(image, want) ? timedSteps('band-score', streamedSteps(image, true))
      : cpuRoute(image, want)
      ? (tracing() && traced('cpu-route:' + (refused ? 'refused' : image.ycbcr ? 'ycbcr' : color.transform ? 'transform' : !want?.ssimulacra2 ? 'no-s2'
        : want.butteraugli ? 'butteraugli' : want.p !== undefined ? 'p' : want.margin !== undefined ? 'margin' : 'arithmetic'), 0),
        (refused || color.transform) && cpuOnly(image, want) ? cpuLook(image, want) : cpuScores(image, want)) : (function* () {
        if (leftDevice('photo-rebuild', width * height)) return yield* cpuLook(image, want);
        const look = started.get(image);
        if (look?.want === want) { started.delete(image); return yield* finishLook(look); }
        return yield* finishLook(yield* startLook(image, want));
      })(),
    *begin(image, want) {
      if (helperReading(image, want) || libjxlStreams(image, want) || cpuRoute(image, want) || leftDevice('photo-rebuild', width * height) || started.has(image)) return;
      started.set(image, yield* startLook(image, want));
    },
    later() { s2Later = true; },
    settle: settleCheck,
    destroy() { s2Pending = null; cpu?.destroy(); cpu = null; bandStorage?.destroy(); bandStorage = null; probe32 = null; outs = [null, null]; pinned = null; if (refCache) refCache.length = 0; s2Held.state?.release(); rebuildHeld.release?.(); },
  };
}