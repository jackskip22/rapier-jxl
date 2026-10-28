// SPDX-License-Identifier: MIT
import {LIMITS} from './limits.mjs';
import {BitWriter, complete, part, scaled} from './bits.mjs';
import {admitOptions, admitPixels, fault, job} from './admit.mjs';
import {admitSampleFormat} from './admit-samples.mjs';
import {admitEffort} from './effort-level.mjs';
import {inspectPixels, shapeFloors, losslessSteps} from './lossless.mjs';
import {photoCoefficientSteps} from './photo-dct.mjs';
import {coefficientAnsSteps} from './coefficient-ans.mjs';
import {progressivePasses} from './vardct-progressive.mjs';
import {writeImageHeader} from './icc-write.mjs';
import {readStill, copyBits} from './framing.mjs';
import {encodeLayersSteps} from './layers.mjs';

export {LIMITS};
const HYBRID_KEYS = new Set(['quality', 'colorSpace', 'effort', 'regions', 'orientation', 'progressive']);
function hybridAdmission(data, width, height, options) {
  const {quality, colorSpace} = admitOptions(options, 90), effort = admitEffort(options);
  admitPixels(data, width, height);
  for (const key of Object.keys(options)) if (!HYBRID_KEYS.has(key)) throw fault('JXL_INPUT', 'Unknown hybrid option: ' + key + '.');
  if (!admitSampleFormat(data, options).native8) throw fault('JXL_INPUT', 'Hybrid layers use eight-bit sRGB-transfer RGB or Display P3 samples.');
  const orientation = options.orientation ?? 1;
  if (!Number.isInteger(orientation) || orientation < 1 || orientation > 8) throw fault('JXL_INPUT', 'orientation is an Exif value from one through eight.');
  const automatic = options.regions === undefined || options.regions === 'auto';
  if (!automatic && (!Array.isArray(options.regions) || options.regions.length > 255)) throw fault('JXL_INPUT', 'regions is auto or at most 255 source rectangles.');
  const regions = automatic ? null : options.regions.map(region => {
    if (!region || typeof region !== 'object') throw fault('JXL_INPUT', 'A hybrid region is {x, y, width, height}.');
    const {x, y, width: w, height: h} = region;
    if (![x, y, w, h].every(Number.isSafeInteger) || x < 0 || y < 0 || w < 1 || h < 1 || x + w > width || y + h > height)
      throw fault('JXL_INPUT', 'Every hybrid region is a nonempty rectangle inside the source image.');
    const left = x & ~7, top = y & ~7;
    return {x: left, y: top, width: Math.min(width, Math.ceil((x + w) / 8) * 8) - left,
      height: Math.min(height, Math.ceil((y + h) / 8) * 8) - top};
  });
  return {quality, colorSpace, effort, orientation, automatic, regions, progression: progressivePasses(options.progressive)};
}

export function hybridRegions(data, width, height) {
  admitPixels(data, width, height);
  if (!(data instanceof Uint8Array) && !(data instanceof Uint8ClampedArray)) throw fault('JXL_INPUT', 'Hybrid regions require eight-bit RGBA samples.');
  const rectangles = [], tile = 32;
  let previous = new Map();
  for (let y = 0; y < height; y += tile) {
    const h = Math.min(tile, height - y), row = new Map();
    let from = -1;
    const finish = to => {
      if (from < 0) return;
      const w = to - from, key = from + ':' + w;
      let rectangle = previous.get(key);
      if (rectangle) rectangle.height += h;
      else { rectangle = {x: from, y, width: w, height: h}; rectangles.push(rectangle); }
      row.set(key, rectangle); from = -1;
    };
    for (let x = 0; x < width; x += tile) {
      const w = Math.min(tile, width - x), colors = new Set();
      for (let py = y; py < y + h && colors.size <= 64; py++) for (let px = x; px < x + w && colors.size <= 64; px++) {
        const p = (py * width + px) * 4;
        colors.add(data[p] | data[p + 1] << 8 | data[p + 2] << 16 | data[p + 3] << 24);
      }
      if (colors.size <= 64) { if (from < 0) from = x; }
      else finish(x);
    }
    finish(width); previous = row;
  }
  if (rectangles.length > 255) rectangles.sort((a, b) => b.width * b.height - a.width * a.height || a.y - b.y || a.x - b.x).length = 255;
  return rectangles.sort((a, b) => a.y - b.y || a.x - b.x);
}

