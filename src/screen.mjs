// SPDX-License-Identifier: MIT
import {BitWriter, packSigned, complete} from './bits.mjs';
import {writeImageHeader, writeModularFrameHeader, groupLayout, groupPass, assembleCodestream, GROUP_DIM} from './frame.mjs';
import {buildCode, writePrefixCode} from './prefix.mjs';
import {screenModel, writeScreenModel} from './screen-lz77.mjs';
import {admitOutputSize} from './admit.mjs';
import {ALPHABET, leaf, channelTree, writeTree, writeModularHeader, writeChannelHistograms, codeChannel} from './modular.mjs';

export function screenLike(rgba, width, height) {
  if (width < 32 || height < 32) return false;
  let flat = 0;
  for (let s = 0; s < 256; s++) {
    const x = Math.min(width - 2, Math.floor((((s % 16) * 16 + ((s * 13) & 15)) * width) / 256));
    const y = Math.min(height - 2, Math.floor((((s >> 4) * 16 + ((s * 7) & 15)) * height) / 256));
    const p = (y * width + x) * 4,
      q = p + 4,
      r = p + width * 4;
    if (
      rgba[p] === rgba[q] &&
      rgba[p + 1] === rgba[q + 1] &&
      rgba[p + 2] === rgba[q + 2] &&
      rgba[p + 3] === rgba[q + 3] &&
      rgba[p] === rgba[r] &&
      rgba[p + 1] === rgba[r + 1] &&
      rgba[p + 2] === rgba[r + 2] &&
      rgba[p + 3] === rgba[r + 3]
    )
      flat++;
    if (flat + 255 - s < 192) return false;
  }
  return flat >= 192;
}

const screenValueAt = (rgba, i, c, shape) => rgba[i + (shape.colour === 1 && c === 1 ? 3 : c)];
const screenPacked = (rgba, i) => (rgba[i] + rgba[i + 1] * 256 + rgba[i + 2] * 65536 + rgba[i + 3] * 16777216) >>> 0;
const PALETTE_CAP = 8192;
function paletteTable(limit) {
  let cap = PALETTE_CAP;
  while (cap < limit * 2) cap <<= 1;
  return cap;
}
function scanPalette(rgba, frequency, limit = 4096) {
  const cap = paletteTable(limit), mask = cap - 1, shift = Math.clz32(mask);
  const slotOf = key => (Math.imul(key ^ (key >>> 16), 0x7feb352d) >>> shift) & mask;
  const keys = new Uint32Array(cap), occupied = new Uint8Array(cap), counts = frequency ? new Uint32Array(cap) : null;
  let used = 0, grey = true, opaque = true;
  for (let i = 0; i < rgba.length; i += 4) {
    if (rgba[i + 3] !== 255) opaque = false;
    if (grey && (rgba[i] !== rgba[i + 1] || rgba[i] !== rgba[i + 2])) grey = false;
    const key = screenPacked(rgba, i);
    let slot = slotOf(key);
    while (occupied[slot] && keys[slot] !== key) slot = (slot + 1) & mask;
    if (!occupied[slot]) {
      if (used === limit) return null;
      occupied[slot] = 1; keys[slot] = key; if (counts) counts[slot] = 1; used++;
    } else if (counts) counts[slot]++;
  }
  const slots = [];
  for (let slot = 0; slot < cap; slot++) if (occupied[slot]) slots.push(slot);
  slots.sort(frequency ? (a, b) => counts[b] - counts[a] || (keys[a] < keys[b] ? -1 : keys[a] > keys[b] ? 1 : 0)
    : (a, b) => keys[a] < keys[b] ? -1 : keys[a] > keys[b] ? 1 : 0);
  const indexOf = new Uint16Array(cap);
  slots.forEach((slot, index) => { indexOf[slot] = index; });
  return {keys, occupied, indexOf, colours: slots.map(slot => keys[slot]), grey, alpha: !opaque, mask, shift};
}
export function lookupPalette(table, key) {
  let slot = (Math.imul(key ^ (key >>> 16), 0x7feb352d) >>> table.shift) & table.mask;
  while (table.occupied[slot]) {
    if (table.keys[slot] === key) return table.indexOf[slot];
    slot = (slot + 1) & table.mask;
  }
  return 0;
}

