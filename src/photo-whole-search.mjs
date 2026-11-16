import {TRANSFORMS} from './vardct-strategies.mjs';
// SPDX-License-Identifier: MIT
import {retainsWhole, RETAINED_BYTES} from './memory-device.mjs';
import {shown} from './photo-shown.mjs';
import {complete} from './bits.mjs';
import {quantFieldValue} from './vardct-planes.mjs';
import {prepareV6, blockSearchOptions, V6, GABORISH, gaborishRows, v6Options} from './photo-v6.mjs';
import {v6For, smallPicture} from './photo-v6-settings.mjs';
import {journalFact, JOIN, unit, stage, journaling} from './step-journal.mjs';
import {smoothPhoto} from './v7/low-photo.mjs';
import {stillPhotoProvider} from './photo-v6-provider.mjs';
import {photoXYBSteps, XYB_TABLES} from './photo-xyb.mjs';
import {transformDCT8, dct8Basis} from './photo-dct.mjs';
import {lowWholePhoto} from './photo-low.mjs';
import {qualitySteps} from './photo-quality-search.mjs';
import {plainLayout, planeLayoutSteps, planeLevelsSteps} from './photo-plane-levels.mjs';
import {planeSearchSteps, planeSearchLayoutSteps} from './photo-plane-search.mjs';
import {planeMeasuredSteps} from './photo-plane-measured.mjs';
import {scoreSteps, AQ, CANDIDATES} from './photo-search.mjs';
import {maskEnergy, maskWeights} from './photo-mask.mjs';
import {memoryPlan, s2Admitted} from './memory-plan.mjs';
import {materialize, fixedStrategyImage} from './varblock-core.mjs';
import {wholePhotoTarget, wholePhotoFloor, wholePhotoSmaller, wholePhotoMeasurements} from './photo-whole-policy.mjs';
import {admitSize} from './admit.mjs';
import {s2Dimensions, s2RGBA} from './ssimulacra2-input.mjs';
import {EDGE} from './limits.mjs';
import {fault} from './fault.mjs';
import {trialDue, tryStage, leftDevice} from './device-trial.mjs';
import {offloading} from './offload.mjs';
import {layoutPicture, scoreBandPicture, packLayout, unpackLayout} from './photo-layout-picture.mjs';
import {bandScratch} from './band-scratch.mjs';
import {MEASURED_EFFORT, measuredLevel} from './effort-level.mjs';
import {hostGPU} from './gpu-gate.mjs';
import {timedSteps} from './stage-trace.mjs';

const CAPTURE_PHOTO = (typeof __RAPIER_JXL_CAPTURE_PHOTO__ !== 'undefined' && __RAPIER_JXL_CAPTURE_PHOTO__ === true);
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

