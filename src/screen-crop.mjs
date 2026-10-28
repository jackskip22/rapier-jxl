// SPDX-License-Identifier: MIT
import {BitWriter} from './bits.mjs';
import {writeModularFrameHeader, writeTOC, groupLayout} from './frame.mjs';
import {leaf, channelTree, writeTree, writeChannelHistograms, writeModularHeader, ALPHABET} from './modular.mjs';

const LITTLE = new Uint8Array(Uint32Array.of(1).buffer)[0] === 1;
export function pixelKeys(rgba) {
  if (LITTLE && !(rgba.byteOffset & 3)) return new Uint32Array(rgba.buffer, rgba.byteOffset, rgba.length >> 2);
  const keys = new Uint32Array(rgba.length >> 2);
  for (let i = 0; i < keys.length; i++) keys[i] = (rgba[4 * i] | rgba[4 * i + 1] << 8 | rgba[4 * i + 2] << 16 | rgba[4 * i + 3] << 24) >>> 0;
  return keys;
}

export function screenCrop(data, width, height) {
  const background = Uint8Array.of(data[0], data[1], data[2], data[3]);
  const view = new DataView(data.buffer, data.byteOffset, width * height * 4), color = view.getUint32(0, true), size = width * height;
  let first = 0, last = size - 1;
  while (first + 4 <= size && view.getUint32(first * 4, true) === color && view.getUint32((first + 1) * 4, true) === color &&
      view.getUint32((first + 2) * 4, true) === color && view.getUint32((first + 3) * 4, true) === color) first += 4;
  while (first < size && view.getUint32(first * 4, true) === color) first++;
  if (first === size) return null;
  while (last - 4 >= first && view.getUint32(last * 4, true) === color && view.getUint32((last - 1) * 4, true) === color &&
      view.getUint32((last - 2) * 4, true) === color && view.getUint32((last - 3) * 4, true) === color) last -= 4;
  while (last >= first && view.getUint32(last * 4, true) === color) last--;
  const y = Math.floor(first / width), bottom = Math.floor(last / width) + 1;
  let x = first % width, right = last % width + 1;
  for (let row = y; row < bottom && (x || right < width); row++) {
    const start = row * width; let col = 0;
    while (col + 4 <= x && view.getUint32((start + col) * 4, true) === color && view.getUint32((start + col + 1) * 4, true) === color &&
        view.getUint32((start + col + 2) * 4, true) === color && view.getUint32((start + col + 3) * 4, true) === color) col += 4;
    while (col < x && view.getUint32((start + col) * 4, true) === color) col++;
    if (col < x) x = col;
    col = width - 1;
    while (col - 3 >= right && view.getUint32((start + col) * 4, true) === color && view.getUint32((start + col - 1) * 4, true) === color &&
        view.getUint32((start + col - 2) * 4, true) === color && view.getUint32((start + col - 3) * 4, true) === color) col -= 4;
    while (col >= right && view.getUint32((start + col) * 4, true) === color) col--;
    if (col >= right) right = col + 1;
  }
  if (!x && !y && right === width && bottom === height) return null;
  const w = right - x, h = bottom - y;
  let cropped = null;
  return {get data() {
    if (!cropped) {
      cropped = new Uint8Array(w * h * 4);
      for (let row = 0; row < h; row++) { const at = ((row + y) * width + x) * 4; cropped.set(data.subarray(at, at + w * 4), row * w * 4); }
    }
    return cropped;
  }, width: w, height: h, x, y, background};
}

export function writeScreenBackground(writer, width, height, shape, background, crop) {
  const global = new BitWriter(128), layout = groupLayout(width, height, 1024);
  writeModularFrameHeader(writer, {alpha: shape.alpha, shift: 3, last: false, reference: 1, crop});
  global.write(1, 1); global.write(1, 1);
  const leaves = Array.from({length: shape.channels}, (_, c) => leaf(0, background[shape.colour === 1 && c === 1 ? 3 : c]));
  const counts = new Uint32Array(ALPHABET); counts[0] = 1;
  writeChannelHistograms(global, writeTree(global, channelTree(leaves)), [counts], () => 0);
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

export function screenRegions(data, width, height) {
  if (width < 2 || height < 2) return null;
  const words = pixelKeys(data), background = words[0], regions = [];
  let gutter = false;
  for (let y = 0; y < height && !gutter; y++) {
    const first = words[y * width]; gutter = first === words[y * width + (width >> 1)] && first === words[y * width + width - 1];
  }
  for (let x = 0; x < width && !gutter; x++) {
    const first = words[x]; gutter = first === words[(height >> 1) * width + x] && first === words[(height - 1) * width + x];
  }
  if (!gutter) return null;
  const band = (y0, y1) => {
    let left = -1;
    for (let x = 0; x <= width; x++) {
      const ink = x < width && differs(words, y0 * width + x, y1 * width + x, width, background);
      if (ink && left < 0) left = x;
      else if (!ink && left >= 0) {
        regions.push({x: left, y: y0, width: x - left, height: y1 - y0}); left = -1;
        if (regions.length > MAX_REGIONS) return false;
      }
    }
    return true;
  };
  let top = -1;
  for (let y = 0; y <= height; y++) {
    const ink = y < height && differs(words, y * width + 1, (y + 1) * width, 1, words[y * width]);
    if (ink && top < 0) top = y;
    else if (!ink && top >= 0) { if (!band(top, y)) return null; top = -1; }
  }
  return regions.length > 1 ? {regions, background} : null;
}

function differs(words, from, to, step, key) {
  for (let p = from; p < to; p += step) if (words[p] !== key) return true;
  return false;
}

export function screenColumns(data, width, height) {
  const words = pixelKeys(data), seen = new Map();
  for (let i = 0; i < words.length; i += 97) seen.set(words[i], (seen.get(words[i]) || 0) + 1);
  let background = 0, votes = 0;
  for (const [colour, n] of seen) if (n > votes) { votes = n; background = colour; }
  const lowest = new Int32Array(width).fill(-1), open = new Int32Array(width);
  let count = width;
  for (let x = 0; x < width; x++) open[x] = x;
  for (let y = height - 1; y >= 0 && count; y--) count = inkRow(words, y * width, y, open, count, lowest, background);
  const tops = [...new Set(lowest)].map(y => y + 1).sort((a, b) => a - b);
  for (const top of tops) {
    if (height - top < height / 2) return null;
    const runs = [];
    for (let x = 0; x < width; x++) if (lowest[x] >= top) {
      if (runs.length && x - runs.at(-1).end < 44) runs.at(-1).end = x + 1;
      else runs.push({start: x, end: x + 1});
    }
    if (runs.length < 2) continue;
    for (let i = 1; i < runs.length; i++) if (runs[i].start - runs[i - 1].end > 200) return null;
    return {background, regions: runs.map(({start, end}) => {
      let first = -1, last = -1;
      for (let y = top; y < height; y++) if (differs(words, y * width + start, y * width + end, 1, background)) { if (first < 0) first = y; last = y; }
      return {x: start, y: first, width: end - start, height: last - first + 1};
    })};
  }
  return null;
}

function inkRow(words, row, y, open, count, lowest, background) {
  let kept = 0;
  for (let i = 0; i < count; i++) { const x = open[i]; if (words[row + x] !== background) lowest[x] = y; else open[kept++] = x; }
  return kept;
}
