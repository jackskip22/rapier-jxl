// SPDX-License-Identifier: MIT
import {fault} from './fault.mjs';
import {SIGNATURE, FTYP, BRAND, CODESTREAM, PARTIAL, LEVEL, BROB, RECONSTRUCTION, fileHeader, boxHeader} from './container.mjs';
import {readFrames} from './framing.mjs';
import {prepareColorEncoding} from './color-info.mjs';
import {prepareICC} from './icc-write.mjs';

const INDEX = 0x6a786c69, GAIN = 0x6a68676d, U63 = 9223372036854775807n;
const invalid = message => fault('JXL_INPUT', message);
const fourcc = value => String.fromCharCode(value >>> 24, value >>> 16 & 255, value >>> 8 & 255, value & 255);

function record(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid(name + ' is an object.');
}
function uint(value, maximum, name, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw invalid(name + ' is an integer from ' + minimum + ' to ' + maximum + '.');
  return value;
}
function limit(options) { record(options, 'Container options'); return uint(options.maxBytes ?? Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, 'maxBytes', 1); }
function bounded(length, maximum) {
  if (!Number.isSafeInteger(length) || length > maximum) throw fault('JXL_SIZE', 'The JPEG XL container exceeds maxBytes.');
  return length;
}
function byteArray(value, name) { if (!(value instanceof Uint8Array)) throw invalid(name + ' is a Uint8Array.'); return value; }
function joinBytes(parts, maximum) {
  const length = parts.reduce((sum, part) => bounded(sum + part.length, maximum), 0), result = new Uint8Array(length);
  let cursor = 0;
  for (const part of parts) { result.set(part, cursor); cursor += part.length; }
  return result;
}
function typeCode(name) {
  if (typeof name !== 'string' || name.length !== 4 || Array.from(name).some(c => c.charCodeAt(0) > 255))
    throw invalid('boxType is exactly four byte-valued characters.');
  let value = 0; for (const c of name) value = value * 256 + c.charCodeAt(0); return value;
}

export function containerBoxHeader(boxType, bodyByteLength, {extended = false} = {}) {
  if (typeof extended !== 'boolean') throw invalid('extended is a boolean.');
  return boxHeader(typeCode(boxType), bodyByteLength, extended);
}

