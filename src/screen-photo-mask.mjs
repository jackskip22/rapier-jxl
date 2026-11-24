// SPDX-License-Identifier: MIT
import {pixelKeys} from './screen-crop.mjs';
import {photoCells, photoCellText} from './screen-photo-regions.mjs';
import {captureFillHoles, captureMaskComponents, capturePhotoMasks, captureRectangleRuns, releaseMaskArena} from './capture-kernels.mjs';

const MIN_PHOTO = 0.4;

const RUNS = new WeakMap();
export function releasePhotoMasks(data) { RUNS.delete(data); releaseMaskArena(); }
export function photoMasks(data, width, height, regions, exactRects = [], minPhoto = 4096, cache = true) {
  const keyed = pixelKeys(data), words = new Int32Array(keyed.buffer, keyed.byteOffset, keyed.length);
  let known = RUNS.get(data);
  if (!known && cache) RUNS.set(data, known = new Map());
  const found = regions.map(r => {
    const key = width + ':' + r.x + ':' + r.y + ':' + r.width + ':' + r.height, had = known?.get(key);
    if (had) return had;
    const runs = captureRectangleRuns(words, width, r);
    if (cache) known.set(key, runs);
    return runs;
  });
  const masked = capturePhotoMasks(words, width, height, regions, found, exactRects);
  const protectedMore = regions.map((r, index) => protectTextCells(data, width, height, r, masked[index]));
  return regions.map((r, index) => {
    const n = r.width * r.height, m = masked[index];
    const corner = words[(r.y ? r.y - 1 : 0) * width + (r.x ? r.x - 1 : 0)];
    if (!m.list) return {exact: m.exact, photo: n - protectedMore[index], fill: (corner | 0xff000000) >>> 0};
    const photo = n - m.list - m.ring - protectedMore[index], floor = typeof minPhoto === 'function' ? minPhoto(r, index) : minPhoto;
    if (photo < floor || photo < MIN_PHOTO * (n - m.flat)) return null;
    return {exact: m.exact, photo, fill: ((m.fill < 0 ? corner : m.fill) | 0xff000000) >>> 0};
  });
}

function placementOnlyLeftEdge(data, width, r, m, tx, ty) {
  if (tx !== Math.floor(r.x / 32)) return false;
  const x0 = Math.max(tx * 32, r.x), x1 = Math.min((tx + 1) * 32, r.x + r.width);
  const y0 = Math.max(ty * 32, r.y), y1 = Math.min((ty + 1) * 32, r.y + r.height);
  if (x1 - x0 < 10 || y1 - y0 < 8) return false;
  const same = (a, b) => data[a] === data[b] && data[a + 1] === data[b + 1] &&
    data[a + 2] === data[b + 2] && data[a + 3] === data[b + 3];
  const edgeRows = new Map();
  let photoRows = 0;
  for (let y = y0; y < y1; y++) {
    const row = (y - r.y) * r.width - r.x;
    let edge = x0;
    while (edge < x1 && m.exact[row + edge]) edge++;
    if (edge - x0 < 3 || x1 - edge < 5) continue;
    const page = (y * width + x0) * 4;
    let uniform = true;
    for (let x = x0 + 1; x < edge; x++) if (!same(page, (y * width + x) * 4)) {
      uniform = false; break;
    }
    if (!uniform) continue;
    let different = 0;
    for (let x = edge + 1; x < edge + 5; x++)
      if (!same(page, (y * width + x) * 4)) different++;
    if (different < 4) continue;
    photoRows++;
    edgeRows.set(edge, (edgeRows.get(edge) ?? 0) + 1);
  }
  if (photoRows < 8) return false;
  let edge = -1, seen = 0;
  for (const [x, count] of edgeRows) if (count > seen) {edge = x; seen = count;}
  if (seen < 8 || seen * 4 < photoRows * 3) return false;

  let colored = 0, first = -1;
  for (let y = y0; y < y1; y++) {
    const row = (y - r.y) * r.width - r.x;
    if (edge >= x1 - 4 || edge < x0 + 3) return false;
    if (m.exact[row + edge]) continue;
    let strip = true;
    for (let x = x0; x < edge; x++) if (!m.exact[row + x]) {strip = false; break;}
    if (!strip) continue;
    const seam = (y * width + edge) * 4;
    if (!m.exact[row + edge]) {
      const key = (data[seam] << 16) | (data[seam + 1] << 8) | data[seam + 2];
      if (first >= 0 && key !== first) colored++;
      first = key;
    }
    for (let x = edge + 2; x < x1 - 2; x++) {
      if (m.exact[row + x]) return false;
      const p = (y * width + x) * 4;
      if (data[p + 3] !== 255) return false;
      if (same(p, p + 4) && same(p, p + 8)) return false;
      if (y + 1 < y1 && same(p, p + width * 4) &&
          same(p + 4, p + (width + 1) * 4)) return false;
    }
  }
  return colored >= 4;
}

function protectTextCells(data, width, height, r, m) {
  if (!m?.exact) return 0;
  let added = 0;
  const cells = photoCells(data, width, height), T = 32;
  const cx0 = Math.max(0, Math.floor(r.x / T)), cx1 = Math.min(cells.cols - 1, Math.ceil((r.x + r.width) / T) - 1);
  const cy0 = Math.max(0, Math.floor(r.y / T)), cy1 = Math.min(cells.rows - 1, Math.ceil((r.y + r.height) / T) - 1);
  if (cx1 < cx0 || cy1 < cy0) return 0;
  const text = photoCellText(cells, cx0, cy0, cx1, cy1);
  for (let ty = cy0; ty <= cy1; ty++) for (let tx = cx0; tx <= cx1; tx++) {
    if (text[ty * cells.cols + tx] !== 1 || placementOnlyLeftEdge(data, width, r, m, tx, ty)) continue;
    for (let y = Math.max(ty * T, r.y); y < Math.min((ty + 1) * T, r.y + r.height); y++) for (let x = Math.max(tx * T, r.x); x < Math.min((tx + 1) * T, r.x + r.width); x++) {
      const at = (y - r.y) * r.width + x - r.x;
      if (!m.exact[at]) { m.exact[at] = 1; added++; }
    }
  }
  return added;
}

export function fillHoles(rgba, w, h, exact) {
  captureFillHoles(rgba, w, h, exact);
  return rgba;
}

export function maskComponents(mask, w, h) {
  return captureMaskComponents(mask, w, h);
}
