// SPDX-License-Identifier: MIT
import {BitWriter, LITTLE_ENDIAN} from './bits.mjs';
import {writeTOC, groupLayout, writeModularFrameHeader as generalFrame} from './frame.mjs';
import {writeCaptureFrameHeader, writeCaptureModularHeader} from './capture-headers.mjs';
import {leaf, channelTree, writeTree, writeModularHeader as generalModular, ALPHABET, LZ77, RESIDUAL_CONFIG} from './modular.mjs';
import {buildCode, writeHistograms} from './prefix.mjs';
import {captureColumnsUnlike, captureCropEdges, captureLowestInk, captureRowsUnlike} from './capture-kernels.mjs';

const writeModularFrameHeader = typeof __RAPIER_JXL_CAPTURE_LEAN__ !== 'undefined' && __RAPIER_JXL_CAPTURE_LEAN__ === true ? writeCaptureFrameHeader : generalFrame;
const writeModularHeader = typeof __RAPIER_JXL_CAPTURE_LEAN__ !== 'undefined' && __RAPIER_JXL_CAPTURE_LEAN__ === true ? writeCaptureModularHeader : generalModular;
export function pixelKeys(rgba) {
  if (LITTLE_ENDIAN && !(rgba.byteOffset & 3)) return new Uint32Array(rgba.buffer, rgba.byteOffset, rgba.length >> 2);
  const keys = new Uint32Array(rgba.length >> 2);
  for (let i = 0; i < keys.length; i++) keys[i] = (rgba[4 * i] | rgba[4 * i + 1] << 8 | rgba[4 * i + 2] << 16 | rgba[4 * i + 3] << 24) >>> 0;
  return keys;
}

export function viewPixels(source, width, height, stride, origin) {
  const out = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) { const at = (origin + y * stride) * 4; out.set(source.subarray(at, at + width * 4), y * width * 4); }
  return out;
}

function runFrom(words, i, end, color) { while (i < end && words[i] === color) i++; return i; }
function runBack(words, i, stop, color) { while (i >= stop && words[i] === color) i--; return i; }

function cropEdges(words, width, height, stride, origin) {
  const color = words[origin];
  let first = -1, last = -1;
  for (let y = 0; y < height && first < 0; y++) {
    const start = origin + y * stride, found = runFrom(words, start, start + width, color);
    if (found < start + width) first = y * width + found - start;
  }
  if (first < 0) return null;
  for (let y = height - 1; last < 0; y--) {
    const start = origin + y * stride, found = runBack(words, start + width - 1, start, color);
    if (found >= start) last = y * width + found - start;
  }
  const bottom = Math.floor(last / width) + 1;
  let x = first % width, right = last % width + 1;
  for (let row = Math.floor(first / width); row < bottom && (x || right < width); row++) {
    const start = origin + row * stride, left = runFrom(words, start, start + x, color) - start;
    if (left < x) x = left;
    const end = runBack(words, start + width - 1, start + right, color) - start + 1;
    if (end > right) right = end;
  }
  return [first, last, x, right];
}

export function screenCrop(data, width, height, stride = width, origin = 0) {
  const at = origin * 4, background = Uint8Array.of(data[at], data[at + 1], data[at + 2], data[at + 3]);
  const words = pixelKeys(data), held = captureCropEdges(words, width, height, stride, origin),
    edges = held === undefined ? cropEdges(words, width, height, stride, origin) : held;
  if (!edges) return null;
  const [first, last] = edges, y = Math.floor(first / width), bottom = Math.floor(last / width) + 1;
  let [,, x, right] = edges;
  if (!x && !y && right === width && bottom === height) return null;
  const w = right - x, h = bottom - y;
  let cropped = null;
  return {get data() {
    return cropped ||= viewPixels(data, w, h, stride, origin + y * stride + x);
  }, width: w, height: h, x, y, background};
}

export function writeScreenBackground(writer, width, height, shape, background, crop, final = false, canvas) {
  const global = new BitWriter(128), layout = groupLayout(width, height, 1024);
  writeModularFrameHeader(writer, {alpha: shape.alpha, shift: 3, last: final, reference: final ? 0 : 1, crop, canvas});
  global.write(1, 1); global.write(1, 1);
  const leaves = Array.from({length: shape.channels}, (_, c) => leaf(0, background[shape.colour === 1 && c === 1 ? 3 : c]));
  const counts = new Uint32Array(ALPHABET); counts[0] = 1;
  const ordered = writeTree(global, channelTree(leaves)), map = new Uint8Array(ordered.length + 1);
  for (const l of ordered) map[l.context] = 1;
  writeHistograms(global, {lz77: LZ77, contextMap: map, histograms: [{config: RESIDUAL_CONFIG, code: buildCode(Uint32Array.of(0, 1))}, {config: RESIDUAL_CONFIG, code: buildCode(counts)}]});
  writeModularHeader(global);
  const sections = [global.finish()];
  if (!layout.single) {
    for (let i = 0; i < layout.dcGroupsX * layout.dcGroupsY + 1; i++) sections.push(new Uint8Array(0));
    const group = new BitWriter(4); writeModularHeader(group);
    const bytes = group.finish();
    for (let i = 0; i < layout.groupsX * layout.groupsY; i++) sections.push(bytes);
  }
  writeTOC(writer, sections.map(section => section.length));
  for (const section of sections) writer.append({bytes: section, at: section.length, pending: 0, acc: 0});
}

const MAX_REGIONS = 128;

