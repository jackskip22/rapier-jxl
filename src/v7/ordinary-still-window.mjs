// SPDX-License-Identifier: MIT
import {photoWindow} from './capture-region-look.mjs';
import {captureWindowVulnerability} from '../capture-kernels.mjs';
import {lowPhotoWindow} from '../photo-low.mjs';
import {smoothPhoto, smoothDecides} from './low-photo.mjs';
import {prepareKernels, ensureKernels} from '../kernels.mjs';
import {prepareRebuildKernels} from '../rebuild-kernels.mjs';
import {rebuildShown, rebuildPicture} from '../photo-rebuild.mjs';
import {ssimulacra2, linearFromRGBA} from '../ssimulacra2.mjs';
import {linearFromTransform} from '../color-bytes.mjs';
import {P3_TRANSFORM} from '../color-transform.mjs';
import {measuredLook, worstRegionFloor, usesRegionalCalibration} from '../photo-quality-table.mjs';
import {NATIVE_STILL_CALIBRATION, filteredStillQuality} from './native-still-prediction.mjs';
import {BAND_PIXELS} from '../memory-device.mjs';
import {fault} from '../fault.mjs';

const largePhotograph = f => f.preferXYB && f.shorterSide >= 2048 && (f.pixels ?? f.width * f.height) > BAND_PIXELS;

const windowLook = (reference, window, image, wide) => {
  if (wide) return ssimulacra2(reference, rebuildPicture(image, {linear: true}).linear, window.width, window.height).score;
  return ssimulacra2(reference, linearFromRGBA(rebuildShown(image).rgba, window.width * window.height), window.width, window.height).score;
};

const refOf = (window, wide) => wide
  ? linearFromTransform(window.pixels, window.width * window.height, P3_TRANSFORM)
  : linearFromRGBA(window.pixels, window.width * window.height);

function windowEligible(decision, effort) {
  const f = decision?.facts;
  return effort >= 1 && effort <= 5 && decision?.route === 'photo' && decision.quality < NATIVE_STILL_CALIBRATION.maximumLossy &&
    f.eligible && f.alpha === false && !f.palette && !f.screenLike && f.preferXYB && f.shorterSide >= 256;
}

export function ownedStillWindow(decision, effort, intent) {
  const f = decision?.facts, b = f?.blocks;
  return windowEligible(decision, effort) &&
    (largePhotograph(f) ? intent <= NATIVE_STILL_CALIBRATION.intent[2] + 1e-9
      : effort >= 3 && b && b.slope50 - b.spread50 >= NATIVE_STILL_CALIBRATION.windowGrain);
}

export function needsStillWindow(decision, effort, intent) {
  return windowEligible(decision, effort) &&
    (usesRegionalCalibration(intent) ? intent <= NATIVE_STILL_CALIBRATION.intent[2] + 1e-9 : ownedStillWindow(decision, effort, intent));
}

const LARGE = Object.freeze({side: 256, step: 8, intent: [0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.88, 0.9, 0.92],
  margin: {1: [7, 6.75, 6.25, 5.75, 4.75, 4.75, 3.75, 3.5, 5, 5.75, 6.75], 3: [5.25, 5.25, 5, 4.75, 4.25, 3.5, 3.5, 3.5, 5, 5.75, 6.75]}});
const largeMargin = (q, effort = 3) => {
  const {intent: knots} = LARGE, margin = LARGE.margin[effort >= 3 ? 3 : 1];
  if (q <= knots[0]) return margin[0];
  let i = 0;
  while (i + 2 < knots.length && knots[i + 1] < q) i++;
  return margin[i] + Math.min(1, (q - knots[i]) / (knots[i + 1] - knots[i])) * (margin[i + 1] - margin[i]);
};

async function ready(check) {
  const done = await Promise.all([prepareKernels(), prepareRebuildKernels()]);
  check();
  if (!done[0] || !done[1] || !ensureKernels()) throw fault('JXL_WASM', 'WebAssembly SIMD required');
}

function windowProbes(data, width, height, decision, effort, smooth, colorSpace) {
  const one = lowPhotoWindow(data, width, height, {...decision, effort, smooth, colorSpace});
  return one ? [one] : [lowPhotoWindow(data, width, height, {...decision, effort, smooth: false, colorSpace}),
    lowPhotoWindow(data, width, height, {...decision, lowFilteredQuality: undefined, effort, smooth, colorSpace})].filter(Boolean);
}

