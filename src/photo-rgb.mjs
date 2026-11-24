// SPDX-License-Identifier: MIT
import {stage, carried, PASSED, journalRequest} from './step-journal.mjs';
import {complete} from './bits.mjs';
import {rgbCoefficientSteps, photoCoefficientSteps, photoQualityStep, areaFieldBase} from './photo-dct.mjs';
import {quantFieldValue, quantFieldBase} from './vardct-planes.mjs';
import {fixedStrategyImage} from './varblock-core.mjs';
import {plainLayout, planeLayoutSteps as layoutImage} from './photo-plane-levels.mjs';
import {photoMeasuredSteps, spannedSteps} from './photo-measured-steps.mjs';
import {gcPlaneBound} from './gpu-arithmetic.mjs';
import {qualitySteps} from './photo-quality-search.mjs';
import {cpuMeasure} from './photo-measure.mjs';
import {writeImageSteps} from './photo-image-write.mjs';
import {pageFrameSteps} from './photo-frame-bands.mjs';
import {gammaPicture, linearPicture, pictureOutputs, cropGuard, qualifyPhotoImage} from './photo-region-score.mjs';
import {P3_TRANSFORM} from './color-transform.mjs';
import {photoReference} from './photo-reference.mjs';
import {fault} from './fault.mjs';


const check = signal => { if (signal?.aborted) throw signal.reason; };
const LEVEL = [0.65, 0.65, 0.5, 0.5, 0.65, 0.65];

function fillRGBPhotoPlanes(pixels, width, height, stride, planes, from, to, ycbcr = false) {
  const W = stride * 8;
  for (let at = from, y = Math.floor(from / W); at < to; y++) {
    const end = Math.min(to, (y + 1) * W);
    for (let x = at - y * W; at < end; x++, at++) {
      const p = (Math.min(height - 1, y) * width + Math.min(width - 1, x)) * 4;
      const r = pixels[p], g = pixels[p + 1], b = pixels[p + 2];
      if (ycbcr) {
        planes[0][at] = -0.168735892 * r - 0.331264108 * g + 0.5 * b;
        planes[1][at] = 0.299 * r + 0.587 * g + 0.114 * b - 128;
        planes[2][at] = 0.5 * r - 0.418687589 * g - 0.081312411 * b;
      } else {
        planes[0][at] = r - g; planes[1][at] = g; planes[2][at] = b - g;
      }
    }
  }
}
const rgbPhotoUnit = (areas, quality) => quantFieldBase(16, areaFieldBase(areas, quality, 'regions', areas?.some(a => a.quality !== quality)).peak);
function fillRGBPhotoScaledFields(source, fields, from, to, unit = 16) {
  for (let at = from; at < to; at++) fields[at] = source[at] * unit;
  return fields;
}
function rgbPhotoBlockBase(plain, planes, quantFields, planeBound, unit = 16) {
  const ordered = plain.ycbcr ? [1, 0, 2].map(i => plain.components[i]) : plain.components;
  return {...plain, ...(plain.ycbcr && {frameOrder: true}), quantScale: 16 * unit, quantFieldBase: (plain.quantFieldBase || 2) * unit, planes, planeBound, quantFields,
    components: ordered.map(c => ({...c, quant: Float64Array.from(c.quant, q => q * unit)}))};
}
function plainCoefficients(pixels, width, height, quality, colorSpace, areas, ycbcr, crops) {
  return complete(ycbcr ? photoCoefficientSteps(pixels, width, height, quality, colorSpace, false, true, areas, {crops})
    : rgbCoefficientSteps(pixels, width, height, quality, colorSpace, areas));
}
function blockBase(pixels, width, height, plain, unit) {
  const stride = plain.components[0].stride, rows = plain.components[0].rows, W = stride * 8, H = rows * 8;
  const planes = [0, 1, 2].map(() => new Float64Array(W * H));
  fillRGBPhotoPlanes(pixels, width, height, stride, planes, 0, W * H, plain.ycbcr === true);
  const planeBound = gcPlaneBound(planes);
  const fields = plain.quantFields && fillRGBPhotoScaledFields(plain.quantFields, new Uint16Array(plain.quantFields.length), 0, plain.quantFields.length, unit);
  return {...rgbPhotoBlockBase(plain, planes, fields, planeBound, unit), planeRows: () => ({planes, top: 0, stride: W}), devicePlanes: {}};
}