function wholeProvider(prepared, signal, device = false, banded = false) {
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
    if (quantFields) for (let i = 0; i < quantFields.length; i++) quantFields[i] = quantFieldValue(64 * fieldScale[i]);
    const out = {...base, components, epf: quantFields ? probe.epf * 2 : probe.epf, rowsRecipe: source.rowsRecipe,
      ...(quantFields ? {quantFields, quantFieldBase: 64} : {quantFields: undefined, quantFieldBase: undefined})};
    return Object.defineProperty(out, 'planeBound', {get: source.getBound, enumerable: false, configurable: true});
  };
  const journal = journaling();
  let onDevice = false;
  const makeSource = (key, image, filter, quality) => {
    {
      const stride = image.components[0].stride, rows = image.components[0].rows, W = stride * 8, H = rows * 8;
      const planes = image.planes ?? (filter === 'gaborish' ? prepared.pres?.get(coreAt(quality).gaborish) ?? null : null);
      const rowsOf = planes ? () => ({planes, top: 0, stride: W})
        : image.planeRows ?? (filter === 'plain' ? plainRows(rgba, width, height, color) : gaborishRows(rgba, width, height, coreAt(quality), true));
      const core = filter === 'gaborish' && (!planes || prepared.retain) ? coreAt(quality) : null;
      const rowsRecipe = core && {gaborish: core.gaborish, ...(core.transform && {transform: core.transform})};
      const planeRows = (from, to, x0, x1) => ({stride: W, ...rowsOf(from, to, x0, x1)});
      const devicePlanes = {};
      let bound = null;
      const getBound = () => {
        if (bound === null) {
          bound = 0;
          const needMask = filter === 'gaborish' && !devicePlanes.maskWeight, hf = needMask ? new Float64Array(stride * rows) : null;
          const staged = device && hostGPU() ? new Map() : null;
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
                  throw fault('JXL_INTERNAL', 'A photo plane cannot be represented by finite double-single samples.');
                const err = Math.abs(value - (hi + lo));
                if (err > worst) worst = err;
                pairs[i * 2] = hi; pairs[i * 2 + 1] = lo;
              }
              const b32 = new Float32Array([worst]);
              if (b32[0] < worst) new Uint32Array(b32.buffer)[0]++;
              if (!Number.isFinite(b32[0])) throw fault('JXL_INTERNAL', 'A photo plane split error has no finite f32 bound.');
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
        'planeBound', {get: getBound, enumerable: false, configurable: true});
      const setBound = (saved, mask) => { bound = saved; if (mask) devicePlanes.maskWeight = mask; };
      const source = {planeRows, getBound, setBound, devicePlanes, base, rowsRecipe}; sources.set(key, source);
      return source;
    }
  };
  const canonical = (image, filter, quality) => {
    const key = keyOf(filter, quality);
    const source = sources.get(key) ?? makeSource(key, image, filter, quality);
    return Object.defineProperty({...image, ...(source.base.planes && {planes: source.base.planes}), planeRows: source.planeRows, devicePlanes: source.devicePlanes, rowsRecipe: source.rowsRecipe},
      'planeBound', {get: source.getBound, enumerable: false, configurable: true});
  };
  const sourceSteps = function* (quality) {
    const key = keyOf('gaborish', quality);
    if (sources.has(key)) return;
    const record = yield* unit('whole-source', () => {
      const {planeRows: _r, planes: _p, ...image} = still.base(quality, {keepPlanes: true, noLevels: true});
      return Object.fromEntries(Object.entries({...image, components: image.components.map(c => ({...c, coeffs: EMPTY_I16}))}).filter(([, v]) => v !== undefined));
    });
    const held = prepared.retain ? prepared.pres?.get(coreAt(quality).gaborish) : null;
    if (!sources.has(key)) makeSource(key, {...record, ...(held ? {planes: held} : {planeRows: gaborishRows(rgba, width, height, coreAt(quality))})}, 'gaborish', quality);
    const source = sources.get(key);
    const saved = yield* unit('whole-bound', () => ({bound: source.getBound(), mask: source.devicePlanes.maskWeight ?? null}));
    source.setBound(saved.bound, saved.mask);
  };
  const provider = {...still,
    onDevice: () => onDevice,
    blockOptions(base) { return {...still.blockOptions(base), model: 'simple'}; },
    base(quality, options = {}) {
      check(signal);
      const filter = options.filter ?? 'gaborish';
      if (options.keepPlanes && sources.has(keyOf(filter, quality))) return retarget(sources.get(keyOf(filter, quality)), quality, options);
      const image = still.base(quality, {...options, ...(filter === 'plain' ? {keepPlanes: false} : options.keepPlanes && {noLevels: true})});
      return options.keepPlanes ? canonical(image, filter, quality) : image;
    },
    *baseSteps(quality, options = {}) {
      const filter = options.filter ?? 'gaborish';
      if (journal && options.keepPlanes && filter === 'gaborish' && (prepared.retain || !prepared.pres?.get(coreAt(quality).gaborish))) {
        yield* sourceSteps(quality);
        check(signal);
        return retarget(sources.get(keyOf(filter, quality)), quality, options);
      }
      if (options.keepPlanes && sources.has(keyOf(filter, quality))) {
        check(signal);
        return retarget(sources.get(keyOf(filter, quality)), quality, options);
      }
      const n = width * height;
      if (device && filter === 'gaborish' && options.fieldScale === undefined && !leftDevice('core', n)) {
        check(signal);
        const request = {data: rgba, width, height, quality, options: {...coreAt(quality), ...(options.keepPlanes && {noLevels: true})}, lib, audit: made => made?.gpuAudit?.blocks > 0 ? made.gpuAudit.worst : Infinity};
        if (trialDue('core', n)) {
          const self = this;
          return yield* tryStage('core', n, {gpu: request}, function* () { return self.base(quality, options); });
        }
        const image = yield {gpu: request};
        check(signal);
        if (image && request.audit(image) <= 1) {
          onDevice = true;
          if (!options.keepPlanes) return image;
          if (!sources.has(keyOf('gaborish', quality)) && !prepared.pres?.get(coreAt(quality).gaborish)) image.planeRows = gaborishRows(rgba, width, height, coreAt(quality), true);
          return canonical(image, 'gaborish', quality);
        }
      }
      return this.base(quality, options);
    },
    *image(quality, options = {}) {
      if (journal) {
        if ((options.filter ?? 'gaborish') === 'gaborish' && (prepared.retain || !prepared.pres?.get(coreAt(quality).gaborish))) yield* sourceSteps(quality);
        const self = this;
        return {deferred: function* () { const base = yield* self.baseSteps(quality, {...options, keepPlanes: true}); return self.lazy(base, plainLayout(base), self.blockOptions(base)); }};
      }
      const base = yield* this.baseSteps(quality, {...options, keepPlanes: true});
      if ((banded || offloading('score-band')) && base.rowsRecipe) return yield* this.lazyLook(base, plainLayout(base), this.blockOptions(base));
      return yield* planeLayoutSteps(base, width, height, plainLayout(base), this.blockOptions(base), signal);
    },
    *write(image, effort, options) {
      while (image?.deferred) image = yield* image.deferred();
      return yield* still.write(image, effort, options);
    },
    sourceSteps,
    lazy(base, layout, options, keep = true) {
      if (!CAPTURE_PHOTO && base.rowsRecipe && offloading('score-band'))
        return scoreBandPicture(base, width, height, layout, options);
      return layoutPicture(base, width, height, layout, options, keep);
    },
    *lazyLook(base, layout, options) {
      const picture = this.lazy(base, layout, options);
      if (onDevice && !options.deadzoneMap) {
        const exact = yield* planeLevelsSteps(base, width, height, layout, options, signal);
        if (exact) picture.lazyStrategy.hold(exact);
      }
      return picture;
    },
    *layout(base, layout, options) {
      const kept = base.planeRows && base.devicePlanes ? base : canonical(base, 'gaborish', 75);
      return journal ? this.lazy(kept, layout, options) : yield* planeLayoutSteps(kept, width, height, layout, options, signal);
    },
  };
  return {provider, prepared, release: () => { for (const source of sources.values()) source.devicePlanes.release?.(); sources.clear(); }};
}

const SHARED_SEARCH = {blocks: planeSearchSteps, options: blockSearchOptions, measured: planeMeasuredSteps,
  score: scoreSteps, aq: AQ, candidates: CANDIDATES};
const WANT_S2 = {ssimulacra2: true, butteraugli: false};
export const LIBJXL_BOUND = 1.0, SEARCH_BOUND = 0.9;
const DESCENT = 2, DESCENT_MAX = 8, RAISES = 6, SCORE_SLOPE = 0.8;
const LIBJXL_WANT = {ssimulacra2: true, butteraugli: false, exact: true, arithmetic: 'libjxl'};
const recipeOf = found => {
  const {candidate, decisions: d, quality} = found;
  if (candidate === 'gaborish') return {quality};
  if (candidate === 'field') return {quality, field: d.field};
  if (candidate === 'blocks' || candidate === 'closed') return {quality, field: d.field, layout: d.layout, transforms: d.transforms};
  return null;
};
const PROBE_WRITE = 5;
const DOWN_FROM = 1, DOWN_PROBES = [4, 4, 6], DOWN_LAST_AIM = 0.35, FLOOR_EFFORT = MEASURED_EFFORT - 1;
const LEAN_EFFORT = 7, LEAN_PROBES = 6;
const leanStart = quality => Math.max(1, quality - (quality < 85 ? 7 : 4));

