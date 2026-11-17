// SPDX-License-Identifier: MIT
import {fault, admitOutputSize} from './admit.mjs';
import {journaling, journalJoin, journalTool, sliceBytes} from './step-journal.mjs';

export const SIGNATURE = new Uint8Array([0, 0, 0, 12, 74, 88, 76, 32, 13, 10, 135, 10]);
export const FTYP = 0x66747970, BRAND = 0x6a786c20, CODESTREAM = 0x6a786c63, PARTIAL = 0x6a786c70;
export const EXIF = 0x45786966, XML = 0x786d6c20, BROB = 0x62726f62, RECONSTRUCTION = 0x6a627264;
export const JUMBF = 0x6a756d62, LEVEL = 0x6a786c6c;
const invalidBox = message => fault('JXL_INPUT', message);
const MAX_RECONSTRUCTION_BOXES = 65536;

export function boxHeader(type, length, wide = false) {
  if (!Number.isSafeInteger(length) || length < 0 || !Number.isInteger(type) || type < 0 || type > 0xffffffff)
    throw invalidBox('box: 4-byte type and safe length');
  const size = length + (wide || length > 0xffffffff - 8 ? 16 : 8);
  if (!Number.isSafeInteger(size)) throw invalidBox('box length: too large');
  const out = new Uint8Array(wide || size > 0xffffffff ? 16 : 8), view = new DataView(out.buffer);
  view.setUint32(0, out.length === 16 ? 1 : size); view.setUint32(4, type);
  if (out.length === 16) { view.setUint32(8, Math.floor(size / 4294967296)); view.setUint32(12, size % 4294967296); }
  return out;
}

export function fileHeader(level = 5) {
  if (level !== 5 && level !== 10) throw invalidBox('level: 5 or 10');
  const out = new Uint8Array(level === 10 ? 41 : 32), view = new DataView(out.buffer);
  out.set(SIGNATURE); view.setUint32(12, 20); view.setUint32(16, FTYP); view.setUint32(20, BRAND); view.setUint32(28, BRAND);
  if (level === 10) { view.setUint32(32, 9); view.setUint32(36, LEVEL); out[40] = 10; }
  return out;
}

export function boxWords(bytes) {
  let start = -1, data, view;
  const ready = (at, n) => {
    if (!data || at < start || at + n > start + data.length) {
      start = at; data = bytes.subarray(at, Math.min(bytes.length, at + 65536));
      view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    }
  };
  return {u32(at) { ready(at, 4); return view.getUint32(at - start); }, u8(at) { ready(at, 1); return data[at - start]; }};
}
function admitBoxes(bytes, maxBoxes) {
  if (!(bytes instanceof Uint8Array)) throw invalidBox('container: Uint8Array');
  if (!Number.isSafeInteger(maxBoxes) || maxBoxes < 1) throw invalidBox('maxBoxes: positive integer');
}
export const boxCursor = () => ({at: SIGNATURE.length, first: true, next: 0, complete: false, stream: 0, minorVersion: 0, level: 5,
  lastIndex: -1, count: 0, levelSeen: false, indexBoxes: 0, gainBoxes: 0, prefixes: new Map()});