function screenFill(setup) {
  const {mode, channels, colour, index, maps} = setup;
  return (planes, rgba, stride, x0, y0, w, h) => {
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const p = ((y0 + y) * stride + x0 + x) * 4, at = y * w + x;
      if (mode === 'global' || mode === 'frequency') planes[0][at] = lookupPalette(index, screenPacked(rgba, p));
      else if (mode === 'scalar') {
        for (let c = 0; c < channels; c++) {
          const value = rgba[p + (colour === 1 && c === 1 ? 3 : c)];
          planes[c][at] = maps[c] ? maps[c][value] : value;
        }
      } else if (channels >= 3) {
        const co = rgba[p] - rgba[p + 2], tmp = rgba[p + 2] + (co >> 1), cg = rgba[p + 1] - tmp;
        planes[0][at] = tmp + (cg >> 1); planes[1][at] = co; planes[2][at] = cg;
        if (channels === 4) planes[3][at] = rgba[p + 3];
      } else {
        planes[0][at] = rgba[p];
        if (channels === 2) planes[1][at] = rgba[p + 3];
      }
    }
  };
}
function screenPlanned(rgba, width, meta, transforms, setup) {
  const fill = screenFill(setup);
  return {mode: setup.mode, count: setup.count, meta, transforms, setup,
    fill: (planes, x0, y0, w, h) => fill(planes, rgba, width, x0, y0, w, h)};
}

function indexedPlan(rgba, width, scanned, shape) {
  const colours = scanned.colours, channels = shape.channels, n = colours.length, rows = new Int16Array(n * channels);
  for (let c = 0; c < channels; c++)
    for (let i = 0; i < n; i++)
      rows[c * n + i] = (colours[i] >>> (8 * (shape.colour === 1 && c === 1 ? 3 : c))) & 255;
  const meta = [{plane: rows, width: n, height: channels}];
  const transforms = [{type: 'palette', beginC: 0, numC: channels, nbColors: n}];
  return screenPlanned(rgba, width, meta, transforms, {mode: 'frequency', count: 1, channels, colour: shape.colour, index: scanned});
}

export function screenPlan(rgba, width, height, shape, mode = 'global') {
  const channels = shape.channels,
    meta = [],
    transforms = [];
  if (mode === 'global' || mode === 'frequency') {
    const table = scanPalette(rgba, mode === 'frequency');
    if (!table) return null;
    if (mode === 'frequency' && shape.colour === (table.grey ? 1 : 3) && shape.alpha === table.alpha)
      return indexedPlan(rgba, width, table, shape);
    const colours = table.colours, n = colours.length, rows = new Int16Array(n * channels);
    for (let c = 0; c < channels; c++)
      for (let i = 0; i < n; i++)
        rows[c * n + i] = (colours[i] >>> (8 * (shape.colour === 1 && c === 1 ? 3 : c))) & 255;
    meta.push({plane: rows, width: n, height: channels});
    transforms.push({type: 'palette', beginC: 0, numC: channels, nbColors: n});
    return screenPlanned(rgba, width, meta, transforms, {mode, count: 1, channels, colour: shape.colour, index: table});
  }
  if (mode === 'scalar') {
    const maps = Array.from({length: channels}, () => new Int16Array(256).fill(-1));
    for (let i = 0; i < rgba.length; i += 4)
      for (let c = 0; c < channels; c++) maps[c][screenValueAt(rgba, i, c, shape)] = 0;
    const palettes = maps.map(map => Array.from({length: 256}, (_, i) => i).filter(v => map[v] === 0));
    for (let c = channels - 1; c >= 0; c--) {
      const values = palettes[c];
      if (values.length > 192 || values.length >= values.at(-1) - values[0] + 1) {
        maps[c] = null;
        continue;
      }
      values.forEach((v, i) => (maps[c][v] = i));
      transforms.push({type: 'palette', beginC: c + meta.length, numC: 1, nbColors: values.length});
      meta.unshift({plane: Int16Array.from(values), width: values.length, height: 1});
    }
    if (!meta.length) return null;
    return screenPlanned(rgba, width, meta, transforms, {mode, count: channels, channels, colour: shape.colour, maps});
  }
  return screenPlanned(rgba, width, meta, channels >= 3 ? [{type: 'rct', beginC: 0, rctType: 6}] : [],
    {mode: 'direct', count: channels, channels, colour: shape.colour});
}

