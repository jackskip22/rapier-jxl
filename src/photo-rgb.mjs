// SPDX-License-Identifier: MIT
import {complete} from './bits.mjs';
import {rgbCoefficientSteps, photoQualityStep} from './photo-dct.mjs';
import {fixedStrategyImage} from './varblock-core.mjs';
import {plainLayout, planeLayoutSteps as layoutImage} from './photo-plane-levels.mjs';
import {photoMeasuredSteps} from './photo-measured-steps.mjs';
import {gcPlaneBound} from './gpu-arithmetic.mjs';
import {qualitySteps} from './photo-quality-search.mjs';
import {cpuMeasure} from './photo-measure.mjs';
import {writeImageSteps} from './photo-image-write.mjs';
import {pageFrameSteps} from './photo-frame-bands.mjs';
import {linearPicture, pictureOutputs, cropGuard, qualifyPhotoImage} from './photo-region-score.mjs';
import {P3_TRANSFORM} from './color-transform.mjs';
import {photoReference} from './photo-reference.mjs';

export {imageRecipe as rgbImageRecipe};

const check = signal => { if (signal?.aborted) throw signal.reason; };
const LEVEL = [0.65, 0.65, 0.5, 0.5, 0.65, 0.65];

export function fillRGBPhotoPlanes(pixels, width, height, stride, planes, from, to) {
  const W = stride * 8;
  for (let at = from, y = Math.floor(from / W); at < to; y++) {
    const end = Math.min(to, (y + 1) * W);
    for (let x = at - y * W; at < end; x++, at++) {
      const p = (Math.min(height - 1, y) * width + Math.min(width - 1, x)) * 4, g = pixels[p + 1];
      planes[0][at] = pixels[p] - g; planes[1][at] = g; planes[2][at] = pixels[p + 2] - g;
    }
  }
}
export function fillRGBPhotoScaledFields(source, fields, from, to) {
  for (let at = from; at < to; at++) fields[at] = source[at] * 16;
  return fields;
}
export function rgbPhotoBlockBase(plain, planes, quantFields, planeBound) {
  return {...plain, quantScale: 256, quantFieldBase: (plain.quantFieldBase || 2) * 16, planes, planeBound, quantFields,
    components: plain.components.map(c => ({...c, quant: Float64Array.from(c.quant, q => q * 16)}))};
}
function blockBase(pixels, width, height, plain) {
  const stride = plain.components[0].stride, rows = plain.components[0].rows, W = stride * 8, H = rows * 8;
  const planes = [0, 1, 2].map(() => new Float64Array(W * H));
  fillRGBPhotoPlanes(pixels, width, height, stride, planes, 0, W * H);
  const planeBound = gcPlaneBound(planes);
  const fields = plain.quantFields && fillRGBPhotoScaledFields(plain.quantFields, new Uint16Array(plain.quantFields.length), 0, plain.quantFields.length);
  return {...rgbPhotoBlockBase(plain, planes, fields, planeBound), planeRows: () => ({planes, top: 0, stride: W})};
}