export function screenRegions(data, width, height, splitSlices = false, stride = width, origin = 0) {
  if (width < 2 || height < 2) return null;
  const words = pixelKeys(data), row = y => origin + y * stride, background = words[origin], regions = [];
  let solid = true;
  let gutter = false;
  for (let y = 0; y < height && !gutter; y++) {
    const first = words[row(y)]; gutter = first === words[row(y) + (width >> 1)] && first === words[row(y) + width - 1];
  }
  for (let x = 0; x < width && !gutter; x++) {
    const first = words[origin + x]; gutter = first === words[row(height >> 1) + x] && first === words[row(height - 1) + x];
  }
  if (!gutter) return null;
  const band = (y0, y1) => {
    const edge = words[row(y0)], bandBg = differs(words, row(y0), row(y1), stride, edge) ? background : edge;
    if (bandBg !== background) solid = false;
    const inked = captureColumnsUnlike(words, width, height, stride, origin, y0, y1, bandBg);
    let left = -1;
    for (let x = 0; x <= width; x++) {
      const ink = x < width && (inked ? inked[x] !== 0 : differs(words, row(y0) + x, row(y1) + x, stride, bandBg));
      if (ink && left < 0) left = x;
      else if (!ink && left >= 0) {
        if (splitSlices) {
          let sy0 = -1, gap = 0;
          for (let y = y0; y <= y1; y++) {
            const rowInk = y < y1 && differs(words, row(y) + left, row(y) + x, 1, bandBg);
            if (rowInk) { if (sy0 < 0) sy0 = y; gap = 0; }
            else if (sy0 >= 0 && (++gap >= 8 || y === y1)) {
              regions.push({x: left, y: sy0, width: x - left, height: y - gap + 1 - sy0, background: bandBg});
              sy0 = -1; gap = 0;
              if (regions.length > MAX_REGIONS) return false;
            }
          }
        } else {
          regions.push({x: left, y: y0, width: x - left, height: y1 - y0});
          if (regions.length > MAX_REGIONS) return false;
        }
        left = -1;
      }
    }
    return true;
  };
  let top = -1;
  const unlike = captureRowsUnlike(words, width, height, stride, origin);
  for (let y = 0; y <= height; y++) {
    const ink = y < height && (unlike ? unlike[y] !== 0 : differs(words, row(y) + 1, row(y) + width, 1, words[row(y)]));
    if (ink && top < 0) top = y;
    else if (!ink) {
      if (y < height && words[row(y)] !== background) solid = false;
      if (top >= 0) { if (!band(top, y)) return null; top = -1; }
    }
  }
  return regions.length > 1 ? {regions, background, solid} : null;
}

function differs(words, from, to, step, key) {
  for (let p = from; p < to; p += step) if (words[p] !== key) return true;
  return false;
}

export function commonSample(words, step, width = words.length, height = 1, stride = width, origin = 0) {
  const total = width * height;
  let size = 1024, slots = new Int32Array(size), keys = new Uint32Array(256), counts = new Uint32Array(256), distinct = 0;
  const place = key => {
    let slot = Math.imul(key, 0x9e3779b1) >>> (Math.clz32(size) + 1);
    while (slots[slot] && keys[slots[slot] - 1] !== key) slot = (slot + 1) & (size - 1);
    return slot;
  };
  for (let i = 0, x = 0, at = origin; i < total; i += step) {
    const key = words[at], slot = place(key);
    if (slots[slot]) counts[slots[slot] - 1]++;
    else {
      if (distinct === keys.length) { const k = new Uint32Array(2 * distinct), n = new Uint32Array(2 * distinct); k.set(keys); n.set(counts); keys = k; counts = n; }
      keys[distinct] = key; counts[distinct] = 1; slots[slot] = ++distinct;
      if (2 * distinct > size) {
        size *= 2; slots = new Int32Array(size);
        for (let d = 0; d < distinct; d++) slots[place(keys[d])] = d + 1;
      }
    }
    x += step; at += step;
    while (x >= width) { x -= width; at += stride - width; }
  }
  let best = 0, votes = 0;
  for (let d = 0; d < distinct; d++) if (counts[d] > votes) { votes = counts[d]; best = keys[d]; }
  return best;
}

export function screenColumns(data, width, height, stride = width, origin = 0, crop = null) {
  const words = pixelKeys(data), background = commonSample(words, 97, width, height, stride, origin), row = y => origin + y * stride;
  let lowest;
  if (crop && pixelKeys(crop.background)[0] === background) {
    const inside = captureLowestInk(words, crop.width, crop.height, background, stride, origin + crop.y * stride + crop.x);
    lowest = new Int32Array(width).fill(-1);
    for (let x = 0; x < crop.width; x++) if (inside[x] >= 0) lowest[crop.x + x] = inside[x] + crop.y;
  } else lowest = captureLowestInk(words, width, height, background, stride, origin);
  const tops = [...new Set(lowest)].map(y => y + 1).sort((a, b) => a - b);
  for (const top of tops) {
    if (top * 5 > height) return null;
    const runs = [];
    for (let x = 0; x < width; x++) if (lowest[x] >= top && ((runs.length && x === runs.at(-1).end) || lowest[x + 1] >= top || differs(words, row(top + 1) + x, row(lowest[x] + 1) + x, stride, words[row(top) + x]))) {
      if (runs.length && x - runs.at(-1).end < 32) runs.at(-1).end = x + 1;
      else runs.push({start: x, end: x + 1});
    }
    if (runs.length < 2) continue;
    for (let i = 1; i < runs.length; i++) if (runs[i].start - runs[i - 1].end > 200) return null;
    return {background, regions: runs.map(({start, end}) => {
      let first = top, last = top;
      for (let x = start; x < end; x++) if (lowest[x] > last) last = lowest[x];
      while (first < last && !differs(words, row(first) + start, row(first) + end, 1, background)) first++;
      return {x: start, y: first, width: end - start, height: last - first + 1};
    })};
  }
  return null;
}
