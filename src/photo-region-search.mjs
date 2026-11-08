// SPDX-License-Identifier: MIT
import {qualitySteps} from './photo-quality-search.mjs';
import {lookFromScores, prepareCropScores, held, SMALLEST} from './photo-region-quality.mjs';
import {webpTarget} from './photo-quality-table.mjs';
import {measuredTarget} from './photo-browser-margin.mjs';
import {photoQualityMemo} from './photo-quality-cache.mjs';
import {photoScoreMemo} from './photo-score-cache.mjs';
import {complete} from './bits.mjs';
import {unit, journaling} from './step-journal.mjs';

const atStep = (step, cropProbe) => Object.assign((data, width, r, reading, webp, dx, dy, exactRects, colorSpace, frameQuality, boxes) =>
  searchQuality(data, width, r, reading, webp, dx, dy, exactRects, colorSpace, frameQuality, boxes, {step, cropProbe}),
{steps: (data, width, r, reading, webp, dx, dy, exactRects, colorSpace, frameQuality, boxes) =>
  searchQualitySteps(data, width, r, reading, webp, dx, dy, exactRects, colorSpace, frameQuality, boxes, {step, cropProbe})});

export function qualityLooks(owned) {
  const memo = photoQualityMemo(owned), scoreMemo = photoScoreMemo(owned);
  const probe = (args, quality, compute) => memo.crop(args, quality, compute), fine = atStep(1, probe);
  return {coarse: atStep(4, probe), fine: Object.assign((...args) => memo.look(args, () => fine(...args)), {steps: fine.steps}), scoreMemo,
    destroy() { memo.destroy(); scoreMemo.destroy(); }};
}

export function searchQuality(data, width, r, reading, webp, dx = 0, dy = 0, exactRects = [], colorSpace = 'srgb', frameQuality = reading, boxes = [], options = {}) {
  return complete(searchQualitySteps(data, width, r, reading, webp, dx, dy, exactRects, colorSpace, frameQuality, boxes, options));
}
export function* searchQualitySteps(data, width, r, reading, webp, dx = 0, dy = 0, exactRects = [], colorSpace = 'srgb', frameQuality = reading, boxes = [], {step = 4, cacheBytes = 16 << 20, cropProbe = null} = {}) {
  if (r.width < SMALLEST || r.height < SMALLEST || reading >= 100) return reading;
  const crops = held(r, boxes, width, data.length / 4 / width);
  if (!crops.length) return reading;
  let scores = null;
  const ready = () => scores ??= prepareCropScores(data, width, r, crops, dx, dy, exactRects, colorSpace, frameQuality, {cacheBytes});
  if (!journaling()) ready();
  const recipe = cropProbe && [data, width, r, crops, dx, dy, exactRects, colorSpace, frameQuality];
  const score = quality => cropProbe ? cropProbe(recipe, quality, () => ready()(quality)) : ready()(quality);
  let search, next, reply;
  try {
    const start = lookFromScores(reading, webp, yield* unit('quality-probe', () => score(reading)));
    const imageAt = function* (quality) { return {quality}; };
    search = qualitySteps(imageAt, {ssimulacra2: measuredTarget(webpTarget(webp))}, {start, low: 1, high: 99, probes: step > 1 ? 6 : 12});
    while (!(next = search.next(reply)).done) {
      const quality = next.value.measure.quality;
      reply = {ssimulacra2: Math.min(...(yield* unit('quality-probe', () => score(quality))))};
    }
    return next.value.quality;
  } finally {
    try { search?.return(); }
    finally { scores?.destroy(); }
  }
}
