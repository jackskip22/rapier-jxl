import {JxlBits} from '../decode-bits.mjs';
import {journaling, journalTool} from '../step-journal.mjs';
import {readDecodeImageHeader} from '../decode-header.mjs';
import {fault} from '../fault.mjs';
import {SIGNATURE, FTYP, BRAND, CODESTREAM, PARTIAL, LEVEL, BROB, RECONSTRUCTION} from '../decode-tables.mjs';
import {fail} from './primitives.mjs';

export function header(bytes, options = {}) {
  const {maxInputBytes: maxBytes = Number.MAX_SAFE_INTEGER, maxBoxes = Number.MAX_SAFE_INTEGER} = options;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw fail('JXL_OPTIONS', "maxInputBytes: positive safe integer");
  if (!Number.isSafeInteger(maxBoxes) || maxBoxes < 1) throw fail('JXL_OPTIONS', "maxBoxes: positive safe integer");
  for (const key of ['maxPixels', 'maxDimension', 'maxMetadataBytes'])
    if (options[key] !== undefined && !(Number.isSafeInteger(options[key]) && options[key] > 0)) throw fail('JXL_OPTIONS', `${key}: positive safe integer`);
  if (bytes.byteLength > maxBytes) throw fail('JXL_LIMIT', "maxInputBytes: exceeded");
  const {maxInputBytes: _bytes, maxBoxes: _boxes, complete = false, ...limits} = options;
  const source = headerSource(bytes, maxBoxes, complete);
  const info = prefixRead(source, codestream => readDecodeImageHeader(new JxlBits(codestream, true), {maxPixels: Infinity, maxDimension: limits.maxDimension, ...(limits.maxPixels !== undefined && {maxPixels: limits.maxPixels})}));
  info.reconstruction = source.reconstruction;
  return info;
}

const UNREAD = new Set(['JXL_DECODE', 'JXL_DIMENSIONS', 'JXL_INPUT', 'JXL_LIMIT']);
export function firstFrameNoise(bytes) {
  try {
    return prefixRead(headerSource(bytes), codestream => {
      const r = new JxlBits(codestream, true), h = readDecodeImageHeader(r, {maxPixels: Infinity});
      if (h.colorEncoding.wantICC || h.preview) return null;
      r.align(); if (r.read(1)) return false;
      r.read(3); return (r.u64BigInt() & 1n) !== 0n;
    });
  } catch (error) { if (UNREAD.has(error?.code)) return null; throw error; }
}

export const boundedHeader = (bytes, options = {}) => header(bytes, {...options, complete: true});

export function* boundedHeaderSteps(bytes, options = {}) {
  if (!journaling()) return boundedHeader(bytes, options);
  return yield* journalTool('boundedHeader')(bytes, options, {header});
}

