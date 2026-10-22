// SPDX-License-Identifier: MIT
import {BitWriter} from './bits.mjs';
import {boxes, SIGNATURE, CODESTREAM, PARTIAL} from './container.mjs';
import {fault} from './admit.mjs';

const framingFault = message => fault('JXL_FRAMING', message);

const BIT_WEIGHTS = [1];
for (let i = 1; i <= 64; i++) BIT_WEIGHTS.push(BIT_WEIGHTS[i - 1] * 2);

class BitReader {
  constructor(bytes) { this.bytes = bytes; this.pos = 0; }
  read(count) {
    let value = 0;
    for (let i = 0; i < count; i++, this.pos++) {
      if (this.pos >> 3 >= this.bytes.length) throw framingFault('The codestream ends inside a header.');
      value += ((this.bytes[this.pos >> 3] >> (this.pos & 7)) & 1) * BIT_WEIGHTS[i];
    }
    return value;
  }
  bool() { return this.read(1) === 1; }
  u32(choices) { const [bits, offset] = choices[this.read(2)]; return offset + (bits ? this.read(bits) : 0); }
  u64() {
    const selector = this.read(2);
    if (selector < 3) return selector === 0 ? 0 : selector === 1 ? 1 + this.read(4) : 17 + this.read(8);
    let value = this.read(12), shift = 12;
    while (this.bool()) {
      if (shift === 60) { value += this.read(4) * BIT_WEIGHTS[shift]; break; }
      value += this.read(8) * BIT_WEIGHTS[shift]; shift += 8;
    }
    return value;
  }
  enumeration() { return this.u32(ENUM); }
  padToByte() { this.pos = (this.pos + 7) & ~7; }
}

const ENUM = [[0, 0], [0, 1], [4, 2], [6, 18]];
const SIZE = [[9, 1], [13, 1], [18, 1], [30, 1]];
const FRAME_SIZE = [[8, 0], [11, 256], [14, 2304], [30, 18688]];
const NAME = [[0, 0], [4, 0], [5, 16], [10, 48]];
const BLEND_MODE = [[0, 0], [0, 1], [0, 2], [2, 3]];
const SOURCE = [[0, 0], [0, 1], [0, 2], [0, 3]];
const ALPHA_CHANNEL = [[0, 0], [0, 1], [0, 2], [3, 3]];
const DURATION = [[0, 0], [0, 1], [8, 0], [32, 0]];
const TPS_NUMERATOR = [[0, 100], [0, 1000], [10, 1], [30, 1]];
const TPS_DENOMINATOR = [[0, 1], [0, 1001], [8, 1], [10, 1]];
const LOOPS = [[0, 0], [3, 0], [16, 0], [32, 0]];
const UPSAMPLING = [[0, 1], [0, 2], [0, 4], [0, 8]];
const NUM_PASSES = [[0, 1], [0, 2], [0, 3], [3, 4]];
const NUM_DOWNSAMPLE = [[0, 0], [0, 1], [0, 2], [1, 3]];
const LAST_PASS = [[0, 0], [0, 1], [0, 2], [3, 0]];
const DC_LEVEL = [[0, 1], [0, 2], [0, 3], [0, 4]];
const TOC_ENTRY = [[10, 0], [14, 1024], [22, 17408], [30, 4211712]];
const REPLACE = 0, BLEND = 2, REGULAR = 0, DC_FRAME = 1, REFERENCE_ONLY = 2, SKIP_PROGRESSIVE = 3;
export const BLEND_MODES = Object.freeze({replace: REPLACE, blend: BLEND});

function readSizeHeader(r) {
  const small = r.bool();
  const height = small ? (r.read(5) + 1) * 8 : r.u32(SIZE);
  const ratio = r.read(3);
  const ratios = [null, [1, 1], [12, 10], [4, 3], [3, 2], [16, 9], [5, 4], [2, 1]];
  const width = ratio ? Math.floor(height * ratios[ratio][0] / ratios[ratio][1]) : small ? (r.read(5) + 1) * 8 : r.u32(SIZE);
  return {width, height};
}

function readBitDepth(r) {
  const float = r.bool();
  if (!float) return {float, bits: r.u32([[0, 8], [0, 10], [0, 12], [6, 1]])};
  return {float, bits: r.u32([[0, 32], [0, 16], [0, 24], [6, 1]]), exponent: r.read(4) + 1};
}

