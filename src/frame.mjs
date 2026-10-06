// Rapier's JPEG XL encoder: the codestream around a frame. MIT (LICENSE).
// A bare codestream (no container): signature, size header, image metadata, one frame with its table of contents.
import {BitWriter} from './bits.mjs';
import {admitOutputSize} from './admit.mjs';

export const GROUP_DIM = 256, DC_GROUP_DIM = 2048;

function writeSize(w, size) {
  w.writeU32([[9, 1], [13, 1], [18, 1], [30, 1]], size);
}

// 8 bits per sample; `colour` 1 (grey) or 3 (sRGB, or Display P3 when `colorSpace` says so); an 8-bit alpha channel
// when `alpha`. Frames start byte-aligned.
export function writeImageHeader(w, width, height, colour, alpha, {xyb = false, orientation = 1, colorSpace} = {}) {
  w.write(16, 0x0AFF);
  w.write(1, 0);          // not the small size form
  writeSize(w, height);
  w.write(3, 0);          // no aspect ratio shortcut
  writeSize(w, width);
  w.write(1, 0);          // metadata not all default
  const extra = orientation !== 1;
  w.write(1, extra ? 1 : 0);  // extra fields: only an orientation (the Exif value, as a JPEG carried it)
  if (extra) w.write(6, orientation - 1);  // orientation (3), no intrinsic size, preview or animation (1 each)
  w.write(4, 0b1_00_0);  // integer samples (1), 8 bits per sample (2), 16-bit buffers suffice (1)
  if (alpha) w.write(3, 0b1_01);  // one extra channel (2), all default (1): 8-bit alpha
  else w.write(2, 0);
  w.write(1, xyb ? 1 : 0);  // xyb_encoded
  if (colour === 3 && colorSpace === 'display-p3') {
    // Display P3, fields in reverse order as below: not default (1), no ICC (1), RGB (2), D65 (2), the P3 primaries
    // (selector 2 and 11 - 2 in 4), no gamma (1), the sRGB curve (selector 2 and 13 - 2 in 4), relative intent (2).
    w.write(21, 0b01_1011_10_0_1001_10_01_00_0_0);
  } else if (colour === 3) w.write(1, 1);  // colour encoding all default: sRGB
  else {
    // Fixed grey encoding. Groups below are the fields in reverse order because the writer sends the low bits
    // first: not default (1), no ICC (1), grey (2), D65 (2), no gamma (1), sRGB selector (2) and enum (4), intent (2).
    w.write(15, 0b01_1011_10_0_01_01_0_0);
  }
  if (extra) w.write(1, 1);  // default tone mapping
  w.write(2, 0);          // no extensions
  w.write(1, 1);          // default transform data
  w.zeroPadToByte();
}

// A modular frame, the last frame, no filters, one pass, groups of 128 << shift pixels (256 unless asked), replace
// blending.
export function writeModularFrameHeader(w, {alpha, shift = 1}) {
  // Fixed beginning, low bits first: not all default (1), regular frame (2), modular (1), default flags (2),
  // not YCbCr (1), no upsampling (2).
  w.write(9, 0b00_0_00_1_00_0);
  if (alpha) w.write(2, 0);  // no extra-channel upsampling
  w.write(2, shift);  // the group size shift
  writeFrameHeaderEnd(w, alpha);
}

// Both modular and VarDCT use one pass, replace blending, the last frame and no filters. Keep the tail shared:
// extra-channel blending is present only when alpha is, even though both branches carry the value zero.
export function writeFrameHeaderEnd(w, alpha) {
  w.write(alpha ? 7 : 5, 0);  // one pass (2), no custom size/origin (1), replace blending (2), replace alpha (2)
  // Last frame (1), no name (2), loop filter not default (1), no gaborish (1), no edge-preserving filter (2),
  // no filter extensions (2), no frame header extensions (2). Only the first field is nonzero.
  w.write(11, 1);
}

export function writeTOC(w, sizes) {
  w.write(1, 0);  // no permutation
  w.zeroPadToByte();
  for (const size of sizes) w.writeU32([[10, 0], [14, 1024], [22, 17408], [30, 4211712]], size);
  w.zeroPadToByte();
}

// The groups of a frame whose groups are `dim` pixels on a side, its DC groups eight times that.
export function groupLayout(width, height, dim = GROUP_DIM) {
  const groupsX = Math.ceil(width / dim), groupsY = Math.ceil(height / dim);
  const dcGroupsX = Math.ceil(width / (8 * dim)), dcGroupsY = Math.ceil(height / (8 * dim));
  return {groupsX, groupsY, dcGroupsX, dcGroupsY, single: groupsX === 1 && groupsY === 1};
}

// Group g's rectangle in the picture: [x0, y0, width, height].
export function groupRect(layout, width, height, g) {
  const x0 = g % layout.groupsX * GROUP_DIM, y0 = (g / layout.groupsX | 0) * GROUP_DIM;
  return [x0, y0, Math.min(GROUP_DIM, width - x0), Math.min(GROUP_DIM, height - y0)];
}

// A pass over a frame's groups. A group's work is a function of the pass's setup and the group's own pixels alone, so
// it runs here, one group a step (`run(g)`), or, when the request is `pooled`, in a pool of workers (pool.mjs): the
// pass is then one step, answered with every group's result for `accept(g, result)` in group order, or with null when a
// hurry ended it. `at(g)` is the fraction done once group g is, and `stop(g)` whether a hurry there ends the pass.
// Returns null when a hurry ended it, else whether its last step was hurried.
export function* groupPass(request, groups, run, accept) {
  if (request.pooled) {
    const reply = yield request;
    if (!reply) return null;
    reply.results.forEach((result, g) => accept(g, result));
    return reply.hurried;
  }
  let hurried = false;
  for (let g = 0; g < groups; g++) { run(g); hurried = yield request.at(g); if (hurried && request.stop(g)) return null; }
  return hurried;
}
// A group's counts added into the picture's, histogram by histogram.
export function addCounts(into, counts) { into.forEach((h, i) => { const c = counts[i]; for (let s = 0; s < h.length; s++) h[s] += c[s]; }); }

// finish() already zero-pads its returned copy. Empty sections need no writer, and completed writers are not
// mutated just to obtain the same bytes a second way.
export function finishSections(writers) { return writers.map(w => w ? w.finish() : new Uint8Array(0)); }

// Sections in the specification's order: DC global, the DC groups, AC global, the AC groups (one pass). A single
// group frame has one section holding everything. Every section ends on a byte.
export function assembleCodestream(header, sections) {
  const sizes = sections.map(section => section.length);
  writeTOC(header, sizes);
  const head = header.finish();
  const length = head.length + sizes.reduce((a, b) => a + b, 0);
  admitOutputSize(length);
  const out = new Uint8Array(length);
  out.set(head);
  let at = head.length;
  for (const section of sections) { out.set(section, at); at += section.length; }
  return out;
}