export function nextBox(bytes, maxBoxes, state, words) {
  const at = state.at;
  if (state.count >= maxBoxes) throw invalidBox('boxes: over maxBoxes');
  if (bytes.length - at < 8) throw invalidBox('box header: incomplete');
  const short = words.u32(at); let length = short, body = at + 8;
  const type = words.u32(at + 4);
  if (length === 1) {
    if (bytes.length - at < 16) throw invalidBox('extended box header: incomplete');
    length = words.u32(at + 8) * 4294967296 + words.u32(at + 12); body += 8;
  } else if (!length) length = bytes.length - at;
  if (!Number.isSafeInteger(length) || length < body - at || length > bytes.length - at) throw invalidBox('box size');
  const end = at + length;
  if (state.first) {
    if (type !== FTYP || end - body < 12 || (end - body) % 4 || words.u32(body) !== BRAND)
      throw invalidBox('second box: jxl file type');
    if (words.u32(body + 4) > 1) throw invalidBox('minorVersion: 0 or 1');
    let compatible = false, p = state.brandAt ?? body + 8;
    const stop = Math.min(end, p + 65536);
    for (; p < stop; p += 4) if (words.u32(p) === BRAND) { compatible = true; break; }
    if (!compatible && p < end) { state.brandAt = p; return null; }
    if (!compatible) throw invalidBox('file type: jxl brand required');
    delete state.brandAt;
    state.minorVersion = words.u32(body + 4); state.first = false;
  } else if (type === FTYP || type === 0x4a584c20) throw invalidBox('file header: duplicate');
  if (type === LEVEL) {
    if (state.count !== 1 || state.levelSeen || end - body !== 1 || words.u8(body) !== 5 && words.u8(body) !== 10)
      throw invalidBox('level box: 5 or 10 after file type');
    state.levelSeen = true; state.level = words.u8(body);
  }
  let decoded = type, sequence, last;
  if (type === BROB) {
    if (end - body < 4) throw invalidBox('brob box: incomplete');
    decoded = words.u32(body);
    if (decoded === BROB || decoded === RECONSTRUCTION || decoded >>> 8 === 0x6a786c)
      throw invalidBox('Brotli box: not codestream/index/reconstruction/Brotli');
  }
  if (decoded === 0x6a786c69 && ++state.indexBoxes > 1 || decoded === 0x6a68676d && ++state.gainBoxes > 1)
    throw invalidBox('duplicate jxli or jhgm');
  if (type === CODESTREAM) {
    if (state.complete || state.next) throw invalidBox('codestream boxes: duplicate or mixed');
    state.complete = true;
    for (let data = body; data < end && state.stream < 2;) {
      if (words.u8(data++) !== (state.stream++ ? 10 : 255)) throw invalidBox('logical codestream signature');
    }
  } else if (type === PARTIAL) {
    if (state.complete && !state.next || end - body < 4) throw invalidBox('jxlp box');
    const field = words.u32(body), index = field & 0x7fffffff, data = body + 4; last = !!(field & 0x80000000);
    sequence = index;
    if (state.minorVersion === 0) {
      if (index !== state.next++) throw invalidBox('fragment v0: duplicate or unordered');
      if (state.complete) throw invalidBox(last ? 'final fragment: duplicate' : 'codestream: incomplete');
      state.complete = last;
      for (let p = data; p < end && state.stream < 2;) {
        if (words.u8(p++) !== (state.stream++ ? 10 : 255)) throw invalidBox('logical codestream signature');
      }
    } else {
      if (state.prefixes.has(index)) throw invalidBox('fragment v0: duplicate or unordered');
      const n = Math.min(2, end - data), prefix = n << 16 | (n ? words.u8(data) << 8 : 0) | (n > 1 ? words.u8(data + 1) : 0);
      state.prefixes.set(index, prefix); state.next++;
      if (last) { if (state.lastIndex !== -1) throw invalidBox('final fragment: duplicate'); state.lastIndex = index; }
      state.highest = Math.max(state.highest ?? -1, index);
      if (state.lastIndex !== -1 && state.highest > state.lastIndex) throw invalidBox('codestream: incomplete');
    }
  }
  state.at = end; state.count++;
  return {entry: {at, end, body, type, decoded}, sequence, last, unbounded: short === 0};
}
export function endBoxes(state) {
  if (state.minorVersion === 1 && state.next) {
    if (state.lastIndex !== state.next - 1) throw invalidBox('codestream: incomplete');
    for (let index = 0; index < state.next; index++) {
      if (!state.prefixes.has(index)) throw invalidBox('missing jxlp fragment');
      const prefix = state.prefixes.get(index);
      for (let i = 0; i < prefix >>> 16 && state.stream < 2; i++)
        if ((prefix >>> (i ? 0 : 8) & 255) !== (state.stream++ ? 10 : 255)) throw invalidBox('logical codestream signature');
    }
    state.complete = true;
  }
  if (state.first || !state.complete || state.stream < 2) throw invalidBox('codestream: incomplete');
}
export function* boxes(bytes, maxBoxes = 65536) {
  admitBoxes(bytes, maxBoxes); const state = boxCursor(), words = boxWords(bytes);
  while (state.at < bytes.length) { const row = nextBox(bytes, maxBoxes, state, words); if (row) yield row.entry; }
  endBoxes(state);
}
function reconstructionBox(row, state) {
  if (row.entry.decoded === RECONSTRUCTION) {
    if (state.reconstructionSeen) throw invalidBox('duplicate jbrd');
    state.reconstructionSeen = true;
  }
  if (row.sequence >= MAX_RECONSTRUCTION_BOXES) throw invalidBox('boxes: over maxBoxes');
}
export function* containerBoxesSteps(bytes, maxBoxes = 65536, reconstruction = false) {
  return yield* journalTool('containerBoxes')(bytes, maxBoxes, reconstruction,
    {admitBoxes, boxCursor, boxWords, nextBox, endBoxes, reconstructionBox});
}