function readCustomXY(r) { for (let i = 0; i < 2; i++) r.u32([[19, 0], [19, 524288], [20, 1048576], [21, 2097152]]); }

export function readImageHeader(bytes, {iccBits} = {}) {
  const r = new BitReader(bytes);
  if (r.read(16) !== 0x0AFF) throw framingFault('Not a JPEG XL codestream.');
  const {width, height} = readSizeHeader(r);
  const header = {width, height, metadataAt: r.pos, orientation: 1};
  if (r.bool()) throw framingFault('Default image metadata is not produced by this encoder.');
  header.extraAt = r.pos;
  header.extra = r.bool();
  if (header.extra) {
    header.orientation = r.read(3) + 1;
    if (r.bool()) header.intrinsicSize = readSizeHeader(r);
    header.previewAt = r.pos;
    if (r.bool()) {
      const small = r.bool(), size = small ? [[0, 16], [0, 32], [5, 1], [9, 33]] : [[6, 1], [8, 65], [10, 321], [12, 1345]];
      const height = r.u32(size) * (small ? 8 : 1), ratio = r.read(3);
      const ratios = [null, [1, 1], [12, 10], [4, 3], [3, 2], [16, 9], [5, 4], [2, 1]];
      const width = ratio ? Math.floor(height * ratios[ratio][0] / ratios[ratio][1]) : r.u32(size) * (small ? 8 : 1);
      header.preview = {width, height};
    }
    header.animationAt = r.pos;
    if (r.bool()) header.animation = {numerator: r.u32(TPS_NUMERATOR), denominator: r.u32(TPS_DENOMINATOR), loops: r.u32(LOOPS), timecodes: r.bool()};
  }
  header.depthAt = r.pos;
  header.depth = readBitDepth(r);
  header.modular16At = r.pos;
  header.modular16 = r.bool();
  header.extraChannels = r.u32([[0, 0], [0, 1], [4, 2], [12, 1]]);
  header.alpha = false; header.channelInfo = [];
  for (let i = 0; i < header.extraChannels; i++) {
    if (r.bool()) { header.alpha ||= i === 0; header.channelInfo.push({kind: 0, associated: false, bitDepth: 8, exponentBits: 0, dimShift: 0, name: []}); continue; }
    const type = r.enumeration();
    if (i === 0 && type === 0) header.alpha = true;
    const depth = readBitDepth(r), dimShift = r.u32([[0, 0], [0, 3], [0, 4], [3, 1]]);
    const name = Array.from({length: r.u32(NAME)}, () => r.read(8));
    const associated = type === 0 ? r.bool() : false;
    const info = {kind: type, associated, bitDepth: depth.bits, exponentBits: depth.exponent ?? 0, dimShift, name};
    if (type === 2) info.spot = Array.from({length: 4}, () => r.read(16));
    else if (type === 5) info.cfa = r.u32([[0, 1], [2, 0], [4, 3], [8, 19]]);
    header.channelInfo.push(info);
  }
  header.xyb = r.bool(); header.colorAt = r.pos;
  header.defaultColor = true;
  if (!r.bool()) {
    header.icc = r.bool();
    const space = r.enumeration();
    header.colorChannels = space === 1 ? 1 : 3;
    header.defaultColor = !header.icc && space === 0;
    if (!header.icc) {
      if (space !== 2) { const white = r.enumeration(); header.defaultColor &&= white === 1; if (white === 2) readCustomXY(r); }
      if (space !== 1 && space !== 2) { const primaries = r.enumeration(); header.defaultColor &&= primaries === 1; if (primaries === 2) for (let i = 0; i < 3; i++) readCustomXY(r); }
      if (space !== 2) { if (r.bool()) { r.read(24); header.defaultColor = false; } else { const transfer = r.enumeration(); header.defaultColor &&= transfer === 13; } }
      const intent = r.enumeration(); header.defaultColor &&= intent === 1;
    }
  } else header.colorChannels = 3;
  header.toneAt = r.pos;
  if (header.extra && !r.bool()) r.read(16 + 16 + 1 + 16);
  header.extensionsAt = r.pos;
  if (r.u64()) throw framingFault('Image metadata extensions are not produced by this encoder.');
  header.transformAt = r.pos;
  if (!r.bool()) {
    if (header.xyb && !r.bool()) r.read(16 * 16);
    const mask = r.read(3);
    for (const [bit, count] of [[1, 15], [2, 55], [4, 210]]) if (mask & bit) r.read(16 * count);
  }
  header.iccAt = r.pos;
  if (header.icc) {
    if (typeof iccBits === 'function') iccBits = iccBits(bytes, r.pos);
    if (!Number.isSafeInteger(iccBits) || iccBits < 1 || r.pos + iccBits > bytes.length * 8)
      throw framingFault('Framing an ICC image requires the prepared profile bit length.');
    r.pos += iccBits;
  }
  header.payloadEnd = r.pos;
  r.padToByte();
  header.end = r.pos >> 3;
  return header;
}

