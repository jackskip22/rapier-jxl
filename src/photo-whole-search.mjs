// SPDX-License-Identifier: MIT
import {shown} from './photo-shown.mjs';
import {complete} from './bits.mjs';
import {prepareV6, blockSearchOptions, V6, GABORISH, gaborishRows, v6Options} from './photo-v6.mjs';
import {v6For, smallPicture} from './photo-v6-settings.mjs';
import {journalFact, JOIN, unit, stage, journaling} from './step-journal.mjs';
import {smoothPhoto} from './v7/low-photo.mjs';
import {stillPhotoProvider} from './photo-v6-provider.mjs';
import {photoXYBSteps, XYB_TABLES} from './photo-xyb.mjs';
import {transformDCT8, dct8Basis} from './photo-dct.mjs';
import {lowWholePhoto} from './photo-low.mjs';
import {qualitySteps} from './photo-quality-search.mjs';
import {plainLayout, planeLayoutSteps} from './photo-plane-levels.mjs';
import {fixedStrategyImage} from './varblock-core.mjs';
import {planeSearchSteps, planeSearchLayoutSteps} from './photo-plane-search.mjs';
import {planeMeasuredSteps} from './photo-plane-measured.mjs';
import {scoreSteps, AQ, CANDIDATES} from './photo-search.mjs';
import {maskEnergy, maskWeights} from './photo-mask.mjs';
import {memoryPlan} from './memory-plan.mjs';
import {wholePhotoTarget, wholePhotoFloor, wholePhotoSmaller, wholePhotoMeasurements} from './photo-whole-policy.mjs';
import {admitSize} from './admit.mjs';
import {s2Dimensions, s2RGBA} from './ssimulacra2-input.mjs';
import {EDGE} from './limits.mjs';
import {fault} from './fault.mjs';
import {bandScratch} from './band-scratch.mjs';
import {MEASURED_EFFORT, measuredLevel} from './effort-level.mjs';

const check = signal => { if (signal?.aborted) throw signal.reason; };
const ROWS = 256;
const DUMMY_8X8 = new Uint8Array(256).fill(128), EMPTY_I16 = new Int16Array(0);

function plainRows(data, width, height, color) {
  let held = null;
  return (from, to) => {
    if (held && from >= held.top && to <= held.top + held.planes[0].length / held.stride) return held;
    const top = Math.floor(from / ROWS) * ROWS, end = Math.min(height, Math.max(top + ROWS, to));
    const {planes} = complete(photoXYBSteps(data.subarray(top * width * 4, end * width * 4), width, end - top, 85,
      {...color, planesOnly: true}));
    return held = {planes, top, stride: Math.ceil(width / 8) * 8};
  };
}

