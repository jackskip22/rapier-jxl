// SPDX-License-Identifier: MIT
import {rebuildPicture, rebuildable} from './photo-rebuild.mjs';
export {reconstructRGB, reconstructYCbCr, ycbcrPixels, half, inverseBasis} from './reconstruct-planes.mjs';

export function reconstruct(image) {
  if (!rebuildable(image) || image.ycbcr) throw Object.assign(new Error('reconstruct:xyb'), {code: 'JXL_INTERNAL'});
  return rebuildPicture(image, {rgba: false, linear: true}).linear;
}
