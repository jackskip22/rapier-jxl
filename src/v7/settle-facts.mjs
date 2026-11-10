// SPDX-License-Identifier: MIT
import {journaled} from '../step-journal.mjs';

const BAND_BYTES = 2 << 20;

export async function settleFacts(journal, scans, data, width, height, bandBytes = BAND_BYTES) {
  const {shapeScan, shapeScanPixels, shapeScanNext, shapeResult, gradientRows, flatSampleAt, flatSampleY, photoPreferenceDifference} = scans;
  const rows = Math.max(2, Math.floor(bandBytes / (width * 4))), bands = Math.ceil(height / rows), pixels = width * height;
  let state = {shape: shapeScan(pixels), gradient: {sum: 0, n: 0}, flats: new Uint8Array(256), xyb: 0, swept: 0};
  const feed = (state, k) => {
    const top = k * rows, bottom = Math.min(height, top + rows), band = data.subarray(top * width * 4, Math.min(height, bottom + 1) * width * 4);
    if (state.swept === k) {
      gradientRows(state.gradient, band, width, height, top, bottom, {row0: top});
      if (width >= 32 && height >= 32) for (let s = 0; s < 256; s++) {
        const y = flatSampleY(height, s);
        if (y >= top && y < bottom) state.flats[s] = flatSampleAt(band, width, height, s, width, 0, 0, top);
      }
      state.xyb += photoPreferenceDifference(band, width, height, top, bottom, top);
      state.swept++;
    }
    if (Math.floor(shapeScanNext(state.shape) / width) >= top && Math.floor(shapeScanNext(state.shape) / width) < bottom)
      shapeScanPixels(state.shape, band, top * width, (bottom - top) * width);
    return state;
  };
  for (;;) {
    const at = shapeScanNext(state.shape), k = state.swept < bands ? state.swept : at < pixels ? Math.floor(at / width / rows) : -1;
    if (k < 0) break;
    state = await journaled(journal, 'settle-band', () => feed(state, k));
  }
  const shape = shapeResult(state.shape), sum = state.gradient;
  let flat = 0, screen = width >= 32 && height >= 32;
  if (screen) for (let s = 0; s < 256; s++) { flat += state.flats[s]; if (flat + 255 - s < 192) { flat = 0; break; } }
  screen &&= flat >= 192;
  const chroma = sum.n ? sum.chroma / sum.n : 0, slots = shape.palette?.colours.length ?? null;
  const greyPhoto = !screen && chroma < 2 && Math.min(width, height) >= 128 && (slots ?? 0) > 64;
  return {eligible: true, width, height, pixels, shorterSide: Math.min(width, height),
    gradient: sum.n ? sum.sum / sum.n : 0, chroma, palette: Boolean(shape.palette) && !greyPhoto, paletteSlots: slots,
    alpha: shape.alpha, screenLike: screen, preferXYB: Math.min(width, height) < 128 || state.xyb <= 0};
}
