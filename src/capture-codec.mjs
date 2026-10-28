// SPDX-License-Identifier: MIT
import {BitWriter, complete} from './bits.mjs';
import {admitOptions, admitPixels, admitOutputSize, fault, job} from './admit.mjs';
import {SCREEN_INTEGER_CONFIGS, screenDistanceMap} from './screen-codes.mjs';
import {writeImageHeader, writeModularFrameHeader, groupLayout, groupRect, assembleCodestream} from './frame.mjs';
import {pixelKeys, screenColumns, screenCrop, screenRegions, writeScreenBackground} from './screen-crop.mjs';
import {LZ77, leaf, split, writeTree, writeModularHeader} from './modular.mjs';
import {buildCode, canonicalCodes, hybridToken, priceCode, uintConfig, writeHistograms, writeHybrid, writePrefixCode, writeUintConfig} from './prefix.mjs';

const DIM = 1024, PALETTE_LIMIT = 16384;

function scanColours(rgba, stride, x0, y0, w, h, limit) {
  limit = Math.min(limit, w * h);
  let size = 1024;
  while (size < limit * 2) size <<= 1;
  const keys = new Uint32Array(size), slots = new Uint16Array(size), shift = Math.clz32(size) + 1, mask = size - 1;
  const colours = new Uint32Array(limit), indices = new Uint16Array(w * h), words = pixelKeys(rgba);
  let n = 0, last = -1, lastIndex = 0;
  for (let i = 0, x = 0, p = y0 * stride + x0, size = w * h; i < size; i++, x++, p++) {
    if (x === w) { x = 0; p += stride - w; }
    const key = words[p];
    if (key === last) { indices[i] = lastIndex; continue; }
    if (i >= w && key === words[p - stride]) { indices[i] = lastIndex = indices[i - w]; last = key; continue; }
    let slot = Math.imul(key, 0x9e3779b1) >>> shift;
    while (slots[slot] && keys[slot] !== key) slot = (slot + 1) & mask;
    if (!slots[slot]) {
      if (n === limit) return null;
      keys[slot] = key; colours[n] = key; slots[slot] = ++n;
    }
    indices[i] = lastIndex = slots[slot] - 1; last = key;
  }
  return {colours: colours.subarray(0, n), indices};
}

function relabel(colours, models) {
  const n = colours.length, uses = new Uint32Array(n), common = [], rare = [];
  for (const model of models) for (let k = 0; k < model.count; k++) if (!model.pieceDistance[k]) uses[model.pieceValue[k] >> 1]++;
  for (let i = 0; i < n; i++) if (uses[i] >= 16) common.push(i); else if (uses[i]) rare.push(i);
  common.sort((a, b) => uses[b] - uses[a] || colours[a] - colours[b]);
  rare.sort((a, b) => colours[a] - colours[b]);
  const remap = new Int32Array(n), sorted = new Uint32Array(common.length + rare.length);
  common.concat(rare).forEach((old, i) => { remap[old] = i; sorted[i] = colours[old]; });
  for (const model of models) for (let k = 0; k < model.count; k++) if (!model.pieceDistance[k]) model.pieceValue[k] = remap[model.pieceValue[k] >> 1] * 2;
  return sorted;
}

function paletteMeta(colours, shape) {
  const n = colours.length, channels = shape.channels, rows = new Int32Array(n * channels);
  for (let c = 0; c < channels; c++) for (let i = 0; i < n; i++)
    rows[c * n + i] = (colours[i] >>> (8 * (shape.colour === 1 && c === 1 ? 3 : c))) & 255;
  return {plane: rows, width: n, height: channels, transform: {type: 'palette', beginC: 0, numC: channels, nbColors: n}};
}

const SMOOTH_CUTS = [-13, -3, -1, 0, 2, 12], SMOOTH_LEVEL = [3, 2, 1, 0, 1, 2, 3], RANGE = 32768;
const SMOOTH = new Uint8Array(2 * RANGE);
for (let v = -RANGE, k = 0; v < RANGE; v++) {
  while (k < SMOOTH_CUTS.length && v > SMOOTH_CUTS[k]) k++;
  SMOOTH[v + RANGE] = SMOOTH_LEVEL[k];
}

