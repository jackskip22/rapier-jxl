import {settleIntent, qualityForIntent, gradientRows, blockFacts, exactlyPredicted, softEdges, qualityFor, fixedQuality, regionQuality, ceilingFor, smallReading} from './intent-quality.mjs';
import {inspectPixels, shapeResult, shapeScanNext, shapeFloors} from '../lossless.mjs';
import {journalFact, FACTS} from '../step-journal.mjs';
import {screenLike} from '../screen-samples.mjs';
import {preferXYB} from '../photo-preference.mjs';

export const LOW_INTENT_CALIBRATION = Object.freeze({
  q: [0.5, 0.8, 0.92],
  palettePhoto: [82, 88, 95],
  smallestScored: 8,
  minimumQuality: 64,
  maximumLossy: 99.99,
});

const nativeRgb = picture => (picture.data instanceof Uint8Array || picture.data instanceof Uint8ClampedArray) &&
  ['srgb', 'display-p3'].includes(picture.colorSpace ?? 'srgb') && picture.icc === undefined && picture.colorEncoding === undefined &&
  picture.orientation === undefined && picture.extraChannels === undefined &&
  (picture.bitDepth ?? 8) === 8 && (picture.sampleFormat ?? 'uint') === 'uint' &&
  (picture.transferFunction ?? 'srgb') === 'srgb' && !picture.alphaPremultiplied &&
  (picture.intensityTarget ?? 255) === 255;

export const settledFacts = /* @__PURE__ */ new WeakMap();
export const lowIntentEligible = picture => nativeRgb(picture) && (picture.colorSpace ?? 'srgb') === 'srgb';

export function lowIntentFacts(picture, {wide = false} = {}) {
  if (!(wide ? nativeRgb(picture) && picture.colorSpace === 'display-p3' : lowIntentEligible(picture))) return {eligible: false};
  const settled = settledFacts.get(picture.data);
  if (settled) return settled;
  const {data, width, height} = picture, carried = carriedFacts(data, width * height);
  const shape = carried ? shapeResult(structuredClone(carried.scan)) : inspectPixels(data, width, height);
  const stats = carried ? structuredClone(carried.gradient) : {sum: 0, n: 0};
  if (!carried) gradientRows(stats, data, width, height, 1, height);
  const chroma = stats.n ? stats.chroma / stats.n : 0, screen = screenLike(data, width, height);
  const slots = shape.palette?.colours.length ?? null;
  const greyPhoto = !screen && chroma < 2 && Math.min(width, height) >= 128 && (slots ?? 0) > 64;
  return {eligible: true, width, height, pixels: width * height, shorterSide: Math.min(width, height),
    gradient: stats.n ? stats.sum / stats.n : 0, blocks: blockFacts(stats), chroma, palette: Boolean(shape.palette) && !greyPhoto, paletteSlots: slots, alpha: shape.alpha,
    visibleShare: stats.n ? 1 - stats.clear / stats.n : 1,
    smooth: exactlyPredicted(stats),
    soft: softEdges(stats),
    screenLike: screen, preferXYB: Math.min(width, height) < 128 || preferXYB(data, width, height)};
}

function carriedFacts(data, pixels) {
  const facts = journalFact(data, FACTS), floor = shapeFloors.get(data);
  const scan = facts?.scans && !floor?.alpha ? facts.scans[floor?.colour === 3 ? 1 : 0] : null;
  return scan && facts.gradient && shapeScanNext(scan) >= pixels ? {scan, gradient: facts.gradient} : null;
}

function anchor(q, values) {
  const knots = LOW_INTENT_CALIBRATION.q;
  if (q <= knots[0]) return values[0];
  if (q >= knots.at(-1)) return values.at(-1);
  const index = q <= knots[1] ? 0 : 1;
  return values[index] + (values[index + 1] - values[index]) * (q - knots[index]) / (knots[index + 1] - knots[index]);
}