function scanContainer(bytes, maximum) {
  byteArray(bytes, 'JPEG XL input'); bounded(bytes.length, maximum);
  if (bytes[0] === 255 && bytes[1] === 10) return {codestream: bytes, level: 5, minorVersion: 0, entries: [], fragments: []};
  if (!SIGNATURE.every((byte, i) => bytes[i] === byte)) throw invalid('Invalid JPEG XL signature.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), entries = [], fragments = [], byIndex = new Map();
  let minorVersion = 0, level = 5, seenLevel = false, full = null, finalIndex = -1, indexBoxes = 0, gainBoxes = 0;
  for (let at = 12; at < bytes.length;) {
    if (bytes.length - at < 8) throw invalid('Truncated JPEG XL box header.');
    const short = view.getUint32(at), type = view.getUint32(at + 4), headerLength = short === 1 ? 16 : 8;
    if (bytes.length - at < headerLength) throw invalid('Truncated extended JPEG XL box header.');
    const length = short === 1 ? view.getUint32(at + 8) * 4294967296 + view.getUint32(at + 12) : short || bytes.length - at;
    if (!Number.isSafeInteger(length) || length < headerLength || length > bytes.length - at) throw invalid('Invalid JPEG XL box size.');
    const body = at + headerLength, end = at + length, data = bytes.subarray(body, end), entry = {at, body, end, type, decoded: type, data, headerLength, unbounded: short === 0};
    if (!entries.length) {
      if (type !== FTYP || data.length < 12 || data.length % 4 || view.getUint32(body) !== BRAND)
        throw invalid('The second JPEG XL box must declare the jxl file type.');
      minorVersion = view.getUint32(body + 4);
      if (minorVersion > 1) throw invalid('JPEG XL file-format minorVersion is 0 or 1.');
      let compatible = false; for (let p = body + 8; p < end; p += 4) compatible ||= view.getUint32(p) === BRAND;
      if (!compatible) throw invalid('The file type lacks the jxl compatibility brand.');
    } else if (type === FTYP || type === 0x4a584c20) throw invalid('Repeated JPEG XL file header.');
    if (type === LEVEL) {
      if (entries.length !== 1 || seenLevel || data.length !== 1 || data[0] !== 5 && data[0] !== 10)
        throw invalid('A level box contains 5 or 10 immediately after the file type.');
      level = data[0]; seenLevel = true;
    } else if (type === CODESTREAM) {
      if (full || fragments.length) throw invalid('Repeated or mixed JPEG XL codestream boxes.');
      full = data;
    } else if (type === PARTIAL) {
      if (full || data.length < 4) throw invalid('Invalid JPEG XL codestream fragment.');
      const field = view.getUint32(body), sequence = field & 0x7fffffff, last = field >= 0x80000000;
      if (byIndex.has(sequence) || minorVersion === 0 && sequence !== fragments.length)
        throw invalid('Repeated or out-of-order version 0 codestream fragment.');
      if (last) { if (finalIndex >= 0) throw invalid('Repeated final codestream fragment.'); finalIndex = sequence; }
      const fragment = {sequence, last, byteOffset: body + 4, byteLength: data.length - 4, headerLength};
      fragments.push(fragment); byIndex.set(sequence, bytes.subarray(body + 4, end));
    } else if (type === BROB) {
      if (data.length < 4) throw invalid('Truncated compressed JPEG XL box.');
      const inner = view.getUint32(body);
      if (inner === BROB || inner === RECONSTRUCTION || inner >>> 8 === 0x6a786c)
        throw invalid('A Brotli box cannot wrap codestream, index, reconstruction or another Brotli box.');
      entry.decoded = inner;
    }
    if (entry.decoded === INDEX && ++indexBoxes > 1 || entry.decoded === GAIN && ++gainBoxes > 1)
      throw invalid('A JPEG XL container has at most one frame index and one gain map.');
    entries.push(entry); at = end;
  }
  if (!entries.length || !full && (!fragments.length || finalIndex !== fragments.length - 1)) throw invalid('The JPEG XL container has no complete codestream.');
  let codestream = full;
  if (!full) {
    const parts = [];
    for (let i = 0; i < fragments.length; i++) { if (!byIndex.has(i)) throw invalid('Missing JPEG XL codestream fragment.'); parts.push(byIndex.get(i)); }
    codestream = joinBytes(parts, maximum);
  }
  if (codestream[0] !== 255 || codestream[1] !== 10) throw invalid('Invalid logical JPEG XL codestream signature.');
  return {codestream, level, minorVersion, entries, fragments};
}

export function inspectContainer(bytes, options = {}) {
  const source = scanContainer(bytes, limit(options));
  return {codestream: source.codestream.slice(), level: source.level, minorVersion: source.minorVersion,
    fragments: source.fragments.map(row => ({...row})),
    auxiliary: source.entries.filter(row => ![FTYP, LEVEL, CODESTREAM, PARTIAL].includes(row.type)).map(row =>
      ({boxType: fourcc(row.type), data: row.data.slice(), extended: row.headerLength === 16}))};
}

function validateOrder(order, chunks, stream, options) {
  if (!Array.isArray(order) || order.length !== chunks.length) throw invalid('fragmentOrder lists each fragment exactly once.');
  if (options.allowBufferedFrameEnds !== undefined && typeof options.allowBufferedFrameEnds !== 'boolean') throw invalid('allowBufferedFrameEnds is a boolean.');
  const positions = new Int32Array(chunks.length); positions.fill(-1);
  for (let i = 0; i < order.length; i++) {
    const value = uint(order[i], chunks.length - 1, 'fragmentOrder entry');
    if (positions[value] !== -1) throw invalid('fragmentOrder contains a repeated fragment.');
    positions[value] = i;
  }
  if (positions.every((value, i) => value === i)) return false;
  let starts = options.frameStarts;
  if (starts === undefined) {
    const framed = readFrames(stream, {iccBits: options.iccBitLength});
    starts = [...(framed.preview ? [framed.preview.start] : []), ...framed.frames.map(frame => frame.start)];
  }
  if (!Array.isArray(starts) || !starts.length) throw invalid('frameStarts declares every frame header byte offset.');
  let previous = -1, chunk = 0;
  const barriers = new Set([0]), endings = new Set();
  for (const start of starts) {
    uint(start, stream.length - 1, 'frameStarts entry', 2);
    if (start <= previous) throw invalid('frameStarts is strictly increasing.'); previous = start;
    while (chunk + 1 < chunks.length && chunks[chunk + 1].start <= start) chunk++;
    barriers.add(chunk);
    if (chunk) endings.add(chunk - 1);
  }
  const beforeMax = new Int32Array(chunks.length), afterMin = new Int32Array(chunks.length);
  let highest = -1, lowest = chunks.length;
  for (let i = 0; i < chunks.length; i++) { beforeMax[i] = highest; highest = Math.max(highest, positions[i]); }
  for (let i = chunks.length - 1; i >= 0; i--) { afterMin[i] = lowest; lowest = Math.min(lowest, positions[i]); }
  for (const boundary of barriers) if (beforeMax[boundary] >= positions[boundary] || afterMin[boundary] <= positions[boundary])
    throw invalid('Every frame-start fragment must follow all earlier fragments and precede all later fragments.');
  if (!options.allowBufferedFrameEnds) for (const boundary of endings) if (beforeMax[boundary] >= positions[boundary] || afterMin[boundary] <= positions[boundary])
    throw invalid('Keep the fragment before each frame start in order for Chrome 155, or explicitly allowBufferedFrameEnds.');
  return true;
}

export function reframeContainer(bytes, options = {}) {
  const maximum = limit(options), source = scanContainer(bytes, maximum), stream = source.codestream;
  const extended = options.extended ?? false;
  if (typeof extended !== 'boolean') throw invalid('extended is a boolean.');
  const level = options.level ?? source.level;
  if (level !== 5 && level !== 10 || source.level === 10 && level !== 10) throw invalid('The container level is 5 or 10 and cannot demote an existing level 10 declaration.');
  const chunkSize = options.chunkSize === undefined ? stream.length : uint(options.chunkSize, 0x7fffffff, 'chunkSize', 1);
  const chunks = [];
  for (let start = 0; start < stream.length; start += chunkSize) chunks.push({start, data: stream.subarray(start, Math.min(stream.length, start + chunkSize))});
  const order = options.fragmentOrder ?? chunks.map((_, i) => i), outOfOrder = validateOrder(order, chunks, stream, options);
  const minorVersion = options.minorVersion ?? (outOfOrder ? 1 : 0);
  if (minorVersion !== 0 && minorVersion !== 1 || outOfOrder && minorVersion !== 1) throw invalid('Out-of-order fragments require minorVersion 1.');
  const ftyp = source.entries.length ? source.entries[0].data.slice() : new Uint8Array([106,120,108,32,0,0,0,0,106,120,108,32]);
  new DataView(ftyp.buffer).setUint32(4, minorVersion);
  const parts = [SIGNATURE, boxHeader(FTYP, ftyp.length, extended), ftyp];
  if (level === 10 || source.entries.some(row => row.type === LEVEL)) parts.push(boxHeader(LEVEL, 1, extended), Uint8Array.of(level));
  const auxiliary = source.entries.filter(row => ![FTYP, LEVEL, CODESTREAM, PARTIAL].includes(row.type));
  for (const row of auxiliary) if (row.type !== INDEX) parts.push(boxHeader(row.type, row.data.length, extended), row.data);
  if (options.chunkSize === undefined && options.fragmentOrder === undefined) parts.push(boxHeader(CODESTREAM, stream.length, extended), stream);
  else for (const index of order) {
    const data = chunks[index].data, counter = new Uint8Array(4);
    new DataView(counter.buffer).setUint32(0, index + (index === chunks.length - 1 ? 0x80000000 : 0));
    parts.push(boxHeader(PARTIAL, data.length + 4, extended), counter, data);
  }
  for (const row of auxiliary) if (row.type === INDEX) parts.push(boxHeader(row.type, row.data.length, extended), row.data);
  return joinBytes(parts, maximum);
}

function integer63(value, name, minimum = 0n) {
  if (typeof value === 'number') { if (!Number.isSafeInteger(value)) throw invalid(name + ' is a safe integer or bigint.'); value = BigInt(value); }
  if (typeof value !== 'bigint' || value < minimum || value > U63) throw invalid(name + ' is an unsigned 63-bit integer.');
  return value;
}
function putVarint(out, value) { do { const byte = Number(value & 127n); value >>= 7n; out.push(byte + (value ? 128 : 0)); } while (value); }
function compactInteger(value) { return value <= 9007199254740991n ? Number(value) : value; }

export function frameIndexPayload(index, options = {}) {
  const maximum = limit(options); record(index, 'Frame index');
  const numerator = uint(index.tickNumerator, 0xffffffff, 'tickNumerator'), denominator = uint(index.tickDenominator, 0xffffffff, 'tickDenominator', 1);
  if (!Array.isArray(index.frames) || !index.frames.length) throw invalid('A frame index includes the first displayed keyframe.');
  bounded(index.frames.length * 3 + 9, maximum);
  const out = []; putVarint(out, BigInt(index.frames.length));
  const clock = new Uint8Array(8), view = new DataView(clock.buffer); view.setUint32(0, numerator); view.setUint32(4, denominator); out.push(...clock);
  let previous = 0n;
  for (let i = 0; i < index.frames.length; i++) {
    const frame = index.frames[i]; record(frame, 'Frame index entry');
    const absolute = integer63(frame.byteOffset, 'byteOffset', 2n);
    if (i && absolute <= previous) throw invalid('Frame index byte offsets are strictly increasing.');
    putVarint(out, absolute - previous); putVarint(out, integer63(frame.duration, 'duration'));
    putVarint(out, integer63(frame.framesToNext, 'framesToNext', 1n)); previous = absolute; bounded(out.length, maximum);
  }
  return Uint8Array.from(out);
}

function parseIndex(data) {
  let cursor = 0;
  const take = () => {
    let value = 0n;
    for (let shift = 0n; shift < 63n; shift += 7n) {
      if (cursor >= data.length) throw invalid('Truncated frame index integer.');
      const byte = data[cursor++]; value |= BigInt(byte & 127) << shift;
      if (byte < 128) return value;
    }
    throw invalid('A frame index integer exceeds 63 bits.');
  };
  const amount = take();
  if (!amount || amount > BigInt(Math.floor((data.length - cursor - 8) / 3))) throw invalid('Invalid frame index entry count.');
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength), tickNumerator = view.getUint32(cursor), tickDenominator = view.getUint32(cursor + 4); cursor += 8;
  if (!tickDenominator) throw invalid('Frame index tickDenominator must be nonzero.');
  const frames = []; let absolute = 0n;
  for (let i = 0; i < Number(amount); i++) {
    const delta = take(), duration = take(), framesToNext = take(); absolute += delta;
    if (absolute < 2n || absolute > U63 || i && !delta || !framesToNext) throw invalid('Invalid frame index offset or frame distance.');
    frames.push({byteOffset: compactInteger(absolute), duration: compactInteger(duration), framesToNext: compactInteger(framesToNext)});
  }
  if (cursor !== data.length) throw invalid('Unexpected bytes after the frame index.');
  return {tickNumerator, tickDenominator, frames};
}

