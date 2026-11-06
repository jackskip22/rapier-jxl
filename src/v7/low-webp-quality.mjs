import {settleWebp, webpQuality, gradient, qualityFor, fixedQuality, regionQuality, ceilingFor, smallReading} from './webp-quality.mjs';
import {inspectPixels} from '../lossless.mjs';
import {screenLike} from '../screen.mjs';
import {preferXYB} from '../photo-preference.mjs';

export const LOW_WEBP_CALIBRATION = Object.freeze({
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

export function lowWebpFacts(picture) {
  if (!nativeRgb(picture) || (picture.colorSpace ?? 'srgb') !== 'srgb') return {eligible: false};
  const {data, width, height} = picture, shape = inspectPixels(data, width, height);
  return {eligible: true, width, height, pixels: width * height, shorterSide: Math.min(width, height),
    gradient: gradient(picture), palette: Boolean(shape.palette), paletteSlots: shape.palette?.colours.length ?? null, alpha: shape.alpha,
    screenLike: screenLike(data, width, height), preferXYB: preferXYB(data, width, height)};
}

function anchor(q, values) {
  const knots = LOW_WEBP_CALIBRATION.q;
  if (q <= knots[0]) return values[0];
  if (q >= knots.at(-1)) return values.at(-1);
  const index = q <= knots[1] ? 0 : 1;
  return values[index] + (values[index + 1] - values[index]) * (q - knots[index]) / (knots[index + 1] - knots[index]);
}

export function lowWebpDecision(q, picture, {exactAllowed = true, facts: suppliedFacts} = {}) {
  if (!exactAllowed) return {quality: webpQuality(q, picture), route: 'existing', policyClass: 'featured'};
  if (q >= 1) return {quality: webpQuality(q, picture), route: 'exact', policyClass: 'webp-one'};
  const facts = suppliedFacts ?? lowWebpFacts(picture);
  if (!facts.eligible) return {quality: webpQuality(q, picture), route: 'existing', policyClass: 'other-description'};
  const region = regionQuality(q, picture.data, picture.width, {x: 0, y: 0, width: picture.width, height: picture.height});
  const reading = photoReading(q, facts, region);
  if (facts.shorterSide < LOW_WEBP_CALIBRATION.smallestScored)
    return {quality: 100, route: 'exact', policyClass: 'tiny-pixels', facts, reading};
  if (facts.screenLike)
    return {quality: 100, route: 'exact', policyClass: 'screen', facts, reading};
  if (facts.palette && !facts.preferXYB)
    return {quality: 100, route: 'exact', policyClass: 'non-photo-palette', facts, reading};
  return photoDecision(q, facts, reading);
}

function photoReading(q, facts, region) {
  const old = qualityFor(q, facts.gradient), fixed = fixedQuality(q);
  const base = Math.max(LOW_WEBP_CALIBRATION.minimumQuality, Math.min(99.9, Math.max(old, fixed, region) + 1));
  return {old, fixed, region, base};
}

function photoDecision(q, facts, reading) {
  let floor = 0, policyClass = 'ordinary-photo';
  if (facts.shorterSide < 128) return {quality: Math.min(LOW_WEBP_CALIBRATION.maximumLossy, smallReading(q, facts.shorterSide)),
    route: 'photo', policyClass: facts.shorterSide < 64 ? 'photo-below64' : 'photo-below128', facts, reading};
  if (facts.palette && facts.preferXYB) {
    floor = anchor(q, LOW_WEBP_CALIBRATION.palettePhoto); policyClass = 'photographic-palette';
  } else if (facts.shorterSide < 256) {
    return {quality: Math.min(LOW_WEBP_CALIBRATION.maximumLossy, smallReading(q, facts.shorterSide)),
      route: 'photo', policyClass: 'photo-below256', facts, reading};
  }
  const ceiling = policyClass === 'ordinary-photo' && facts.preferXYB && !facts.palette ? ceilingFor(q) : Infinity;
  return {quality: Math.min(LOW_WEBP_CALIBRATION.maximumLossy, ceiling, Math.max(reading.base, floor)),
    route: 'photo', policyClass, facts, reading};
}

export function lowPhotoReading(q, picture, baseQuality, sampling) {
  if (q >= 1 || baseQuality >= 100 || !nativeRgb(picture)) return baseQuality;
  const p3 = picture.colorSpace === 'display-p3', [, lower, upper] = LOW_WEBP_CALIBRATION.q;
  const t = Math.min(1, Math.max(0, (q - lower) / (upper - lower)));
  if (!p3 && t === 0) return baseQuality;
  const chroma = !preferXYB(picture.data, picture.width, picture.height, sampling);
  return Math.min(LOW_WEBP_CALIBRATION.maximumLossy, baseQuality + (p3 ? t : 0) + (chroma ? p3 ? 1 : t : 0));
}

export function lowCaptureReading(q, data, width, rect, offGrid = false, colorSpace = 'srgb') {
  const base = regionQuality(q, data, width, rect, offGrid);
  return lowPhotoReading(q, {data, width: rect.width, height: rect.height, colorSpace}, base,
    {stride: width, origin: rect.y * width + rect.x});
}

export function lowWebpQuality(q, picture, options) { return lowWebpDecision(q, picture, options).quality; }

export function settleLowWebp(codec, picture, {exactAllowed = true} = {}) {
  const effort = codec.effort ?? 3;
  if (codec.qualityIntent === undefined || effort < 1 || effort > 4 || !exactAllowed) return settleWebp(codec, picture);
  const {qualityIntent, ...rest} = codec;
  const decision = lowWebpDecision(qualityIntent, picture);
  if (decision.route !== 'photo' || decision.facts?.palette) return settleWebp(codec, picture);
  return {...rest, quality: decision.quality, lowWebp: qualityIntent};
}
