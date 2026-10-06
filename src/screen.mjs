// SPDX-License-Identifier: MIT
// Effort-only screen coding. A fixed 256-sample gate rejects textured pictures
// without allocating an image-sized scratch buffer. The core never imports this.
import {BitWriter, packSigned, complete} from './bits.mjs';
import {writeImageHeader, writeModularFrameHeader, groupLayout, assembleCodestream, GROUP_DIM} from './frame.mjs';
import {buildCode, writePrefixCode} from './prefix.mjs';
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

// A whole-colour palette sorted with integer keys, including the actual zero
// colour only when present; or sparse scalar palettes on individual channels.
export function screenPlan(rgba, width, height, shape, mode = 'global') {
  const channels = shape.channels,
    meta = [],
    transforms = [];
  if (mode === 'global') {
    const seen = new Map();
    for (let i = 0; i < rgba.length; i += 4) {
      const k = screenPacked(rgba, i);
      if (!seen.has(k)) {
        if (seen.size === 4096) return null;
        seen.set(k, 0);
      }
    }
    const colours = [...seen.keys()].sort((a, b) => a - b),
      n = colours.length;
    colours.forEach((k, i) => seen.set(k, i));
    const rows = new Int16Array(n * channels);
    for (let c = 0; c < channels; c++)
      for (let i = 0; i < n; i++)
        rows[c * n + i] = (colours[i] >>> (8 * (shape.colour === 1 && c === 1 ? 3 : c))) & 255;
    meta.push({plane: rows, width: n, height: channels});
    transforms.push({type: 'palette', beginC: 0, numC: channels, nbColors: n});
    return {
      mode,
      meta,
      transforms,
      count: 1,
      fill: (planes, x0, y0, w, h) => {
        for (let y = 0; y < h; y++)
          for (let x = 0; x < w; x++)
            planes[0][y * w + x] = seen.get(screenPacked(rgba, ((y0 + y) * width + x0 + x) * 4));
      }
    };
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
    return {
      mode,
      meta,
      transforms,
      count: channels,
      fill: (planes, x0, y0, w, h) => {
        for (let y = 0; y < h; y++)
          for (let x = 0; x < w; x++) {
            const p = ((y0 + y) * width + x0 + x) * 4;
            for (let c = 0; c < channels; c++) {
              const v = screenValueAt(rgba, p, c, shape);
              planes[c][y * w + x] = maps[c] ? maps[c][v] : v;
            }
          }
      }
    };
  }
  return {
    mode: 'direct',
    meta,
    transforms: channels >= 3 ? [{type: 'rct', beginC: 0, rctType: 6}] : [],
    count: channels,
    fill: (planes, x0, y0, w, h) => {
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
          const p = ((y0 + y) * width + x0 + x) * 4,
            at = y * w + x;
          if (channels >= 3) {
            const co = rgba[p] - rgba[p + 2],
              tmp = rgba[p + 2] + (co >> 1),
              cg = rgba[p + 1] - tmp;
            planes[0][at] = tmp + (cg >> 1);
            planes[1][at] = co;
            planes[2][at] = cg;
            if (channels === 4) planes[3][at] = rgba[p + 3];
          } else {
            planes[0][at] = rgba[p];
            if (channels === 2) planes[1][at] = rgba[p + 3];
          }
        }
    }
  };
}

// Count a code's real prefix header and payload, not entropy approximations.
function screenPrefixPrice(freq) {
  const code = buildCode(freq),
    w = new BitWriter(128);
  writePrefixCode(w, code);
  let bits = w.bitLength;
  for (let s = 0; s < freq.length; s++)
    if (freq[s]) bits += freq[s] * (code.lengths[s] + Math.max(0, s < 224 ? s - 1 : s - 236));
  return bits;
}

// Optional header/global hooks belong only to the heavier screen/patch path.
// They let a reference-only atlas and a patched frame reuse the same pixel coder.
export function* screenFrameSteps(
  rgba,
  width,
  height,
  shape,
  colorSpace,
  plan,
  {predictor = null, frameHeader = null, globalPrefix = null, imageHeader = true, tokenCodec = null} = {}
) {
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
  const custom = tokenCodec?.create(leaves.length);
  const code = (writer, target, plane, w, h, l, s) =>
    custom ? custom.code(writer, target, plane, w, h, l, s) : codeChannel(writer, target, plane, w, h, l);
  for (let c = 0; c < plan.meta.length; c++) {
    const m = plan.meta[c];
    code(null, freqs[c], m.plane, m.width, m.height, leaves[c], c);
  }
  for (let g = 0; g < groups; g++) {
    visit(g, (w, h) => {
      for (let c = 0; c < plan.count; c++) {
        const s = slot(c);
        code(null, freqs[s], planes[c], w, h, leaves[s], s);
      }
    });
    if (yield (g + 1) / (2 * groups)) return null;
  }
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
  for (let g = 0; g < groups; g++) {
    visit(g, (w, h) => {
      const out = layout.single ? global : new BitWriter(w * h * plan.count + 64);
      if (!layout.single) writeModularHeader(out);
      for (let c = 0; c < plan.count; c++) {
        const s = slot(c);
        code(out, histograms[s + 1].code, planes[c], w, h, leaves[s], s);
      }
      sections.push(out.finish());
    });
    if (yield 0.5 + (g + 1) / (2 * groups)) return null;
  }
  return assembleCodestream(header, sections);
}

export function encodeScreen(rgba, width, height, shape, colorSpace, options = {}) {
  const plan = screenPlan(rgba, width, height, shape, options.mode);
  return plan ? complete(screenFrameSteps(rgba, width, height, shape, colorSpace, plan, options)) : null;
}
