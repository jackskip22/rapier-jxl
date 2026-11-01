import {DECODE_LIMITS} from '../decode-image.mjs';

export const PUBLIC_DECODE_LIMITS = ['maxInputBytes', 'maxPixels', 'maxDimension', 'maxFrames', 'maxTotalSamples', 'maxBoxes', 'maxMetadataBytes'];
export function decodeLimits(given) {
  const limits = {...DECODE_LIMITS};
  for (const key of PUBLIC_DECODE_LIMITS) if (given[key] !== undefined) limits[key] = given[key];
  const scale = (given.maxPixels ?? 0) > 40000000 ? Math.max(1, given.maxPixels * 10 / DECODE_LIMITS.maxRetainedSamples) : 1;
  for (const key of ['maxSamples', 'maxRetainedSamples', 'maxTotalSamples', 'maxModularWork'])
    if (given[key] === undefined) limits[key] = Math.min(2147483647, Math.ceil(DECODE_LIMITS[key] * scale));
  if (given.maxTotalSamples !== undefined) limits.maxRetainedSamples = Math.min(limits.maxRetainedSamples, given.maxTotalSamples);
  return limits;
}
