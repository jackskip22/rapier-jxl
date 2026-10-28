// SPDX-License-Identifier: MIT
import {fault} from './fault.mjs';
import {SIGNATURE, FTYP, BRAND, CODESTREAM, PARTIAL, LEVEL, BROB, RECONSTRUCTION} from './decode-tables.mjs';

const INDEX = 0x6a786c69, GAIN = 0x6a68676d;
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
