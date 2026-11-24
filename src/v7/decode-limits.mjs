import {DECODE_LIMITS, pictureCounters} from '../decode-image.mjs';
import {PIXELS} from '../limits.mjs';
const COUNTERS = ['maxSamples', 'maxRetainedSamples', 'maxTotalSamples', 'maxModularWork'];

export const PUBLIC_DECODE_LIMITS = ['maxInputBytes', 'maxPixels', 'maxDimension', 'maxFrames', 'maxTotalSamples', 'maxBoxes', 'maxMetadataBytes'];
export function decodeLimits(given) {
  const limits = {...DECODE_LIMITS};
  for (const key of COUNTERS) delete limits[key];
  for (const key of PUBLIC_DECODE_LIMITS) if (given[key] !== undefined) limits[key] = given[key];
  if (given.maxPixels !== undefined && given.maxPixels < PIXELS) {
    const counters = pictureCounters(given.maxPixels);
    for (const key of COUNTERS) if (given[key] === undefined && !(key === 'maxTotalSamples' && given.onFrame !== undefined))
      limits[key] = counters[key];
  }
  if (given.maxTotalSamples !== undefined)
    limits.maxRetainedSamples = Math.min(limits.maxRetainedSamples ?? DECODE_LIMITS.maxRetainedSamples, given.maxTotalSamples);
  return limits;
}
