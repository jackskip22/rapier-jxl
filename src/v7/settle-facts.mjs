// SPDX-License-Identifier: MIT
import {PASSED, FACTS, journalFact, journaled} from '../step-journal.mjs';

const BAND_BYTES = 2 << 20;

const carriedBand = (journal, run) => journaled(journal, 'settle-band', run);

export async function settleFacts(journal, scans, data, width, height, bandBytes = BAND_BYTES) {
  const {shapeScan, shapeScanPixels, shapeScanNext, shapeResult, gradientRows, flatSampleAt, flatSampleY, photoPreferenceDifference} = scans;
  const rows = Math.max(2, Math.floor(bandBytes / (width * 4))), bands = Math.ceil(height / rows), pixels = width * height;
  const facts = journalFact(data, FACTS);
  let state;
  if (facts?.scans?.[0] && facts.flats && facts.gradient && typeof facts.preference === 'function') {
    let shape = structuredClone(facts.scans[0]);
    while (shapeScanNext(shape) < pixels) {
      const k = Math.floor(shapeScanNext(shape) / width / rows), top = k * rows, bottom = Math.min(height, top + rows);
      const next = await carriedBand(journal, () => {
        const nextShape = structuredClone(shape);
        shapeScanPixels(nextShape, data.subarray(top * width * 4, bottom * width * 4), top * width, (bottom - top) * width);
        return nextShape;
      });
      if (next !== PASSED) shape = next;
    }
    state = {shape, gradient: facts.gradient, flats: facts.flats, xyb: facts.preference()};
  } else {
    state = {shape: shapeScan(pixels), gradient: {sum: 0, n: 0}, flats: new Uint8Array(256), xyb: 0, swept: 0};
    const feed = (prev, k) => {
      const next = structuredClone(prev);
      const top = k * rows, bottom = Math.min(height, top + rows), band = data.subarray(top * width * 4, Math.min(height, bottom + 1) * width * 4);
      if (next.swept === k) {
        gradientRows(next.gradient, band, width, height, top, bottom, {row0: top});
        if (width >= 32 && height >= 32) for (let s = 0; s < 256; s++) {
          const y = flatSampleY(height, s);
          if (y >= top && y < bottom) next.flats[s] = flatSampleAt(band, width, height, s, width, 0, 0, top);
        }
        next.xyb += photoPreferenceDifference(band, width, height, top, bottom, top);
        next.swept++;
      }
      if (Math.floor(shapeScanNext(next.shape) / width) >= top && Math.floor(shapeScanNext(next.shape) / width) < bottom)
        shapeScanPixels(next.shape, band, top * width, (bottom - top) * width);
      return next;
    };
    for (;;) {
      const at = shapeScanNext(state.shape), k = state.swept < bands ? state.swept : at < pixels ? Math.floor(at / width / rows) : -1;
      if (k < 0) break;
      const saved = await carriedBand(journal, () => feed(state, k));
      if (saved !== PASSED) state = saved;
    }
  }
  const shape = shapeResult(state.shape), sum = state.gradient;
  const screen = width >= 32 && height >= 32 && scans.screenFromFlags(state.flats);
  const chroma = sum.n ? sum.chroma / sum.n : 0, slots = shape.palette?.colours.length ?? null;
  const greyPhoto = !screen && chroma < 2 && Math.min(width, height) >= 128 && (slots ?? 0) > 64;
  return {eligible: true, width, height, pixels, shorterSide: Math.min(width, height),
    gradient: sum.n ? sum.sum / sum.n : 0, blocks: scans.blockFacts(sum), visibleShare: sum.n ? 1 - (sum.clear ?? 0) / sum.n : 1, smooth: scans.exactlyPredicted(sum), soft: scans.softEdges(sum), chroma, palette: Boolean(shape.palette) && !greyPhoto, paletteSlots: slots,
    alpha: shape.alpha, screenLike: screen, preferXYB: Math.min(width, height) < 128 || state.xyb <= 0};
}
