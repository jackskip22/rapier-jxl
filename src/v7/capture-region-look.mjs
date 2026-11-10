// SPDX-License-Identifier: MIT
import {complete} from '../bits.mjs';
import {photoCoefficientSteps, rgbCoefficientSteps} from '../photo-dct.mjs';
import {gammaPicture} from '../photo-region-score.mjs';
import {gammaRGBA} from '../photo-output.mjs';
import {ssimulacra2} from '../ssimulacra2.mjs';
import {webpTarget} from '../photo-quality-table.mjs';

export const LOOK_FROM = 3;
const WINDOW = 128, SIDE = 128, RGB_SIDE = 96, AIM = 1.25, STEP_DOWN = 1.2, STEP_UP = 0.6, CEILING = 99.99;
const SMALL_AIM = 0.9, SMALL_KNEE = 82, SMALL_SLOPE_LOW = 0.66, SMALL_SLOPE_HIGH = 1;

function cut(data, width, height, r, full = false) {
  let x = Math.max(0, r.x), y = Math.max(0, r.y), w = Math.min(width, r.x + r.width) - x, h = Math.min(height, r.y + r.height) - y;
  if (w <= 0 || h <= 0) return null;
  if (!full) {
    if (w > WINDOW) { x += (w - WINDOW) >> 4 << 3; w = WINDOW; }
    if (h > WINDOW) { y += (h - WINDOW) >> 4 << 3; h = WINDOW; }
  }
  const out = new Uint8Array(w * h * 4);
  for (let row = 0; row < h; row++) out.set(data.subarray(((y + row) * width + x) * 4, ((y + row) * width + x + w) * 4), row * w * 4);
  return {pixels: out, width: w, height: h};
}

function rgbFrame(frame) {
  return frame && frame.coder === 'rgb' && Number.isFinite(frame.frameQuality) ? frame : null;
}

function codedCrop(pixels, w, h, reading, colorSpace, frame) {
  if (!frame) return complete(photoCoefficientSteps(pixels, w, h, reading, colorSpace, false, true, null,
    Math.min(w, h) < SIDE ? {smallRegions: true} : {}));
  if (frame.frameQuality === reading) return complete(rgbCoefficientSteps(pixels, w, h, reading, colorSpace));
  return complete(rgbCoefficientSteps(pixels, w, h, frame.frameQuality, colorSpace, [{x: 0, y: 0, width: w, height: h, quality: reading}]));
}

export function lookReading(q, data, width, rect, reading, colorSpace = 'srgb', frame = null, {measureLarge = true, measureSmall = false} = {}) {
  frame = rgbFrame(frame);
  const short = Math.min(rect.width, rect.height);
  const small = !frame && short < SIDE;
  if (q >= 1 || reading >= 100) return reading;
  if (frame && !measureLarge) return reading;
  if (small && !measureSmall) return reading;
  if (!small && !frame && !measureLarge) return reading;
  const side = frame || small ? RGB_SIDE : SIDE;
  if (short < side) return reading;
  const crop = cut(data, width, data.length / 4 / width, rect, small);
  if (!crop || Math.min(crop.width, crop.height) < side) return reading;
  const {pixels, width: w, height: h} = crop;
  const scoreAt = at => {
    const image = codedCrop(pixels, w, h, at, colorSpace, frame);
    const decoded = gammaRGBA(gammaPicture(image, {reference: pixels, exact: null, pixels, mask: false}), w, h);
    return ssimulacra2({rgba: pixels}, {rgba: decoded}, w, h).score;
  };
  const s0 = scoreAt(reading);
  if (s0 === undefined || !Number.isFinite(s0)) return reading;
  const clamp = next => Math.min(CEILING, Math.max(1, next));
  if (small) {
    const aim = webpTarget(q) + SMALL_AIM;
    if (s0 >= aim) return reading;
    const slope = reading < SMALL_KNEE ? SMALL_SLOPE_LOW : SMALL_SLOPE_HIGH;
    return clamp(reading + (aim - s0) / slope);
  }
  const aim = webpTarget(q) + AIM, T = aim - AIM;
  const r1 = clamp(s0 >= aim ? reading - (s0 - aim) / STEP_DOWN : reading + (aim - s0) / STEP_UP);
  if (!frame || Math.abs(r1 - reading) < 0.25 || s0 <= aim + 8) return r1;
  const s1 = scoreAt(r1);
  if (s1 === undefined || !Number.isFinite(s1)) return r1;
  if (s1 < T) {
    if (!(s0 > s1)) return Math.max(reading, r1);
    const frac = Math.min(1, Math.max(0, (aim - s1) / (s0 - s1)));
    return clamp(r1 + frac * (reading - r1));
  }
  if (s1 <= aim + 4) return r1;
  const slope = (s0 - s1) / (reading - r1);
  if (!(slope > 0.05)) return r1;
  const span = Math.abs(reading - r1);
  const raw = r1 - (s1 - aim) / slope;
  return clamp(reading > r1 ? Math.max(raw, r1 - span) : Math.min(raw, r1 + span));
}

export function lookingReader(q, read, flags = {}) {
  const seen = new Map();
  return (data, width, rect, offGrid, colorSpace, ...more) => {
    const reading = read(data, width, rect, offGrid, colorSpace, ...more);
    const frame = rgbFrame(more.find(rgbFrame));
    const key = `${rect.x},${rect.y},${rect.width},${rect.height},${offGrid === true},${reading},${frame ? frame.frameQuality : ''}`;
    if (!seen.has(key)) seen.set(key, lookReading(q, data, width, rect, reading, colorSpace, frame, flags));
    return seen.get(key);
  };
}