function intervals(property, cuts, child) {
  const build = (lo, hi) => {
    if (lo === hi) return child(lo);
    const mid = (lo + hi) >> 1;
    return split(property, cuts[mid], build(mid + 1, hi), build(lo, mid));
  };
  return build(0, cuts.length);
}

function predictSmooth(plane, w, h, values, contexts, step) {
  const bound = (step - 1) >> 1;
  for (let y = 0, i = 0; y < h; y++) for (let x = 0; x < w; x++, i++) {
    const west = x ? plane[i - 1] : y ? plane[i - w] : 0, north = y ? plane[i - w] : west,
      northWest = x && y ? plane[i - w - 1] : west;
    const low = west < north ? west : north, high = west < north ? north : west, gradient = west + north - northWest;
    const prediction = gradient < low ? low : gradient > high ? high : gradient;
    let residual = plane[i] - prediction;
    if (step > 1) {
      residual = residual >= 0 ? (residual + bound) / step | 0 : -((bound - residual) / step | 0);
      plane[i] = prediction + residual * step;
    }
    values[i] = residual >= 0 ? residual * 2 : -residual * 2 - 1;
    contexts[i] = SMOOTH[west - northWest + RANGE] * 4 + SMOOTH[northWest - north + RANGE];
  }
}

function smoothTree(leaves, step) {
  return intervals(10, SMOOTH_CUTS, a => intervals(11, SMOOTH_CUTS, b => {
    const node = leaf(5, 0, step);
    node.local = SMOOTH_LEVEL[a] * 4 + SMOOTH_LEVEL[b]; leaves.push(node);
    return node;
  }));
}

const copyHash = (values, i) => (Math.imul(values[i] + 1, 0x1e35a7bd) ^ Math.imul(values[i + 1] + 1, 0x6c8e9cf5) ^ Math.imul(values[i + 2] + 1, 0x2c1b3c6d)) >>> 16;

function matchLength(values, previous, from, n) {
  let k = 3;
  while (from + k < n && values[previous + k] === values[from + k]) k++;
  return k;
}

function copyProbe(s, previous) {
  const values = s.values, at = s.at, length = s.length;
  if (previous < 0 || values[previous] !== values[at] || values[previous + 1] !== values[at + 1] || values[previous + 2] !== values[at + 2]) return;
  if (length && values[previous + length - 1] !== values[at + length - 1]) return;
  const k = matchLength(values, previous, at, s.n), d = at - previous, cost = d === 1 || d === s.width ? 2 : 31 - Math.clz32(d);
  if (6 * k - cost > 6 * length - s.lengthCost) { s.length = k; s.distance = d; s.lengthCost = cost; }
}

const RECENT = 16;
function remember(recent, d) {
  let i = 0;
  while (i < RECENT - 1 && recent[i] !== d) i++;
  for (; i > 0; i--) recent[i] = recent[i - 1];
  recent[0] = d;
}

function copyFind(s, position) {
  const {values, n, width, depth, heads, chain} = s;
  const at = s.at = position;
  s.length = 0; s.distance = 0; s.lengthCost = 0;
  if (at + s.minimum > n) return 0;
  if (depth) for (let i = s.inserted; i < at; i++) { const h = copyHash(values, i); chain[i] = heads[h]; heads[h] = i; }
  if (depth && s.inserted < at) s.inserted = at;
  if (at) copyProbe(s, at - 1);
  if (at >= width && at + s.length < n) copyProbe(s, at - width);
  if (depth) {
    const v = values[at], recent = s.recent;
    for (let i = 0; i < RECENT && s.length < 256; i++) {
      const r = recent[i];
      if (r > 1 && r !== width && r <= at && values[at - r] === v) copyProbe(s, at - r);
    }
  }
  if (depth) for (let p = heads[copyHash(values, at)], d = 0; p >= 0 && d < depth && at + s.length < n && s.length < 256; p = chain[p], d++) copyProbe(s, p);
  return s.length >= s.minimum ? s.length : 0;
}

