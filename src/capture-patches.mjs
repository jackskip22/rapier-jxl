// SPDX-License-Identifier: MIT
import {FRAME_SIZE, packSigned} from './bits.mjs';
import {pixelKeys} from './screen-crop.mjs';
import {capturePatchMarks, capturePeelMarks} from './capture-kernels.mjs';
import {buildCode, hybridToken, uintConfig, writeHistograms, writeHybrid} from './prefix.mjs';

export const PATCH_SLOT = 2;
const MAX_SIDE = 128, MAX_MARKS = 1 << 16, token = [0, 0, 0];

export function capturePatches(rgba, width, height, least = 0) {
  const n = width * height;
  if (width < 16 || height < 16 || n > 1 << 25) return null;
  const keys = pixelKeys(rgba), boxes = capturePatchMarks(keys, width, height, MAX_SIDE, MAX_MARKS, 4);
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
  const {atlas, atlasKeys, atlasWidth, atlasHeight} = packAtlas(kept, side, area, keys[0]);
  for (const g of kept)
    for (let r = 0; r < g.h; r++) atlasKeys.set(keys.subarray((g.y + r) * width + g.x, (g.y + r) * width + g.x + g.w), (g.ay + r) * atlasWidth + g.ax);
  return {groups: kept, atlas, width: atlasWidth, height: atlasHeight, placements, cover: repeats / n};
}