function wholeProvider(prepared, signal, device = false) {
  const {rgba, width, height, color} = prepared, still = stillPhotoProvider(prepared), sources = new Map();
  const v6 = v6For(width, height), coreAt = quality => v6Options(prepared, quality), lib = {complete, photoXYBSteps, transformDCT8, dct8Basis, xyb: XYB_TABLES};
  const gabs = [], keyOf = (filter, quality) => {
    if (filter !== 'gaborish') return filter;
    const gab = coreAt(quality).gaborish;
    let at = gabs.indexOf(gab);
    if (at < 0) at = gabs.push(gab) - 1;
    return 'gaborish:' + at;
  };
  const retarget = (source, quality, options) => {
    const filter = options.filter ?? 'gaborish', base = source.base, {stride, rows} = base.components[0];
    const probe = complete(photoXYBSteps(DUMMY_8X8, 8, 8, quality, {...(filter === 'plain' ? {...v6, ...color} : coreAt(quality)), noLevels: true}));
    const components = probe.components.map(c => ({h: 1, v: 1, stride, rows, quant: c.quant, coeffs: EMPTY_I16}));
    const fieldScale = options.fieldScale, quantFields = fieldScale && new Int32Array(stride * rows);
    if (quantFields) for (let i = 0; i < quantFields.length; i++) quantFields[i] = Math.max(1, Math.min(256, Math.round(64 * fieldScale[i])));
    const out = {...base, components, epf: quantFields ? probe.epf * 2 : probe.epf,
      ...(quantFields ? {quantFields, quantFieldBase: 64} : {quantFields: undefined, quantFieldBase: undefined})};
    return Object.defineProperty(out, 'planeBound', {get: source.getBound, enumerable: true, configurable: true});
  };
  const journal = journaling();
  const makeSource = (key, image, filter, quality) => {
    {
      const stride = image.components[0].stride, rows = image.components[0].rows, W = stride * 8, H = rows * 8;
      const planes = image.planes ?? (filter === 'gaborish' ? prepared.pres?.get(coreAt(quality).gaborish) ?? null : null);
      const rowsOf = planes ? () => ({planes, top: 0, stride: W})
        : image.planeRows ?? (filter === 'plain' ? plainRows(rgba, width, height, color) : gaborishRows(rgba, width, height, coreAt(quality), true));
      const planeRows = (from, to, x0, x1) => ({stride: W, ...rowsOf(from, to, x0, x1)});
      const devicePlanes = {};
      let bound = null;
      const getBound = () => {
        if (bound === null) {
          bound = 0;
          const needMask = filter === 'gaborish' && !devicePlanes.maskWeight, hf = needMask ? new Float64Array(stride * rows) : null;
          const staged = typeof navigator !== 'undefined' && navigator.gpu ? new Map() : null;
          for (let from = 0; from < H; from += ROWS) {
            check(signal);
            const to = Math.min(H, from + ROWS), band = planeRows(from, to), start = (from - band.top) * W, end = start + (to - from) * W, count = end - start;
            if (hf) maskEnergy(band.planes, band.top, stride, from / 8, to / 8, hf);
            const trio = [];
            for (let c = 0; c < 3; c++) {
              const p = band.planes[c], pairs = staged ? new Float32Array(count * 2) : bandScratch(Float32Array, 'plane-pairs', count * 2);
              let worst = 0;
              for (let i = 0; i < count; i++) {
                const value = p[start + i], hi = Math.fround(value), lo = Math.fround(value - hi);
                if (!Number.isFinite(value) || !Number.isFinite(hi) || !Number.isFinite(lo))
                  throw new Error('A photo plane cannot be represented by finite double-single samples.');
                const err = Math.abs(value - (hi + lo));
                if (err > worst) worst = err;
                pairs[i * 2] = hi; pairs[i * 2 + 1] = lo;
              }
              const b32 = new Float32Array([worst]);
              if (b32[0] < worst) new Uint32Array(b32.buffer)[0]++;
              if (!Number.isFinite(b32[0])) throw new Error('A photo plane split error has no finite f32 bound.');
              if (b32[0] > bound) bound = b32[0];
              trio.push(pairs);
            }
            staged?.set(from + ':' + to, trio);
          }
          if (hf) devicePlanes.maskWeight = maskWeights(hf, stride, rows).weight;
          if (staged) devicePlanes.staged = staged;
        }
        return bound;
      };
      const base = Object.defineProperty({...image, components: image.components.map(c => ({...c, coeffs: EMPTY_I16})), ...(planes && {planes}), planeRows, devicePlanes},
        'planeBound', {get: getBound, enumerable: true, configurable: true});
      const setBound = (saved, mask) => { bound = saved; if (mask) devicePlanes.maskWeight = mask; };
      const source = {planeRows, getBound, setBound, devicePlanes, base}; sources.set(key, source);
      return source;
    }
  };
  const canonical = (image, filter, quality) => {
    const key = keyOf(filter, quality);
    const source = sources.get(key) ?? makeSource(key, image, filter, quality);
    return Object.defineProperty({...image, ...(source.base.planes && {planes: source.base.planes}), planeRows: source.planeRows, devicePlanes: source.devicePlanes},
      'planeBound', {get: source.getBound, enumerable: true, configurable: true});
  };
  const sourceSteps = function* (quality) {
    const key = keyOf('gaborish', quality);
    if (sources.has(key)) return;
    const record = yield* unit('whole-source', () => {
      const {planeRows: _r, planes: _p, ...image} = still.base(quality, {keepPlanes: true});
      return Object.fromEntries(Object.entries({...image, components: image.components.map(c => ({...c, coeffs: EMPTY_I16}))}).filter(([, v]) => v !== undefined));
    });
    if (!sources.has(key)) makeSource(key, {...record, planeRows: gaborishRows(rgba, width, height, coreAt(quality))}, 'gaborish', quality);
    const source = sources.get(key);
    const saved = yield* unit('whole-bound', () => ({bound: source.getBound(), mask: source.devicePlanes.maskWeight ?? null}));
    source.setBound(saved.bound, saved.mask);
  };
  const provider = {...still,
    blockOptions(base) { return {...still.blockOptions(base), model: 'simple'}; },
    base(quality, options = {}) {
      check(signal);
      const filter = options.filter ?? 'gaborish';
      if (options.keepPlanes && sources.has(keyOf(filter, quality))) return retarget(sources.get(keyOf(filter, quality)), quality, options);
      const image = still.base(quality, {...options, ...(filter === 'plain' && {keepPlanes: false})});
      return options.keepPlanes ? canonical(image, filter, quality) : image;
    },
    *baseSteps(quality, options = {}) {
      const filter = options.filter ?? 'gaborish';
      if (journal && options.keepPlanes && filter === 'gaborish' && !prepared.pres?.get(coreAt(quality).gaborish)) {
        yield* sourceSteps(quality);
        check(signal);
        return retarget(sources.get(keyOf(filter, quality)), quality, options);
      }
      if (options.keepPlanes && sources.has(keyOf(filter, quality))) {
        check(signal);
        return retarget(sources.get(keyOf(filter, quality)), quality, options);
      }
      if (device && filter === 'gaborish' && options.fieldScale === undefined) {
        check(signal);
        const request = {data: rgba, width, height, quality, options: {...coreAt(quality), ...(options.keepPlanes && {noLevels: true})}, lib, audit: made => made?.gpuAudit?.blocks > 0 ? made.gpuAudit.worst : Infinity};
        const image = yield {gpu: request};
        check(signal);
        if (image && request.audit(image) <= 1) {
          if (!options.keepPlanes) return image;
          if (!sources.has(keyOf('gaborish', quality)) && !prepared.pres?.get(coreAt(quality).gaborish)) image.planeRows = gaborishRows(rgba, width, height, coreAt(quality), true);
          return canonical(image, 'gaborish', quality);
        }
      }
      return this.base(quality, options);
    },
    *image(quality, options = {}) {
      if (journal) {
        if ((options.filter ?? 'gaborish') === 'gaborish' && !prepared.pres?.get(coreAt(quality).gaborish)) yield* sourceSteps(quality);
        const self = this;
        return {deferred: function* () { const base = yield* self.baseSteps(quality, {...options, keepPlanes: true}); return self.lazy(base, plainLayout(base), self.blockOptions(base)); }};
      }
      const base = yield* this.baseSteps(quality, {...options, keepPlanes: true});
      return yield* planeLayoutSteps(base, width, height, plainLayout(base), this.blockOptions(base), signal);
    },
    *write(image, effort, options) {
      while (image?.deferred) image = yield* image.deferred();
      return yield* still.write(image, effort, options);
    },
    sourceSteps,
    lazy(base, layout, options) {
      const {planeRows: _r, devicePlanes: _d, planes: _p, ...fields} = base;
      let byRow = null;
      const rows = (by0, by1) => {
        if (!byRow) { byRow = Array.from({length: base.components[0].rows}, () => []); for (const entry of layout) byRow[entry.by].push(entry); }
        base.planeRows?.(by0 * 8, Math.min(byRow.length, by1) * 8);
        const entries = [];
        for (let by = by0; by < Math.min(by1, byRow.length); by++) entries.push(...byRow[by]);
        return fixedStrategyImage(base, width, height, {...options, layout: entries}).image;
      };
      return {...fields, width, height, components: base.components, layout,
        lazyStrategy: {rows, materialize: () => fixedStrategyImage(base, width, height, {...options, layout}).image}};
    },
    *layout(base, layout, options) {
      const kept = base.planeRows && base.devicePlanes ? base : canonical(base, 'gaborish', 75);
      return journal ? this.lazy(kept, layout, options) : yield* planeLayoutSteps(kept, width, height, layout, options, signal);
    },
  };
  return {provider, prepared, release: () => { for (const source of sources.values()) source.devicePlanes.release?.(); sources.clear(); }};
}

