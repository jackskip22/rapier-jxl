// SPDX-License-Identifier: MIT
import {photoWindow} from './capture-region-look.mjs';
import {captureWindowVulnerability} from '../capture-kernels.mjs';
import {lowPhotoWindow} from '../photo-low.mjs';
import {photoCoefficientSteps} from '../photo-dct.mjs';
import {complete} from '../bits.mjs';
import {readEach} from '../step-journal.mjs';
import {s2Stream} from '../photo-s2-stream.mjs';
import {smoothPhoto, smoothDecides} from './low-photo.mjs';
import {prepareKernels, ensureKernels} from '../kernels.mjs';
import {prepareRebuildKernels, releaseRebuildKernels} from '../rebuild-kernels.mjs';
import {rebuildShown, rebuildPicture} from '../photo-rebuild.mjs';
import {ssimulacra2, ssimulacra2Reference, linearFromRGBA} from '../ssimulacra2.mjs';
import {dropMetricPool} from '../ssimulacra2-arithmetic.mjs';
import {finitePlanes} from '../ssimulacra2-input.mjs';
import {uploadFlat, uploadGrain} from '../photo-v6-settings.mjs';
import {settledFacts, settledWideFacts} from './low-intent-quality.mjs';
import {linearFromTransform} from '../color-bytes.mjs';
import {P3_TRANSFORM} from '../color-transform.mjs';
import {measuredLook, worstRegionFloor, usesRegionalCalibration, landsAtEffort, LAND_KEEP} from '../photo-quality-table.mjs';
import {measuredTarget} from '../photo-browser-margin.mjs';
import {qualityLanding} from '../model-weights.mjs';
import {NATIVE_STILL_CALIBRATION, filteredStillQuality} from './native-still-prediction.mjs';
import {BAND_PIXELS, uploadCacheBudget} from '../memory-device.mjs';
import {fault} from '../fault.mjs';
import {bandScratch} from '../band-scratch.mjs';

const largePhotograph = f => f.preferXYB && f.shorterSide >= 2048 && (f.pixels ?? f.width * f.height) > BAND_PIXELS;

const windowLook = (reference, window, image, wide) => {
  if (wide) return ssimulacra2(reference, finitePlanes(rebuildPicture(image, {linear: true}).linear), window.width, window.height).score;
  return ssimulacra2(reference, finitePlanes(linearFromRGBA(rebuildShown(image).rgba, window.width * window.height)), window.width, window.height).score;
};

const refOf = (window, wide) => finitePlanes(wide
  ? linearFromTransform(window.pixels, window.width * window.height, P3_TRANSFORM)
  : linearFromRGBA(window.pixels, window.width * window.height));

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

export const needsWideWindow = (decision, effort) => {
  const f = decision?.facts;
  return windowEligible(decision, effort) || effort >= 1 && effort <= 5 && decision?.route === 'photo' && decision.quality < NATIVE_STILL_CALIBRATION.maximumLossy &&
    f.eligible && f.alpha === false && !f.palette && !f.screenLike && f.preferXYB && f.shorterSide >= 128 && f.pixels <= 200000;
};

export const usesModelLanding = intent => intent >= 0.3 - 1e-9 && intent <= NATIVE_STILL_CALIBRATION.intent[2] + 1e-9;
const modelStart = (decision, intent) => decision?.today !== undefined && usesModelLanding(intent);
const todayOf = decision => {
  const {today, lowFilteredQuality: _, ...rest} = decision;
  return {...rest, quality: today.quality, ...(today.lowFilteredQuality !== undefined && {lowFilteredQuality: today.lowFilteredQuality})};
};

