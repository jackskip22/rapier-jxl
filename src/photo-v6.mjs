// SPDX-License-Identifier: MIT
import {memoryPlan} from './memory-plan.mjs';
import {fault} from './fault.mjs';
import {exactPow} from './exact-math.mjs';
import {complete, part, scaled} from './bits.mjs';
import {QUANT_SHAPE, transformDCT8, dct8Basis} from './photo-dct.mjs';
import {photoXYBSteps, gaborishPlanes} from './photo-xyb.mjs';
import {photoXYBBands, photoXYBBand, appendPhotoBand, PHOTO_BAND_MARGIN, photoFastBands} from './photo-bands.mjs';
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

export const V6 = {
  tune: (c, k) => {
    const r = Math.sqrt(((k & 7) * (k & 7) + (k >> 3) * (k >> 3)) / 98);
    return CHROMA[c * 64 + k] * [1.3, 1, 1.675][c] * (1 + [0.45, 0.45, 0][c] * r) * (1 + [-0.15, 0.05, 0][c] * r * r);
  },
  deadzone: [0.72, 0.76, 0.485, 0.575, 0.54, 0.6], epfScale: 3, filterAlways: true, dcScale: [1.675, 1.35, 1.675], cflScale: 0.7,
};
export const GABORISH = {gaborish: {strength: 1, tilt: 1}, epfScale: 2};

function admitV6Memory(rgba, width, height, memory) {
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

function gaborishRows(data, width, height, options) {
  const W = Math.ceil(width / 8) * 8;
  let band = null;
  return (y0, y1) => {
    if (band && y0 >= band.top && y1 <= band.top + band.rows) return band;
    band = null;
    const top = Math.floor(y0 / 64) * 64, rows = Math.max(256, Math.ceil((y1 - top) / 64) * 64);
    const from = Math.max(0, top - PHOTO_BAND_MARGIN), to = Math.min(height, top + rows + PHOTO_BAND_MARGIN);
    const planes = gaborishPlanes(data.subarray(from * width * 4, to * width * 4), width, to - from, options);
    return band = {top, rows, planes: planes.map(p => p.subarray((top - from) * W))};
  };
}

export function photoV6Image(prepared, quality, cache = true) { return v6Image(prepared, quality, {}, cache); }

export function v6Image(prepared, quality, extra = {}, cache = true) {
  const {rgba, width, height, pre, color, dct} = prepared, options = {...V6, ...GABORISH, ...color};
  if (pre) return complete(photoXYBSteps(rgba, width, height, quality, {...options, pre, dctCache: cache ? dct : null, ...extra}));
  const image = bandedImage(rgba, width, height, quality, options, extra.fieldScale);
  if (extra.keepPlanes) image.planeRows = gaborishRows(rgba, width, height, options);
  return image;
}

function bandBase(data, width, height, quality, options) {
  const bandHeight = Math.max(64, Math.floor(1048576 / width / 64) * 64);
  let image, band = null;
  const make = y => {
    const h = Math.min(bandHeight, height - y), from = Math.max(0, y - PHOTO_BAND_MARGIN), to = Math.min(height, y + h + PHOTO_BAND_MARGIN);
    const result = photoXYBBand(data.subarray(from * width * 4, to * width * 4), width, h, quality, {...options, keepPlanes: true}, y - from);
    band = {top: y, end: y + Math.ceil(h / 8) * 8, planes: result.planes};
    image = appendPhotoBand(image, result, width, height, y, data);
    image.planes = undefined;
  };
  make(0);
  image.planeRows = (y0, y1) => {
    while (y0 >= band.end) make(band.top + bandHeight);
    if (y0 < band.top || y1 > band.end) throw new RangeError('Block rows are asked for in band order.');
    return {planes: band.planes, top: band.top};
  };
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

export function* photoV6Steps(data, width, height, quality, effort, encodeCoefficients, search, color, gpu, memory) {
  if (effort <= 3 || color) return yield* pictureSteps(data, width, height, quality, effort, encodeCoefficients, search, color, gpu, memory);
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
  const floor = yield* share(pictureSteps(data, width, height, quality, 1, encodeCoefficients, undefined, color, undefined, memory), 0, 0.1);
  if (hurry) return floor;
  const bytes = yield* share(pictureSteps(data, width, height, quality, effort, encodeCoefficients, search, color, gpu, memory), 0.1, 1);
  return bytes.length < floor.length ? bytes : floor;
}

function* pictureSteps(data, width, height, quality, effort, encodeCoefficients, search, color, gpu, memory) {
  if (effort <= 3 && !color) {
    if (effort >= 2 && quality < 100 && width * height > 512 * 512 && encodeCoefficients.splits) {
      const bytes = yield {split: {data, width, height, quality}};
      if (bytes) return bytes;
    }
    const image = offloading() ? yield* part(photoFastBands(data, width, height, quality, {...V6, fast: true}), 0, 2) : complete(photoXYBSteps(data, width, height, quality, {...V6, fast: true}));
    return yield* (offloading() ? part(encodeCoefficients(image, effort), 1, 2) : encodeCoefficients(image, effort));
  }
  if (gpu && effort <= 7 && !color) {
    const image = yield {gpu: {kind: 'v6image', data, width, height, quality, options: {...V6, ...GABORISH}, lib: {complete, photoXYBSteps, transformDCT8, dct8Basis}}};
    if (image) return yield* encodeCoefficients(image, effort);
  }
  if (effort === 8 && !gpu && width * height >= 8000000 && search?.blocks) {
    const plan = admitV6Memory(data, width, height, memory);
    const held = {base: plan.banded ? bandBase(data, width, height, quality, {...V6, ...GABORISH, ...color})
      : v6Image(prepareV6(data, width, height, color, memory), quality, {keepPlanes: true})};
    const blocks = search.blocks(held, width, height, V6.deadzone);
    const image = yield* part(photoXYBBands(data, width, height, quality, {...V6, ...GABORISH, ...color}), 0, 2);
    const dct8 = yield* part(encodeCoefficients(image, 7), 1, 2);
    return dct8.length < blocks.length ? dct8 : blocks;
  }
  if (effort <= 7 || !search || width < 8 || height < 8) {
    admitV6Memory(data, width, height, memory);
    if (offloading()) return yield* bandsThenCoefficients(photoXYBBands(data, width, height, quality, {...V6, ...GABORISH, ...color}, color || {}), image => encodeCoefficients(image, effort));
    const image = yield* part(photoXYBBands(data, width, height, quality, {...V6, ...GABORISH, ...color}), 0, 2);
    return yield* part(encodeCoefficients(image, effort), 1, 2);
  }
  const prepared = prepareV6(data, width, height, color, memory, {banded: true});
  return yield* search(prepared, photoV6Image(prepared, quality, true), quality, effort);
}

