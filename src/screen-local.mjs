// SPDX-License-Identifier: MIT
// Whole-group palette and colour transforms compete after exact copy coding.
import {BitWriter} from './bits.mjs';
import {writeImageHeader, writeModularFrameHeader, groupLayout, groupRect, assembleCodestream} from './frame.mjs';
import {ALPHABET, leaf, writeTree, writeModularHeader, writeChannelHistograms} from './modular.mjs';
import {sampleTransformRanking} from './sampled.mjs';
import {colourTransform} from './rct-search.mjs';
import {screenPlan} from './screen.mjs';
import {screenModel, writeScreenModel} from './screen-lz77.mjs';
import {admitOutputSize} from './admit.mjs';

function localPlan(rgba, width, height, shape, mode) {
  if (mode === 'direct-ranked' && shape.colour === 3) {
    const type = sampleTransformRanking(rgba, width, height)[0], transform = colourTransform(type, shape.channels);
    return {meta: [], count: shape.channels, transforms: [{type: 'rct', beginC: 0, rctType: type}],
      fill: (planes, x, y, w, h) => transform.fill(planes, rgba, width, x, y, w, h)};
  }
  if (mode !== 'luma' && mode !== 'scan') return screenPlan(rgba, width, height, shape, mode);
  const plan = screenPlan(rgba, width, height, shape, 'global');
  if (!plan) return null;
  const palette = plan.meta[0], n = palette.width, rows = palette.plane;
  const order = Array.from({length: n}, (_, i) => i);
  if (mode === 'scan') {
    const first = new Int32Array(n).fill(-1);
    for (let i = 0; i < rgba.length; i += 4) {
      const key = rgba[i] + rgba[i + 1] * 256 + rgba[i + 2] * 65536 + rgba[i + 3] * 16777216;
      const value = plan.setup.index.get(key);
      if (first[value] < 0) first[value] = i;
    }
    order.sort((a, b) => first[a] - first[b]);
  } else {
    const light = i => shape.colour === 3 ? 299 * rows[i] + 587 * rows[n + i] + 114 * rows[2 * n + i] : rows[i] * 1000;
    order.sort((a, b) => light(a) - light(b) || a - b);
  }
  const mapping = new Int16Array(n), table = new Int16Array(rows.length);
  order.forEach((value, i) => { mapping[value] = i; });
  for (let c = 0; c < shape.channels; c++) for (let i = 0; i < n; i++) table[c * n + i] = rows[c * n + order[i]];
  return {...plan, meta: [{...palette, plane: table}], fill(planes, x, y, w, h) {
    plan.fill(planes, x, y, w, h);
    for (let i = 0; i < w * h; i++) planes[0][i] = mapping[planes[0][i]];
  }};
}

const MODES = ['global', 'frequency', 'scalar', 'direct-ranked', 'luma', 'scan'];
function* localScreenCandidate(rgba, width, height, shape, colorSpace,
  {dim = 1024, depths = [64], ceiling = Infinity, stats = null} = {}) {
  const layout = groupLayout(width, height, dim), groups = layout.groupsX * layout.groupsY;
  const header = new BitWriter(128), sections = [];
  writeImageHeader(header, width, height, shape.colour, shape.alpha, {colorSpace});
  writeModularFrameHeader(header, {alpha: shape.alpha, shift: dim === 1024 ? 3 : dim === 512 ? 2 : 1});
  let total = 0;
  const append = bytes => { total += bytes.length; admitOutputSize(total); sections.push(bytes); };
  if (!layout.single) {
    const global = new BitWriter(128);
    global.write(1, 1); global.write(1, 1);
    writeChannelHistograms(global, writeTree(global, leaf(0)), [new Uint32Array(ALPHABET)]);
    writeModularHeader(global); append(global.finish());
    for (let i = 0; i < layout.dcGroupsX * layout.dcGroupsY + 1; i++) sections.push(new Uint8Array(0));
  }
  for (let g = 0; g < groups; g++) {
    const [x, y, w, h] = groupRect(layout, width, height, g, dim);
    const tile = new Uint8Array(w * h * 4);
    for (let row = 0; row < h; row++) tile.set(rgba.subarray(((y + row) * width + x) * 4,
      ((y + row) * width + x + w) * 4), row * w * 4);
    let best = null, selected;
    const candidates = stats ? [] : null;
    for (const [index, mode] of MODES.entries()) {
      if (yield (g + index / MODES.length) / groups) return null;
      const choice = localPlan(tile, w, h, shape, mode);
      if (!choice) continue;
      const values = Array.from({length: choice.count}, () => new Int16Array(w * h));
      choice.fill(values, 0, 0, w, h);
      const planes = [...choice.meta, ...values.map(plane => ({plane, width: w, height: h}))];
      for (const [attempt, depth] of depths.entries()) {
        const writer = new BitWriter(256);
        if (layout.single) { writer.write(1, 1); writer.write(1, 1); }
        else writeModularHeader(writer, {useGlobalTree: false, transforms: choice.transforms});
        const write = writeScreenModel(writer, planes.map(({plane, width, height}) => screenModel(plane, width, height, depth)));
        if (layout.single) writeModularHeader(writer, {transforms: choice.transforms});
        write();
        const bytes = writer.finish();
        candidates?.push({mode, depth, bytes: bytes.length});
        if (!best || bytes.length < best.length) { best = bytes; selected = {mode, depth, bytes: bytes.length}; }
        const hurried = yield (g + (index + (attempt + 1) / depths.length) / MODES.length) / groups;
        if (hurried && (g + 1 < groups || index + 1 < MODES.length || attempt + 1 < depths.length)) return null;
      }
    }
    if (stats) stats.push({g, x, y, width: w, height: h, selected, candidates});
    append(best);
    if (total >= ceiling) return null;
  }
  const bytes = assembleCodestream(header, sections);
  return bytes.length < ceiling ? bytes : null;
}

export function* localScreenSteps(rgba, width, height, shape, colorSpace, options) {
  try { return yield* localScreenCandidate(rgba, width, height, shape, colorSpace, options); }
  catch (error) {
    if (error.code === 'JXL_SIZE' || error instanceof RangeError && !error.code) return null;
    throw error;
  }
}