function captureCopies(values, width, depth, minimum, emit) {
  const n = values.length, s = {values, n, width, depth, minimum, heads: depth ? new Int32Array(65536).fill(-1) : null,
    chain: depth ? new Int32Array(n) : null, inserted: 0, at: 0, length: 0, distance: 0, lengthCost: 0, recent: new Int32Array(RECENT)};
  let position = 0, copy = copyFind(s, 0), from = s.distance, fromCost = s.lengthCost;
  while (position < n) {
    if (copy) {
      const next = depth ? copyFind(s, position + 1) : 0;
      if (next && 6 * next - s.lengthCost > 6 * copy - fromCost + 3) { emit(position++, 0, 0); copy = next; from = s.distance; fromCost = s.lengthCost; continue; }
      emit(position, copy, from);
      if (depth) remember(s.recent, from);
      if (copy > 64) { copyFind(s, position + 8); s.inserted = position + copy - 3; }
      position += copy;
    } else { emit(position, 0, 0); position++; }
    copy = copyFind(s, position); from = s.distance; fromCost = s.lengthCost;
  }
}

function channelModel(plane, w, h, kind, step = 1, minimum = kind === 'index' ? 3 : 4) {
  const n = w * h, values = new Int32Array(n), contexts = new Uint8Array(n), leaves = [];
  let tree, classes = 1;
  if (kind === 'index') {
    for (let i = 0; i < n; i++) values[i] = plane[i] * 2;
    tree = leaf(0);
  } else if (kind === 'palette') {
    for (let i = 0; i < n; i++) {
      const residual = plane[i] - (i % w ? plane[i - 1] : i ? plane[i - w] : 0);
      values[i] = residual >= 0 ? residual * 2 : -residual * 2 - 1;
      contexts[i] = i / w | 0;
    }
    tree = intervals(2, Array.from({length: h - 1}, (_, k) => k), row => { const node = leaf(1); node.local = row; leaves.push(node); return node; });
    classes = h;
  } else { predictSmooth(plane, w, h, values, contexts, step); tree = smoothTree(leaves, step); classes = 16; }
  if (classes === 1) { tree.local = 0; leaves.push(tree); }
  let pieceValue = new Int32Array(Math.min(n, 4096)), pieceDistance = new Int32Array(pieceValue.length),
    pieceContext = new Uint8Array(pieceValue.length), count = 0;
  captureCopies(values, w, kind === 'index' ? 32 : 0, minimum, (at, length, distance) => {
    if (count === pieceValue.length) {
      const size = Math.min(n, count * 2), grow = (from, to) => (to.set(from), to);
      pieceValue = grow(pieceValue, new Int32Array(size)); pieceDistance = grow(pieceDistance, new Int32Array(size));
      pieceContext = grow(pieceContext, new Uint8Array(size));
    }
    pieceContext[count] = contexts[at];
    if (length) { pieceValue[count] = length - minimum; pieceDistance[count++] = distance; }
    else { pieceValue[count] = values[at]; pieceDistance[count++] = 0; }
  });
  return {tree, leaves, classes, width: w, minimum, count, pieceValue, pieceDistance, pieceContext};
}

