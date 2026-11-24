// SPDX-License-Identifier: MIT
import {BitWriter, ceilLog2} from './bits.mjs';
import {copyBits, codestreamLevel} from './framing.mjs';
import {SIGNATURE, FTYP, BRAND, CODESTREAM, PARTIAL, LEVEL, BROB, RECONSTRUCTION, boxHeader, fileHeader} from './container.mjs';
import {readEntropy, readContextMap, readPermutation} from './decode-entropy.mjs';
import {context as iccContext} from './decode-icc.mjs';
import {iccProfileLimit} from './decode-icc-admission.mjs';
import {IccCursor} from './icc-profile.mjs';
import {JxlBits, requireDecode, unpackSigned} from './decode-bits.mjs';
import {readDecodeImageHeader, readDecodeFrameHeader, readDecodeTOC} from './decode-header.mjs';
import {TRANSFORMS} from './vardct-bases.mjs';
import {viewBytes, copyBytes} from './v7/bytes.mjs';
import {fail, declared, snapshotOptions} from './v7/primitives.mjs';

const INDEX = 0x6a786c69, GAIN = 0x6a68676d;
const TOC_ENTRY = [[10, 0], [14, 1024], [22, 17408], [30, 4211712]];
const NUM_PASSES = [[0, 1], [0, 2], [0, 3], [3, 4]];
const NUM_DOWNSAMPLE = [[0, 0], [0, 1], [0, 2], [1, 3]];
const UPSAMPLING = [[0, 1], [0, 2], [0, 4], [0, 8]];
const LAST_PASS = [[0, 0], [0, 1], [0, 2], [3, 0]];
const FAMILY_IDS = [0, 1, 2, 3, 4, 5, 7, 9, 11, 12, 14, 18, 20, 21, 23, 24, 26];
const ORDER_SHAPES = [[1, 1], [1, 1], [2, 2], [4, 4], [2, 1], [4, 1], [4, 2], [8, 8], [8, 4], [16, 16], [16, 8], [32, 32], [32, 16]];
const ORDER_VALUES = 3 * ORDER_SHAPES.reduce((sum, [w, h]) => sum + w * h * 64 + 1, 0);
const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const KEEP_AUX = new Set([0x636f6c72, 0x45786966, 0x786d6c20, 0x6a756d62]);

function toBase64(bytes) {
  let out = '', i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const v = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out += BASE64[(v >>> 18) & 63] + BASE64[(v >>> 12) & 63] + BASE64[(v >>> 6) & 63] + BASE64[v & 63];
  }
  if (i < bytes.length) {
    const two = i + 1 < bytes.length, v = (bytes[i] << 16) | (two ? bytes[i + 1] << 8 : 0);
    out += BASE64[(v >>> 18) & 63] + BASE64[(v >>> 12) & 63] + (two ? BASE64[(v >>> 6) & 63] : '=') + '=';
  }
  return out;
}

