// SPDX-License-Identifier: MIT
import {complete} from '../bits.mjs';
import {photoTextLayers} from '../photo-text-layers.mjs';
import {searchQuality} from '../photo-region-search.mjs';
import {qualitySteps} from '../photo-quality-search.mjs';
import {regionPhotoFrameSteps} from '../photo-rgb.mjs';
import {planeSearchSteps} from '../photo-plane-search.mjs';
import {planeMeasuredSteps} from '../photo-plane-measured.mjs';
import {blockSearchOptions} from '../photo-v6.mjs';
import {scoreSteps, AQ, CANDIDATES} from '../photo-search.mjs';
import {measuredLook} from '../photo-quality-table.mjs';
import {CAPTURE_TOOLS_COMPLETE} from '../capture-ans.mjs';

const search = {blocks: planeSearchSteps, options: blockSearchOptions, measured: planeMeasuredSteps, score: scoreSteps, aq: AQ, candidates: CANDIDATES};

export function landedLettered({data, width, height}, found, codec, intent, signal) {
  const mask = found.mask, rect = {x: 0, y: 0, width, height};
  let measurements = [];
  const frame = (filled, quality, effort) => {
    let passed = false, measured = [];
    const photoAdmission = {record(bytes, ok, m) { passed = ok; measured = m ?? []; return bytes; }};
    const bytes = complete(regionPhotoFrameSteps((top, count) => filled.subarray(top * width * 4, (top + count) * width * 4), width, height, {
      quality, colorSpace: 'srgb', placement: {alphaChannel: true}, effort, photoBlockEffort: effort,
      readingIntent: intent, readingLook: measuredLook(intent), readingArithmetic: 'libjxl', photoSearch: search, photoAdmission, signal,
      referenceRows: (top, count) => data.subarray(top * width * 4, (top + count) * width * 4),
      exactRows: (top, count) => mask.subarray(top * width, (top + count) * width),
      project: (rgba, top) => { for (let i = 0; i < rgba.length / 4; i++) if (mask[top * width + i]) rgba.set(data.subarray((top * width + i) * 4, (top * width + i) * 4 + 4), i * 4); }}));
    return {bytes, quality, passed, measurements: measured};
  };
  const base = filled => {
    const start = searchQuality(filled, width, rect, codec.quality, intent, 0, 0, [], 'srgb', codec.quality, [], {step: 1});
    let best = null;
    for (let effort = 6; effort <= codec.effort; effort++) {
      const floor = best?.measurements[0].score;
      const landing = qualitySteps(function* (quality) { return {quality}; }, {ssimulacra2: 0},
        {start: best?.quality ?? start, low: 1, high: 99, probes: 12});
      let next, score;
      try {
        while (!(next = landing.next(score)).done) {
          const candidate = frame(filled, next.value.measure.quality, effort), readings = candidate.measurements;
          if (!readings.length || readings.some(m => !Number.isFinite(m.score) || !Number.isFinite(m.floor))) break;
          score = {ssimulacra2: Math.min(...readings.map(m => m.score - Math.max(m.floor, floor ?? m.floor)))};
          if (candidate.passed && score.ssimulacra2 >= 0 && (!best || candidate.bytes.length < best.bytes.length)) best = candidate;
        }
      } finally { landing.return(); }
    }
    if (!best) return null;
    measurements = best.measurements;
    return best.bytes;
  };
  const bytes = photoTextLayers(data, width, height, mask, codec.quality, codec.effort, CAPTURE_TOOLS_COMPLETE, base);
  return bytes && {bytes, measurements};
}
