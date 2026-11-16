// SPDX-License-Identifier: MIT
import {pixelKeys} from './screen-crop.mjs';
import {captureFillHoles, captureMaskComponents, capturePhotoMasks, captureRectangleRuns} from './capture-kernels.mjs';

const MIN_PHOTO = 0.4;

const RUNS = new WeakMap();
export function releasePhotoMasks(data) { RUNS.delete(data); }
export function photoMasks(data, width, height, regions, exactRects = [], minPhoto = 4096) {
  const keyed = pixelKeys(data), words = new Int32Array(keyed.buffer, keyed.byteOffset, keyed.length);
  let known = RUNS.get(data);
  if (!known) RUNS.set(data, known = new Map());
  const found = regions.map(r => {
    const key = width + ':' + r.x + ':' + r.y + ':' + r.width + ':' + r.height, had = known.get(key);
    if (had) return had;
    const runs = captureRectangleRuns(words, width, r);
    known.set(key, runs);
    return runs;
  });
  const masked = capturePhotoMasks(words, width, height, regions, found, exactRects);
  return regions.map((r, index) => {
    const n = r.width * r.height, m = masked[index];
    const corner = words[(r.y ? r.y - 1 : 0) * width + (r.x ? r.x - 1 : 0)];
    if (!m.list) return {exact: m.exact, photo: n, fill: (corner | 0xff000000) >>> 0};
    const photo = n - m.list - m.ring, floor = typeof minPhoto === 'function' ? minPhoto(r, index) : minPhoto;
    if (photo < floor || photo < MIN_PHOTO * (n - m.flat)) return null;
    return {exact: m.exact, photo, fill: ((m.fill < 0 ? corner : m.fill) | 0xff000000) >>> 0};
  });
}

export function fillHoles(rgba, w, h, exact) {
  captureFillHoles(rgba, w, h, exact);
  return rgba;
}

export function maskComponents(mask, w, h) {
  return captureMaskComponents(mask, w, h);
}
