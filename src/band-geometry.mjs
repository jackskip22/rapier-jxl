// SPDX-License-Identifier: MIT
export const RECON_MARGIN = 8;
export const MAX_RECON_MARGIN = 64 + RECON_MARGIN;
export const SCORE_BAND_ROWS = 256;
export const SCORE_RECON_ROWS = SCORE_BAND_ROWS + 4 * 64;
export const SCORE_PLANE_ROWS = SCORE_RECON_ROWS + 16;
export const SCORE_COEFF_ROWS = SCORE_RECON_ROWS + 32;
export const scoreBandGeometry = (width, height) => `${Math.ceil(width / 8) * 8}:${Math.min(Math.ceil(height / 8) * 8, SCORE_COEFF_ROWS)}`;
export function scoreBandFits(have, want) {
  const [hw, hr] = have.split(':'), [ww, wr] = want.split(':');
  return +ww <= +hw && +wr <= +hr;
}

export function reconstructionRows(image, y0, y1, variable = image.strategyData || image.lazyStrategy) {
  const rows = image.components[0].rows;
  const margin = image.adaptiveLFSmoothing ? (variable ? MAX_RECON_MARGIN : 2 * RECON_MARGIN) : RECON_MARGIN;
  const at = Math.max(0, Math.floor((y0 - margin) / 64) * 8), end = Math.min(rows, Math.ceil((y1 + margin) / 64) * 8);
  return [end - at < 8 ? Math.max(0, at - 8) : at, end];
}