const LITERAL_CONFIGS = [...SCREEN_INTEGER_CONFIGS, ...[5, 6, 7, 8, 9, 10, 11, 12, 13].map(n => uintConfig(n))];
const SMALL = 64;
const LOG_MANTISSA = Uint8Array.of(0, 1, 3, 4, 5, 7, 8, 9, 10, 11, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 22, 23, 24, 25, 26, 27, 27, 28, 29, 30, 31, 31);
const log2x32 = x => {
  const e = 31 - Math.clz32(x);
  return 32 * e + LOG_MANTISSA[(e >= 5 ? x >>> e - 5 : x << 5 - e) & 31];
};
const entropy = (freqs, total) => {
  let bits = 0;
  const whole = log2x32(total);
  for (const n of freqs) if (n) bits += n * (whole - log2x32(n));
  return bits / 32;
};
function tokenPrice(config, small, large, out) {
  const freqs = out.freqs, token = [0, 0, 0];
  freqs.fill(0, 0, out.top === undefined ? freqs.length : out.top + 1);
  let raw = 0, top = 0, total = 0, used = 0;
  const add = (value, n) => {
    hybridToken(config, value, token);
    if (!freqs[token[0]]) used++;
    freqs[token[0]] += n; raw += token[1] * n; total += n;
    if (token[0] > top) top = token[0];
  };
  for (let v = 0; v < SMALL; v++) if (small[v]) add(v, small[v]);
  for (const [v, n] of large) add(v, n);
  out.top = top; out.total = total;
  out.bits = total ? entropy(freqs.subarray(0, top + 1), total) + raw + 5 * used : 0;
  return out;
}

const WIDE_DISTANCES = [uintConfig(8, 4, 4), uintConfig(10, 4, 3), uintConfig(10, 5, 4), uintConfig(10, 5, 5), uintConfig(12, 5, 5)];
const DISTANCE_CONFIGS = [...SCREEN_INTEGER_CONFIGS, ...WIDE_DISTANCES];
const DISTANCE_TOKENS = 1 << 15;
function distanceTokens(config, values, out) {
  const token = [0, 0, 0], freqs = out.freqs;
  let raw = 0, top = 0, total = 0;
  freqs.fill(0, 0, out.top === undefined ? freqs.length : out.top + 1);
  for (const [v, n] of values) {
    hybridToken(config, v, token);
    if (token[0] >= DISTANCE_TOKENS) { out.top = top; return null; }
    freqs[token[0]] += n; raw += token[1] * n; total += n;
    if (token[0] > top) top = token[0];
  }
  out.top = top;
  return {raw, total, top};
}
function distanceEstimate(config, values, out) {
  const counted = distanceTokens(config, values, out);
  if (!counted) return Infinity;
  const freqs = out.freqs, whole = log2x32(counted.total);
  let bits = 0, header = 0, gap = 0;
  for (let i = 0; i <= counted.top; i++) {
    const n = freqs[i];
    if (!n) { gap++; continue; }
    bits += n * (whole - log2x32(n));
    header += 4 + (gap ? gap < 3 ? 3 * gap : 6 : 0); gap = 0;
  }
  return bits / 32 + counted.raw + header;
}
function distancePrice(config, values, out) {
  const {raw, top} = distanceTokens(config, values, out), freqs = out.freqs;
  const code = priceCode(freqs.subarray(0, top + 1)), header = new BitWriter(256);
  writeUintConfig(header, config, 15); writePrefixCode(header, code);
  let bits = raw + header.bitLength;
  for (let i = 0; i <= top; i++) bits += freqs[i] * code.lengths[i];
  return {bits, code};
}