function readFrame(r, image, animation, tocPermutation) {
  const frame = {start: r.pos >> 3};
  if (r.bool()) throw framingFault('A default frame header is not produced by this encoder.');
  frame.type = r.read(2);
  frame.modular = r.read(1) === 1;
  frame.flagsAt = r.pos; frame.flags = r.u64(); frame.flagsEnd = r.pos;
  frame.ycbcr = !image.xyb && r.bool();
  frame.upsampling = 1; frame.extraUpsampling = [];
  if (!(frame.flags & 32)) {
    if (frame.ycbcr) r.read(6);
    frame.upsampling = r.u32(UPSAMPLING);
    for (let i = 0; i < image.extraChannels; i++) frame.extraUpsampling.push(r.u32(UPSAMPLING));
  }
  frame.shift = frame.modular ? r.read(2) : 1;
  if (image.xyb && !frame.modular) r.read(6);
  frame.passesAt = r.pos;
  frame.passes = 1; frame.passShifts = [0]; frame.downsample = []; frame.lastPass = [];
  if (frame.type !== REFERENCE_ONLY) {
    frame.passes = r.u32(NUM_PASSES);
    if (frame.passes > 1) {
      const count = r.u32(NUM_DOWNSAMPLE);
      if (count > frame.passes) throw framingFault('More progressive milestones than passes.');
      frame.passShifts = Array.from({length: frame.passes - 1}, () => r.read(2)); frame.passShifts.push(0);
      frame.downsample = Array.from({length: count}, () => r.u32(UPSAMPLING));
      frame.lastPass = Array.from({length: count}, () => r.u32(LAST_PASS));
      for (let i = 0; i < count; i++) if (frame.lastPass[i] >= frame.passes || i &&
          (frame.lastPass[i] <= frame.lastPass[i - 1] || frame.downsample[i] >= frame.downsample[i - 1]))
        throw framingFault('Invalid progressive milestone order.');
    }
  }
  frame.dcLevel = frame.type === DC_FRAME ? r.u32(DC_LEVEL) : 0;
  frame.fieldsAt = r.pos;
  const factor = BIT_WEIGHTS[3 * frame.dcLevel];
  frame.width = Math.ceil(image.width / factor); frame.height = Math.ceil(image.height / factor); frame.x0 = 0; frame.y0 = 0;
  if (frame.type !== DC_FRAME && r.bool()) {
    if (frame.type === REGULAR || frame.type === SKIP_PROGRESSIVE) {
      const unpack = v => v & 1 ? -(v + 1) / 2 : v / 2;
      frame.x0 = unpack(r.u32(FRAME_SIZE)); frame.y0 = unpack(r.u32(FRAME_SIZE));
    }
    frame.width = r.u32(FRAME_SIZE); frame.height = r.u32(FRAME_SIZE);
  }
  const full = frame.x0 <= 0 && frame.y0 <= 0 && frame.x0 + frame.width >= image.width && frame.y0 + frame.height >= image.height;
  frame.mode = REPLACE; frame.duration = 0; frame.blending = [];
  if (frame.type === REGULAR || frame.type === SKIP_PROGRESSIVE) {
    for (let c = 0; c <= image.extraChannels; c++) {
      const mode = r.u32(BLEND_MODE), blend = {mode, alpha: 0, clamp: false, source: 0};
      if (!c) frame.mode = mode;
      if (image.extraChannels && (mode === BLEND || mode === 3)) blend.alpha = r.u32(ALPHA_CHANNEL);
      if (image.extraChannels && (mode === BLEND || mode === 3) || mode === 4) blend.clamp = r.bool();
      if (mode !== REPLACE || !full) blend.source = r.u32(SOURCE);
      frame.blending.push(blend);
    }
    if (animation) { frame.duration = r.u32(DURATION); if (animation.timecodes) r.read(32); }
  }
  frame.last = (frame.type === REGULAR || frame.type === SKIP_PROGRESSIVE) && r.bool();
  frame.reference = 0;
  if (frame.type !== DC_FRAME && !frame.last) frame.reference = r.read(2);
  if (frame.type === REFERENCE_ONLY || (frame.type !== DC_FRAME && full && frame.mode === REPLACE && !frame.last && (frame.duration === 0 || frame.reference !== 0))) frame.beforeColorTransform = r.bool();
  frame.nameAt = r.pos;
  r.read(8 * r.u32(NAME)); frame.filterAt = r.pos;
  if (!r.bool()) {
    if (r.bool() && r.bool()) r.read(6 * 16);
    const epf = r.read(2);
    if (epf) {
      if (!frame.modular && r.bool()) r.read(8 * 16);
      if (r.bool()) r.read(5 * 16);
      if (r.bool()) r.read(frame.modular ? 3 * 16 : 4 * 16);
      if (frame.modular) r.read(16);
    }
    if (r.u64()) throw framingFault('Filter extensions are not produced by this encoder.');
  }
  if (r.u64()) throw framingFault('Frame header extensions are not produced by this encoder.');
  frame.tocAt = r.pos;
  const dim = 128 << frame.shift;
  const codedWidth = Math.ceil(frame.width / frame.upsampling), codedHeight = Math.ceil(frame.height / frame.upsampling);
  const groups = Math.ceil(codedWidth / dim) * Math.ceil(codedHeight / dim);
  const dcGroups = Math.ceil(codedWidth / (8 * dim)) * Math.ceil(codedHeight / (8 * dim));
  const count = groups === 1 && frame.passes === 1 ? 1 : 2 + dcGroups + groups * frame.passes;
  let permutation;
  if (r.bool()) {
    if (typeof tocPermutation !== 'function') throw framingFault('A permuted table of contents requires its optional delivery reader.');
    if (count > 65536) throw framingFault('A table of contents has at most 65536 sections.');
    permutation = tocPermutation(r, count);
    if (!Array.isArray(permutation) || permutation.length !== count) throw framingFault('Invalid table-of-contents permutation length.');
    const seen = new Uint8Array(count);
    for (const value of permutation) {
      if (!Number.isInteger(value) || value < 0 || value >= count || seen[value]) throw framingFault('Invalid table-of-contents permutation.');
      seen[value] = 1;
    }
  }
  r.padToByte();
  frame.sizes = Array.from({length: count}, () => r.u32(TOC_ENTRY));
  r.padToByte();
  frame.sectionsAt = r.pos >> 3;
  frame.end = frame.sectionsAt + frame.sizes.reduce((a, b) => a + b, 0);
  if (frame.end > r.bytes.length) throw framingFault('The codestream ends inside a frame.');
  if (permutation) {
    frame.physicalSizes = frame.sizes; frame.permutation = permutation;
    const offsets = []; let offset = frame.sectionsAt;
    for (const size of frame.physicalSizes) { offsets.push(offset); offset += size; }
    frame.sizes = permutation.map(index => frame.physicalSizes[index]);
    frame.sectionOffsets = permutation.map(index => offsets[index]);
  }
  r.pos = frame.end * 8;
  return frame;
}

