// SPDX-License-Identifier: MIT
import {qualityFor, ceilingFor, smallReading, measuredNeed} from './intent-quality.mjs';
import {MEASURED_EFFORT} from '../effort-level.mjs';
import {LOW_INTENT_CALIBRATION} from './low-intent-quality.mjs';
import {largePhoto} from '../photo-low-settings.mjs';

export const NATIVE_STILL_CALIBRATION = Object.freeze({
  intent: Object.freeze([0.5, 0.8, 0.92]),
  ordinaryXYB: Object.freeze([79, 88, 96]),
  ordinaryOther: Object.freeze([70, 82, 92]),
  texturedGradient: 16,
  largeMarginGradient: 7.5,
  largeMinimum: Object.freeze([48, 78, 92]),
  largeLowMargin: 4,
  maximumLossy: 99.99,
  exactIntent: 1,
  windowGrain: 0.36,
});

const GRAINY_OTHER = [70, 83, 95];

const LOW_NEED = Object.freeze({
  intent: [0.3, 0.4, 0.5, 0.6, 0.7, 0.74],
  rows: [[21.65, -8.649, 4.027, -0.314, 0.01, -17.088, -25.337, 25.024, 27.737],
    [38.16, -9.556, 3.355, -1.427, -0.465, -13.272, -27.348, 21.231, 32.257],
    [61.25, -2.522, 2.568, -2.565, -1.421, -10.276, -22.502, 15.285, 22.964],
    [68.92, -3.02, 2.481, -2.816, -1.331, -9.062, -18.968, 13.322, 20.174],
    [77.34, -1.731, 1.961, -2.876, -1.458, -7.43, -14.623, 10.55, 15.516],
    [82.23, -0.641, 1.627, -2.9, -1.63, -6.253, -12.805, 8.912, 13.009]],
  least: [18, 22.5, 30, 40.1, 51.1, 56],
  from: 0.67, to: 0.75,
});
const LEAST_CHROMA = 20;
function lowNeed(intent, facts, reading, effort) {
  const b = facts.blocks;
  if (!b || intent >= LOW_NEED.to) return reading;
  const x = [1, Math.log(Math.max(facts.gradient, 0.5)), Math.log(Math.max(facts.chroma, LEAST_CHROMA)), Math.log(facts.shorterSide),
    b.spread10, b.spread50, b.spread90, b.slope50, b.slope90];
  const {intent: knots, rows, least, from, to} = LOW_NEED;
  let rise = 0;
  const need = rows.map((row, k) => rise = Math.max(rise, least[k], row.reduce((s, c, i) => s + c * x[i], 0)));
  const own = q => {
    if (q <= knots[0]) return need[0];
    let i = 0;
    while (i + 2 < knots.length && knots[i + 1] < q) i++;
    return need[i] + Math.min(1, (q - knots[i]) / (knots[i + 1] - knots[i])) * (need[i + 1] - need[i]);
  };
  const g = facts.gradient, next = Math.min(ceilingFor(to), g < NATIVE_STILL_CALIBRATION.texturedGradient ? Infinity
    : Math.max(LOW_INTENT_CALIBRATION.minimumQuality, qualityFor(to, g) + 1));
  const lower = effort >= 3 ? Math.max(0, Math.min(1, (0.5 - intent) / 0.2)) : 0;
  const capped = q => Math.min(own(q), ceilingFor(q), next);
  if (intent < from) return capped(intent) - lower;
  const high = Math.max(reading, capped(from)), low = Math.min(own(intent), high);
  const u = (intent - from) / (to - from), s = u * u * (3 - 2 * u);
  return low + s * (high - low);
}

const MEASURED_READING = Object.freeze([94.56, 95.56, 96.56, 97.56, 99.07, 100.07, 100.55]);
function measuredReading(intent) {
  const x = Math.min(99, Math.max(93, intent * 100)), i = Math.min(5, Math.floor(x) - 93);
  return MEASURED_READING[i] + (MEASURED_READING[i + 1] - MEASURED_READING[i]) * (x - 93 - i);
}

