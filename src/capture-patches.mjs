// SPDX-License-Identifier: MIT
import {FRAME_SIZE, packSigned} from './bits.mjs';
import {pixelKeys} from './screen-crop.mjs';
import {capturePatchMarks, capturePeelMarks, capturePeelBackground, capturePeelTools} from './capture-kernels.mjs';
import {buildCode, hybridToken, uintConfig, writeHistograms, writeHybrid} from './prefix.mjs';

export const PATCH_SLOT = 2;
const MAX_SIDE = 128, MAX_MARKS = 1 << 16, token = [0, 0, 0];

export function capturePatches(rgba, width, height, least = 0) {
  if (width < 16 || height < 16 || width * height > 1 << 25) return null;
  const keys = pixelKeys(rgba), found = capturePatchGroups(keys, width, height, least);
  if (!found) return null;
  const {groups, side, area, placements, cover} = found;
  const {atlas, atlasKeys, atlasWidth, atlasHeight} = packAtlas(groups, side, area, keys[0]);
  for (const g of groups)
    for (let r = 0; r < g.h; r++) atlasKeys.set(keys.subarray((g.y + r) * width + g.x, (g.y + r) * width + g.x + g.w), (g.ay + r) * atlasWidth + g.ax);
  return {groups, atlas, width: atlasWidth, height: atlasHeight, placements, cover};
}

export function capturePatchGroups(keys, width, height, least = 0) {
  const n = width * height;
  if (width < 16 || height < 16 || n > 1 << 25) return null;
  const boxes = capturePatchMarks(keys, width, height, MAX_SIDE, MAX_MARKS, 4);
  if (!boxes) return null;
  let marked = 0;
  for (let i = 2; i < boxes.length; i += 4) marked += boxes[i] * boxes[i + 1];
  if (marked < least * n) return null;
  const same = (ax, ay, bx, by, w, h) => {
    for (let y = 0; y < h; y++) for (let a = (ay + y) * width + ax, b = (by + y) * width + bx, e = a + w; a < e; a++, b++)
      if (keys[a] !== keys[b]) return false;
    return true;
  };
  const buckets = new Map(), groups = [];
  for (let i = 0; i < boxes.length; i += 4) {
    const x = boxes[i], y = boxes[i + 1], w = boxes[i + 2], h = boxes[i + 3];
    let hash = Math.imul(w, 0x9e3779b1) ^ h;
    for (const r of [0, h >> 1, h - 1]) for (let p = (y + r) * width + x, e = p + w; p < e; p++) hash = Math.imul(hash ^ keys[p], 16777619);
    const list = buckets.get(hash);
    let group = list?.find(g => g.w === w && g.h === h && same(g.x, g.y, x, y, w, h));
    if (group) group.positions.push(x, y);
    else {
      group = {x, y, w, h, positions: [x, y]};
      groups.push(group);
      if (list) list.push(group); else buckets.set(hash, [group]);
    }
  }
  const kept = groups.filter(g => { const c = g.positions.length >> 1; return c >= 2 && (c - 1) * 3 * g.h > 3.5 * c + 8; });
  if (!kept.length) return null;
  let placements = 0, area = 0, side = 0, repeats = 0;
  for (const g of kept) { const c = g.positions.length >> 1; placements += c; area += g.w * g.h; repeats += (c - 1) * g.w * g.h; side = Math.max(side, g.w); }
  if (placements * 16 > n || repeats < least * n) return null;
  kept.sort((a, b) => b.h - a.h || b.w - a.w);
  return {groups: kept, side, area, placements, cover: repeats / n};
}

function packAtlas(groups, side, area, fill) {
  const atlasWidth = Math.max(side, Math.min(1024, Math.ceil(Math.sqrt(area * 1.25))));
  let ax = 0, ay = 0, rowHeight = 0;
  for (const g of groups) {
    if (ax + g.w > atlasWidth) { ay += rowHeight; ax = 0; rowHeight = 0; }
    g.ax = ax; g.ay = ay; ax += g.w; rowHeight = Math.max(rowHeight, g.h);
  }
  const atlasHeight = ay + rowHeight, atlas = new Uint8Array(atlasWidth * atlasHeight * 4), atlasKeys = pixelKeys(atlas);
  atlasKeys.fill(fill);
  return {atlas, atlasKeys, atlasWidth, atlasHeight};
}

export function fillPatches(plane, width, patches) {
  for (const g of patches.groups) for (let i = 0; i < g.positions.length; i += 2) {
    const x = g.positions[i], y = g.positions[i + 1];
    for (let r = 0, row = y * width; r < g.h; r++, row += width)
      plane.fill(plane[x ? row + x - 1 : x + g.w < width ? row + x + g.w : row], row + x, row + x + g.w);
  }
}

