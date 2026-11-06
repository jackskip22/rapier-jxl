// SPDX-License-Identifier: MIT
import {qualityFor, ceilingFor, smallReading} from './webp-quality.mjs';
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
  exactIntent: 0.99,
});

function at(intent, values) {
  const knots = NATIVE_STILL_CALIBRATION.intent;
  if (intent <= knots[0]) return values[0] * intent / knots[0];
  if (intent >= knots[2]) return values[2] + (100 - values[2]) * (intent - knots[2]) / (1 - knots[2]);
  const i = intent <= knots[1] ? 0 : 1;
  return values[i] + (values[i + 1] - values[i]) * (intent - knots[i]) / (knots[i + 1] - knots[i]);
}

export function nativeStillPrediction(intent, facts, sharedQuality, {exactAllowed = true} = {}) {
  if (!exactAllowed || !facts.eligible || facts.alpha !== false) return null;
  if (intent >= NATIVE_STILL_CALIBRATION.exactIntent || facts.shorterSide < 8 || facts.screenLike ||
      facts.palette && !facts.preferXYB) return 100;
  let reading = sharedQuality;
  if (facts.shorterSide < 128 || !facts.palette && facts.shorterSide < 256) {
    reading = smallReading(intent, facts.shorterSide);
  } else if (!facts.palette && facts.shorterSide >= 256) {
    const g = facts.gradient;
    if (facts.preferXYB && largePhoto(facts.width, facts.height)) {
      reading = qualityFor(intent, g);
      if (g <= NATIVE_STILL_CALIBRATION.largeMarginGradient) {
        const anchors = [...NATIVE_STILL_CALIBRATION.largeMinimum];
        anchors[0] = Math.max(anchors[0], qualityFor(0.5, g) + NATIVE_STILL_CALIBRATION.largeLowMargin);
        reading = Math.max(reading, at(intent, anchors));
      }
    } else if (!facts.preferXYB) {
      reading = Math.max(reading, at(intent, NATIVE_STILL_CALIBRATION.ordinaryOther));
    } else {
      if (g < NATIVE_STILL_CALIBRATION.texturedGradient) reading = Math.max(reading, at(intent, NATIVE_STILL_CALIBRATION.ordinaryXYB));
      reading = Math.min(reading, ceilingFor(intent));
    }
  }
  return Math.min(NATIVE_STILL_CALIBRATION.maximumLossy, reading);
}
