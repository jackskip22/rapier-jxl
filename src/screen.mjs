// SPDX-License-Identifier: MIT
// Lossless screen models for the effort entry point. A fixed sample rejects textured images without image-sized scratch buffers.
import {BitWriter, packSigned, complete} from './bits.mjs';
import {writeImageHeader, writeModularFrameHeader, groupLayout, groupPass, addCounts, assembleCodestream, GROUP_DIM} from './frame.mjs';
import {buildCode, writePrefixCode} from './prefix.mjs';
import {screenModel, writeScreenModel, screenLZ77} from './screen-lz77.mjs';
import {admitOutputSize} from './admit.mjs';
import {ALPHABET, leaf, channelTree, writeTree, writeModularHeader, writeChannelHistograms, codeChannel} from './modular.mjs';

export function screenLike(rgba, width, height) {
  if (width < 32 || height < 32) return false;
  let flat = 0;
  for (let s = 0; s < 256; s++) {
    // Different odd strides in a stratified 16x16 grid avoid sampling only rules.
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
    // A screen must have at least 192 fully flat samples. Stop when impossible.
    if (flat + 255 - s < 192) return false;
  }
  return flat >= 192;
}

const screenValueAt = (rgba, i, c, shape) => rgba[i + (shape.colour === 1 && c === 1 ? 3 : c)];
const screenPacked = (rgba, i) => rgba[i] + rgba[i + 1] * 256 + rgba[i + 2] * 65536 + rgba[i + 3] * 16777216;