function screenPrefixPrice(freq) {
  const code = buildCode(freq),
    w = new BitWriter(128);
  writePrefixCode(w, code);
  let bits = w.bitLength;
  for (let s = 0; s < freq.length; s++)
    if (freq[s]) bits += freq[s] * (code.lengths[s] + Math.max(0, s < 224 ? s - 1 : s - 236));
  return bits;
}

export function* screenFrameSteps(
  rgba,
  width,
  height,
  shape,
  colorSpace,
  plan,
  {predictor = null, frameHeader = null, globalPrefix = null, imageHeader = true, tokenCodec = null, search = null, minLength = 7} = {}
) {
  if (search) return yield* screenDetailedFrameSteps(rgba, width, height, shape, colorSpace, plan, {frameHeader, globalPrefix, imageHeader, minLength, ...search});
  const layout = groupLayout(width, height),
    groups = layout.groupsX * layout.groupsY;
  const count = layout.single ? plan.meta.length + plan.count : Math.max(plan.meta.length, plan.count);
  const leaves = Array.from({length: count}, () => leaf(5));
  const planes = Array.from({length: plan.count}, () => new Int16Array(GROUP_DIM * GROUP_DIM));
  const slot = c => (layout.single ? plan.meta.length + c : c);
  const visit = (g, fn) => {
    const x = (g % layout.groupsX) * GROUP_DIM,
      y = ((g / layout.groupsX) | 0) * GROUP_DIM,
      w = Math.min(GROUP_DIM, width - x),
      h = Math.min(GROUP_DIM, height - y);
    plan.fill(planes, x, y, w, h);
    fn(w, h);
  };
  if (predictor !== null) for (const l of leaves) l.predictor = predictor;
  else {
    const candidates = [0, 1, 2, 5].map(p => ({
      p,
      freqs: Array.from({length: plan.count}, () => new Uint32Array(ALPHABET))
    }));
    const w = Math.min(64, width),
      h = Math.min(32, height);
    for (const fraction of [0, 1, 2]) {
      plan.fill(planes, Math.floor(((width - w) * fraction) / 2), Math.floor(((height - h) * fraction) / 2), w, h);
      for (const c of candidates)
        for (let k = 0; k < plan.count; k++) codeChannel(null, c.freqs[k], planes[k], w, h, leaf(c.p));
    }
    for (let c = 0; c < plan.count; c++) {
      let best = candidates[0],
        cost = screenPrefixPrice(best.freqs[c]);
      for (const choice of candidates.slice(1)) {
        const p = screenPrefixPrice(choice.freqs[c]);
        if (p < cost) {
          best = choice;
          cost = p;
        }
      }
      leaves[slot(c)].predictor = best.p;
    }
  }
  const freqs = leaves.map(() => new Uint32Array(ALPHABET));
  const distances = tokenCodec ? new Uint32Array(64) : null, custom = tokenCodec?.create({distances, minLength});
  const code = (writer, target, plane, w, h, l, s) =>
    custom ? custom.code(writer, target, plane, w, h, l, s) : codeChannel(writer, target, plane, w, h, l);
  for (let c = 0; c < plan.meta.length; c++) {
    const m = plan.meta[c];
    code(null, freqs[c], m.plane, m.width, m.height, leaves[c], c);
  }
  if ((yield* groupPass({at: g => (g + 1) / (2 * groups), stop: () => true}, groups, g => {
    visit(g, (w, h) => {
      for (let c = 0; c < plan.count; c++) {
        const s = slot(c);
        code(null, freqs[s], planes[c], w, h, leaves[s], s);
      }
    });
  })) === null) return null;
  const header = new BitWriter(256);
  if (imageHeader) writeImageHeader(header, width, height, shape.colour, shape.alpha, {colorSpace});
  if (frameHeader) frameHeader(header);
  else writeModularFrameHeader(header, {alpha: shape.alpha});
  const global = new BitWriter(4096);
  if (globalPrefix) globalPrefix(global);
  global.write(1, 1);
  global.write(1, 1);
  const ordered = writeTree(global, channelTree(leaves));
  const histograms = custom
    ? custom.histograms(global, ordered, freqs, l => leaves.indexOf(l))
    : writeChannelHistograms(global, ordered, freqs, l => leaves.indexOf(l));
  writeModularHeader(global, {transforms: plan.transforms});
  for (let c = 0; c < plan.meta.length; c++) {
    const m = plan.meta[c];
    code(global, histograms[c + 1].code, m.plane, m.width, m.height, leaves[c], c);
  }
  const sections = [];
  if (!layout.single) {
    sections.push(global.finish());
    for (let i = 0; i < layout.dcGroupsX * layout.dcGroupsY + 1; i++) sections.push(new Uint8Array(0));
  }
  if ((yield* groupPass({at: g => 0.5 + (g + 1) / (2 * groups), stop: () => true}, groups, g => {
    visit(g, (w, h) => {
      const out = layout.single ? global : new BitWriter(w * h * plan.count + 64);
      if (!layout.single) writeModularHeader(out);
      for (let c = 0; c < plan.count; c++) {
        const s = slot(c);
        code(out, histograms[s + 1].code, planes[c], w, h, leaves[s], s);
      }
      sections.push(out.finish());
    });
  })) === null) return null;
  return assembleCodestream(header, sections);
}