const packLayout = layout => { const out = new Int32Array(layout.length * 3); layout.forEach(({id, bx, by}, i) => { out[i * 3] = id; out[i * 3 + 1] = bx; out[i * 3 + 2] = by; }); return out; };
const unpackLayout = packed => Array.from({length: packed.length / 3}, (_, i) => ({id: packed[i * 3], bx: packed[i * 3 + 1], by: packed[i * 3 + 2]}));
const SHARED_SEARCH = {blocks: planeSearchSteps, options: blockSearchOptions, measured: planeMeasuredSteps,
  score: scoreSteps, aq: AQ, candidates: CANDIDATES};
const WANT_S2 = {ssimulacra2: true, butteraugli: false};
const DOWN_FROM = 1, DOWN_PROBES = [4, 4, 6], DOWN_LAST_AIM = 0.35, FLOOR_EFFORT = MEASURED_EFFORT - 1;
const LEAN_EFFORT = 7, LEAN_PROBES = 6;
const leanStart = quality => Math.max(1, quality - (quality < 85 ? 7 : 4));

export function* wholePhotoSteps(data, width, height, options) {
  const steps = wholeSteps(data, width, height, options), signal = options.signal;
  let step, reply, failed = false;
  try {
    for (;;) {
      check(signal);
      step = steps.next(reply);
      if (step.done) return step.value;
      reply = yield step.value;
    }
  } catch (error) { failed = true; throw error; }
  finally { try { steps.return?.(); } catch (error) { if (!failed) throw error; } }
}

