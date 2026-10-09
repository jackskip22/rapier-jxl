// SPDX-License-Identifier: MIT
// Local palette indices share one learned pixel model across local and global palette representations.
import {BitWriter} from './bits.mjs';
import {writeImageHeader, writeModularFrameHeader, groupLayout, groupRect, groupPass, assembleCodestream} from './frame.mjs';
import {ALPHABET, leaf, writeTree, writeModularHeader, writeChannelHistograms} from './modular.mjs';
import {sampledPlanes, SAMPLE_RUNGS} from './sampled.mjs';
import {screenPlan} from './screen.mjs';
import {admitOutputSize} from './admit.mjs';

const packed = (rgba, i) => rgba[i] + rgba[i + 1] * 256 + rgba[i + 2] * 65536 + rgba[i + 3] * 16777216;
const PALETTE_MODEL = Object.freeze({...SAMPLE_RUNGS.precise, predictors: Object.freeze([5, 6, 1, 2, 0])});

// A group returns the complete section for each frame representation. Palette indices remain 16-bit values
// when a local table refers to a larger global palette; only the RGBA table contains byte-valued entries.
export function paletteGroup(setup) {
  const {index, rows, colours, channels, colour, alpha, single} = setup, model = PALETTE_MODEL;
  const weights = Float64Array.from({length: colours}, (_, i) => {
    const r = rows[i], g = colour === 3 ? rows[colours + i] : r, b = colour === 3 ? rows[2 * colours + i] : r;
    return (299 * r + 587 * g + 114 * b + 100) * (alpha ? rows[(channels - 1) * colours + i] + 1 : 1);
  });
  return (rgba, stride, x0, y0, width, height) => {
    const values = new Int16Array(width * height), counts = new Uint32Array(colours);
    for (let y = 0, at = 0; y < height; y++) for (let x = 0; x < width; x++, at++) {
      const value = index.get(packed(rgba, ((y0 + y) * stride + x0 + x) * 4));
      values[at] = value; counts[value]++;
    }
    const entries = [];
    for (let i = 0; i < colours; i++) if (counts[i]) entries.push(i);
    entries.sort((a, b) =>
      (counts[a] > 4 ? -weights[a] : weights[a]) - (counts[b] > 4 ? -weights[b] : weights[b]) || a - b);
    const count = entries.length, mapping = new Int16Array(colours), indices = new Int16Array(values.length);
    entries.forEach((value, i) => { mapping[value] = i; });
    for (let i = 0; i < values.length; i++) indices[i] = mapping[values[i]];
    const image = sampledPlanes.prepare(indices, width, height, model), sections = [];
    for (let representation = 0; representation < (single ? 1 : 2); representation++) {
      const tableChannels = representation ? 1 : channels, table = new Int16Array(count * tableChannels);
      for (let c = 0; c < tableChannels; c++) for (let i = 0; i < count; i++)
        table[c * count + i] = representation ? entries[i] : rows[c * colours + entries[i]];
      const meta = sampledPlanes.prepare(table, count, tableChannels, model), section = new BitWriter(256);
      if (single) { section.write(1, 1); section.write(1, 1); }
      sampledPlanes.write(section, [meta, image], model, {global: single,
        transforms: [{type: 'palette', beginC: 0, numC: tableChannels, nbColors: count}]});
      sections.push(section.finish());
    }
    return sections;
  };
}

export function* paletteSteps(rgba, width, height, shape, colorSpace,
  {plan = null, pooled = false, ceiling = Infinity} = {}) {
  plan ||= screenPlan(rgba, width, height, shape, 'global');
  if (!plan) return null;
  const palette = plan.meta[0], model = PALETTE_MODEL;
  // A palette that fits the model's leaf budget can share a larger group. This measured heuristic avoids
  // duplicate fits; richer palettes retain spatial groups, and the preceding complete stream remains the floor.
  const dim = palette.width <= model.leaves ? 1024 : 256;
  const layout = groupLayout(width, height, dim), groups = layout.groupsX * layout.groupsY;
  const setup = {index: plan.setup.index, rows: palette.plane, colours: palette.width,
    channels: shape.channels, colour: shape.colour, alpha: shape.alpha, single: layout.single};
  const header = () => {
    const writer = new BitWriter(128);
    writeImageHeader(writer, width, height, shape.colour, shape.alpha, {colorSpace});
    writeModularFrameHeader(writer, {alpha: shape.alpha, shift: dim === 1024 ? 3 : 1});
    return writer;
  };
  const group = paletteGroup(setup);
  if (layout.single) {
    const bytes = assembleCodestream(header(), [group(rgba, width, 0, 0, width, height)[0]]);
    yield 1;
    return bytes.length < ceiling ? bytes : null;
  }
  const frames = [], sizes = [0, 0];
  for (let representation = 0; representation < 2; representation++) {
    const global = new BitWriter(256);
    global.write(1, 1); global.write(1, 1);
    if (representation) sampledPlanes.write(global,
      [sampledPlanes.prepare(palette.plane, palette.width, palette.height, model)], model,
      {global: true, transforms: plan.transforms});
    else {
      const tree = leaf(0);
      writeChannelHistograms(global, writeTree(global, tree), [new Uint32Array(ALPHABET)]);
      writeModularHeader(global);
    }
    const bytes = global.finish();
    sizes[representation] = bytes.length;
    frames.push(sizes[representation] < ceiling ? [bytes] : null);
    if (frames[representation]) for (let i = 0; i < layout.dcGroupsX * layout.dcGroupsY + 1; i++)
      frames[representation].push(new Uint8Array(0));
  }
  const append = (g, sections) => {
    for (let representation = 0; representation < 2; representation++) if (frames[representation]) {
      sizes[representation] += sections[representation].length;
      admitOutputSize(sizes[representation]);
      if (sizes[representation] >= ceiling) frames[representation] = null;
      else frames[representation].push(sections[representation]);
    }
  };
  if (!frames.some(Boolean)) return null;
  if (pooled) {
    if ((yield* groupPass({pooled, kind: 'palette', setup, data: rgba, width, height, dim,
      at: g => (g + 1) / groups, stop: g => g + 1 < groups}, groups, null, append)) === null) return null;
  } else for (let g = 0; g < groups; g++) {
    append(g, group(rgba, width, ...groupRect(layout, width, height, g, dim)));
    const hurried = yield (g + 1) / groups;
    if (!frames.some(Boolean) || hurried && g + 1 < groups) return null;
  }
  let best = null;
  for (const sections of frames) if (sections) {
    const bytes = assembleCodestream(header(), sections);
    if (bytes.length < ceiling && (!best || bytes.length < best.length)) best = bytes;
  }
  return best;
}