export function codestreamOf(bytes) {
  if (bytes[0] === 0xFF && bytes[1] === 0x0A) return {codestream: bytes, level: 5};
  if (!SIGNATURE.every((byte, i) => bytes[i] === byte)) throw framingFault('Not a JPEG XL file.');
  const parts = [];
  let level = 5;
  for (const box of boxes(bytes)) {
    if (box.type === 0x6a786c6c) level = bytes[box.body];
    if (box.type === CODESTREAM || box.type === PARTIAL) parts.push(bytes.subarray(box.body + (box.type === PARTIAL ? 4 : 0), box.end));
  }
  if (parts.length === 1) return {codestream: parts[0], level};
  const codestream = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) { codestream.set(part, at); at += part.length; }
  return {codestream, level};
}

export function readFrames(bytes, options) {
  const {codestream, level} = codestreamOf(bytes);
  const image = readImageHeader(codestream, options);
  const r = new BitReader(codestream);
  r.pos = image.end * 8;
  const preview = image.preview ? readFrame(r, {...image, ...image.preview}, undefined, options?.tocPermutation) : undefined;
  const frames = [];
  do frames.push(readFrame(r, image, image.animation, options?.tocPermutation)); while (!frames.at(-1).last && r.pos < codestream.length * 8);
  if (!frames.at(-1).last) throw framingFault('The codestream has no last frame.');
  if (r.pos !== codestream.length * 8) throw framingFault('Bytes follow the last frame.');
  return {codestream, level, image, preview, frames};
}

