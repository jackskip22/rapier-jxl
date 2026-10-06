// SPDX-License-Identifier: MIT
// Exact component dictionary for screen glyphs. Geometry finds candidates;
// full RGBA comparison proves equality. The atlas is a JPEG XL reference-only
// frame, not an application-private sidecar or a lossy replacement.
import {BitWriter, packSigned, complete} from './bits.mjs';
import {admitOutputSize} from './admit.mjs';
import {writeImageHeader, writeFrameHeaderEnd} from './frame.mjs';
import {buildCode, uintConfig, countToken, writeHybrid, writeHistograms} from './prefix.mjs';
import {screenPlan, screenFrameSteps} from './screen.mjs';

const patchColour = (rgba, p) =>
  rgba[p * 4] + rgba[p * 4 + 1] * 256 + rgba[p * 4 + 2] * 65536 + rgba[p * 4 + 3] * 16777216;

export function glyphDictionary(rgba, width, height) {
  const size = width * height;
  if (size > 4_000_000 || width < 32 || height < 32) return null;
  const sampled = new Map();
  for (let i = 0; i < 256; i++) {
    const c = patchColour(rgba, Math.floor(((i * 2 + 1) * size) / 512));
    sampled.set(c, (sampled.get(c) || 0) + 1);
  }
  let background = 0,
    votes = 0;
  for (const [c, n] of sampled)
    if (n > votes) {
      votes = n;
      background = c;
    }
  if (votes < 128) return null;
  const seen = new Uint8Array(size),
    queue = new Int32Array(size),
    buckets = new Map();
  const equal = (a, b) => {
    for (let y = 0; y < a.h; y++)
      for (let x = 0; x < a.w; x++)
        if (patchColour(rgba, (a.y + y) * width + a.x + x) !== patchColour(rgba, (b.y + y) * width + b.x + x))
          return false;
    return true;
  };
  let components = 0;
  for (let p = 0; p < size; p++) {
    if (seen[p] || patchColour(rgba, p) === background) continue;
    let read = 0,
      write = 1,
      minX = p % width,
      maxX = minX,
      minY = (p / width) | 0,
      maxY = minY;
    seen[p] = 1;
    queue[0] = p;
    while (read < write) {
      const at = queue[read++],
        x = at % width,
        y = (at / width) | 0;
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          if ((!dx && !dy) || x + dx < 0 || x + dx >= width || y + dy < 0 || y + dy >= height) continue;
          const q = at + dy * width + dx;
          if (!seen[q] && patchColour(rgba, q) !== background) {
            seen[q] = 1;
            queue[write++] = q;
          }
        }
    }
    const w = maxX - minX + 1,
      h = maxY - minY + 1;
    if (w > 64 || h > 64 || write < 3 || w * h < 6) continue;
    // A hard bound on dictionary bookkeeping, not on lossless correctness.
    if (++components > 32768) return null;
    const box = {x: minX, y: minY, w, h};
    let hash = 0x811c9dc5;
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++)
        hash = Math.imul(hash ^ patchColour(rgba, (minY + y) * width + minX + x), 16777619) >>> 0;
    const key = w + ',' + h + ',' + hash,
      list = buckets.get(key) || [];
    let group = list.find(g => equal(g, box));
    if (group) group.positions.push({x: minX, y: minY});
    else {
      if (list.length >= 4) return null;
      group = {...box, positions: [{x: minX, y: minY}]};
      list.push(group);
      buckets.set(key, list);
    }
  }
  const groups = [];
  for (const list of buckets.values())
    for (const g of list) if (g.positions.length >= 3 && g.w * g.h * (g.positions.length - 1) >= 64) groups.push(g);
  if (!groups.length || groups.length > 2048) return null;
  // Raster discovery order is retained for deterministic atlas and dictionary.
  const aw = 256;
  let ax = 0,
    ay = 0,
    rowHeight = 0;
  for (const g of groups) {
    if (ax + g.w > aw) {
      ay += rowHeight;
      ax = 0;
      rowHeight = 0;
    }
    g.ax = ax;
    g.ay = ay;
    ax += g.w;
    rowHeight = Math.max(rowHeight, g.h);
  }
  const ah = ay + rowHeight;
  if (ah > 16384) return null;
  const atlas = new Uint8Array(aw * ah * 4),
    body = Uint8Array.from(rgba);
  const bg = Uint8Array.of(
    background & 255,
    (background >>> 8) & 255,
    (background >>> 16) & 255,
    (background >>> 24) & 255
  );
  for (let p = 0; p < atlas.length; p += 4) atlas.set(bg, p);
  let placements = 0,
    covered = 0;
  for (const g of groups) {
    for (let y = 0; y < g.h; y++)
      atlas.set(
        rgba.subarray(((g.y + y) * width + g.x) * 4, ((g.y + y) * width + g.x + g.w) * 4),
        ((g.ay + y) * aw + g.ax) * 4
      );
    for (const pos of g.positions) {
      placements++;
      covered += g.w * g.h;
      for (let y = 0; y < g.h; y++) for (let x = 0; x < g.w; x++) body.set(bg, ((pos.y + y) * width + pos.x + x) * 4);
    }
  }
  return {groups, atlas, body, width: aw, height: ah, placements, covered};
}

