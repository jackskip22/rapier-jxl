// SPDX-License-Identifier: MIT
import {s2Dimensions} from './ssimulacra2-input.mjs';
import {fault} from './fault.mjs';

export const S2_MEMORY = Object.freeze({linear:32768, gaussian:33792, base:65536, maximumPages:32767});
const LIMIT = S2_MEMORY.maximumPages * 65536;

export function s2ArenaPlan({admit = true, base = S2_MEMORY.base} = {}) {
  let cursor = base;
  return {
    take(bytes) {
      if (!Number.isSafeInteger(bytes) || bytes < 0 || !Number.isSafeInteger(cursor + bytes + 15) || admit && bytes > LIMIT - cursor - 15)
        throw fault('JXL_MEMORY','SSIMULACRA2: over limit');
      const at = cursor; cursor += Math.ceil(bytes / 16) * 16; return at;
    },
    get arenaBytes() { return cursor; },
    get residentBytes() { return Math.ceil(cursor / 65536) * 65536; },
  };
}

export function ssimulacra2Layout(width, height, options = {}) {
  const pixels = s2Dimensions(width, height), map = options.map ?? false;
  const mask = options.channels ?? (map ? 1 : 7), cached = options.cached ?? 0, cachedP1 = options.cachedP1 ?? 0, retain = options.retain ?? 0;
  if (![mask,cached,cachedP1,retain].every(n => Number.isInteger(n) && n >= 0 && n <= 7) || !mask
      || map && (mask & (mask - 1)))
    throw fault('JXL_INPUT','masks or mapChannel');
  const cachedMask = cached & mask, p1Mask = cachedMask | (cachedP1 & mask), needReference = !!(mask & ~p1Mask);
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
  const rowBytes = ((needReference ? 48 : 0) + 80 + 24 * active) * width * 4;
  const scratch = options.place ? 0 : take(rowBytes), sums = options.place ? 0 : take(18 * 8);
  const terms = map ? take(pixels * 8) : 0, edgeTerms = map ? take(pixels * 8) : 0;
  return {pixels,mask,cachedMask,reference,distorted,caches,scratch,sums,terms,edgeTerms,
    arenaBytes:arena.arenaBytes, residentBytes:arena.residentBytes,
    referenceBytes,distortedBytes,cacheBytes,rowBytes,termBytes:map ? pixels * 16 : 0};
}

export const ssimulacra2WorkBytes = (width,height,options) => ssimulacra2Layout(width,height,options).residentBytes;

export function ssimulacra2Allocation(width,height,{referenceRgba = false,distortedRgba = false,
    wantMap = false,cacheBytes = 0} = {}) {
  const original = s2Dimensions(width,height);
  if (!Number.isSafeInteger(cacheBytes) || cacheBytes < 0) throw fault('JXL_INTERNAL', 'ssimulacra2-memory:cacheBytes');
  const fullWidth = Math.max(8,width), fullHeight = Math.max(8,height), padded = fullWidth * fullHeight;
  const candidateBytes = original * (distortedRgba ? 4 : 12), scales = [];
  let w = fullWidth, h = fullHeight, left = cacheBytes, retained = 0, arenaBytes = 0;
  const sizes = [];
  for (let s = 0; s < 6; s++) {
    if (w < 8 || h < 8) break;
    if (s) { w = Math.ceil(w / 2); h = Math.ceil(h / 2); }
    sizes.push({w,h,pixels:w * h,bytes:0,keep:false});
  }
  for (let i = sizes.length - 1; i >= 0; i--) {
    const d = sizes[i], p = d.pixels;
    if (p * 36 <= left) { d.keep = true; d.bytes = p * 36; left -= d.bytes; retained += d.bytes; }
    else if (i === 0 && p * 20 <= left) { d.keep = 'y-ms'; d.bytes = p * 20; left -= d.bytes; retained += d.bytes; }
    else if (i === 0 && p * 12 <= left) { d.keep = 'p1'; d.bytes = p * 12; left -= d.bytes; retained += d.bytes; }
  }
  const planeAligned = (pixels, keep) => !keep ? 0 : [0,1,2].reduce((sum, c) =>
    sum + Math.ceil(pixels * (keep === 'p1' ? 4 : keep === 'y-ms' ? (c === 1 ? 12 : 4) : 12) / 16) * 16, 0);
  const planes = sizes.reduce((sum,{pixels,keep}) => sum + planeAligned(pixels, keep),0);
  for (const [s,{w,h,pixels,bytes,keep}] of sizes.entries()) {
    const plan = ssimulacra2Layout(w,h,{referenceRgba:!s && referenceRgba,distortedRgba:!s && distortedRgba,
      map:wantMap,admit:false,
      base:S2_MEMORY.base + planes,resident:!!retained});
    const staging = plan.residentBytes - planes;
    arenaBytes = Math.max(arenaBytes,staging);
    scales.push({width:w,height:h,pixels,cacheBytes:keep ? bytes : 0,arenaBytes:staging});
  }
  const pyramidBytes = wantMap ? 24 * ((scales[1]?.pixels ?? 0) + (scales[2]?.pixels ?? 0)) : 0;
  const mapBytes = wantMap ? padded * 24 + (scales[1]?.pixels ?? 0) * 8 + (padded !== original ? original * 8 : 0) : 0;
  const paddingBytes = padded === original ? 0 : padded * ((referenceRgba ? 4 : 24) + (distortedRgba ? 4 : 24));
  const hostBytes = candidateBytes + retained + pyramidBytes + mapBytes + paddingBytes;
  return {workBytes:arenaBytes + hostBytes,arenaBytes,hostBytes,candidateBytes,cacheBytes:retained,
    pyramidBytes,mapBytes,paddingBytes,scales,retainedArenaBytes:retained ? arenaBytes : 0,admissible:arenaBytes + planes <= LIMIT};
}