function writeChannels(writer, models) {
  const build = (lo, hi) => {
    if (lo === hi) return models[lo].tree;
    const mid = (lo + hi) >> 1;
    return split(0, mid, build(mid + 1, hi), build(lo, mid));
  };
  const ordered = writeTree(writer, build(0, models.length - 1));
  const histograms = [], distances = new Map();
  for (const model of models) {
    model.base = histograms.length;
    for (let c = 0; c < model.classes; c++) histograms.push({small: new Uint32Array(SMALL), large: new Map(), lengths: new Map(), literals: 0, copies: 0});
    for (let k = 0; k < model.count; k++) {
      const target = histograms[model.base + model.pieceContext[k]], value = model.pieceValue[k], d = model.pieceDistance[k];
      if (d) { target.lengths.set(value, (target.lengths.get(value) || 0) + 1); target.copies++; distances.set(d, (distances.get(d) || 0) + 1); }
      else { if (value < SMALL) target.small[value]++; else target.large.set(value, (target.large.get(value) || 0) + 1); target.literals++; }
    }
  }
  const live = histograms.filter(h => h.literals + h.copies), index = new Int32Array(histograms.length);
  for (let i = 0, next = 0; i < histograms.length; i++) index[i] = histograms[i].literals + histograms[i].copies ? next++ : 0;
  const scratch = {freqs: new Uint32Array(DISTANCE_TOKENS)}, none = new Uint32Array(SMALL);
  for (const h of live) {
    h.options = h.literals ? LITERAL_CONFIGS.map(config => {
      const {bits, top} = tokenPrice(config, h.small, h.large, scratch);
      return {config, bits, top};
    }) : [{config: LITERAL_CONFIGS[0], bits: 0, top: 0}];
  }
  let length = {config: LZ77.lengthConfig, bits: 0};
  if (distances.size) {
    length = null;
    for (const config of SCREEN_INTEGER_CONFIGS) {
      let bits = 0;
      for (const h of live) if (h.copies) bits += tokenPrice(config, none, h.lengths, scratch).bits;
      if (!length || bits < length.bits) length = {config, bits};
    }
  }
  let choice;
  for (const minSymbol of distances.size ? [224, 512, 4096, 16384] : [224]) {
    let bits = 0;
    const configs = live.map(h => {
      let best;
      for (const option of h.options) if ((!distances.size || option.top < minSymbol) && (!best || option.bits < best.bits)) best = option;
      if (best) bits += best.bits;
      return best;
    });
    if (configs.every(Boolean) && (!choice || bits + minSymbol / 64 < choice.bits)) choice = {minSymbol, configs, bits: bits + minSymbol / 64};
  }
  const token = [0, 0, 0], codes = live.map((h, m) => {
    const config = choice.configs[m].config, freqs = new Uint32Array(Math.max(choice.configs[m].top + 1, choice.minSymbol + 1024));
    for (let v = 0; v < SMALL; v++) if (h.small[v]) { hybridToken(config, v, token); freqs[token[0]] += h.small[v]; }
    for (const [v, n] of h.large) { hybridToken(config, v, token); freqs[token[0]] += n; }
    for (const [v, n] of h.lengths) { hybridToken(length.config, v, token); freqs[choice.minSymbol + token[0]] += n; }
    return buildCode(freqs);
  });
  let distance;
  const map = distances.size ? screenDistanceMap(Math.max(...models.map(model => model.width))) : null;
  if (map) {
    const spatial = new Map(), generic = new Map();
    for (const [d, n] of distances) {
      const s = map.get(d) ?? d + 119, g = d === 1 ? 1 : d + 119;
      spatial.set(s, (spatial.get(s) || 0) + n); generic.set(g, (generic.get(g) || 0) + n);
    }
    const ranked = [];
    for (const [kind, values] of [[true, spatial], [false, generic]]) for (const config of DISTANCE_CONFIGS)
      ranked.push({config, kind, values, estimate: distanceEstimate(config, values, scratch)});
    ranked.sort((a, b) => a.estimate - b.estimate);
    for (const {config, kind, values} of ranked.slice(0, 2)) {
      const priced = distancePrice(config, values, scratch);
      if (!distance || priced.bits < distance.bits) distance = {...priced, config, spatial: kind};
    }
    distance.code.codes = canonicalCodes(distance.code.lengths);
  }
  const offset = distance ? 1 : 0, contextMap = new Uint8Array(ordered.length + offset);
  for (const model of models) for (const node of model.leaves) contextMap[node.context] = index[model.base + node.local] + offset;
  writeHistograms(writer, {
    lz77: distance ? {minSymbol: choice.minSymbol, minLength: models[0].minimum, lengthConfig: length.config} : null,
    contextMap,
    histograms: [...(distance ? [{config: distance.config, code: distance.code}] : []),
      ...codes.map((code, m) => ({config: choice.configs[m].config, code}))]
  });
  return () => {
    for (const model of models) for (let k = 0; k < model.count; k++) {
      const h = index[model.base + model.pieceContext[k]], value = model.pieceValue[k], d = model.pieceDistance[k];
      if (d) {
        writeHybrid(writer, codes[h], length.config, value, choice.minSymbol);
        writeHybrid(writer, distance.code, distance.config, distance.spatial ? (map.get(d) ?? d + 119) : d === 1 ? 1 : d + 119);
      } else writeHybrid(writer, codes[h], choice.configs[h].config, value);
    }
  };
}

