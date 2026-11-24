import {WHOLE, COMPACT_WHOLE} from '../memory-device.mjs';
export {WHOLE, BAND_PIXELS, COMPACT_WHOLE, WHOLE_BYTES, wholeBudget, BANDED_LIMITS, bandRows} from '../memory-device.mjs';

export function needsBands(width, height, settings, data) {
  const pixels = width * height;
  if (pixels > WHOLE) return true;
  const eight = data instanceof Uint8Array || data instanceof Uint8ClampedArray;
  return eight && settings.effort === 7 && settings.quality < 100 && pixels > COMPACT_WHOLE;
}
