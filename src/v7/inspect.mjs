import {JxlBits} from '../decode-bits.mjs';
import {journaling, journalTool} from '../step-journal.mjs';
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
  const {maxInputBytes: _bytes, maxBoxes: _boxes, complete = false, ...limits} = options;
  const source = headerSource(bytes, maxBoxes, complete);
  const info = readDecodeImageHeader(new JxlBits(source.codestream), {maxPixels: 65536 * 65536, maxDimension: limits.maxDimension, ...(limits.maxPixels !== undefined && {maxPixels: limits.maxPixels})});
  info.reconstruction = source.reconstruction;
  return info;
}

export const boundedHeader = (bytes, options = {}) => header(bytes, {...options, complete: true});

export function* boundedHeaderSteps(bytes, options = {}) {
  if (!journaling()) return boundedHeader(bytes, options);
  return yield* journalTool('boundedHeader')(bytes, options, {header});
}

const INDEX = 0x6a786c69, GAIN = 0x6a68676d, HEAD = 65536;
const invalid = message => fault('JXL_INPUT', message);
const u32At = (b, i) => (b[i] << 24 | b[i + 1] << 16 | b[i + 2] << 8 | b[i + 3]) >>> 0;
export function headerSource(bytes, maxBoxes = 65536, complete = false) {
  const sig = bytes.subarray(0, Math.min(bytes.length, 12));
  if (sig[0] === 255 && sig[1] === 10) return {codestream: bytes.subarray(0, Math.min(bytes.length, HEAD)), reconstruction: false};
  if (sig.length < 12 || !SIGNATURE.every((byte, i) => sig[i] === byte)) throw invalid('Invalid JPEG XL signature.');
  const bySequence = new Map();
  let boxes = 0, minorVersion = 0, seenLevel = false, full = null, fragments = 0, finalIndex = -1, highest = -1, indexBoxes = 0, gainBoxes = 0;
  let reconstruction = false, cut = false;
  for (let at = 12; at < bytes.length && !cut;) {
    if (boxes >= maxBoxes) throw invalid('JPEG XL box count exceeds the limit.');
    if (bytes.length - at < 8) { cut = true; break; }
    const head = bytes.subarray(at, Math.min(bytes.length, at + 28));
    const short = u32At(head, 0), type = u32At(head, 4), headerLength = short === 1 ? 16 : 8;
    if (head.length < headerLength) { cut = true; break; }
    const length = short === 1 ? u32At(head, 8) * 4294967296 + u32At(head, 12) : short || bytes.length - at;
    if (!Number.isSafeInteger(length) || length < headerLength) throw invalid('Invalid JPEG XL box size.');
    cut = length > bytes.length - at;
    const body = at + headerLength, end = cut ? bytes.length : at + length, dataLen = end - body;
    if (!boxes) {
      if (type !== FTYP) throw invalid('The second JPEG XL box must declare the jxl file type.');
      if (dataLen < 8) { if (cut && !complete) break; throw invalid('The second JPEG XL box must declare the jxl file type.'); }
      if ((!cut || complete) && (dataLen < 12 || dataLen % 4) || u32At(head, headerLength) !== BRAND) throw invalid('The second JPEG XL box must declare the jxl file type.');
      minorVersion = u32At(head, headerLength + 4);
      if (minorVersion > 1) throw invalid('JPEG XL file-format minorVersion is 0 or 1.');
      let compatible = false;
      for (let w = body + 8; w < end && !compatible; w += HEAD) {
        const span = bytes.subarray(w, Math.min(end, w + HEAD));
        for (let p = 0; p + 4 <= span.length; p += 4) compatible ||= u32At(span, p) === BRAND;
      }
      if (!compatible && (!cut || complete)) throw invalid('The file type lacks the jxl compatibility brand.');
    } else if (type === FTYP || type === 0x4a584c20) throw invalid('Repeated JPEG XL file header.');
    let decoded = type;
    if (type === LEVEL) {
      if (boxes !== 1 || seenLevel || dataLen > 1 || (!cut || complete) && dataLen !== 1 || dataLen === 1 && head[headerLength] !== 5 && head[headerLength] !== 10)
        throw invalid('The level box (5 or 10) follows the file type.');
      seenLevel = true;
    } else if (type === CODESTREAM) {
      if (full || fragments) throw invalid('Repeated or mixed JPEG XL codestream boxes.');
      full = bytes.subarray(body, Math.min(end, body + HEAD));
    } else if (type === PARTIAL) {
      if (full || (!cut || complete) && dataLen < 4) throw invalid('Invalid JPEG XL codestream fragment.');
      if (dataLen >= 4) {
        const field = u32At(head, headerLength), sequence = field & 0x7fffffff, last = field >= 0x80000000;
        if (bySequence.has(sequence) || minorVersion === 0 && sequence !== fragments)
          throw invalid('Repeated or out-of-order version 0 codestream fragment.');
        if (last) { if (finalIndex >= 0) throw invalid('Repeated final codestream fragment.'); finalIndex = sequence; }
        highest = Math.max(highest, sequence);
        if (finalIndex >= 0 && highest > finalIndex) throw invalid('The JPEG XL container has no complete codestream.');
        bySequence.set(sequence, [body + 4, end]); fragments++;
      }
    } else if (type === BROB) {
      if ((!cut || complete) && dataLen < 4) throw invalid('Truncated compressed JPEG XL box.');
      if (dataLen >= 4) {
        decoded = u32At(head, headerLength);
        if (decoded === BROB || decoded === RECONSTRUCTION || decoded >>> 8 === 0x6a786c)
          throw invalid('Brotli cannot wrap codestream, index, reconstruction or Brotli boxes.');
      }
    }
    if (decoded === INDEX && ++indexBoxes > 1 || decoded === GAIN && ++gainBoxes > 1)
      throw invalid('At most one frame index and one gain map.');
    if (type === RECONSTRUCTION) reconstruction = true;
    boxes++; at = end;
  }
  if (complete && (cut || fragments && (finalIndex < 0 || fragments !== finalIndex + 1)))
    throw invalid('The JPEG XL container has no complete codestream.');
  if (!full && !bySequence.has(0)) throw invalid('The JPEG XL container has no complete codestream.');
  let codestream = full;
  if (!full) {
    const parts = [];
    for (let i = 0, length = 0; bySequence.has(i) && length < HEAD; i++) {
      const [a, b] = bySequence.get(i), part = bytes.subarray(a, Math.min(b, a + HEAD - length));
      parts.push(part); length += part.length;
    }
    if (parts.length === 1) codestream = parts[0];
    else {
      codestream = new Uint8Array(Math.min(HEAD, parts.reduce((sum, part) => sum + part.length, 0)));
      let used = 0;
      for (const part of parts) { const take = part.subarray(0, codestream.length - used); codestream.set(take, used); used += take.length; }
    }
  }
  if ((complete || codestream.length >= 2) && (codestream.length < 2 || codestream[0] !== 255 || codestream[1] !== 10))
    throw invalid('Invalid logical JPEG XL codestream signature.');
  return {codestream, reconstruction};
}
