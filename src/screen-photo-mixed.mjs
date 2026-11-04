// SPDX-License-Identifier: MIT
import {part} from './bits.mjs';
import {encodeCaptureBytes, CAPTURE_BASE, compileCaptureKernels} from './capture-codec.mjs';
export {compileCaptureKernels};
import {expandPhotoRegions} from './screen-photo-borders.mjs';
import {photoCoefficientSteps} from './photo-dct.mjs';
import {coefficientAnsSteps} from './coefficient-ans.mjs';
import {encodeLayersSteps} from './layers-core.mjs';

function crop(data, width, region) {
  const {x, y, width: w, height: h} = region, out = new Uint8Array(w * h * 4);
  for (let row = 0; row < h; row++) {
    const at = ((y + row) * width + x) * 4;
    out.set(data.subarray(at, at + w * 4), row * w * 4);
  }
  return out;
}

function* stage(steps, start, span) {
  return yield* part(steps, start / span, 1 / span);
}

export function* screenPhotoSteps({data, width, height, quality, regions: rawRegions, effort = 1, bound = Infinity}) {
  const regions = expandPhotoRegions(data, width, height, rawRegions), base = Uint8Array.from(data);
  for (const {x, y, width: w, height: h} of regions) {
    const corner = ((y ? y - 1 : y) * width + (x ? x - 1 : x)) * 4;
    for (let row = y; row < y + h; row++) for (let col = x; col < x + w; col++) {
      const p = (row * width + col) * 4;
      base[p] = data[corner]; base[p + 1] = data[corner + 1]; base[p + 2] = data[corner + 2];
    }
  }
  let alpha = false;
  for (let i = 3; i < data.length; i += 4) if (data[i] !== 255) { alpha = true; break; }
  const exact = encodeCaptureBytes(base, width, height, {colorSpace: 'srgb', [CAPTURE_BASE]: true});
  yield 0.2;
  const coded = [], layers = [{bytes: exact}];
  for (let i = 0; i < regions.length; i++) {
    const region = regions[i], pixels = crop(data, width, region), start = 0.2 + i * 0.3 / regions.length;
    const image = yield* stage(photoCoefficientSteps(pixels, region.width, region.height, quality, 'srgb'),
      start, 0.15 / regions.length);
    if (alpha) image.alpha = pixels;
    const bytes = yield* stage(coefficientAnsSteps(image, 1), start + 0.15 / regions.length, 0.15 / regions.length);
    coded.push({image, bytes}); layers.push({bytes, x: region.x, y: region.y});
  }
  const first = yield* stage(encodeLayersSteps({width, height, layers}), 0.5, 0.1);
  if (effort < 2 || first.length > bound) return first;
  for (let i = 0; i < regions.length; i++) {
    let {image, bytes} = coded[i]; const start = 0.6 + i * 0.3 / regions.length;
    if (effort > 3) bytes = yield* stage(coefficientAnsSteps(image, 3, bytes), start, 0.1 / regions.length);
    layers[i + 1].bytes = yield* stage(coefficientAnsSteps(image, effort, bytes), start + (effort > 3 ? 0.1 : 0) / regions.length, (effort > 3 ? 0.2 : 0.3) / regions.length);
  }
  const better = yield* stage(encodeLayersSteps({width, height, layers}), 0.9, 0.1);
  return better.length < first.length ? better : first;
}