function* screenDetailedFrameSteps(rgba, width, height, shape, colorSpace, plan,
  {dim = 1024, depth = 4, frameHeader = null, globalPrefix = null, imageHeader = true, minLength = 7, predictors = undefined, codeBudget = 15}) {
  const layout = groupLayout(width, height, dim), groups = layout.groupsX * layout.groupsY,
    header = new BitWriter(256), global = new BitWriter(4096), sections = [];
  let planes;
  if (imageHeader) writeImageHeader(header, width, height, shape.colour, shape.alpha, {colorSpace});
  if (frameHeader) frameHeader(header);
  else writeModularFrameHeader(header, {alpha: shape.alpha, shift: dim === 1024 ? 3 : dim === 512 ? 2 : 1});
  if (globalPrefix) globalPrefix(global);
  global.write(1, 1); global.write(1, 1);
  const meta = plan.meta.map(m => screenModel(m.plane, m.width, m.height, depth, minLength, predictors));
  let sectionBytes = 0;
  const append = section => { sectionBytes += section.length; admitOutputSize(sectionBytes); sections.push(section); };
  if (!layout.single) {
    const write = writeScreenModel(global, meta.length ? meta : [screenModel(new Int16Array(1), 1, 1, depth, minLength)], codeBudget);
    writeModularHeader(global, {transforms: plan.transforms});
    if (meta.length) write();
    append(global.finish());
    for (let i = 0; i < layout.dcGroupsX * layout.dcGroupsY + 1; i++) sections.push(new Uint8Array(0));
  }
  if ((yield* groupPass({at: g => (g + 1) / groups, stop: () => true}, groups, g => {
    const x = g % layout.groupsX * dim, y = ((g / layout.groupsX) | 0) * dim,
      w = Math.min(dim, width - x), h = Math.min(dim, height - y);
    planes ||= Array.from({length: plan.count}, () => new Int16Array(Math.min(width, dim) * Math.min(height, dim)));
    plan.fill(planes, x, y, w, h);
    const models = planes.map(plane => screenModel(plane, w, h, depth, minLength, predictors)),
      section = layout.single ? global : new BitWriter(w * h * plan.count + 256);
    if (!layout.single) writeModularHeader(section, {useGlobalTree: false});
    const write = writeScreenModel(section, layout.single ? [...meta, ...models] : models, codeBudget);
    if (layout.single) writeModularHeader(section, {transforms: plan.transforms});
    write(); append(section.finish());
  })) === null) return null;
  return assembleCodestream(header, sections);
}

export function encodeScreen(rgba, width, height, shape, colorSpace, options = {}) {
  const plan = screenPlan(rgba, width, height, shape, options.mode);
  return plan ? complete(screenFrameSteps(rgba, width, height, shape, colorSpace, plan, options)) : null;
}