function rgbPhotoFieldBlock(fields, stride, bx, by, bw, bh) {
  const q = fields[by * stride + bx];
  for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) if (fields[(by + y) * stride + bx + x] !== q) return false;
  return true;
}
function fieldAdmission(base) {
  const fields = ('photoBoundaries' in base ? base.photoBoundaries : base.quantFields), stride = base.components[0].stride;
  return !fields ? undefined : (_id, bx, by, bw, bh) => rgbPhotoFieldBlock(fields, stride, bx, by, bw, bh);
}

const blockOptions = base => ({perceptual: true, tableBands: 8, deadzone: LEVEL, model: 'simple', rate: [1, 3, 2, 0.6],
  lambda: 0.28, sizeScale: 1.03, ids: [4, 5, 6, 7], validBlock: fieldAdmission(base)});

function fillRGBPhotoQualityFields(original, active, scale, fieldScale, fields, from, to) {
  for (let i = from; i < to; i++) {
    const v = original[i];
    fields[i] = quantFieldValue(v * (active[i] ? scale * (fieldScale?.[i] ?? 1) : 1));
  }
  return fields;
}

function rgbProvider(pixels, width, height, plain, {quality, colorSpace, active, signal, ans, scoreScope, unit}) {
  const canonical = blockBase(pixels, width, height, plain, unit), original = canonical.quantFields ?? new Uint16Array(canonical.components[0].stride * canonical.components[0].rows).fill(canonical.quantFieldBase);
  const boundaries = canonical.quantFields, layout = plainLayout(canonical), written = new WeakMap();
  const make = (q, {fieldScale, keepPlanes} = {}) => {
    check(signal);
    const scale = photoQualityStep(quality, 'regions') / photoQualityStep(q, 'regions');
    const fields = fillRGBPhotoQualityFields(original, active, scale, fieldScale, new Uint16Array(original.length), 0, original.length);
    const base = {...canonical, quantFields: fields, photoBoundaries: boundaries};
    if (keepPlanes) return base;
    return fixedStrategyImage(base, width, height, {...blockOptions(base), layout}).image;
  };
  const provider = {width, height, base: make,
    blockOptions: base => ({...blockOptions(base), perceptual: false}),
    *image(q, options) {
      const base = make(q, {...options, keepPlanes: true}), settings = blockOptions(base);
      const image = yield* layoutImage(base, width, height, layout, settings, signal);
      scoreScope?.register(image, settings.deadzone);
      return image;
    },
    *layout(base, chosen, options) { return yield* layoutImage(base, width, height, chosen, options, signal); },
    *write(image, effort) {
      const bytes = yield* writeImageSteps(image, effort);
      written.set(bytes, image); return bytes;
    },
    estimate() { throw fault('JXL_INTERNAL', 'photo-rgb:estimate'); },
  };
  return {provider, written, canonical};
}
function rgbPhotoActiveBounds(r, width, height) {
  const x0 = Math.max(0, Math.floor(r.x)), x1 = Math.min(width, Math.ceil(r.x + r.width));
  const y0 = Math.max(0, Math.floor(r.y)), y1 = Math.min(height, Math.ceil(r.y + r.height));
  return {x0, x1, y0, y1};
}
function fillRGBPhotoActiveCells(active, width, bounds, exact, pixels, mask, from, to) {
  const {x0, x1, y0, y1} = bounds, stride = Math.ceil(width / 8);
  const bx0 = Math.floor(x0 / 8), by0 = Math.floor(y0 / 8), columns = Math.max(0, Math.ceil(x1 / 8) - bx0);
  for (let at = from; at < to; at++) {
    const by = by0 + Math.floor(at / columns), bx = bx0 + at % columns, cell = by * stride + bx;
    if (active[cell]) continue;
    for (let y = Math.max(y0, by * 8); y < Math.min(y1, by * 8 + 8) && !active[cell]; y++)
      for (let x = Math.max(x0, bx * 8); x < Math.min(x1, bx * 8 + 8); x++) {
        const p = y * width + x;
        if (!exact?.[p] && (!mask || pixels[p * 4 + 3] >= 128)) { active[cell] = 1; break; }
      }
  }
}
function activeCells(width, height, crops, exact, pixels, mask) {
  const stride = Math.ceil(width / 8), rows = Math.ceil(height / 8), active = new Uint8Array(stride * rows);
  for (const r of crops?.length ? crops : [{x: 0, y: 0, width, height}]) {
    const bounds = rgbPhotoActiveBounds(r, width, height), {x0, x1, y0, y1} = bounds;
    const count = Math.max(0, Math.ceil(x1 / 8) - Math.floor(x0 / 8)) * Math.max(0, Math.ceil(y1 / 8) - Math.floor(y0 / 8));
    fillRGBPhotoActiveCells(active, width, bounds, exact, pixels, mask, 0, count);
  }
  return active;
}
function* rgbPhotoBandSteps(pixels, width, height, {quality, colorSpace, areas, ycbcr = false, effort = 7, signal,
  reference = pixels, project = null, crops = areas, exact = null, mask = false, ans = null, origin = {x: 0, y: 0}, photoSearch = null, scoreScope = null} = {}) {
  check(signal);
  if (effort >= 6 && !photoSearch?.blocks) throw fault('JXL_INTERNAL', 'photo-rgb:search');
  const measured = photoSearch?.measured ?? photoMeasuredSteps;
  const plain = plainCoefficients(pixels, width, height, quality, colorSpace, areas, ycbcr, crops);
  const active = activeCells(width, height, crops, exact, pixels, mask), {provider, written, canonical} = rgbProvider(pixels, width, height, plain,
    {quality, colorSpace, active, signal, ans, scoreScope, unit: rgbPhotoUnit(areas, quality)});
  try { return yield* rgbPhotoSearchSteps(provider, written, canonical, plain, active, pixels, width, height,
    {quality, colorSpace, effort, signal, reference, project, exact, mask, origin, photoSearch, scoreScope, measured}); }
  finally { canonical.devicePlanes.release?.(); }
}
function* rgbPhotoSearchSteps(provider, written, canonical, plain, active, pixels, width, height,
  {quality, colorSpace, effort, signal, reference, project, exact, mask, origin, photoSearch, scoreScope, measured}) {
  let floor = effort >= 6 ? yield* photoSearch.blocks(canonical, width, height, blockOptions(canonical), signal)
    : {image: yield* provider.image(quality, {filter: 'plain'})};
  if (effort === 6 || effort === 7 || !active.some(Boolean)) return {...floor, plain};
  let rebuilt = null;
  const gammaOf = image => (rebuilt?.image === image ? rebuilt : rebuilt = {image, planes: gammaPicture(image, {reference, exact, pixels, mask})}).planes;
  const toLinear = image => linearPicture(image, {colorSpace, reference, exact, pixels, mask, project}, gammaOf(image));
  const cpu = cpuMeasure(reference, width, height, {native: true, immutable: true, reconstruct: toLinear,
    reference: colorSpace === 'display-p3' ? () => photoReference(reference, width, height, P3_TRANSFORM) : null,
    rgbaOutputs: image => pictureOutputs(image, {colorSpace, reference, exact, pixels, mask}, origin, gammaOf(image)),
    cacheBytes: Math.min(16 << 20, width * height * 48)});
  const measure = (image, want) => scoreScope ? scoreScope.score(image, want, cpu) : cpu(image, want);
  try {
    const own = measure(floor.image, {ssimulacra2: true, butteraugli: false});
    const ownBytes = yield* provider.write(floor.image, effort);
    if (effort < 7) {
      const best = yield* measured(qualitySteps(q => provider.image(q, {filter: 'plain'}), {ssimulacra2: own.ssimulacra2},
        {start: quality, low: 1, high: 99, probes: effort === 5 ? 6 : 12, initial: {quality, image: floor.image, scores: own}}), measure, signal);
      if (best.quality !== quality && best.scores.ssimulacra2 >= own.ssimulacra2) {
        const image = yield* provider.image(best.quality, {filter: 'plain'}), bytes = yield* provider.write(image, effort);
        if (bytes.length < ownBytes.length) floor = {image, candidate: 'plain', quality: best.quality};
      }
    } else {
      const found = yield* measured(photoSearch.score(provider, {ssimulacra2: own.ssimulacra2 + 0.04}, {
        candidates: effort >= 9 ? ['plain', 'blocks', 'field', 'closed'] : ['field'],
        effort, start: quality, aq: {...photoSearch.aq, active}, exactSize: true,
      }), measure, signal);
      if (found?.pass && found.bytes.length < ownBytes.length) floor = {image: written.get(found.bytes), candidate: found.candidate, quality: found.quality};
    }
    return {...floor, plain};
  } finally { cpu.destroy(); rebuilt = null; }
}