const CODER = [1, 99.9], CAP_PROBES = 3, CAP_OVER = 0.05, FOLLOW = 4, FOLLOW_AIM = .999, FOLLOW_ENOUGH = .997;
export function curveBytes(points, q) {
  if (points.length === 1) return points[0].bytes;
  const above = points.findIndex(row => row.quality >= q), k = above < 0 ? points.length - 1 : Math.max(above, 1);
  const a = points[k - 1], b = points[k];
  if (a.quality === b.quality) return b.bytes;
  return Math.exp(Math.log(a.bytes) + (Math.log(b.bytes) - Math.log(a.bytes)) * (q - a.quality) / (b.quality - a.quality));
}
function* follow(targetBytes, curve, minQuality, maxQuality) {
  const points = curve.slice().sort((a, b) => a.quality - b.quality), before = q => curveBytes(points, q);
  const fitted = points.filter(row => row.bytes <= targetBytes).reduce((a, b) => !a || b.quality > a.quality ? b : a, null);
  const tried = [], own = [];
  let q = fitted?.quality ?? points[0].quality, best = null, miss = null;
  for (let n = 0; n < FOLLOW && q >= minQuality && q <= maxQuality && !tried.includes(q); n++) {
    const {bytes} = yield q, length = bytes.byteLength, ratio = length / before(q);
    tried.push(q);
    if (length <= targetBytes) { if (!(best?.quality >= q)) best = {quality: q, bytes: length}; }
    else if (!(miss?.quality <= q)) miss = {quality: q, bytes: length};
    if (best?.bytes >= targetBytes * FOLLOW_ENOUGH) break;
    own.push({quality: q, bytes: length});
    let low = best?.quality ?? minQuality, high = miss?.quality ?? maxQuality;
    if (high - low < 1e-3) break;
    let lo = low, hi = high;
    const [a, b] = own.slice().sort((x, y) => Math.abs(Math.log(x.bytes / targetBytes)) - Math.abs(Math.log(y.bytes / targetBytes)));
    const at = b && a.quality !== b.quality && a.bytes !== b.bytes
      ? x => Math.exp(Math.log(a.bytes) + (Math.log(b.bytes) - Math.log(a.bytes)) * (x - a.quality) / (b.quality - a.quality))
      : x => before(x) * ratio;
    for (let i = 0; i < 40; i++) { const mid = (lo + hi) / 2; if (at(mid) <= targetBytes * FOLLOW_AIM) lo = mid; else hi = mid; }
    q = Math.round(lo * 100) / 100;
    if (!(q > low) && best) break;
    if (!(q < high)) q = Math.round((low + high) * 50) / 100;
  }
}

