// SPDX-License-Identifier: MIT
import {photoWindow} from './capture-region-look.mjs';
import {lowPhotoWindow} from '../photo-low.mjs';
import {smoothPhoto, smoothDecides} from './low-photo.mjs';
import {prepareKernels, ensureKernels} from '../kernels.mjs';
import {prepareRebuildKernels} from '../rebuild-kernels.mjs';
import {rebuildShown} from '../photo-rebuild.mjs';
import {ssimulacra2, linearFromRGBA} from '../ssimulacra2.mjs';
import {measuredLook} from '../photo-quality-table.mjs';
import {NATIVE_STILL_CALIBRATION, filteredStillQuality} from './native-still-prediction.mjs';
import {BAND_PIXELS} from '../memory-device.mjs';
import {fault} from '../fault.mjs';

const largePhotograph = f => f.preferXYB && f.shorterSide >= 2048 && (f.pixels ?? f.width * f.height) > BAND_PIXELS;

const windowLook = (reference, window, shown) => ssimulacra2(reference, linearFromRGBA(shown.rgba, window.width * window.height),
  window.width, window.height).score;

export function needsStillWindow(decision, effort, intent) {
  const f = decision?.facts, b = f?.blocks;
  return effort >= 1 && effort <= 5 && decision?.route === 'photo' && decision.quality < NATIVE_STILL_CALIBRATION.maximumLossy &&
    f.eligible && f.alpha === false && !f.palette && !f.screenLike && f.preferXYB && f.shorterSide >= 256 &&
    (largePhotograph(f) ? intent <= NATIVE_STILL_CALIBRATION.intent[2] + 1e-9
      : effort >= 3 && b && b.slope50 - b.spread50 >= NATIVE_STILL_CALIBRATION.windowGrain);
}

const LARGE = Object.freeze({side: 256, step: 8, intent: [0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.88, 0.9, 0.92],
  margin: {1: [7, 6.75, 6.25, 5.75, 4.75, 4.75, 3.75, 3.5, 5, 5.75, 6.75], 3: [5.25, 5.25, 5, 4.75, 4.25, 3.5, 3.5, 3.5, 5, 5.75, 6.75]}});
const largeMargin = (q, effort) => {
  const {intent: knots} = LARGE, margin = LARGE.margin[effort >= 3 ? 3 : 1];
  if (q <= knots[0]) return margin[0];
  let i = 0;
  while (i + 2 < knots.length && knots[i + 1] < q) i++;
  return margin[i] + Math.min(1, (q - knots[i]) / (knots[i + 1] - knots[i])) * (margin[i + 1] - margin[i]);
};

export async function ordinaryStillWindow(intent, picture, decision, effort, signal) {
  const check = () => { if (signal?.aborted) throw signal.reason; };
  check();
  const {data, width, height} = picture, {facts} = decision;
  if (largePhotograph(facts)) return largeWindow(intent, picture, decision, effort, check);
  const smooth = smoothDecides(decision) && smoothPhoto(data, width, height, facts);
  const probe = lowPhotoWindow(data, width, height, {...decision, effort, smooth});
  if (!probe) return decision;
  await ready(check);
  const window = photoWindow(data, width, height);
  const score = windowLook(linearFromRGBA(window.pixels, window.width * window.height), window, rebuildShown(probe.image(window)));
  check();
  const margin = 2.3 + Math.max(0, 12 - facts.gradient) / 8;
  const deficit = measuredLook(intent) + margin - score;
  if (!(deficit > 0)) return decision;
  const lift = deficit / Math.max(0.5, 0.9 + 0.02 * (probe.quality - 70)) + 0.15;
  return probe.filtered ? {...decision, lowFilteredQuality: Math.min(NATIVE_STILL_CALIBRATION.maximumLossy, probe.quality + lift)}
    : {...decision, quality: Math.min(NATIVE_STILL_CALIBRATION.maximumLossy, decision.quality + lift)};
}

async function ready(check) {
  const done = await Promise.all([prepareKernels(), prepareRebuildKernels()]);
  check();
  if (!done[0] || !done[1] || !ensureKernels()) throw fault('JXL_WASM', 'The photographic window needs WebAssembly SIMD.');
}

function largeProbes(data, width, height, decision, effort, smooth) {
  const one = lowPhotoWindow(data, width, height, {...decision, effort, smooth});
  return one ? [one] : [lowPhotoWindow(data, width, height, {...decision, effort, smooth: false}),
    lowPhotoWindow(data, width, height, {...decision, lowFilteredQuality: undefined, effort, smooth})].filter(Boolean);
}

async function largeWindow(intent, picture, decision, effort, check) {
  const {data, width, height} = picture, {facts} = decision;
  const window = photoWindow(data, width, height, undefined, 0, 0, true, LARGE.side);
  if (!window) return decision;
  await ready(check);
  const gray = facts.chroma < 2 && (facts.paletteSlots ?? 0) > 64 ? 2 * Math.max(0, Math.min(1, (0.8 - intent) / 0.1)) : 0;
  const target = measuredLook(intent) + largeMargin(intent, effort) + gray, top = NATIVE_STILL_CALIBRATION.maximumLossy;
  const slope = q => Math.max(0.5, 0.9 + 0.02 * (q - 70));
  let smoothRead;
  const reference = linearFromRGBA(window.pixels, window.width * window.height);
  const read = d => {
    const smooth = smoothDecides(d) && (smoothRead ??= smoothPhoto(data, width, height, facts));
    let score = Infinity;
    for (const probe of largeProbes(data, width, height, d, effort, smooth)) {
      score = Math.min(score, windowLook(reference, window, rebuildShown(probe.image(window))));
      check();
    }
    return score;
  };
  const at = quality => {
    const {lowFilteredQuality: _, ...rest} = decision, lowFilteredQuality = filteredStillQuality(intent, facts, quality, effort);
    return {...rest, quality, ...(lowFilteredQuality !== undefined && {lowFilteredQuality})};
  };
  const q1 = decision.quality, s1 = read(decision);
  if (!(target > s1) || !Number.isFinite(s1) || q1 >= top) return decision;
  const q2 = Math.min(top, q1 + Math.min(LARGE.step, (target - s1) / slope(q1))), s2 = read(at(q2));
  const rise = Math.max(0.05, (s2 - s1) / (q2 - q1));
  return at(Math.min(top, (s2 >= target ? q1 + (target - s1) / rise : q2 + (target - s2) / rise) + 0.15));
}