export function writePatchFrameHeader(w, alpha, {reference = false, width = 0, height = 0, shift = 1} = {}) {
  w.write(1, 0);
  w.write(2, reference ? 2 : 0);
  w.write(1, 1);
  // U64 flags: 0 for the atlas, 2 (patches) for the visible frame.
  if (reference) w.write(2, 0);
  else {
    w.write(2, 1);
    w.write(4, 1);
  }
  w.write(3, 0);
  if (alpha) w.write(2, 0);
  w.write(2, shift);
  if (!reference) {
    writeFrameHeaderEnd(w, alpha);
    return;
  }
  // Reference-only frames omit passes, origin, blending, and is_last.
  w.write(1, 1);
  const sizes = [
    [8, 0],
    [11, 256],
    [14, 2304],
    [30, 18688]
  ];
  w.writeU32(sizes, width);
  w.writeU32(sizes, height);
  w.write(2, 1);
  w.write(1, 1); // slot 1; save before colour conversion
  w.write(10, 0); // no name, no filters or extensions
}

export function writePatchDictionary(w, dictionary, alpha) {
  const values = [],
    emit = (ctx, value) => values.push([ctx, value]);
  emit(0, dictionary.groups.length);
  for (const g of dictionary.groups) {
    emit(1, 1);
    emit(3, g.ax);
    emit(3, g.ay);
    emit(2, g.w - 1);
    emit(2, g.h - 1);
    emit(7, g.positions.length - 1);
    let x = 0,
      y = 0;
    for (let i = 0; i < g.positions.length; i++) {
      const p = g.positions[i];
      emit(i ? 6 : 4, i ? packSigned(p.x - x) : p.x);
      emit(i ? 6 : 4, i ? packSigned(p.y - y) : p.y);
      x = p.x;
      y = p.y;
      emit(5, 1);
      if (alpha) emit(5, 1); // replace, including hidden RGB and alpha
    }
  }
  const config = uintConfig(4),
    freqs = Array.from({length: 10}, () => new Uint32Array(64));
  for (const [ctx, v] of values) countToken(config, v, freqs[ctx]);
  const histograms = freqs.map(f => ({config, code: buildCode(f)})),
    contextMap = Uint8Array.from({length: 10}, (_, i) => i);
  writeHistograms(w, {contextMap, histograms});
  for (const [ctx, v] of values) writeHybrid(w, histograms[ctx].code, config, v);
}

function* patchFraction(steps, start, span) {
  let step, hurry;
  while (!(step = steps.next(hurry)).done) hurry = yield start + span * step.value;
  return step.value;
}

