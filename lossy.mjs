// Rapier's JPEG XL encoder: lossy pictures. MIT (LICENSE).
// Lossy modular as libjxl encodes it: the reversible YCoCg transform, the Squeeze transform to its default
// depth, then each squeezed channel quantised by a step that halves with every level (chroma coarser than luma),
// carried as the multiplier of that channel's tree leaf so the decoder scales the residuals back. The finest
// low-pass image is kept exact. Quality maps to libjxl's distance (90 is 1.0).
import {BitWriter, complete} from './bits.mjs';
import {writeImageHeader, writeModularFrameHeader, groupLayout, finishSections, assembleCodestream} from './frame.mjs';
import {ZERO_PREDICTOR, GRADIENT_PREDICTOR, ALPHABET, leaf, channelTree, streamTree, writeTree, writeModularHeader, writeChannelHistograms, codeChannel} from './modular.mjs';
import {forwardSqueeze, defaultSqueezeParams} from './squeeze.mjs';
import {inspectPixels} from './lossless.mjs';

const QUALITY_FACTOR = 0.35, LUMA_FACTOR = 1.1;
// Groups of 1,024 pixels (group size shift 3), DC groups of 8,192: fewer sections and fewer bytes, and a picture up to
// 8,192 pixels on a side is one DC group, so no coarse Squeeze channel meets a DC group border inside it. A decoder
// that reads such a border from the wrong origin (jxl-rs 0.7.4, where one coarse tile holds several finer ones) reads
// these right. A picture within 256 pixels is one group either way and keeps the header of 256-pixel groups.
const SQUEEZE_GROUP = 1024, SQUEEZE_DC_GROUP = 8 * SQUEEZE_GROUP;

// libjxl's JxlEncoderDistanceFromQuality.
export function distanceFromQuality(quality) {
  return quality >= 100 ? 0 : quality >= 30 ? 0.1 + (100 - quality) * 0.09 : 53 / 3000 * quality * quality - 23 / 20 * quality + 25;
}

// distance ** 1.2 in arithmetic every engine rounds alike (`**` does not): the fifth root by Newton's iteration from a
// fixed start, times the distance. Within three ulps of V8's power, and the same integer steps at every quality by 0.001.
function distancePower(distance) {
  let root = 1;
  for (let i = 0; i < 24; i++) root = (4 * root + distance / (root * root * root * root)) / 5;
  return distance * root;
}

// The quantisation step of a squeezed channel: `component` 0 luma, 1-2 chroma, 3 an extra channel.
export function quantiserFor(component, hshift, vshift, distance) {
  let shift = Math.min(16, hshift + vshift);
  if (shift > 0) shift--;
  // Alpha is authored coverage: quantising its Squeeze residuals changes compositing even when RGB is close.
  if (component === 3) return 1;
  const base = 0.25 * distancePower(distance), scale = 1 << shift;
  const q = component === 1 || component === 2 ? base * QUALITY_FACTOR * Math.max(0.5, 1024 / scale) : base * QUALITY_FACTOR * LUMA_FACTOR * (163.84 / scale);
  return Math.max(1, Math.floor(q));
}

export function encodeLossy(rgba, width, height, options) { return complete(lossySteps(rgba, width, height, options)); }

