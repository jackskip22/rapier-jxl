import {DECODE_LIMITS} from '../decode-image.mjs';

export const PUBLIC_DECODE_LIMITS = ['maxInputBytes', 'maxPixels', 'maxDimension', 'maxFrames', 'maxTotalSamples', 'maxBoxes', 'maxMetadataBytes'];
export function decodeLimits(given) {
  const limits = {...DECODE_LIMITS};
  for (const key of PUBLIC_DECODE_LIMITS) if (given[key] !== undefined) limits[key] = given[key];
  if (given.maxTotalSamples !== undefined) limits.maxRetainedSamples = Math.min(DECODE_LIMITS.maxRetainedSamples, given.maxTotalSamples);
  return limits;
}