export function needsStillWindow(decision, effort, intent) {
  return windowEligible(decision, effort) &&
    (usesRegionalCalibration(intent, effort) || modelStart(decision, intent) || ownedStillWindow(decision, effort, intent));
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

const MODEL = Object.freeze({lift: 0.65, hard: 0.95, least: 24});

async function ready(check) {
  const done = await Promise.all([prepareKernels(), prepareRebuildKernels()]);
  check();
  if (!done[0] || !done[1] || !ensureKernels()) throw fault('JXL_WASM', 'WebAssembly SIMD required');
}

const cachedVulnWindows = /* @__PURE__ */ new WeakMap();
function sharedVulnWindow(data, width, height, side) {
  const owned = settledFacts.has(data) || settledWideFacts.has(data);
  if (owned) {
    const hit = cachedVulnWindows.get(data);
    if (hit && hit.width === width && hit.height === height && hit.side === side) return hit.win;
  }
  const win = photoWindow(data, width, height, undefined, 0, 0, true, side);
  if (owned && win) cachedVulnWindows.set(data, {width, height, side, win});
  return win;
}

function windowProbes(data, width, height, decision, effort, smooth, colorSpace, memo) {
  let extra;
  if (memo) {
    memo.flat ??= uploadFlat(data, width, height);
    memo.grain ??= !memo.flat && uploadGrain(data, width, height);
    extra = {uploadFlat: memo.flat, grain: memo.grain};
  }
  const one = lowPhotoWindow(data, width, height, {...decision, effort, smooth, colorSpace, ...extra});
  return one ? [one] : [lowPhotoWindow(data, width, height, {...decision, effort, smooth: false, colorSpace, ...extra}),
    lowPhotoWindow(data, width, height, {...decision, lowFilteredQuality: undefined, effort, smooth, colorSpace, ...extra})].filter(Boolean);
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

export async function windowsReady(signal) {
  if (signal?.aborted) throw signal.reason;
  await ready(() => { if (signal?.aborted) throw signal.reason; });
}
export function releaseWindows() { releaseRebuildKernels(); dropMetricPool(); }
export const windowsNow = () => typeof document === 'undefined' && ensureKernels();
export {stillWindowNow, retainedStillWindow};

export async function ordinaryStillWindow(intent, picture, decision, effort, signal, wide = false, cap = null, sharedState = null) {
  if (signal?.aborted) throw signal.reason;
  await ready(() => { if (signal?.aborted) throw signal.reason; });
  try { return stillWindowNow(intent, picture, decision, effort, signal, wide, cap, sharedState); }
  finally { releaseRebuildKernels(); dropMetricPool(); }
}

export function ordinaryStillWindowNow(intent, picture, decision, effort, signal, cap = null, then = reading => reading) {
  if (typeof document !== 'undefined' || !usesRegionalCalibration(intent, effort) && !modelStart(decision, intent) || !ensureKernels()) return null;
  try { const reading = stillWindowNow(intent, picture, decision, effort, signal, false, cap, null); return reading && then(reading); }
  finally { releaseRebuildKernels(); dropMetricPool(); }
}

export async function earlierStillWindow(intent, picture, decision, effort, signal, sharedState = null) {
  if (signal?.aborted) throw signal.reason;
  await ready(() => { if (signal?.aborted) throw signal.reason; });
  try { return retainedStillWindow(intent, picture, decision, effort, signal, sharedState); }
  finally { releaseRebuildKernels(); dropMetricPool(); }
}

const FLOOR = Object.freeze({margin: 3, aim: 0.3, steps: 3});

function floorProbes(data, width, height, decision, memo) {
  if (decision.calibratedWindow) return windowProbes(data, width, height, decision, 3, false, 'srgb', memo);
  if (decision.facts.preferXYB) {
    const smooth = smoothDecides(decision) && (memo.smooth ??= smoothPhoto(data, width, height, decision.facts));
    return windowProbes(data, width, height, decision, 3, smooth, 'srgb', memo);
  }
  const q = decision.quality;
  return [{image: ({pixels, width: w, height: h}) => complete(photoCoefficientSteps(pixels, w, h, q, 'srgb')),
    band: (from, to, scratch = false) => complete(photoCoefficientSteps(data.subarray(from * width * 4, to * width * 4), width, to - from, q, 'srgb', false, false, null, {bandScratch: scratch}))}];
}

function joinedBand(strips) {
  const first = strips[0], last = strips[strips.length - 1];
  const components = first.components.map((c, k) => {
    const coeffs = bandScratch(Int16Array, 'band-coeffs' + k, strips.reduce((n, t) => n + t.components[k].coeffs.length, 0));
    let at = 0;
    for (const t of strips) { coeffs.set(t.components[k].coeffs, at); at += t.components[k].coeffs.length; }
    return {...c, rows: strips.reduce((n, t) => n + t.components[k].rows, 0), coeffs};
  });
  const out = {...first, height: strips.reduce((n, t) => n + t.height, 0), components};
  if (first.cfl) {
    const join = key => { const a = new Int8Array(strips.reduce((n, t) => n + t.cfl[key].length, 0)); let at = 0; for (const t of strips) { a.set(t.cfl[key], at); at += t.cfl[key].length; } return a; };
    out.cfl = {...first.cfl, x: join('x'), b: join('b')};
  }
  if (first.nonZero) out.nonZero = first.nonZero.map((_, c) => { const a = new Uint8Array(strips.reduce((n, t) => n + t.nonZero[c].length, 0)); let at = 0; for (const t of strips) { a.set(t.nonZero[c], at); at += t.nonZero[c].length; } return a; });
  return out;
}

function bandedLook(data, width, height, probe, check) {
  const rows = 64, stream = s2Stream({rgba: data}, width, height, 1), strips = new Map();
  const strip = at => { let t = strips.get(at); if (!t) strips.set(at, t = probe.band(at, Math.min(height, at + 64), false)); return t; };
  try {
    for (let y = 0; y < height; y += rows) {
      const y1 = Math.min(height, y + rows), b0 = Math.max(0, y - 64), b1 = Math.min(height, y1 + 64);
      for (const at of strips.keys()) if (at < b0) strips.delete(at);
      const band = probe.splittable === false ? probe.band(b0, b1, true) : joinedBand(Array.from({length: Math.ceil((b1 - b0) / 64)}, (_, i) => strip(b0 + 64 * i)));
      for (let r = y; r < y1; r += 32) {
        const r1 = Math.min(y1, r + 32), skip = (r - b0) * width, count = (r1 - r) * width;
        const made = rebuildPicture(band, {views: true, sliceFrom: skip, sliceCount: count});
        stream.push(r, r1 - r, [made.sliced ? made.rgba : made.rgba.subarray(skip * 4, (skip + count) * 4)]);
      }
      check();
    }
    return stream.finish()[0];
  } finally { stream.release(); }
}

export function stillFloorNow(intent, picture, decision, signal) {
  const check = () => { if (signal?.aborted) throw signal.reason; };
  const {data, width, height} = picture, top = NATIVE_STILL_CALIBRATION.maximumLossy, memo = {};
  const T = measuredLook(intent);
  const whole = {pixels: data, x: 0, y: 0, width, height};
  const look = (d, win) => {
    const probes = floorProbes(data, width, height, d, memo);
    if (!probes.length) return Infinity;
    let s = Infinity, reference = null;
    for (const p of probes) {
      s = Math.min(s, win === whole && p.band ? bandedLook(data, width, height, p, check) : windowLook(reference ??= refOf(win, false), win, p.image(win), false));
      check();
    }
    return s;
  };
  const effFiltered = d => d.quality >= 85 ? d.lowFilteredQuality ?? d.quality - 0.5 : d.lowFilteredQuality;
  const read = decision.windowRead, same = read && Math.abs(read.quality - decision.quality) < 0.006 && effFiltered(read) === effFiltered(decision);
  const vulnSide = width > 256 && height > 256 ? 256 : 128;
  const vulnWin = same || decision.calibratedWindow ? null : sharedVulnWindow(data, width, height, vulnSide) ?? photoWindow(data, width, height);
  if (!same && !vulnWin && !decision.calibratedWindow) return decision;
  if (!decision.calibratedWindow && (same ? read.score : look(decision, vulnWin)) >= T + FLOOR.margin) return decision;
  if (typeof data.rect === 'function') readEach(Array.from({length: Math.ceil(height / 32)}, (_, k) => () => data.rect(0, k * 32, width, 1)));
  const {lowFilteredOther: _o, lowBoth: _b, windowRead: _r, ...measured} = decision;
  let d = measured, score = look(d, whole);
  if (score >= T) {
    let best = decision, cur = d, reading = score;
    for (let step = 0; step < (decision.landSteps ?? 0) && reading > T + 0.6; step++) {
      const slope = Math.max(0.5, 0.9 + 0.02 * (cur.quality - 70)), fall = (reading - (T + 0.3)) / slope;
      const lower = {...cur, quality: Math.round((cur.quality - fall) * 100) / 100,
        ...(cur.lowFilteredQuality !== undefined && {lowFilteredQuality: Math.round((cur.lowFilteredQuality - fall) * 100) / 100})};
      if (!(lower.quality > 8)) break;
      const next = look(lower, whole);
      if (!(next >= T + LAND_KEEP)) break;
      best = cur = lower; reading = next;
    }
    data.ahead?.(0, 0); return best;
  }
  for (let step = 0; score < T && step < FLOOR.steps && d.quality < top; step++) {
    const rise = Math.min(top, d.quality + (T + FLOOR.aim - score) / Math.max(0.5, 0.9 + 0.02 * (d.quality - 70))) - d.quality;
    d = {...d, quality: Math.round((d.quality + rise) * 100) / 100,
      ...(d.lowFilteredQuality !== undefined && {lowFilteredQuality: Math.min(top, Math.round((d.lowFilteredQuality + rise) * 100) / 100)})};
    score = look(d, whole);
  }
  data.ahead?.(0, 0);
  return score >= T || d.quality >= top ? d : {...d, quality: top, lowFilteredQuality: undefined};
}

export function stillFloorSync(intent, picture, decision, signal) {
  if (typeof document !== 'undefined' || !ensureKernels()) return null;
  try { return stillFloorNow(intent, picture, decision, signal); }
  finally { releaseRebuildKernels(); dropMetricPool(); }
}

export async function stillFloor(intent, picture, decision, signal) {
  if (signal?.aborted) throw signal.reason;
  await ready(() => { if (signal?.aborted) throw signal.reason; });
  try { return stillFloorNow(intent, picture, decision, signal); }
  finally { releaseRebuildKernels(); dropMetricPool(); }
}

function calibratedVulnMargin(intent, facts, wide) {
  const b = facts.blocks, gr = b ? b.slope50 - b.spread50 : 0.15;
  const coarseBias = b && b.spread10 > 0.30 && b.spread50 > 1.15 ? Math.min(1, (b.spread10 - 0.25) / 0.40) : 0;
  const spreadGap = b ? Math.max(0, Math.min(1.2, b.spread50 - b.spread10 - 1.5)) : 0;
  const grainLift = Math.max(-0.18, gr - 0.08) * (gr < 0.08 ? 1.8 : 1.75 + 2.4 * coarseBias);
  const lowQ = Math.max(0, (0.85 - intent) / 0.15) * (0.20 + 0.70 * coarseBias + ((facts.pixels ?? facts.width * facts.height) > 2e6 ? 0.45 : 0));
  const highQ = Math.max(0, (intent - 0.82) / 0.08) * (0.12 + 1.15 * Math.max(0, gr - 0.12) + 0.92 * spreadGap) +
    Math.max(0, (intent - 0.90) / 0.05) * (0.22 + 0.25 * coarseBias);
  return 0.18 + grainLift + lowQ + highQ + (wide ? 0.04 : 0) + (coarseBias > 0.2 ? 0.30 * coarseBias : 0);
}

function calibrateVulnWindow(intent, picture, decision, signal, wide) {
  const check = () => { if (signal?.aborted) throw signal.reason; };
  check();
  const {data, width, height} = picture, {facts} = decision, colorSpace = wide ? 'display-p3' : 'srgb';
  const whole = width * height <= 160000, side = Math.min(256, width & ~7 || width, height & ~7 || height);
  const win = whole ? {pixels: data, x: 0, y: 0, width, height}
    : (wide ? photoWindow(data, width, height, undefined, 0, 0, true, side) : sharedVulnWindow(data, width, height, side)) ?? photoWindow(data, width, height);
  if (!win) return decision;
  const refBudget = Math.min(8 << 20, uploadCacheBudget(width * height));
  const ref = refBudget > 0 ? ssimulacra2Reference(refOf(win, wide), win.width, win.height, {cacheBytes: refBudget >> 1, immutable: true}) : refOf(win, wide);
  const Tm = measuredTarget(measuredLook(intent)), aim = whole ? Tm + 0.20 : Tm + calibratedVulnMargin(intent, facts, wide);
  const mlp = facts.blocks ? qualityLanding(intent, wide, 3, facts) : {quality: decision.lowFilteredQuality ?? decision.quality, slope: 0.85};
  const memo = {};
  const atQ = q => {
    const rq = Math.round(q * 100) / 100;
    return wide ? {...decision, quality: rq, lowFilteredQuality: undefined}
      : {...decision, quality: Math.min(NATIVE_STILL_CALIBRATION.maximumLossy, Math.round((rq + 0.5) * 100) / 100), lowFilteredQuality: rq};
  };
  const evalAt = q => {
    const probes = windowProbes(data, width, height, atQ(q), 3, false, colorSpace, memo);
    if (!probes.length) return NaN;
    let s = Infinity;
    for (const p of probes) { s = Math.min(s, windowLook(ref, win, p.image(win), wide)); check(); }
    return s;
  };
  try {
    let lo = 8, hi = 99.2, loS = -Infinity, hiS = Infinity, prevQ = NaN, prevS = NaN;
    let q = Math.min(98.5, Math.max(15, Math.round(mlp.quality * 100) / 100)), settledQ = null;
    for (let i = 0; i < 3; i++) {
      const s = evalAt(q);
      if (!Number.isFinite(s)) return decision;
      if (s < aim) { if (q > lo) { lo = q; loS = s; } }
      else { if (q < hi) { hi = q; hiS = s; } }
      if (s >= aim - 0.10 && s <= aim + 0.25) { settledQ = q; break; }
      let nextQ;
      if (Number.isFinite(loS) && Number.isFinite(hiS) && hi > lo + 0.08) {
        const t = Math.max(0.12, Math.min(0.88, (aim - loS) / Math.max(0.05, hiS - loS)));
        nextQ = lo + t * (hi - lo);
      } else {
        const rawSlope = Number.isFinite(prevQ) && Math.abs(q - prevQ) > 0.1 ? (s - prevS) / (q - prevQ) : mlp.slope;
        const slope = rawSlope > 0.2 ? Math.min(2.5, rawSlope) : mlp.slope;
        nextQ = q + Math.max(-16, Math.min(16, (aim - s) / slope));
      }
      prevQ = q; prevS = s;
      nextQ = Math.max(lo === 8 ? 8 : lo + 0.06, Math.min(hi === 99.2 ? 99.2 : hi - 0.06, Math.round(nextQ * 100) / 100));
      if (Math.abs(nextQ - q) < 0.06) break;
      q = nextQ;
    }
    if (settledQ === null) {
      if (Number.isFinite(loS) && Number.isFinite(hiS)) {
        const t = Math.max(0, Math.min(1, (aim + 0.04 - loS) / Math.max(0.05, hiS - loS)));
        settledQ = Math.round((lo + t * (hi - lo)) * 100) / 100;
      } else if (Number.isFinite(hiS)) {
        settledQ = Math.max(8, Math.round((hi - Math.max(0, hiS - aim) / Math.max(0.45, mlp.slope)) * 100) / 100);
      } else {
        settledQ = Math.min(99.2, Math.round((lo + (aim - loS) / Math.max(0.35, mlp.slope)) * 100) / 100);
      }
    }
    return atQ(settledQ);
  } finally {
    ref?.release?.();
  }
}

const WIDE = Object.freeze({whole: 200000, exact: 0.6, hard: 0.6, keep: 0.5, aim: 0.3, down: 20, up: 10, lift: -2.4, least: 25, probes: 2, intent: [0.3, 0.92],
  side: [1280, 1920, 4096], q: [0.5, 0.7, 0.9], margin: [[1.5, 1.5, 1.5], [3.0, 1.9, 1.8], [5.8, 4.3, 3.5]]});
function wideMargin(longSide, intent) {
  const along = (at, v, x) => { if (x <= at[0]) return v[0]; for (let k = 1; k < at.length; k++) if (x <= at[k]) return v[k - 1] + (v[k] - v[k - 1]) * (x - at[k - 1]) / (at[k] - at[k - 1]); return v.at(-1); };
  const {side, q, margin} = WIDE, row = margin.map(m => along(q, m, intent));
  return along(side.map(Math.log2), row, Math.log2(Math.max(1, longSide)));
}

function wideStillWindow(intent, picture, decision, signal) {
  if (!(intent >= WIDE.intent[0] - 1e-9 && intent <= WIDE.intent[1] + 1e-9)) return decision;
  const check = () => { if (signal?.aborted) throw signal.reason; };
  check();
  const {data, width, height} = picture;
  const whole = width * height <= WIDE.whole, vulnSide = width > 256 && height > 256 ? 256 : 128;
  const vulnWin = whole ? {pixels: data, x: 0, y: 0, width, height} : photoWindow(data, width, height, undefined, 0, 0, true, vulnSide) ?? photoWindow(data, width, height);
  const hardWin = whole ? null : hardestCrop(data, width, height);
  if (!vulnWin) return decision;
  const T = measuredLook(intent), W = worstRegionFloor(T), margin = whole ? WIDE.exact : wideMargin(Math.max(width, height), intent), vulnRef = refOf(vulnWin, true), hardRef = hardWin ? refOf(hardWin, true) : null;
  const at = quality => ({...decision, quality: Math.round(quality * 100) / 100, lowFilteredQuality: undefined});
  const read = candidate => {
    const probes = windowProbes(data, width, height, candidate, 3, false, 'display-p3');
    if (!probes.length) return null;
    let vulnS = Infinity, hardS = Infinity;
    for (const p of probes) {
      vulnS = Math.min(vulnS, windowLook(vulnRef, vulnWin, p.image(vulnWin), true));
      if (hardWin) hardS = Math.min(hardS, windowLook(hardRef, hardWin, p.image(hardWin), true));
      check();
    }
    return {s: Math.min(vulnS - (T + margin), hardWin ? hardS - (W + WIDE.hard) : Infinity), v: vulnS - T};
  };
  const surplus = candidate => read(candidate)?.s ?? NaN;
  const slope = q => Math.max(0.65, 0.88 + 0.02 * (q - 70));
  const q0 = decision.quality, floor = Math.max(WIDE.least, q0 - WIDE.down), top = Math.min(NATIVE_STILL_CALIBRATION.maximumLossy, q0 + WIDE.up), r0 = read(decision), s0 = r0 ? r0.s : NaN;
  if (!Number.isFinite(s0)) return decision;
  if (whole ? s0 < 0 : r0.v < WIDE.lift) {
    let q = q0, s = s0;
    for (let i = 0; i < WIDE.probes && s < 0 && q < top; i++) {
      q = Math.min(top, q + (WIDE.aim - s) / slope(q) + 0.1);
      const next = surplus(at(q));
      if (!Number.isFinite(next)) return decision;
      s = next;
    }
    return at(q);
  }
  if (!(s0 > WIDE.keep) || q0 <= floor + 0.25) return decision;
  let pass = {q: q0, s: s0}, fail = null;
  for (let i = 0; i < WIDE.probes && pass.s > WIDE.aim + 0.1; i++) {
    let q = fail ? pass.q + (fail.q - pass.q) * (pass.s - WIDE.aim) / (pass.s - fail.s) : pass.q - (pass.s - WIDE.aim) / slope(pass.q);
    q = Math.max(floor, Math.min(pass.q - 0.35, q));
    if (!(q < pass.q - 0.3)) break;
    const s = surplus(at(q));
    if (!Number.isFinite(s)) break;
    if (s >= 0) pass = {q, s}; else fail = {q, s};
  }
  return pass.q === q0 ? decision : at(pass.q);
}

function stillWindowNow(intent, picture, decision, effort, signal, wide, cap = null, sharedState = null) {
  const reads = new Map(), out = stillWindowRead(intent, picture, decision, effort, signal, wide, cap, sharedState, reads);
  const score = reads.get(out);
  return score === undefined ? out : {...out, windowRead: {quality: out.quality, lowFilteredQuality: out.lowFilteredQuality, score}};
}

function stillWindowRead(intent, picture, decision, effort, signal, wide, cap, sharedState, reads) {
  if (wide) return wideStillWindow(intent, picture, decision, signal);
  if (decision?.calibratedWindow) return calibrateVulnWindow(intent, picture, decision, signal, false);
  const model = modelStart(decision, intent);
  if (!usesRegionalCalibration(intent, effort) && !model) return retainedStillWindow(intent, picture, decision, effort, signal, sharedState);
  const unread = () => {
    if (!model) return decision;
    const today = todayOf(decision);
    return usesRegionalCalibration(intent, effort) || ownedStillWindow(today, effort, intent)
      ? stillWindowNow(intent, picture, today, effort, signal, wide, cap, sharedState) : today;
  };
  const check = () => { if (signal?.aborted) throw signal.reason; };
  check();
  const {data, width, height} = picture, {facts} = decision, colorSpace = wide ? 'display-p3' : 'srgb';
  const q1 = decision.quality;
  const minDownQ = model ? Math.max(MODEL.least, q1 - 7.0) : Math.max(intent * 100 - 1.5, q1 - (wide ? 9.5 : 7.0));
  const noDownRoom = q1 <= minDownQ + 0.25 || q1 - minDownQ < 0.35;
  if (wide && noDownRoom) return decision;
  const cappedAbove = !!(cap && cap.lowFilteredQuality === undefined && Math.min(q1, Math.round(q1 * 100) / 100) >= cap.quality - 0.011);
  if (cappedAbove && noDownRoom) return unread();

  const isLarge = largePhotograph(facts);
  const vulnSide = width > 256 && height > 256 ? 256 : 128;
  const vulnWin = sharedVulnWindow(data, width, height, vulnSide) ?? photoWindow(data, width, height);
  if (!vulnWin) return unread();

  const T = measuredLook(intent), W = worstRegionFloor(T);
  const top = NATIVE_STILL_CALIBRATION.maximumLossy;
  const gray = facts.chroma < 2 && (facts.paletteSlots ?? 0) > 64 ? 2 * Math.max(0, Math.min(1, (0.8 - intent) / 0.1)) : 0;
  const liftMargin = isLarge ? largeMargin(intent) + gray : 2.3 + Math.max(0, 12 - facts.gradient) / 8;

  const downGlobalMargin = (vulnSide === 256 ? 2.45 : 2.85) + gray + (wide ? 0.55 : 0) + Math.max(0, 12 - facts.gradient) / 4;
  const downHardMargin = 2.35 + (wide ? 0.45 : 0);

  const refBudget = Math.min(8 << 20, uploadCacheBudget(width * height));
  const makeRef = win => refBudget > 0
    ? ssimulacra2Reference(refOf(win, wide), win.width, win.height, {cacheBytes: refBudget >> 1, immutable: true})
    : refOf(win, wide);
  const vulnRef = makeRef(vulnWin);
  let hardWin, hardRef = null, hardReady = false;
  const ensureHard = () => {
    if (!hardReady) {
      hardWin = hardestCrop(data, width, height);
      hardRef = hardWin ? makeRef(hardWin) : null;
      hardReady = true;
    }
    return hardWin;
  };
  const probeEffort = 3, memo = {};
  let smoothRead;
  try {
    const at = quality => {
      const qRound = Math.round(quality * 100) / 100;
      const {lowFilteredQuality: _, ...rest} = decision;
      const lowFilteredQuality = wide ? undefined : filteredStillQuality(intent, facts, qRound, probeEffort);
      return {...rest, quality: qRound, ...(lowFilteredQuality !== undefined && {lowFilteredQuality})};
    };
    const probesFor = d => {
      const smooth = !wide && smoothDecides(d) && (smoothRead ??= smoothPhoto(data, width, height, facts));
      return windowProbes(data, width, height, d, probeEffort, smooth, colorSpace, memo);
    };
    const evalVuln = probes => {
      let vulnS = Infinity;
      for (const p of probes) {
        vulnS = Math.min(vulnS, windowLook(vulnRef, vulnWin, p.image(vulnWin), wide));
        check();
      }
      return vulnS;
    };
    const evalHard = probes => {
      const hw = ensureHard();
      if (!hw) return Infinity;
      let hardS = Infinity;
      for (const p of probes) {
        hardS = Math.min(hardS, windowLook(hardRef, hw, p.image(hw), wide));
        check();
      }
      return hardS;
    };

    const p1 = probesFor(decision);
    if (!p1.length) return unread();
    const vuln1 = evalVuln(p1);
    if (!Number.isFinite(vuln1)) return unread();
    let hard1;
    if (model) {
      const b = facts.blocks;
      hard1 = evalHard(p1);
      const margin = isLarge ? largeMargin(intent) + gray : b && b.slope50 - b.spread50 >= NATIVE_STILL_CALIBRATION.windowGrain
        ? liftMargin : MODEL.lift;
      if (vuln1 < T + margin || hardWin && hard1 < W + MODEL.hard) return unread();
      const {today: _, ...kept} = decision; decision = kept;
    }
    reads.set(decision, vuln1);
    if (sharedState && !wide && vulnSide === LARGE.side) {
      sharedState.vuln1 = {quality: decision.quality, lowFilteredQuality: decision.lowFilteredQuality, score: vuln1, memo};
    }

    const b = facts.blocks, wantsLift = !wide && (isLarge || b && b.slope50 - b.spread50 >= NATIVE_STILL_CALIBRATION.windowGrain);
    const liftTarget = T + liftMargin;
    if (wantsLift && vuln1 < liftTarget && q1 < top) {
      if (cappedAbove) return decision;
      const slope = Math.max(0.5, 0.9 + 0.02 * (q1 - 70));
      if (isLarge) {
        const q2 = Math.min(top, q1 + Math.min(LARGE.step, (liftTarget - vuln1) / slope));
        const p2 = probesFor(at(q2));
        if (!p2.length) return decision;
        const vuln2 = evalVuln(p2);
        const rise = Math.max(0.05, (vuln2 - vuln1) / Math.max(0.05, q2 - q1));
        return at(Math.min(top, (vuln2 >= liftTarget ? q1 + (liftTarget - vuln1) / rise : q2 + (liftTarget - vuln2) / rise) + 0.15));
      }
      return at(Math.min(top, q1 + (liftTarget - vuln1) / slope + 0.15));
    }
    const vulnSurplus = vuln1 - (T + downGlobalMargin);
    if (wide && !(vulnSurplus > 0.8)) return decision;

    hard1 ??= evalHard(p1);
    if (!wide && hardWin && hard1 < W + 1.2 && q1 < top) {
      if (cappedAbove) return decision;
      const slope = Math.max(0.5, 0.85 + 0.02 * (q1 - 70));
      return at(Math.min(top, q1 + (W + 1.4 - hard1) / slope));
    }

    const surplus = Math.min(vulnSurplus, hardWin ? hard1 - (W + downHardMargin) : Infinity);
    if (!(surplus > 0.8) || noDownRoom) return decision;

    const estSlope = Math.max(0.65, 0.88 + 0.02 * (q1 - 70));
    const q2 = Math.max(minDownQ, Math.round((q1 - Math.min(8.5, surplus / estSlope)) * 100) / 100);
    if (q1 - q2 < 0.35) return decision;
    const cand2 = at(q2), p2 = probesFor(cand2);
    if (!p2.length) return decision;
    const vuln2 = evalVuln(p2), hard2 = evalHard(p2);
    const s2Surplus = Math.min(vuln2 - (T + downGlobalMargin), hardWin ? hard2 - (W + downHardMargin) : Infinity);
    reads.set(cand2, vuln2);
    if (s2Surplus >= 0) return cand2;

    const rise = Math.max(0.3, (surplus - s2Surplus) / Math.max(0.1, q1 - q2));
    const q3 = Math.max(minDownQ, Math.min(q1, q2 + (0.45 - s2Surplus) / rise));
    if (q1 - q3 < 0.35) return decision;
    const cand3 = at(q3), p3 = probesFor(cand3);
    if (!p3.length) return decision;
    const hardFloor3 = W + downHardMargin - 0.15, vulnFloor3 = T + downGlobalMargin - 0.15;
    if (hardWin) {
      for (const p of p3) {
        const hs = windowLook(hardRef, hardWin, p.image(hardWin), wide);
        check();
        if (!(hs >= hardFloor3)) return decision;
      }
    }
    let vuln3 = Infinity;
    for (const p of p3) {
      const vs = windowLook(vulnRef, vulnWin, p.image(vulnWin), wide);
      check();
      if (!(vs >= vulnFloor3)) return decision;
      vuln3 = Math.min(vuln3, vs);
    }
    reads.set(cand3, vuln3);
    return cand3;
  } finally {
    vulnRef?.release?.();
    hardRef?.release?.();
  }
}

function retainedStillWindow(intent, picture, decision, effort, signal, sharedState = null) {
  const check = () => { if (signal?.aborted) throw signal.reason; };
  check();
  const {data, width, height} = picture, {facts} = decision;
  if (largePhotograph(facts)) return retainedLargeWindow(intent, picture, decision, effort, check, sharedState);
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

function retainedLargeWindow(intent, picture, decision, effort, check, sharedState = null) {
  const {data, width, height} = picture, {facts} = decision;
  const window = sharedVulnWindow(data, width, height, LARGE.side);
  if (!window) return decision;
  const gray = facts.chroma < 2 && (facts.paletteSlots ?? 0) > 64 ? 2 * Math.max(0, Math.min(1, (0.8 - intent) / 0.1)) : 0;
  const target = measuredLook(intent) + largeMargin(intent, effort) + gray, top = NATIVE_STILL_CALIBRATION.maximumLossy;
  const slope = q => Math.max(0.5, 0.9 + 0.02 * (q - 70));
  const reused = sharedState?.vuln1 && effort === 3 &&
    sharedState.vuln1.quality === decision.quality && sharedState.vuln1.lowFilteredQuality === decision.lowFilteredQuality
    ? sharedState.vuln1 : null;
  const q1 = decision.quality;
  if (reused && (!(target > reused.score) || !Number.isFinite(reused.score) || q1 >= top)) return decision;
  const refBudget = Math.min(8 << 20, uploadCacheBudget(width * height));
  const reference = refBudget > 0
    ? ssimulacra2Reference(refOf(window, false), window.width, window.height, {cacheBytes: refBudget, immutable: true})
    : refOf(window, false);
  const memo = reused?.memo ?? {};
  let smoothRead;
  try {
    const read = d => {
      const smooth = smoothDecides(d) && (smoothRead ??= smoothPhoto(data, width, height, facts));
      let score = Infinity;
      for (const probe of windowProbes(data, width, height, d, effort, smooth, 'srgb', memo)) {
        score = Math.min(score, windowLook(reference, window, probe.image(window), false));
        check();
      }
      return score;
    };
    const at = quality => {
      const {lowFilteredQuality: _, ...rest} = decision, lowFilteredQuality = filteredStillQuality(intent, facts, quality, effort);
      return {...rest, quality, ...(lowFilteredQuality !== undefined && {lowFilteredQuality})};
    };
    const s1 = reused ? reused.score : read(decision);
    if (!(target > s1) || !Number.isFinite(s1) || q1 >= top) return decision;
    let qa = q1, sa = s1, qb = Math.min(top, q1 + Math.min(LARGE.step, (target - s1) / slope(q1))), sb = read(at(qb));
    const line = () => { const rise = Math.max(0.05, (sb - sa) / (qb - qa)); return sb >= target ? qa + (target - sa) / rise : qb + (target - sb) / rise; };
    if (sb < target && qb < top && line() > qb + LARGE.step) {
      qa = qb; sa = sb; qb = Math.min(top, qb + Math.min(LARGE.step, (target - sb) / slope(qb))); sb = read(at(qb));
    }
    return at(Math.min(top, qb + LARGE.step, line() + 0.15));
  } finally {
    reference?.release?.();
  }
}
