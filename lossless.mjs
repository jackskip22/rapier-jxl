// Rapier's JPEG XL encoder: lossless pictures. MIT (LICENSE).
// The design of libjxl's fast lossless path, written for Rapier: 8-bit grey, grey+alpha, RGB or RGBA; an opaque
// alpha is dropped and a grey picture keeps one channel; up to 512 colours become a palette; colour goes through
// the reversible YCoCg transform; every channel is predicted by the clamped gradient and coded with one prefix
// code per channel, zero runs as LZ77 copies; groups of 256x256 pixels, each an independent section.
import {BitWriter} from './bits.mjs';
import {writeImageHeader, writeModularFrameHeader, groupLayout, assembleCodestream, GROUP_DIM} from './frame.mjs';
import {PREDICTOR, ALPHABET, leaf, channelTree, writeTree, writeModularHeader, writeChannelHistograms, codeChannel} from './modular.mjs';

const MAX_PALETTE = 512;

// What the picture is: which channels it needs and, when few colours, its palette.
export function inspectPixels(rgba, width, height, {palette: wantPalette = true} = {}) {
  const pixels = width * height;
  let opaque = true, grey = true;
  for (let i = 0, p = 0; p < pixels; p++, i += 4) {
    if (rgba[i + 3] !== 255) { opaque = false; if (!grey) break; }
    if (rgba[i] !== rgba[i + 1] || rgba[i] !== rgba[i + 2]) { grey = false; if (!opaque) break; }
  }
  const colour = grey ? 1 : 3, alpha = !opaque, channels = colour + (alpha ? 1 : 0);
  // The packed colour of a pixel: channel c in byte c, as the palette rows are laid out.
  const key = i => grey
    ? (alpha ? rgba[i] + rgba[i + 3] * 256 : rgba[i])
    : rgba[i] + rgba[i + 1] * 256 + rgba[i + 2] * 65536 + (alpha ? rgba[i + 3] * 16777216 : 0);
  const seen = new Map();
  let palette = null;
  for (let i = 0, p = 0; wantPalette && p < pixels; p++, i += 4) {
    const k = key(i);
    if (k === 0 || seen.has(k)) continue;
    seen.set(k, 1);
    if (seen.size >= MAX_PALETTE) break;
  }
  if (wantPalette && seen.size < MAX_PALETTE) {
    const entries = [...seen.keys()];
    const byte = (k, c) => Math.floor(k / 256 ** c) % 256;
    let lowest = 255, highest = 0;
    for (const k of entries) { const g = byte(k, 1); if (g < lowest) lowest = g; if (g > highest) highest = g; }
    // A grey ramp without holes gains nothing from a palette.
    const ramp = colour === 1 && !alpha && (() => { let lo = 255, hi = 0; for (const k of entries) { if (k < lo) lo = k; if (k > hi) hi = k; } return hi - lo < entries.length * 1.4; })();
    if (!ramp) {
      const weight = k => (0.299 * byte(k, 0) + 0.587 * byte(k, 1) + 0.114 * byte(k, 2) + 0.01) * (channels === 4 ? byte(k, 3) : 1);
      entries.sort((a, b) => weight(a) - weight(b));
      const index = new Map([[0, 0]]);
      entries.forEach((k, at) => index.set(k, at + 1));
      palette = {colours: [0, ...entries], index, key, byte};
    }
  }
  return {colour, alpha, channels, palette};
}

