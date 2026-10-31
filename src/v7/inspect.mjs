import {JxlBits} from '../decode-bits.mjs';
import {readDecodeImageHeader} from '../decode-header.mjs';
import {fault} from '../fault.mjs';
import {SIGNATURE, FTYP, BRAND, CODESTREAM, PARTIAL, LEVEL, BROB, RECONSTRUCTION} from '../decode-tables.mjs';
import {fail} from './primitives.mjs';

export function header(bytes, options = {}) {
  const maxBytes = options.maxInputBytes ?? 1073741824;
  const maxBoxes = options.maxBoxes ?? 65536;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw fail('JXL_OPTIONS', 'maxInputBytes is a positive safe integer.');
  if (!Number.isSafeInteger(maxBoxes) || maxBoxes < 1) throw fail('JXL_OPTIONS', 'maxBoxes is a positive safe integer.');
  for (const key of ['maxPixels', 'maxDimension', 'maxMetadataBytes'])
    if (options[key] !== undefined && !(Number.isSafeInteger(options[key]) && options[key] > 0)) throw fail('JXL_OPTIONS', `${key} is a positive safe integer.`);
  if (bytes.byteLength > maxBytes) throw fail('JXL_LIMIT', 'Encoded input exceeds maxInputBytes.');
  const {maxInputBytes: _bytes, maxBoxes: _boxes, ...limits} = options;
  const source = headerSource(bytes, maxBoxes);
  const info = readDecodeImageHeader(new JxlBits(source.codestream), {maxPixels: 65536 * 65536, maxDimension: limits.maxDimension, ...(limits.maxPixels !== undefined && {maxPixels: limits.maxPixels})});
  info.reconstruction = source.reconstruction;
  return info;
}

const INDEX = 0x6a786c69, GAIN = 0x6a68676d, HEAD = 65536;
const invalid = message => fault('JXL_INPUT', message);
export function headerSource(bytes, maxBoxes = 65536) {
  if (bytes[0] === 255 && bytes[1] === 10) return {codestream: bytes, reconstruction: false};
  if (bytes.length < 12 || !SIGNATURE.every((byte, i) => bytes[i] === byte)) throw invalid('Invalid JPEG XL signature.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), bySequence = new Map();
  let boxes = 0, minorVersion = 0, seenLevel = false, full = null, fragments = 0, finalIndex = -1, highest = -1, indexBoxes = 0, gainBoxes = 0;
  let reconstruction = false, cut = false;
  for (let at = 12; at < bytes.length && !cut;) {
    if (boxes >= maxBoxes) throw invalid('JPEG XL box count exceeds the limit.');
    if (bytes.length - at < 8) { cut = true; break; }
    const short = view.getUint32(at), type = view.getUint32(at + 4), headerLength = short === 1 ? 16 : 8;
    if (bytes.length - at < headerLength) { cut = true; break; }
    const length = short === 1 ? view.getUint32(at + 8) * 4294967296 + view.getUint32(at + 12) : short || bytes.length - at;
    if (!Number.isSafeInteger(length) || length < headerLength) throw invalid('Invalid JPEG XL box size.');
    cut = length > bytes.length - at;
    const body = at + headerLength, end = cut ? bytes.length : at + length, data = bytes.subarray(body, end);
    if (!boxes) {
      if (type !== FTYP) throw invalid('The second JPEG XL box must declare the jxl file type.');
      if (data.length < 8) { if (cut) break; throw invalid('The second JPEG XL box must declare the jxl file type.'); }
      if (!cut && (data.length < 12 || data.length % 4) || view.getUint32(body) !== BRAND) throw invalid('The second JPEG XL box must declare the jxl file type.');
      minorVersion = view.getUint32(body + 4);
      if (minorVersion > 1) throw invalid('JPEG XL file-format minorVersion is 0 or 1.');
      let compatible = false; for (let p = body + 8; p + 4 <= end; p += 4) compatible ||= view.getUint32(p) === BRAND;
      if (!compatible && !cut) throw invalid('The file type lacks the jxl compatibility brand.');
    } else if (type === FTYP || type === 0x4a584c20) throw invalid('Repeated JPEG XL file header.');
    let decoded = type;
    if (type === LEVEL) {
      if (boxes !== 1 || seenLevel || data.length > 1 || !cut && data.length !== 1 || data.length === 1 && data[0] !== 5 && data[0] !== 10)
        throw invalid('A level box contains 5 or 10 immediately after the file type.');
      seenLevel = true;
    } else if (type === CODESTREAM) {
      if (full || fragments) throw invalid('Repeated or mixed JPEG XL codestream boxes.');
      full = data;
    } else if (type === PARTIAL) {
      if (full || !cut && data.length < 4) throw invalid('Invalid JPEG XL codestream fragment.');
      if (data.length >= 4) {
        const field = view.getUint32(body), sequence = field & 0x7fffffff, last = field >= 0x80000000;
        if (bySequence.has(sequence) || minorVersion === 0 && sequence !== fragments)
          throw invalid('Repeated or out-of-order version 0 codestream fragment.');
        if (last) { if (finalIndex >= 0) throw invalid('Repeated final codestream fragment.'); finalIndex = sequence; }
        highest = Math.max(highest, sequence);
        if (finalIndex >= 0 && highest > finalIndex) throw invalid('The JPEG XL container has no complete codestream.');
        bySequence.set(sequence, bytes.subarray(body + 4, end)); fragments++;
      }
    } else if (type === BROB) {
      if (!cut && data.length < 4) throw invalid('Truncated compressed JPEG XL box.');
      if (data.length >= 4) {
        decoded = view.getUint32(body);
        if (decoded === BROB || decoded === RECONSTRUCTION || decoded >>> 8 === 0x6a786c)
          throw invalid('A Brotli box cannot wrap codestream, index, reconstruction or another Brotli box.');
      }
    }
    if (decoded === INDEX && ++indexBoxes > 1 || decoded === GAIN && ++gainBoxes > 1)
      throw invalid('A JPEG XL container has at most one frame index and one gain map.');
    if (type === RECONSTRUCTION) reconstruction = true;
    boxes++; at = end;
  }
  if (!full && !bySequence.has(0)) throw invalid('The JPEG XL container has no complete codestream.');
  let codestream = full;
  if (!full) {
    const parts = [];
    for (let i = 0, length = 0; bySequence.has(i) && length < HEAD; i++) { parts.push(bySequence.get(i)); length += bySequence.get(i).length; }
    if (parts.length === 1) codestream = parts[0];
    else {
      codestream = new Uint8Array(Math.min(HEAD, parts.reduce((sum, part) => sum + part.length, 0)));
      let used = 0;
      for (const part of parts) { const take = part.subarray(0, codestream.length - used); codestream.set(take, used); used += take.length; }
    }
  }
  if (codestream.length >= 2 && (codestream[0] !== 255 || codestream[1] !== 10))
    throw invalid('Invalid logical JPEG XL codestream signature.');
  return {codestream, reconstruction};
}