function groupChannels(rgba, stride, x, y, w, h, shape, maxError) {
  const scan = scanColours(rgba, stride, x, y, w, h, Math.min(PALETTE_LIMIT, (w * h) >> 3));
  if (scan) {
    const index = channelModel(scan.indices, w, h, 'index'), meta = paletteMeta(relabel(scan.colours, [index]), shape);
    return {transforms: [meta.transform], models: [channelModel(meta.plane, meta.width, meta.height, 'palette', 1, 3), index]};
  }
  const sample = c => {
    const plane = new Int32Array(w * h);
    for (let row = 0, at = 0; row < h; row++) for (let p = ((y + row) * stride + x) * 4 + c, end = p + w * 4; p < end; p += 4) plane[at++] = rgba[p];
    return plane;
  };
  const step = 2 * maxError + 1, models = [];
  let transforms = [];
  if (shape.colour === 1) models.push(channelModel(sample(0), w, h, 'smooth', step));
  else {
    const green = sample(1);
    models.push(channelModel(green, w, h, 'smooth', step));
    for (const c of [2, 0]) {
      const plane = sample(c);
      for (let i = 0; i < plane.length; i++) plane[i] -= green[i];
      models.push(channelModel(plane, w, h, 'smooth', step));
    }
    transforms = [{type: 'rct', beginC: 0, rctType: 10}];
  }
  if (shape.alpha) models.push(channelModel(sample(3), w, h, 'smooth'));
  return {transforms, models};
}

function shapeOf(keys, margin = keys[0]) {
  let grey = !((margin ^ margin >>> 8) & 0xffff), opaque = margin >>> 24 === 255;
  for (let i = 0; i < keys.length && (grey || opaque); i++) {
    const key = keys[i];
    if (key >>> 24 !== 255) opaque = false;
    if ((key ^ key >>> 8) & 0xffff) grey = false;
  }
  const colour = grey ? 1 : 3;
  return {colour, alpha: !opaque, channels: colour + (opaque ? 0 : 1)};
}