function hardestCrop(data, width, height) {
  const side = 128;
  if (width <= side || height <= side) return null;
  const nx = Math.min(6, Math.max(2, width >> 7)), ny = Math.min(6, Math.max(2, height >> 7));
  let bestScore = -1, bx = 0, by = 0;
  for (let iy = 0; iy < ny; iy++) {
    const cy0 = Math.min(height - side, Math.max(0, (Math.round(iy * (height - side) / Math.max(1, ny - 1)) + 4) & ~7));
    for (let ix = 0; ix < nx; ix++) {
      const cx0 = Math.min(width - side, Math.max(0, (Math.round(ix * (width - side) / Math.max(1, nx - 1)) + 4) & ~7));
      const vuln = captureWindowVulnerability(data, width, cx0, cy0, side, side, null).sum;
      if (vuln > bestScore) { bestScore = vuln; bx = cx0; by = cy0; }
    }
  }
  const out = new Uint8Array(side * side * 4);
  for (let y = 0; y < side; y++) out.set(data.subarray(((by + y) * width + bx) * 4, ((by + y) * width + bx + side) * 4), y * side * 4);
  return {pixels: out, x: bx, y: by, width: side, height: side};
}

export async function ordinaryStillWindow(intent, picture, decision, effort, signal, wide = false) {
  if (signal?.aborted) throw signal.reason;
  await ready(() => { if (signal?.aborted) throw signal.reason; });
  return stillWindowNow(intent, picture, decision, effort, signal, wide);
}

export function ordinaryStillWindowNow(intent, picture, decision, effort, signal) {
  if (typeof document !== 'undefined' || !usesRegionalCalibration(intent) || !ensureKernels()) return null;
  return stillWindowNow(intent, picture, decision, effort, signal, false);
}

export async function earlierStillWindow(intent, picture, decision, effort, signal) {
  if (signal?.aborted) throw signal.reason;
  await ready(() => { if (signal?.aborted) throw signal.reason; });
  return retainedStillWindow(intent, picture, decision, effort, signal);
}

function stillWindowNow(intent, picture, decision, effort, signal, wide) {
  if (!usesRegionalCalibration(intent)) return wide ? decision : retainedStillWindow(intent, picture, decision, effort, signal);
  const check = () => { if (signal?.aborted) throw signal.reason; };
  check();
  const {data, width, height} = picture, {facts} = decision, colorSpace = wide ? 'display-p3' : 'srgb';
  const isLarge = largePhotograph(facts);
  const vulnSide = width > 256 && height > 256 ? 256 : 128;
  const vulnWin = photoWindow(data, width, height, undefined, 0, 0, true, vulnSide) ?? photoWindow(data, width, height);
  const hardWin = hardestCrop(data, width, height);
  if (!vulnWin) return decision;

  const T = measuredLook(intent), W = worstRegionFloor(T);
  const top = NATIVE_STILL_CALIBRATION.maximumLossy;
  const gray = facts.chroma < 2 && (facts.paletteSlots ?? 0) > 64 ? 2 * Math.max(0, Math.min(1, (0.8 - intent) / 0.1)) : 0;
  const liftMargin = isLarge ? largeMargin(intent) + gray : 2.3 + Math.max(0, 12 - facts.gradient) / 8;

  const minDownQ = Math.max(intent * 100 - 1.5, decision.quality - (wide ? 9.5 : 7.0));
  const downGlobalMargin = (vulnSide === 256 ? 2.45 : 2.85) + gray + (wide ? 0.55 : 0) + Math.max(0, 12 - facts.gradient) / 4;
  const downHardMargin = 2.35 + (wide ? 0.45 : 0);

  const vulnRef = refOf(vulnWin, wide), hardRef = hardWin ? refOf(hardWin, wide) : null;
  const probeEffort = 3;
  let smoothRead;
  const at = quality => {
    const qRound = Math.round(quality * 100) / 100;
    const {lowFilteredQuality: _, ...rest} = decision;
    const lowFilteredQuality = wide ? undefined : filteredStillQuality(intent, facts, qRound, probeEffort);
    return {...rest, quality: qRound, ...(lowFilteredQuality !== undefined && {lowFilteredQuality})};
  };
  const evalAt = d => {
    const smooth = !wide && smoothDecides(d) && (smoothRead ??= smoothPhoto(data, width, height, facts));
    const probes = windowProbes(data, width, height, d, probeEffort, smooth, colorSpace);
    if (!probes.length) return null;
    let vulnS = Infinity, hardS = Infinity;
    for (const p of probes) {
      vulnS = Math.min(vulnS, windowLook(vulnRef, vulnWin, p.image(vulnWin), wide));
      if (hardWin) hardS = Math.min(hardS, windowLook(hardRef, hardWin, p.image(hardWin), wide));
      check();
    }
    return {vulnS, hardS};
  };

  const q1 = decision.quality, m1 = evalAt(decision);
  if (!m1 || !Number.isFinite(m1.vulnS)) return decision;

  const b = facts.blocks, wantsLift = !wide && (isLarge || b && b.slope50 - b.spread50 >= NATIVE_STILL_CALIBRATION.windowGrain);
  const liftTarget = T + liftMargin;
  if (wantsLift && m1.vulnS < liftTarget && q1 < top) {
    const slope = Math.max(0.5, 0.9 + 0.02 * (q1 - 70));
    if (isLarge) {
      const q2 = Math.min(top, q1 + Math.min(LARGE.step, (liftTarget - m1.vulnS) / slope));
      const m2 = evalAt(at(q2));
      if (!m2) return decision;
      const rise = Math.max(0.05, (m2.vulnS - m1.vulnS) / Math.max(0.05, q2 - q1));
      return at(Math.min(top, (m2.vulnS >= liftTarget ? q1 + (liftTarget - m1.vulnS) / rise : q2 + (liftTarget - m2.vulnS) / rise) + 0.15));
    }
    return at(Math.min(top, q1 + (liftTarget - m1.vulnS) / slope + 0.15));
  }
  if (!wide && hardWin && m1.hardS < W + 1.2 && q1 < top) {
    const slope = Math.max(0.5, 0.85 + 0.02 * (q1 - 70));
    return at(Math.min(top, q1 + (W + 1.4 - m1.hardS) / slope));
  }

  const surplus = Math.min(m1.vulnS - (T + downGlobalMargin), hardWin ? m1.hardS - (W + downHardMargin) : Infinity);
  if (!(surplus > 0.8) || q1 <= minDownQ + 0.25) return decision;

  const estSlope = Math.max(0.65, 0.88 + 0.02 * (q1 - 70));
  const q2 = Math.max(minDownQ, Math.round((q1 - Math.min(8.5, surplus / estSlope)) * 100) / 100);
  if (q1 - q2 < 0.35) return decision;
  const cand2 = at(q2), m2 = evalAt(cand2);
  if (!m2) return decision;
  const s2Surplus = Math.min(m2.vulnS - (T + downGlobalMargin), hardWin ? m2.hardS - (W + downHardMargin) : Infinity);
  if (s2Surplus >= 0) return cand2;

  const rise = Math.max(0.3, (surplus - s2Surplus) / Math.max(0.1, q1 - q2));
  const q3 = Math.max(minDownQ, Math.min(q1, q2 + (0.45 - s2Surplus) / rise));
  if (q1 - q3 < 0.35) return decision;
  const cand3 = at(q3), m3 = evalAt(cand3);
  if (!m3) return decision;
  const s3Surplus = Math.min(m3.vulnS - (T + downGlobalMargin - 0.15), hardWin ? m3.hardS - (W + downHardMargin - 0.15) : Infinity);
  return s3Surplus >= 0 ? cand3 : decision;
}

