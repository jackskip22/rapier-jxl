import {TRANSFORMS} from './vardct-strategies.mjs';
// SPDX-License-Identifier: MIT
import {retainsWhole, RETAINED_BYTES} from './memory-device.mjs';
import {shown} from './photo-shown.mjs';
import {complete} from './bits.mjs';
import {quantFieldValue} from './vardct-planes.mjs';
import {prepareV6, blockSearchOptions, V6, GABORISH, gaborishRows, v6Options, recycleBandPlanes} from './photo-v6.mjs';
import {v6For, smallPicture} from './photo-v6-settings.mjs';
import {journalFact, JOIN, unit, stage, journaling} from './step-journal.mjs';
import {smoothPhoto} from './v7/low-photo.mjs';
import {stillPhotoProvider} from './photo-v6-provider.mjs';
import {photoXYBSteps, XYB_TABLES} from './photo-xyb.mjs';
import {transformDCT8, dct8Basis} from './photo-dct.mjs';
import {lowWholePhoto} from './photo-low.mjs';
import {writeImageSteps} from './photo-image-write.mjs';
import {raisedPlanLf} from './photo-split.mjs';
import {qualitySteps} from './photo-quality-search.mjs';
import {plainLayout, planeLayoutSteps, planeLevelsSteps} from './photo-plane-levels.mjs';
import {planeSearchSteps, planeSearchLayoutSteps} from './photo-plane-search.mjs';
import {SHARED_PHOTO_SEARCH as SHARED_SEARCH} from './photo-plane-measured.mjs';
import {spannedSteps} from './photo-measured-steps.mjs';
import {candidateImageSteps} from './photo-search.mjs';
import {maskEnergy, maskWeights} from './photo-mask.mjs';
import {memoryPlan, s2Admitted} from './memory-plan.mjs';
import {materialize, fixedStrategyImage, packLayoutDct} from './varblock-core.mjs';
import {packedPicture} from './photo-packed-picture.mjs';
import {learnedOrders} from './varblock-write.mjs';
import {varDCTSteps} from './vardct.mjs';
import {strategyAnsSteps, strategyLfLowerBound, strategyOrderEntry, progressiveTwin, progressiveCarried, progressiveKept, passesKept, keptPasses} from './coefficient-ans.mjs';
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
import {pruneRareTransforms} from './visual-lexer-core.mjs';
import {photoEffortTenPass2Steps} from './photo-effort-ten.mjs';


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
    const out = {...base, components, epf: quantFields ? probe.epf * 2 : probe.epf, rowsRecipe: source.rowsRecipe, ...((typeof __RAPIER_JXL_EFFORT_TEN__ === 'undefined' || __RAPIER_JXL_EFFORT_TEN__ === true) && options.cfl && {cfl: options.cfl}),
      ...(quantFields ? {quantFields, quantFieldBase: 64} : {quantFields: undefined, quantFieldBase: undefined})};
    Object.defineProperty(out, 'sourceRgba', {value: rgba, enumerable: false, configurable: true});
    return Object.defineProperty(out, 'planeBound', {get: source.getBound, enumerable: false, configurable: true});
  };
  const journal = journaling();
  let onDevice = false;
  const makeSource = (key, image, filter, quality) => {
    {
      const stride = image.components[0].stride, rows = image.components[0].rows, W = stride * 8, H = rows * 8;
      const planes = image.planes ?? (filter === 'gaborish' ? prepared.pres?.get(coreAt(quality).gaborish) ?? null : null);
      const sourcePlaneRows = image.planeRows;
      let heldPlanes = planes, fallbackRows = null;
      const rowsOf = (from, to, x0, x1) => heldPlanes ? {planes: heldPlanes, top: 0, stride: W}
        : (fallbackRows ??= sourcePlaneRows ?? (filter === 'plain' ? plainRows(rgba, width, height, color) : gaborishRows(rgba, width, height, coreAt(quality), onDevice)))(from, to, x0, x1);
      const core = filter === 'gaborish' && (!planes || prepared.retain) ? coreAt(quality) : null;
      const rowsRecipe = core && {gaborish: core.gaborish, ...(core.transform && {transform: core.transform})};
      const planeRows = (from, to, x0, x1) => ({stride: W, ...rowsOf(from, to, x0, x1)});
      const devicePlanes = {};
      let bound = null;
      const getBound = () => {
        if (bound === null) {
          bound = 0;
          const needMask = filter === 'gaborish' && !devicePlanes.maskWeight, hf = needMask ? new Float64Array(stride * rows) : null;
          const needPairs = !CAPTURE_PHOTO && device && hostGPU(), staged = needPairs ? new Map() : null;
          if (hf || needPairs) {
            for (let from = 0; from < H; from += ROWS) {
              check(signal);
              const to = Math.min(H, from + ROWS), band = planeRows(from, to), start = (from - band.top) * W, end = start + (to - from) * W, count = end - start;
              if (hf) maskEnergy(band.planes, band.top, stride, from / 8, to / 8, hf);
              if (needPairs) {
                const trio = [];
                for (let c = 0; c < 3; c++) {
                  const p = band.planes[c], pairs = new Float32Array(count * 2);
                  let worst = 0;
                  for (let i = 0; i < count; i++) {
                    const value = p[start + i], hi = Math.fround(value), lo = Math.fround(value - hi);
                    if (!Number.isFinite(value) || !Number.isFinite(hi) || !Number.isFinite(lo))
                      throw fault('JXL_INTERNAL', 'photo-whole-search:ds');
                    const err = Math.abs(value - (hi + lo));
                    if (err > worst) worst = err;
                    pairs[i * 2] = hi; pairs[i * 2 + 1] = lo;
                  }
                  const b32 = new Float32Array([worst]);
                  if (b32[0] < worst) new Uint32Array(b32.buffer)[0]++;
                  if (!Number.isFinite(b32[0])) throw fault('JXL_INTERNAL', 'photo-whole-search:bound');
                  if (b32[0] > bound) bound = b32[0];
                  trio.push(pairs);
                }
                staged.set(from + ':' + to, trio);
              }
            }
            if (hf) devicePlanes.maskWeight = maskWeights(hf, stride, rows).weight;
            if (staged) devicePlanes.staged = staged;
          }
        }
        return bound;
      };
      const base = Object.defineProperty({...image, components: image.components.map(c => ({...c, coeffs: EMPTY_I16})), ...(planes && {planes}), planeRows, devicePlanes},
        'planeBound', {get: getBound, enumerable: false, configurable: true});
      const takePlanes = () => {
        const p = heldPlanes;
        if (!p) return null;
        heldPlanes = null;
        delete base.planes;
        if (filter === 'gaborish') prepared.pres?.delete(coreAt(quality).gaborish);
        return p;
      };
      const setBound = (saved, mask) => { bound = saved; if (mask) devicePlanes.maskWeight = mask; };
      const source = {planeRows, getBound, setBound, takePlanes, devicePlanes, base, rowsRecipe}; sources.set(key, source);
      return source;
    }
  };
  const canonical = (image, filter, quality) => {
    const key = keyOf(filter, quality);
    const source = sources.get(key) ?? makeSource(key, image, filter, quality);
    const out = {...image, ...(source.base.planes && {planes: source.base.planes}), planeRows: source.planeRows, devicePlanes: source.devicePlanes, rowsRecipe: source.rowsRecipe};
    Object.defineProperty(out, 'sourceRgba', {value: rgba, enumerable: false, configurable: true});
    return Object.defineProperty(out, 'planeBound', {get: source.getBound, enumerable: false, configurable: true});
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
      if (!CAPTURE_PHOTO && device && filter === 'gaborish' && options.fieldScale === undefined && !leftDevice('core', n)) {
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
      if (!CAPTURE_PHOTO && (banded || offloading('score-band')) && base.rowsRecipe) return yield* this.lazyLook(base, plainLayout(base), this.blockOptions(base));
      return yield* planeLayoutSteps(base, width, height, plainLayout(base), this.blockOptions(base), signal);
    },
    *write(image, effort, options) {
      while (image?.deferred) image = yield* image.deferred();
      if (!CAPTURE_PHOTO && options?.seedOrders) {
        image = image.lazyStrategy && !image.lazyStrategy.held?.() && !offloading() ? packedPicture(image) : materialize(image);
        const orders = image.strategyData && learnedOrders(image);
        if (orders) return yield* strategyAnsSteps(image, effort, orders);
        if (options.raisedLf) return yield* spannedSteps(writeImageSteps(image, effort, undefined, undefined, raisedPlanLf()));
      }
      return yield* still.write(image, effort, options);
    },
    sourceSteps,
    lazy(base, layout, options, keep = true) {
      if (!CAPTURE_PHOTO && (keep || !options.gpuDeadzone) && base.rowsRecipe && offloading('score-band'))
        return scoreBandPicture(base, width, height, layout, options);
      return layoutPicture(base, width, height, layout, options, keep);
    },
    takePlanes(quality) { return sources.get(keyOf('gaborish', quality))?.takePlanes?.() ?? null; },
    *lazyLook(base, layout, options, keepAsked = true) {
      const keep = keepAsked && !CAPTURE_PHOTO && !offloading('score-band');
      const picture = this.lazy(base, layout, options, keep);
      if (!CAPTURE_PHOTO && onDevice && (!options.deadzoneMap || options.gpuDeadzone)) {
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
  return {provider, prepared, release: () => {
    for (const source of sources.values()) source.devicePlanes.release?.();
    sources.clear();
    if (!journaling()) {
      if (prepared.pooledPlanes) { recycleBandPlanes?.(prepared.pooledPlanes); prepared.pooledPlanes = null; }
      prepared.pres?.clear();
    }
  }};
}

let LOG2_TABLE = null;
const fastLog2 = n => {
  if (n < 65536) {
    if (!LOG2_TABLE) { LOG2_TABLE = new Float64Array(65536); for (let i = 2; i < 65536; i++) LOG2_TABLE[i] = Math.log2(i); }
    return LOG2_TABLE[n];
  }
  return Math.log2(n);
};
const plainLowerBoundBytes = CAPTURE_PHOTO ? null : function plainLowerBoundBytes(image, effort = 7, targetBytes = Infinity) {
  if (!image?.strategyData || image.progressive || image.progression || image.alpha || image.auxiliary) return 0;
  const groupsX = Math.ceil(image.components[0].stride / 32), groupsY = Math.ceil(image.components[0].rows / 32), numGroups = groupsX * groupsY;
  if (numGroups < 1) return 0;
  const std = learnedOrders(image), orders = std ? [null, std] : [null];
  let minAcBits = Infinity, lfBits = null;
  for (const authored of orders) {
    const {img, shared} = strategyOrderEntry(image, authored);
    const {counts, blockCounts} = complete(varDCTSteps(img, {countGroups: [0, numGroups]}, shared));
    (shared.countedByOrder ||= new Map()).set(authored, [counts]);
    shared.blockCounts = blockCounts;
    const {contexts, small, large, totals} = counts;
    let bits = 0, tokens = 0;
    for (let ctx = 0; ctx < contexts; ctx++) {
      const n = totals[ctx];
      if (!(n > 0)) continue;
      tokens += n;
      if (n > 1) bits += n * fastLog2(n);
      const base = ctx * 64;
      for (let v = 0; v < 64; v++) { const c = small[base + v]; if (c > 1) bits -= c * fastLog2(c); }
      const map = large[ctx];
      if (map) for (const c of map.values()) if (c > 1) bits -= c * fastLog2(c);
    }
    const netBits = bits - tokens * 0.02273;
    if (netBits < minAcBits) minAcBits = netBits;
    if (!authored && orders.length > 1 && Math.floor(minAcBits / 8) <= targetBytes) {
      lfBits = strategyLfLowerBound(image, effort);
      if (Math.floor((lfBits + minAcBits) / 8) <= targetBytes) return Math.floor((lfBits + minAcBits) / 8);
    }
  }
  const acOnlyBytes = Math.floor(minAcBits / 8);
  if (acOnlyBytes > targetBytes) return acOnlyBytes;
  lfBits ??= strategyLfLowerBound(image, effort);
  return Math.floor((lfBits + minAcBits) / 8);
};

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
const LEXER_PROBES = 3, LEXER_CLOSE = 0.3, LEXER_AIM = 0.1, LEXER_UNDER = 0.25;
const LEXER_BPP = 0.75;
const PLAN_PROBES = 5, PLAN_AGAIN = 3, PLAN_AIM = 0.2;
const SEED_PIXELS = 512 * 512;
const GATE_QUALITY = 90, PLAN_SHARE = 0.25;
const variableShare = (layout, width, height) => {
  let cells = 0;
  for (const b of layout ?? []) if (b.id) cells += (TRANSFORMS[b.id].width >> 3) * (TRANSFORMS[b.id].height >> 3);
  return cells / (Math.ceil(width / 8) * Math.ceil(height / 8));
};
export const planGate = (lexer, data, width, height, quality, readingIntent, effort) => {
  const share = (p, min) => !!p && variableShare(p.layout, width, height) >= min;
  const at = q => quality === q ? lexer.plan(data, width, height, q, readingIntent, effort) : lexer.plan(data, width, height, q, q / 100, effort);
  if (effort < 6) {
    const open = at(quality);
    return {plan: open?.layout ? open : null};
  }
  const plan = lexer.plan(data, width, height, quality, readingIntent, effort);
  if (!plan) return {plan: null};
  if (!plan.layout) return {plan: null, second: plan};
  return share(quality === GATE_QUALITY ? plan : lexer.plan(data, width, height, GATE_QUALITY, GATE_QUALITY / 100, effort), PLAN_SHARE) ? {plan} : {plan: null, second: plan};
};
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
const floorPart = steps => spannedSteps(steps, 0, 0.1, true);
const spanned = (steps, from, to) => spannedSteps(steps, from, to);
function* effortNineSteps(data, width, height, options) {
  const exact = new Set(), facts = new Map(), sink = {record(bytes, passed, measurements) { facts.set(bytes, {passed, measurements}); }};
  const retainFloor = options.retainFloor && function* (bytes, level) { const file = yield* options.retainFloor(bytes, level); if (file) exact.add(file); return file; };
  const sharedNine = !journaling() && !options.preview ? {probed: new Map()} : null;
  let failed = false;
  try {
    const eight = yield* spanned(wholeSteps(data, width, height, {...options, effort: 8, retainFloor, photoAdmission: sink, _sharedNine: sharedNine}), 0, 0.2);
    const nine = yield* spanned(wholeSteps(data, width, height, {...options, retainFloor, photoAdmission: sink, _sharedNine: sharedNine, lexer: null}), 0.2, 1);
    const seven = yield* spanned(wholeSteps(data, width, height, {...options, effort: 7, firstEffort: 7, retainFloor, photoAdmission: sink, lexer: null}), 0.2, 0.25);
    const small = seven && facts.has(seven) && !exact.has(seven) && (!eight || !facts.has(eight) || exact.has(eight) || seven.length < eight.length) ? seven : eight;
    const kept = small && facts.has(small) && !exact.has(small) && (!nine || small.length < nine.length) ? small : nine;
    const record = kept && facts.get(kept);
    if (record) options.photoAdmission?.record(kept, record.passed, record.measurements);
    return kept;
  } catch (error) { failed = true; throw error; }
  finally {
    let cleanupFailed = false, cleanupError;
    if (sharedNine) { sharedNine.s2Ref = null; if (sharedNine.lean) { sharedNine.lean.zonedImg = null; sharedNine.lean.plainImg = null; } }
    try { sharedNine?.release?.(); } catch (error) { cleanupFailed = true; cleanupError = error; }
    try { sharedNine?.rebuilt?.destroy(); } catch (error) { if (!cleanupFailed) { cleanupFailed = true; cleanupError = error; } }
    if (!failed && cleanupFailed) throw cleanupError;
  }
}
function* effortEightSteps(data, width, height, options) {
  const exact = new Set(), facts = new Map(), sink = {record(bytes, passed, measurements) { facts.set(bytes, {passed, measurements}); }};
  const retainFloor = options.retainFloor && function* (bytes, level) { const file = yield* options.retainFloor(bytes, level); if (file) exact.add(file); return file; };
  const eight = yield* spanned(wholeSteps(data, width, height, {...options, retainFloor, photoAdmission: sink}), 0, 0.85);
  const seven = yield* spanned(wholeSteps(data, width, height, {...options, effort: 7, firstEffort: 7, retainFloor, photoAdmission: sink, lexer: null}), 0.85, 1);
  const kept = seven && facts.has(seven) && !exact.has(seven) && (!eight || !facts.has(eight) || exact.has(eight) || seven.length < eight.length) ? seven : eight;
  const record = kept && facts.get(kept);
  if (record) options.photoAdmission?.record(kept, record.passed, record.measurements);
  return kept;
}
export const fitFinalWriter = (writerEffort, asked) => asked === 7 && writerEffort < 7 ? 7 : null;
export const fitLayoutLevels = (effort, asked) => asked === 7 ? [[7, undefined]]
  : [[6, [4]], [7, undefined]].filter(([level]) => effort >= level);
export const pruneLayout = (typeof __RAPIER_JXL_CAPTURE_PHOTO__ !== 'undefined' && __RAPIER_JXL_CAPTURE_PHOTO__ === true) ? null : lay => lay ? pruneRareTransforms(lay) : null;
const recipePicture = CAPTURE_PHOTO ? null : (provider, recipe, shape, {width, height, quality, journal, banded, signal}) => function* (p) {
  const {field, transforms, epfScale = 1.0} = recipe;
  let base = yield* provider.baseSteps(p, {keepPlanes: true, ...(field && {fieldScale: field})});
  if (epfScale !== 1.0 && base.epf) base = {...base, epf: base.epf * epfScale};
  const rOpts = recipe.options?.deadzoneMap && p >= 98.5 ? {...recipe.options, deadzoneMap: undefined} : (recipe.options ?? {});
  const o = {...(recipe.providerBlocks || !recipe.options ? provider.blockOptions() : {}), ...rOpts, ...(quality > 85 && {gentleChromaDz: true}), ...(transforms && {transforms})};
  return journal || (banded || offloading()) && base.rowsRecipe ? provider.lazy(base, shape, o, true) : yield* planeLayoutSteps(base, width, height, shape, o, signal);
};
export function* settleSteps({bound, bytes, closest, keep, retainFloor, readingIntent, asked, pixels, lexer, own = () => 0}) {
  if (lexer) yield* lexer();
  yield* bound();
  const near = closest();
  if (!bytes() && near && Number.isFinite(near.score) && !(retainFloor && readingIntent > 0.92)) keep(near.bytes, near.score);
  if (!bytes() && retainFloor) { const exact = yield* retainFloor(null); if (exact) keep(exact, null); }
  else if (bytes() && retainFloor && Math.max(bytes().length, own()) * 8 >= EXACT_BITS * pixels) {
    const exact = yield* retainFloor(null, asked);
    if (exact && exact.length < bytes().length) keep(exact, null);
  }
}
const effortTenPhotoSteps = (typeof __RAPIER_JXL_EFFORT_TEN__ !== 'undefined' && __RAPIER_JXL_EFFORT_TEN__ !== true) || (typeof __RAPIER_JXL_CAPTURE_PHOTO__ !== 'undefined' && __RAPIER_JXL_CAPTURE_PHOTO__ === true) ? null : function* effortTenPhotoSteps(data, width, height, options) {
  const exact = new Set(), facts = new Map(), byFile = new Map(), shapedSeen = [];
  const sink = {record(bytes, passed, measurements) { facts.set(bytes, {passed, measurements}); }};
  const retainFloor = options.retainFloor && function* (bytes, level) { const file = yield* options.retainFloor(bytes, level); if (file) exact.add(file); return file; };
  const onRecipes = (file, recipe, leanShaped) => {
    if (file && recipe) byFile.set(file, recipe);
    if (leanShaped) shapedSeen.push(leanShaped);
  };
  const baseSteps = smallPicture(width, height) ? wholeSteps : effortNineSteps;
  const nine = yield* spanned(baseSteps(data, width, height, {...options, effort: 9, retainFloor, photoAdmission: sink, onRecipes}), 0, 0.45);
  const nineRecord = nine && (facts.get(nine) ?? [...facts.entries()].findLast(([k]) => k.length === nine.length)?.[1]);
  const m0 = nineRecord?.measurements?.[0];
  if (!nine || exact.has(nine) || !nineRecord?.passed || !m0 || !Number.isFinite(m0.score) || !options.deadzones) {
    if (nineRecord) options.photoAdmission?.record(nine, nineRecord.passed, nineRecord.measurements);
    return nine;
  }
  const nineScore = m0.score, nineFloor = m0.floor;
  const primary = byFile.get(nine) ?? [...byFile.entries()].findLast(([k]) => k.length === nine.length)?.[1];
  const recipes = [];
  if (primary) recipes.push(primary);
  for (const r of [...byFile.values(), ...shapedSeen]) {
    if (r && !recipes.some(x => x.layout === r.layout && x.field === r.field)) recipes.push(r);
  }
  if (!recipes.length) {
    options.photoAdmission?.record(nine, nineRecord.passed, nineRecord.measurements);
    return nine;
  }
  const signal = options.signal, colorSpace = options.colorSpace ?? 'srgb';
  const s2Data = s2RGBA(journalFact(data, JOIN) ? data.subarray(0, data.length) : data, s2Dimensions(width, height), true);
  const smooth = colorSpace === 'srgb' ? yield* unit('low-smooth-10', () => smoothPhoto(s2Data, width, height)) : undefined;
  const {color} = lowWholePhoto(s2Data, width, height, {colorSpace, signal, smooth, v6: true});
  const upload = !color?.transform && (color?.space ?? 'srgb') === 'srgb' && !smallPicture(width, height);
  const plan = memoryPlan(width * height, {width, height, inputBytes: s2Data.buffer.byteLength});
  if (!s2Admitted(plan, width, height)) {
    options.photoAdmission?.record(nine, nineRecord.passed, nineRecord.measurements);
    return nine;
  }
  const journal = journaling();
  const banded = !plan.known && !journal && !offloading('score-band') && retainsWhole(width * height, RETAINED_BYTES) ? false : plan.banded;
  const made = wholeProvider(prepareV6(s2Data, width, height, color, {}, {banded: true, upload, smallest: true}), signal, !color?.transform && (color?.space ?? 'srgb') === 'srgb', banded);
  let rebuilt = null, failed = false;
  const provided = () => (rebuilt ??= options.imageMeasure(s2Data, width, height, color, signal, plan));
  const resolve = function* (img) { while (img?.deferred) img = yield* img.deferred(); return img; };
  const scoreWith = (img, want) => (function* () {
    const m = journal ? provided().measureSteps(yield* resolve(img), want) : provided().measure(img, want);
    return (typeof m?.next === 'function' ? yield* m : m).ssimulacra2;
  })();
  try {
    const pass2 = yield* spanned(photoEffortTenPass2Steps({
      provider: made.provider, data: s2Data, width, height, quality: options.quality,
      nineBytes: nine, nineScore, nineFloor, recipes,
      pruneLayout, plainLayout, planeLayoutSteps, cellSums: options.deadzones.cellSums,
      recipeAt: (recipe, shape) => recipePicture(made.provider, recipe, shape, {width, height, quality: options.quality, journal, banded, signal}),
      scoreExact: img => scoreWith(img, {...WANT_S2, exact: true}),
      scoreLibjxl: img => scoreWith(img, LIBJXL_WANT),
      writeAtNine: (img, tag) => stage(`e10-w9-${tag}`, function* () { const m = yield* resolve(img); return shown(yield* made.provider.write(m, 9, {pass: true}), m); }),
      writeAtTen: (img, tag) => stage(`e10-w10-${tag}`, function* () { const m = yield* resolve(img); return shown(yield* made.provider.write(m, 10, {pass: true}), m); }),
      journal, banded, offloading, signal,
    }), 0.45, 1);
    rebuilt?.settle?.();
    if (pass2?.bytes && pass2.bytes.length < nine.length && pass2.score >= Math.max(nineFloor ?? 0, nineScore)) {
      const measurements = wholePhotoMeasurements(pass2.score, nineFloor);
      options.preview?.(pass2.bytes, {width, height, measurements});
      options.photoAdmission?.record(pass2.bytes, true, measurements);
      return pass2.bytes;
    }
    options.photoAdmission?.record(nine, nineRecord.passed, nineRecord.measurements);
    return nine;
  } catch (error) { failed = true; throw error; }
  finally {
    let cleanupFailed = false, cleanupError;
    try { made.release?.(); } catch (error) { cleanupFailed = true; cleanupError = error; }
    try { rebuilt?.destroy(); } catch (error) { if (!cleanupFailed) { cleanupFailed = true; cleanupError = error; } }
    if (!failed && cleanupFailed) throw cleanupError;
  }
};
export function* wholePhotoSteps(data, width, height, options) {
  const ten = (typeof __RAPIER_JXL_EFFORT_TEN__ === 'undefined' || __RAPIER_JXL_EFFORT_TEN__ === true) && !(typeof __RAPIER_JXL_CAPTURE_PHOTO__ !== 'undefined' && __RAPIER_JXL_CAPTURE_PHOTO__ === true) && options.effort === 10 && options.firstEffort < 9 && options.quality < 100 && options.readingIntent !== undefined && !options.measureOutput && !options.fit;
  const nine = !(typeof __RAPIER_JXL_CAPTURE_PHOTO__ !== 'undefined' && __RAPIER_JXL_CAPTURE_PHOTO__ === true) && options.effort === 9 && options.firstEffort < 9 && options.quality < 100 && options.readingIntent !== undefined && !options.measureOutput && !options.fit && !smallPicture(width, height);
  const eight = !(typeof __RAPIER_JXL_CAPTURE_PHOTO__ !== 'undefined' && __RAPIER_JXL_CAPTURE_PHOTO__ === true) && options.effort === 8 && options.firstEffort < 8 && options.quality < 100 && options.readingIntent !== undefined && !options.measureOutput && !options.fit && !smallPicture(width, height);
  const steps = timedSteps('whole-photo', ten ? effortTenPhotoSteps(data, width, height, options) : nine ? effortNineSteps(data, width, height, options) : eight ? effortEightSteps(data, width, height, options) : wholeSteps(data, width, height, options)), signal = options.signal;
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
export const curveBytes = CAPTURE_PHOTO ? null : function curveBytes(points, q) {
  if (points.length === 1) return points[0].bytes;
  const above = points.findIndex(row => row.quality >= q), k = above < 0 ? points.length - 1 : Math.max(above, 1);
  const a = points[k - 1], b = points[k];
  if (a.quality === b.quality) return b.bytes;
  return Math.exp(Math.log(a.bytes) + (Math.log(b.bytes) - Math.log(a.bytes)) * (q - a.quality) / (b.quality - a.quality));
};
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
  deadzones = null, alpha = false, _sharedNine: sharedNine = null, onRecipes = null, lexer = null, chooseFloorGroup}) {
  const _sharedNine = (typeof __RAPIER_JXL_CAPTURE_PHOTO__ !== 'undefined' && __RAPIER_JXL_CAPTURE_PHOTO__ === true) ? null : sharedNine;
  if (quality >= 100) return null;
  if (effort >= MEASURED_EFFORT) {
    if (maxPixels !== undefined) {
      if (!Number.isSafeInteger(maxPixels) || maxPixels < 1)
        throw fault('JXL_INPUT', 'maxPixels: positive integer');
      admitSize(width, height, {pixels: maxPixels, edge: EDGE});
    }
    if (journalFact(data, JOIN)) data = data.subarray(0, data.length);
    data = _sharedNine ? (_sharedNine.data ??= s2RGBA(data, s2Dimensions(width, height), true)) : s2RGBA(data, s2Dimensions(width, height), true);
  }
  const smooth = !measureOutput && colorSpace === 'srgb' ? (_sharedNine ? (_sharedNine.hasSmooth ? _sharedNine.smooth : (_sharedNine.hasSmooth = true, _sharedNine.smooth = smoothPhoto(data, width, height))) : yield* unit('low-smooth', () => smoothPhoto(data, width, height))) : undefined;
  const {color, steps: low} = lowWholePhoto(data, width, height, {colorSpace, signal, smooth, v6: !measureOutput});
  if (effort < MEASURED_EFFORT) return yield* low({quality, effort});
  const lean = !(typeof __RAPIER_JXL_CAPTURE_PHOTO__ !== 'undefined' && __RAPIER_JXL_CAPTURE_PHOTO__ === true) && effort >= LEAN_EFFORT && readingIntent !== undefined && !measureOutput && !fit && !smallPicture(width, height), leanWrite = effort, leanOnly = lean && effort === LEAN_EFFORT;
  const noFloor = lean && effort <= 8;
  const asked = effort;
  const leanPart = lean && asked >= 8 ? (asked === 9 ? 0.25 : 0.45) : 1;
  firstEffort = firstEffort >= effort ? measuredLevel(effort) : Math.min(firstEffort, 5);
  effort = measuredLevel(effort);
  const lexes = !CAPTURE_PHOTO && !!lexer && !measureOutput && !fit
    && readingIntent !== undefined && colorSpace === 'srgb' && !smallPicture(width, height);
  let lexed = lexes && effort !== 4 ? lexer.plan(data, width, height, quality, readingIntent, asked) : null;
  const upload = !CAPTURE_PHOTO && !measureOutput && !color?.transform && (color?.space ?? 'srgb') === 'srgb' && !smallPicture(width, height);
  const search = photoSearch ?? SHARED_SEARCH, measured = search.measured;
  const plan = memoryPlan(width * height, {width, height, inputBytes: data.buffer.byteLength});
  const banded = !CAPTURE_PHOTO && !measureOutput && plan.banded && !(!plan.known && !journaling() && !offloading('score-band') && retainsWhole(width * height, RETAINED_BYTES));
  let rebuilt = null, made = null, writerEffort = Math.max(5, firstEffort);
  if (!CAPTURE_PHOTO && !measureOutput && typeof imageMeasure !== 'function') throw fault('JXL_INTERNAL', 'photo-whole-search:provider');
  const measure = (CAPTURE_PHOTO || measureOutput) ? function* (image, want) {
    if (!made) throw fault('JXL_INTERNAL', 'photo-whole-search:writer');
    return yield* measureOutput(yield* made.provider.write(image, writerEffort, {pass: true}), want, image);
  } : Object.assign((image, want) => provided().measure(image, want), {many: (images, want) => {
    const provider = provided();
    if (typeof provider.measureMany === 'function') return provider.measureMany(images, want);
    return (function* () {
      const list = [];
      for (const image of images) { const answer = provider.measure(image, want); list.push(typeof answer?.next === 'function' ? yield* answer : answer); }
      return list;
    })();
  }});
  const measureSteps = function* (image, want) {
    while (image?.deferred) image = yield* image.deferred();
    return yield* provided().measureSteps(image, want);
  };
  const shareRebuilt = !!(_sharedNine && !hostGPU() && !measureOutput);
  let settles = false;
  if (shareRebuilt && _sharedNine.rebuilt) { rebuilt = _sharedNine.rebuilt; rebuilt.pin?.(null, true); }
  const provided = () => {
    if (!rebuilt) {
      rebuilt = imageMeasure(data, width, height, color, signal, plan);
      if (shareRebuilt) _sharedNine.rebuilt = rebuilt;
      if (settles) rebuilt.later?.();
    }
    return rebuilt;
  };
  const journal = !CAPTURE_PHOTO && !measureOutput && journaling();
  const defer = make => journal ? function* (q) { yield* made.provider.sourceSteps(q); return {deferred: () => make(q)}; } : make;
  const resolve = function* (image) { while (image?.deferred) image = yield* image.deferred(); return image; };
  const taught = (typeof __RAPIER_JXL_TEACH__ === 'undefined' || __RAPIER_JXL_TEACH__ === true) && !CAPTURE_PHOTO ? (typeof globalThis.__RAPIER_JXL_TEACH === 'function' ? globalThis.__RAPIER_JXL_TEACH : null) : null;
  const scoreFile = function* (file, image, want) {
    const scores = yield* stage('whole-score', function* () {
      const value = (CAPTURE_PHOTO || measureOutput) ? yield* measureOutput(file, want, yield* resolve(image))
        : journal ? measureSteps(image, want) : measure(image, want);
      return typeof value?.next === 'function' ? yield* value : value;
    });
    check(signal);
    if (want?.ssimulacra2 && !Number.isFinite(scores?.ssimulacra2)) throw fault('JXL_INPUT', 'score: finite number');
    if ((want?.arithmetic ?? 'binary64') === 'binary64') announce?.(file, scores.ssimulacra2);
    return scores;
  };
  let bytes = null, selectedScore = null, release = null, admittedFloor = null, failed = false, zoned = false;
  const announce = preview && ((file, score) => preview(file, {width, height, measurements: Number.isFinite(score)
    ? wholePhotoMeasurements(score, admittedFloor ?? wholePhotoFloor(score, readingIntent,
      wholePhotoTarget(score, readingIntent, !!measureOutput, smallPicture(width, height))), measureOutput ? 'decoded-output' : 'encoder-reconstruction') : []}));
  const kept = [];
  let keptRecipe = null, leanShapedRecipe = null, boundRecipe = null;
  const keepBytes = (candidate, score, recipe = null, more = null) => {
    if ((typeof __RAPIER_JXL_TEACH__ === 'undefined' || __RAPIER_JXL_TEACH__ === true) && taught && candidate) taught({decision: 'whole', effort, intent: readingIntent, width, height,
      quality: more?.quality ?? recipe?.quality ?? null, bytes: candidate.length, score: typeof score === 'number' ? score : null});
    if (candidate && more) kept.push({bytes: candidate, score, ...(!CAPTURE_PHOTO && (typeof __RAPIER_JXL_EFFORT_TEN__ === 'undefined' || __RAPIER_JXL_EFFORT_TEN__ === true) && onRecipes && recipe && {recipe}), ...more});
    if (candidate && wholePhotoSmaller(bytes ? bytes.length : null, candidate.length)) { bytes = candidate; selectedScore = score; if (!CAPTURE_PHOTO) keptRecipe = recipe; }
  };
  try {
    const lowFiles = new WeakMap();
    const lowRun = function* (q) {
      let image;
      const file = yield* floorPart(low({quality: q, effort: FLOOR_EFFORT, observe: selected => { image = selected; },
        chooseLfGroup: chooseFloorGroup}));
      if (!image) throw fault('JXL_INTERNAL', 'photo-whole-search:low');
      lowFiles.set(image, shown(file, image));
      return image;
    };
    const lowAt = journal ? function* (q) { return {lowQuality: q}; } : lowRun;
    const scoredLow = function* (image, want) {
      if (!journal) { const file = lowFiles.get(image); return {file, scores: yield* scoreFile(file, image, want)}; }
      const {laid, ...probe} = yield* stage('low-probe', function* () {
        const made = yield* lowRun(image.lowQuality), file = lowFiles.get(made);
        return {file, scores: yield* scoreFile(file, made, want), laid: yield* passesKept(file, effort)};
      });
      keptPasses(probe.file, laid);
      return probe;
    };
    const lowRedo = function* (q) {
      const image = yield* lowAt(q), {file, scores} = yield* scoredLow(image, {...WANT_S2, exact: true});
      return {bytes: file, score: scores.ssimulacra2, quality: q,
        libjxlScore: scores.ssimulacra2 >= requested.ssimulacra2 ? (yield* scoredLow(image, LIBJXL_WANT)).scores.ssimulacra2 : undefined};
    };
    const lowMore = q => ({quality: q, redo: lowRedo,
      libjxl: function* () { return (yield* scoredLow(yield* lowAt(q), LIBJXL_WANT)).scores.ssimulacra2; }});
    const exactOf = (picture, file = null) => Object.assign(function* () { return (yield* scoreFile(file, yield* picture(), WANT_S2)).ssimulacra2; },
      {...(!CAPTURE_PHOTO && {begin: function* () { if (!journal && !measureOutput) yield* provided().begin(yield* picture(), WANT_S2); }})});
    const lowExact = (file, q, image) => journal ? function* () { return (yield* scoredLow(yield* lowAt(q), WANT_S2)).scores.ssimulacra2; }
      : function* () { return (yield* scoreFile(file, image ?? (yield* lowAt(q)), WANT_S2)).ssimulacra2; };
    if (!(typeof __RAPIER_JXL_CAPTURE_PHOTO__ !== 'undefined' && __RAPIER_JXL_CAPTURE_PHOTO__ === true) && fit) return yield* fitSteps();
    settles = true;
    let secondPlan = null;
    if (lexes && effort === 4) {
      ({plan: lexed, second: secondPlan = null} = planGate(lexer, data, width, height, quality, readingIntent, asked));
    }
    const planFirst = !!lexed && effort === 4;
    const requested = {ssimulacra2: noFloor || planFirst ? wholePhotoTarget(0, readingIntent, false) : 0};
    const admit = function* () {
      rebuilt?.settle?.();
      if (typeof selectedScore === 'function') selectedScore = yield* selectedScore();
      if (bytes) photoAdmission?.record(bytes, true, wholePhotoMeasurements(selectedScore, admittedFloor, measureOutput ? 'decoded-output' : undefined));
    };
    let closest = null;
    const bounded = function* () {
      if (readingIntent === undefined || !kept.length) return;
      const t = requested.ssimulacra2, floor = t - SEARCH_BOUND;
      const chosen = progressiveKept(yield* stage('whole-bound', progressiveCarried(function* () {
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
          if (!c.lexer) lifted = true;
          if (c.redo) starts.push(c);
        }
        for (const start of !pick ? starts : asked >= 8 ? starts.slice(0, 1) : []) {
          let at = start, before = null;
          for (let i = 0; i < RAISES && at.quality < 99.9; i++) {
            const rise = before && at.quality > before.quality ? (at.libjxlScore - before.libjxlScore) / (at.quality - before.quality) : 0;
            const slope = rise > 0 ? Math.min(SCORE_SLOPE, Math.max(SCORE_SLOPE / 16, rise)) : SCORE_SLOPE;
            const q = Math.min(99.9, Math.round((at.quality + Math.max(0.1, (floor - at.libjxlScore) / slope)) * 100) / 100);
            const next = {...(yield* at.redo(q, !!pick)), redo: at.redo, ...((typeof __RAPIER_JXL_EFFORT_TEN__ === 'undefined' || __RAPIER_JXL_EFFORT_TEN__ === true) && onRecipes && at.recipe && {recipe: {...at.recipe, quality: q}})};
            if (pick && !(next.bytes?.length < pick.bytes.length)) break;
            if (next.score >= t && next.libjxlScore >= floor) { pick = next; lifted = true; break; }
            if (!(next.score >= t)) break;
            before = at; at = next;
          }
          if (!near || at.libjxlScore > near.libjxlScore) near = at;
        }
        let plateau = null;
        if (!pick && near && near.redo && retainFloor && readingIntent > 0.92 && near.quality < 99.8) {
          const next = {...(yield* near.redo(Math.round((near.quality + 99.9) / 2 * 100) / 100, false)), redo: near.redo, ...((typeof __RAPIER_JXL_EFFORT_TEN__ === 'undefined' || __RAPIER_JXL_EFFORT_TEN__ === true) && onRecipes && near.recipe && {recipe: {...near.recipe, quality: Math.round((near.quality + 99.9) / 2 * 100) / 100}})};
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
            const next = yield* pick.redo(q, false, true);
            if (next.score >= t && next.libjxlScore >= floor && next.bytes.length < pick.bytes.length) pick = {...next, ...((typeof __RAPIER_JXL_EFFORT_TEN__ === 'undefined' || __RAPIER_JXL_EFFORT_TEN__ === true) && onRecipes && pick.recipe && {recipe: {...pick.recipe, quality: q}}), redo: pick.redo};
            else failed = q;
          }
          return pick;
        };
        const under = pick.score - t < 0.1 * SCORE_SLOPE;
        const probes = asked >= 9 ? DESCENT_MAX : asked === 8 ? under ? 0 : DESCENT_MAX : asked < 7 && !lifted || asked === 7 && zoned && !(lifted && readingIntent > 0.85) || under ? 0 : DESCENT;
        pick = yield* descend(pick, order, probes, plateau, asked);
        if (!CAPTURE_PHOTO && asked === 8) {
          const own = order.filter(c => c.lean);
          let start = null;
          for (const c of own) { yield* read(c); if (c.score >= t && c.libjxlScore >= floor) { start = c; break; } }
          if (start && start !== pick) {
            const low = yield* descend(start, own, start.score - t < 0.1 * SCORE_SLOPE ? 0 : DESCENT, null, 7);
            if (low.bytes.length < pick.bytes.length) pick = low;
          }
        }
        if ((typeof __RAPIER_JXL_EFFORT_TEN__ === 'undefined' || __RAPIER_JXL_EFFORT_TEN__ === true) && onRecipes && pick.recipe) boundRecipe = {bytes: pick.bytes, recipe: {...pick.recipe, quality: pick.quality ?? pick.recipe.quality, libjxl: pick.libjxlScore}};
        return {bytes: pick.bytes, score: pick.score};
      })));
      if (!chosen) return;
      if (chosen.under && !chosen.tool && retainFloor && readingIntent > 0.92) { bytes = null; selectedScore = null; closest = null; return; }
      bytes = chosen.bytes; selectedScore = chosen.score;
      if ((typeof __RAPIER_JXL_EFFORT_TEN__ === 'undefined' || __RAPIER_JXL_EFFORT_TEN__ === true) && !CAPTURE_PHOTO && boundRecipe?.bytes === chosen.bytes) keptRecipe = boundRecipe.recipe;
    };
    let lexerTurn = null, lexerDone = null;
    const settle = function* () {
      if ((typeof __RAPIER_JXL_TEACH__ === 'undefined' || __RAPIER_JXL_TEACH__ === true) && taught) taught({decision: 'settle', effort: asked});
      const turn = lexerTurn;
      lexerTurn = null;
      try {
        yield* settleSteps({bound: () => timedSteps('bound', bounded()), bytes: () => bytes, closest: () => closest, keep: keepBytes, retainFloor,
          readingIntent, asked, pixels: width * height, lexer: turn,
          own: () => kept.some(c => c.lexer && c.bytes === bytes) ? kept.reduce((m, c) => c.lexer ? m : Math.max(m, c.bytes?.length ?? 0), 0) : 0});
      } finally { lexerDone?.(); lexerDone = null; }
    };
    let ownFloor = null;
    if (noFloor || planFirst) admittedFloor = requested.ssimulacra2;
    if (!noFloor) {
    const floorSteps = function* () {
    let floorImage = yield* lowAt(quality);
    const bounded = !CAPTURE_PHOTO && readingIntent !== undefined && !measureOutput;
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
        let {file, scores} = yield* scoredLow(image, CAPTURE_PHOTO || want.exact || measureOutput ? want : {...want, doubt: true});
        const d = scores.doubt?.ssimulacra2 ?? 0;
        if (d && (Math.abs(scores.ssimulacra2 - t) <= d || closest && scores.ssimulacra2 < t && scores.ssimulacra2 + d >= closest.score))
          scores = yield* scoreFile(file, image, {...want, exact: true, doubt: false});
        if (scores.ssimulacra2 >= t) keepBytes(file, scores.doubt ? (at.quality === undefined ? exactOf(function* () { return image; }, file) : lowExact(file, at.quality, image)) : scores.ssimulacra2,
          null, at.quality === undefined ? null : lowMore(at.quality, file));
        else if (closest && scores.ssimulacra2 > closest.score) closest = {bytes: file, score: scores.ssimulacra2};
        return {scores, output: {bytes: file, effort: FLOOR_EFFORT}};
      };
      const correctLow = (start, low, high, down, initial) => measured(qualitySteps(lowAt, requested, {start, low, high,
        lastAim: down && effort === 4 ? DOWN_LAST_AIM : undefined, probes: down ? DOWN_PROBES[Math.min(effort, 6) - 4] : 2,
        settle: down ? DOWN_FROM : Infinity, initial, measureSteps: checkedLow}), journal ? measureSteps : measure, signal);
      const corrected = yield* correctLow(quality, over ? 1 : quality, 99.99, over, {quality, image: floorImage, scores: floorScores, output: {bytes: floorFile, effort: FLOOR_EFFORT}});
      if (!over && corrected?.quality > quality && corrected.scores?.ssimulacra2 - requested.ssimulacra2 >= DOWN_FROM)
        yield* correctLow(corrected.quality, quality, corrected.quality, true, {quality: corrected.quality, image: null, scores: corrected.scores, output: corrected.output});
    }
    floorImage = null;
    };
    if (journal) {
      const floor = yield* stage('whole-floor', function* () {
        yield* floorSteps();
        const score = c => typeof c.score === 'number' ? c.score : null;
        const files = [];
        for (const c of kept) files.push({bytes: c.bytes, score: score(c), quality: c.quality, libjxlScore: c.libjxlScore, laid: yield* passesKept(c.bytes, effort)});
        return {target: requested.ssimulacra2, admittedFloor, bytes, closest, selected: kept.findIndex(c => c.bytes === bytes),
          selectedScore: typeof selectedScore === 'number' ? selectedScore : null, kept: files};
      });
      ({admittedFloor, bytes, closest} = floor);
      requested.ssimulacra2 = floor.target;
      kept.length = 0;
      for (const {laid, ...c} of floor.kept) { keptPasses(c.bytes, laid); kept.push({...c, score: c.score ?? lowExact(c.bytes, c.quality), ...lowMore(c.quality)}); }
      selectedScore = floor.selected >= 0 ? kept[floor.selected].score : floor.selectedScore;
      if (floor.selected >= 0) bytes = kept[floor.selected].bytes;
    } else if (planFirst) ownFloor = floorSteps;
    else yield* floorSteps();
    const maxSecondBpp = width * height > 2000000 ? Math.min(lexer?.bpp ?? LEXER_BPP, 0.35) : (lexer?.bpp ?? LEXER_BPP);
    if (secondPlan && !(lexer.seed && width * height > SEED_PIXELS) && bytes && bytes.length * 8 < maxSecondBpp * width * height) lexed = secondPlan;
    if (effort === 4 && !lexed) { yield* settle(); yield* admit(); return bytes; }
    }

    if (_sharedNine?.made) { made = _sharedNine.made; }
    else {
      const prepared = prepareV6(data, width, height, color, {}, {banded: true, upload, smallest: asked >= 8});
      made = wholeProvider(prepared, signal, !CAPTURE_PHOTO && !measureOutput && !color?.transform && (color?.space ?? 'srgb') === 'srgb', banded);
      if (_sharedNine) { _sharedNine.made = made; _sharedNine.release = made.release; }
      else release = made.release;
    }
    const prepared = made.prepared, provider = made.provider;
    const pubEffort = Math.max(effort, leanWrite);
    const highDz = lean && quality > 85 && readingIntent > 0.85;
    const blockOptions = ids => ({...search.options(data, width, height, v6Options(prepared, quality).deadzone), ...((lean || effort >= 6) && (quality <= 85 || highDz) && {compactDct8: true, tableBands: 6, dct8Bands: 8, pruneRare: true}), ...(ids && {ids})});
    const qualify = function* (image, want) {
      if (!CAPTURE_PHOTO && !measureOutput) return {scores: yield* scoreFile(null, image, want), output: {effort: writerEffort}};
      const file = shown(yield* provider.write(image, writerEffort, {pass: true}), image);
      const scores = yield* scoreFile(file, image, want);
      return {scores, output: {bytes: file, effort: writerEffort}};
    };
    const probeQualify = function* (image, want) {
      const file = shown(yield* provider.write(image, PROBE_WRITE, {pass: true}), image);
      return {scores: yield* scoreFile(file, image, want), output: {bytes: file, effort: PROBE_WRITE}};
    };
    let bestQ = Infinity;
    const scoreOnly = (CAPTURE_PHOTO || measureOutput) ? qualify : function* (image, want, at = {}) {
      const scores = yield* scoreFile(null, image, want.exact ? want : {...want, doubt: true});
      if (!journal && scores.ssimulacra2 >= requested.ssimulacra2 && !(at.quality >= bestQ)) { bestQ = at.quality ?? bestQ; rebuilt?.pin?.(image, true); }
      return {scores};
    };
    let written = null;
    const sameWriteEffort = (a, b) => a === b || (!CAPTURE_PHOTO && !measureOutput && a <= 6 && b <= 6);
    const keepWinningMemo = !journal && (banded || width * height <= 2621440);
    const s2Ref = _sharedNine ? (_sharedNine.s2Ref ??= {rgba: data}) : {rgba: data};
    const memoAt = (fn, q0 = NaN, img0 = null, maxHeld = 1) => {
      const held = new Map(), tags = CAPTURE_PHOTO ? null : new Map(), tag = q => tags.get(q) ?? tags.set(q, {}).get(q);
      if (img0) { if (tags) img0.lookTag = tag(q0); held.set(q0, img0); }
      const at = function* (q) {
        const hit = held.get(q);
        if (hit) { held.delete(q); held.set(q, hit); return hit; }
        while (held.size >= maxHeld) held.delete(held.keys().next().value);
        const img = yield* fn(q);
        if (tags && img) img.lookTag = tag(q);
        held.set(q, img);
        return img;
      };
      at.peek = q => held.get(q) ?? null;
      at.keepOnly = (...qs) => { for (const k of [...held.keys()]) if (!qs.includes(k)) held.delete(k); };
      at.clear = () => held.clear();
      if (tags) at.tag = tag;
      return at;
    };
    const first = (CAPTURE_PHOTO || measureOutput) ? WANT_S2 : {...WANT_S2, doubt: true};
    const exactAt = (at, q) => exactOf(function* () { return yield* at(q); });
    const writeImage = function* (image, effort, raised = false) {
      return progressiveKept(yield* stage('whole-keep', function* () {
        const m = yield* resolve(image);
        const compare = raised && planFirst && width <= 2048 && height <= 2048 && chooseFloorGroup?.() === 0;
        const seedOrders = planFirst;
        const write = compare && !seedOrders ? spannedSteps(writeImageSteps(m, effort, undefined, undefined, raisedPlanLf()))
          : provider.write(m, effort, {pass: true, seedOrders, raisedLf: compare});
        return yield* progressiveTwin(shown(yield* write, m), effort);
      }));
    };
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
      const redo = function* (q, needBytes = true, settled = false) {
        const image = yield* resolve(yield* imageAt(q)), write = () => writeImage(image, effort, q > quality);
        let bytes = (CAPTURE_PHOTO || measureOutput) ? yield* write() : null;
        const score = (yield* scoreFile(bytes, image, {...WANT_S2, exact: true, ...(!needBytes && {minScore: requested.ssimulacra2})})).ssimulacra2;
        if (!(score >= requested.ssimulacra2)) return {bytes, score, quality: q};
        const libjxlScore = (yield* scoreFile(bytes, image, settled ? {...LIBJXL_WANT, minScore: requested.ssimulacra2 - SEARCH_BOUND} : LIBJXL_WANT)).ssimulacra2;
        if (needBytes || libjxlScore >= requested.ssimulacra2 - SEARCH_BOUND) bytes ??= yield* write();
        return {bytes, score, libjxlScore, quality: q};
      };
      return {quality, redo, ...(imageAt.lean && {lean: true}), libjxl: function* () { const t = !CAPTURE_PHOTO && !measureOutput && !journal && imageAt.tag?.(quality); return !CAPTURE_PHOTO && t && rebuilt?.pin?.(t) ? (yield* scoreFile(file, {lookTag: t, xyb: true}, LIBJXL_WANT)).ssimulacra2 : yield* libjxlOfImage(yield* imageAt(quality), file); }};
    };
    function* fitSteps() {
      const families = [() => [lowRun, image => lowFiles.get(image)]];
      if (effort > 4) {
        let provider;
        const write = function* (image) { return shown(yield* provider.write(image, writerEffort, {pass: true}), image); };
        families.push(() => {
          const prepared = prepareV6(data, width, height, color, {}, {banded: true, upload, smallest: asked >= 8});
          made = wholeProvider(prepared, signal); release = made.release; provider = made.provider;
          writerEffort = effort;
          return [q => provider.image(q, {filter: 'gaborish'}), write];
        });
        for (const [, ids] of fitLayoutLevels(effort, asked)) families.push(function* (at) {
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
      let chosen = null, scores = null, last = quality, capped = false, chosenAt = null;
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
          chosen = {...found, fits}, scores = score, chosenAt = k > 0 ? [at, write] : null;
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
      const finalWriter = !capped && chosenAt && fitFinalWriter(writerEffort, asked);
      if (finalWriter) {
        const image = yield* chosenAt[0](chosen.quality), probesWriter = writerEffort;
        writerEffort = finalWriter;
        let file;
        try { const made = chosenAt[1](image); file = made instanceof Uint8Array ? made : yield* made; } finally { writerEffort = probesWriter; }
        if (file.length < chosen.file.length) chosen = {...chosen, file, fits: file.length <= fit.maxBytes};
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
    const probe = (imageAt, start, probes, initial = null, seen = null, extra = null) => (bestQ = initial?.scores?.ssimulacra2 >= requested.ssimulacra2 ? (rebuilt?.pin?.(initial.image, true), initial.quality) : Infinity,
      measured(qualitySteps(imageAt, requested, {start, low: 1, high: 99.9, probes, ...extra, initial, measureSteps: scoreOnly, seen}), journal ? measureSteps : measure, signal));
    const imageAt = memoAt(defer(q => provider.image(q, {filter: 'gaborish'})), NaN, null, keepWinningMemo ? 2 : 1);
    if (!CAPTURE_PHOTO) imageAt.recipe = {};
    imageAt.lean = lean;
    let probed = _sharedNine?.probed ?? new Map();
    const seen = {get: q => { const o = probed?.get(q); return o && {scores: o.scores, ...(o.output && sameWriteEffort(o.output.effort, writerEffort) && {output: o.output})}; },
      set: (q, o) => probed?.set(q, o)};
    const makeLook = function* (b, lay, o, look = true, keep = true, wrap = null) {
      if (journal) return provider.lazy(b, lay, o, keep);
      if (!(typeof __RAPIER_JXL_CAPTURE_PHOTO__ !== 'undefined' && __RAPIER_JXL_CAPTURE_PHOTO__ === true) && (banded || offloading('score-band')) && b.rowsRecipe)
        return look ? yield* provider.lazyLook(b, lay, o, keep) : wrap ? wrap(provider.lazy(b, lay, o, keep)) : provider.lazy(b, lay, o, keep);
      return yield* planeLayoutSteps(b, width, height, lay, o, signal);
    };
    const shapes = function* (q, options, inPlaceDct = false) {
      const base = yield* provider.baseSteps(q, {keepPlanes: true}), lazy = journal || banded && !!base.rowsRecipe;
      const searched = lazy ? {layout: unpackLayout(yield* stage('whole-shapes', () => timedSteps('block-search', function* () {
        return packLayout(search.blocks !== planeSearchSteps ? (yield* search.blocks(base, width, height, options, signal)).layout
          : !CAPTURE_PHOTO && !journal && provider.onDevice() ? (yield* planeSearchSteps(base, width, height, options, signal, true)).layout
          : yield* planeSearchLayoutSteps(base, width, height, options, signal));
      }())))} : yield* search.blocks(base, width, height, options, signal);
      const layout = searched.layout, dctGab = base.rowsRecipe?.gaborish;
      let dctPack = null;
      if (inPlaceDct && lazy && !provider.onDevice() && base.planes && prepared.retain) {
        const rawPlanes = provider.takePlanes(q);
        if (rawPlanes) dctPack = packLayoutDct(rawPlanes, base.components[0].stride, base.components[0].rows, layout);
      }
      const at = memoAt(defer(function* (p) {
        const b = yield* provider.baseSteps(p, {keepPlanes: true});
        return yield* makeLook(dctPack && b.rowsRecipe?.gaborish === dctGab ? {...b, dctPack} : b, layout, options);
      }), q, searched.image);
      const origClear = at.clear;
      at.dropDct = () => { dctPack = null; origClear(); };
      if (!CAPTURE_PHOTO) at.recipe = {layout, options};
      return {at, image: lazy ? yield* at(q) : searched.image};
    };
    const layoutVarShare = (typeof __RAPIER_JXL_CAPTURE_PHOTO__ !== 'undefined' && __RAPIER_JXL_CAPTURE_PHOTO__ === true) ? null : lay => variableShare(lay, width, height);
    const gpuDz = asked >= 8;
    if (lexed) {
      lexerTurn = function* () {
        if ((typeof __RAPIER_JXL_TEACH__ === 'undefined' || __RAPIER_JXL_TEACH__ === true) && taught) taught({decision: 'lexer', effort: asked});
        const own = planFirst ? undefined : kept.find(c => c.bytes === bytes)?.quality ?? keptRecipe?.quality;
        const start = Math.max(1, Math.min(99.9, own !== undefined ? own - LEXER_UNDER : lexed.quality ?? leanStart(quality)));
        const lexAt = memoAt(defer(recipePicture(provider, lexed, pruneLayout(lexed.layout) ?? plainLayout(yield* provider.baseSteps(start, {keepPlanes: true})),
          {width, height, quality, journal, banded, signal})), NaN, null, keepWinningMemo ? 2 : 1);
        lexerDone = () => lexAt.clear();
        const slope = lexed.slope ?? SCORE_SLOPE, t = requested.ssimulacra2;
        let found = yield* probe(lexAt, start, planFirst ? PLAN_PROBES : LEXER_PROBES, null, null, {close: LEXER_CLOSE, aim: LEXER_AIM, slope, noRaise: !planFirst});
        let file = found.scores.ssimulacra2 >= t ? yield* writeImage(yield* lexAt(found.quality), asked) : null, libjxlScore;
        if (planFirst && file) {
          if (found.scores.doubt) found = {...found, scores: {...found.scores, ssimulacra2: yield* exactAt(lexAt, found.quality)(), doubt: undefined}};
          if (found.scores.ssimulacra2 >= t) {
            libjxlScore = yield* libjxlOfImage(yield* lexAt(found.quality), file);
            if (libjxlScore < t - SEARCH_BOUND - PLAN_AIM) {
              const aimed = t + (found.scores.ssimulacra2 - libjxlScore) - SEARCH_BOUND + PLAN_AIM, at = found.quality;
              requested.ssimulacra2 = aimed;
              let again;
              try { again = yield* probe(lexAt, Math.min(99.9, at + (aimed - found.scores.ssimulacra2) / slope), PLAN_AGAIN, null, null, {close: LEXER_CLOSE, aim: LEXER_AIM, slope}); }
              finally { requested.ssimulacra2 = t; }
              if (again.scores.ssimulacra2 >= aimed) {
                found = again; file = yield* writeImage(yield* lexAt(found.quality), asked); libjxlScore = undefined;
                if (found.scores.doubt) found = {...found, scores: {...found.scores, ssimulacra2: yield* exactAt(lexAt, found.quality)(), doubt: undefined}};
              }
            }
          }
          if (!(found.scores.ssimulacra2 >= t)) file = null;
        }
        if (file) {
          const smallest = kept.reduce((m, c) => Math.min(m, c.bytes?.length ?? Infinity), Math.min(bytes ? bytes.length : Infinity, closest?.bytes?.length ?? Infinity));
          if (file.length < smallest) {
            announce?.(file, found.scores.ssimulacra2);
            const at = found.quality;
            if ((typeof __RAPIER_JXL_TEACH__ === 'undefined' || __RAPIER_JXL_TEACH__ === true) && taught) taught({decision: 'whole', effort, intent: readingIntent, width, height, quality: at, bytes: file.length, score: found.scores.ssimulacra2});
            kept.push({bytes: file, score: found.scores.doubt ? exactAt(lexAt, at) : found.scores.ssimulacra2, quality: at, lexer: true,
              ...(planFirst && {redo: keptMore(lexAt, at, file, asked).redo}), ...(libjxlScore !== undefined && {libjxlScore}),
              ...(!CAPTURE_PHOTO && onRecipes && {recipe: {...lexed, quality: at}}),
              libjxl: function* () { return yield* libjxlOfImage(yield* lexAt(at), file); }});
          }
        }
        if ((typeof __RAPIER_JXL_TEACH__ === 'undefined' || __RAPIER_JXL_TEACH__ === true) && taught) taught({decision: 'lexer-end', effort: asked});
      };
      if (effort === 4) {
        if (planFirst) {
          const turn = lexerTurn;
          lexerTurn = null;
          try { yield* turn(); } finally { lexerDone?.(); lexerDone = null; }
          if (!kept.length) yield* ownFloor();
        }
        yield* settle(); yield* admit(); return bytes;
      }
    }
    if (lean) {
      writerEffort = leanWrite;
      yield 0.05 * leanPart;
      const useFastDz = !CAPTURE_PHOTO && deadzones && lean && (quality <= 85 || highDz) && !measureOutput && s2Admitted(plan, width, height);
      const canDeferPlain = !CAPTURE_PHOTO && !announce && !measureOutput && !journal && leanOnly && !alpha && !useFastDz && !_sharedNine && width * height > 16384;
      let plain = null, plainImg = null, plainPacked = null, qSeed = leanStart(quality), shapedAt = null;
      const savedLean = _sharedNine?.lean;
      if (savedLean && savedLean.useFastDz === !!useFastDz) {
        if (savedLean.useFastDz) {
          qSeed = savedLean.q0;
          if (!noFloor && (!leanOnly || alpha)) plain = yield* writtenNow(imageAt, yield* probe(imageAt, leanStart(quality), LEAN_PROBES, null, seen), leanWrite);
          yield 0.3 * leanPart;
          imageAt.clear();
          const {q0, layout, options, dzMap, oZoned} = savedLean, seedZonedImg = savedLean.zonedImg ?? null;
          savedLean.zonedImg = null;
          const baseQ0 = yield* provider.baseSteps(q0, {keepPlanes: true});
          zoned = !(readingIntent <= deadzones.threeScalesTo);
          shapedAt = memoAt(defer(function* (p) {
            const wantGentle = highDz && p >= 85, activeDz = highDz && p >= 98.5 ? null : dzMap;
            const oAt = wantGentle !== !!oZoned.gentleChromaDz || activeDz !== dzMap
              ? {...options, rated: false, ...(activeDz && {deadzoneMap: activeDz, ...(gpuDz && {gpuDeadzone: true})}), ...(wantGentle && {gentleChromaDz: true})}
              : oZoned;
            return yield* makeLook(p === q0 ? baseQ0 : yield* provider.baseSteps(p, {keepPlanes: true}), layout, oAt, gpuDz);
          }), seedZonedImg ? savedLean.zProbed.quality : NaN, seedZonedImg);
          if (!CAPTURE_PHOTO) shapedAt.recipe = {layout, options: oZoned};
          shapedAt.lean = true;
          yield 0.5 * leanPart;
          yield* keep(shapedAt, {...savedLean.zProbed}, leanWrite);
          shapedAt.clear();
          yield 0.8 * leanPart;
          if (!leanOnly && plain) yield* keep(imageAt, plain, leanWrite);
          else if (savedLean.keepPlain) yield* keep(imageAt, yield* probe(imageAt, leanStart(quality), LEAN_PROBES, null, seen), leanWrite);
          else if (!bytes) yield* keep(imageAt, yield* probe(imageAt, leanStart(quality), LEAN_PROBES, null, seen), leanWrite);
        } else {
          if (savedLean.plainImg) { const seedPlain = memoAt(defer(q => provider.image(q, {filter: 'gaborish'})), savedLean.plainFound.quality, savedLean.plainImg); savedLean.plainImg = null; plain = yield* writtenNow(seedPlain, {...savedLean.plainFound}, leanWrite); seedPlain.clear(); }
          else plain = yield* writtenNow(imageAt, {...savedLean.plainFound}, leanWrite);
          qSeed = plain.quality;
          yield 0.3 * leanPart;
          imageAt.clear();
          const {layout, options} = savedLean, seedShapedImg = savedLean.zonedImg ?? null;
          savedLean.zonedImg = null;
          shapedAt = memoAt(defer(function* (p) {
            return yield* makeLook(yield* provider.baseSteps(p, {keepPlanes: true}), layout, options);
          }), seedShapedImg ? savedLean.shapedFound.quality : NaN, seedShapedImg);
          if (!CAPTURE_PHOTO) shapedAt.recipe = {layout, options};
          shapedAt.lean = true;
          yield 0.5 * leanPart;
          yield* keep(shapedAt, {...savedLean.shapedFound}, leanWrite);
          shapedAt.clear();
          yield 0.8 * leanPart;
          yield* keep(imageAt, plain, leanWrite);
        }
      } else {
        if (useFastDz) {
          const seedNext = m => {
            const dSlope = highDz ? (readingIntent >= 0.92 && m < 0 ? 0.68 : 0.88) : quality >= 70 ? 1.15 : 0.82;
            const seedAim = highDz ? -0.04 : 0.02, qHigh = qSeed + (seedAim - m) / dSlope;
            const qNext = highDz && m > 1.5 && qHigh < 84.5
              ? Math.min(qSeed, 85) + (seedAim - (m - Math.max(0, qSeed - 85) * 0.88)) / 0.60
              : qHigh;
            return Math.max(1, Math.min(99, Math.round(qNext * 100) / 100));
          };
          let pObs = yield* measured((function* () { return yield* scoreOnly(yield* imageAt(qSeed), first); })(), journal ? measureSteps : measure, signal);
          const seedDoubt = pObs.scores.doubt?.ssimulacra2 ?? 0, mRaw = pObs.scores.ssimulacra2 - requested.ssimulacra2;
          if (seedDoubt > 0 && (seedNext(mRaw - seedDoubt) !== seedNext(mRaw + seedDoubt)
              || (highDz && ((mRaw - seedDoubt < 0 && mRaw + seedDoubt >= 0) || (mRaw - seedDoubt <= 1.5 && mRaw + seedDoubt > 1.5))))) {
            pObs = yield* measured((function* () { return yield* scoreOnly(yield* imageAt(qSeed), {...WANT_S2, exact: true}); })(), journal ? measureSteps : measure, signal);
          }
          if (highDz || !journal) seen.set(qSeed, pObs);
          qSeed = seedNext(pObs.scores.ssimulacra2 - requested.ssimulacra2);
          if (!noFloor && (!leanOnly || alpha)) plain = yield* writtenNow(imageAt, yield* probe(imageAt, leanStart(quality), LEAN_PROBES, null, seen), leanWrite);
        } else if (canDeferPlain) {
          plain = yield* probe(imageAt, qSeed, LEAN_PROBES, null, noFloor ? null : seen);
          qSeed = plain.quality;
          if (plain.scores.ssimulacra2 >= requested.ssimulacra2 && banded) {
            const pImg = yield* resolve(yield* imageAt(plain.quality));
            const pPacked = pImg?.lazyStrategy?.packed, fullPacked = pPacked?.length === Math.ceil(pImg.components[0].rows / 32) && pPacked.every(Boolean);
            if (prepared.retain && !fullPacked) plainPacked = pImg?.lazyStrategy ? packedPicture(pImg) : materialize(pImg);
            else if (!offloading('score-band')) plainImg = pImg;
          }
        } else {
          plain = yield* writtenNow(imageAt, yield* probe(imageAt, qSeed, LEAN_PROBES, null, (!noFloor || _sharedNine) ? seen : null), leanWrite);
          qSeed = plain.quality;
        }
        yield 0.3 * leanPart;
        imageAt.clear();
        let searched = yield* shapes(qSeed, {...blockOptions(), ...(highDz && qSeed >= 85 && {gentleChromaDz: true}), ...(useFastDz && {rated: true})}, canDeferPlain);
        shapedAt = searched.at;
        shapedAt.lean = true;
        if (useFastDz && shapedAt.recipe) {
          let {layout: rawLayout, options} = shapedAt.recipe, q0 = qSeed, basePic = searched.image;
          let layout = highDz ? pruneLayout(rawLayout) : rawLayout;
          let baseQ0 = yield* provider.baseSteps(q0, {keepPlanes: true});
          let keepPlain = highDz && layoutVarShare(layout) < 0.08;
          searched = null; shapedAt.clear();
          let zones = null, prevQ = 0, prevOver = 0;
          for (let pass = 0; ; pass++) {
            const zoned = picture => {
              const measure = picture.recipe && provided();
              if (typeof measure?.zoneSteps === 'function') picture.zoneSteps = yOnly => measure.zoneSteps(picture, yOnly);
              return picture;
            };
            const zonedAt = function* (map) {
              const o = {...options, deadzoneMap: map, rated: true, ...(gpuDz && {gpuDeadzone: true})};
              return yield* makeLook(baseQ0, layout, o, gpuDz, false, zoned);
            };
            const first = highDz ? yield* stage('whole-zones-first', function* () {
              return yield* deadzones(zonedAt, s2Ref, width, height, signal, 7, layout === rawLayout && basePic ? zoned(basePic) : null, readingIntent, q0, null, true);
            }) : null;
            const over = first ? first.score - requested.ssimulacra2 : 0;
            if (highDz && Math.abs(over) > 0.5 && pass < 2 && !(pass === 1 && Math.sign(over) === Math.sign(prevOver))) {
              const qNext = pass ? prevQ + (q0 - prevQ) * prevOver / (prevOver - over) : q0 - over / 0.75;
              prevQ = q0; prevOver = over; basePic = null;
              q0 = Math.max(1, Math.min(99, Math.round(qNext * 100) / 100));
              searched = yield* shapes(q0, {...blockOptions(), ...(q0 >= 85 && {gentleChromaDz: true}), rated: true});
              ({layout: rawLayout, options} = searched.at.recipe);
              basePic = searched.image; searched.at.clear(); searched = null;
              layout = pruneLayout(rawLayout); keepPlain = layoutVarShare(layout) < 0.08;
              baseQ0 = yield* provider.baseSteps(q0, {keepPlanes: true});
              continue;
            }
            zones = yield* stage('whole-zones', function* () {
              const made = yield* deadzones(zonedAt, s2Ref, width, height, signal, 7, first ? null : layout === rawLayout && basePic ? zoned(basePic) : null, readingIntent, q0, first);
              return {map: made, qShift: made.qShift, scoreZoned: made.scoreZoned, slope: made.slope};
            });
            break;
          }
          const dzMap = zones.map;
          if (!highDz && (zones.qShift ?? 0) > 0.1) keepPlain = true;
          zoned = !(readingIntent <= deadzones.threeScalesTo);
          const oZoned = {...options, rated: false, deadzoneMap: dzMap, ...(highDz && q0 >= 85 && {gentleChromaDz: true}), ...(gpuDz && {gpuDeadzone: true})};
          shapedAt = memoAt(defer(function* (p) {
            const wantGentle = highDz && p >= 85, activeDz = highDz && p >= 98.5 ? null : dzMap;
            const oAt = wantGentle !== !!oZoned.gentleChromaDz || activeDz !== dzMap
              ? {...options, rated: false, ...(activeDz && {deadzoneMap: activeDz, ...(gpuDz && {gpuDeadzone: true})}), ...(wantGentle && {gentleChromaDz: true})}
              : oZoned;
            return yield* makeLook(p === q0 ? baseQ0 : yield* provider.baseSteps(p, {keepPlanes: true}), layout, oAt, gpuDz);
          }));
          if (!CAPTURE_PHOTO) shapedAt.recipe = {layout, options: oZoned};
          shapedAt.lean = true;
          yield 0.5 * leanPart;
          const zSlope = zones.slope ?? 0.8;
          const qStart = highDz && Number.isFinite(zones.scoreZoned)
            ? Math.max(1, Math.min(99.5, Math.round((q0 + (0.028 - (zones.scoreZoned - requested.ssimulacra2)) / zSlope) * 100) / 100))
            : Math.max(1, Math.min(99.5, Math.round((q0 + (zones.qShift ?? 0.15)) * 100) / 100));
          const zOpts = highDz
            ? {aim: 0.022, lastAim: 0.04, close: 0.055, slope: zSlope}
            : {aim: 0.035, close: 0.08};
          const zProbed = yield* probe(shapedAt, qStart, 4, null, null, zOpts);
          if (!CAPTURE_PHOTO && (typeof __RAPIER_JXL_EFFORT_TEN__ === 'undefined' || __RAPIER_JXL_EFFORT_TEN__ === true) && onRecipes && shapedAt.recipe && zProbed?.quality !== undefined) leanShapedRecipe = {...shapedAt.recipe, quality: zProbed.quality};
          yield* keep(shapedAt, zProbed, leanWrite);
          if (zProbed.earlier && bytes && (yield* writeImage(yield* shapedAt(zProbed.earlier.quality), leanWrite)).length < bytes.length) yield* keep(shapedAt, zProbed.earlier, leanWrite);
          if (_sharedNine) _sharedNine.lean = {useFastDz: true, q0, layout, options, dzMap, oZoned, keepPlain, zProbed: {quality: zProbed.quality, scores: zProbed.quality !== undefined ? zProbed.scores : null, bestObserved: zProbed.bestObserved}, zonedImg: keepWinningMemo ? shapedAt.peek(zProbed.quality) : null};
          const zonedBytes = bytes;
          shapedAt.clear();
          yield 0.8 * leanPart;
          if (highDz && zonedBytes && zonedBytes.length * 8 < 0.15 * width * height) keepPlain = true;
          if (_sharedNine?.lean) _sharedNine.lean.keepPlain = keepPlain;
          const keepSmaller = function* (found) {
            const before = kept.length, held = bytes;
            yield* keep(imageAt, found, leanWrite);
            if (bytes === held && kept.length > before) kept.length = before;
          };
          if (keepPlain && !plain) {
            yield* keepSmaller(yield* probe(imageAt, leanStart(quality), LEAN_PROBES, null, seen));
            if (bytes !== zonedBytes) zoned = false;
          }
          else if ((!leanOnly || keepPlain) && plain) yield* (leanOnly ? keepSmaller(plain) : keep(imageAt, plain, leanWrite));
          else if (!bytes) yield* keep(imageAt, yield* probe(imageAt, leanStart(quality), LEAN_PROBES), leanWrite);
        } else {
          const initial = {v: {quality: plain.quality, image: searched.image, ...yield* qualify(searched.image, first)}};
          searched = null;
          yield 0.5 * leanPart;
          const keptBeforeShaped = kept.length;
          const sProbed = yield* probe(shapedAt, plain.quality, LEAN_PROBES, taken(initial));
          if (!CAPTURE_PHOTO && (typeof __RAPIER_JXL_EFFORT_TEN__ === 'undefined' || __RAPIER_JXL_EFFORT_TEN__ === true) && onRecipes && shapedAt.recipe && sProbed?.quality !== undefined) leanShapedRecipe = {...shapedAt.recipe, quality: sProbed.quality};
          yield* keep(shapedAt, sProbed, leanWrite);
          if (_sharedNine && shapedAt.recipe) _sharedNine.lean = {useFastDz: false, plainFound: {quality: plain.quality, scores: plain.scores, bestObserved: plain.bestObserved}, layout: shapedAt.recipe.layout, options: shapedAt.recipe.options, shapedFound: {quality: sProbed.quality, scores: sProbed.scores, bestObserved: sProbed.bestObserved}, zonedImg: keepWinningMemo ? shapedAt.peek(sProbed.quality) : null};
          shapedAt.clear();
          yield 0.8 * leanPart;
          let skipPlainWrite = false;
          if (canDeferPlain && plain.scores.ssimulacra2 >= requested.ssimulacra2 && kept.length === keptBeforeShaped + 1 && bytes) {
            const sEntry = kept[kept.length - 1], t = requested.ssimulacra2, floor = t - SEARCH_BOUND;
            if (typeof sEntry.score === 'function' && sEntry.score.begin && sEntry.libjxlScore === undefined) {
              yield* sEntry.score.begin();
              const libjxl = yield* sEntry.libjxl();
              sEntry.score = yield* sEntry.score();
              if (sEntry.score >= t) sEntry.libjxlScore = libjxl;
            }
            if (typeof sEntry.score === 'function') sEntry.score = yield* sEntry.score();
            if (sEntry.score >= t && sEntry.libjxlScore === undefined) sEntry.libjxlScore = yield* sEntry.libjxl();
            if (sEntry.score >= t && sEntry.libjxlScore >= floor) {
              if (!plainPacked) {
                const pImg = plainImg ?? (yield* resolve(yield* imageAt(plain.quality)));
                plainPacked = pImg?.lazyStrategy ? packedPicture(pImg) : materialize(pImg);
              }
              plainImg = null;
              imageAt.clear();
              const lb = plainLowerBoundBytes(plainPacked, leanWrite, sEntry.bytes.length);
              if (lb > sEntry.bytes.length) {
                plainPacked = null;
                kept.push({bytes: {length: lb}, score: plain.scores.doubt ? exactAt(imageAt, plain.quality) : plain.scores.ssimulacra2,
                  ...keptMore(imageAt, plain.quality, null, leanWrite)});
                skipPlainWrite = true;
              }
            }
          }
          plainImg = null;
          if (!skipPlainWrite) {
            if (canDeferPlain) {
              plain = plainPacked ? {...plain, output: {bytes: yield* writeImage(plainPacked, leanWrite), effort: leanWrite, unannounced: true}}
                : yield* writtenNow(imageAt, plain, leanWrite);
              plainPacked = null;
            }
            yield* keep(imageAt, plain, leanWrite);
            imageAt.clear();
          }
        }
        plainPacked = null;
      }
      if (alpha) {
        const unfilteredAt = memoAt(defer(q => provider.image(q, {filter: 'plain'})));
        if (!CAPTURE_PHOTO) unfilteredAt.recipe = {};
        const aProbed = savedLean?.alphaFound ? {...savedLean.alphaFound} : yield* probe(unfilteredAt, plain?.quality ?? qSeed, LEAN_PROBES);
        if (_sharedNine && !savedLean?.alphaFound) (_sharedNine.lean ??= {}).alphaFound = {quality: aProbed.quality, scores: aProbed.scores, bestObserved: aProbed.bestObserved};
        yield* keep(unfilteredAt, aProbed, leanWrite);
        unfilteredAt.clear();
      }
      check(signal);
      if (leanOnly) {
        yield* settle();
        shapedAt.dropDct ? shapedAt.dropDct() : shapedAt.clear();
        yield* admit();
        return bytes;
      }
      shapedAt.dropDct?.();
    }
    const fromLean = lean && asked === 8;
    const rung0 = Math.max(5, firstEffort), nineLean = lean && asked === 9;
    const rungAt = (rung, f) => nineLean ? 0.25 + 0.4 * (rung - rung0 + f) / (effort - rung0 + 1) : f;
    const late = nineLean ? {zones: [0.65, 0.85], settle: [0.85, 0.98]} : fromLean ? {zones: [0.45, 0.75], settle: [0.75, 0.98]} : null;
    let coarse = fromLean ? null : yield* probe(imageAt, quality, 6, null, seen);
    const shapeProbe = function* (q, ids, probes) {
      let searched = yield* shapes(q, blockOptions(ids));
      const at = searched.at, initial = {v: {quality: q, image: searched.image, ...yield* qualify(searched.image, first)}};
      searched = null;
      return [at, yield* probe(at, q, probes, taken(initial))];
    };
    let fine = null, block = null, blockAt = null, block16 = null, block16At = null;
    const knownField = !(typeof __RAPIER_JXL_CAPTURE_PHOTO__ !== 'undefined' && __RAPIER_JXL_CAPTURE_PHOTO__ === true) && !journal && !measureOutput && !preview ? {} : null;
    for (let rung = Math.max(5, firstEffort); !fromLean && rung <= effort; rung++) {
      writerEffort = rung;
      coarse = yield* keep(imageAt, coarse, rung);
      let best = coarse;
      if (rung >= 6) {
        fine ??= yield* probe(imageAt, quality, 12, null, seen);
        fine = yield* keep(imageAt, fine, rung);
        if (rung === effort) imageAt.clear();
        else if (keepWinningMemo) imageAt.keepOnly(coarse?.quality, fine?.quality);
        best = fine;
        if (!block16) {
          if (!keepWinningMemo) imageAt.clear();
          [block16At, block16] = yield* shapeProbe(best.quality, [4], 6);
        }
        block16 = yield* keep(block16At, block16, rung);
        if (rung === effort) block16At.clear();
        else if (keepWinningMemo) block16At.keepOnly(block16?.quality);
      }
      yield rungAt(rung, 0.3);
      if (rung >= 7) {
        if (!block) {
          if (!keepWinningMemo) { imageAt.clear(); block16At?.clear(); }
          [blockAt, block] = yield* shapeProbe(best.quality, undefined, 12);
        }
        block = yield* keep(blockAt, block, rung);
        if (rung === effort) blockAt.clear();
        else if (keepWinningMemo) blockAt.keepOnly(block?.quality);
        yield rungAt(rung, 0.6);
      }
      const rungQualify = CAPTURE_PHOTO || measureOutput ? probeQualify : preview ? qualify : function* (image, want) {
        return {scores: yield* scoreFile(null, image, want.exact ? want : {...want, doubt: true}), output: {effort: writerEffort}};
      };
      for (const [lv, cands, a0, a1] of [[8, ['field'], 0.6, 0.75], [9, search.candidates, 0.75, 1]]) if (rung >= lv) {
        const gabInit = lv === 9 && !journal && !measureOutput && !preview && fine
          ? {quality: fine.quality, scores: fine.scores, ...(fine.output?.effort === rung && fine.output.bytes && {output: fine.output, effort: rung, bytes: fine.output.bytes})}
          : null;
        const found = yield* reported(measured(search.score(provider, requested, {candidates: cands, effort: rung,
          start: best.quality, initial: gabInit, seen: !journal && !measureOutput && !preview ? seen : null, knownField,
          aq: search.aq, exactSize: true, measureSteps: rungQualify, libjxlOf: libjxlOfImage}), journal ? measureSteps : measure, signal), rungAt(rung, a0), rungAt(rung, a1));
        if (found?.pass) keepBytes(found.bytes, found.doubt ? exactOf(() => candidateImageSteps(provider, found.candidate, found.quality, found.decisions), found.bytes) : found.ssimulacra2,
          CAPTURE_PHOTO ? null : recipeOf(found), loopMore(found));
      }
    }
    if (knownField) knownField.fieldImage = null;
    imageAt.clear(); block16At?.clear(); blockAt?.clear();
    if (!_sharedNine) probed = null;
    const sameZoneRecipe = (a, b) => !!(a && b && a.quality === b.quality && a.field === b.field && a.layout === b.layout && a.options === b.options && a.transforms === b.transforms);
    const zoneRung = function* () {
    if (!CAPTURE_PHOTO && deadzones && pubEffort >= 8 && keptRecipe && !measureOutput && s2Admitted(plan, width, height)) {
      const zoneRecipe = keptRecipe;
      let dz8 = null;
      for (const zoneEffort of pubEffort >= 9 ? [8, 9] : [8]) {
        const {quality: q0, field, layout: rawLayout, options, transforms} = zoneRecipe;
        const layout = pruneLayout(rawLayout);
        const gentleChromaDz = quality > 85;
        let epfScale = 1.0;
        const make = (extra, keepBand = true, epfMul = 1.0) => function* (p) {
          let base = yield* provider.baseSteps(p, {keepPlanes: true, ...(field && {fieldScale: field})});
          if (epfMul !== 1.0 && base.epf) base = {...base, epf: base.epf * epfMul};
          const o = {...(options ?? provider.blockOptions(base)), ...(zoneEffort === 8 && quality <= 85 && {compactDct8: true, tableBands: 6, dct8Bands: 8}), ...(gentleChromaDz && {gentleChromaDz: true}), ...(transforms && {transforms}), gpuDeadzone: true, ...extra};
          const shape = layout ?? plainLayout(base);
          return journal ? provider.lazy(base, shape, o, keepBand) : (banded || offloading()) && base.rowsRecipe ? yield* provider.lazyLook(base, shape, o, keepBand) : yield* planeLayoutSteps(base, width, height, shape, o, signal);
        };
        if (zoneEffort === 8 && !journal && !preview && sameZoneRecipe(_sharedNine?.zone8?.recipe, zoneRecipe)) {
          const cached8 = _sharedNine.zone8;
          dz8 = cached8.deadzoneMap;
          const zonedAt = memoAt(defer(make({deadzoneMap: dz8}, true, 1.0)));
          if (!CAPTURE_PHOTO) zonedAt.recipe = {field, layout, ...((typeof __RAPIER_JXL_EFFORT_TEN__ === 'undefined' || __RAPIER_JXL_EFFORT_TEN__ === true) && {transforms, epfScale: 1.0, providerBlocks: !options}), options: {...(options ?? {}), ...(zoneEffort === 8 && quality <= 85 && {compactDct8: true, tableBands: 6, dct8Bands: 8}), deadzoneMap: dz8}};
          yield* keep(zonedAt, {...cached8.found}, 8);
          zonedAt.clear();
          continue;
        }
        const alreadyCompact = !!(options?.compactDct8 === true && options?.tableBands === 6 && options?.dct8Bands === 8);
        const reuseScale0 = zoneEffort >= 9 && !journal && dz8?.cells0 && (quality > 85 || alreadyCompact)
          ? {cells: dz8.cells0, rate: dz8.rates0, score: dz8.score0, norms: dz8.norms0, layout: dz8.layout0}
          : null;
        const deadzoneMap = yield* stage('whole-zones', function* () {
          return yield* deadzones(function* (map) { return yield* make({deadzoneMap: map, rated: true}, false)(q0); }, s2Ref, width, height, signal, zoneEffort, null, 0, 0, reuseScale0);
        });
        if (zoneEffort === 8) dz8 = deadzoneMap;
        const zTight = zoneEffort >= 9 ? (quality > 85 ? {aim: 0.018, lastAim: 0.032, close: 0.045} : {aim: 0.012, lastAim: 0.024, close: 0.028}) : {aim: 0.018, lastAim: 0.032, close: 0.042};
        let initPic = null, initObs = null;
        if (zoneEffort >= 9) {
          let bestEpfS2 = -Infinity, basePic1 = null;
          for (const em of [1.0, 0.74, 1.24]) {
            const ePic = !journal && !measureOutput && basePic1 && !basePic1.lazyStrategy && !basePic1.recipe
              ? {...basePic1, epf: basePic1.epf ? basePic1.epf * em : basePic1.epf, lookTag: undefined}
              : yield* make({deadzoneMap}, true, em)(q0);
            if (em === 1.0) basePic1 = ePic;
            const eObs = yield* measured((function* () { return yield* scoreOnly(ePic, em === 1.0 ? {...WANT_S2, exact: true} : {...WANT_S2, exact: true, minScore: bestEpfS2 + 0.020000000001}); })(), journal ? measureSteps : measure, signal);
            if (eObs.scores.ssimulacra2 > bestEpfS2 + (em === 1.0 ? 0 : 0.02)) {
              bestEpfS2 = eObs.scores.ssimulacra2; epfScale = em; initPic = ePic; initObs = eObs;
            }
          }
        }
        const zonedAt = memoAt(defer(make({deadzoneMap}, true, epfScale)), !journal && !measureOutput && initPic ? q0 : NaN, !journal && !measureOutput ? initPic : null);
        if (!CAPTURE_PHOTO) zonedAt.recipe = {field, layout, ...((typeof __RAPIER_JXL_EFFORT_TEN__ === 'undefined' || __RAPIER_JXL_EFFORT_TEN__ === true) && {transforms, epfScale, providerBlocks: !options}), options: {...(options ?? {}), ...(zoneEffort === 8 && quality <= 85 && {compactDct8: true, tableBands: 6, dct8Bands: 8}), deadzoneMap}};
        const image = yield* zonedAt(q0);
        const firstZoned = !journal && !measureOutput && initObs && !initObs.scores.doubt
          ? {scores: initObs.scores, output: {effort: writerEffort}}
          : yield* qualify(image, first);
        const zonedMap = !journal && !measureOutput && !preview && zoneEffort >= 9 && quality <= 85 && alreadyCompact ? new Map() : null;
        const zonedSeen = zonedMap && {get: q => { const o = zonedMap.get(q); return o && {scores: o.scores}; }, set: (q, o) => zonedMap.set(q, o)};
        if (zonedMap) zonedMap.set(q0, firstZoned);
        let zFound = yield* keep(zonedAt, yield* probe(zonedAt, q0, zoneEffort >= 9 ? 10 : 6, {quality: q0, image, ...firstZoned}, zonedSeen, zTight), zoneEffort);
        if (zoneEffort === 8 && _sharedNine && !journal && !preview) _sharedNine.zone8 = {recipe: zoneRecipe, deadzoneMap, found: zFound};
        let bestCompact = zoneEffort === 8 && quality <= 85;
        if (zoneEffort >= 9 && quality <= 85 && zonedMap && zFound?.output?.bytes && zFound.scores.doubt?.ssimulacra2 > 0) {
          const zGap = zFound.scores.ssimulacra2 - requested.ssimulacra2, zDoubt = zFound.scores.doubt.ssimulacra2;
          if (Math.abs(zGap - zTight.close) <= zDoubt || Math.abs(zGap) <= zDoubt) {
            const exactZ = yield* scoreFile(null, yield* zonedAt(zFound.quality), {...WANT_S2, exact: true});
            zFound = {...zFound, scores: exactZ};
            zonedMap.set(zFound.quality, {scores: exactZ, output: zFound.output});
          }
        }
        zonedAt.clear();
        if (zoneEffort >= 9 && quality <= 85) {
          const cStart = zFound?.quality ?? q0;
          const skipCompact = zonedMap && zFound?.scores.ssimulacra2 >= requested.ssimulacra2 && zFound.scores.ssimulacra2 - requested.ssimulacra2 < zTight.close && zFound.output?.bytes;
          if (!skipCompact) {
            const compactAt = memoAt(defer(make({deadzoneMap, compactDct8: true, tableBands: 6, dct8Bands: 8}, true, epfScale)));
            if (!CAPTURE_PHOTO) compactAt.recipe = {field, layout, ...((typeof __RAPIER_JXL_EFFORT_TEN__ === 'undefined' || __RAPIER_JXL_EFFORT_TEN__ === true) && {transforms, epfScale, providerBlocks: !options}), options: {...(options ?? {}), deadzoneMap, compactDct8: true, tableBands: 6, dct8Bands: 8}};
            const prevBytes = bytes;
            let cProbed = yield* probe(compactAt, cStart, 7, null, zonedSeen, zTight);
            if (zonedMap && cProbed.quality === zFound?.quality && zFound?.output?.effort === zoneEffort && zFound.output.bytes)
              cProbed = {...cProbed, output: zFound.output};
            const cFound = yield* keep(compactAt, cProbed, zoneEffort);
            if (bytes !== prevBytes) { zFound = cFound; bestCompact = true; }
            compactAt.clear();
          }
        }
      }
    }
    };
    yield* late ? reported(zoneRung(), ...late.zones) : zoneRung();
    if (late) yield late.zones[1];
    check(signal);
    yield* late ? reported(settle(), ...late.settle) : settle();
    yield* admit();
    if ((typeof __RAPIER_JXL_EFFORT_TEN__ === 'undefined' || __RAPIER_JXL_EFFORT_TEN__ === true) && onRecipes && bytes) onRecipes(bytes, keptRecipe, leanShapedRecipe);
    return bytes;
  } catch (error) { failed = true; throw error; }
  finally {
    let cleanupFailed = false, cleanupError;
    try { release?.(); } catch (error) { cleanupFailed = true; cleanupError = error; }
    try { if (_sharedNine?.rebuilt !== rebuilt) rebuilt?.destroy(); } catch (error) { if (!cleanupFailed) { cleanupFailed = true; cleanupError = error; } }
    if (!failed && cleanupFailed) throw cleanupError;
  }
}

export const lowPlanPictureSteps = CAPTURE_PHOTO ? null : function* (prepared, plan, quality, signal) {
  const shape = pruneLayout(plan.layout);
  if (!shape) return null;
  const {provider, release} = wholeProvider(prepared, signal, false, true), {width, height} = prepared;
  return {image: yield* recipePicture(provider, plan, shape, {width, height, quality, journal: false, banded: true, signal})(quality), release};
};
