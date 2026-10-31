// SPDX-License-Identifier: MIT
import {complete} from './bits.mjs';
import {admitPixels, fault} from './admit.mjs';
import {admitAnimation} from './animation-frames.mjs';

const MAX_POSITIONS = 262144, MAX_CANDIDATES = 65536;
const pixel = (data, at) => data[at] + data[at + 1] * 256 + data[at + 2] * 65536 + data[at + 3] * 16777216;
const whole = (value, min, max, name) => {
  if (!Number.isInteger(value) || value < min || value > max) throw fault('JXL_INPUT', name + ' is an integer from ' + min + ' to ' + max + '.');
  return value;
};

export function atlasSearchOptions(options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw fault('JXL_INPUT', 'Atlas search options are an object.');
  const strategy = options.strategy ?? 'auto', tileSize = options.tileSize ?? 16;
  if (!['auto', 'glyphs', 'tiles'].includes(strategy)) throw fault('JXL_INPUT', 'Atlas strategy is auto, glyphs or tiles.');
  if (![4, 8, 16, 32, 64].includes(tileSize)) throw fault('JXL_INPUT', 'Atlas tileSize is 4, 8, 16, 32 or 64.');
  return {strategy, tileSize, maxEntries: whole(options.maxEntries ?? 256, 1, 4096, 'Atlas maxEntries'),
    maxPixels: whole(options.maxPixels ?? 262144, 16, 1048576, 'Atlas maxPixels'),
    minUses: whole(options.minUses ?? 2, 2, 65536, 'Atlas minUses')};
}

function equalRect(a, aw, ax, ay, b, bw, bx, by, width, height) {
  for (let y = 0; y < height; y++) {
    const ai = ((ay + y) * aw + ax) * 4, bi = ((by + y) * bw + bx) * 4;
    for (let x = 0; x < width * 4; x++) if (a[ai + x] !== b[bi + x]) return false;
  }
  return true;
}

function glyphBoxes(data, width, height) {
  const size = width * height;
  if (size > 4000000) return [];
  const votes = new Map();
  for (let i = 0; i < 256; i++) {
    const value = pixel(data, Math.min(size - 1, Math.floor((i + .5) * size / 256)) * 4);
    votes.set(value, (votes.get(value) ?? 0) + 1);
  }
  let background = 0, best = 0;
  for (const [value, count] of votes) if (count > best) { best = count; background = value; }
  if (best < 128) return [];
  const seen = new Uint8Array(size), queue = new Int32Array(size), boxes = [];
  for (let p = 0; p < size; p++) {
    if (seen[p] || pixel(data, p * 4) === background) continue;
    let at = 0, count = 1, x0 = p % width, x1 = x0, y0 = Math.floor(p / width), y1 = y0;
    queue[0] = p; seen[p] = 1;
    while (at < count) {
      const q = queue[at++], x = q % width, y = Math.floor(q / width);
      x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if ((!dx && !dy) || x + dx < 0 || x + dx >= width || y + dy < 0 || y + dy >= height) continue;
        const next = q + dy * width + dx;
        if (!seen[next] && pixel(data, next * 4) !== background) { seen[next] = 1; queue[count++] = next; }
      }
    }
    const w = x1 - x0 + 1, h = y1 - y0 + 1;
    if (w <= 64 && h <= 64 && w * h >= 16 && count >= 3) boxes.push({x: x0, y: y0, width: w, height: h});
    if (boxes.length === 32768) break;
  }
  return boxes;
}