function* wholeSteps(data, width, height, {quality, colorSpace = 'srgb', effort, readingWebp, signal,
  firstEffort = effort, retainFloor = null, photoAdmission = null, photoSearch = null, maxPixels, measureOutput = null, imageMeasure = null, fit = null, preview = null}) {
  if (quality >= 100) return null;
  if (effort >= MEASURED_EFFORT) {
    if (maxPixels !== undefined) {
      if (!Number.isSafeInteger(maxPixels) || maxPixels < 1)
        throw fault('JXL_INPUT', 'A whole-photo pixel limit is a positive whole number.');
      admitSize(width, height, {pixels: maxPixels, edge: EDGE});
    }
    if (journalFact(data, JOIN)) data = data.subarray(0, data.length);
    data = s2RGBA(data, s2Dimensions(width, height), true);
  }
  const smooth = !measureOutput && colorSpace === 'srgb' ? yield* unit('low-smooth', () => smoothPhoto(data, width, height)) : undefined;
  const {color, steps: low} = lowWholePhoto(data, width, height, {colorSpace, signal, smooth});
  if (effort < MEASURED_EFFORT) return yield* low({quality, effort});
  const lean = effort >= LEAN_EFFORT && readingWebp !== undefined && !measureOutput && !fit && !smallPicture(width, height), leanWrite = effort, leanOnly = lean && effort === LEAN_EFFORT;
  firstEffort = firstEffort >= effort ? measuredLevel(effort) : Math.min(firstEffort, 5);
  effort = measuredLevel(effort);
  const upload = !measureOutput && !color?.transform && (color?.space ?? 'srgb') === 'srgb' && !smallPicture(width, height);
  const search = photoSearch ?? SHARED_SEARCH, measured = search.measured;
  const plan = memoryPlan(width * height, {width, height, inputBytes: data.buffer.byteLength});
  let rebuilt = null, made = null, writerEffort = Math.max(5, firstEffort);
  if (!measureOutput && typeof imageMeasure !== 'function') throw fault('JXL_INTERNAL', 'A measured whole photo needs its picture provider.');
  const measure = measureOutput ? function* (image, want) {
    if (!made) throw fault('JXL_INTERNAL', 'A capture image measure needs its writer.');
    return yield* measureOutput(yield* made.provider.write(image, writerEffort, {pass: true}), want);
  } : (image, want) => (rebuilt ??= imageMeasure(data, width, height, color, signal, plan)).measure(image, want);
  const measureSteps = function* (image, want) {
    while (image?.deferred) image = yield* image.deferred();
    return yield* (rebuilt ??= imageMeasure(data, width, height, color, signal, plan)).measureSteps(image, want);
  };
  const journal = !measureOutput && journaling();
  const defer = make => journal ? function* (q) { yield* made.provider.sourceSteps(q); return {deferred: () => make(q)}; } : make;
  const resolve = function* (image) { while (image?.deferred) image = yield* image.deferred(); return image; };
  const scoreFile = function* (file, image, want) {
    const scores = yield* stage('whole-score', function* () {
      const value = measureOutput ? yield* measureOutput(file, want)
        : journal ? measureSteps(image, want) : measure(image, want);
      return typeof value?.next === 'function' ? yield* value : value;
    });
    check(signal);
    announce?.(file, scores.ssimulacra2);
    return scores;
  };
  let bytes = null, selectedScore = null, release = null, admittedFloor = null, failed = false;
  const announce = preview && ((file, score) => preview(file, {width, height, measurements: Number.isFinite(score)
    ? wholePhotoMeasurements(score, admittedFloor ?? wholePhotoFloor(score, readingWebp,
      wholePhotoTarget(score, readingWebp, !!measureOutput, smallPicture(width, height))), measureOutput ? 'decoded-output' : 'encoder-reconstruction') : []}));
  const keepBytes = (candidate, score) => {
    if (candidate && wholePhotoSmaller(bytes ? bytes.length : null, candidate.length)) { bytes = candidate; selectedScore = score; }
  };
  try {
    const lowFiles = new WeakMap();
    const lowRun = function* (q) {
      let image;
      const file = yield* low({quality: q, effort: FLOOR_EFFORT, observe: selected => { image = selected; }});
      if (!image) throw new Error('The low photo writer did not expose its selected image.');
      lowFiles.set(image, shown(file, image));
      return image;
    };
    const lowAt = journal ? function* (q) { return {lowQuality: q}; } : lowRun;
    const scoredLow = function* (image, want) {
      if (!journal) { const file = lowFiles.get(image); return {file, scores: yield* scoreFile(file, image, want)}; }
      return yield* stage('low-probe', function* () {
        const made = yield* lowRun(image.lowQuality), file = lowFiles.get(made);
        return {file, scores: yield* scoreFile(file, made, want)};
      });
    };
    if (!(typeof __RAPIER_JXL_CAPTURE_PHOTO__ !== 'undefined' && __RAPIER_JXL_CAPTURE_PHOTO__ === true) && fit) return yield* fitSteps();
    const requested = {ssimulacra2: leanOnly ? wholePhotoTarget(0, readingWebp, false) : 0};
    const admit = function* () {
      if (typeof selectedScore === 'function') selectedScore = yield* selectedScore();
      if (bytes) photoAdmission?.record(bytes, true, wholePhotoMeasurements(selectedScore, admittedFloor, measureOutput ? 'decoded-output' : undefined));
    };
    let closest = null;
    const settle = function* () {
      if (!bytes && closest) keepBytes(closest.bytes, closest.score);
      if (!bytes && retainFloor) { const exact = yield* retainFloor(null); if (exact) keepBytes(exact, null); }
    };
    if (leanOnly) admittedFloor = requested.ssimulacra2;
    else {
    const floorSteps = function* () {
    let floorImage = yield* lowAt(quality);
    const bounded = readingWebp !== undefined && !measureOutput;
    let {file: floorFile, scores: floorScores} = yield* scoredLow(floorImage, bounded ? {...WANT_S2, doubt: true} : WANT_S2);
    requested.ssimulacra2 = wholePhotoTarget(floorScores.ssimulacra2, readingWebp, !!measureOutput, smallPicture(width, height));
    const floorDoubt = floorScores.doubt?.ssimulacra2 ?? 0, floorGap = floorScores.ssimulacra2 - requested.ssimulacra2;
    if (floorDoubt && (floorGap <= floorDoubt || Math.abs(floorGap - DOWN_FROM) <= floorDoubt))
      floorScores = journal ? (yield* scoredLow(floorImage, WANT_S2)).scores : yield* scoreFile(floorFile, floorImage, WANT_S2);
    admittedFloor = wholePhotoFloor(floorScores.ssimulacra2, readingWebp, requested.ssimulacra2);
    if (readingWebp === undefined || floorScores.ssimulacra2 >= requested.ssimulacra2)
      keepBytes(floorFile, floorScores.doubt ? function* () { return (yield* scoreFile(floorFile, yield* lowAt(quality), WANT_S2)).ssimulacra2; } : floorScores.ssimulacra2);
    const needCorrection = readingWebp !== undefined && !bytes;
    closest = needCorrection ? {bytes: floorFile, score: floorScores.ssimulacra2} : null;
    const over = readingWebp !== undefined && bytes && floorScores.ssimulacra2 - requested.ssimulacra2 >= DOWN_FROM;
    if (needCorrection || over) {
      const checkedLow = function* (image, want) {
        const t = requested.ssimulacra2;
        let {file, scores} = yield* scoredLow(image, want.exact || measureOutput ? want : {...want, doubt: true});
        const d = scores.doubt?.ssimulacra2 ?? 0;
        if (d && (Math.abs(scores.ssimulacra2 - t) <= d || closest && scores.ssimulacra2 < t && scores.ssimulacra2 + d >= closest.score))
          scores = yield* scoreFile(file, image, {...want, exact: true, doubt: false});
        if (scores.ssimulacra2 >= t) keepBytes(file, scores.doubt ? function* () { return (yield* scoreFile(file, image, WANT_S2)).ssimulacra2; } : scores.ssimulacra2);
        else if (closest && scores.ssimulacra2 > closest.score) closest = {bytes: file, score: scores.ssimulacra2};
        return {scores, output: {bytes: file, effort: FLOOR_EFFORT}};
      };
      yield* measured(qualitySteps(lowAt, requested, {start: quality, low: over ? 1 : quality, high: 99.99,
        lastAim: over && effort === 4 ? DOWN_LAST_AIM : undefined, probes: over ? DOWN_PROBES[Math.min(effort, 6) - 4] : 2,
        initial: {quality, image: floorImage, scores: floorScores, output: {bytes: floorFile, effort: FLOOR_EFFORT}},
        measureSteps: checkedLow}), journal ? measureSteps : measure, signal);
    }
    floorImage = null;
    };
    if (journal) {
      const floor = yield* stage('whole-floor', function* () {
        yield* floorSteps();
        return {target: requested.ssimulacra2, admittedFloor, bytes, selectedScore, closest};
      });
      ({admittedFloor, bytes, selectedScore, closest} = floor);
      requested.ssimulacra2 = floor.target;
    } else yield* floorSteps();
    if (effort === 4) { yield* settle(); yield* admit(); return bytes; }
    }

    const prepared = prepareV6(data, width, height, color, {}, {banded: true, upload});
    made = wholeProvider(prepared, signal, !measureOutput && !color?.transform && (color?.space ?? 'srgb') === 'srgb'); const provider = made.provider; release = made.release;
    const blockOptions = ids => ({...search.options(data, width, height, v6Options(prepared, quality).deadzone), ...(ids && {ids})});
    const qualify = function* (image, want) {
      if (!measureOutput) return {scores: yield* scoreFile(null, image, want), output: {effort: writerEffort}};
      const file = shown(yield* provider.write(image, writerEffort, {pass: true}), image);
      const scores = yield* scoreFile(file, image, want);
      return {scores, output: {bytes: file, effort: writerEffort}};
    };
    const scoreOnly = measureOutput ? qualify : function* (image, want) { return {scores: yield* scoreFile(null, image, want.exact ? want : {...want, doubt: true})}; };
    let written = null;
    const sameWriteEffort = (a, b) => a === b || (!measureOutput && a <= 6 && b <= 6);
    const memoAt = (fn, q0 = NaN, img0 = null) => {
      const held = new Map();
      if (img0) held.set(q0, img0);
      const at = function* (q) {
        const hit = held.get(q);
        if (hit) { held.delete(q); held.set(q, hit); return hit; }
        held.clear();
        const img = yield* fn(q);
        held.set(q, img);
        return img;
      };
      at.clear = () => held.clear();
      return at;
    };
    const first = measureOutput ? WANT_S2 : {...WANT_S2, doubt: true};
    const exactAt = (at, q) => function* () { return (yield* scoreFile(null, yield* at(q), WANT_S2)).ssimulacra2; };
    const writtenNow = function* (imageAt, found, effort) {
      if (!(found.scores.ssimulacra2 >= requested.ssimulacra2) || found.output?.bytes && sameWriteEffort(found.output.effort, effort)) return found;
      const bytes = yield* stage('whole-keep', function* () {
        const image = yield* resolve(yield* imageAt(found.quality));
        return shown(yield* provider.write(image, effort, {pass: true}), image);
      });
      return {...found, output: {bytes, effort, unannounced: true}};
    };
    const keep = function* (imageAt, found, effort) {
      if (!(found.scores.ssimulacra2 >= requested.ssimulacra2)) return found;
      if (found.output?.unannounced) {
        const {unannounced: _u, ...output} = found.output;
        found = {...found, output};
        written = {imageAt, quality: found.quality, effort: output.effort, bytes: output.bytes};
        announce?.(output.bytes, found.scores.ssimulacra2);
      }
      if (!found.output?.bytes || !sameWriteEffort(found.output.effort, effort)) {
        const same = written?.imageAt === imageAt && written.quality === found.quality && sameWriteEffort(written.effort, effort);
        let bytes = same ? written.bytes : null;
        if (!bytes) bytes = yield* stage('whole-keep', function* () {
          const image = yield* resolve(yield* imageAt(found.quality));
          return shown(yield* provider.write(image, effort, {pass: true}), image);
        });
        written = {imageAt, quality: found.quality, effort, bytes};
        found = {...found, output: {bytes, effort}};
        announce?.(found.output.bytes, found.scores.ssimulacra2);
      }
      if (found.scores.ssimulacra2 >= requested.ssimulacra2)
        keepBytes(found.output.bytes, found.scores.doubt ? exactAt(imageAt, found.quality) : found.scores.ssimulacra2);
      return found;
    };
    function* fitSteps() {
      const families = [() => [lowRun, image => lowFiles.get(image)]];
      if (effort > 4) {
        let provider;
        const write = function* (image) { return shown(yield* provider.write(image, writerEffort, {pass: true}), image); };
        families.push(() => {
          const prepared = prepareV6(data, width, height, color, {}, {banded: true, upload});
          made = wholeProvider(prepared, signal); release = made.release; provider = made.provider;
          writerEffort = effort;
          return [q => provider.image(q, {filter: 'gaborish'}), write];
        });
        for (const [level, ids] of [[6, [4]], [7, undefined]]) if (effort >= level) families.push(function* (at) {
          const options = {...search.options(data, width, height, v6Options(made.prepared, quality).deadzone), ...(ids && {ids})};
          const layout = yield* stage('fit-layout', function* () { return (yield* search.blocks(provider.base(at, {keepPlanes: true}), width, height, options, signal)).layout; });
          return [q => planeLayoutSteps(provider.base(q, {keepPlanes: true}), width, height, layout, options, signal), write];
        });
      }
      const rates = [];
      let held = null;
      const searchOf = function* (at, write) {
        const before = rates.splice(0), candidates = before.length ? follow(fit.maxBytes, before, ...CODER) : fit.candidates({data, width, height}, CODER);
        let next = candidates.next(), kept = null, smallest = null;
        try {
          while (!next.done) {
            check(signal);
            const q = next.value;
            held = null;
            const file = yield* stage('fit-probe', function* () {
              const image = yield* at(q), made = write(image), file = made instanceof Uint8Array ? made : yield* made;
              held = {file, image};
              return file;
            });
            if (file.length <= fit.maxBytes && !(kept?.quality >= q)) kept = {quality: q, file};
            if (!(smallest?.file.length <= file.length)) smallest = {quality: q, file};
            rates.push({quality: q, bytes: file.length});
            next = candidates.next({bytes: file});
          }
        } finally { candidates.return(); }
        return {kept, smallest};
      };
      const look = q => wholePhotoTarget(0, q / 100, !!measureOutput, smallPicture(width, height)), {minQuality, maxQuality} = fit;
      const cap = readingWebp === undefined ? Infinity : look(maxQuality);
      let chosen = null, scores = null, last = quality, capped = false;
      for (let k = 0; k < families.length; k++) {
        const made = families[k](last), [at, write] = Array.isArray(made) ? made : yield* made;
        if (capped && k < families.length - 1) continue;
        if (capped) { yield* toCap(at, write); break; }
        const {kept, smallest} = yield* searchOf(at, write), found = kept ?? smallest;
        const score = yield* stage('fit-score', function* () {
          const image = held?.file === found.file ? held.image : yield* at(found.quality);
          held = null;
          return yield* scoreFile(found.file, image, WANT_S2);
        });
        const fits = found.file.length <= fit.maxBytes;
        last = found.quality;
        if (!chosen || (fits && !chosen.fits) || (fits === chosen.fits && (fits ? score.ssimulacra2 > scores.ssimulacra2 : found.file.length < chosen.file.length)))
          chosen = {...found, fits}, scores = score;
        if (chosen.fits && scores.ssimulacra2 >= cap) {
          capped = true;
          if (k === families.length - 1) yield* toCap(at, write);
        }
      }
      function* toCap(at, write) {
        const tried = [{quality: chosen.quality, score: scores.ssimulacra2}];
        let q = Math.max(CODER[0], chosen.quality - (scores.ssimulacra2 - cap - CAP_OVER));
        for (let n = 0; n < CAP_PROBES; n++) {
          const probe = yield* stage('fit-cap', function* () {
            const image = yield* at(q), made = write(image), file = made instanceof Uint8Array ? made : yield* made;
            return {file, scores: yield* scoreFile(file, image, WANT_S2)};
          });
          tried.push({quality: q, score: probe.scores.ssimulacra2});
          if (probe.scores.ssimulacra2 >= cap && probe.file.length < chosen.file.length)
            chosen = {...chosen, quality: q, file: probe.file}, scores = probe.scores;
          if (scores.ssimulacra2 - cap < CAP_OVER * 2) break;
          const [a, b] = tried.slice(-2);
          const next = a.score === b.score ? q - 1 : b.quality + (cap + CAP_OVER - b.score) * (b.quality - a.quality) / (b.score - a.score);
          if (!(Math.abs(next - q) > 0.01)) break;
          q = Math.max(next, CODER[0]);
        }
      }
      let reported = chosen.quality;
      if (readingWebp !== undefined && chosen.fits) {
        if (capped) reported = maxQuality;
        else if (scores.ssimulacra2 < look(minQuality)) chosen = {...chosen, fits: false};
        else {
          let low = minQuality, high = maxQuality;
          for (let i = 0; i < 40; i++) { const mid = (low + high) / 2; if (look(mid) <= scores.ssimulacra2) low = mid; else high = mid; }
          reported = low;
        }
      }
      photoAdmission?.record(chosen.file, true, wholePhotoMeasurements(scores.ssimulacra2, undefined, measureOutput ? 'decoded-output' : undefined));
      fit.found?.({quality: reported, fits: chosen.fits});
      return chosen.file;
    }
    const taken = box => { const value = box.v; box.v = null; return value; };
    const probe = (imageAt, start, probes, initial = null, seen = null) => measured(qualitySteps(imageAt,
      requested, {start, low: 1, high: 99.9, probes, initial, measureSteps: scoreOnly, seen}), journal ? measureSteps : measure, signal);
    const imageAt = memoAt(defer(q => provider.image(q, {filter: 'gaborish'})));
    let probed = new Map();
    const seen = {get: q => { const o = probed?.get(q); return o && {scores: o.scores, ...(o.output && sameWriteEffort(o.output.effort, writerEffort) && {output: o.output})}; },
      set: (q, o) => probed?.set(q, o)};
    const shapes = function* (q, options) {
      const base = yield* provider.baseSteps(q, {keepPlanes: true});
      const searched = journal ? {layout: unpackLayout(yield* stage('whole-shapes', function* () {
        return packLayout(search.blocks === planeSearchSteps ? yield* planeSearchLayoutSteps(base, width, height, options, signal)
          : (yield* search.blocks(base, width, height, options, signal)).layout);
      }))} : yield* search.blocks(base, width, height, options, signal);
      const layout = searched.layout, at = memoAt(defer(function* (p) {
        const base = yield* provider.baseSteps(p, {keepPlanes: true});
        return journal ? provider.lazy(base, layout, options) : yield* planeLayoutSteps(base, width, height, layout, options, signal);
      }), q, searched.image);
      return {at, image: journal ? yield* at(q) : searched.image};
    };
    if (lean) {
      writerEffort = leanWrite;
      yield 0.05;
      const plain = yield* writtenNow(imageAt, yield* probe(imageAt, leanStart(quality), LEAN_PROBES, null, leanOnly ? null : seen), leanWrite);
      yield 0.3;
      imageAt.clear();
      let searched = yield* shapes(plain.quality, blockOptions());
      const shapedAt = searched.at;
      const initial = {v: {quality: plain.quality, image: searched.image, ...yield* qualify(searched.image, first)}};
      searched = null;
      yield 0.5;
      yield* keep(shapedAt, yield* probe(shapedAt, plain.quality, LEAN_PROBES, taken(initial)), leanWrite);
      shapedAt.clear();
      yield 0.8;
      yield* keep(imageAt, plain, leanWrite);
      check(signal);
      if (leanOnly) {
        yield* settle();
        yield* admit();
        return bytes;
      }
    }
    let coarse = yield* probe(imageAt, quality, 6, null, seen);
    let fine = null, block = null, blockAt = null, block16 = null, block16At = null;
    for (let rung = Math.max(5, firstEffort); rung <= effort; rung++) {
      writerEffort = rung;
      coarse = yield* keep(imageAt, coarse, rung);
      let best = coarse;
      if (rung >= 6) {
        fine ??= yield* probe(imageAt, quality, 12, null, seen);
        probed = null;
        fine = yield* keep(imageAt, fine, rung);
        if (rung === effort) imageAt.clear();
        best = fine;
        if (!block16) {
          imageAt.clear();
          let searched = yield* shapes(best.quality, blockOptions([4]));
          block16At = searched.at;
          const initial = {v: {quality: best.quality, image: searched.image, ...yield* qualify(searched.image, first)}};
          searched = null;
          block16 = yield* probe(block16At, best.quality, 6, taken(initial));
        }
        block16 = yield* keep(block16At, block16, rung);
        if (rung === effort) block16At.clear();
      }
      yield 0.3;
      if (rung >= 7) {
        if (!block) {
          imageAt.clear(); block16At?.clear();
          let searched = yield* shapes(best.quality, blockOptions());
          blockAt = searched.at;
          const initial = {v: {quality: best.quality, image: searched.image, ...yield* qualify(searched.image, first)}};
          searched = null;
          block = yield* probe(blockAt, best.quality, 12, taken(initial));
        }
        block = yield* keep(blockAt, block, rung);
        if (rung === effort) blockAt.clear();
        yield 0.6;
      }
      if (rung >= 8) {
        const found = yield* measured(search.score(provider, requested, {candidates: ['field'], effort: rung,
          start: best.quality, aq: search.aq, exactSize: true, measureSteps: qualify}), journal ? measureSteps : measure, signal);
        if (found?.pass) keepBytes(found.bytes, found.ssimulacra2);
      }
      if (rung >= 9) {
        const found = yield* measured(search.score(provider, requested, {candidates: search.candidates, effort: rung,
          start: best.quality, aq: search.aq, exactSize: true, measureSteps: qualify}), journal ? measureSteps : measure, signal);
        if (found?.pass) keepBytes(found.bytes, found.ssimulacra2);
      }
    }
    check(signal);
    yield* settle();
    yield* admit();
    return bytes;
  } catch (error) { failed = true; throw error; }
  finally {
    let cleanupFailed = false, cleanupError;
    try { release?.(); } catch (error) { cleanupFailed = true; cleanupError = error; }
    try { rebuilt?.destroy(); } catch (error) { if (!cleanupFailed) { cleanupFailed = true; cleanupError = error; } }
    if (!failed && cleanupFailed) throw cleanupError;
  }
}