// Palette order is learned once from the frame. The immutable mapping is also the worker setup; filling a tile
// must use that same order rather than rebuilding a palette from its subset of colours.
function screenFill(setup) {
  const {mode, channels, colour, index, maps} = setup;
  return (planes, rgba, stride, x0, y0, w, h) => {
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const p = ((y0 + y) * stride + x0 + x) * 4, at = y * w + x;
      if (mode === 'global' || mode === 'frequency') planes[0][at] = index.get(screenPacked(rgba, p));
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

// A whole-colour palette in integer-key or frequency order, including the
// actual zero colour only when present; or sparse scalar channel palettes.
export function screenPlan(rgba, width, height, shape, mode = 'global') {
  const channels = shape.channels,
    meta = [],
    transforms = [];
  if (mode === 'global' || mode === 'frequency') {
    const seen = new Map();
    if (mode === 'frequency') {
      for (let i = 0; i < rgba.length; i += 4) {
        const k = screenPacked(rgba, i), count = seen.get(k) || 0;
        if (!count && seen.size === 4096) return null;
        seen.set(k, count + 1);
      }
    } else for (let i = 0; i < rgba.length; i += 4) {
      const k = screenPacked(rgba, i);
      if (!seen.has(k)) {
        if (seen.size === 4096) return null;
        seen.set(k, 0);
      }
    }
    const colours = [...seen.keys()].sort(mode === 'frequency' ? (a, b) => seen.get(b) - seen.get(a) || a - b : (a, b) => a - b),
      n = colours.length;
    colours.forEach((k, i) => seen.set(k, i));
    const rows = new Int16Array(n * channels);
    for (let c = 0; c < channels; c++)
      for (let i = 0; i < n; i++)
        rows[c * n + i] = (colours[i] >>> (8 * (shape.colour === 1 && c === 1 ? 3 : c))) & 255;
    meta.push({plane: rows, width: n, height: channels});
    transforms.push({type: 'palette', beginC: 0, numC: channels, nbColors: n});
    return screenPlanned(rgba, width, meta, transforms, {mode, count: 1, channels, colour: shape.colour, index: seen});
  }
  if (mode === 'scalar') {
    const maps = Array.from({length: channels}, () => new Int16Array(256).fill(-1));
    for (let i = 0; i < rgba.length; i += 4)
      for (let c = 0; c < channels; c++) maps[c][screenValueAt(rgba, i, c, shape)] = 0;
    const palettes = maps.map(map => Array.from({length: 256}, (_, i) => i).filter(v => map[v] === 0));
    // Dense scalar alphabets cost more than they remove. Leave those channels
    // alone; the complete stream still competes with the current effort floor.
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

// A complete format group retains its prediction edges and LZ history on either thread. Deep groups own their
// complete model; global-model groups return additive histograms or emit the coordinator's selected codes.
export function screenGroup(setup) {
  const fill = screenFill(setup.plan);
  let planes;
  return (rgba, stride, x0, y0, w, h, target) => {
    if (!planes || planes[0].length < w * h) planes = Array.from({length: setup.plan.count}, () => new Int16Array(w * h));
    fill(planes, rgba, stride, x0, y0, w, h);
    if (setup.depth !== undefined) {
      const models = planes.map(plane => screenModel(plane, w, h, setup.depth));
      const section = new BitWriter(w * h * planes.length + 256);
      writeModularHeader(section, {useGlobalTree: false});
      writeScreenModel(section, models)();
      return section.finish();
    }
    const custom = setup.lz ? screenLZ77.create({distances: target?.at(-1), distanceCode: setup.distanceCode}) : null;
    const writer = setup.codes ? new BitWriter(w * h * planes.length + 64) : null;
    if (writer) writeModularHeader(writer);
    for (let c = 0; c < planes.length; c++) {
      const code = writer ? setup.codes[c] : target[c];
      if (custom) custom.code(writer, code, planes[c], w, h, setup.leaves[c]);
      else codeChannel(writer, code, planes[c], w, h, setup.leaves[c]);
    }
    return writer?.finish();
  };
}

// Exact prefix-header and payload cost.
function screenPrefixPrice(freq) {
  const code = buildCode(freq),
    w = new BitWriter(128);
  writePrefixCode(w, code);
  let bits = w.bitLength;
  for (let s = 0; s < freq.length; s++)
    if (freq[s]) bits += freq[s] * (code.lengths[s] + Math.max(0, s < 224 ? s - 1 : s - 236));
  return bits;
}

// Header hooks let a reference-only atlas and patched frame share the pixel coder.
export function* screenFrameSteps(
  rgba,
  width,
  height,
  shape,
  colorSpace,
  plan,
  {predictor = null, frameHeader = null, globalPrefix = null, imageHeader = true, tokenCodec = null, search = null, pooled = false} = {}
) {
  if (search) return yield* screenDetailedFrameSteps(rgba, width, height, shape, colorSpace, plan, {frameHeader, globalPrefix, imageHeader, pooled, ...search});
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
  const distances = tokenCodec ? new Uint32Array(64) : null, custom = tokenCodec?.create({distances});
  const parallel = pooled && !layout.single && (!tokenCodec || tokenCodec === screenLZ77);
  const setup = {plan: plan.setup, leaves, lz: !!tokenCodec};
  const code = (writer, target, plane, w, h, l, s) =>
    custom ? custom.code(writer, target, plane, w, h, l, s) : codeChannel(writer, target, plane, w, h, l);
  for (let c = 0; c < plan.meta.length; c++) {
    const m = plan.meta[c];
    code(null, freqs[c], m.plane, m.width, m.height, leaves[c], c);
  }
  if ((yield* groupPass({pooled: parallel, kind: 'screen', data: rgba, width, height,
    setup: {...setup, sizes: [...freqs.map(freq => freq.length), ...(distances ? [64] : [])]},
    at: g => (g + 1) / (2 * groups), stop: () => true}, groups, g => {
    visit(g, (w, h) => {
      for (let c = 0; c < plan.count; c++) {
        const s = slot(c);
        code(null, freqs[s], planes[c], w, h, leaves[s], s);
      }
    });
  }, (g, counts) => {
    addCounts(freqs, counts);
    if (distances) addCounts([distances], [counts.at(-1)]);
  })) === null) return null;
  const header = new BitWriter(256);
  if (imageHeader) writeImageHeader(header, width, height, shape.colour, shape.alpha, {colorSpace});
  if (frameHeader) frameHeader(header);
  else writeModularFrameHeader(header, {alpha: shape.alpha});
  const global = new BitWriter(4096);
  if (globalPrefix) globalPrefix(global);
  global.write(1, 1); // default DC quantisation
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
  if ((yield* groupPass({pooled: parallel, kind: 'screen', data: rgba, width, height,
    setup: {...setup, codes: histograms.slice(1).map(histogram => histogram.code), distanceCode: custom ? histograms[0].code : undefined},
    at: g => 0.5 + (g + 1) / (2 * groups), stop: () => true}, groups, g => {
    visit(g, (w, h) => {
      const out = layout.single ? global : new BitWriter(w * h * plan.count + 64);
      if (!layout.single) writeModularHeader(out);
      for (let c = 0; c < plan.count; c++) {
        const s = slot(c);
        code(out, histograms[s + 1].code, planes[c], w, h, leaves[s], s);
      }
      sections.push(out.finish());
    });
  }, (g, bytes) => sections.push(bytes))) === null) return null;
  return assembleCodestream(header, sections);
}

// Each large group selects predictors after pricing copies and writes its own model.
// Scratch memory is bounded by one group, independent of image area.
function* screenDetailedFrameSteps(rgba, width, height, shape, colorSpace, plan,
  {dim = 1024, depth = 4, frameHeader = null, globalPrefix = null, imageHeader = true, pooled = false}) {
  const layout = groupLayout(width, height, dim), groups = layout.groupsX * layout.groupsY,
    header = new BitWriter(256), global = new BitWriter(4096), sections = [];
  let planes;
  if (imageHeader) writeImageHeader(header, width, height, shape.colour, shape.alpha, {colorSpace});
  if (frameHeader) frameHeader(header);
  else writeModularFrameHeader(header, {alpha: shape.alpha, shift: dim === 1024 ? 3 : dim === 512 ? 2 : 1});
  if (globalPrefix) globalPrefix(global);
  global.write(1, 1); global.write(1, 1);
  const meta = plan.meta.map(m => screenModel(m.plane, m.width, m.height, depth));
  let sectionBytes = 0;
  const append = section => { sectionBytes += section.length; admitOutputSize(sectionBytes); sections.push(section); };
  if (!layout.single) {
    const write = writeScreenModel(global, meta.length ? meta : [screenModel(new Int16Array(1), 1, 1, depth)]);
    writeModularHeader(global, {transforms: plan.transforms});
    if (meta.length) write();
    append(global.finish());
    for (let i = 0; i < layout.dcGroupsX * layout.dcGroupsY + 1; i++) sections.push(new Uint8Array(0));
  }
  if ((yield* groupPass({pooled: pooled && !layout.single, kind: 'screen', data: rgba, width, height, dim,
    setup: {plan: plan.setup, depth}, at: g => (g + 1) / groups, stop: () => true}, groups, g => {
    const x = g % layout.groupsX * dim, y = ((g / layout.groupsX) | 0) * dim,
      w = Math.min(dim, width - x), h = Math.min(dim, height - y);
    planes ||= Array.from({length: plan.count}, () => new Int16Array(Math.min(width, dim) * Math.min(height, dim)));
    plan.fill(planes, x, y, w, h);
    const models = planes.map(plane => screenModel(plane, w, h, depth)),
      section = layout.single ? global : new BitWriter(w * h * plan.count + 256);
    if (!layout.single) writeModularHeader(section, {useGlobalTree: false});
    const write = writeScreenModel(section, layout.single ? [...meta, ...models] : models);
    if (layout.single) writeModularHeader(section, {transforms: plan.transforms});
    write(); append(section.finish());
  }, (g, bytes) => append(bytes))) === null) return null;
  return assembleCodestream(header, sections);
}

export function encodeScreen(rgba, width, height, shape, colorSpace, options = {}) {
  const plan = screenPlan(rgba, width, height, shape, options.mode);
  return plan ? complete(screenFrameSteps(rgba, width, height, shape, colorSpace, plan, options)) : null;
}