function attached(bytes, type, payload, options) {
  const maximum = limit(options), source = scanContainer(bytes, maximum), extended = options.extended ?? false;
  if (typeof extended !== 'boolean') throw invalid('extended is a boolean.');
  const level = options.level ?? source.level;
  if (level !== 5 && level !== 10 || source.level === 10 && level !== 10) throw invalid('The container level is 5 or 10 and cannot demote an existing level 10 declaration.');
  const parts = [];
  if (!source.entries.length) parts.push(fileHeader(level), boxHeader(CODESTREAM, bytes.length), bytes);
  else {
    parts.push(SIGNATURE);
    for (const row of source.entries) if (row.decoded !== type) {
      if (row.type === LEVEL && source.level !== level) continue;
      if (row.unbounded) parts.push(boxHeader(row.type, row.data.length, row.headerLength === 16), row.data);
      else parts.push(bytes.subarray(row.at, row.end));
      if (row.type === FTYP && source.level !== level) parts.push(boxHeader(LEVEL, 1), Uint8Array.of(level));
    }
  }
  if (payload !== null) parts.push(boxHeader(type, payload.length, extended), payload);
  return joinBytes(parts, maximum);
}

export function withFrameIndex(bytes, index, options = {}) {
  const maximum = limit(options), source = scanContainer(bytes, maximum), payload = index === null ? null : frameIndexPayload(index, options);
  if (index !== null) for (const frame of index.frames) if (integer63(frame.byteOffset, 'byteOffset') >= BigInt(source.codestream.length))
    throw invalid('A frame index byteOffset must fall inside the logical codestream.');
  return attached(bytes, INDEX, payload, options);
}
export function readFrameIndex(bytes, options = {}) {
  const source = scanContainer(bytes, limit(options)), entry = source.entries.find(row => row.type === INDEX);
  if (!entry) return null;
  const index = parseIndex(entry.data);
  for (const frame of index.frames) if (integer63(frame.byteOffset, 'byteOffset') >= BigInt(source.codestream.length))
    throw invalid('A frame index byteOffset falls outside the logical codestream.');
  return index;
}