function concatenate(parts) {
  const out = new Uint8Array(parts.reduce((n, part) => n + part.length, 0));
  let at = 0; for (const part of parts) { out.set(part, at); at += part.length; } return out;
}

export function withJPEGReconstruction(bytes, reconstruction) {
  if (!(bytes instanceof Uint8Array) || !(reconstruction instanceof Uint8Array))
    throw invalidBox('codestream and reconstruction: Uint8Array');
  const join = pieces => {
    const length = pieces.reduce((n, part) => n + part.length, 0); admitOutputSize(length);
    if (journaling()) return journalJoin(pieces);
    return concatenate(pieces);
  };
  const prefix = bytes.subarray(0, Math.min(SIGNATURE.length, bytes.length));
  if (prefix[0] !== 255 || prefix[1] !== 10) {
    if (!SIGNATURE.every((byte, i) => prefix[i] === byte)) throw invalidBox('signature');
    let insertion = -1, boxCount = 0;
    for (const entry of boxes(bytes)) {
      if (++boxCount >= MAX_RECONSTRUCTION_BOXES) throw invalidBox('boxes: over maxBoxes');
      if (entry.decoded === RECONSTRUCTION) throw invalidBox('jbrd: already present');
      if (insertion < 0 && (entry.type === CODESTREAM || entry.type === PARTIAL)) insertion = entry.at;
    }
    return join([sliceBytes(bytes, 0, insertion), boxHeader(RECONSTRUCTION, reconstruction.length), reconstruction, sliceBytes(bytes, insertion)]);
  }
  return join([fileHeader(), boxHeader(RECONSTRUCTION, reconstruction.length), reconstruction, boxHeader(CODESTREAM, bytes.length), bytes]);
}

function reconstructionStart(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 2) throw invalidBox('input: Uint8Array');
  admitOutputSize(bytes.length);
  const prefix = bytes.subarray(0, Math.min(SIGNATURE.length, bytes.length));
  if (prefix[0] === 255 && prefix[1] === 10) return null;
  if (!SIGNATURE.every((byte, i) => prefix[i] === byte)) throw invalidBox('signature');
  return {reconstruction: null, exif: null, xml: null, exifCompressed: false, xmlCompressed: false, parts: []};
}
function reconstructionPart(found, {entry: box, sequence}, take) {
  if (box.decoded === RECONSTRUCTION) found.reconstruction = take(box.body, box.end);
  if (box.decoded === EXIF && !found.exif) { found.exifCompressed = box.type === BROB; found.exif = take(box.body + (found.exifCompressed ? 4 : 0), box.end); }
  if (box.decoded === XML && !found.xml) { found.xmlCompressed = box.type === BROB; found.xml = take(box.body + (found.xmlCompressed ? 4 : 0), box.end); }
  if (box.type === CODESTREAM) found.parts.push(take(box.body, box.end));
  else if (box.type === PARTIAL) found.parts[sequence] = take(box.body + 4, box.end);
}
function reconstructionEnd(found, join) {
  const {parts, ...metadata} = found;
  return found.reconstruction ? {...metadata, codestream: parts.length > 1 ? join(parts) : parts[0]} : null;
}
export function jpegReconstruction(bytes) {
  const found = reconstructionStart(bytes); if (!found) return null;
  const cursor = boxCursor(), words = boxWords(bytes), take = (from, to) => bytes.subarray(from, to);
  while (cursor.at < bytes.length) {
    const row = nextBox(bytes, MAX_RECONSTRUCTION_BOXES, cursor, words);
    if (row) { reconstructionBox(row, cursor); reconstructionPart(found, row, take); }
  }
  endBoxes(cursor); return reconstructionEnd(found, concatenate);
}
export function* jpegReconstructionSteps(bytes) {
  if (!journaling()) return jpegReconstruction(bytes);
  return yield* journalTool('jpegContainer')(bytes, {reconstructionStart, containerBoxesSteps, reconstructionPart,
    reconstructionEnd, maximum: MAX_RECONSTRUCTION_BOXES});
}