// The same as steps: Squeeze and the plan one step, then a section of each pass per step.
export function* lossySteps(rgba, width, height, {quality = 90, shape = inspectPixels(rgba, width, height, {palette: false}), colorSpace} = {}) {
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
  // Avoid empty chroma channels at the global/group boundary in a one-wide colour image. Any other colour picture one
  // pixel wide or high names its Squeeze steps, the decoder's defaults, instead of leaving them to the decoder: one that
  // regenerates them (jxl-rs 0.7.4) leaves out the chroma steps an axis of one pixel makes empty, and misreads the rest.
  const thin = width === 1 && height > SQUEEZE_GROUP && colour === 3;
  const params = thin ? defaultSqueezeParams(channels).filter(p => !p.horizontal) : (width === 1 || height === 1) && colour === 3 ? defaultSqueezeParams(channels) : [];
  const squeezed = forwardSqueeze(channels, params.length ? params : undefined);
  const predictorOf = ch => ch.residual ? ZERO_PREDICTOR : GRADIENT_PREDICTOR;
  const quantiserOf = ch => quantiserFor(ch.component, ch.hshift + (thin && ch.component > 0 && ch.component < 3 ? 1 : 0), ch.vshift, distance);
  const transforms = [...(colour === 3 ? [{type: 'rct', beginC: 0, rctType: 6}] : []), {type: 'squeeze', params}];

  // The sections and the channel pieces each holds, in the decoder's order: the global section takes the channels
  // up to the first wider or taller than a group; DC groups take the rest with both shifts of three or more, AC
  // groups the rest; a piece is the group's rectangle at the channel's scale. A channel's number inside a section
  // is its place among that section's pieces, so every section gets its own subtree under the stream property.
  const layout = groupLayout(width, height, SQUEEZE_GROUP), dcGroups = layout.dcGroupsX * layout.dcGroupsY, acGroups = layout.groupsX * layout.groupsY;
  let globalCount = 0;
  while (globalCount < squeezed.length && squeezed[globalCount].w <= SQUEEZE_GROUP && squeezed[globalCount].h <= SQUEEZE_GROUP) globalCount++;
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
        const rect = rectOf(ch, gx * SQUEEZE_DC_GROUP, gy * SQUEEZE_DC_GROUP, SQUEEZE_DC_GROUP);
        if (rect.w > 0 && rect.h > 0) section.pieces.push({c, rect});
      }
      sections.push(section);
    }
    for (let g = 0; g < acGroups; g++) {
      const gx = g % layout.groupsX, gy = (g / layout.groupsX) | 0, section = {index: 2 + dcGroups + g, streamId: 1 + 3 * dcGroups + 17 + g, pieces: []};
      for (let c = globalCount; c < squeezed.length; c++) {
        const ch = squeezed[c];
        if (Math.min(ch.hshift, ch.vshift) > 2) continue;
        const rect = rectOf(ch, gx * SQUEEZE_GROUP, gy * SQUEEZE_GROUP, SQUEEZE_GROUP);
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

  const scratch = new Int16Array(SQUEEZE_GROUP * SQUEEZE_GROUP);
  const dataOf = piece => {
    const ch = squeezed[piece.c], rect = piece.rect;
    if (rect.w === ch.w && rect.h === ch.h) return ch.data;
    for (let y = 0; y < rect.h; y++) scratch.set(ch.data.subarray((rect.y + y) * ch.w + rect.x, (rect.y + y) * ch.w + rect.x + rect.w), y * rect.w);
    return scratch;
  };
  // One histogram per channel that owns a piece, numbered densely in channel order. The decoder counts the
  // histograms from the context map and refuses a hole in it; Squeeze of a one-wide picture leaves zero-width
  // chroma residual channels that own no piece between channels that do.
  const owners = [...new Set(sections.flatMap(section => section.pieces.map(piece => piece.c)))].sort((a, b) => a - b);
  const histogramOf = new Map(owners.map((c, i) => [c, i]));
  const freqs = owners.map(() => new Uint32Array(ALPHABET)), total = 1 + 2 * sections.length;
  let done = 1;
  yield done / total;
  for (const section of sections) {
    for (const piece of section.pieces) codeChannel(null, freqs[histogramOf.get(piece.c)], dataOf(piece), piece.rect.w, piece.rect.h, piece.leaf);
    yield ++done / total;
  }

  const header = new BitWriter(256);
  writeImageHeader(header, width, height, colour, alpha, {colorSpace});
  writeModularFrameHeader(header, {alpha, shift: width > 256 || height > 256 ? 3 : 1});
  // Section order: DC global, DC groups, AC global (empty), AC groups.
  const writers = Array.from({length: layout.single ? 1 : 2 + dcGroups + acGroups}, () => null);
  const global = writers[0] = new BitWriter(65536);
  global.write(1, 1);  // default DC quantisation
  global.write(1, 1);  // a global tree
  const ordered = writeTree(global, tree);
  const histograms = writeChannelHistograms(global, ordered, freqs, l => histogramOf.get(l.channel));
  writeModularHeader(global, {useGlobalTree: true, transforms});
  for (const section of sections) {
    let w = writers[section.index];
    if (!w) {
      w = writers[section.index] = new BitWriter(4096);
      if (section.pieces.length) writeModularHeader(w, {useGlobalTree: true, transforms: []});
    }
    for (const piece of section.pieces) codeChannel(w, histograms[histogramOf.get(piece.c) + 1].code, dataOf(piece), piece.rect.w, piece.rect.h, piece.leaf);
    yield ++done / total;
  }
  return assembleCodestream(header, finishSections(writers));
}