export function readStill(bytes, options) {
  const still = readFrames(bytes, options);
  if (still.image.animation) throw framingFault('The frame is already animated.');
  return still;
}

export function copyBits(w, bytes, from, to) {
  let at = from;
  while (at < to && (at & 7)) { w.write(1, (bytes[at >> 3] >> (at & 7)) & 1); at++; }
  while (at + 8 <= to) { w.write(8, bytes[at >> 3]); at += 8; }
  while (at < to) { w.write(1, (bytes[at >> 3] >> (at & 7)) & 1); at++; }
}

export function writeStillImageHeader(w, still, {width, height, modular16 = still.image.modular16}) {
  w.write(16, 0x0AFF); w.write(1, 0); w.writeU32(SIZE, height); w.write(3, 0); w.writeU32(SIZE, width);
  copyBits(w, still.codestream, still.image.metadataAt, still.image.modular16At);
  w.write(1, modular16 ? 1 : 0);
  copyBits(w, still.codestream, still.image.modular16At + 1, still.image.payloadEnd);
  w.zeroPadToByte();
}

export function writeStillFrame(w, still, frame, placement) {
  const bytes = still.codestream, image = placement.canvas;
  const type = placement.frameType ?? frame.type;
  if (frame.type === DC_FRAME || type === DC_FRAME) throw framingFault('DC frames use their pyramid header.');
  if (type !== REGULAR && type !== REFERENCE_ONLY && type !== SKIP_PROGRESSIVE) throw framingFault('Unknown frame type.');
  if (type === REFERENCE_ONLY && frame.passes !== 1) throw framingFault('A reference-only frame has one pass.');
  w.write(1, 0); w.write(2, type);
  if (placement.patchDictionary) {
    if (!Number.isInteger(frame.flags) || frame.flags < 0 || frame.flags > 4095) throw framingFault('Unsupported frame flags.');
    if (frame.flags & 2) throw framingFault('A frame already has its own patch dictionary.');
    copyBits(w, bytes, frame.start * 8 + 3, frame.flagsAt);
    writeFrameFlags(w, frame.flags | 2);
    copyBits(w, bytes, frame.flagsEnd, frame.passesAt);
  } else copyBits(w, bytes, frame.start * 8 + 3, frame.passesAt);
  if (type !== REFERENCE_ONLY) {
    if (frame.type === REFERENCE_ONLY) w.writeU32(NUM_PASSES, 1);
    else copyBits(w, bytes, frame.passesAt, frame.fieldsAt);
  }
  const {x0 = 0, y0 = 0, last = true, reference = 0, source = 0, mode = REPLACE, alpha = 0, clamp = false} = placement;
  if (type === REFERENCE_ONLY && (x0 || y0)) throw framingFault('A reference-only frame has no origin.');
  const same = !x0 && !y0 && frame.width === image.width && frame.height === image.height;
  const full = x0 <= 0 && y0 <= 0 && x0 + frame.width >= image.width && y0 + frame.height >= image.height;
  w.write(1, same ? 0 : 1);
  if (!same) {
    if (type !== REFERENCE_ONLY) {
      const pack = v => v < 0 ? -2 * v - 1 : 2 * v;
      w.writeU32(FRAME_SIZE, pack(x0)); w.writeU32(FRAME_SIZE, pack(y0));
    }
    w.writeU32(FRAME_SIZE, frame.width); w.writeU32(FRAME_SIZE, frame.height);
  }
  if (type !== REFERENCE_ONLY) {
    for (let c = 0; c <= image.extraChannels; c++) {
      const blend = c ? placement.extraBlending?.[c - 1] ?? {mode, source, alpha, clamp} : {mode, source, alpha, clamp};
      w.writeU32(BLEND_MODE, blend.mode);
      if (image.extraChannels && (blend.mode === BLEND || blend.mode === 3)) w.writeU32(ALPHA_CHANNEL, blend.alpha ?? 0);
      if (image.extraChannels && (blend.mode === BLEND || blend.mode === 3) || blend.mode === 4) w.write(1, blend.clamp ? 1 : 0);
      if (blend.mode !== REPLACE || !full) w.writeU32(SOURCE, blend.source ?? 0);
    }
    w.write(1, last ? 1 : 0);
  }
  if (type === REFERENCE_ONLY || !last) w.writeU32(SOURCE, reference);
  if (type === REFERENCE_ONLY || !last && full && mode === REPLACE) w.write(1, placement.beforeColorTransform ? 1 : 0);
  if (placement.name === undefined) copyBits(w, bytes, frame.nameAt, frame.filterAt);
  else {
    const name = new TextEncoder().encode(placement.name);
    if (name.length > 1071) throw framingFault('A frame name has at most 1071 UTF-8 bytes.');
    w.writeU32(NAME, name.length); for (const value of name) w.write(8, value);
  }
  copyBits(w, bytes, frame.filterAt, frame.tocAt);
  const sections = []; let at = frame.sectionsAt;
  for (let i = 0; i < frame.sizes.length; i++) {
    const start = frame.sectionOffsets?.[i] ?? at, size = frame.sizes[i];
    sections.push(bytes.subarray(start, start + size)); at += size;
  }
  if (placement.patchDictionary) {
    const first = new BitWriter(Math.ceil(placement.patchDictionary.bitLength / 8) + sections[0].length + 16);
    first.append(placement.patchDictionary);
    first.append({bytes: sections[0], at: sections[0].length, pending: 0, acc: 0});
    sections[0] = first.finish();
  }
  w.write(1, 0); w.zeroPadToByte();
  for (const section of sections) w.writeU32(TOC_ENTRY, section.length);
  w.zeroPadToByte();
  for (const section of sections) w.append({bytes: section, at: section.length, pending: 0, acc: 0});
}