function hybridShape(data, width, height, alpha) {
  const before = shapeFloors.get(data);
  shapeFloors.set(data, {colour: 3, alpha});
  try { return inspectPixels(data, width, height); }
  finally { if (before) shapeFloors.set(data, before); else shapeFloors.delete(data); }
}
function hybridOrientation(bytes, orientation, colorSpace) {
  if (orientation === 1) return bytes;
  const still = readStill(bytes), w = new BitWriter(bytes.length + 32);
  writeImageHeader(w, still.image.width, still.image.height, still.image.colorChannels, still.image.alpha, {orientation, colorSpace});
  copyBits(w, still.codestream, still.image.end * 8, still.codestream.length * 8);
  return w.finish();
}
function* hybridExact(data, width, height, alpha, config, forced = true) {
  const shape = forced ? hybridShape(data, width, height, alpha) : undefined;
  const bytes = yield* losslessSteps(data, width, height, {colorSpace: config.colorSpace, shape});
  return hybridOrientation(bytes, config.orientation, config.colorSpace);
}
function* hybridPhoto(data, width, height, config) {
  const image = yield* part(photoCoefficientSteps(data, width, height, config.quality, config.colorSpace), 0, 2);
  image.orientation = config.orientation; image.progression = config.progression;
  return yield* part(coefficientAnsSteps(image, config.effort), 1, 2);
}
function hybridCrop(data, stride, region) {
  const out = new Uint8Array(region.width * region.height * 4);
  for (let y = 0; y < region.height; y++) {
    const start = ((region.y + y) * stride + region.x) * 4;
    out.set(data.subarray(start, start + region.width * 4), y * region.width * 4);
  }
  return out;
}
function* hybridStage(steps, start, span) {
  let next, hurry;
  while (!(next = steps.next(hurry)).done) hurry = yield scaled(next.value, value => start + span * value);
  return next.value;
}
function* hybridSteps(data, width, height, config) {
  if (config.quality === 100) return yield* hybridExact(data, width, height, false, config, false);
  let regions = config.regions ?? hybridRegions(data, width, height);
  if (regions.length === 1 && regions[0].x === 0 && regions[0].y === 0 && regions[0].width === width && regions[0].height === height) {
    const exact = yield* part(hybridExact(data, width, height, false, config, false), 0, config.automatic ? 2 : 1);
    if (!config.automatic) return exact;
    const photo = yield* part(hybridPhoto(data, width, height, config), 1, 2);
    return exact.length < photo.length ? exact : photo;
  }
  if (!regions.length) return yield* hybridPhoto(data, width, height, config);
  let best;
  if (config.automatic) {
    best = yield* part(hybridPhoto(data, width, height, config), 0, 4);
    if (yield .25) return best;
  }
  try {
    const alpha = data.some((value, i) => (i & 3) === 3 && value !== 255), exactCrops = new Map();
    const broadGraphics = regions.reduce((sum, r) => sum + r.width * r.height, 0) >= width * height / 2;
    if (config.automatic) {
      const selected = [];
      for (let i = 0; i < regions.length; i++) {
        const region = regions[i], pixels = hybridCrop(data, width, region);
        const exact = yield* hybridStage(hybridExact(pixels, region.width, region.height, alpha, config), .25 + .25 * i / regions.length, .125 / regions.length);
        const photo = yield* hybridStage(hybridPhoto(pixels, region.width, region.height, config), .25 + .25 * (i + .5) / regions.length, .125 / regions.length);
        if (exact.length + 32 < photo.length) {
          selected.push(region); exactCrops.set(region, exact);
        }
        if (yield .25 + .25 * (i + 1) / regions.length) return best;
      }
      regions = selected;
    }
    const smooth = new Uint8Array(data);
    for (const region of regions) {
      const at = (region.y * width + region.x) * 4;
      for (let y = region.y; y < region.y + region.height; y++) for (let x = region.x; x < region.x + region.width; x++) {
        const p = (y * width + x) * 4;
        for (let c = 0; c < 3; c++) smooth[p + c] = data[at + c];
      }
    }
    if (regions.length) {
      const base = yield* hybridStage(hybridPhoto(smooth, width, height, config), config.automatic ? .5 : 0, config.automatic ? .125 : .5);
      const layers = [{bytes: base}];
      for (let i = 0; i < regions.length; i++) {
        const region = regions[i];
        const bytes = exactCrops.get(region) ?? (yield* hybridStage(hybridExact(hybridCrop(data, width, region), region.width, region.height, alpha, config),
          (config.automatic ? .625 : .5) + (config.automatic ? .125 : .25) * i / regions.length, (config.automatic ? .125 : .25) / regions.length));
        layers.push({bytes, x: region.x, y: region.y});
      }
      const bytes = yield* hybridStage(encodeLayersSteps({width, height, layers}), .75, config.automatic && broadGraphics ? .125 : .25);
      if (!best || bytes.length < best.length) best = bytes;
    }
    if (config.automatic && broadGraphics) {
      const exact = yield* hybridStage(hybridExact(data, width, height, alpha, config, false), .875, .125);
      if (exact.length < best.length) best = exact;
    }
    return best;
  } catch (error) {
    if (best && (error.code === 'JXL_SIZE' || error.code === 'JXL_MEMORY' || error instanceof RangeError && !error.code)) return best;
    throw error;
  }
}
export function encodeHybrid(data, width, height, options = {}) { return complete(encodeHybridSteps(data, width, height, options)); }
export function encodeHybridSteps(data, width, height, options = {}) { return job(hybridSteps(data, width, height, hybridAdmission(data, width, height, options))); }