const INDEX = 0x6a786c69, GAIN = 0x6a68676d, HEAD = 65536;
const invalid = (message, fix = '') => fault('JXL_INPUT', fix ? `${message}; ${fix}` : message);
const u32At = (b, i) => (b[i] << 24 | b[i + 1] << 16 | b[i + 2] << 8 | b[i + 3]) >>> 0;
export function headerSource(bytes, maxBoxes = Number.MAX_SAFE_INTEGER, complete = false) {
  const sig = bytes.subarray(0, Math.min(bytes.length, 12));
  if (sig[0] === 255 && sig[1] === 10) { const window = n => bytes.subarray(0, Math.min(n, bytes.length)); return {codestream: window(HEAD), window, total: bytes.length, reconstruction: false}; }
  if (sig.length < 12 || !SIGNATURE.every((byte, i) => sig[i] === byte)) throw invalid("signature");
  const bySequence = new Map();
  let boxes = 0, minorVersion = 0, seenLevel = false, full = null, fragments = 0, finalIndex = -1, highest = -1, indexBoxes = 0, gainBoxes = 0;
  let reconstruction = false, cut = false;
  for (let at = 12; at < bytes.length && !cut;) {
    if (boxes >= maxBoxes) throw invalid("maxBoxes: exceeded", "simplify file or raise maxBoxes");
    if (bytes.length - at < 8) { cut = true; break; }
    const head = bytes.subarray(at, Math.min(bytes.length, at + 28));
    const short = u32At(head, 0), type = u32At(head, 4), headerLength = short === 1 ? 16 : 8;
    if (head.length < headerLength) { cut = true; break; }
    const length = short === 1 ? u32At(head, 8) * 4294967296 + u32At(head, 12) : short || bytes.length - at;
    if (!Number.isSafeInteger(length) || length < headerLength) throw invalid("box size");
    cut = length > bytes.length - at;
    const body = at + headerLength, end = cut ? bytes.length : at + length, dataLen = end - body;
    if (!boxes) {
      if (type !== FTYP) throw invalid("second box: jxl file type");
      if (dataLen < 8) { if (cut && !complete) break; throw invalid("second box: jxl file type"); }
      if ((!cut || complete) && (dataLen < 12 || dataLen % 4) || u32At(head, headerLength) !== BRAND) throw invalid("second box: jxl file type");
      minorVersion = u32At(head, headerLength + 4);
      if (minorVersion > 1) throw invalid("minorVersion: 0 or 1");
      let compatible = false;
      for (let w = body + 8; w < end && !compatible; w += HEAD) {
        const span = bytes.subarray(w, Math.min(end, w + HEAD));
        for (let p = 0; p + 4 <= span.length; p += 4) compatible ||= u32At(span, p) === BRAND;
      }
      if (!compatible && (!cut || complete)) throw invalid("file type: jxl brand required");
    } else if (type === FTYP || type === 0x4a584c20) throw invalid("file header: duplicate");
    let decoded = type;
    if (type === LEVEL) {
      if (boxes !== 1 || seenLevel || dataLen > 1 || (!cut || complete) && dataLen !== 1 || dataLen === 1 && head[headerLength] !== 5 && head[headerLength] !== 10)
        throw invalid("level box: 5 or 10 after file type");
      seenLevel = true;
    } else if (type === CODESTREAM) {
      if (full || fragments) throw invalid("codestream boxes: duplicate or mixed");
      full = [body, end];
    } else if (type === PARTIAL) {
      if (full || (!cut || complete) && dataLen < 4) throw invalid("codestream fragment");
      if (dataLen >= 4) {
        const field = u32At(head, headerLength), sequence = field & 0x7fffffff, last = field >= 0x80000000;
        if (bySequence.has(sequence) || minorVersion === 0 && sequence !== fragments)
          throw invalid("fragment v0: duplicate or unordered");
        if (last) { if (finalIndex >= 0) throw invalid("final fragment: duplicate"); finalIndex = sequence; }
        highest = Math.max(highest, sequence);
        if (finalIndex >= 0 && highest > finalIndex) throw invalid("codestream: incomplete");
        bySequence.set(sequence, [body + 4, end]); fragments++;
      }
    } else if (type === BROB) {
      if ((!cut || complete) && dataLen < 4) throw invalid("compressed box: incomplete");
      if (dataLen >= 4) {
        decoded = u32At(head, headerLength);
        if (decoded === BROB || decoded === RECONSTRUCTION || decoded >>> 8 === 0x6a786c)
          throw invalid("Brotli box: not codestream/index/reconstruction/Brotli");
      }
    }
    if (decoded === INDEX && ++indexBoxes > 1 || decoded === GAIN && ++gainBoxes > 1)
      throw invalid("frame index/gain map: max 1 each");
    if (type === RECONSTRUCTION) reconstruction = true;
    boxes++; at = end;
  }
  if (complete && (cut || fragments && (finalIndex < 0 || fragments !== finalIndex + 1)))
    throw invalid("codestream: incomplete");
  if (!full && !bySequence.has(0)) throw invalid("codestream: incomplete");
  const ranges = full ? [full] : [];
  for (let i = 0; !full && bySequence.has(i); i++) ranges.push(bySequence.get(i));
  const total = ranges.reduce((sum, [a, b]) => sum + b - a, 0), window = n => joined(bytes, ranges, Math.min(n, total));
  return checked({codestream: window(HEAD), window, total, reconstruction}, complete);
}
function checked(source, complete) {
  const {codestream} = source;
  if ((complete || codestream.length >= 2) && (codestream.length < 2 || codestream[0] !== 255 || codestream[1] !== 10))
    throw invalid("logical codestream signature");
  return source;
}
function joined(bytes, ranges, n) {
  if (ranges.length === 1) return bytes.subarray(ranges[0][0], ranges[0][0] + n);
  const out = new Uint8Array(n);
  for (let i = 0, at = 0; at < n; at += ranges[i][1] - ranges[i][0], i++) out.set(bytes.subarray(ranges[i][0], Math.min(ranges[i][1], ranges[i][0] + n - at)), at);
  return out;
}
function prefixRead(source, read) {
  for (let n = HEAD, codestream = source.codestream; ; codestream = source.window(n *= 4)) {
    try { return read(codestream); } catch (error) { if (codestream.length === source.total || error?.code !== 'JXL_DECODE') throw error; }
  }
}
