// Rapier's JPEG XL encoder: lossy pictures. MIT (LICENSE).
// Lossy modular as libjxl encodes it: the reversible YCoCg transform, the Squeeze transform to its default
// depth, then each squeezed channel quantised by a step that halves with every level (chroma coarser than luma),
// carried as the multiplier of that channel's tree leaf so the decoder scales the residuals back. The finest
// low-pass image is kept exact. Quality maps to libjxl's distance (90 is 1.0).
import {BitWriter} from './bits.mjs';
import {writeImageHeader, writeModularFrameHeader, groupLayout, assembleCodestream, GROUP_DIM, DC_GROUP_DIM} from './frame.mjs';
import {PREDICTOR, ALPHABET, leaf, channelTree, streamTree, writeTree, writeModularHeader, writeChannelHistograms, codeChannel} from './modular.mjs';
import {forwardSqueeze} from './squeeze.mjs';
import {inspectPixels} from './lossless.mjs';

const LUMA_STEPS = [163.84, 81.92, 40.96, 20.48, 10.24, 5.12, 2.56, 1.28, 0.64, 0.32, 0.16, 0.08, 0.04, 0.02, 0.01, 0.005];
const CHROMA_STEPS = [1024, 512, 256, 128, 64, 32, 16, 8, 4, 2, 1, 0.5, 0.5, 0.5, 0.5, 0.5];
const QUALITY_FACTOR = 0.35, LUMA_FACTOR = 1.1;

// libjxl's JxlEncoderDistanceFromQuality.
export function distanceFromQuality(quality) {
  return quality >= 100 ? 0 : quality >= 30 ? 0.1 + (100 - quality) * 0.09 : 53 / 3000 * quality * quality - 23 / 20 * quality + 25;
}

// The quantisation step of a squeezed channel: `component` 0 luma, 1-2 chroma, 3 an extra channel.
export function quantiserFor(component, hshift, vshift, distance) {
  let shift = Math.min(16, hshift + vshift);
  if (shift > 0) shift--;
  // An extra channel (alpha) is quantised at half the colour steps: its edges fringe before colour does.
  const base = component === 3 ? 0.125 * distance : 0.25 * distance ** 1.2;
  const q = component === 1 || component === 2 ? base * QUALITY_FACTOR * CHROMA_STEPS[shift] : base * QUALITY_FACTOR * LUMA_FACTOR * LUMA_STEPS[shift];
  return Math.max(1, Math.floor(q));
}