export function lowIntentDecision(q, picture, {exactAllowed = true, facts: suppliedFacts} = {}) {
  if (!exactAllowed) return {quality: qualityForIntent(q, picture), route: 'existing', policyClass: 'featured'};
  if (q >= 1) return {quality: qualityForIntent(q, picture), route: 'exact', policyClass: 'intent-one'};
  const facts = suppliedFacts ?? lowIntentFacts(picture);
  if (!facts.eligible) return {quality: qualityForIntent(q, picture), route: 'existing', policyClass: 'other-description'};
  const region = regionQuality(q, picture.data, picture.width, {x: 0, y: 0, width: picture.width, height: picture.height});
  const reading = photoReading(q, facts, region);
  if (facts.shorterSide < LOW_INTENT_CALIBRATION.smallestScored)
    return {quality: 100, route: 'exact', policyClass: 'tiny-pixels', facts, reading};
  if (facts.screenLike)
    return {quality: 100, route: 'exact', policyClass: 'screen', facts, reading};
  if (facts.palette && !facts.preferXYB)
    return {quality: 100, route: 'exact', policyClass: 'non-photo-palette', facts, reading};
  return photoDecision(q, facts, reading);
}

function photoReading(q, facts, region) {
  const old = qualityFor(q, facts.gradient), fixed = fixedQuality(q);
  const base = Math.max(LOW_INTENT_CALIBRATION.minimumQuality, Math.min(99.9, Math.max(old, fixed, region) + 1));
  return {old, fixed, region, base};
}

function photoDecision(q, facts, reading) {
  let floor = 0, policyClass = 'ordinary-photo';
  if (facts.shorterSide < 128) return {quality: Math.min(LOW_INTENT_CALIBRATION.maximumLossy, smallReading(q, facts.shorterSide)),
    route: 'photo', policyClass: facts.shorterSide < 64 ? 'photo-below64' : 'photo-below128', facts, reading};
  if (facts.palette && facts.preferXYB) {
    floor = anchor(q, LOW_INTENT_CALIBRATION.palettePhoto); policyClass = 'photographic-palette';
  } else if (facts.shorterSide < 256) {
    return {quality: Math.min(LOW_INTENT_CALIBRATION.maximumLossy, smallReading(q, facts.shorterSide, facts.gradient)),
      route: 'photo', policyClass: 'photo-below256', facts, reading};
  }
  const ceiling = policyClass === 'ordinary-photo' && facts.preferXYB && !facts.palette ? ceilingFor(q) : Infinity;
  return {quality: Math.min(LOW_INTENT_CALIBRATION.maximumLossy, ceiling, Math.max(reading.base, floor)),
    route: 'photo', policyClass, facts, reading};
}

export function lowPhotoReading(q, picture, baseQuality, sampling) {
  if (q >= 1 || baseQuality >= 100 || !nativeRgb(picture)) return baseQuality;
  const p3 = picture.colorSpace === 'display-p3', [, lower, upper] = LOW_INTENT_CALIBRATION.q;
  const t = Math.min(1, Math.max(0, (q - lower) / (upper - lower)));
  if (!p3 && t === 0) return baseQuality;
  const chroma = !preferXYB(picture.data, picture.width, picture.height, sampling);
  return Math.min(LOW_INTENT_CALIBRATION.maximumLossy, baseQuality + (p3 ? t : 0) + (chroma ? p3 ? 1 : t : 0));
}

const P3_STILL = Object.freeze({offset: -1, slope: 50, cap: Object.freeze({q: [0.8, 0.84, 0.88, 0.9, 0.92], over: [0.4, 0.6, 0.6, 0.5, 0]}),
  large: Object.freeze({q: [0.5, 0.8, 0.88, 0.92], offset: [0.8, 1.4, 1.8, 0]})});