function writeFrameFlags(w, flags) {
  if (!Number.isInteger(flags) || flags < 0 || flags > 4095) throw framingFault('Unsupported frame flags.');
  if (!flags) w.write(2, 0);
  else if (flags <= 16) { w.write(2, 1); w.write(4, flags - 1); }
  else if (flags <= 272) { w.write(2, 2); w.write(8, flags - 17); }
  else { w.write(2, 3); w.write(12, flags); w.write(1, 0); }
}

export function writeLFFrameHeader(w, {level = 1, shift = 3, extraChannels = 0, xyb = true, ycbcr = false, modular = true, flags = 0, passes} = {}) {
  if (!Number.isInteger(level) || level < 1 || level > 4 || !Number.isInteger(shift) || shift < 0 || shift > 3 ||
      !Number.isInteger(extraChannels) || extraChannels < 0 || extraChannels > 256 || !Number.isInteger(flags) || flags < 0 || flags > 4095)
    throw framingFault('Invalid low-frequency frame header.');
  w.write(1, 0); w.write(2, DC_FRAME); w.write(1, modular ? 1 : 0);
  writeFrameFlags(w, flags);
  if (!xyb) w.write(1, ycbcr ? 1 : 0);
  if (!xyb && ycbcr && !(flags & 32)) w.write(6, 0);
  if (!(flags & 32)) { w.writeU32(UPSAMPLING, 1); for (let i = 0; i < extraChannels; i++) w.writeU32(UPSAMPLING, 1); }
  if (modular) w.write(2, shift);
  else if (xyb) { w.write(3, 2); w.write(3, 2); }
  if (passes) w.append(passes); else w.writeU32(NUM_PASSES, 1);
  w.writeU32(DC_LEVEL, level);
  w.write(10, 0);
}