export function writeCapturePatches(w, patches, alpha) {
  if (!(typeof __RAPIER_JXL_JPEG__ !== 'undefined' && __RAPIER_JXL_JPEG__ === true) && patches.peel && !patches.ordered) {
    patches.ordered = true;
    const raster = patches.groups.map(g => g.positions), walked = patches.groups.map(g => {
      const n = g.positions.length >> 1;
      if (n < 3 || n > 512) return g.positions;
      const left = Array.from({length: n}, (_, i) => i), out = [];
      for (let x = 0, y = 0; left.length;) {
        let best = 0, d = Infinity;
        for (let k = 0; k < left.length; k++) { const i = left[k], e = Math.abs(g.positions[2 * i] - x) + 4 * Math.abs(g.positions[2 * i + 1] - y); if (e < d) { d = e; best = k; } }
        const i = left[best]; left[best] = left[left.length - 1]; left.pop();
        out.push(x = g.positions[2 * i], y = g.positions[2 * i + 1]);
      }
      return out;
    });
    const bits = all => {
      const counts = new Uint32Array(64);
      let raw = 0, n = 0;
      for (const p of all) for (let i = 2; i < p.length; i++) {
        const v = packSigned(p[i] - p[i - 2]), e = 31 - Math.clz32(v);
        counts[v < 16 ? v : 16 + (e - 4) * 4 + (v >> e - 2 & 3)]++; raw += v < 16 ? 0 : e - 2; n++;
      }
      for (const c of counts) if (c) raw -= c * Math.log2(c / n);
      return raw;
    };
    const walk = bits(walked) < bits(raster);
    patches.groups.forEach((g, k) => g.positions = walk ? walked[k] : raster[k]);
  }
  dictionary(w, patches, alpha);
}
function dictionary(w, patches, alpha) {
  const values = [], emit = (ctx, value) => values.push(ctx, value), at = w.bitLength;
  emit(0, patches.groups.length);
  for (const g of patches.groups) {
    emit(1, PATCH_SLOT); emit(3, g.ax); emit(3, g.ay); emit(2, g.w - 1); emit(2, g.h - 1); emit(7, (g.positions.length >> 1) - 1);
    for (let i = 0, x = 0, y = 0; i < g.positions.length; i += 2) {
      const px = g.positions[i], py = g.positions[i + 1];
      emit(i ? 6 : 4, i ? packSigned(px - x) : px); emit(i ? 6 : 4, i ? packSigned(py - y) : py);
      x = px; y = py;
      emit(5, g.mode ?? 1);
      if (g.mode === PEEL_MUL) emit(9, 0);
      if (alpha) { emit(5, g.mode ?? 1); if (g.mode === PEEL_MUL) emit(9, 0); }
    }
  }
  const freqs = new Uint32Array(512), lengths = new Uint32Array(10), byContext = Array.from({length: 10}, () => new Map());
  for (let i = 0; i < values.length; i += 2) {
    const ctx = values[i], value = values[i + 1], counts = byContext[ctx];
    counts.set(value, (counts.get(value) ?? 0) + 1); lengths[ctx]++;
  }
  const histograms = byContext.map((counts, ctx) => {
    let best = null;
    for (let split = 0; split <= 8; split++) for (let msb = 0; msb <= 1 && msb <= split; msb++) for (let lsb = 0; msb + lsb <= split && lsb <= 1; lsb++) {
      const config = uintConfig(split, msb, lsb);
      let bits = 0, top = 0;
      for (const [v, n] of counts) { hybridToken(config, v, token); freqs[token[0]] += n; bits += token[1] * n; top = Math.max(top, token[0]); }
      for (let t = 0; t <= top; t++) if (freqs[t]) { bits -= freqs[t] * Math.log2(freqs[t] / lengths[ctx]); freqs[t] = 0; }
      if (!best || bits < best.bits) best = {config, bits};
    }
    let top = 0;
    for (const [v, n] of counts) { hybridToken(best.config, v, token); freqs[token[0]] += n; top = Math.max(top, token[0]); }
    const code = buildCode(freqs.slice(0, top + 1));
    freqs.fill(0, 0, top + 1);
    return {config: best.config, code};
  });
  writeHistograms(w, {contextMap: Uint8Array.from({length: 10}, (_, i) => i), histograms});
  for (let i = 0; i < values.length; i += 2) writeHybrid(w, histograms[values[i]].code, histograms[values[i]].config, values[i + 1]);
  patches.dictionary = w.bitLength - at;
}

export function writeAtlasFrameHeader(w, alpha, width, height, shift = 3) {
  const u = alpha ? 4 : 2;
  w.write(10 + u, 12 | shift << 7 + u | 1 << 9 + u);
  w.writeU32(FRAME_SIZE, width); w.writeU32(FRAME_SIZE, height);
  w.write(13, PATCH_SLOT | 4);
}