const knots = (q, at, values) => {
  if (q <= at[0]) return values[0];
  for (let k = 1; k < at.length; k++) if (q <= at[k]) return values[k - 1] + (values[k] - values[k - 1]) * (q - at[k - 1]) / (at[k] - at[k - 1]);
  return values.at(-1);
};
export function p3StillQuality(q, reading, large = false) {
  const {cap, large: big} = P3_STILL, offset = large ? knots(q, big.q, big.offset) : P3_STILL.offset;
  return Math.min(reading + offset, q * 100 + knots(q, cap.q, cap.over) + P3_STILL.slope * Math.max(0, cap.q[0] - q));
}

const BUMP_STEPS = [[100, 8, 4], [250, 6, 3], [Infinity, 3, 2]];
const captureFixed = intent => {
  const q = intent * 100;
  return q >= 76 ? q - 3 : q >= 68 ? q - (q - 68) * 3 / 8 : q >= 60 ? q + (68 - q) / 2 : q + 4;
};

const CHROMA_SMOOTH = [2.5, 6.5];
function captureAimedDelta(data, stride, rect, side, offGrid, smooth = true) {
  const pageH = stride > 0 ? Math.floor(data.length / (stride * 4)) : 0;
  const x0 = Math.max(0, rect.x), y0 = Math.max(0, rect.y);
  const w = Math.min(stride - x0, rect.width), h = Math.min(pageH - y0, rect.height);
  if (w <= 0 || h <= 0) return [0, 0];
  const nx = Math.min(w, 32), ny = Math.min(h, 32), splitQuad = nx >= 16 && ny >= 16;
  const qY = [0, 0, 0, 0], qC = [0, 0, 0, 0], qN = [0, 0, 0, 0];
  let sumY = 0, sumC = 0, sumHiSat = 0, sumG = 0, sumS4 = 0, sumD2 = 0;
  let n = 0, nG = 0, nS4 = 0, nD2 = 0, nFlat = 0;
  for (let iy = 0; iy < ny; iy++) {
    const y = y0 + Math.floor((iy + 0.5) * h / ny);
    const y1 = Math.min(y0 + h - 1, y + 1), ym1 = Math.max(y0, y - 1), y4 = Math.min(y0 + h - 1, y + 4);
    const qRow = iy * 2 >= ny ? 2 : 0;
    for (let ix = 0; ix < nx; ix++) {
      const x = x0 + Math.floor((ix + 0.5) * w / nx);
      const i = (y * stride + x) * 4;
      if (data[i + 3] < 128) continue;
      const x1 = Math.min(x0 + w - 1, x + 1), xm1 = Math.max(x0, x - 1), x4 = Math.min(x0 + w - 1, x + 4);
      const qi = qRow + (ix * 2 >= nx ? 1 : 0);
      const r = data[i], g = data[i + 1], b = data[i + 2];
      const lum = 0.299 * r + 0.587 * g + 0.114 * b, chr = Math.abs(r - g) + Math.abs(b - g);
      const sr = chr / (lum + 24);
      sumY += lum; sumC += chr; n++;
      if (sr > 0.50) sumHiSat += Math.min(1, (sr - 0.50) / 0.40);
      qY[qi] += lum; qC[qi] += chr; qN[qi]++;
      const ir = (y * stride + x1) * 4, id = (y1 * stride + x) * 4;
      if ((x1 > x || y1 > y) && data[ir + 3] >= 128 && data[id + 3] >= 128) {
        const gr = (Math.abs(r - data[ir]) + Math.abs(g - data[ir + 1]) + Math.abs(b - data[ir + 2])
          + Math.abs(r - data[id]) + Math.abs(g - data[id + 1]) + Math.abs(b - data[id + 2])) / 6;
        sumG += gr; nG++;
      }
      const ir4 = (y * stride + x4) * 4, id4 = (y4 * stride + x) * 4;
      if ((x4 > x || y4 > y) && data[ir4 + 3] >= 128 && data[id4 + 3] >= 128) {
        const s4 = (Math.abs(r - data[ir4]) + Math.abs(g - data[ir4 + 1]) + Math.abs(b - data[ir4 + 2])
          + Math.abs(r - data[id4]) + Math.abs(g - data[id4 + 1]) + Math.abs(b - data[id4 + 2])) / 6;
        sumS4 += s4; nS4++;
        if (s4 < 8) nFlat++;
      }
      if (x > x0 && x < x0 + w - 1 && y > y0 && y < y0 + h - 1) {
        const il = (y * stride + xm1) * 4, iu = (ym1 * stride + x) * 4;
        if (data[il + 3] >= 128 && data[iu + 3] >= 128 && data[ir + 3] >= 128 && data[id + 3] >= 128) {
          const d2 = (Math.abs(data[il] - 2 * r + data[ir]) + Math.abs(data[il + 1] - 2 * g + data[ir + 1]) + Math.abs(data[il + 2] - 2 * b + data[ir + 2])
            + Math.abs(data[iu] - 2 * r + data[id]) + Math.abs(data[iu + 1] - 2 * g + data[id + 1]) + Math.abs(data[iu + 2] - 2 * b + data[id + 2])) / 6;
          sumD2 += d2; nD2++;
        }
      }
    }
  }
  if (!n) return [0, 0];
  const Y = sumY / n, C = sumC / n, sat = C / (Y + 24), hiSat = sumHiSat / n;
  const G = nG ? sumG / nG : 0, S4 = nS4 ? sumS4 / nS4 : 0, D2 = nD2 ? sumD2 / nD2 : 0;
  if (G < 0.5 && S4 < 0.5) return [0, 0];
  const flat = nS4 ? nFlat / nS4 : 0;
  let maxQS = sat;
  if (splitQuad) for (let qi = 0; qi < 4; qi++) if (qN[qi] >= 16) {
    const qs = (qC[qi] / qN[qi]) / (qY[qi] / qN[qi] + 24);
    if (qs > maxQS) maxQS = qs;
  }
  const d2Ratio = D2 / (G + 0.4), gs4Ratio = G / (S4 + 0.4);

  const darkSpan = Math.max((14.5 - S4) / 6.0, (flat - 0.58) / 0.22);
  const darkTerm = Math.min(1, Math.max(0, (89.5 - Y) / 35)) * Math.min(1, Math.max(0, darkSpan));

  const satG = Math.min(1, Math.max(0, (sat - 0.58) / 0.36));
  const satHi = Math.min(1, Math.max(0, (hiSat - 0.42) / 0.38));
  const satDarkQ = Y < 92 ? 0.75 * Math.min(1, Math.max(0, (maxQS - 0.66) / 0.28)) : 0;
  const chromaTerm = Math.max(satG, satHi, satDarkQ) * (smooth ? Math.min(1, Math.max(0, (G - CHROMA_SMOOTH[0]) / (CHROMA_SMOOTH[1] - CHROMA_SMOOTH[0]))) : 1);

  const aliasCurv = Math.min(1, Math.max(0, (d2Ratio - 1.50) / 0.16));
  const aliasFine = Math.min(1, Math.max(0, (gs4Ratio - 0.52) / 0.12));
  const aliasMask = Math.min(1, Math.max(0, (flat - 0.18) / 0.15)) * Math.min(1, Math.max(0, (G - 6.5) / 3.5));
  const aliasTerm = aliasCurv > 0 && aliasFine > 0 && aliasMask > 0 ? Math.min(1, Math.sqrt(aliasCurv * aliasFine) * aliasMask * 1.6) : 0;

  if (darkTerm > 0 || chromaTerm > 0 || aliasTerm > 0) {
    const smallScale = side < 100 ? (sat > 0.85 ? 0.85 : 0.45) : 1.0;
    const pos80 = smallScale * Math.min(5.2, 5.6 * darkTerm + 4.4 * chromaTerm + 3.4 * aliasTerm);
    const pos92 = smallScale * Math.min(3.6, 3.7 * darkTerm + 3.1 * chromaTerm + 2.1 * aliasTerm);
    const noOff = !offGrid && darkTerm > 0.35 ? 1.8 : 0;
    return [pos80 + noOff, pos92 + 0.5 * noOff];
  }

  const gY = Math.min(1, Math.max(0, (Y - 48) / 36));
  const gs4Top = side < 64 ? 0.62 : 0.49, d2Top = side < 64 ? 1.70 : 1.54;
  const gFreq = Math.min(1, Math.max(0, (d2Top - d2Ratio) / 0.20), Math.max(0, (gs4Top - gs4Ratio) / 0.10));
  const gSat = Math.min(1, Math.max(0.25, (0.50 - sat) / 0.22), Math.max(0.25, (0.28 - hiSat) / 0.18));
  const lowMask = S4 < 15 && flat >= 0.48;
  const over = lowMask ? 0 : Math.min(1, Math.max(0, (0.42 - gs4Ratio) / 0.08)) * Math.min(1, Math.max(0, (1.22 - d2Ratio) / 0.22));
  const flatTaper80 = lowMask ? 0.30 : Math.min(1, Math.max(0.45, (0.80 - flat) / 0.30));
  const flatTaper92 = side >= 250 && flat > 0.55 && over === 0 ? 0 : lowMask ? 0.30 : Math.min(1, Math.max(0.36, (0.76 - flat) / 0.28));
  const e80 = gY * gFreq * gSat * flatTaper80, e92 = gY * gFreq * gSat * flatTaper92;
  const maxNeg80 = (side < 64 ? 5.0 : side < 140 ? 4.1 : side < 250 ? 4.8 : 4.7) + (side >= 180 ? 2.2 : 0) * over;
  const maxNeg92 = (side < 64 ? 2.5 : side < 100 ? 1.35 : side < 250 ? 1.70 : 1.75) + (side >= 180 ? 0.75 : 0) * over;
  return [-e80 * maxNeg80, -e92 * maxNeg92];
}

