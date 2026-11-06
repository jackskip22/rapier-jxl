// SPDX-License-Identifier: MIT
import {s2Dimensions} from './ssimulacra2-input.mjs';
import {fault} from './fault.mjs';

export const S2_MEMORY = Object.freeze({linear:131072, gaussian:132096, colorKeys:132352,
  colorValues:656640, base:2229504, maximumPages:32767});
const LIMIT = S2_MEMORY.maximumPages * 65536;

export function s2ArenaPlan({admit = true, base = S2_MEMORY.base} = {}) {
  let cursor = base;
  return {
    take(bytes) {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || !Number.isSafeInteger(cursor + bytes + 15) || admit && bytes > LIMIT - cursor - 15)
      throw fault('JXL_MEMORY','SSIMULACRA2 exceeds its memory allowance.');
    const at = cursor; cursor += Math.ceil(bytes / 16) * 16; return at;
    },
    get arenaBytes() { return cursor; },
    get residentBytes() { return Math.ceil(cursor / 65536) * 65536; },
  };
}

export function ssimulacra2Layout(width, height, options = {}) {
  const pixels = s2Dimensions(width, height), map = options.map ?? false;
  const mask = options.channels ?? (map ? 1 : 7), cached = options.cached ?? 0, retain = options.retain ?? 0;
  if (![mask,cached,retain].every(n => Number.isInteger(n) && n >= 0 && n <= 7) || !mask
      || map && (mask & (mask - 1)))
    throw fault('JXL_INPUT','SSIMULACRA2 needs valid channel/cache masks and one map channel.');
  const cachedMask = cached & mask, needReference = !!(mask & ~cachedMask);
  const arena = s2ArenaPlan({admit:options.admit !== false, base:options.base}), take = bytes => arena.take(bytes);
  const referenceBytes = needReference ? pixels * (options.referenceRgba ? 4 : 12) : 0;
  const distortedBytes = pixels * (options.distortedRgba ? 4 : 12);
  const reference = needReference ? take(referenceBytes) : 0, distorted = take(distortedBytes);
  let active = 0, cacheBytes = 0;
  const caches = [0,1,2].map(c => {
    const bit = 1 << c;
    if (!(mask & bit)) return 0;
    active += cachedMask & bit ? 3 : 5;
    if (options.resident || !((cachedMask | retain) & bit)) return 0;
    cacheBytes += 12 * pixels; return take(12 * pixels);
  });
  const rowBytes = ((needReference ? 48 : 0) + 56 + 23 * active) * width * 4;
  const scratch = take(rowBytes), sums = take(18 * 8);
  const terms = map ? take(pixels * 8) : 0, edgeTerms = map ? take(pixels * 8) : 0;
  return {pixels,mask,cachedMask,reference,distorted,caches,scratch,sums,terms,edgeTerms,
    arenaBytes:arena.arenaBytes, residentBytes:arena.residentBytes,
    referenceBytes,distortedBytes,cacheBytes,rowBytes,termBytes:map ? pixels * 16 : 0};
}

export const ssimulacra2WorkBytes = (width,height,options) => ssimulacra2Layout(width,height,options).residentBytes;

export function ssimulacra2Allocation(width,height,{referenceRgba = false,distortedRgba = false,
    wantMap = false,cacheBytes = 0} = {}) {
  const original = s2Dimensions(width,height);
  if (!Number.isSafeInteger(cacheBytes) || cacheBytes < 0) throw new RangeError('SSIMULACRA2 cacheBytes must be a nonnegative safe integer.');
  const fullWidth = Math.max(8,width), fullHeight = Math.max(8,height), padded = fullWidth * fullHeight;
  const candidateBytes = original * (distortedRgba ? 4 : 12), scales = [];
  let w = fullWidth, h = fullHeight, left = cacheBytes, retained = 0, arenaBytes = 0;
  const sizes = [];
  for (let s = 0; s < 6; s++) {
    if (w < 8 || h < 8) break;
    if (s) { w = Math.ceil(w / 2); h = Math.ceil(h / 2); }
    const pixels = w * h, bytes = pixels * 36, keep = bytes <= left;
    if (keep) { left -= bytes; retained += bytes; }
    sizes.push({w,h,pixels,bytes,keep});
  }
  const planes = sizes.reduce((sum,{pixels,keep}) => sum + (keep ? 3 * Math.ceil(pixels * 12 / 16) * 16 : 0),0);
  for (const [s,{w,h,pixels,keep}] of sizes.entries()) {
    const plan = ssimulacra2Layout(w,h,{referenceRgba:!s && referenceRgba,distortedRgba:!s && distortedRgba,
      map:wantMap,admit:false,
      base:S2_MEMORY.base + planes,resident:!!retained});
    const staging = plan.residentBytes - planes;
    arenaBytes = Math.max(arenaBytes,staging);
    scales.push({width:w,height:h,pixels,cacheBytes:keep ? pixels * 36 : 0,arenaBytes:staging});
  }
  const pyramidBytes = 24 * ((scales[1]?.pixels ?? 0) + (scales[2]?.pixels ?? 0));
  const mapBytes = wantMap ? padded * 24 + (scales[1]?.pixels ?? 0) * 8 + (padded !== original ? original * 8 : 0) : 0;
  const paddingBytes = padded === original ? 0 : padded * ((referenceRgba ? 4 : 24) + (distortedRgba ? 4 : 24));
  const hostBytes = candidateBytes + retained + pyramidBytes + mapBytes + paddingBytes;
  return {workBytes:arenaBytes + hostBytes,arenaBytes,hostBytes,candidateBytes,cacheBytes:retained,
    pyramidBytes,mapBytes,paddingBytes,scales,retainedArenaBytes:retained ? arenaBytes : 0,admissible:arenaBytes + planes <= LIMIT};
}