function packAtlas(groups, side, area, fill) {
  groups.sort((a, b) => b.h - a.h || b.w - a.w);
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
  if ((typeof __RAPIER_JXL_UPLOAD__ === 'undefined' || !__RAPIER_JXL_UPLOAD__) && patches.peel && !patches.ordered) {
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

function contain(groups, id) {
  const counts = new Map(), at = new Map();
  groups.forEach((g, k) => { for (let i = 0; i < g.cells.length; i++) { const v = g.cells[i]; if (v === id) continue; counts.set(v, (counts.get(v) || 0) + 1); const list = at.get(v); if (list) list.push(k, i); else at.set(v, [k, i]); } });
  for (const t of groups) {
    let anchor = -1, fewest = Infinity;
    for (let i = 0; i < t.cells.length; i++) { const v = t.cells[i]; if (v !== id && counts.get(v) < fewest) { fewest = counts.get(v); anchor = i; } }
    if (anchor < 0 || fewest < 2) continue;
    const list = at.get(t.cells[anchor]), tx = anchor % t.w, ty = anchor / t.w | 0;
    for (let j = 0; j < list.length; j += 2) {
      const g = groups[list[j]];
      if (g.w * g.h <= t.w * t.h) continue;
      const ox = list[j + 1] % g.w - tx, oy = (list[j + 1] / g.w | 0) - ty;
      if (ox < 0 || oy < 0 || ox + t.w > g.w || oy + t.h > g.h) continue;
      let same = true;
      for (let y = 0; y < t.h && same; y++) for (let x = 0, a = y * t.w, b = (oy + y) * g.w + ox; x < t.w; x++) if (t.cells[a + x] !== g.cells[b + x]) { same = false; break; }
      if (same) { t.in = g; t.ox = ox; t.oy = oy; break; }
    }
  }
}

export function capturePeel(rgba, width, height, least = 0, glyph = WORD_GLYPH) {
  const n = width * height;
  if (width < 16 || height < 16 || n > 1 << 25) return null;
  const keys = pixelKeys(rgba);
  const counts = new Map(), sample = new Int32Array(keys.buffer, keys.byteOffset, n);
  for (let i = 0; i < n; i += 61) counts.set(sample[i], (counts.get(sample[i]) || 0) + 1);
  let bg0 = keys[0], most = 0;
  for (const [k, c] of counts) if (c > most) { most = c; bg0 = k >>> 0; }
  const signed = sample, mul = bg0 === 0xffffffff, br = bg0 & 255, bgg = bg0 >>> 8 & 255, bb = bg0 >>> 16 & 255, ba = bg0 >>> 24;
  const found = capturePeelMarks(keys, width, height, bg0 | 0, MAX_SIDE);
  if (!found) return null;
  const {runs} = found, marks = [];
  for (let i = 0; i < found.marks.length; i += 6) {
    const start = found.marks[i + 4], end = found.marks[i + 5];
    let ok = true, pixels = 0;
    for (let k = start; k < end && ok; k += 3) for (let p = runs[k] * width + runs[k + 1], q = runs[k] * width + runs[k + 2]; p <= q; p++) {
      const v = keys[p];
      pixels++;
      if (!mul && ((v & 255) < br || (v >>> 8 & 255) < bgg || (v >>> 16 & 255) < bb || v >>> 24 < ba)) { ok = false; break; }
    }
    if (!ok) continue;
    if (pixels >= 1024) {
      const colours = new Set();
      for (let k = start; k < end; k += 3) for (let p = runs[k] * width + runs[k + 1], q = runs[k] * width + runs[k + 2]; p <= q; p++) colours.add(signed[p]);
      if (colours.size >= 1024 && colours.size * 2 > pixels) continue;
    }
    marks.push({x: found.marks[i], y: found.marks[i + 1], w: found.marks[i + 2], h: found.marks[i + 3], start, end});
  }
  let inked = 0;
  for (const m of marks) for (let k = m.start; k < m.end; k += 3) inked += runs[k + 2] - runs[k + 1] + 1;
  if (!marks.length || inked < least * n) return null;
  const mode = mul ? PEEL_MUL : PEEL_ADD, id = mul ? 0xffffffff : 0, first = [], groups = [];
  let buckets = new Map();
  const add = (into, cells, w, h, positions) => {
    let hash = Math.imul(w, 0x9e3779b1) ^ h;
    for (let i = 0; i < cells.length; i++) hash = Math.imul(hash ^ cells[i], 16777619);
    const list = buckets.get(hash), group = list?.find(g => g.w === w && g.h === h && g.cells.every((v, i) => v === cells[i]));
    if (group) { group.positions.push(...positions); return; }
    const made = {w, h, mode, cells, positions: [...positions]};
    into.push(made);
    if (list) list.push(made); else buckets.set(hash, [made]);
  };
  for (const m of marks) {
    const cells = new Uint32Array(m.w * m.h).fill(id);
    for (let k = m.start; k < m.end; k += 3) {
      const y = runs[k], from = y * width + runs[k + 1], to = y * width + runs[k + 2], at = (y - m.y) * m.w - m.x - y * width;
      if (mul) cells.set(keys.subarray(from, to + 1), at + from);
      else for (let p = from; p <= to; p++) cells[at + p] = keys[p] - bg0 >>> 0;
    }
    add(first, cells, m.w, m.h, [m.x, m.y]);
  }
  buckets = new Map();
  const inkOf = g => g.cells.reduce((n, v) => n + (v !== id), 0), anchors = new Map();
  for (const t of first.filter(g => g.w <= glyph && inkOf(g) >= MIN_GLYPH_INK).sort((a, b) => inkOf(b) - inkOf(a))) {
    t.ink = [];
    for (let c = t.cells.length - 1; c >= 0; c--) if (t.cells[c] !== id) t.ink.push(c % t.w, c / t.w | 0, t.cells[c]);
    t.anchor = t.ink.length - 3;
    const list = anchors.get(t.ink[t.anchor + 2]);
    if (list) list.push(t); else anchors.set(t.ink[t.anchor + 2], [t]);
  }
  const moved = (positions, dx, dy) => positions.map((v, i) => v + (i & 1 ? dy : dx));
  for (const g of first) {
    if (g.w <= glyph) { add(groups, g.cells, g.w, g.h, g.positions); continue; }
    const cells = g.cells.slice();
    for (let i = 0; i < cells.length; i++) {
      const list = cells[i] === id ? null : anchors.get(cells[i]);
      if (list) for (const t of list) {
        const ox = i % g.w - t.ink[t.anchor], oy = (i / g.w | 0) - t.ink[t.anchor + 1];
        if (ox < 0 || oy < 0 || ox + t.w > g.w || oy + t.h > g.h) continue;
        let k = 0;
        while (k < t.ink.length && cells[(oy + t.ink[k + 1]) * g.w + ox + t.ink[k]] === t.ink[k + 2]) k += 3;
        if (k < t.ink.length) continue;
        for (k = 0; k < t.ink.length; k += 3) cells[(oy + t.ink[k + 1]) * g.w + ox + t.ink[k]] = id;
        add(groups, t.cells, t.w, t.h, moved(g.positions, ox, oy));
        break;
      }
    }
    let x0 = g.w, x1 = -1, y0 = g.h, y1 = -1;
    for (let i = 0; i < cells.length; i++) if (cells[i] !== id) { const x = i % g.w, y = i / g.w | 0; x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
    if (x1 < 0) continue;
    const w = x1 - x0 + 1, h = y1 - y0 + 1, rest = new Uint32Array(w * h);
    for (let y = 0; y < h; y++) rest.set(cells.subarray((y0 + y) * g.w + x0, (y0 + y) * g.w + x0 + w), y * w);
    add(groups, rest, w, h, moved(g.positions, x0, y0));
  }
  const body = new Uint32Array(keys);
  for (const m of marks) for (let k = m.start; k < m.end; k += 3) body.fill(bg0, runs[k] * width + runs[k + 1], runs[k] * width + runs[k + 2] + 1);
  contain(groups, id);
  let placements = 0, area = 0, side = 0;
  for (const g of groups) {
    placements += g.positions.length >> 1;
    if (!g.in) { area += g.w * g.h; side = Math.max(side, g.w); }
    const order = Array.from({length: g.positions.length >> 1}, (_, i) => i).sort((a, b) => g.positions[2 * a + 1] - g.positions[2 * b + 1] || g.positions[2 * a] - g.positions[2 * b]);
    g.positions = order.flatMap(i => [g.positions[2 * i], g.positions[2 * i + 1]]);
  }
  const {atlas, atlasKeys, atlasWidth, atlasHeight} = packAtlas(groups.filter(g => !g.in), side, area, 0xffffffff);
  const place = g => { if (g.in && g.ax === undefined) { place(g.in); g.ax = g.in.ax + g.ox; g.ay = g.in.ay + g.oy; } };
  for (const g of groups) place(g);
  for (const g of groups) if (!g.in) for (let r = 0; r < g.h; r++) atlasKeys.set(g.cells.subarray(r * g.w, (r + 1) * g.w), (g.ay + r) * atlasWidth + g.ax);
  for (const g of groups) { g.cells = null; g.in = null; }
  return {groups, atlas, width: atlasWidth, height: atlasHeight, placements, cover: inked / n, body: new Uint8Array(body.buffer), peel: true};
}