export function* patchSteps(rgba, width, height, shape, colorSpace, {tokenCodec = null, stats = null, search = null, limit = Infinity} = {}) {
  const dict = glyphDictionary(rgba, width, height);
  if (yield 0.05) return null;
  if (!dict) return null;
  if (search) return yield* patchSearchSteps(dict, width, height, shape, colorSpace, search, limit, stats);
  const atlasPlan = screenPlan(dict.atlas, dict.width, dict.height, shape, 'global');
  const bodyPlan = screenPlan(dict.body, width, height, shape, 'global');
  if (!atlasPlan || !bodyPlan) return null;
  const atlas = yield* patchFraction(
    screenFrameSteps(dict.atlas, dict.width, dict.height, shape, colorSpace, atlasPlan, {
      imageHeader: false,
      tokenCodec,
      frameHeader: w => writePatchFrameHeader(w, shape.alpha, {reference: true, width: dict.width, height: dict.height})
    }),
    0.05,
    0.3
  );
  if (!atlas) return null;
  const body = yield* patchFraction(
    screenFrameSteps(dict.body, width, height, shape, colorSpace, bodyPlan, {
      imageHeader: false,
      tokenCodec,
      frameHeader: w => writePatchFrameHeader(w, shape.alpha),
      globalPrefix: w => writePatchDictionary(w, dict, shape.alpha)
    }),
    0.35,
    0.65
  );
  if (!body) return null;
  const header = new BitWriter(256);
  writeImageHeader(header, width, height, shape.colour, shape.alpha, {colorSpace});
  const head = header.finish(),
    length = head.length + atlas.length + body.length;
  admitOutputSize(length);
  const bytes = new Uint8Array(length);
  bytes.set(head);
  bytes.set(atlas, head.length);
  bytes.set(body, head.length + atlas.length);
  if (stats) {
    const d = new BitWriter(256);
    writePatchDictionary(d, dict, shape.alpha);
    Object.assign(stats, {
      atlasBytes: atlas.length,
      bodyBytes: body.length,
      dictionaryBits: d.bitLength,
      glyphs: dict.groups.length,
      placements: dict.placements,
      covered: dict.covered
    });
  }
  return bytes;
}

function* patchSearchSteps(dict, width, height, shape, colorSpace, search, limit, stats) {
  const header = new BitWriter(256), dictionary = new BitWriter(256);
  writeImageHeader(header, width, height, shape.colour, shape.alpha, {colorSpace});
  writePatchDictionary(dictionary, dict, shape.alpha);
  const head = header.finish(), dictionaryBytes = Math.floor(dictionary.bitLength / 8), frames = [];
  // The dictionary and completed atlas are unavoidable bytes of this candidate.
  if (head.length + dictionaryBytes >= limit) return null;
  for (let stage = 0; stage < 2; stage++) {
    const pixels = stage ? dict.body : dict.atlas, w = stage ? width : dict.width, h = stage ? height : dict.height;
    let best = null;
    for (const [i, mode] of ['global', 'frequency', 'scalar', 'direct'].entries()) {
      const plan = screenPlan(pixels, w, h, shape, mode);
      if (!plan) continue;
      const bytes = yield* patchFraction(screenFrameSteps(pixels, w, h, shape, colorSpace, plan, {
        imageHeader: false, search,
        frameHeader: out => writePatchFrameHeader(out, shape.alpha, {reference: !stage, width: w, height: h,
          shift: search.dim === 512 ? 2 : search.dim === 256 ? 1 : 3}),
        globalPrefix: stage ? out => writePatchDictionary(out, dict, shape.alpha) : null
      }), 0.05 + 0.95 * (stage * 4 + i) / 8, 0.95 / 8);
      if (!bytes) return null;
      if (!best || bytes.length < best.length) best = bytes;
    }
    if (!best) return null;
    frames.push(best);
    if (!stage && head.length + best.length + dictionaryBytes >= limit) return null;
  }
  const length = head.length + frames[0].length + frames[1].length;
  admitOutputSize(length);
  const bytes = new Uint8Array(length);
  bytes.set(head); bytes.set(frames[0], head.length); bytes.set(frames[1], head.length + frames[0].length);
  if (stats) Object.assign(stats, {atlasBytes: frames[0].length, bodyBytes: frames[1].length,
    dictionaryBits: dictionary.bitLength, glyphs: dict.groups.length, placements: dict.placements, covered: dict.covered});
  return bytes;
}
export function encodePatches(rgba, width, height, shape, colorSpace, options) {
  return complete(patchSteps(rgba, width, height, shape, colorSpace, options));
}
