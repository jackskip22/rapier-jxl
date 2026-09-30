// Rapier's JPEG XL encoder: the codestream around a frame. MIT (LICENSE).
// A bare codestream (no container): signature, size header, image metadata, one frame with its table of contents.
import {BitWriter} from './bits.mjs';

export const GROUP_DIM = 256, DC_GROUP_DIM = 2048;

function writeSize(w, size) {
  if (size <= 1 << 9) { w.write(2, 0); w.write(9, size - 1); }
  else if (size <= 1 << 13) { w.write(2, 1); w.write(13, size - 1); }
  else if (size <= 1 << 18) { w.write(2, 2); w.write(18, size - 1); }
  else { w.write(2, 3); w.write(30, size - 1); }
}

// 8 bits per sample; `colour` 1 (grey) or 3 (sRGB); an 8-bit alpha channel when `alpha`. Frames start byte-aligned.
export function writeImageHeader(w, width, height, colour, alpha, {xyb = false, orientation = 1} = {}) {
  w.write(16, 0x0AFF);
  w.write(1, 0);          // not the small size form
  writeSize(w, height);
  w.write(3, 0);          // no aspect ratio shortcut
  writeSize(w, width);
  w.write(1, 0);          // metadata not all default
  const extra = orientation !== 1;
  w.write(1, extra ? 1 : 0);  // extra fields: only an orientation (the Exif value, as a JPEG carried it)
  if (extra) { w.write(3, orientation - 1); w.write(1, 0); w.write(1, 0); w.write(1, 0); }  // no intrinsic size, preview or animation
  w.write(1, 0);          // integer samples
  w.write(2, 0);          // 8 bits per sample
  w.write(1, 1);          // 16-bit buffers suffice
  if (alpha) { w.write(2, 1); w.write(1, 1); }  // one extra channel, all default: 8-bit alpha
  else w.write(2, 0);
  w.write(1, xyb ? 1 : 0);  // xyb_encoded
  if (colour === 3) w.write(1, 1);  // colour encoding all default: sRGB
  else {
    w.write(1, 0); w.write(1, 0);   // not default, no ICC
    w.write(2, 1);                  // grey
    w.write(2, 1);                  // D65
    w.write(1, 0);                  // no gamma
    w.write(2, 2); w.write(4, 11);  // transfer function: sRGB
    w.write(2, 1);                  // relative rendering intent
  }
  if (extra) w.write(1, 1);  // default tone mapping
  w.write(2, 0);          // no extensions
  w.write(1, 1);          // default transform data
  w.zeroPadToByte();
}

// A lossless modular frame, the last frame, no filters, one pass, 256-pixel groups, replace blending.
export function writeModularFrameHeader(w, {alpha}) {
  w.write(1, 0);  // not all default
  w.write(2, 0);  // regular frame
  w.write(1, 1);  // modular
  w.write(2, 0);  // default flags
  w.write(1, 0);  // not YCbCr
  w.write(2, 0);  // no upsampling
  if (alpha) w.write(2, 0);  // no extra-channel upsampling
  w.write(2, 1);  // group size shift 1: 256
  w.write(2, 0);  // one pass
  w.write(1, 0);  // no custom size or origin
  w.write(2, 0);  // replace blending
  if (alpha) w.write(2, 0);  // replace for the extra channel
  w.write(1, 1);  // the last frame
  w.write(2, 0);  // no name
  w.write(1, 0);  // loop filter not default:
  w.write(1, 0);  //   no gaborish
  w.write(2, 0);  //   no edge-preserving filter
  w.write(2, 0);  //   no filter extensions
  w.write(2, 0);  // no frame header extensions
}

const TOC_OFFSET = [0, 1024, 17408, 4211712], TOC_BITS = [12, 16, 24, 32];

export function writeTOC(w, sizes) {
  w.write(1, 0);  // no permutation
  w.zeroPadToByte();
  for (const size of sizes) {
    let bucket = 0;
    while (bucket < 3 && size >= TOC_OFFSET[bucket + 1]) bucket++;
    w.write(2, bucket);
    w.write(TOC_BITS[bucket] - 2, size - TOC_OFFSET[bucket]);
  }
  w.zeroPadToByte();
}

export function groupLayout(width, height) {
  const groupsX = Math.ceil(width / GROUP_DIM), groupsY = Math.ceil(height / GROUP_DIM);
  const dcGroupsX = Math.ceil(width / DC_GROUP_DIM), dcGroupsY = Math.ceil(height / DC_GROUP_DIM);
  return {groupsX, groupsY, dcGroupsX, dcGroupsY, single: groupsX === 1 && groupsY === 1};
}

// Sections in the specification's order: DC global, the DC groups, AC global, the AC groups (one pass). A single
// group frame has one section holding everything. Every section ends on a byte.
export function assembleCodestream(header, sections) {
  const sizes = sections.map(section => section.length);
  writeTOC(header, sizes);
  const head = header.finish();
  const out = new Uint8Array(head.length + sizes.reduce((a, b) => a + b, 0));
  out.set(head);
  let at = head.length;
  for (const section of sections) { out.set(section, at); at += section.length; }
  return out;
}