function* captureFrameSteps(pixels, width, height, shape, maxError, frame, header, placement) {
  const layout = groupLayout(width, height, DIM), groups = layout.groupsX * layout.groupsY, sections = [];
  writeModularFrameHeader(header, {alpha: shape.alpha, shift: 3, ...placement});
  let total = 0;
  const append = bytes => { total += bytes.length; admitOutputSize(total); sections.push(bytes); };
  const indexModels = frame ? Array.from({length: groups}, (_, g) => {
    const [x, y, w, h] = groupRect(layout, width, height, g, DIM), indices = new Uint16Array(w * h);
    const {stride = width, x: fx = 0, y: fy = 0} = frame;
    for (let row = 0, p = (fy + y) * stride + fx + x; row < h; row++, p += stride) indices.set(frame.indices.subarray(p, p + w), row * w);
    return channelModel(indices, w, h, 'index');
  }) : null;
  const meta = frame ? paletteMeta(relabel(frame.colours, indexModels), shape) : null;
  const global = new BitWriter(1024);
  global.write(1, 1); global.write(1, 1);
  if (layout.single) {
    const {transforms, models} = frame
      ? {transforms: [meta.transform], models: [channelModel(meta.plane, meta.width, meta.height, 'palette', 1, 3), indexModels[0]]}
      : groupChannels(pixels, width, 0, 0, width, height, shape, maxError);
    const write = writeChannels(global, models);
    writeModularHeader(global, {transforms});
    write();
    return assembleCodestream(header, [global.finish()]);
  }
  if (frame) {
    const write = writeChannels(global, [channelModel(meta.plane, meta.width, meta.height, 'palette')]);
    writeModularHeader(global, {transforms: [meta.transform]});
    write();
  } else {
    writeHistograms(global, {contextMap: new Uint8Array(writeTree(global, leaf(0)).length),
      histograms: [{config: LITERAL_CONFIGS[0], code: buildCode(new Uint32Array(1))}]});
    writeModularHeader(global);
  }
  append(global.finish());
  for (let i = 0; i < layout.dcGroupsX * layout.dcGroupsY + 1; i++) sections.push(new Uint8Array(0));
  for (let g = 0; g < groups; g++) {
    const [x, y, w, h] = groupRect(layout, width, height, g, DIM), section = new BitWriter(w * h + 256);
    const channels = frame ? {transforms: [], models: [indexModels[g]]} : groupChannels(pixels, width, x, y, w, h, shape, maxError);
    writeModularHeader(section, {useGlobalTree: false, transforms: channels.transforms});
    writeChannels(section, channels.models)();
    append(section.finish());
    yield (g + 1) / groups;
  }
  return assembleCodestream(header, sections);
}

function* scaledSteps(steps, start, span) {
  let step;
  while (!(step = steps.next()).done) yield start + span * step.value;
  return step.value;
}

function* captureSteps(source, imageWidth, imageHeight, colorSpace, maxError) {
  const crop = screenCrop(source, imageWidth, imageHeight);
  const pixels = crop ? crop.data : source, width = crop ? crop.width : imageWidth, height = crop ? crop.height : imageHeight;
  const frame = scanColours(pixels, width, 0, 0, width, height, PALETTE_LIMIT);
  let partition = frame && screenColumns(source, imageWidth, imageHeight) || screenRegions(source, imageWidth, imageHeight);
  if (partition) {
    const x0 = crop?.x ?? 0, y0 = crop?.y ?? 0, x1 = x0 + width, y1 = y0 + height;
    const regions = partition.regions.map(r => {
      const x = Math.max(r.x, x0), y = Math.max(r.y, y0);
      return {x, y, width: Math.min(r.x + r.width, x1) - x, height: Math.min(r.y + r.height, y1) - y};
    }).filter(r => r.width > 0 && r.height > 0 && r.width < imageWidth && r.width * r.height >= 20000);
    partition = regions.length ? {...partition, regions} : null;
  }
  const header = new BitWriter(128);
  if (!partition) {
    const shape = shapeOf(frame ? frame.colours : pixelKeys(pixels), crop ? pixelKeys(crop.background)[0] : undefined);
    writeImageHeader(header, imageWidth, imageHeight, shape.colour, shape.alpha, {colorSpace});
    if (crop) writeScreenBackground(header, imageWidth, imageHeight, shape, crop.background);
    return yield* captureFrameSteps(pixels, width, height, shape, maxError, frame, header, crop ? {crop: {x: crop.x, y: crop.y, width, height}} : {});
  }
  const {regions, background} = partition, frames = [];
  const shape = shapeOf(frame ? frame.colours : pixelKeys(source), crop ? pixelKeys(crop.background)[0] : undefined);
  let body = source, base;
  const blank = fill => { for (const r of regions) for (let y = r.y; y < r.y + r.height; y++) fill(y * imageWidth + r.x, y * imageWidth + r.x + r.width); };
  const backgroundIndex = frame ? frame.colours.indexOf(background) : -1,
    marginIndex = crop ? frame ? frame.colours.indexOf(pixelKeys(crop.background)[0]) : -1 : backgroundIndex;
  if (backgroundIndex >= 0 && marginIndex >= 0) {
    const indices = new Uint16Array(imageWidth * imageHeight).fill(marginIndex), cx = crop?.x ?? 0, cy = crop?.y ?? 0;
    for (let y = 0; y < height; y++) indices.set(frame.indices.subarray(y * width, (y + 1) * width), (y + cy) * imageWidth + cx);
    blank((from, to) => indices.fill(backgroundIndex, from, to));
    base = {colours: frame.colours, indices};
  } else {
    body = Uint8Array.from(source);
    const [r, g, b, a] = [0, 8, 16, 24].map(shift => background >>> shift & 255);
    blank((from, to) => { for (let p = 4 * from; p < 4 * to; p += 4) { body[p] = r; body[p + 1] = g; body[p + 2] = b; body[p + 3] = a; } });
    base = scanColours(body, imageWidth, 0, 0, imageWidth, imageHeight, PALETTE_LIMIT);
  }
  writeImageHeader(header, imageWidth, imageHeight, shape.colour, shape.alpha, {colorSpace});
  const count = regions.length + 1;
  frames.push(yield* scaledSteps(captureFrameSteps(body, imageWidth, imageHeight, shape, maxError, base, header, {last: false, reference: 1}), 0, 1 / count));
  for (const [i, r] of regions.entries()) {
    let part = null, local = frame && {colours: frame.colours, indices: frame.indices, stride: width, x: r.x - (crop?.x ?? 0), y: r.y - (crop?.y ?? 0)};
    if (!local) {
      part = new Uint8Array(r.width * r.height * 4);
      for (let y = 0; y < r.height; y++) part.set(source.subarray(((r.y + y) * imageWidth + r.x) * 4, ((r.y + y) * imageWidth + r.x + r.width) * 4), y * r.width * 4);
      local = scanColours(part, r.width, 0, 0, r.width, r.height, PALETTE_LIMIT);
    }
    frames.push(yield* scaledSteps(captureFrameSteps(part, r.width, r.height, shape, maxError, local,
      new BitWriter(64), {crop: r, last: i + 1 === regions.length, reference: 1}), (i + 1) / count, 1 / count));
  }
  let length = 0;
  for (const f of frames) length += f.length;
  admitOutputSize(length);
  const out = new Uint8Array(length);
  for (let i = 0, at = 0; i < frames.length; at += frames[i++].length) out.set(frames[i], at);
  return out;
}