export function writeAnimatedImageHeader(w, still, {width, height, numerator, denominator, loops}, modular16) {
  const bytes = still.codestream, image = still.image;
  w.write(16, 0x0AFF);
  w.write(1, 0);
  w.writeU32(SIZE, height);
  w.write(3, 0);
  w.writeU32(SIZE, width);
  copyBits(w, bytes, image.metadataAt, image.extraAt);
  w.write(1, 1);
  if (image.extra) copyBits(w, bytes, image.extraAt + 1, image.animationAt);
  else w.write(5, 0);
  w.write(1, 1);
  w.writeU32(TPS_NUMERATOR, numerator);
  w.writeU32(TPS_DENOMINATOR, denominator);
  w.writeU32(LOOPS, loops);
  w.write(1, 0);
  copyBits(w, bytes, image.depthAt, image.modular16At);
  w.write(1, modular16 ? 1 : 0);
  copyBits(w, bytes, image.modular16At + 1, image.toneAt);
  if (!image.extra) w.write(1, 1);
  copyBits(w, bytes, image.toneAt, image.extensionsAt);
  w.write(2, 0);
  w.write(1, 1);
  w.zeroPadToByte();
}

export function writeAnimatedFrame(w, still, frame, placement) {
  const bytes = still.codestream, image = placement.canvas;
  copyBits(w, bytes, frame.start * 8, frame.fieldsAt);
  if (frame.type === REFERENCE_ONLY) {
    if (placement.reference === frame.reference) throw framingFault('A reference frame would overwrite the animation canvas.');
    copyBits(w, bytes, frame.fieldsAt, frame.end * 8);
    return;
  }
  const {x0 = 0, y0 = 0, duration, last, reference, source, mode = REPLACE} = placement;
  const full = x0 === 0 && y0 === 0 && frame.width === image.width && frame.height === image.height;
  w.write(1, full ? 0 : 1);
  if (!full) {
    const pack = v => v < 0 ? -2 * v - 1 : 2 * v;
    w.writeU32(FRAME_SIZE, pack(x0)); w.writeU32(FRAME_SIZE, pack(y0));
    w.writeU32(FRAME_SIZE, frame.width); w.writeU32(FRAME_SIZE, frame.height);
  }
  for (let c = 0; c <= image.extraChannels; c++) {
    const channelMode = c ? REPLACE : mode, blend = mode === BLEND;
    w.writeU32(BLEND_MODE, blend ? BLEND : channelMode);
    if (blend && image.extraChannels) w.writeU32(ALPHA_CHANNEL, 0);
    if (blend) w.write(1, 0);
    if (blend || !full) w.writeU32(SOURCE, source);
  }
  w.writeU32(DURATION, duration);
  w.write(1, last ? 1 : 0);
  if (!last) w.write(2, reference);
  if (full && mode === REPLACE && !last && (duration === 0 || reference !== 0)) w.write(1, 0);
  copyBits(w, bytes, frame.nameAt, frame.tocAt);
  w.write(1, 0);
  w.zeroPadToByte();
  for (const size of frame.sizes) w.writeU32(TOC_ENTRY, size);
  w.zeroPadToByte();
  w.append({bytes: bytes.subarray(frame.sectionsAt, frame.end), at: frame.end - frame.sectionsAt, pending: 0, acc: 0});
}

export function metadataKey(still) {
  const {codestream: bytes, image} = still, w = new BitWriter(64);
  copyBits(w, bytes, image.metadataAt, image.modular16At);
  copyBits(w, bytes, image.modular16At + 1, image.extensionsAt);
  return w.bitLength + ':' + w.finish().join(',');
}

export function compositionMetadataKey(still) {
  const w = new BitWriter(128), {image, codestream} = still;
  if (image.defaultColor) w.write(1, 1); else copyBits(w, codestream, image.colorAt, image.toneAt);
  const defaultTone = !image.extra || !!(codestream[image.toneAt >> 3] >> (image.toneAt & 7) & 1);
  w.write(1, defaultTone ? 1 : 0);
  if (!defaultTone) copyBits(w, codestream, image.toneAt + 1, image.extensionsAt);
  copyBits(w, codestream, image.extensionsAt, image.payloadEnd);
  return JSON.stringify([image.orientation, image.depth, image.channelInfo, image.xyb]) + ':' + w.bitLength + ':' + w.finish().join(',');
}