export function* discoverAtlasSteps(animation, options) {
  const {width, height, frames} = animation, buckets = new Map();
  let candidates = 0, positions = 0, previous = null;
  const inspect = (frame, box) => {
    const {data} = frames[frame], {x, y, width: w, height: h} = box;
    if (previous && equalRect(data, width, x, y, previous, width, x, y, w, h)) return;
    let hash = 2166136261, first = -1, flat = true;
    for (let v = 0; v < h; v++) for (let u = 0; u < w; u++) {
      const value = pixel(data, ((y + v) * width + x + u) * 4);
      if (first < 0) first = value; else if (value !== first) flat = false;
      hash = Math.imul(hash ^ value, 16777619) >>> 0;
    }
    if (flat || positions === MAX_POSITIONS) return;
    const key = w + ',' + h + ',' + hash, list = buckets.get(key) ?? [];
    let entry = list.find(candidate => equalRect(data, width, x, y, frames[candidate.frame].data, width,
      candidate.x, candidate.y, w, h));
    if (!entry) {
      if (candidates === MAX_CANDIDATES || list.length === 4) return;
      entry = {frame, ...box, order: candidates++, positions: [], positionKeys: new Set()}; list.push(entry); buckets.set(key, list);
    }
    const positionKey = (frame * height + y) * width + x;
    if (entry.positionKeys.has(positionKey)) return;
    entry.positionKeys.add(positionKey);
    entry.positions.push({frame, x, y}); positions++;
  };
  for (let frame = 0; frame < frames.length; frame++) {
    const shown = frames[frame].duration > 0 || frame === frames.length - 1 && !previous;
    if (shown) {
      const data = frames[frame].data;
      if (options.strategy !== 'tiles') for (const box of glyphBoxes(data, width, height)) inspect(frame, box);
      if (options.strategy !== 'glyphs') for (let y = 0; y < height; y += options.tileSize) for (let x = 0; x < width; x += options.tileSize) {
        const w = Math.min(options.tileSize, width - x), h = Math.min(options.tileSize, height - y);
        if (w * h >= 16) inspect(frame, {x, y, width: w, height: h});
      }
      previous = data;
    }
    yield (frame + 1) / frames.length * .9;
  }
  const entries = [];
  for (const list of buckets.values()) for (const entry of list) if (entry.positions.length >= options.minUses) entries.push(entry);
  entries.sort((a, b) => (b.positions.length - 1) * b.width * b.height - (a.positions.length - 1) * a.width * a.height || a.order - b.order);
  const selected = []; let area = 0;
  for (const entry of entries) {
    if (selected.length === options.maxEntries) break;
    if (area + entry.width * entry.height > options.maxPixels) continue;
    selected.push(entry); area += entry.width * entry.height;
  }
  if (!selected.length) return null;
  let atlasWidth = 16;
  while (atlasWidth < Math.max(...selected.map(entry => entry.width)) || atlasWidth < 1024 && atlasWidth * atlasWidth < area) atlasWidth *= 2;
  let x = 0, y = 0, rowHeight = 0;
  const packed = [];
  for (const entry of selected) {
    if (x + entry.width > atlasWidth) { y += rowHeight; x = 0; rowHeight = 0; }
    if ((y + Math.max(rowHeight, entry.height)) * atlasWidth > options.maxPixels) continue;
    packed.push({...entry, sourceX: x, sourceY: y}); x += entry.width; rowHeight = Math.max(rowHeight, entry.height);
  }
  if (!packed.length) return null;
  const atlasHeight = y + rowHeight, data = new Uint8Array(atlasWidth * atlasHeight * 4);
  for (let i = 3; i < data.length; i += 4) data[i] = 255;
  for (const entry of packed) for (let row = 0; row < entry.height; row++) {
    const from = ((entry.y + row) * width + entry.x) * 4;
    data.set(frames[entry.frame].data.subarray(from, from + entry.width * 4), ((entry.sourceY + row) * atlasWidth + entry.sourceX) * 4);
  }
  yield 1;
  return {atlas: {data, width: atlasWidth, height: atlasHeight}, patches: packed.map(entry => ({sourceX: entry.sourceX,
    sourceY: entry.sourceY, width: entry.width, height: entry.height, positions: entry.positions}))};
}