export function encodeLossy(rgba, width, height, {quality = 90, shape = inspectPixels(rgba, width, height, {palette: false})} = {}) {
  const distance = distanceFromQuality(quality);
  if (!(distance > 0)) throw new Error('lossy encoding needs a quality below 100');
  const {colour, alpha, channels: count} = shape;
  const pixels = width * height;
  // Full planes in the transformed colour space.
  const planes = Array.from({length: count}, () => new Int16Array(pixels));
  for (let i = 0, p = 0; p < pixels; p++, i += 4) {
    if (colour === 3) {
      const r = rgba[i], g = rgba[i + 1], b = rgba[i + 2], co = r - b, tmp = b + (co >> 1), cg = g - tmp;
      planes[0][p] = tmp + (cg >> 1); planes[1][p] = co; planes[2][p] = cg;
    } else planes[0][p] = rgba[i];
    if (alpha) planes[count - 1][p] = rgba[i + 3];
  }
  const channels = planes.map((data, c) => ({w: width, h: height, hshift: 0, vshift: 0, data, component: colour === 3 ? c : c === 0 ? 0 : 3}));
  const squeezed = forwardSqueeze(channels);
  const predictorOf = ch => ch.residual ? PREDICTOR.zero : PREDICTOR.gradient;
  const quantiserOf = ch => quantiserFor(ch.component, ch.hshift, ch.vshift, distance);
  const transforms = [...(colour === 3 ? [{type: 'rct', beginC: 0, rctType: 6}] : []), {type: 'squeeze', params: []}];

  // The sections and the channel pieces each holds, in the decoder's order: the global section takes the channels
  // up to the first wider or taller than a group; DC groups take the rest with both shifts of three or more, AC
  // groups the rest; a piece is the group's rectangle at the channel's scale. A channel's number inside a section
  // is its place among that section's pieces, so every section gets its own subtree under the stream property.
  const layout = groupLayout(width, height), dcGroups = layout.dcGroupsX * layout.dcGroupsY, acGroups = layout.groupsX * layout.groupsY;
  let globalCount = 0;
  while (globalCount < squeezed.length && squeezed[globalCount].w <= GROUP_DIM && squeezed[globalCount].h <= GROUP_DIM) globalCount++;
  const rectOf = (ch, x0, y0, dim) => {
    const x = x0 >> ch.hshift, y = y0 >> ch.vshift;
    return {x, y, w: Math.min(ch.w, x + (dim >> ch.hshift)) - x, h: Math.min(ch.h, y + (dim >> ch.vshift)) - y};
  };
  const sections = [{index: 0, streamId: 0, pieces: []}];
  for (let c = 0; c < globalCount; c++) sections[0].pieces.push({c, rect: {x: 0, y: 0, w: squeezed[c].w, h: squeezed[c].h}});
  if (!layout.single) {
    for (let g = 0; g < dcGroups; g++) {
      const gx = g % layout.dcGroupsX, gy = (g / layout.dcGroupsX) | 0, section = {index: 1 + g, streamId: 1 + dcGroups + g, pieces: []};
      for (let c = globalCount; c < squeezed.length; c++) {
        const ch = squeezed[c];
        if (Math.min(ch.hshift, ch.vshift) < 3) continue;
        const rect = rectOf(ch, gx * DC_GROUP_DIM, gy * DC_GROUP_DIM, DC_GROUP_DIM);
        if (rect.w > 0 && rect.h > 0) section.pieces.push({c, rect});
      }
      sections.push(section);
    }
    for (let g = 0; g < acGroups; g++) {
      const gx = g % layout.groupsX, gy = (g / layout.groupsX) | 0, section = {index: 2 + dcGroups + g, streamId: 1 + 3 * dcGroups + 17 + g, pieces: []};
      for (let c = globalCount; c < squeezed.length; c++) {
        const ch = squeezed[c];
        if (Math.min(ch.hshift, ch.vshift) > 2) continue;
        const rect = rectOf(ch, gx * GROUP_DIM, gy * GROUP_DIM, GROUP_DIM);
        if (rect.w > 0 && rect.h > 0) section.pieces.push({c, rect});
      }
      sections.push(section);
    }
  }
  for (const section of sections) for (const piece of section.pieces) {
    const ch = squeezed[piece.c];
    piece.leaf = leaf(predictorOf(ch), 0, quantiserOf(ch)); piece.leaf.channel = piece.c;
  }
  const withPieces = sections.filter(section => section.pieces.length);
  const tree = withPieces.length === 1 ? channelTree(withPieces[0].pieces.map(p => p.leaf))
    : streamTree(withPieces.map(section => ({streamId: section.streamId, tree: channelTree(section.pieces.map(p => p.leaf))})));

  const scratch = new Int16Array(GROUP_DIM * GROUP_DIM);
  const dataOf = piece => {
    const ch = squeezed[piece.c], rect = piece.rect;
    if (rect.w === ch.w && rect.h === ch.h) return ch.data;
    for (let y = 0; y < rect.h; y++) scratch.set(ch.data.subarray((rect.y + y) * ch.w + rect.x, (rect.y + y) * ch.w + rect.x + rect.w), y * rect.w);
    return scratch;
  };
  const freqs = squeezed.map(() => new Uint32Array(ALPHABET));
  for (const section of sections) for (const piece of section.pieces) codeChannel(null, freqs[piece.c], dataOf(piece), piece.rect.w, piece.rect.h, piece.leaf);

  const header = new BitWriter(256);
  writeImageHeader(header, width, height, colour, alpha);
  writeModularFrameHeader(header, {alpha});
  // Section order: DC global, DC groups, AC global (empty), AC groups.
  const writers = Array.from({length: layout.single ? 1 : 2 + dcGroups + acGroups}, () => null);
  const global = writers[0] = new BitWriter(65536);
  global.write(1, 1);  // default DC quantisation
  global.write(1, 1);  // a global tree
  const ordered = writeTree(global, tree);
  const histograms = writeChannelHistograms(global, ordered, freqs, l => l.channel);
  writeModularHeader(global, {useGlobalTree: true, transforms});
  for (const section of sections) {
    let w = writers[section.index];
    if (!w) {
      w = writers[section.index] = new BitWriter(4096);
      if (section.pieces.length) writeModularHeader(w, {useGlobalTree: true, transforms: []});
    }
    for (const piece of section.pieces) codeChannel(w, histograms[piece.c + 1].code, dataOf(piece), piece.rect.w, piece.rect.h, piece.leaf);
  }
  const out = writers.map(w => w || new BitWriter(16));
  return assembleCodestream(header, out.map(w => { w.zeroPadToByte(); return w.finish(); }));
}