function imageRecipe(image) {
  const layout = new Uint32Array(image.strategyData.blocks.length * 3);
  image.strategyData.blocks.forEach(({id, bx, by}, i) => layout.set([id, bx, by], i * 3));
  return {layout, fields: image.quantFields?.slice(), perceptual: image.perceptual === true};
}
function rebuildImage(pixels, width, height, options, recipe) {
  const plain = plainCoefficients(pixels, width, height, options.quality, options.colorSpace, options.areas, options.ycbcr === true, options.crops);
  const base = blockBase(pixels, width, height, plain, rgbPhotoUnit(options.areas, options.quality));
  base.photoBoundaries = base.quantFields;
  if (recipe.fields) base.quantFields = recipe.fields;
  const layout = Array.from({length: recipe.layout.length / 3}, (_, i) =>
    ({id: recipe.layout[i * 3], bx: recipe.layout[i * 3 + 1], by: recipe.layout[i * 3 + 2]}));
  return fixedStrategyImage(base, width, height, {...blockOptions(base), perceptual: recipe.perceptual, layout}).image;
}

const GUARD_FAILED = Symbol('crop guard failed');
export function* regionPhotoFrameSteps(rows, width, height, options) {
  const {photoBlockEffort: effort = 7, readingIntent, readingLook, readingArithmetic, signal, photoCrops, referenceRows = rows, exactRows = null,
    project = null, photoAdmission = null, photoSearch = null, floorImage = null, floorBytes = null, photoScoreMemo = null, ...frame} = options;
  const origin = {x: frame.placement?.crop?.x ?? 0, y: frame.placement?.crop?.y ?? 0}, ycbcr = !frame.placement?.patches;
  const writerEffort = Math.max(effort, frame.effort ?? effort);
  const memoFrame = photoScoreMemo?.frame(rows, width, height, options);
  if (floorImage) {
    const result = qualifyPhotoImage(floorImage, {rows, referenceRows, exactRows, crops: photoCrops ?? frame.areas,
      readingIntent, readingLook, readingArithmetic, mask: frame.placement?.mask === true, project, signal, colorSpace: frame.colorSpace, origin});
    check(signal); photoAdmission?.record(floorBytes, result.passed, result.measurements); return floorBytes;
  }
  const newGuard = () => cropGuard(width, height, photoCrops ?? frame.areas, readingIntent,
    frame.placement?.mask === true, project, signal, frame.colorSpace, origin, readingLook, readingArithmetic);
  const observe = guard => Object.assign((image, pixels, top) => guard.add(pixels, image, image, top,
    referenceRows(top, image.height), exactRows?.(top, image.height)), {state: guard.state, restore: guard.restore});
  if (effort === 4) {
    const guard = newGuard();
    const bytes = yield* pageFrameSteps(rows, width, height, {...frame, ycbcr, crops: photoCrops, observeBand: observe(guard)});
    check(signal); photoAdmission?.record(bytes, guard.complete(), guard.measurements()); return bytes;
  }
  const guard = newGuard(), recipes = new Map();
  const strategy = {*band(pixels, w, h, info) {
    if (info.again) {
      const recipe = recipes.get(info.top);
      if (!recipe) throw fault('JXL_INTERNAL', 'photo-rgb:recipe');
      return rebuildImage(pixels, w, h, info, recipe);
    }
    const source = pixels.slice(), reference = referenceRows(info.top, h).slice(), exact = exactRows?.(info.top, h);
    const crops = (photoCrops ?? frame.areas)?.map(r => ({...r, y: r.y - info.top}));
    let result = null;
    const recipe = yield* stage('photo-band', function* () {
      const scoreScope = memoFrame?.band(info.top, w, h);
      try {
        result = yield* rgbPhotoBandSteps(source, w, h, {...info, effort, signal, reference, crops, photoSearch, scoreScope,
          exact, mask: frame.placement?.mask === true,
          project: project && (rgba => project(rgba, info.top)), ans: frame.placement?.ans,
          origin: {x: origin.x, y: origin.y + info.top}});
        return imageRecipe(result.image);
      } finally { scoreScope?.release(); }
    }, undefined, true);
    result ??= {image: rebuildImage(source, w, h, info, recipe), plain: null};
    recipes.set(info.top, recipe);
    made = {image: result.image, plain: result.plain, source, reference, exact, info: {...info, width: w, height: h}};
    return result.image;
  },
  summary: image => ({recipe: imageRecipe(image)}),
  *after(image, top, full) {
    const band = made?.image === image ? made : null;
    made = null;
    if (!recipes.has(top)) recipes.set(top, image.extra?.recipe ?? imageRecipe(image));
    const saved = yield* carried('crop-guard', () => {
      const h = image.height, info = band?.info ?? {width, height: h, quality: frame.quality, colorSpace: frame.colorSpace, ycbcr,
        areas: frame.areas?.map(a => ({...a, y: a.y - top})), crops: photoCrops?.map(c => ({...c, y: c.y - top}))};
      const source = band?.source ?? rows(top, h).slice(), picture = band ? image : full();
      const plain = band?.plain ?? plainCoefficients(source, info.width, info.height, info.quality, info.colorSpace, info.areas, ycbcr, info.crops);
      guard.add(source, picture, plain, top, band?.reference ?? referenceRows(top, h).slice(), band ? band.exact : exactRows?.(top, h));
      return guard.state();
    });
    if (saved !== PASSED) guard.restore(saved);
    if (!guard.passed()) throw GUARD_FAILED;
  }};
  let made = null;
  let step, reply;
  const candidate = pageFrameSteps(rows, width, height, {...frame, effort: writerEffort, ycbcr, crops: photoCrops, strategy});
  try {
    while (!(step = candidate.next(reply)).done) {
      if (!guard.passed() && !journalRequest(step.value)) break;
      reply = yield typeof step.value === 'number' ? step.value * 0.95 : step.value;
    }
  } catch (error) { if (error !== GUARD_FAILED) throw error; } finally { candidate.return?.(); }
  check(signal);
  if (step.done && guard.complete()) { photoAdmission?.record(step.value, true, guard.measurements()); return step.value; }
  const fallbackGuard = newGuard();
  const bytes = yield* spannedSteps(pageFrameSteps(rows, width, height, {...frame, ycbcr, crops: photoCrops, observeBand: observe(fallbackGuard)}), 0.95, 1);
  check(signal); photoAdmission?.record(bytes, fallbackGuard.complete(), fallbackGuard.measurements()); return bytes;
}