export function writePatchedFrameHeader(w, alpha, shift = 3) {
  const u = alpha ? 4 : 2;
  w.write(17 + 2 * u, 88 | shift << 11 + u | 1 << 16 + 2 * u);
  w.write(10, 0);
}

export const PEEL_ADD = 2, PEEL_MUL = 3;
const WORD_GLYPH = 14, MIN_GLYPH_INK = 12;

export function capturePeel(rgba, width, height, least = 0, glyph = WORD_GLYPH) {
  const n = width * height;
  if (width < 16 || height < 16 || n > 1 << 25) return null;
  const keys = pixelKeys(rgba), bg0 = capturePeelBackground(keys.subarray(0, n)), mul = bg0 === 0xffffffff,
    found = capturePeelMarks(keys, width, height, bg0 | 0, MAX_SIDE);
  if (!found) return null;
  const kernels = capturePeelTools(bg0), {runs} = found, marks = [];
  const mode = mul ? PEEL_MUL : PEEL_ADD, first = [], groups = [];
  let buckets = new Map();
  const add = (into, cells, w, h, positions, info = kernels.info(cells, w, h)) => {
    const list = buckets.get(info.hash), group = list?.find(g => g.w === w && g.h === h && kernels.equal(g.cells, cells));
    if (group) { for (const position of positions) group.positions.push(position); return; }
    const made = {w, h, mode, cells, positions: [...positions], hash: info.hash, inkCount: info.inkCount};
    into.push(made);
    if (list) list.push(made); else buckets.set(info.hash, [made]);
  };
  let inked = 0;
  for (let i = 0; i < found.marks.length; i += 6) {
    const mark = {x: found.marks[i], y: found.marks[i + 1], w: found.marks[i + 2], h: found.marks[i + 3],
      start: found.marks[i + 4], end: found.marks[i + 5]}, extracted = kernels.cells(keys, width, mark, runs);
    if (extracted) { marks.push(mark); inked += extracted.pixels; add(first, extracted.cells, mark.w, mark.h, [mark.x, mark.y]); }
  }
  if (!marks.length || inked < least * n) return null;
  buckets = new Map();
  const templates = first.filter(g => g.w <= glyph && g.inkCount >= MIN_GLYPH_INK).sort((a, b) => b.inkCount - a.inkCount);
  for (const t of templates) t.ink = kernels.info(t.cells, t.w, t.h, true).ink;
  kernels.templates(templates);
  const moved = (positions, dx, dy) => positions.map((v, i) => v + (i & 1 ? dy : dx));
  for (const g of first) {
    if (g.w <= glyph) { add(groups, g.cells, g.w, g.h, g.positions, g); continue; }
    const factored = kernels.factor(g);
    for (let i = 0; i < factored.matches.length; i += 3) {
      const t = templates[factored.matches[i]];
      add(groups, t.cells, t.w, t.h, moved(g.positions, factored.matches[i + 1], factored.matches[i + 2]), t);
    }
    if (factored.cells) add(groups, factored.cells, factored.width, factored.height, moved(g.positions, factored.x, factored.y));
  }
  kernels.contain(groups);
  const body = kernels.body(keys, width, height, marks, runs);
  let placements = 0, area = 0, side = 0;
  for (const g of groups) {
    placements += g.positions.length >> 1;
    if (!g.in) { area += g.w * g.h; side = Math.max(side, g.w); }
    const order = Array.from({length: g.positions.length >> 1}, (_, i) => i).sort((a, b) => g.positions[2 * a + 1] - g.positions[2 * b + 1] || g.positions[2 * a] - g.positions[2 * b]);
    g.positions = order.flatMap(i => [g.positions[2 * i], g.positions[2 * i + 1]]);
  }
  const {atlas, atlasKeys, atlasWidth, atlasHeight} = packAtlas(groups.filter(g => !g.in).sort((a, b) => b.h - a.h || b.w - a.w), side, area, 0xffffffff);
  const place = g => { if (g.in && g.ax === undefined) { place(g.in); g.ax = g.in.ax + g.ox; g.ay = g.in.ay + g.oy; } };
  for (const g of groups) place(g);
  for (const g of groups) if (!g.in) for (let r = 0; r < g.h; r++) atlasKeys.set(g.cells.subarray(r * g.w, (r + 1) * g.w), (g.ay + r) * atlasWidth + g.ax);
  for (const g of groups) { g.cells = null; g.in = null; delete g.hash; delete g.inkCount; }
  return {groups, atlas, width: atlasWidth, height: atlasHeight, placements, cover: inked / n, body: new Uint8Array(body.buffer), peel: true};
}
