// SPDX-License-Identifier: MIT
import {rebuildPicture, rebuildable} from './photo-rebuild.mjs';
export {rcLlfFromDC, coefficientPlanes, inverseBlockRows, inverseBlockColumns, reconstructionDCSteps, reconstructionBlockScale, dequantizeStrategyAC, addStrategyChroma, reconstructionBlockDC, reconstructionBlockMeans, writeReconstructionLLF, epfInverseSigma, reconstructRGB, reconstructYCbCr, ycbcrPixels, half, inverseBasis, toRGBA, toRGBAInto} from './reconstruct-planes.mjs';

export function reconstruct(image) {
  if (!rebuildable(image) || image.ycbcr) throw Object.assign(new Error('This coefficient image has no XYB decoder rebuild.'), {code: 'JXL_INTERNAL'});
  return rebuildPicture(image, {rgba: false, linear: true}).linear;
}