export function gainMapPayload(bundle, options = {}) {
  const maximum = limit(options); record(bundle, 'Gain map bundle');
  if ((bundle.version ?? 0) !== 0) throw invalid('The supported gain-map bundle version is 0.');
  const metadata = byteArray(bundle.gainMapMetadata, 'gainMapMetadata'); uint(metadata.length, 65535, 'gainMapMetadata byte length');
  const gain = scanContainer(bundle.gainMap, maximum).codestream; uint(gain.length, 0xffffffff, 'gainMap byte length', 2);
  if (bundle.alternativeColorEncoding !== undefined && bundle.alternativeColorEncodingBytes !== undefined)
    throw invalid('Choose structured alternativeColorEncoding or its serialized bytes.');
  const color = bundle.alternativeColorEncoding !== undefined ? prepareColorEncoding(bundle.alternativeColorEncoding).colorData.finish()
    : bundle.alternativeColorEncodingBytes === undefined ? new Uint8Array(0) : byteArray(bundle.alternativeColorEncodingBytes, 'alternativeColorEncodingBytes');
  uint(color.length, 255, 'alternative color encoding byte length');
  if (bundle.alternativeICC !== undefined && bundle.alternativeICCCompressed !== undefined) throw invalid('Choose original alternativeICC or its compressed bytes.');
  const icc = bundle.alternativeICC !== undefined ? prepareICC(bundle.alternativeICC, {level: options.level ?? 5, compression: bundle.iccCompression}).iccData.finish()
    : bundle.alternativeICCCompressed === undefined ? new Uint8Array(0) : byteArray(bundle.alternativeICCCompressed, 'alternativeICCCompressed');
  uint(icc.length, 0xffffffff, 'alternative ICC compressed byte length');
  const prefix = new Uint8Array(3), suffix = new Uint8Array(4);
  new DataView(prefix.buffer).setUint16(1, metadata.length); new DataView(suffix.buffer).setUint32(0, icc.length);
  return joinBytes([prefix, metadata, Uint8Array.of(color.length), color, suffix, icc, gain], maximum);
}

