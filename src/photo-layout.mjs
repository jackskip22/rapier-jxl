// SPDX-License-Identifier: MIT
import {PHOTO_LIMITS} from './limits.mjs';
import {admitSize, fault} from './admit.mjs';
import {prepareUpsamplingWeights} from './format-fields.mjs';
import {padPhotoTiles} from './photo-crop.mjs';

export function admitPhotoLayout(width, height, options, quality) {
  admitSize(width, height, PHOTO_LIMITS);
  const factor = options.upsampling ?? 1;
  if (![1, 2, 4, 8].includes(factor)) throw fault('JXL_INPUT', 'upsampling is 1, 2, 4 or 8.');
  if (quality === 100 && (factor !== 1 || options.upsamplingWeights !== undefined))
    throw fault('JXL_INPUT', 'Photographic upsampling requires quality below 100; exact reduced planes use encodeChannels.');
  if (factor !== 1 && options.lfFrames !== undefined && options.lfFrames !== false)
    throw fault('JXL_INPUT', 'A frame using a low-frequency frame cannot signal spatial upsampling.');
  return {width, height, factor, codedWidth: Math.ceil(width / factor), codedHeight: Math.ceil(height / factor),
    colorTransform: prepareUpsamplingWeights(options.upsamplingWeights),
    xybTransform: prepareUpsamplingWeights(options.upsamplingWeights, {xyb: true})};
}

export function padPhotoLayout(data, width, height, layout, noise) {
  if (noise) return padPhotoTiles(data, width, height);
  if (layout.factor === 1 || width > 1 && height > 1) return null;
  const w = Math.max(2, width), h = Math.max(2, height), pixels = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const at = (Math.min(y, height - 1) * width + Math.min(x, width - 1)) * 4;
    pixels.set(data.subarray(at, at + 4), (y * w + x) * 4);
  }
  return {data: pixels, width: w, height: h};
}

export function applyPhotoLayout(image, layout, padded = false) {
  image.canvasWidth = padded ? image.width * layout.factor : layout.width;
  image.canvasHeight = padded ? image.height * layout.factor : layout.height;
  image.upsampling = layout.factor;
  const transformData = image.xyb ? layout.xybTransform : layout.colorTransform;
  if (transformData) image.profile = {...image.profile, transformData};
}