export function encodeCapture(data, width, height, options) {
  return complete(encodeCaptureSteps(data, width, height, options));
}

const admitError = maxError => {
  if (!Number.isInteger(maxError) || maxError < 0 || maxError > 8)
    throw fault('JXL_INPUT', 'maxError is a whole number from 0 to 8. Zero preserves every sample.');
  return maxError;
};

export function encodeCaptureSteps(data, width, height, options = {}) {
  const {colorSpace} = admitOptions(options);
  admitPixels(data, width, height);
  if (!(data instanceof Uint8Array || data instanceof Uint8ClampedArray))
    throw fault('JXL_INPUT', 'Captures use straight RGBA8 samples.');
  if (options.quality !== undefined || options.bitDepth !== undefined || options.sampleFormat !== undefined ||
      options.transferFunction !== undefined || options.alphaPremultiplied !== undefined || options.icc !== undefined)
    throw fault('JXL_INPUT', 'Captures use maxError and colorSpace; use the still encoder for other sample formats.');
  return job(captureSteps(data, width, height, colorSpace, admitError(options.maxError ?? 0)));
}

export function encodeCaptureBytes(data, width, height, options = {}) {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) throw fault('JXL_INPUT', 'Capture options are an object.');
  if (options.signal?.aborted) throw fault('JXL_ABORTED', 'JPEG XL encoding was canceled.');
  const bytes = encodeCapture(data, width, height, {maxError: admitError(options.maxError ?? 0), colorSpace: options.colorSpace});
  if (options.signal?.aborted) throw fault('JXL_ABORTED', 'JPEG XL encoding was canceled.');
  return bytes;
}