export function withGainMap(bytes, bundle, options = {}) {
  const source = scanContainer(bytes, limit(options)), settings = {...options, level: options.level ?? source.level};
  return attached(bytes, GAIN, bundle === null ? null : gainMapPayload(bundle, settings), settings);
}
export function readGainMap(bytes, options = {}) {
  const source = scanContainer(bytes, limit(options)), entry = source.entries.find(row => row.decoded === GAIN);
  if (!entry) return null;
  if (entry.type === BROB) throw invalid('Reading a Brotli-compressed gain map requires external decompression first.');
  const data = entry.data, view = new DataView(data.buffer, data.byteOffset, data.byteLength); let cursor = 0;
  const part = size => { if (size > data.length - cursor) throw invalid('Truncated gain map bundle.'); const value = data.slice(cursor, cursor + size); cursor += size; return value; };
  const version = part(1)[0]; if (version !== 0) throw invalid('Unsupported gain-map bundle version.');
  part(2); const gainMapMetadata = part(view.getUint16(1)), colorLength = part(1)[0], alternativeColorEncodingBytes = part(colorLength);
  const iccAt = cursor; part(4); const alternativeICCCompressed = part(view.getUint32(iccAt)), gainMap = part(data.length - cursor);
  if (gainMap[0] !== 255 || gainMap[1] !== 10) throw invalid('A gain map contains a naked JPEG XL codestream.');
  return {version, gainMapMetadata, alternativeColorEncodingBytes, alternativeICCCompressed, gainMap};
}