function joinParts(parts) {
  const total = parts.reduce((n, p) => n + p.length, 0), out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

function unpackSource(bytes, allowCut) {
  if (bytes.length < 2) throw fail('JXL_INPUT', 'JPEG XL: empty input');
  if (bytes[0] === 0xff && bytes[1] === 0x0a) return {codestream: bytes, prefixBoxes: null, suffixBoxes: null, level: 5};
  if (bytes.length < 12 || !SIGNATURE.every((b, i) => bytes[i] === b))
    throw fail('JXL_INPUT', 'not JPEG XL: invalid signature');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const prefixBoxes = [], suffixBoxes = [], bySequence = new Map();
  let level = 5, minorVersion = 0, boxes = 0, seenLevel = false, full = null;
  let fragments = 0, finalIndex = -1, highest = -1, indexBoxes = 0, gainBoxes = 0, cut = false;
  for (let at = 12; at < bytes.length;) {
    if (boxes >= 65536) throw fail('JXL_LIMIT', 'JPEG XL box count exceeds the limit.');
    if (bytes.length - at < 8) { if (allowCut) { cut = true; break; } throw fail('JXL_INPUT', 'container box: incomplete'); }
    const short = view.getUint32(at), type = view.getUint32(at + 4), head = short === 1 ? 16 : 8;
    if (bytes.length - at < head) { if (allowCut) { cut = true; break; } throw fail('JXL_INPUT', 'extended box: incomplete'); }
    const declared = short === 1 ? view.getUint32(at + 8) * 4294967296 + view.getUint32(at + 12) : short || (bytes.length - at);
    if (!Number.isSafeInteger(declared) || declared < head) throw fail('JXL_INPUT', 'box length: >= header');
    cut = declared > bytes.length - at;
    if (cut && !allowCut) throw fail('JXL_INPUT', 'container box: incomplete');
    const end = cut ? bytes.length : at + declared, body = at + head, dataLen = end - body;
    if (!boxes) {
      if (type !== FTYP) throw fail('JXL_INPUT', 'Second JPEG XL box must declare the jxl file type.');
      if (dataLen < 8) { if (cut && allowCut) break; throw fail('JXL_INPUT', 'Second JPEG XL box must declare the jxl file type.'); }
      if ((!cut || !allowCut) && (dataLen < 12 || dataLen % 4) || view.getUint32(body) !== BRAND)
        throw fail('JXL_INPUT', 'Second JPEG XL box must declare the jxl file type.');
      minorVersion = view.getUint32(body + 4);
      if (minorVersion > 1) throw fail('JXL_INPUT', 'JPEG XL file-format minorVersion is 0 or 1.');
      let compatible = false;
      for (let p = body + 8; p + 4 <= end; p += 4) if (view.getUint32(p) === BRAND) { compatible = true; break; }
      if (!compatible) {
        if (cut && allowCut) break;
        throw fail('JXL_INPUT', 'The file type lacks the jxl compatibility brand.');
      }
      if (!cut) prefixBoxes.push(fileHeader(5).subarray(12));
    } else if (type === FTYP || type === 0x4a584c20) {
      throw fail('JXL_INPUT', 'Repeated JPEG XL file header.');
    }
    let decoded = type;
    if (type === LEVEL) {
      if (boxes !== 1 || seenLevel || dataLen > 1 || (!cut || !allowCut) && dataLen !== 1 ||
          dataLen === 1 && bytes[body] !== 5 && bytes[body] !== 10)
        throw fail('JXL_INPUT', 'The level box (5 or 10) follows the file type.');
      seenLevel = true;
      if (dataLen === 1) { level = bytes[body]; prefixBoxes.push(bytes.subarray(at, end)); }
    } else if (type === CODESTREAM) {
      if (full || fragments) throw fail('JXL_INPUT', 'Repeated or mixed JPEG XL codestream boxes.');
      full = bytes.subarray(body, end);
    } else if (type === PARTIAL) {
      if (full || (!cut || !allowCut) && dataLen < 4) throw fail('JXL_INPUT', 'Invalid JPEG XL codestream fragment.');
      if (dataLen >= 4) {
        const field = view.getUint32(body), sequence = field & 0x7fffffff, last = field >= 0x80000000;
        if (bySequence.has(sequence) || minorVersion === 0 && sequence !== fragments)
          throw fail('JXL_INPUT', 'Repeated or out-of-order codestream fragment.');
        if (last) { if (finalIndex >= 0) throw fail('JXL_INPUT', 'Repeated final codestream fragment.'); finalIndex = sequence; }
        highest = Math.max(highest, sequence);
        if (finalIndex >= 0 && highest > finalIndex) throw fail('JXL_INPUT', 'The JPEG XL container has no complete codestream.');
        bySequence.set(sequence, bytes.subarray(body + 4, end));
        fragments++;
      }
    } else if (type === BROB) {
      if ((!cut || !allowCut) && dataLen < 4) throw fail('JXL_INPUT', 'Truncated compressed JPEG XL metadata.');
      if (dataLen >= 4) {
        decoded = view.getUint32(body);
        if (decoded === BROB || decoded === RECONSTRUCTION || decoded >>> 8 === 0x6a786c)
          throw fail('JXL_INPUT', 'Brotli cannot wrap codestream, index, reconstruction or Brotli boxes.');
      }
      if (!cut && KEEP_AUX.has(decoded)) (full || fragments ? suffixBoxes : prefixBoxes).push(bytes.subarray(at, end));
    } else if (!cut && KEEP_AUX.has(type)) {
      if (type === 0x45786966) {
        if (dataLen < 4) throw fail('JXL_INPUT', 'Exif: TIFF offset missing');
        const tiffOff = 4 + view.getUint32(body);
        if (tiffOff + 8 > dataLen) throw fail('JXL_INPUT', 'Exif: invalid TIFF offset or header');
        const t0 = body + tiffOff;
        if (!(bytes[t0] === 73 && bytes[t0 + 1] === 73 && bytes[t0 + 2] === 42 && bytes[t0 + 3] === 0 ||
              bytes[t0] === 77 && bytes[t0 + 1] === 77 && bytes[t0 + 2] === 0 && bytes[t0 + 3] === 42))
          throw fail('JXL_INPUT', 'Exif: invalid TIFF offset or header');
      }
      (full || fragments ? suffixBoxes : prefixBoxes).push(bytes.subarray(at, end));
    }
    if (decoded === INDEX && ++indexBoxes > 1 || decoded === GAIN && ++gainBoxes > 1)
      throw fail('JXL_INPUT', 'At most one frame index and one gain map.');
    boxes++;
    if (cut) break;
    at = end;
  }
  if (!allowCut && (cut || !full && (finalIndex < 0 || fragments !== finalIndex + 1)))
    throw fail('JXL_INPUT', 'The JPEG XL container has no complete codestream.');
  let codestream = full;
  if (!codestream) {
    const parts = [];
    for (let i = 0; bySequence.has(i); i++) parts.push(bySequence.get(i));
    if (!allowCut && parts.length !== fragments) throw fail('JXL_INPUT', 'Missing JPEG XL codestream fragment.');
    if (parts.length) codestream = parts.length === 1 ? parts[0] : joinParts(parts);
  }
  if (!codestream || !codestream.length) throw fail('JXL_INPUT', 'prefix: codestream missing');
  if (codestream.length < 2) {
    if (allowCut) throw fail('JXL_INPUT', 'prefix: codestream missing');
    throw fail('JXL_INPUT', 'Invalid logical JPEG XL codestream signature.');
  }
  if (codestream[0] !== 0xff || codestream[1] !== 0x0a)
    throw fail('JXL_INPUT', 'Invalid logical JPEG XL codestream signature.');
  return {codestream, prefixBoxes, suffixBoxes, level};
}

function wrapContainer(codestream, unpacked) {
  const needed = codestreamLevel(codestream);
  if (!unpacked.prefixBoxes) {
    return needed === 10 ? joinParts([fileHeader(10), boxHeader(CODESTREAM, codestream.length), codestream]) : codestream;
  }
  const boxes = needed === 10 && unpacked.level < 10 && !unpacked.prefixBoxes.some(b => b.length >= 8 && b[4] === 0x6a && b[5] === 0x78 && b[6] === 0x6c && b[7] === 0x6c)
    ? [unpacked.prefixBoxes[0], fileHeader(10).subarray(32), ...unpacked.prefixBoxes.slice(1)]
    : unpacked.prefixBoxes;
  return joinParts([
    SIGNATURE,
    ...boxes,
    boxHeader(CODESTREAM, codestream.length),
    codestream,
    ...unpacked.suffixBoxes,
  ]);
}

function locateFrameSpliceBits(codestream, h, frameStartBit) {
  const r = new JxlBits(codestream, true);
  r.bit = frameStartBit;
  if (r.read(1)) throw fail('JXL_UNSUPPORTED', 'frame header: no separable LF');
  const type = r.read(2), encoding = r.read(1), flags = r.u64BigInt();
  const doYCbCr = !h.xyb ? r.read(1) : 0;
  if (!(flags & 32n)) {
    if (doYCbCr) { r.read(2); r.read(2); r.read(2); }
    r.u32(UPSAMPLING);
    for (let i = 0; i < h.extraChannels.length; i++) r.u32(UPSAMPLING);
  }
  if (encoding === 1) r.read(2);
  else if (h.xyb && type !== 2) { r.read(3); r.read(3); }
  const passesBit = r.bit;
  if (type !== 2) {
    const count = r.u32(NUM_PASSES);
    if (count !== 1) {
      const ds = r.u32(NUM_DOWNSAMPLE);
      for (let i = 0; i < count - 1; i++) r.read(2);
      for (let i = 0; i < ds; i++) r.u32(UPSAMPLING);
      for (let i = 0; i < ds; i++) r.u32(LAST_PASS);
    }
  }
  const afterPassesBit = r.bit;
  if (type === 1) r.u32([[0, 1], [0, 2], [0, 3], [0, 4]]);
  let x0 = 0, y0 = 0, fw = h.width, fh = h.height;
  if (type !== 1 && r.read(1)) {
    const sz = [[8, 0], [11, 256], [14, 2304], [30, 18688]];
    if (type === 0 || type === 3) { x0 = unpackSigned(r.u32(sz)); y0 = unpackSigned(r.u32(sz)); }
    fw = r.u32(sz); fh = r.u32(sz);
  }
  const full = x0 <= 0 && y0 <= 0 && x0 + fw >= h.width && y0 + fh >= h.height;
  let mode0 = 0, duration = 0;
  if (type === 0 || type === 3) {
    for (let c = 0; c <= h.extraChannels.length; c++) {
      const m = r.u32([[0, 0], [0, 1], [0, 2], [2, 3]]);
      if (!c) mode0 = m;
      if (h.extraChannels.length && (m === 2 || m === 3)) r.u32([[0, 0], [0, 1], [0, 2], [3, 3]]);
      if ((h.extraChannels.length && (m === 2 || m === 3)) || m === 4) r.read(1);
      if (m !== 0 || !full) r.u32([[0, 0], [0, 1], [0, 2], [0, 3]]);
    }
    if (h.animation) { duration = r.u32([[0, 0], [0, 1], [8, 0], [32, 0]]); if (h.animation.timecodes) r.read(32); }
  }
  const isLast = (type === 0 || type === 3) ? r.read(1) === 1 : false;
  const saveRef = type !== 1 && !isLast ? r.read(2) : 0;
  if (type === 2 || (type !== 1 && full && mode0 === 0 && !isLast && (duration === 0 || saveRef !== 0))) r.read(1);
  const nameLen = r.u32([[0, 0], [4, 0], [5, 16], [10, 48]]);
  for (let i = 0; i < nameLen; i++) r.read(8);
  if (!r.read(1)) {
    if (r.read(1) && r.read(1)) for (let i = 0; i < 6; i++) r.f16();
    const epf = r.read(2);
    if (epf) {
      if (!encoding && r.read(1)) for (let i = 0; i < 8; i++) r.f16();
      if (r.read(1)) { r.f16(); r.f16(); r.f16(); r.read(32); }
      if (r.read(1)) for (let i = 0; i < (encoding ? 3 : 4); i++) r.f16();
      if (encoding) r.f16();
    }
    if (r.u64BigInt() !== 0n) throw fail('JXL_UNSUPPORTED', 'frame filters: extensions unsupported');
  }
  if (r.u64BigInt() !== 0n) throw fail('JXL_UNSUPPORTED', 'frame header: extensions unsupported');
  return {passesBit, afterPassesBit, tocBit: r.bit, flags};
}

function buildZeroAcHFGlobal(numGroups, passCount) {
  const w = new BitWriter(32);
  w.write(1, 1);
  if (numGroups > 1) w.write(ceilLog2(numGroups), 0);
  for (let p = 0; p < passCount; p++) {
    w.write(2, 2);
    w.write(1, 0);
    w.write(1, 1); w.write(2, 0);
    w.write(1, 1);
    w.write(4, 0);
    w.write(1, 0);
  }
  return w.finish();
}

function readVarDCTClusters(lfBytes, flags, allowGlobalTree = false) {
  requireDecode(lfBytes.length > 0, 'Empty JPEG XL LF global section.');
  const r = new JxlBits(lfBytes, true);
  if (flags & 19n) {
    if (allowGlobalTree) return 1;
    throw fail('JXL_UNSUPPORTED', 'slice: no patches/splines/noise');
  }
  const lfDequant = r.read(1) ? [1 / 32, 1 / 4, 1 / 2] : [r.f16(), r.f16(), r.f16()];
  requireDecode(lfDequant.every(v => v >= 1e-8), 'Invalid JPEG XL LF dequantization.', r);
  r.u32([[11, 1], [11, 2049], [12, 4097], [16, 8193]]);
  r.u32([[0, 16], [5, 1], [8, 1], [16, 1]]);
  let clusters = 15;
  if (!r.read(1)) {
    let bins = 1;
    for (let c = 0; c < 3; c++) {
      const n = r.read(4); bins *= n + 1;
      for (let i = 0; i < n; i++) r.u32([[4, 0], [8, 16], [16, 272], [32, 65808]]);
    }
    const nq = r.read(4); bins *= nq + 1;
    for (let i = 0; i < nq; i++) r.u32([[2, 0], [3, 4], [5, 12], [8, 44]]);
    requireDecode(bins <= 64, 'Too many JPEG XL block context bins.', r);
    const map = readContextMap(r, bins * 39);
    clusters = 1;
    for (let i = 0; i < map.length; i++) if (map[i] + 1 > clusters) clusters = map[i] + 1;
    requireDecode(clusters <= 16, 'Too many JPEG XL block contexts.', r);
  }
  if (!r.read(1)) {
    r.u32([[0, 84], [0, 256], [8, 2], [16, 258]]);
    const baseX = r.f16(), baseB = r.f16();
    requireDecode(Math.abs(baseX) <= 4 && Math.abs(baseB) <= 4, 'Invalid JPEG XL color correlation.', r);
    r.read(8); r.read(8);
  }
  const hasGlobalTree = r.read(1) === 1;
  if (hasGlobalTree && !allowGlobalTree) throw fail('JXL_UNSUPPORTED', 'slice: no VarDCT global modular tree');
  return clusters;
}

function skipRawQuantTable(r, width, height, streamIndex) {
  if (r.read(1)) throw fail('JXL_UNSUPPORTED', 'slice: no raw quantization');
  if (!r.read(1)) for (let i = 0; i < 11; i++) r.read(i < 7 ? 5 : 4);
  if (r.u32([[0, 0], [0, 1], [4, 2], [8, 18]]) !== 0) throw fail('JXL_UNSUPPORTED', 'slice: no transformed quantization');
  const samplesPerChannel = width * height, totalSamples = 3 * samplesPerChannel;
  const maxNodes = Math.min(1048576, 1024 + totalSamples);
  const tree = readEntropy(r, 6, {values: maxNodes * 5, distanceMultiplier: 0});
  const nodes = [{depth: 0}];
  let leaves = 0;
  for (let i = 0; i < nodes.length; i++) {
    requireDecode(nodes.length <= maxNodes && nodes[i].depth <= 2048, 'JPEG XL MA tree exceeds its bound.', r);
    const node = nodes[i], property = tree.read(1);
    if (property === 0) {
      const predictor = tree.read(2);
      tree.read(3);
      const exponent = tree.read(4), mantissa = tree.read(5);
      requireDecode(predictor <= 13 && exponent <= 30 && mantissa <= 2 ** (31 - exponent) - 2, 'Invalid MA leaf.', r);
      node.leaf = leaves++;
    } else {
      if (property !== 1 && property !== 2)
        throw fail('JXL_UNSUPPORTED', 'slice: quantization channel tree only');
      node.property = property - 1;
      node.value = unpackSigned(tree.read(0));
      node.left = nodes.length;
      node.right = nodes.length + 1;
      nodes.push({depth: node.depth + 1}, {depth: node.depth + 1});
    }
  }
  tree.finish();
  const stream = readEntropy(r, leaves, {values: totalSamples, distanceMultiplier: height});
  for (let c = 0; c < 3; c++) {
    let at = 0;
    while (nodes[at].leaf === undefined) {
      const tested = nodes[at].property === 0 ? c : streamIndex;
      at = tested > nodes[at].value ? nodes[at].left : nodes[at].right;
    }
    for (let i = 0; i < samplesPerChannel; i++) stream.read(nodes[at].leaf);
  }
  stream.finish();
}

function sliceHFGlobalBytes(hfBytes, numLFGroups, numGroups, clusters, keepPasses, appendDummyPass = false) {
  requireDecode(hfBytes.length > 0, 'Empty JPEG XL HF global section.');
  const r = new JxlBits(hfBytes, true);
  const allDefault = r.read(1);
  if (!allDefault) {
    for (let fam = 0; fam < 17; fam++) {
      const t = TRANSFORMS[FAMILY_IDS[fam]], width = Math.max(t.width, t.height), height = Math.min(t.width, t.height);
      const mode = r.read(3);
      requireDecode(mode < 1 || mode > 5 || width * height === 64, 'Invalid JPEG XL quantization mode for transform.', r);
      if (mode === 0) continue;
      if (mode === 1) r.skip(3 * 3 * 16);
      else if (mode === 2) r.skip(3 * 6 * 16);
      else if (mode === 3) { r.skip(3 * 2 * 16); const nb = r.read(4) + 1; r.skip(3 * nb * 16); }
      else if (mode === 4) { r.skip(3 * 16); const nb = r.read(4) + 1; r.skip(3 * nb * 16); }
      else if (mode === 5) {
        r.skip(3 * 9 * 16);
        const nb1 = r.read(4) + 1; r.skip(3 * nb1 * 16);
        const nb2 = r.read(4) + 1; r.skip(3 * nb2 * 16);
      } else if (mode === 6) {
        const nb = r.read(4) + 1; r.skip(3 * nb * 16);
      } else if (mode === 7) {
        const denominator = r.f16();
        requireDecode(denominator > 0, 'Invalid JPEG XL raw quantization multiplier.', r);
        skipRawQuantTable(r, width, height, 1 + numLFGroups * 3 + fam);
      }
    }
  }
  const numPresets = r.read(ceilLog2(numGroups)) + 1;
  requireDecode(numPresets <= numGroups, 'Too many JPEG XL HF presets.', r);
  for (let p = 0; p < keepPasses; p++) {
    const used = r.u32([[0, 95], [0, 19], [0, 0], [13, 0]]);
    if (used) {
      const dec = readEntropy(r, 8, {values: ORDER_VALUES});
      for (let ord = 0; ord < 13; ord++) if (used & (1 << ord)) {
        const [w, h] = ORDER_SHAPES[ord], skip = w * h;
        for (let c = 0; c < 3; c++) readPermutation(dec, skip * 64, skip);
      }
      dec.finish();
    }
    readEntropy(r, 495 * numPresets * clusters);
  }
  const w = new BitWriter(Math.ceil(r.bit / 8) + 8);
  copyBits(w, hfBytes, 0, r.bit);
  if (appendDummyPass) {
    w.write(2, 2); w.write(1, 0); w.write(1, 1); w.write(2, 0); w.write(1, 1); w.write(4, 0); w.write(1, 0);
  }
  return w.finish();
}

function skipICC(r, level = 5) {
  const start = r.bit, size = r.u64();
  const maxProfileBytes = iccProfileLimit(level, 1 << 28), maxEncoded = Math.min(1 << 28, maxProfileBytes + 65536);
  if (!Number.isSafeInteger(size) || size < 0 || size > maxEncoded)
    throw fail('JXL_LIMIT', 'JPEG XL ICC profile exceeds its allocation limit.');
  const code = readEntropy(r, 41, {values: size, byteHistory: true});
  const headLen = Math.min(size, 20), first = new Uint8Array(headLen);
  let a = 0, b = 0;
  for (let i = 0; i < headLen; i++) {
    const value = code.read(iccContext(i, a, b));
    requireDecode(value < 256, 'JPEG XL ICC entropy value exceeds one byte.', r);
    first[i] = value; b = a; a = value;
  }
  const preamble = new IccCursor(first, requireDecode), outputSize = preamble.integer(), commandSize = preamble.integer();
  if (!Number.isSafeInteger(outputSize) || outputSize < 0 || outputSize > maxProfileBytes)
    throw fail('JXL_LIMIT', 'JPEG XL ICC profile exceeds its allocation limit.');
  requireDecode(commandSize <= size - preamble.at && size <= outputSize + 65536, 'Invalid JPEG XL ICC preamble.', r);
  for (let i = headLen; i < size; i++) {
    if (i >= 20 && (i & 65535) === 0) requireDecode(i <= (r.bit - start) * 32, 'Invalid JPEG XL ICC expansion.', r);
    const value = code.read(iccContext(i, a, b));
    requireDecode(value < 256, 'JPEG XL ICC entropy value exceeds one byte.', r);
    b = a; a = value;
  }
  code.finish();
}

function openSingleVarDCT(codestream, allowCut, level = 5) {
  const r = new JxlBits(codestream, true);
  const h = readDecodeImageHeader(r, {maxPixels: Infinity, maxDimension: 1073741824});
  if (h.preview || h.animation) throw fail('JXL_UNSUPPORTED', 'slice: single-frame VarDCT only');
  if (h.extraChannels.length) throw fail('JXL_UNSUPPORTED', 'slice: no extra channels');
  if (h.colorEncoding.wantICC) skipICC(r, level);
  r.align();
  const imageEndByte = r.bit >>> 3;
  const frameStartBit = r.bit;
  const f = readDecodeFrameHeader(r, h, {maxPixels: Infinity, maxDimension: 1073741824});
  if (f.modular || f.type !== 0 || !f.isLast || f.useLFFrame || f.haveCrop || f.upsampling > 1 || f.blending[0].mode !== 0)
    throw fail('JXL_UNSUPPORTED', 'slice: full-canvas single-frame VarDCT with LF');
  const readers = readDecodeTOC(r, f, allowCut);
  if (!allowCut && f.end !== codestream.length)
    throw fail('JXL_INPUT', 'Unexpected bytes after the JPEG XL codestream.');
  const splice = locateFrameSpliceBits(codestream, h, frameStartBit);
  return {h, f, readers, imageEndByte, frameStartBit, splice};
}

function writePassesField(w, passCount, downsampleList, lastPassList, shiftList = []) {
  w.writeU32(NUM_PASSES, passCount);
  if (passCount > 1) {
    w.writeU32(NUM_DOWNSAMPLE, downsampleList.length);
    for (let i = 0; i < passCount - 1; i++) w.write(2, shiftList[i] ?? 0);
    for (const ds of downsampleList) w.writeU32(UPSAMPLING, ds);
    for (const lp of lastPassList) w.writeU32(LAST_PASS, lp);
  }
}

function assembleSlicedFrame(codestream, opened, passCount, downsampleList, lastPassList, sections, shiftList = []) {
  const {imageEndByte, frameStartBit, splice} = opened;
  const w = new BitWriter(imageEndByte + 64 + sections.length * 4);
  w.append({bytes: codestream.subarray(0, imageEndByte), at: imageEndByte, pending: 0, acc: 0});
  copyBits(w, codestream, frameStartBit, splice.passesBit);
  writePassesField(w, passCount, downsampleList, lastPassList, shiftList);
  copyBits(w, codestream, splice.afterPassesBit, splice.tocBit);
  w.write(1, 0);
  w.zeroPadToByte();
  for (const s of sections) w.writeU32(TOC_ENTRY, s.length);
  w.zeroPadToByte();
  return joinParts([w.finish(), ...sections]);
}

function admitLFSections(opened) {
  const {f, readers, splice} = opened;
  const lfSections = [];
  for (let i = 0; i < 1 + f.numLFGroups; i++) {
    if (!readers[i]) throw fail('JXL_INPUT', 'Prefix ends before all LF sections have arrived.');
    requireDecode(readers[i].bytes.length > 0, 'Empty JPEG XL LF section.');
    lfSections.push(readers[i].bytes);
  }
  readVarDCTClusters(readers[0].bytes, splice.flags, true);
  return lfSections;
}

export function placeholder(input, options) {
  try { return placeholderInner(input, options); } catch (error) { throw declared(error); }
}
function placeholderInner(input, options) {
  const settings = snapshotOptions(options);
  for (const key of Object.keys(settings)) if (key !== 'format')
    throw fail('JXL_OPTIONS', `unknown option: ${key}`);
  const {format = 'jxl'} = settings;
  if (format !== 'jxl' && format !== 'dataUrl')
    throw fail('JXL_OPTIONS', "format: jxl|dataUrl");
  const raw = viewBytes(input);
  const unpacked = unpackSource(raw, true);
  const effectiveLevel = unpacked.prefixBoxes ? unpacked.level : codestreamLevel(unpacked.codestream);
  const opened = openSingleVarDCT(unpacked.codestream, true, effectiveLevel);
  const {h, f, readers} = opened;
  if (readers.length === 1) throw fail('JXL_UNSUPPORTED', 'slice: progressive LF/HF separation required');
  const lfSections = admitLFSections(opened);
  const emittedPasses = f.numGroups === 1 ? 2 : 1;
  const hfZero = buildZeroAcHFGlobal(f.numGroups, emittedPasses);
  const empty = new Uint8Array(0);
  const sections = [...lfSections, hfZero, ...Array.from({length: emittedPasses * f.numGroups}, () => empty)];
  const stream = assembleSlicedFrame(unpacked.codestream, opened, emittedPasses, [], [], sections);
  const bytes = wrapContainer(stream, unpacked);
  const swap = h.orientation >= 5;
  const width = swap ? h.height : h.width, height = swap ? h.width : h.height;
  return {
    bytes,
    width,
    height,
    previewWidth: Math.ceil(width / 8),
    previewHeight: Math.ceil(height / 8),
    scale: 8,
    ...(format === 'dataUrl' ? {dataUrl: 'data:image/jxl;base64,' + toBase64(bytes)} : {}),
  };
}

function buildScaleCandidate(raw, unpacked, opened, targetScale) {
  const {h, f, readers, splice} = opened;
  const swap = h.orientation >= 5;
  const width = swap ? h.height : h.width, height = swap ? h.width : h.height;
  if (targetScale === 1) {
    if (readers.length === 1) requireDecode(readers[0].bytes.length > 0, 'Empty JPEG XL frame section.');
    else {
      admitLFSections(opened);
      requireDecode(readers[1 + f.numLFGroups].bytes.length > 0, 'Empty JPEG XL HF global section.');
    }
    return {bytes: copyBytes(raw), scale: 1, width, height, renderedWidth: width, renderedHeight: height};
  }
  if (targetScale === 8) {
    const dc = placeholder(raw);
    return {bytes: dc.bytes, scale: 8, width, height, renderedWidth: dc.previewWidth, renderedHeight: dc.previewHeight};
  }
  const idx = f.passes.downsample.indexOf(targetScale);
  if (idx < 0) return null;
  const lastPass = f.passes.lastPass[idx];
  if (f.passes.shift[lastPass] !== 0) return null;
  const keepPasses = lastPass + 1;
  const lfSections = admitLFSections(opened);
  const clusters = readVarDCTClusters(readers[0].bytes, splice.flags, false);
  const needDummy = f.numGroups === 1 && keepPasses === 1;
  const hfSliced = sliceHFGlobalBytes(readers[1 + f.numLFGroups].bytes, f.numLFGroups, f.numGroups, clusters, keepPasses, needDummy);
  const acSections = [];
  for (let p = 0; p < keepPasses; p++) for (let g = 0; g < f.numGroups; g++) {
    acSections.push(readers[2 + f.numLFGroups + p * f.numGroups + g].bytes);
  }
  if (needDummy) acSections.push(new Uint8Array(0));
  const emittedPasses = needDummy ? 2 : keepPasses;
  const keptDs = [], keptLp = [];
  for (let i = 0; i < idx; i++) { keptDs.push(f.passes.downsample[i]); keptLp.push(f.passes.lastPass[i]); }
  const keptShift = Array.from({length: emittedPasses - 1}, (_, i) => i < keepPasses ? f.passes.shift[i] : 0);
  const stream = assembleSlicedFrame(unpacked.codestream, opened, emittedPasses, keptDs, keptLp, [...lfSections, hfSliced, ...acSections], keptShift);
  return {
    bytes: wrapContainer(stream, unpacked),
    scale: targetScale,
    width,
    height,
    renderedWidth: Math.ceil(width / targetScale),
    renderedHeight: Math.ceil(height / targetScale),
  };
}

export function slice(input, options) {
  try { return sliceInner(input, options); } catch (error) { throw declared(error); }
}
function sliceInner(input, options) {
  const settings = snapshotOptions(options);
  for (const key of Object.keys(settings)) if (!['scale', 'maxWidth', 'maxBytes'].includes(key))
    throw fail('JXL_OPTIONS', `unknown option: ${key}`);
  const {scale, maxWidth, maxBytes} = settings;
  if (scale !== undefined && ![1, 2, 4, 8].includes(scale))
    throw fail('JXL_OPTIONS', 'scale: 1|2|4|8');
  if (maxWidth !== undefined && (!Number.isSafeInteger(maxWidth) || maxWidth < 1))
    throw fail('JXL_OPTIONS', 'maxWidth: positive safe integer');
  if (maxBytes !== undefined && (!Number.isSafeInteger(maxBytes) || maxBytes < 1))
    throw fail('JXL_OPTIONS', 'maxBytes: positive safe integer');

  const raw = viewBytes(input);
  const unpacked = unpackSource(raw, false);
  const effectiveLevel = unpacked.prefixBoxes ? unpacked.level : codestreamLevel(unpacked.codestream);
  const opened = openSingleVarDCT(unpacked.codestream, false, effectiveLevel);
  const {h, f} = opened;
  const swap = h.orientation >= 5, width = swap ? h.height : h.width, height = swap ? h.width : h.height;

  const available = [1];
  for (const ds of [2, 4]) {
    const idx = f.passes.downsample.indexOf(ds);
    if (idx >= 0 && f.passes.shift[f.passes.lastPass[idx]] === 0) available.push(ds);
  }
  if (opened.readers.length > 1) available.push(8);
  available.sort((a, b) => a - b);

  let chosen = scale ?? 1;
  if (scale !== undefined && !available.includes(scale))
    throw fail('JXL_UNSUPPORTED', `scale 1:${scale}: unavailable`);
  if (scale === undefined && maxWidth !== undefined) {
    for (const s of [...available].reverse()) {
      if (Math.ceil(width / s) >= maxWidth) { chosen = s; break; }
    }
  }
  if (maxBytes === undefined) {
    const candidate = buildScaleCandidate(raw, unpacked, opened, chosen);
    if (!candidate) throw fail('JXL_UNSUPPORTED', `Requested scale 1:${chosen} is not present in this codestream.`);
    return candidate;
  }
  let smallest = null;
  for (const s of available.filter(s => s >= chosen)) {
    let candidate;
    try { candidate = buildScaleCandidate(raw, unpacked, opened, s); }
    catch (error) { if (s !== 1 && s !== 8 && error?.code === 'JXL_UNSUPPORTED') continue; throw error; }
    if (!candidate) continue;
    smallest = candidate;
    if (candidate.bytes.byteLength <= maxBytes) return candidate;
  }
  if (!smallest) smallest = buildScaleCandidate(raw, unpacked, opened, available.at(-1));
  if (smallest.bytes.byteLength > maxBytes)
    throw fail('JXL_LIMIT', `maxBytes ${maxBytes}: minimum ${smallest.bytes.byteLength} B at 1:${smallest.scale}`);
  return smallest;
}