export function lowCaptureReading(q, data, width, rect, offGrid = false, colorSpace = 'srgb', smooth = true, ...rest) {
  const base = regionQuality(q, data, width, rect, offGrid);
  const picture = {data, width: rect.width, height: rect.height, colorSpace};
  const sampling = {stride: width, origin: rect.y * width + rect.x};
  const side = Math.min(rect.width, rect.height);
  if (q >= 1 || base >= 100 || !nativeRgb(picture) || side >= 16 && rest.some(m => m?.probed === true))
    return lowPhotoReading(q, picture, base, sampling);
  const [d80, d92] = captureAimedDelta(data, width, rect, side, offGrid, smooth);
  if (d80 === 0 && d92 === 0) return lowPhotoReading(q, picture, base, sampling);
  const [, stepLo, stepHi] = BUMP_STEPS.find(([under]) => side < under);
  const [, lower, upper] = LOW_INTENT_CALIBRATION.q;
  const t = Math.min(1, Math.max(0, (q - lower) / (upper - lower)));
  const raw = captureFixed(q) + stepLo + t * (stepHi - stepLo) + (offGrid ? 2 - t : 0);
  const aimed = Math.min(LOW_INTENT_CALIBRATION.maximumLossy, Math.max(1, raw + d80 + t * (d92 - d80)));
  return lowPhotoReading(q, picture, aimed, sampling);
}

export function lowIntentQuality(q, picture, options) { return lowIntentDecision(q, picture, options).quality; }

export function settleLowIntent(codec, picture, {exactAllowed = true} = {}) {
  const effort = codec.effort ?? 3;
  if (codec.qualityIntent === undefined || effort < 1 || effort > 4 || !exactAllowed) return settleIntent(codec, picture);
  const {qualityIntent, ...rest} = codec;
  const decision = lowIntentDecision(qualityIntent, picture);
  if (decision.route !== 'photo' || decision.facts?.palette) return settleIntent(codec, picture);
  return {...rest, quality: decision.quality, lowIntent: qualityIntent};
}