function retainedStillWindow(intent, picture, decision, effort, signal) {
  const check = () => { if (signal?.aborted) throw signal.reason; };
  check();
  const {data, width, height} = picture, {facts} = decision;
  if (largePhotograph(facts)) return retainedLargeWindow(intent, picture, decision, effort, check);
  const smooth = smoothDecides(decision) && smoothPhoto(data, width, height, facts);
  const probe = lowPhotoWindow(data, width, height, {...decision, effort, smooth});
  if (!probe) return decision;
  const window = photoWindow(data, width, height);
  const score = windowLook(linearFromRGBA(window.pixels, window.width * window.height), window, probe.image(window), false);
  check();
  const margin = 2.3 + Math.max(0, 12 - facts.gradient) / 8;
  const deficit = measuredLook(intent) + margin - score;
  if (!(deficit > 0)) return decision;
  const lift = deficit / Math.max(0.5, 0.9 + 0.02 * (probe.quality - 70)) + 0.15;
  return probe.filtered ? {...decision, lowFilteredQuality: Math.min(NATIVE_STILL_CALIBRATION.maximumLossy, probe.quality + lift)}
    : {...decision, quality: Math.min(NATIVE_STILL_CALIBRATION.maximumLossy, decision.quality + lift)};
}

function retainedLargeWindow(intent, picture, decision, effort, check) {
  const {data, width, height} = picture, {facts} = decision;
  const window = photoWindow(data, width, height, undefined, 0, 0, true, LARGE.side);
  if (!window) return decision;
  const gray = facts.chroma < 2 && (facts.paletteSlots ?? 0) > 64 ? 2 * Math.max(0, Math.min(1, (0.8 - intent) / 0.1)) : 0;
  const target = measuredLook(intent) + largeMargin(intent, effort) + gray, top = NATIVE_STILL_CALIBRATION.maximumLossy;
  const slope = q => Math.max(0.5, 0.9 + 0.02 * (q - 70));
  let smoothRead;
  const reference = linearFromRGBA(window.pixels, window.width * window.height);
  const read = d => {
    const smooth = smoothDecides(d) && (smoothRead ??= smoothPhoto(data, width, height, facts));
    let score = Infinity;
    for (const probe of windowProbes(data, width, height, d, effort, smooth)) {
      score = Math.min(score, windowLook(reference, window, probe.image(window), false));
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