export function encodeLossless(rgba, width, height, {shape = inspectPixels(rgba, width, height)} = {}) {
  const {channels, palette} = shape;
  const layout = groupLayout(width, height);
  const streamChannels = palette ? 2 : channels;  // the palette's meta channel and the index channel
  const leaves = Array.from({length: streamChannels}, () => leaf(PREDICTOR.gradient));
  const tree = channelTree(leaves);
  const transforms = palette
    ? [{type: 'palette', beginC: 0, numC: channels, nbColors: palette.colours.length}]
    : channels >= 3 ? [{type: 'rct', beginC: 0, rctType: 6}] : [];

  // Channel planes of a group rectangle, computed straight from the pixels.
  const planes = Array.from({length: streamChannels}, () => new Int32Array(GROUP_DIM * GROUP_DIM));
  const fill = (x0, y0, w, h) => {
    for (let y = 0; y < h; y++) {
      let i = ((y0 + y) * width + x0) * 4, at = y * w;
      for (let x = 0; x < w; x++, i += 4, at++) {
        if (palette) { planes[0][at] = palette.index.get(palette.key(i)); continue; }
        if (channels >= 3) {
          const r = rgba[i], g = rgba[i + 1], b = rgba[i + 2];
          const co = r - b, tmp = b + (co >> 1), cg = g - tmp;
          planes[0][at] = tmp + (cg >> 1); planes[1][at] = co; planes[2][at] = cg;
          if (channels === 4) planes[3][at] = rgba[i + 3];
        } else { planes[0][at] = rgba[i]; if (channels === 2) planes[1][at] = rgba[i + 3]; }
      }
    }
  };
  // The palette meta channel: one row per channel, one column per colour.
  let paletteRows = null;
  if (palette) {
    const n = palette.colours.length;
    paletteRows = new Int32Array(n * channels);
    palette.colours.forEach((k, at) => { for (let c = 0; c < channels; c++) paletteRows[c * n + at] = palette.byte(k, c); });
  }
  // The image channels of a section: in the global section they follow the meta channel; in a group they start at 0.
  const pictureLeaf = c => leaves[palette ? (layout.single ? 1 : 0) : c];
  const pictureChannels = palette ? 1 : channels;

  const forGroups = visit => {
    for (let gy = 0; gy < layout.groupsY; gy++) for (let gx = 0; gx < layout.groupsX; gx++) {
      const x0 = gx * GROUP_DIM, y0 = gy * GROUP_DIM, w = Math.min(GROUP_DIM, width - x0), h = Math.min(GROUP_DIM, height - y0);
      fill(x0, y0, w, h);
      visit(gy * layout.groupsX + gx, w, h);
    }
  };

  // Pass one: token histograms per leaf.
  const freqs = leaves.map(() => new Uint32Array(ALPHABET)), freqOf = l => freqs[leaves.indexOf(l)];
  if (paletteRows) codeChannel(null, freqOf(leaves[0]), paletteRows, palette.colours.length, channels, leaves[0]);
  forGroups((g, w, h) => { for (let c = 0; c < pictureChannels; c++) codeChannel(null, freqOf(pictureLeaf(c)), planes[c], w, h, pictureLeaf(c)); });

  // Pass two: the sections.
  const header = new BitWriter(256);
  writeImageHeader(header, width, height, shape.colour, shape.alpha);
  writeModularFrameHeader(header, {alpha: shape.alpha});
  const global = new BitWriter(4096);
  global.write(1, 1);  // default DC quantisation
  global.write(1, 1);  // a global tree
  const ordered = writeTree(global, tree);
  const histograms = writeChannelHistograms(global, ordered, freqs, l => leaves.indexOf(l));
  const codeOf = l => histograms[leaves.indexOf(l) + 1].code;
  writeModularHeader(global, {useGlobalTree: true, transforms});
  if (paletteRows) codeChannel(global, codeOf(leaves[0]), paletteRows, palette.colours.length, channels, leaves[0]);
  const sections = [];
  if (layout.single) {
    forGroups((g, w, h) => { for (let c = 0; c < pictureChannels; c++) codeChannel(global, codeOf(pictureLeaf(c)), planes[c], w, h, pictureLeaf(c)); });
    global.zeroPadToByte();
    sections.push(global.finish());
  } else {
    global.zeroPadToByte();
    sections.push(global.finish());
    for (let i = 0; i < layout.dcGroupsX * layout.dcGroupsY + 1; i++) sections.push(new Uint8Array(0));
    forGroups((g, w, h) => {
      const section = new BitWriter(w * h * pictureChannels + 64);
      writeModularHeader(section, {useGlobalTree: true, transforms: []});
      for (let c = 0; c < pictureChannels; c++) codeChannel(section, codeOf(pictureLeaf(c)), planes[c], w, h, pictureLeaf(c));
      section.zeroPadToByte();
      sections.push(section.finish());
    });
  }
  return assembleCodestream(header, sections);
}