function at(intent, values) {
  const knots = NATIVE_STILL_CALIBRATION.intent;
  if (intent <= knots[0]) return values[0] * intent / knots[0];
  if (intent >= knots[2]) return values[2] + (100 - values[2]) * (intent - knots[2]) / (1 - knots[2]);
  const i = intent <= knots[1] ? 0 : 1;
  return values[i] + (values[i + 1] - values[i]) * (intent - knots[i]) / (knots[i + 1] - knots[i]);
}

export function nativeStillPrediction(intent, facts, sharedQuality, {exactAllowed = true, effort} = {}) {
  if (!exactAllowed || !facts.eligible || facts.alpha !== false) return null;
  if (intent >= NATIVE_STILL_CALIBRATION.exactIntent || facts.shorterSide < 8 || facts.screenLike ||
      facts.palette && !facts.preferXYB) return 100;
  const above = intent > NATIVE_STILL_CALIBRATION.intent[2] + 1e-9, measured = above && effort >= MEASURED_EFFORT;
  let reading = sharedQuality;
  if (facts.shorterSide < 128 || !facts.palette && facts.shorterSide < 256) {
    reading = smallReading(intent, facts.shorterSide, facts.gradient);
    const b = facts.blocks, grain = b && facts.shorterSide < 128 ? Math.max(0, Math.min(1, (b.slope50 - b.spread50 - 0.5) / 0.1)) : 0;
    if (grain > 0 && reading < 100) {
      const under64 = smallReading(intent, Math.min(facts.shorterSide, 48));
      const grainyTarget = Math.min(99.5, facts.shorterSide < 64 ? under64 + 2 : Math.max(reading, under64 - 3));
      if (grainyTarget > reading) reading += grain * (grainyTarget - reading);
    }
    if (reading >= 100) return measured ? Math.min(NATIVE_STILL_CALIBRATION.maximumLossy, smallReading(0.98, facts.shorterSide, facts.gradient)) : 100;
  } else if (!facts.palette && facts.shorterSide >= 256) {
    const g = facts.gradient;
    const greyPhoto = facts.chroma < 2 && (facts.paletteSlots ?? 0) > 64;
    if (measured && facts.preferXYB) {
      const need = measuredNeed(intent, facts.pixels ?? facts.width * facts.height);
      if (need >= 100) return NATIVE_STILL_CALIBRATION.maximumLossy;
      return Math.max(need, nativeStillPrediction(NATIVE_STILL_CALIBRATION.intent[2], facts, sharedQuality, {exactAllowed}));
    } else if (facts.preferXYB && !greyPhoto && largePhoto(facts.width, facts.height)) {
      reading = qualityFor(intent, g);
      if (g <= NATIVE_STILL_CALIBRATION.largeMarginGradient) {
        const anchors = [...NATIVE_STILL_CALIBRATION.largeMinimum];
        anchors[0] = Math.max(anchors[0], qualityFor(0.5, g) + NATIVE_STILL_CALIBRATION.largeLowMargin);
        reading = Math.max(reading, at(intent, anchors));
      }
      const clip = x => Math.max(0, Math.min(1, x));
      const weight = clip((g - 23) / 2) * clip((facts.shorterSide - 2048) / 512) * clip((4096 - facts.shorterSide) / 512);
      const ceiling = 91 + 450 * Math.max(0, intent - 0.9);
      reading -= weight * Math.max(0, reading - ceiling);
    } else if (!facts.preferXYB) {
      const row = at(intent, NATIVE_STILL_CALIBRATION.ordinaryOther), b = facts.blocks;
      const grain = b ? Math.max(0, Math.min(1, (b.slope50 - b.spread50 - 0.35) / 0.1)) : 0;
      reading = Math.max(reading, row + grain * (at(intent, GRAINY_OTHER) - row));
    } else {
      if (g < NATIVE_STILL_CALIBRATION.texturedGradient) reading = Math.max(reading, at(intent, NATIVE_STILL_CALIBRATION.ordinaryXYB));
      reading = Math.min(reading, ceilingFor(Math.min(intent, NATIVE_STILL_CALIBRATION.intent[2])));
      if (!(effort >= MEASURED_EFFORT)) reading = lowNeed(intent, facts, reading, effort);
    }
    if (above && !measured) {
      const top = Math.max(measuredReading(intent), measuredNeed(intent, facts.pixels ?? facts.width * facts.height));
      if (top > reading) reading += (top - reading) * Math.min(1, intent * 100 - 92);
    }
  }
  return Math.min(NATIVE_STILL_CALIBRATION.maximumLossy, reading);
}