export function validateAtlasPlan(animation, plan) {
  if (!plan || typeof plan !== 'object' || !plan.atlas || typeof plan.atlas !== 'object')
    throw fault('JXL_INPUT', 'An animation atlas plan supplies atlas and patches.');
  const {data, width, height} = plan.atlas;
  admitPixels(data, width, height);
  if (!(data instanceof Uint8Array || data instanceof Uint8ClampedArray)) throw fault('JXL_INPUT', 'An animation atlas uses RGBA8 samples.');
  if (width * height > 1048576) throw fault('JXL_SIZE', 'An animation atlas has at most 1,048,576 pixels.');
  if (!Array.isArray(plan.patches) || !plan.patches.length || plan.patches.length > 4096)
    throw fault('JXL_INPUT', 'An animation atlas has 1 to 4096 source rectangles.');
  const byData = new Map(), budget = 4 * animation.width * animation.height * animation.frames.length;
  let total = 0, compared = 0;
  for (const entry of plan.patches) {
    if (!entry || typeof entry !== 'object') throw fault('JXL_INPUT', 'An atlas patch is an object.');
    const sx = whole(entry.sourceX, 0, width - 1, 'Atlas sourceX'), sy = whole(entry.sourceY, 0, height - 1, 'Atlas sourceY');
    const w = whole(entry.width, 1, Math.min(width - sx, animation.width), 'Atlas patch width');
    const h = whole(entry.height, 1, Math.min(height - sy, animation.height), 'Atlas patch height');
    if (!Array.isArray(entry.positions) || !entry.positions.length || entry.positions.length > MAX_POSITIONS - total)
      throw fault('JXL_INPUT', 'Atlas positions are nonempty, with at most 262144 positions in the plan.');
    total += entry.positions.length;
    compared += w * h * entry.positions.length;
    if (compared > budget) throw fault('JXL_INPUT', 'Atlas positions cover more than four times the animation; supply fewer or smaller rectangles.');
    for (const position of entry.positions) {
      if (!position || typeof position !== 'object') throw fault('JXL_INPUT', 'An atlas position supplies frame, x and y.');
      const frame = whole(position.frame, 0, animation.frames.length - 1, 'Atlas frame');
      const x = whole(position.x, 0, animation.width - w, 'Atlas x'), y = whole(position.y, 0, animation.height - h, 'Atlas y');
      const source = animation.frames[frame].data;
      if (!equalRect(source, animation.width, x, y, data, width, sx, sy, w, h))
        throw fault('JXL_INPUT', 'An atlas placement differs from its source frame, including alpha or hidden RGB.');
      const list = byData.get(source) ?? [];
      list.push({sx, sy, w, h, x, y}); byData.set(source, list);
    }
  }
  return {atlas: {data, width, height}, byData};
}

export function atlasCropPlan(plan, crop, width, height, job, alpha) {
  const list = plan.byData.get(job.data), limit = Math.floor(width * height / 16);
  if (!list || !limit) return null;
  const [x0, y0] = job.rect, choices = [];
  for (const patch of list) {
    const x = Math.max(x0, patch.x), y = Math.max(y0, patch.y), right = Math.min(x0 + width, patch.x + patch.w), bottom = Math.min(y0 + height, patch.y + patch.h);
    const w = right - x, h = bottom - y, sx = patch.sx + x - patch.x, sy = patch.sy + y - patch.y;
    if (w * h < 16 || w <= 0 || h <= 0 || !equalRect(crop, width, x - x0, y - y0, plan.atlas.data, plan.atlas.width, sx, sy, w, h)) continue;
    choices.push({sx, sy, w, h, x: x - x0, y: y - y0});
  }
  choices.sort((a, b) => b.w * b.h - a.w * a.h || a.y - b.y || a.x - b.x || a.sy - b.sy || a.sx - b.sx);
  const occupied = new Uint8Array(width * height), groups = new Map(), body = crop.slice(), colors = new Map();
  for (let p = 0; p < Math.min(256, width * height); p++) {
    const at = Math.floor((p + .5) * width * height / Math.min(256, width * height)), value = pixel(crop, at * 4);
    colors.set(value, (colors.get(value) ?? 0) + 1);
  }
  let fill = 0, most = 0;
  for (const [value, count] of colors) if (count > most) { fill = value; most = count; }
  const background = [fill & 255, Math.floor(fill / 256) & 255, Math.floor(fill / 65536) & 255, Math.floor(fill / 16777216)];
  let placements = 0;
  for (const choice of choices) {
    const {x, y, w, h, sx, sy} = choice, key = sx + ',' + sy + ',' + w + ',' + h;
    if (placements === limit * 4 || !groups.has(key) && groups.size === limit) continue;
    let overlaps = false;
    for (let row = y; row < y + h && !overlaps; row++) for (let column = x; column < x + w; column++) if (occupied[row * width + column]) { overlaps = true; break; }
    if (overlaps) continue;
    const group = groups.get(key) ?? {reference: 3, sx, sy, w, h, positions: []};
    group.positions.push({x, y, blending: Array.from({length: 1 + Number(alpha)}, () => ({mode: 1, alpha: 0, clamp: false}))});
    groups.set(key, group); placements++;
    for (let row = y; row < y + h; row++) for (let column = x; column < x + w; column++) {
      const p = row * width + column; occupied[p] = 1; body.set(background, p * 4);
    }
  }
  if (!groups.size) return null;
  return {body, groups: [...groups.values()], extraChannels: Number(alpha),
    tokens: 1 + groups.size * 6 + placements * (3 + Number(alpha))};
}

export function buildAnimationAtlas(animation, options) {
  const admitted = admitAnimation(animation, {}), search = atlasSearchOptions(options);
  if (!admitted.samples.native8) throw fault('JXL_INPUT', 'Atlas discovery uses straight RGBA8 samples.');
  return complete(discoverAtlasSteps(admitted, search));
}