export function rgbPhotoFieldBlock(fields, stride, bx, by, bw, bh) {
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

export {blockOptions as rgbPhotoBlockOptions};
export function fillRGBPhotoQualityFields(original, active, scale, fieldScale, fields, from, to) {
  for (let i = from; i < to; i++) {
    const v = original[i];
    fields[i] = Math.max(1, Math.min(65535, Math.round(v * (active[i] ? scale * (fieldScale?.[i] ?? 1) : 1))));
  }
  return fields;
}

function rgbProvider(pixels, width, height, plain, {quality, colorSpace, active, signal, ans, scoreScope}) {
  const canonical = blockBase(pixels, width, height, plain), original = canonical.quantFields ?? new Uint16Array(canonical.components[0].stride * canonical.components[0].rows).fill(canonical.quantFieldBase);
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
    estimate() { throw new Error('The RGB photo engine compares written frames.'); },
  };
  return {provider, written, canonical};
}
export function rgbPhotoActiveBounds(r, width, height) {
  const x0 = Math.max(0, Math.floor(r.x)), x1 = Math.min(width, Math.ceil(r.x + r.width));
  const y0 = Math.max(0, Math.floor(r.y)), y1 = Math.min(height, Math.ceil(r.y + r.height));
  return {x0, x1, y0, y1};
}
export function fillRGBPhotoActiveCells(active, width, bounds, exact, pixels, mask, from, to) {
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
export function* rgbPhotoBandSteps(pixels, width, height, {quality, colorSpace, areas, effort = 7, signal,
  reference = pixels, project = null, crops = areas, exact = null, mask = false, ans = null, origin = {x: 0, y: 0}, photoSearch = null, scoreScope = null} = {}) {
  check(signal);
  if (effort >= 7 && !photoSearch?.blocks) throw new Error('The photographic transform search is unavailable.');
  const measured = photoSearch?.measured ?? photoMeasuredSteps;
  const plain = complete(rgbCoefficientSteps(pixels, width, height, quality, colorSpace, areas));
  const active = activeCells(width, height, crops, exact, pixels, mask), {provider, written, canonical} = rgbProvider(pixels, width, height, plain,
    {quality, colorSpace, active, signal, ans, scoreScope});
  let floor = effort >= 7 ? yield* photoSearch.blocks(canonical, width, height, blockOptions(canonical), signal)
    : {image: yield* provider.image(quality, {filter: 'plain'})};
  if (effort === 7 || !active.some(Boolean)) return {...floor, plain};
  const toLinear = image => linearPicture(image, {colorSpace, reference, exact, pixels, mask, project});
  const cpu = cpuMeasure(reference, width, height, {native: true, immutable: true, reconstruct: toLinear, maps: 's2',
    reference: colorSpace === 'display-p3' ? () => photoReference(reference, width, height, P3_TRANSFORM) : null,
    rgbaOutputs: image => pictureOutputs(image, {colorSpace, reference, exact, pixels, mask}, origin),
    cacheBytes: Math.min(16 << 20, width * height * 48)});
  const measure = (image, want) => scoreScope ? scoreScope.score(image, want, cpu) : cpu(image, want);
  try {
    const own = measure(floor.image, {ssimulacra2: true, butteraugli: false});
    const ownBytes = yield* provider.write(floor.image, effort);
    if (effort < 7) {
      const best = yield* measured(qualitySteps(q => provider.image(q, {filter: 'plain'}), {ssimulacra2: own.ssimulacra2},
        {start: quality, low: 1, high: 99, probes: effort === 5 ? 6 : 12}), measure, signal);
      if (best.scores.ssimulacra2 >= own.ssimulacra2) {
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
  } finally { cpu.destroy(); }
}

function imageRecipe(image) {
  const layout = new Uint32Array(image.strategyData.blocks.length * 3);
  image.strategyData.blocks.forEach(({id, bx, by}, i) => layout.set([id, bx, by], i * 3));
  return {layout, fields: image.quantFields?.slice(), perceptual: image.perceptual === true};
}
function rebuildImage(pixels, width, height, options, recipe) {
  const plain = complete(rgbCoefficientSteps(pixels, width, height, options.quality, options.colorSpace, options.areas));
  const base = blockBase(pixels, width, height, plain);
  base.photoBoundaries = base.quantFields;
  if (recipe.fields) base.quantFields = recipe.fields;
  const layout = Array.from({length: recipe.layout.length / 3}, (_, i) =>
    ({id: recipe.layout[i * 3], bx: recipe.layout[i * 3 + 1], by: recipe.layout[i * 3 + 2]}));
  return fixedStrategyImage(base, width, height, {...blockOptions(base), perceptual: recipe.perceptual, layout}).image;
}

export function* regionPhotoFrameSteps(rows, width, height, options) {
  const {photoBlockEffort: effort = 7, readingWebp, signal, photoCrops, referenceRows = rows, exactRows = null,
    project = null, photoAdmission = null, photoSearch = null, floorImage = null, floorBytes = null, photoScoreMemo = null, ...frame} = options;
  const origin = {x: frame.placement?.crop?.x ?? 0, y: frame.placement?.crop?.y ?? 0};
  const memoFrame = photoScoreMemo?.frame(rows, width, height, options);
  if (floorImage) {
    const result = qualifyPhotoImage(floorImage, {rows, referenceRows, exactRows, crops: photoCrops ?? frame.areas,
      readingWebp, mask: frame.placement?.mask === true, project, signal, colorSpace: frame.colorSpace, origin});
    check(signal); photoAdmission?.record(floorBytes, result.passed, result.measurements); return floorBytes;
  }
  const newGuard = () => cropGuard(width, height, photoCrops ?? frame.areas, readingWebp,
    frame.placement?.mask === true, project, signal, frame.colorSpace, origin);
  const observe = guard => (image, pixels, top) => guard.add(pixels, image, image, top,
    referenceRows(top, image.height), exactRows?.(top, image.height));
  if (effort === 4) {
    const guard = newGuard();
    const bytes = yield* pageFrameSteps(rows, width, height, {...frame, observeBand: observe(guard)});
    check(signal); photoAdmission?.record(bytes, guard.complete(), guard.measurements()); return bytes;
  }
  const guard = newGuard(), recipes = new Map();
  const strategy = {*band(pixels, w, h, info) {
    if (info.again) {
      const recipe = recipes.get(info.top);
      if (!recipe) throw new Error('A photo band has no selected recipe.');
      return rebuildImage(pixels, w, h, info, recipe);
    }
    const source = pixels.slice(), reference = referenceRows(info.top, h).slice(), exact = exactRows?.(info.top, h);
    const crops = (photoCrops ?? frame.areas)?.map(r => ({...r, y: r.y - info.top}));
    const scoreScope = memoFrame?.band(info.top, w, h);
    try {
      const result = yield* rgbPhotoBandSteps(source, w, h, {...info, effort, signal, reference, crops, photoSearch, scoreScope,
        exact, mask: frame.placement?.mask === true,
        project: project && (rgba => project(rgba, info.top)), ans: frame.placement?.ans,
        origin: {x: origin.x, y: origin.y + info.top}});
      recipes.set(info.top, imageRecipe(result.image));
      guard.add(source, result.image, result.plain, info.top, reference, exact);
      return result.image;
    } finally { scoreScope?.release(); }
  }};
  let step, reply;
  const candidate = pageFrameSteps(rows, width, height, {...frame, strategy});
  try {
    while (!(step = candidate.next(reply)).done) {
      if (!guard.passed()) break;
      reply = yield typeof step.value === 'number' ? step.value * 0.95 : step.value;
    }
  } finally { candidate.return?.(); }
  check(signal);
  if (step.done && guard.complete()) { photoAdmission?.record(step.value, true, guard.measurements()); return step.value; }
  const fallbackGuard = newGuard();
  const fallback = pageFrameSteps(rows, width, height, {...frame, observeBand: observe(fallbackGuard)});
  try {
    while (!(step = fallback.next(reply)).done) reply = yield typeof step.value === 'number' ? 0.95 + step.value * 0.05 : step.value;
    check(signal); photoAdmission?.record(step.value, fallbackGuard.complete(), fallbackGuard.measurements()); return step.value;
  } finally { fallback.return?.(); }
}