export function filteredStillQuality(intent, facts, quality, effort) {
  if (!(effort >= 3 && effort <= 5) || !facts.eligible || facts.alpha !== false || facts.palette ||
      facts.screenLike || !facts.preferXYB || facts.shorterSide < 256 || quality >= 95) return undefined;
  if (largePhoto(facts.width, facts.height)) return !(facts.chroma < 2 && (facts.paletteSlots ?? 0) > 64) &&
    facts.gradient <= NATIVE_STILL_CALIBRATION.largeMarginGradient ? quality - 0.5 : undefined;
  const reading = Math.min(quality, 90.5 + 175 * Math.max(0, intent - 0.9));
  if (!(reading < quality)) return undefined;
  const b = facts.blocks, grain = b ? b.slope50 - b.spread50 : 0;
  const weight = grain < NATIVE_STILL_CALIBRATION.windowGrain ? Math.max(0, Math.min(1, (grain - 0.24) / 0.05)) : 0;
  const lift = weight * Math.max(0, 1 - 100 * Math.abs(intent - 0.9));
  return Math.min(quality - 0.5, reading - 0.5 + lift);
}

const ALPHA_LIFT = Object.freeze({intent: [0.2, 0.25, 0.3, 0.35, 0.4, 0.45, 0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95],
  rows: [[128, [0, 0, 0, 0, 2, 4.1, 5.2, 2.1, 1.8, 0, 0, 1.3, 0, 0, 0, 0]],
    [256, [4.8, 4.1, 6.4, 8.5, 13.7, 12.5, 11.9, 7.3, 7.3, 6.1, 2.5, 0, 0.2, 1.6, 1.8, 0]],
    [Infinity, [1.4, 2.8, 4.5, 6.5, 6.9, 7.5, 6.8, 3.8, 1.6, 0, 0, 0, 0, 0, 0, 0]]]});
const ALPHA_SMALL = Object.freeze({side: 64, intent: [0.1, 0.2, 0.3, 0.35, 0.4, 0.5, 0.6, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95, 1],
  coder: [55.6, 68.6, 74, 77.7, 79.2, 83.5, 86, 88, 88.3, 90.2, 92.7, 95.2, 97.4, 100]});
export const ALPHA_OPAQUE = Object.freeze({share: 0.95, side: 128});
const between = ({intent: knots, coder}, q) => {
  if (q <= knots[0]) return coder[0];
  let i = 0;
  while (i + 2 < knots.length && knots[i + 1] < q) i++;
  return coder[i] + Math.min(1, (q - knots[i]) / (knots[i + 1] - knots[i])) * (coder[i + 1] - coder[i]);
};
export function alphaStillQuality(intent, facts, opaque = null) {
  if (intent >= NATIVE_STILL_CALIBRATION.exactIntent) return 100;
  const lift = ALPHA_LIFT.rows.find(([below]) => facts.shorterSide < below)[1];
  const reading = facts.shorterSide < ALPHA_SMALL.side ? between(ALPHA_SMALL, intent) : intent * 100 + between({intent: ALPHA_LIFT.intent, coder: lift}, intent);
  return Math.min(NATIVE_STILL_CALIBRATION.maximumLossy, Math.max(reading, opaque < 100 ? opaque : 0));
}