const EXACT_BITS = 6;
function* reported(steps, from, to) {
  let step, reply, n = 0;
  try {
    while (!(step = steps.next(reply)).done) {
      reply = yield step.value;
      if (typeof step.value !== 'number' && ++n % 4 === 0) yield from + (to - from) * n / (n + 16);
    }
    return step.value;
  } finally { if (!step?.done) steps.return?.(); }
}
function* floorPart(steps) {
  let step, reply;
  try {
    while (!(step = steps.next(reply)).done) reply = typeof step.value === 'number' && step.value !== 0 ? (yield 0.1 * step.value, undefined) : yield step.value;
    return step.value;
  } finally { if (!step?.done) steps.return?.(); }
}
function* spanned(steps, from, to) {
  let step, reply;
  try {
    while (!(step = steps.next(reply)).done) reply = typeof step.value === 'number' ? (yield from + (to - from) * step.value, undefined) : yield step.value;
    return step.value;
  } finally { if (!step?.done) steps.return?.(); }
}
function* effortNineSteps(data, width, height, options) {
  const exact = new Set(), facts = new Map(), sink = {record(bytes, passed, measurements) { facts.set(bytes, {passed, measurements}); }};
  const retainFloor = options.retainFloor && function* (bytes, level) { const file = yield* options.retainFloor(bytes, level); if (file) exact.add(file); return file; };
  const eight = yield* spanned(wholeSteps(data, width, height, {...options, effort: 8, retainFloor, photoAdmission: sink}), 0, 0.2);
  const nine = yield* spanned(wholeSteps(data, width, height, {...options, retainFloor, photoAdmission: sink}), 0.2, 1);
  const kept = eight && facts.has(eight) && !exact.has(eight) && (!nine || eight.length < nine.length) ? eight : nine;
  const record = kept && facts.get(kept);
  if (record) options.photoAdmission?.record(kept, record.passed, record.measurements);
  return kept;
}
export function* wholePhotoSteps(data, width, height, options) {
  const nine = options.effort === 9 && options.firstEffort < 9 && options.quality < 100 && options.readingIntent !== undefined && !options.measureOutput && !options.fit && !smallPicture(width, height);
  const steps = timedSteps('whole-photo', nine ? effortNineSteps(data, width, height, options) : wholeSteps(data, width, height, options)), signal = options.signal;
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

function* wholeSteps(data, width, height, {quality, colorSpace = 'srgb', effort, readingIntent, signal,
  firstEffort = effort, retainFloor = null, photoAdmission = null, photoSearch = null, maxPixels, measureOutput = null, imageMeasure = null, fit = null, preview = null,
  deadzones = null, alpha = false}) {
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
  const {color, steps: low} = lowWholePhoto(data, width, height, {colorSpace, signal, smooth, v6: !measureOutput});
  if (effort < MEASURED_EFFORT) return yield* low({quality, effort});
  const lean = effort >= LEAN_EFFORT && readingIntent !== undefined && !measureOutput && !fit && !smallPicture(width, height), leanWrite = effort, leanOnly = lean && effort === LEAN_EFFORT;
  const noFloor = lean && effort <= 8;
  const asked = effort;
  const leanPart = lean && asked >= 8 ? (asked === 9 ? 0.25 : 0.45) : 1;
  firstEffort = firstEffort >= effort ? measuredLevel(effort) : Math.min(firstEffort, 5);
  effort = measuredLevel(effort);
  const upload = !measureOutput && !color?.transform && (color?.space ?? 'srgb') === 'srgb' && !smallPicture(width, height);
  const search = photoSearch ?? SHARED_SEARCH, measured = search.measured;
  const plan = memoryPlan(width * height, {width, height, inputBytes: data.buffer.byteLength});
  const banded = !CAPTURE_PHOTO && !measureOutput && plan.banded && !(!plan.known && !journaling() && !offloading('score-band') && retainsWhole(width * height, RETAINED_BYTES));
  let rebuilt = null, made = null, writerEffort = Math.max(5, firstEffort);
  if (!measureOutput && typeof imageMeasure !== 'function') throw fault('JXL_INTERNAL', 'A measured whole photo needs its picture provider.');
  const measure = measureOutput ? function* (image, want) {
    if (!made) throw fault('JXL_INTERNAL', 'A capture image measure needs its writer.');
    return yield* measureOutput(yield* made.provider.write(image, writerEffort, {pass: true}), want);
  } : (image, want) => provided().measure(image, want);
  const measureSteps = function* (image, want) {
    while (image?.deferred) image = yield* image.deferred();
    return yield* provided().measureSteps(image, want);
  };
  let settles = false;
  const provided = () => {
    if (!rebuilt) { rebuilt = imageMeasure(data, width, height, color, signal, plan); if (settles) rebuilt.later?.(); }
    return rebuilt;
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
    if ((want?.arithmetic ?? 'binary64') === 'binary64') announce?.(file, scores.ssimulacra2);
    return scores;
  };
  let bytes = null, selectedScore = null, release = null, admittedFloor = null, failed = false, zoned = false;
  const announce = preview && ((file, score) => preview(file, {width, height, measurements: Number.isFinite(score)
    ? wholePhotoMeasurements(score, admittedFloor ?? wholePhotoFloor(score, readingIntent,
      wholePhotoTarget(score, readingIntent, !!measureOutput, smallPicture(width, height))), measureOutput ? 'decoded-output' : 'encoder-reconstruction') : []}));
  const kept = [];
  let keptRecipe = null;
  const keepBytes = (candidate, score, recipe = null, more = null) => {
    if (candidate && more) kept.push({bytes: candidate, score, ...more});
    if (candidate && wholePhotoSmaller(bytes ? bytes.length : null, candidate.length)) { bytes = candidate; selectedScore = score; if (!CAPTURE_PHOTO) keptRecipe = recipe; }
  };
  try {
    const lowFiles = new WeakMap();
    const lowRun = function* (q) {
      let image;
      const file = yield* floorPart(low({quality: q, effort: FLOOR_EFFORT, observe: selected => { image = selected; }}));
      if (!image) throw fault('JXL_INTERNAL', 'The low photo writer did not expose its selected image.');
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
    const lowRedo = function* (q) {
      const image = yield* lowAt(q), {file, scores} = yield* scoredLow(image, {...WANT_S2, exact: true});
      return {bytes: file, score: scores.ssimulacra2, quality: q,
        libjxlScore: scores.ssimulacra2 >= requested.ssimulacra2 ? (yield* scoredLow(image, LIBJXL_WANT)).scores.ssimulacra2 : undefined};
    };
    const lowMore = q => ({quality: q, redo: lowRedo,
      libjxl: function* () { return (yield* scoredLow(yield* lowAt(q), LIBJXL_WANT)).scores.ssimulacra2; }});
    const exactOf = (picture, file = null) => Object.assign(function* () { return (yield* scoreFile(file, yield* picture(), WANT_S2)).ssimulacra2; },
      {begin: function* () { if (!journal && !measureOutput) yield* provided().begin(yield* picture(), WANT_S2); }});
    const lowExact = (file, q, image) => journal ? function* () { return (yield* scoredLow(yield* lowAt(q), WANT_S2)).scores.ssimulacra2; }
      : function* () { return (yield* scoreFile(file, image ?? (yield* lowAt(q)), WANT_S2)).ssimulacra2; };
    if (!(typeof __RAPIER_JXL_CAPTURE_PHOTO__ !== 'undefined' && __RAPIER_JXL_CAPTURE_PHOTO__ === true) && fit) return yield* fitSteps();
    settles = true;
    const requested = {ssimulacra2: noFloor ? wholePhotoTarget(0, readingIntent, false) : 0};
    const admit = function* () {
      rebuilt?.settle?.();
      if (typeof selectedScore === 'function') selectedScore = yield* selectedScore();
      if (bytes) photoAdmission?.record(bytes, true, wholePhotoMeasurements(selectedScore, admittedFloor, measureOutput ? 'decoded-output' : undefined));
    };
    let closest = null;
    const bounded = function* () {
      if (readingIntent === undefined || !kept.length) return;
      const t = requested.ssimulacra2, floor = t - SEARCH_BOUND;
      const chosen = yield* stage('whole-bound', function* () {
        const order = kept.slice().sort((a, b) => a.bytes.length - b.bytes.length);
        const read = function* (c) {
          if (typeof c.score === 'function' && c.score.begin && c.libjxlScore === undefined) {
            yield* c.score.begin();
            const libjxl = yield* c.libjxl();
            c.score = yield* c.score();
            if (c.score >= t) c.libjxlScore = libjxl;
          }
          if (typeof c.score === 'function') c.score = yield* c.score();
          if (c.score >= t && c.libjxlScore === undefined) c.libjxlScore = yield* c.libjxl();
          return c;
        };
        let pick = null, near = null, lifted = false;
        const starts = [];
        for (const c of order) {
          yield* read(c);
          if (!(c.score >= t)) continue;
          if (c.libjxlScore >= floor) { pick = c; break; }
          lifted = true;
          if (c.redo) starts.push(c);
        }
        for (const start of !pick ? starts : asked >= 8 ? starts.slice(0, 1) : []) {
          let at = start, before = null;
          for (let i = 0; i < RAISES && at.quality < 99.9; i++) {
            const rise = before && at.quality > before.quality ? (at.libjxlScore - before.libjxlScore) / (at.quality - before.quality) : 0;
            const slope = rise > 0 ? Math.min(SCORE_SLOPE, Math.max(SCORE_SLOPE / 16, rise)) : SCORE_SLOPE;
            const q = Math.min(99.9, Math.round((at.quality + Math.max(0.1, (floor - at.libjxlScore) / slope)) * 100) / 100);
            const next = {...(yield* at.redo(q, !!pick)), redo: at.redo};
            if (pick && !(next.bytes?.length < pick.bytes.length)) break;
            if (next.score >= t && next.libjxlScore >= floor) { pick = next; lifted = true; break; }
            if (!(next.score >= t)) break;
            before = at; at = next;
          }
          if (!near || at.libjxlScore > near.libjxlScore) near = at;
        }
        let plateau = null;
        if (!pick && near && near.redo && retainFloor && readingIntent > 0.92 && near.quality < 99.8) {
          const next = {...(yield* near.redo(Math.round((near.quality + 99.9) / 2 * 100) / 100, false)), redo: near.redo};
          if (next.score >= t && next.libjxlScore >= floor) { plateau = near.quality; pick = next; lifted = true; }
          else if (next.score >= t && next.libjxlScore > near.libjxlScore) near = next;
        }
        if (!pick) {
          if (near && !near.bytes && near.redo) near = {...(yield* near.redo(near.quality)), redo: near.redo};
          return near ? {bytes: near.bytes, score: near.score, under: true, tool: near.libjxlScore >= t - LIBJXL_BOUND} : null;
        }
        const descend = function* (pick, list, probes, failed, level) {
          for (const c of list) if (c.redo && typeof c.score === 'function' && c.quality < pick.quality) c.score = yield* c.score();
          const below = list.filter(c => c.redo && typeof c.score === 'number' && c.quality < pick.quality && (level < 8 ? !(c.score >= t && c.libjxlScore >= floor) : !(c.score >= t) || c.libjxlScore < floor));
          const known = below.reduce((m, c) => Math.max(m, c.quality), -Infinity);
          const up = below.reduce((m, c) => Math.max(m, c.quality + Math.max(0.1, Math.max(t - c.score, c.libjxlScore === undefined ? 0 : floor - c.libjxlScore) / SCORE_SLOPE)), -Infinity);
          for (let i = 0; pick.redo && i < probes; i++) {
            const room = Math.min(pick.score - t, pick.libjxlScore - floor), step = pick.quality - Math.max(0.1, room / SCORE_SLOPE);
            const first = up < pick.quality - 0.05 ? Math.max(step, up) : step > known ? step : (pick.quality + known) / 2;
            const q = Math.round((failed !== null ? (pick.quality + failed) / 2 : first) * 100) / 100;
            if (q < 1 || q > pick.quality - 0.05) break;
            const next = yield* pick.redo(q, false);
            if (next.score >= t && next.libjxlScore >= floor && next.bytes.length < pick.bytes.length) pick = {...next, redo: pick.redo};
            else failed = q;
          }
          return pick;
        };
        const under = pick.score - t < 0.1 * SCORE_SLOPE;
        const probes = asked >= 9 ? DESCENT_MAX : asked === 8 ? under ? 0 : DESCENT_MAX : asked < 7 && !lifted || asked === 7 && zoned || under ? 0 : DESCENT;
        pick = yield* descend(pick, order, probes, plateau, asked);
        if (asked === 8) {
          const own = order.filter(c => c.lean);
          let start = null;
          for (const c of own) { yield* read(c); if (c.score >= t && c.libjxlScore >= floor) { start = c; break; } }
          if (start && start !== pick) {
            const low = yield* descend(start, own, start.score - t < 0.1 * SCORE_SLOPE ? 0 : DESCENT, null, 7);
            if (low.bytes.length < pick.bytes.length) pick = low;
          }
        }
        return {bytes: pick.bytes, score: pick.score};
      });
      if (!chosen) return;
      if (chosen.under && !chosen.tool && retainFloor && readingIntent > 0.92) { bytes = null; selectedScore = null; closest = null; return; }
      bytes = chosen.bytes; selectedScore = chosen.score;
    };
    const settle = function* () {
      yield* timedSteps('bound', bounded());
      if (!bytes && closest && !(retainFloor && readingIntent > 0.92)) keepBytes(closest.bytes, closest.score);
      if (!bytes && retainFloor) { const exact = yield* retainFloor(null); if (exact) keepBytes(exact, null); }
      else if (bytes && retainFloor && bytes.length * 8 >= EXACT_BITS * width * height) {
        const exact = yield* retainFloor(null, asked);
        if (exact && exact.length < bytes.length) keepBytes(exact, null);
      }
    };
    if (noFloor) admittedFloor = requested.ssimulacra2;
    else {
    const floorSteps = function* () {
    let floorImage = yield* lowAt(quality);
    const bounded = readingIntent !== undefined && !measureOutput;
    let {file: floorFile, scores: floorScores} = yield* scoredLow(floorImage, bounded ? {...WANT_S2, doubt: true} : WANT_S2);
    requested.ssimulacra2 = wholePhotoTarget(floorScores.ssimulacra2, readingIntent, !!measureOutput, smallPicture(width, height));
    const floorDoubt = floorScores.doubt?.ssimulacra2 ?? 0, floorGap = floorScores.ssimulacra2 - requested.ssimulacra2;
    if (floorDoubt && (floorGap <= floorDoubt || Math.abs(floorGap - DOWN_FROM) <= floorDoubt))
      floorScores = journal ? (yield* scoredLow(floorImage, WANT_S2)).scores : yield* scoreFile(floorFile, floorImage, WANT_S2);
    admittedFloor = wholePhotoFloor(floorScores.ssimulacra2, readingIntent, requested.ssimulacra2);
    if (readingIntent === undefined || floorScores.ssimulacra2 >= requested.ssimulacra2)
      keepBytes(floorFile, floorScores.doubt ? lowExact(floorFile, quality) : floorScores.ssimulacra2,
        null, lowMore(quality, floorFile));
    const needCorrection = readingIntent !== undefined && !bytes;
    closest = needCorrection ? {bytes: floorFile, score: floorScores.ssimulacra2} : null;
    const over = readingIntent !== undefined && bytes && floorScores.ssimulacra2 - requested.ssimulacra2 >= DOWN_FROM;
    if (needCorrection || over) {
      const checkedLow = function* (image, want, at = {}) {
        const t = requested.ssimulacra2;
        let {file, scores} = yield* scoredLow(image, want.exact || measureOutput ? want : {...want, doubt: true});
        const d = scores.doubt?.ssimulacra2 ?? 0;
        if (d && (Math.abs(scores.ssimulacra2 - t) <= d || closest && scores.ssimulacra2 < t && scores.ssimulacra2 + d >= closest.score))
          scores = yield* scoreFile(file, image, {...want, exact: true, doubt: false});
        if (scores.ssimulacra2 >= t) keepBytes(file, scores.doubt ? (at.quality === undefined ? exactOf(function* () { return image; }, file) : lowExact(file, at.quality, image)) : scores.ssimulacra2,
          null, at.quality === undefined ? null : lowMore(at.quality, file));
        else if (closest && scores.ssimulacra2 > closest.score) closest = {bytes: file, score: scores.ssimulacra2};
        return {scores, output: {bytes: file, effort: FLOOR_EFFORT}};
      };
      const corrected = yield* measured(qualitySteps(lowAt, requested, {start: quality, low: over ? 1 : quality, high: 99.99,
        lastAim: over && effort === 4 ? DOWN_LAST_AIM : undefined, probes: over ? DOWN_PROBES[Math.min(effort, 6) - 4] : 2,
        settle: over ? DOWN_FROM : Infinity,
        initial: {quality, image: floorImage, scores: floorScores, output: {bytes: floorFile, effort: FLOOR_EFFORT}},
        measureSteps: checkedLow}), journal ? measureSteps : measure, signal);
      if (!over && corrected?.quality > quality && corrected.scores?.ssimulacra2 - requested.ssimulacra2 >= DOWN_FROM)
        yield* measured(qualitySteps(lowAt, requested, {start: corrected.quality, low: quality, high: corrected.quality,
          lastAim: effort === 4 ? DOWN_LAST_AIM : undefined, probes: DOWN_PROBES[Math.min(effort, 6) - 4], settle: DOWN_FROM,
          initial: {quality: corrected.quality, image: null, scores: corrected.scores, output: corrected.output},
          measureSteps: checkedLow}), journal ? measureSteps : measure, signal);
    }
    floorImage = null;
    };
    if (journal) {
      const floor = yield* stage('whole-floor', function* () {
        yield* floorSteps();
        const score = c => typeof c.score === 'number' ? c.score : null;
        return {target: requested.ssimulacra2, admittedFloor, bytes, closest, selected: kept.findIndex(c => c.bytes === bytes),
          selectedScore: typeof selectedScore === 'number' ? selectedScore : null,
          kept: kept.map(c => ({bytes: c.bytes, score: score(c), quality: c.quality, libjxlScore: c.libjxlScore}))};
      });
      ({admittedFloor, bytes, closest} = floor);
      requested.ssimulacra2 = floor.target;
      kept.length = 0;
      for (const c of floor.kept) kept.push({...c, score: c.score ?? lowExact(c.bytes, c.quality), ...lowMore(c.quality)});
      selectedScore = floor.selected >= 0 ? kept[floor.selected].score : floor.selectedScore;
      if (floor.selected >= 0) bytes = kept[floor.selected].bytes;
    } else yield* floorSteps();
    if (effort === 4) { yield* settle(); yield* admit(); return bytes; }
    }

    const prepared = prepareV6(data, width, height, color, {}, {banded: true, upload});
    made = wholeProvider(prepared, signal, !measureOutput && !color?.transform && (color?.space ?? 'srgb') === 'srgb', banded); const provider = made.provider; release = made.release;
    const pubEffort = Math.max(effort, leanWrite);
    const highDz = leanOnly && quality > 85 && readingIntent > 0.85 && readingIntent <= 0.87;
    const blockOptions = ids => ({...search.options(data, width, height, v6Options(prepared, quality).deadzone), ...((lean || effort >= 6) && (quality <= 85 || highDz) && {compactDct8: true, tableBands: 6, dct8Bands: 8, pruneRare: true}), ...(ids && {ids})});
    const qualify = function* (image, want) {
      if (!measureOutput) return {scores: yield* scoreFile(null, image, want), output: {effort: writerEffort}};
      const file = shown(yield* provider.write(image, writerEffort, {pass: true}), image);
      const scores = yield* scoreFile(file, image, want);
      return {scores, output: {bytes: file, effort: writerEffort}};
    };
    const probeQualify = function* (image, want) {
      const file = shown(yield* provider.write(image, PROBE_WRITE, {pass: true}), image);
      return {scores: yield* scoreFile(file, image, want), output: {bytes: file, effort: PROBE_WRITE}};
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
    const exactAt = (at, q) => exactOf(function* () { return yield* at(q); });
    const writeImage = function* (image, effort) { return yield* stage('whole-keep', function* () { const m = yield* resolve(image); return shown(yield* provider.write(m, effort, {pass: true}), m); }); };
    const writtenNow = function* (imageAt, found, effort) {
      if (!(found.scores.ssimulacra2 >= requested.ssimulacra2) || found.output?.bytes && sameWriteEffort(found.output.effort, effort)) return found;
      return {...found, output: {bytes: yield* writeImage(yield* imageAt(found.quality), effort), effort, unannounced: true}};
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
        if (!bytes) bytes = yield* writeImage(yield* imageAt(found.quality), effort);
        written = {imageAt, quality: found.quality, effort, bytes};
        found = {...found, output: {bytes, effort}};
        announce?.(found.output.bytes, found.scores.ssimulacra2);
      }
      if (found.scores.ssimulacra2 >= requested.ssimulacra2)
        keepBytes(found.output.bytes, found.scores.doubt ? exactAt(imageAt, found.quality) : found.scores.ssimulacra2, !CAPTURE_PHOTO && imageAt.recipe && {...imageAt.recipe, quality: found.quality},
          keptMore(imageAt, found.quality, found.output.bytes, effort));
      return found;
    };
    const libjxlOfImage = function* (image, file) { return (yield* scoreFile(file, yield* resolve(image), LIBJXL_WANT)).ssimulacra2; };
    const loopMore = found => found.libjxlScore === undefined ? null : {quality: found.quality, libjxl: function* () { return found.libjxlScore; }};
    const keptMore = (imageAt, quality, file, effort) => {
      const redo = function* (q, needBytes = true) {
        const image = yield* resolve(yield* imageAt(q)), write = () => writeImage(image, effort);
        let bytes = measureOutput ? yield* write() : null;
        const score = (yield* scoreFile(bytes, image, {...WANT_S2, exact: true})).ssimulacra2;
        if (!(score >= requested.ssimulacra2)) return {bytes, score, quality: q};
        const libjxlScore = (yield* scoreFile(bytes, image, LIBJXL_WANT)).ssimulacra2;
        if (needBytes || libjxlScore >= requested.ssimulacra2 - SEARCH_BOUND) bytes ??= yield* write();
        return {bytes, score, libjxlScore, quality: q};
      };
      return {quality, redo, ...(imageAt.lean && {lean: true}), libjxl: function* () { return yield* libjxlOfImage(yield* imageAt(quality), file); }};
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
      const cap = readingIntent === undefined ? Infinity : look(maxQuality);
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
          q = Math.min(CODER[1], Math.max(next, CODER[0]));
        }
      }
      if (retainFloor && readingIntent > 0.92 && !capped && (!chosen.fits || scores.ssimulacra2 < cap)) {
        const whole = yield* retainFloor(null);
        if (whole && whole.length <= fit.maxBytes) {
          photoAdmission?.record(whole, true, []);
          fit.found?.({quality: maxQuality, fits: true});
          return whole;
        }
      }
      let reported = chosen.quality;
      if (readingIntent !== undefined && chosen.fits) {
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
    const probe = (imageAt, start, probes, initial = null, seen = null, extra = null) => measured(qualitySteps(imageAt,
      requested, {start, low: 1, high: 99.9, probes, ...extra, initial, measureSteps: scoreOnly, seen}), journal ? measureSteps : measure, signal);
    const imageAt = memoAt(defer(q => provider.image(q, {filter: 'gaborish'})));
    if (!CAPTURE_PHOTO) imageAt.recipe = {};
    imageAt.lean = lean;
    let probed = new Map();
    const seen = {get: q => { const o = probed?.get(q); return o && {scores: o.scores, ...(o.output && sameWriteEffort(o.output.effort, writerEffort) && {output: o.output})}; },
      set: (q, o) => probed?.set(q, o)};
    const shapes = function* (q, options) {
      const base = yield* provider.baseSteps(q, {keepPlanes: true}), lazy = journal || banded && !!base.rowsRecipe;
      const searched = lazy ? {layout: unpackLayout(yield* stage('whole-shapes', () => timedSteps('block-search', function* () {
        return packLayout(search.blocks !== planeSearchSteps ? (yield* search.blocks(base, width, height, options, signal)).layout
          : !journal && provider.onDevice() ? (yield* planeSearchSteps(base, width, height, options, signal, true)).layout
          : yield* planeSearchLayoutSteps(base, width, height, options, signal));
      }())))} : yield* search.blocks(base, width, height, options, signal);
      const layout = searched.layout, at = memoAt(defer(function* (p) {
        const base = yield* provider.baseSteps(p, {keepPlanes: true});
        return journal ? provider.lazy(base, layout, options) : (banded || offloading('score-band')) && base.rowsRecipe
          ? yield* provider.lazyLook(base, layout, options) : yield* planeLayoutSteps(base, width, height, layout, options, signal);
      }), q, searched.image);
      if (!CAPTURE_PHOTO) at.recipe = {layout, options};
      return {at, image: lazy ? yield* at(q) : searched.image};
    };
    const pruneLayout = lay => {
      if (!lay) return null;
      const counts = new Map();
      for (const b of lay) { const f = TRANSFORMS[b.id].table; if (f) counts.set(f, (counts.get(f) ?? 0) + 1); }
      const drop = new Set();
      for (const [f, c] of counts) if (c > 0 && c < 8) drop.add(f);
      if (!drop.size) return lay;
      const out = [];
      for (const b of lay) {
        if (!drop.has(TRANSFORMS[b.id].table)) { out.push(b); continue; }
        const bw = TRANSFORMS[b.id].width >> 3, bh = TRANSFORMS[b.id].height >> 3;
        for (let dy = 0; dy < bh; dy++) for (let dx = 0; dx < bw; dx++) out.push({id: 0, bx: b.bx + dx, by: b.by + dy});
      }
      return out.sort((a, b) => (a.by - b.by) || (a.bx - b.bx));
    };
    const layoutVarShare = lay => {
      if (!lay) return 0;
      let varCells = 0;
      for (const b of lay) if (b.id) varCells += (TRANSFORMS[b.id].width >> 3) * (TRANSFORMS[b.id].height >> 3);
      return varCells / (Math.ceil(width / 8) * Math.ceil(height / 8));
    };
    if (lean) {
      writerEffort = leanWrite;
      yield 0.05 * leanPart;
      const useFastDz = !CAPTURE_PHOTO && deadzones && lean && (quality <= 85 || highDz) && !measureOutput && s2Admitted(plan, width, height);
      let plain = null, qSeed = leanStart(quality);
      if (useFastDz) {
        const pObs = yield* measured((function* () { return yield* scoreOnly(yield* imageAt(qSeed), first); })(), journal ? measureSteps : measure, signal);
        if (highDz) seen.set(qSeed, pObs);
        const m0 = pObs.scores.ssimulacra2 - requested.ssimulacra2;
        const dSlope = highDz ? 0.88 : quality >= 70 ? 1.15 : 0.82, seedAim = highDz ? -0.08 : 0.02;
        qSeed = Math.max(1, Math.min(99, Math.round((qSeed + (seedAim - m0) / dSlope) * 100) / 100));
        if (!noFloor && (!leanOnly || alpha)) plain = yield* writtenNow(imageAt, yield* probe(imageAt, leanStart(quality), LEAN_PROBES, null, seen), leanWrite);
      } else {
        plain = yield* writtenNow(imageAt, yield* probe(imageAt, qSeed, LEAN_PROBES, null, noFloor ? null : seen), leanWrite);
        qSeed = plain.quality;
      }
      yield 0.3 * leanPart;
      imageAt.clear();
      let searched = yield* shapes(qSeed, {...blockOptions(), ...(highDz && qSeed >= 85 && {gentleChromaDz: true}), ...(useFastDz && {rated: true})});
      let shapedAt = searched.at;
      shapedAt.lean = true;
      if (useFastDz && shapedAt.recipe) {
        const {layout: rawLayout, options} = shapedAt.recipe, q0 = qSeed, basePic = searched.image;
        const layout = highDz ? pruneLayout(rawLayout) : rawLayout;
        const baseQ0 = yield* provider.baseSteps(q0, {keepPlanes: true});
        const keepPlain = highDz && layoutVarShare(layout) < 0.05;
        searched = null; shapedAt.clear();
        const zones = yield* stage('whole-zones', function* () {
          const made = yield* deadzones(function* (map) {
            const o = {...options, deadzoneMap: map, rated: true};
            return journal || (banded || offloading('score-band')) && baseQ0.rowsRecipe ? provider.lazy(baseQ0, layout, o, false) : yield* planeLayoutSteps(baseQ0, width, height, layout, o, signal);
          }, {rgba: data}, width, height, signal, 7, layout === rawLayout ? basePic : null, readingIntent, q0);
          return {map: made, qShift: made.qShift, scoreZoned: made.scoreZoned, slope: made.slope};
        });
        const dzMap = zones.map;
        zoned = !(readingIntent <= deadzones.threeScalesTo);
        const oZoned = {...options, rated: false, deadzoneMap: dzMap};
        shapedAt = memoAt(defer(function* (p) {
          const wantGentle = highDz && p >= 85, activeDz = highDz && p >= q0 + 0.8 ? null : dzMap;
          const oAt = wantGentle !== !!oZoned.gentleChromaDz || activeDz !== dzMap
            ? {...options, rated: false, ...(activeDz && {deadzoneMap: activeDz}), ...(wantGentle && {gentleChromaDz: true})}
            : oZoned;
          const base = p === q0 ? baseQ0 : yield* provider.baseSteps(p, {keepPlanes: true});
          return journal || (banded || offloading('score-band')) && base.rowsRecipe ? provider.lazy(base, layout, oAt) : yield* planeLayoutSteps(base, width, height, layout, oAt, signal);
        }));
        if (!CAPTURE_PHOTO) shapedAt.recipe = {layout, options: oZoned};
        shapedAt.lean = true;
        yield 0.5 * leanPart;
        const zSlope = zones.slope ?? 0.8;
        const qStart = highDz && Number.isFinite(zones.scoreZoned)
          ? Math.max(1, Math.min(99.5, Math.round((q0 + (0.04 - (zones.scoreZoned - requested.ssimulacra2)) / zSlope) * 100) / 100))
          : Math.max(1, Math.min(99.5, Math.round((q0 + (zones.qShift ?? 0.15)) * 100) / 100));
        const zOpts = highDz
          ? {low: Math.max(1, Math.round((qStart - 2.5 / zSlope) * 100) / 100), high: Math.min(99.9, Math.round((qStart + 3.0 / zSlope) * 100) / 100), aim: 0.03, lastAim: 0.05, close: 0.08, slope: zSlope}
          : {aim: 0.035, close: 0.08};
        const zProbed = yield* probe(shapedAt, qStart, highDz ? 3 : 4, null, null, zOpts);
        yield* keep(shapedAt, zProbed, leanWrite);
        const zonedBytes = bytes;
        shapedAt.clear();
        yield 0.8 * leanPart;
        if (keepPlain && !plain) {
          yield* keep(imageAt, yield* probe(imageAt, leanStart(quality), LEAN_PROBES, null, seen), leanWrite);
          if (bytes !== zonedBytes) zoned = false;
        }
        else if (!leanOnly && plain) yield* keep(imageAt, plain, leanWrite);
        else if (!bytes) yield* keep(imageAt, yield* probe(imageAt, leanStart(quality), LEAN_PROBES), leanWrite);
      } else {
        const initial = {v: {quality: plain.quality, image: searched.image, ...yield* qualify(searched.image, first)}};
        searched = null;
        yield 0.5 * leanPart;
        yield* keep(shapedAt, yield* probe(shapedAt, plain.quality, LEAN_PROBES, taken(initial)), leanWrite);
        shapedAt.clear();
        yield 0.8 * leanPart;
        yield* keep(imageAt, plain, leanWrite);
      }
      if (alpha) {
        const unfilteredAt = memoAt(defer(q => provider.image(q, {filter: 'plain'})));
        if (!CAPTURE_PHOTO) unfilteredAt.recipe = {};
        yield* keep(unfilteredAt, yield* probe(unfilteredAt, plain?.quality ?? qSeed, LEAN_PROBES), leanWrite);
        unfilteredAt.clear();
      }
      check(signal);
      if (leanOnly) {
        yield* settle();
        shapedAt.clear();
        yield* admit();
        return bytes;
      }
    }
    const fromLean = lean && asked === 8;
    const rung0 = Math.max(5, firstEffort), nineLean = lean && asked === 9;
    const rungAt = (rung, f) => nineLean ? 0.25 + 0.4 * (rung - rung0 + f) / (effort - rung0 + 1) : f;
    const late = nineLean ? {zones: [0.65, 0.85], settle: [0.85, 0.98]} : fromLean ? {zones: [0.45, 0.75], settle: [0.75, 0.98]} : null;
    let coarse = fromLean ? null : yield* probe(imageAt, quality, 6, null, seen);
    let fine = null, block = null, blockAt = null, block16 = null, block16At = null;
    for (let rung = Math.max(5, firstEffort); !fromLean && rung <= effort; rung++) {
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
      yield rungAt(rung, 0.3);
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
        yield rungAt(rung, 0.6);
      }
      for (const [lv, cands, a0, a1] of [[8, ['field'], 0.6, 0.75], [9, search.candidates, 0.75, 1]]) if (rung >= lv) {
        const found = yield* reported(measured(search.score(provider, requested, {candidates: cands, effort: rung,
          start: best.quality, aq: search.aq, exactSize: true, measureSteps: measureOutput ? probeQualify : qualify, libjxlOf: libjxlOfImage}), journal ? measureSteps : measure, signal), rungAt(rung, a0), rungAt(rung, a1));
        if (found?.pass) keepBytes(found.bytes, found.ssimulacra2, CAPTURE_PHOTO ? null : recipeOf(found), loopMore(found));
      }
    }
    const zoneRung = function* () {
    if (!CAPTURE_PHOTO && deadzones && pubEffort >= 8 && keptRecipe && !measureOutput && s2Admitted(plan, width, height)) {
      const zoneRecipe = keptRecipe;
      for (const zoneEffort of pubEffort >= 9 ? [8, 9] : [8]) {
        const {quality: q0, field, layout: rawLayout, options, transforms} = zoneRecipe;
        const layout = pruneLayout(rawLayout);
        const gentleChromaDz = quality > 85;
        let epfScale = 1.0;
        const make = (extra, keepBand = true, epfMul = 1.0) => function* (p) {
          let base = yield* provider.baseSteps(p, {keepPlanes: true, ...(field && {fieldScale: field})});
          if (epfMul !== 1.0 && base.epf) base = {...base, epf: base.epf * epfMul};
          const o = {...(options ?? provider.blockOptions(base)), ...(zoneEffort === 8 && quality <= 85 && {compactDct8: true, tableBands: 6, dct8Bands: 8}), ...(gentleChromaDz && {gentleChromaDz: true}), ...(transforms && {transforms}), ...extra};
          const shape = layout ?? plainLayout(base);
          return journal || (banded || offloading()) && base.rowsRecipe ? provider.lazy(base, shape, o, keepBand) : yield* planeLayoutSteps(base, width, height, shape, o, signal);
        };
        const deadzoneMap = yield* stage('whole-zones', function* () {
          return yield* deadzones(function* (map) { return yield* make({deadzoneMap: map, rated: true}, false)(q0); }, {rgba: data}, width, height, signal, zoneEffort);
        });
        const zTight = zoneEffort >= 9 ? (quality > 85 ? {aim: 0.018, lastAim: 0.032, close: 0.045} : {aim: 0.012, lastAim: 0.024, close: 0.028}) : {aim: 0.018, lastAim: 0.032, close: 0.042};
        if (zoneEffort >= 9) {
          let bestEpfS2 = -Infinity;
          for (const em of [1.0, 0.74, 1.24]) {
            const ePic = yield* make({deadzoneMap}, true, em)(q0);
            const eObs = yield* measured((function* () { return yield* scoreOnly(ePic, WANT_S2); })(), journal ? measureSteps : measure, signal);
            if (eObs.scores.ssimulacra2 > bestEpfS2 + (em === 1.0 ? 0 : 0.02)) { bestEpfS2 = eObs.scores.ssimulacra2; epfScale = em; }
          }
        }
        const zonedAt = memoAt(defer(make({deadzoneMap}, true, epfScale)));
        if (!CAPTURE_PHOTO) zonedAt.recipe = {field, layout, options: {...(options ?? {}), deadzoneMap}};
        const image = yield* zonedAt(q0);
        let zFound = yield* keep(zonedAt, yield* probe(zonedAt, q0, zoneEffort >= 9 ? 10 : 6, {quality: q0, image, ...yield* qualify(image, first)}, null, zTight), zoneEffort);
        let bestCompact = zoneEffort === 8 && quality <= 85;
        zonedAt.clear();
        if (zoneEffort >= 9 && quality <= 85) {
          const cStart = zFound?.quality ?? q0;
          const compactAt = memoAt(defer(make({deadzoneMap, compactDct8: true, tableBands: 6, dct8Bands: 8}, true, epfScale)));
          if (!CAPTURE_PHOTO) compactAt.recipe = {field, layout, options: {...(options ?? {}), deadzoneMap, compactDct8: true, tableBands: 6, dct8Bands: 8}};
          const prevBytes = bytes;
          const cFound = yield* keep(compactAt, yield* probe(compactAt, cStart, 7, null, null, zTight), zoneEffort);
          if (bytes !== prevBytes) { zFound = cFound; bestCompact = true; }
          compactAt.clear();
        }
      }
    }
    };
    yield* late ? reported(zoneRung(), ...late.zones) : zoneRung();
    if (late) yield late.zones[1];
    check(signal);
    yield* late ? reported(settle(), ...late.settle) : settle();
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
