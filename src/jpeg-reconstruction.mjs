// SPDX-License-Identifier: MIT
import {BitWriter, complete} from './bits.mjs';
import {unit, carried, stage, PASSED} from './step-journal.mjs';
import {kernelHooks} from './kernel-hooks.mjs';
import {ZIGZAG, jpegError, admitScan} from './jfif.mjs';
import {JxlBits, requireJPEG, readJPEGCoefficients} from './jpeg-coefficients.mjs';
import {jpegReconstruction, withJPEGReconstruction, boxes, boxHeader, CODESTREAM} from './container.mjs';
import {guard, admitOutputSize} from './admit.mjs';
import {fault} from './fault.mjs';
import {compressBrotli, decompressBrotli} from './brotli.mjs';

const FOUR = [[0, 1], [0, 2], [0, 3], [0, 4]];
const COUNTS = [[0, 0], [0, 1], [3, 2], [8, 0]], SYMBOLS = [[2, 0], [2, 4], [4, 8], [8, 1]];
const EVENTS = [[0, 0], [2, 1], [4, 4], [16, 20]], BLOCK = [[0, 0], [3, 1], [5, 9], [28, 41]];
const HUFFMANS = [[0, 4], [3, 2], [4, 10], [6, 26]], TAIL = [[0, 0], [8, 1], [16, 257], [22, 65793]];
export const RECONSTRUCTION_PAYLOAD_BYTES = 67108864;
export const RECONSTRUCTION_SCAN_EVENTS = 4194304;
const equal = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
function concatenate(parts) {
  const size = parts.reduce((n, part) => n + part.length, 0); admitOutputSize(size);
  const bytes = new Uint8Array(size); let at = 0;
  for (const part of parts) { bytes.set(part, at); at += part.length; } return bytes;
}

function structure(bytes, jpeg) {
  const sharedSampling = !jpeg.ycbcr && (Math.min(...jpeg.components.map(c => c.h)) > 1 || Math.min(...jpeg.components.map(c => c.v)) > 1);
  if (sharedSampling && jpeg.progressive) throw jpegError('progressive shared sampling factors cannot be reconstructed');
  const data = {markers: [], apps: [], comments: [], quant: [], huffman: [], scans: [], inter: [], tail: new Uint8Array(0), restart: 0, components: jpeg.components.map(c => ({id: c.id, quant: -1}))};
  let events = 0;
  const raw = part => {
    for (let at = 0; at < part.length; at += 65535) {
      requireJPEG(data.markers.length < 16384);
      data.markers.push(255); data.inter.push(part.subarray(at, at + 65535));
    }
  };
  let at = 2, ended = false, hasRestart = false;
  while (at < bytes.length) {
    requireJPEG(data.markers.length < 16384);
    const start = at;
    while (bytes[at] === 255) at++;
    if (at - start > 1) raw(bytes.subarray(start, at - 1));
    const marker = bytes[at++], markerStart = at - 2;
    if (marker === 217) { data.markers.push(marker); data.tail = bytes.subarray(at); ended = true; break; }
    if (marker === 1) { raw(bytes.subarray(markerStart, at)); continue; }
    const size = bytes[at] * 256 + bytes[at + 1], body = at + 2, end = at + size;
    let keep = true;
    if (marker === 219) {
      const tables = [];
      for (let p = body; p < end;) {
        const precision = bytes[p] >> 4, index = bytes[p++] & 15, values = new Int32Array(64);
        for (const k of ZIGZAG) { values[k] = precision ? bytes[p++] * 256 + bytes[p++] : bytes[p++]; }
        tables.push({precision, index, last: p === end, values});
      }
      keep = data.quant.length + tables.length <= 3 && tables.every(q => jpeg.components.some(c => c.tq === q.index && equal(c.quant, q.values))) &&
        tables.every(q => !data.quant.some(old => old.index === q.index));
      if (keep) data.quant.push(...tables);
    } else if (marker === 196) {
      if (body === end) keep = false;
      for (let p = body; p < end;) {
        requireJPEG(data.huffman.length < 89);
        const slot = bytes[p++], counts = [0, ...bytes.subarray(p, p + 16)]; p += 16;
        const n = counts.reduce((a, b) => a + b, 0), symbols = [...bytes.subarray(p, p + n), 256]; p += n;
        requireJPEG(n > 0);
        let last = 16; while (!counts[last]) last--; counts[last]++;
        requireJPEG(counts[last] <= 255);
        data.huffman.push({slot, counts, symbols, last: p === end});
      }
    } else if (marker === 218) {
      const count = bytes[body], components = [];
      if (sharedSampling && count !== 1) throw jpegError('interleaved shared sampling factors cannot be reconstructed');
      for (let p = body + 1, i = 0; i < count; i++, p += 2) components.push({index: jpeg.components.findIndex(c => c.id === bytes[p]), dc: bytes[p + 1] >> 4, ac: bytes[p + 1] & 15});
      const p = body + 1 + count * 2, choices = jpeg.scanChoices[data.scans.length];
      requireJPEG(p + 3 === end && choices.resets.length <= 65555 && choices.zeros.length <= 65555);
      events += choices.resets.length + choices.zeros.length;
      if (events > RECONSTRUCTION_SCAN_EVENTS) throw jpegError(`more than ${RECONSTRUCTION_SCAN_EVENTS} scan events cannot be reconstructed`);
      data.scans.push({components, ss: bytes[p], se: bytes[p + 1], al: bytes[p + 2] & 15, ah: bytes[p + 2] >> 4, ...choices});
      data.markers.push(marker); at = end;
      while (at < bytes.length) {
        if (bytes[at++] !== 255) continue;
        if (bytes[at] === 0) { at++; continue; }
        if (bytes[at] >= 208 && bytes[at] <= 215) { at++; continue; }
        at--; break;
      }
      if (choices.fill) {
        const fill = new Uint8Array(choices.fill * 2);
        for (let i = 0; i < fill.length; i += 2) fill[i] = 255;
        raw(fill);
      }
      if (choices.finalRestart !== undefined) data.markers.push(choices.finalRestart);
      continue;
    } else if (marker >= 224 && marker <= 239) data.apps.push(bytes.subarray(markerStart + 1, end));
    else if (marker === 254) data.comments.push(bytes.subarray(markerStart + 1, end));
    else if (marker === 221) {
      const interval = bytes[body] * 256 + bytes[body + 1];
      if (hasRestart && interval !== data.restart) throw jpegError('changing restart intervals cannot be reconstructed');
      data.restart = interval; hasRestart = true;
    } else if (![192, 193, 194].includes(marker) || sharedSampling) keep = false;
    if (keep) data.markers.push(marker); else raw(bytes.subarray(markerStart, end));
    at = end;
  }
  if (!ended) throw jpegError('JPEG reconstruction requires an end marker');
  for (let i = 0; i < jpeg.components.length; i++) {
    const c = jpeg.components[i];
    let index = data.quant.findIndex(q => q.index === c.tq && equal(q.values, c.quant));
    if (index < 0) { index = data.quant.length; data.quant.push({precision: c.quant.some(v => v > 255) ? 1 : 0, index: c.tq, values: c.quant, last: true}); }
    data.components[i].quant = index;
  }
  if (jpeg.padding) { requireJPEG(jpeg.padding.length < 16777216); data.padding = jpeg.padding; }
  requireJPEG(data.markers.length <= 16384 && data.quant.length <= 3 && data.huffman.length <= 89 && data.tail.length <= 4260096);
  return data;
}

function brotliStore(bytes) {
  const w = new BitWriter(bytes.length + 64); w.write(1, 0);
  for (let at = 0; at < bytes.length; at += 65536) {
    const part = bytes.subarray(at, at + 65536);
    w.write(1, 0); w.write(2, 0); w.write(16, part.length - 1); w.write(1, 1); w.zeroPadToByte();
    for (const byte of part) w.write(8, byte);
  }
  w.write(2, 3); return w.finish();
}
const CONTEXT_BYTES = 196608;
function writeData(data, effort, contextsFrom) {
  const w = new BitWriter(), grey = data.components.length === 1;
  w.write(1, grey ? 1 : 0); for (const marker of data.markers) w.write(6, marker - 192);
  for (const part of data.apps) { w.write(2, 0); w.write(16, part.length - 1); }
  for (const part of data.comments) w.write(16, part.length - 1);
  w.writeU32(FOUR, data.quant.length);
  for (const q of data.quant) { w.write(1, q.precision); w.write(2, q.index); w.write(1, q.last ? 1 : 0); }
  const ids = data.components.map(c => c.id), type = grey && ids[0] === 1 ? 0 : equal(ids, [1, 2, 3]) ? 1 : equal(ids, [82, 71, 66]) ? 2 : 3;
  w.write(2, type);
  if (type === 3) { w.writeU32(FOUR, ids.length); for (const id of ids) w.write(8, id); }
  for (const c of data.components) w.write(2, c.quant);
  w.writeU32(HUFFMANS, data.huffman.length);
  for (const h of data.huffman) {
    w.write(1, h.slot >> 4); w.write(2, h.slot & 15); w.write(1, h.last ? 1 : 0);
    for (const n of h.counts) w.writeU32(COUNTS, n);
    for (const s of h.symbols) w.writeU32(SYMBOLS, s);
  }
  for (const scan of data.scans) {
    w.writeU32(FOUR, scan.components.length); w.write(6, scan.ss); w.write(6, scan.se); w.write(4, scan.al); w.write(4, scan.ah);
    for (const c of scan.components) { w.write(2, c.index); w.write(2, c.ac); w.write(2, c.dc); }
    w.write(2, 0);
  }
  if (data.markers.includes(221)) w.write(16, data.restart);
  for (const scan of data.scans) {
    w.writeU32(EVENTS, scan.resets.length); let previous = -1;
    for (const block of scan.resets) { w.writeU32(BLOCK, block - previous - 1); previous = block; }
    w.writeU32(EVENTS, scan.zeros.length); previous = -1;
    for (const {block, count} of scan.zeros) { w.writeU32([[0, 1], [2, 2], [4, 5], [8, 20]], count); w.writeU32(BLOCK, block - previous - 1); previous = block; }
  }
  for (const part of data.inter) w.write(16, part.length);
  w.writeU32(TAIL, data.tail.length);
  w.write(1, data.padding ? 1 : 0);
  if (data.padding) { w.write(24, data.padding.length); for (const bit of data.padding) w.write(1, bit); }
  w.zeroPadToByte();
  const payload = [...data.apps, ...data.comments, ...data.inter, data.tail].reduce((n, part) => n + part.length, 0);
  if (payload > RECONSTRUCTION_PAYLOAD_BYTES) throw jpegError('metadata past ' + RECONSTRUCTION_PAYLOAD_BYTES + ' bytes');
  const raw = concatenate([...data.apps, ...data.comments, ...data.inter, data.tail]);
  let packed = brotliStore(raw);
  if (raw.length > 32) {
    const literalContexts = effort >= 7 || effort >= contextsFrom && raw.length <= CONTEXT_BYTES;
    try { const compressed = compressBrotli(raw, {literalContexts, kernels: kernelHooks.entropy?.()}); if (compressed.length < packed.length) packed = compressed; }
    catch (error) { if (error.code !== 'JXL_SIZE' && error.code !== 'JXL_INPUT') throw error; }
  }
  return concatenate([w.finish(), packed]);
}

const TAGS = ['cprt', 'wtpt', 'bkpt', 'rXYZ', 'gXYZ', 'bXYZ', 'kXYZ', 'rTRC', 'gTRC', 'bTRC', 'kTRC', 'chad', 'desc', 'chrm', 'dmnd', 'dmdd', 'lumi'];
const TYPES = ['XYZ ', 'desc', 'text', 'mluc', 'para', 'curv', 'sf32', 'gbd '];
const HEADER = /* @__PURE__ */ Uint8Array.of(0, 0, 0, 0, 0, 0, 0, 0, 4, 0, 0, 0, 109, 110, 116, 114, 82, 71, 66, 32, 88, 89, 90, 32, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 97, 99, 115, 112, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 246, 214, 0, 1, 0, 0, 0, 0, 211, 45, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0);
const chars = text => [text.charCodeAt(0), text.charCodeAt(1), text.charCodeAt(2), text.charCodeAt(3)];
const sameTag = (a, text) => a.length === 4 && chars(text).every((c, i) => a[i] === c);
function shuffleBytes(data, width) {
  const size = data.length, height = Math.ceil(size / width), out = new Uint8Array(size);
  let column = 0, at = 0;
  for (let i = 0; i < size; i++) { out[i] = data[at]; at += height; if (at >= size) at = ++column; }
  return out;
}
function predictByte(data, start, i, stride, width, order) {
  const predict = (p1, p2, p3, mask) => { const value = order === 0 ? p1 : order === 1 ? 2 * p1 - p2 : 3 * p1 - 3 * p2 + p3; return value & mask; };
  if (width === 1) return predict(data[start + i - stride], data[start + i - stride * 2], data[start + i - stride * 3], 255);
  if (width === 2) {
    const p = start + (i & ~1), pair = at => (data[at] << 8) + data[at + 1], value = predict(pair(p - stride), pair(p - stride * 2), pair(p - stride * 3), 65535);
    return i & 1 ? value & 255 : value >>> 8;
  }
  const p = start + (i & ~3), word = at => at < 0 ? 0 : ((data[at] << 24) | (data[at + 1] << 16) | (data[at + 2] << 8) | data[at + 3]) >>> 0;
  const value = predict(word(p - stride), word(p - stride * 2), word(p - stride * 3), 0xffffffff);
  return (value >>> ((3 - (i & 3)) * 8)) & 255;
}
export function unpredictICC(enc) {
  requireJPEG(enc instanceof Uint8Array && enc.length >= 2);
  let pos = 0;
  const varint = () => {
    let value = 0, scale = 1;
    for (let i = 0; i < 10; i++, scale *= 128) {
      requireJPEG(pos < enc.length);
      const byte = enc[pos++]; value += (byte & 127) * scale;
      if (!(byte & 128)) return value;
    }
    requireJPEG(false);
  };
  const osize = varint(), csize = varint();
  requireJPEG(osize <= 268435456 && Number.isSafeInteger(csize) && pos + csize <= enc.length);
  const command = {at: pos}, data = pos + csize; pos = data;
  const commandVarint = () => { const saved = pos; pos = command.at; const value = varint(); command.at = pos; pos = saved; return value; };
  const out = new Uint8Array(osize); let at = 0;
  const push = byte => { requireJPEG(at < osize); out[at++] = byte & 255; };
  const be = value => { push(value >>> 24); push(value >>> 16); push(value >>> 8); push(value); };
  const header = HEADER.slice(); header[0] = osize >>> 24; header[1] = (osize >>> 16) & 255; header[2] = (osize >>> 8) & 255; header[3] = osize & 255;
  for (let i = 0; i <= 128; i++) {
    if (at === osize) { requireJPEG(command.at === data && pos === enc.length); return out; }
    if (i === 128) break;
    if (i === 8 && at >= 8) header.set(out.subarray(4, 8), 80);
    if (i === 41 && at >= 41) { if (out[40] === 65) header.set([80, 80, 76], 41); if (out[40] === 77) header.set([83, 70, 84], 41); }
    if (i === 42 && at >= 42 && out[40] === 83) { if (out[41] === 71) header.set([73, 32], 42); if (out[41] === 85) header.set([78, 87], 42); }
    requireJPEG(pos < enc.length); push(enc[pos++] + header[i]);
  }
  requireJPEG(command.at < data);
  let numtags = commandVarint();
  if (numtags) {
    numtags--; requireJPEG(numtags <= 0xffffffff); be(numtags);
    let previousStart = 128 + numtags * 12, previousSize = 0;
    for (;;) {
      requireJPEG(at <= osize && command.at <= data);
      if (command.at === data) break;
      const code = enc[command.at++], tagcode = code & 63; let tag;
      if (!tagcode) break;
      if (tagcode === 1) { requireJPEG(pos + 4 <= enc.length); tag = enc.subarray(pos, pos += 4); }
      else if (tagcode === 2) tag = chars('rTRC');
      else if (tagcode === 3) tag = chars('rXYZ');
      else { requireJPEG(tagcode >= 4 && tagcode - 4 < TAGS.length); tag = chars(TAGS[tagcode - 4]); }
      for (const byte of tag) push(byte);
      let tagSize = previousSize;
      if (['rXYZ', 'gXYZ', 'bXYZ', 'kXYZ', 'wtpt', 'bkpt', 'lumi'].some(name => sameTag(tag, name))) tagSize = 20;
      const tagStart = code & 64 ? commandVarint() : previousStart + previousSize;
      requireJPEG(tagStart <= 0xffffffff); be(tagStart);
      if (code & 128) tagSize = commandVarint();
      requireJPEG(tagSize <= 0xffffffff); be(tagSize);
      previousStart = tagStart; previousSize = tagSize;
      if (tagcode === 2) { for (const name of ['gTRC', 'bTRC']) { for (const byte of chars(name)) push(byte); be(tagStart); be(tagSize); } }
      if (tagcode === 3) { requireJPEG(tagStart + tagSize * 2 <= 0xffffffff); for (const [name, shift] of [['gXYZ', 1], ['bXYZ', 2]]) { for (const byte of chars(name)) push(byte); be(tagStart + tagSize * shift); be(tagSize); } }
    }
  }
  for (;;) {
    requireJPEG(at <= osize && command.at <= data);
    if (command.at === data) break;
    const code = enc[command.at++];
    if (code === 1 || code === 2 || code === 3) {
      const count = commandVarint(); requireJPEG(pos + count <= enc.length);
      let bytes = enc.subarray(pos, pos + count);
      if (code !== 1) bytes = shuffleBytes(bytes, code === 2 ? 2 : 4);
      for (const byte of bytes) push(byte); pos += count;
    } else if (code === 4) {
      requireJPEG(command.at + 2 <= data);
      const flags = enc[command.at++], width = (flags & 3) + 1, order = (flags >> 2) & 3;
      requireJPEG(width !== 3 && order !== 3);
      const stride = flags & 16 ? commandVarint() : width;
      requireJPEG(stride >= width && at && ((at - 1) >>> 2) >= stride && command.at < data);
      const count = commandVarint(); requireJPEG(pos + count <= enc.length);
      let bytes = enc.subarray(pos, pos + count); if (width > 1) bytes = shuffleBytes(bytes, width);
      const start = at;
      for (let i = 0; i < count; i++) push(predictByte(out, start, i, stride, width, order) + bytes[i]);
      pos += count;
    } else if (code === 10) {
      for (const byte of chars('XYZ ')) push(byte); for (let i = 0; i < 4; i++) push(0);
      requireJPEG(pos + 12 <= enc.length); for (let i = 0; i < 12; i++) push(enc[pos++]);
    } else if (code >= 16 && code < 16 + TYPES.length) {
      for (const byte of chars(TYPES[code - 16])) push(byte); for (let i = 0; i < 4; i++) push(0);
    } else requireJPEG(false);
  }
  requireJPEG(pos === enc.length && at === osize); return out;
}
const EXIF_TAG = /* @__PURE__ */ Uint8Array.of(69, 120, 105, 102, 0, 0), ICC_TAG = /* @__PURE__ */ Uint8Array.of(73, 67, 67, 95, 80, 82, 79, 70, 73, 76, 69, 0);
const XMP_TAG = /* @__PURE__ */ Uint8Array.from('http://ns.adobe.com/xap/1.0/\0', char => char.charCodeAt(0));
function materializeApps(apps, take, {icc, exif, xml} = {}) {
  const iccCount = apps.reduce((n, app) => n + (app.type === 1), 0); let sequence = 0, iccAt = 0, exifDone = false, xmlDone = false;
  const filled = apps.map(app => {
    const out = new Uint8Array(app.length); out[1] = (app.length - 1) >> 8; out[2] = (app.length - 1) & 255;
    if (!app.type) { out.set(take(app.length)); requireJPEG(out[1] * 256 + out[2] + 1 === out.length); return out; }
    if (app.type === 1) {
      const n = app.length - 17; requireJPEG(n >= 0 && icc && iccAt + n <= icc.length);
      out[0] = 226; out.set(ICC_TAG, 3); out[15] = ++sequence; out[16] = iccCount; out.set(icc.subarray(iccAt, iccAt += n), 17); return out;
    }
    if (app.type === 2) {
      requireJPEG(!exifDone && exif && exif.length >= 4 && app.length === exif.length + 5);
      out[0] = 225; out.set(EXIF_TAG, 3); out.set(exif.subarray(4), 9); exifDone = true; return out;
    }
    requireJPEG(!xmlDone && xml && app.length === xml.length + 32);
    out[0] = 225; out.set(XMP_TAG, 3); out.set(xml, 32); xmlDone = true; return out;
  });
  requireJPEG(!iccCount || iccAt === icc.length); return filled;
}
function readData(bytes, sources = {}) {
  const r = new JxlBits(bytes), grey = r.read(1), data = {markers: [], apps: [], comments: [], quant: [], huffman: [], scans: [], inter: [], restart: 0};
  for (;;) { const marker = r.read(6) + 192; data.markers.push(marker); requireJPEG(data.markers.length <= 16384); if (marker === 217) break; }
  const size = n => { requireJPEG(n >= 3 && n <= 65536); return n; };
  for (const marker of data.markers) if (marker >= 224 && marker <= 239) {
    const type = r.u32([[0, 0], [0, 1], [1, 2], [2, 4]]);
    requireJPEG(type <= 3); data.apps.push({type, length: size(r.read(16) + 1)});
  }
  for (const marker of data.markers) if (marker === 254) data.comments.push(size(r.read(16) + 1));
  const quantCount = r.u32(FOUR); requireJPEG(quantCount < 4);
  for (let i = 0; i < quantCount; i++) data.quant.push({precision: r.read(1), index: r.read(2), last: !!r.read(1)});
  const type = r.read(2), ids = type === 3 ? Array.from({length: r.u32(FOUR)}, () => r.read(8)) : type === 0 ? [1] : type === 1 ? [1, 2, 3] : [82, 71, 66];
  requireJPEG(ids.length === (grey ? 1 : 3) && new Set(ids).size === ids.length);
  data.components = ids.map(id => ({id, quant: r.read(2)})); requireJPEG(data.components.every(c => c.quant < quantCount));
  const huffmanCount = r.u32(HUFFMANS);
  for (let i = 0; i < huffmanCount; i++) {
    const slot = (r.read(1) << 4) | r.read(2), last = !!r.read(1), counts = Array.from({length: 17}, () => r.u32(COUNTS));
    const n = counts.reduce((a, b) => a + b, 0); requireJPEG(n >= 2 && n <= 257 && !counts[0]);
    const symbols = Array.from({length: n}, () => r.u32(SYMBOLS));
    requireJPEG(symbols.at(-1) === 256 && new Set(symbols).size === n && ((slot & 16) || symbols.slice(0, -1).every(v => v < 16)));
    data.huffman.push({slot, last, counts, symbols});
  }
  for (const marker of data.markers) if (marker === 218) {
    const count = r.u32(FOUR), ss = r.read(6), se = r.read(6), al = r.read(4), ah = r.read(4);
    requireJPEG(count <= ids.length && ss <= se && al <= 13 && ah <= 13);
    const components = Array.from({length: count}, () => ({index: r.read(2), ac: r.read(2), dc: r.read(2)}));
    requireJPEG(components.every(c => c.index < ids.length) && new Set(components.map(c => c.index)).size === count);
    const pass = r.u32([[0, 0], [0, 1], [0, 2], [3, 3]]); requireJPEG(pass <= 10);
    data.scans.push({components, ss, se, al, ah, resets: [], zeros: []});
  }
  if (data.markers.includes(221)) data.restart = r.read(16);
  let events = 0;
  const admitScanEvent = () => { if (++events > RECONSTRUCTION_SCAN_EVENTS) throw fault('JXL_RECONSTRUCTION', `JPEG reconstruction data has over ${RECONSTRUCTION_SCAN_EVENTS} scan events.`); };
  for (const scan of data.scans) {
    let previous = -1;
    for (let n = r.u32(EVENTS); n; n--) { admitScanEvent(); previous += 1 + r.u32(BLOCK); requireJPEG(previous < 201326592); scan.resets.push(previous); }
    previous = -1;
    for (let n = r.u32(EVENTS); n; n--) { admitScanEvent(); const count = r.u32([[0, 1], [2, 2], [4, 5], [8, 20]]); previous += 1 + r.u32(BLOCK); requireJPEG(previous < 201326592 && count <= 4); scan.zeros.push({block: previous, count}); }
  }
  for (const marker of data.markers) if (marker === 255) data.inter.push(r.read(16));
  data.tail = r.u32(TAIL); requireJPEG(data.tail <= 4260096);
  data.padding = null;
  if (r.read(1)) {
    const count = r.read(24); requireJPEG(count <= 16777216);
    data.padding = Uint8Array.from({length: count}, () => r.read(1));
    requireJPEG(data.padding.every(bit => bit <= 1));
  }
  r.align();
  const brotliBytes = data.tail + data.comments.reduce((n, v) => n + v, 0) + data.inter.reduce((n, v) => n + v, 0) + data.apps.reduce((n, app) => n + (app.type ? 0 : app.length), 0);
  requireJPEG(brotliBytes <= RECONSTRUCTION_PAYLOAD_BYTES);
  let raw;
  const brotliInput = bytes.subarray(Math.floor(r.bit / 8));
  const brotliCap = Math.max(brotliBytes, 1);
  try { raw = openBrotli(brotliInput, brotliCap); }
  catch (error) {
    if (error.code === 'JXL_SIZE' || error.code === 'JXL_DICTIONARY') throw error;
    requireJPEG(false);
  }
  requireJPEG(raw.length === brotliBytes);
  let at = 0;
  const take = n => { const part = raw.subarray(at, at += n); requireJPEG(part.length === n); return part; };
  data.apps = materializeApps(data.apps, take, sources);
  data.comments = data.comments.map(n => { const part = take(n); requireJPEG(part[1] * 256 + part[2] + 1 === part.length); return part; });
  data.inter = data.inter.map(take);
  data.tail = take(data.tail); requireJPEG(at === raw.length); return data;
}

export const JBRD_TAIL = 4260096, MAX_NESTING = 4, TAIL_BYTES = 256 << 20;
const GAIN_MAP = 0x6a68676d, ISO_GAIN_MAP = 'urn:iso:std:iso:ts:21496:-1\0';
const UUID = 0x75756964, RAPIER_TAIL = /* @__PURE__ */ Uint8Array.of(0xac, 0x02, 0x9a, 0x3b, 0x18, 0x88, 0x4a, 0x6d, 0x9b, 0x2c, 0xf7, 0x91, 0x12, 0x75, 0xbb, 0x1b);
export function admitTail(length) {
  if (length > RECONSTRUCTION_PAYLOAD_BYTES) throw jpegError('data after the JPEG past ' + RECONSTRUCTION_PAYLOAD_BYTES + ' bytes');
}
export function withTail(file, kind, length, parts, gainMap = null) {
  admitTail(length);
  const body = parts.length === 1 ? parts[0] : concatenate(parts), header = boxHeader(UUID, 22 + body.length);
  if (gainMap) file = concatenate([file, boxHeader(GAIN_MAP, gainMap.length), gainMap]);
  const size = file.length + header.length + 22 + body.length;
  admitOutputSize(size);
  const out = new Uint8Array(size);
  out.set(file); out.set(header, file.length);
  let at = file.length + header.length;
  out.set(RAPIER_TAIL, at); out[at + 16] = 1; out[at + 17] = kind; new DataView(out.buffer).setUint32(at + 18, length); out.set(body, at + 22);
  return out;
}
export function packTail(tail) {
  try { const compressed = compressBrotli(tail, {literalContexts: false, kernels: kernelHooks.entropy?.()}); if (compressed.length < tail.length) return compressed; }
  catch (error) { if (error.code !== 'JXL_SIZE' && error.code !== 'JXL_INPUT') throw error; }
  return brotliStore(tail);
}
export function isoGainMap(jpeg) {
  for (let at = 2; at + 4 <= jpeg.length && jpeg[at] === 0xFF;) {
    const marker = jpeg[at + 1], length = jpeg[at + 2] << 8 | jpeg[at + 3];
    if (marker === 0xDA || marker === 0xD9) break;
    const body = jpeg.subarray(at + 4, at + 2 + length);
    if (marker === 0xE2 && body.length >= ISO_GAIN_MAP.length + 4 &&
        [...ISO_GAIN_MAP].every((c, i) => body[i] === c.charCodeAt(0))) return body.subarray(ISO_GAIN_MAP.length);
    at += 2 + length;
  }
  return null;
}
export function mpfImages(jpeg) {
  for (let at = 2; at + 4 <= jpeg.length && jpeg[at] === 0xFF;) {
    const marker = jpeg[at + 1], length = jpeg[at + 2] << 8 | jpeg[at + 3], body = at + 4, end = at + 2 + length;
    if (marker === 0xDA || marker === 0xD9 || length < 2 || end > jpeg.length) return [];
    if (marker === 0xE2 && length >= 16 && jpeg[body] === 77 && jpeg[body + 1] === 80 && jpeg[body + 2] === 70 && jpeg[body + 3] === 0) {
      const tiff = body + 4, order = jpeg[tiff] << 8 | jpeg[tiff + 1], view = new DataView(jpeg.buffer, jpeg.byteOffset, jpeg.byteLength);
      if (order !== 0x4949 && order !== 0x4D4D) return [];
      const little = order === 0x4949, u16 = p => view.getUint16(p, little), u32 = p => view.getUint32(p, little);
      if (tiff + 8 > end || u16(tiff + 2) !== 42) return [];
      const ifd = tiff + u32(tiff + 4);
      if (ifd < tiff + 8 || ifd + 2 > end) return [];
      const count = u16(ifd);
      if (!count || ifd + 2 + 12 * count + 4 > end) return [];
      for (let i = 0; i < count; i++) {
        const entry = ifd + 2 + 12 * i;
        if (u16(entry) !== 0xB002) continue;
        const bytes = u32(entry + 4), list = tiff + u32(entry + 8);
        if (u16(entry + 2) !== 7 || bytes % 16 || bytes < 32 || list < tiff + 8 || list + bytes > end || u32(list + 8) !== 0) return [];
        const images = [];
        for (let k = 1; k < bytes / 16; k++) {
          const size = u32(list + 16 * k + 4), offset = u32(list + 16 * k + 8), start = tiff + offset;
          if (!offset || size < 4 || start + size > jpeg.length) continue;
          if (jpeg[start] === 0xFF && jpeg[start + 1] === 0xD8 && jpeg[start + size - 2] === 0xFF && jpeg[start + size - 1] === 0xD9) images.push({start, size});
        }
        return images;
      }
      return [];
    }
    at = end;
  }
  return [];
}
export function gainMapOf(file, metadata) {
  const kept = [];
  let codestream = null;
  for (const box of boxes(file)) {
    if (box.type === CODESTREAM && !codestream) codestream = file.subarray(box.body, box.end);
    else kept.push(file.subarray(box.at, box.end));
  }
  const bundle = concatenate([Uint8Array.of(0, metadata.length >> 8, metadata.length & 255), metadata, Uint8Array.of(0, 0, 0, 0, 0), codestream]);
  return {bundle, rest: concatenate([file.subarray(0, 12), ...kept])};
}
function gainMapCodestream(bytes) {
  for (const box of boxes(bytes)) if (box.type === GAIN_MAP) {
    const body = bytes.subarray(box.body, box.end);
    requireJPEG(body.length >= 3 && body[0] === 0);
    let at = 3 + (body[1] << 8 | body[2]);
    requireJPEG(at < body.length); at += 1 + body[at];
    requireJPEG(at + 4 <= body.length); at += 4 + new DataView(body.buffer, body.byteOffset).getUint32(at);
    requireJPEG(at < body.length); return body.subarray(at);
  }
  requireJPEG(false);
}

function tailOf(bytes) {
  let found = null;
  for (const box of boxes(bytes)) if (box.type === UUID && box.end - box.body >= 16 && RAPIER_TAIL.every((v, i) => bytes[box.body + i] === v)) {
    requireJPEG(!found && box.end - box.body >= 22); found = bytes.subarray(box.body + 16, box.end);
  }
  return found;
}
function openTail(box, maxPixels, bands, depth, bytes, budget) {
  requireJPEG(box[0] === 1 && box[1] <= 2 && (!box[1] || depth + 2 <= MAX_NESTING));
  const view = new DataView(box.buffer, box.byteOffset, box.byteLength), length = view.getUint32(2);
  requireJPEG(length <= RECONSTRUCTION_PAYLOAD_BYTES && length <= budget.left && box.length >= (box[1] ? 10 : 6));
  budget.left -= length;
  const packed = box[1] ? view.getUint32(6) : box.length - 6, body = box.subarray(box[1] ? 10 : 6);
  requireJPEG(packed <= body.length);
  let raw;
  try { raw = openBrotli(body.subarray(0, packed), Math.max(length, 1)); } catch (error) { if (error.code === 'JXL_SIZE' || error.code === 'JXL_DICTIONARY') throw error; requireJPEG(false); }
  requireJPEG(raw.length === length);
  if (!box[1]) return raw;
  let file = body.subarray(packed);
  if (box[1] === 2) { const codestream = gainMapCodestream(bytes); file = concatenate([file, boxHeader(CODESTREAM, codestream.length), codestream]); }
  const next = restore(file, maxPixels, bands, depth + 1, budget); requireJPEG(next && next.length <= budget.left);
  budget.left -= next.length;
  requireJPEG(raw.length + next.length <= budget.left); budget.left -= raw.length + next.length;
  return concatenate([raw, next]);
}

export const carryJPEG = (bytes, jpeg, codestream, effort, contextsFrom) => complete(carryJPEGSteps(bytes, jpeg, codestream, effort, contextsFrom));
export function* carryJPEGSteps(bytes, jpeg, codestream, effort = 1, contextsFrom = 7) {
  try {
    const data = yield* unit('structure', () => structure(bytes, jpeg));
    if (!(yield* stage('check', () => writeJPEGSteps(jpeg, data, bytes)))) throw jpegError('JPEG syntax cannot be reconstructed exactly');
    return withJPEGReconstruction(codestream, yield* unit('data', () => writeData(data, effort, contextsFrom)));
  } catch (error) {
    if (error.code === 'JXL_RECONSTRUCTION') throw jpegError('JPEG syntax cannot be reconstructed exactly');
    throw error;
  }
}

const CHUNK = 1 << 20;
class JPEGOutput {
  constructor(expected = null, limit = Infinity) {
    this.limit = limit;
    this.expected = expected; this.same = true; this.chunks = []; this.done = 0;
    this.bytes = new Uint8Array(expected ? Math.min(CHUNK, expected.length + 16) : 4096); this.at = 0; this.acc = 0; this.pending = 0;
  }
  spill(n) {
    const filled = this.bytes.subarray(0, this.at), total = this.done + this.at;
    admitOutputSize(total + n); requireJPEG(total + n <= this.limit);
    if (this.expected) {
      const expected = this.expected;
      if (this.same) for (let i = 0; i < filled.length; i++) if (filled[i] !== expected[this.done + i]) { this.same = false; break; }
      if (total + n > expected.length + 16) this.same = false;
    } else this.chunks.push(filled);
    this.done = total; this.at = 0;
    if (n > this.bytes.length || !this.expected) this.bytes = new Uint8Array(Math.max(n, Math.min(this.expected ? this.bytes.length : Math.min(CHUNK, Math.max(4096, total)), this.limit - total)));
  }
  reserve(n) { if (this.at + n > this.bytes.length) this.spill(n); }
  byte(v) { if (this.at >= this.bytes.length) this.spill(1); this.bytes[this.at++] = v; }
  chunk(bytes) {
    if (!(bytes instanceof Uint8Array)) bytes = Uint8Array.from(bytes);
    for (let from = 0; from < bytes.length;) {
      if (this.at === this.bytes.length) this.spill(1);
      const n = Math.min(bytes.length - from, this.bytes.length - this.at);
      this.bytes.set(bytes.subarray(from, from + n), this.at); this.at += n; from += n;
    }
  }
  marker(v) { requireJPEG(!this.pending); this.byte(255); this.byte(v); }
  segment(marker, data) { requireJPEG(data.length <= 65533); this.marker(marker); this.byte((data.length + 2) >> 8); this.byte((data.length + 2) & 255); this.chunk(data); }
  bits(n, value) {
    requireJPEG(n >= 0 && n <= 16 && value >= 0 && value < (1 << n));
    this.put(n, value);
  }
  put(n, value) {
    let acc = (this.acc << n) | value, pending = this.pending + n;
    if (pending >= 8) {
      if (this.at + 6 > this.bytes.length) this.reserve(6);
      const bytes = this.bytes;
      do {
        pending -= 8; const byte = (acc >>> pending) & 255;
        bytes[this.at++] = byte; if (byte === 255) bytes[this.at++] = 0;
      } while (pending >= 8);
      acc &= (1 << pending) - 1;
    }
    this.acc = acc; this.pending = pending;
  }
  align(pad) {
    const n = (-this.pending) & 7;
    if (!n) return;
    if (!pad) { this.bits(n, (1 << n) - 1); return; }
    let pattern = 0;
    for (let i = 0; i < n; i++) { requireJPEG(pad.at < pad.bits.length && pad.bits[pad.at] <= 1); pattern = pattern * 2 + pad.bits[pad.at++]; }
    this.bits(n, pattern);
  }
  finish() {
    requireJPEG(!this.pending);
    this.spill(0);
    if (this.expected) return this.same && this.done === this.expected.length;
    const chunks = this.chunks, bytes = new Uint8Array(this.done);
    for (let i = 0, at = 0; i < chunks.length; at += chunks[i].length, chunks[i++] = null) bytes.set(chunks[i], at);
    this.chunks = []; return bytes;
  }
}
const category = value => value ? 32 - Math.clz32(value < 0 ? -value : value) : 0;
function jpegCode(h) {
  const words = new Int32Array(257);
  let code = 0, at = 0;
  for (let n = 1; n <= 16; n++) {
    requireJPEG(code + h.counts[n] <= (1 << n));
    for (let j = 0; j < h.counts[n]; j++) { const s = h.symbols[at++]; words[s] = (n << 16) | code++; }
    code *= 2;
  }
  return words;
}
const NO_CODE = /* @__PURE__ */ new Int32Array(257);
const NATURAL = /* @__PURE__ */ Int32Array.from(ZIGZAG);
function coded(out, word, n, extra) {
  const length = (word >>> 16) + n;
  if (length <= 24) out.put(length, (word & 65535) << n | extra);
  else { out.put(word >>> 16, word & 65535); out.put(n, extra); }
}
function sequentialBlock(out, co, at, dc, ac, predictor, extra) {
  const current = co[at], difference = current - predictor;
  let n = category(difference), word = dc[n]; requireJPEG(n <= 11 && word);
  coded(out, word, n, difference < 0 ? difference + (1 << n) - 1 : difference);
  let run = 0;
  for (let k = 1; k < 64; k++) {
    const v = co[at + NATURAL[k]];
    if (!v) { run++; continue; }
    for (; run >= 16; run -= 16) { word = ac[240]; requireJPEG(word); out.put(word >>> 16, word & 65535); }
    n = category(v); word = ac[(run << 4) | n]; requireJPEG(n <= 10 && word);
    coded(out, word, n, v < 0 ? v + (1 << n) - 1 : v); run = 0;
  }
  if (extra) {
    requireJPEG(run >= extra * 16); run -= extra * 16;
    for (let i = 0; i < extra; i++) { word = ac[240]; requireJPEG(word); out.put(word >>> 16, word & 65535); }
  }
  if (run) { word = ac[0]; requireJPEG(word); out.put(word >>> 16, word & 65535); }
  return current;
}
class ScanWriter {
  constructor(out, scan, zeros) {
    this.out = out; this.ss = scan.ss; this.se = scan.se; this.al = scan.al; this.ah = scan.ah; this.zeros = zeros;
    this.blockIndex = 0; this.eob = 0; this.eobTable = NO_CODE; this.pending = new Uint8Array(1024); this.pendingBits = 0;
    this.corrections = new Uint8Array(64); this.band = bandMask(scan.ss, scan.se);
  }
  emit(word) { requireJPEG(word); this.out.put(word >>> 16, word & 65535); }
  extra() { return this.zeros ? this.zeros.get(this.blockIndex) || 0 : 0; }
  hold(n) {
    if (this.pendingBits + n > this.pending.length) {
      const grown = new Uint8Array(Math.max(this.pending.length * 2, this.pendingBits + n)); grown.set(this.pending.subarray(0, this.pendingBits)); this.pending = grown;
    }
    this.pending.set(this.corrections.subarray(0, n), this.pendingBits); this.pendingBits += n;
  }
  flush() {
    const out = this.out;
    if (this.eob) { const n = category(this.eob) - 1, word = this.eobTable[n << 4]; requireJPEG(word); coded(out, word, n, this.eob - (1 << n)); this.eob = 0; }
    for (let i = 0; i < this.pendingBits; i++) out.put(1, this.pending[i]);
    this.pendingBits = 0;
  }
  endBand(table, held) {
    this.eobTable = table; this.eob++; if (held) this.hold(held);
    if (this.eob === 32767) this.flush();
  }
  sequential(entry, at, preds) {
    preds[entry.index] = sequentialBlock(this.out, entry.co, at, entry.dc, entry.ac, preds[entry.index], this.extra());
    this.blockIndex++;
  }
  progressive(entry, at, preds) {
    const co = entry.co, ac = entry.ac, out = this.out, {ss, se, al, ah} = this;
    if (!ss) {
      if (ah) out.put(1, (co[at] >> al) & 1);
      else {
        const current = co[at] >> al, difference = current - preds[entry.index], n = category(difference), word = entry.dc[n];
        requireJPEG(n <= 11 && word); coded(out, word, n, difference < 0 ? difference + (1 << n) - 1 : difference); preds[entry.index] = current;
      }
      this.blockIndex++; return;
    }
    const masks = entry.nonzero, band = this.band, first = masks[at >> 5] & band[0], second = masks[(at >> 5) + 1] & band[1];
    if (!ah) {
      let previous = ss - 1;
      for (let low = first, high = second; low || high;) {
        let k;
        if (low) { const bit = low & -low; k = 31 - Math.clz32(bit); low ^= bit; } else { const bit = high & -high; k = 63 - Math.clz32(bit); high ^= bit; }
        const c = co[at + NATURAL[k]], v = c < 0 ? -(-c >> al) : c >> al;
        if (!v) continue;
        let run = k - previous - 1;
        if (this.eob || this.pendingBits) this.flush();
        for (; run >= 16; run -= 16) this.emit(ac[240]);
        const n = category(v), word = ac[(run << 4) | n]; requireJPEG(n <= 10 && word);
        coded(out, word, n, v < 0 ? v + (1 << n) - 1 : v); previous = k;
      }
      let run = se - previous;
      const extra = this.extra();
      if (extra) { this.flush(); requireJPEG(run >= extra * 16); for (let i = 0; i < extra; i++) this.emit(ac[240]); run -= extra * 16; }
      if (run) this.endBand(ac, 0);
    } else {
      requireJPEG(ah === al + 1);
      const corrections = this.corrections;
      let lastNew = ss - 1, run = 0, held = 0, previous = ss - 1;
      for (let low = first, high = second; low || high;) {
        let k;
        if (low) { const bit = low & -low; k = 31 - Math.clz32(bit); low ^= bit; } else { const bit = high & -high; k = 63 - Math.clz32(bit); high ^= bit; }
        const c = co[at + NATURAL[k]]; if (((c < 0 ? -c : c) >> al) === 1) lastNew = k;
      }
      for (let low = first, high = second; low || high;) {
        let k;
        if (low) { const bit = low & -low; k = 31 - Math.clz32(bit); low ^= bit; } else { const bit = high & -high; k = 63 - Math.clz32(bit); high ^= bit; }
        const original = co[at + NATURAL[k]], magnitude = (original < 0 ? -original : original) >> al;
        if (!magnitude) continue;
        run += k - previous - 1; previous = k;
        while (run >= 16 && k <= lastNew) {
          this.flush(); this.emit(ac[240]); run -= 16;
          for (let i = 0; i < held; i++) out.put(1, corrections[i]);
          held = 0;
        }
        if (magnitude > 1) corrections[held++] = magnitude & 1;
        else {
          this.flush(); this.emit(ac[(run << 4) | 1]); out.put(1, original > 0 ? 1 : 0);
          for (let i = 0; i < held; i++) out.put(1, corrections[i]);
          held = 0; run = 0;
        }
      }
      run += se - previous;
      if (run || held) this.endBand(ac, held);
    }
    this.blockIndex++;
  }
}
const ZIGZAG_OF = /* @__PURE__ */ new Int32Array(64);
for (let k = 0; k < 64; k++) ZIGZAG_OF[NATURAL[k]] = k;
function nonzeroMasks(component) {
  const co = component.coeffs, blocks = co.length >> 6, masks = new Int32Array(blocks * 2);
  for (let b = 0, at = 0; b < blocks; b++, at += 64) {
    let low = 0, high = 0;
    for (let i = 1; i < 64; i++) if (co[at + i]) { const k = ZIGZAG_OF[i]; if (k < 32) low |= 1 << k; else high |= 1 << (k - 32); }
    masks[2 * b] = low; masks[2 * b + 1] = high;
  }
  return masks;
}
const upTo = k => k >= 31 ? -1 : k < 0 ? 0 : (1 << (k + 1)) - 1;
const bandMask = (ss, se) => [upTo(Math.min(se, 31)) & ~upTo(ss - 1), upTo(se - 32) & ~upTo(ss - 33)];
function* writeScan(out, jpeg, scan, huffman, restart, progressive, pad, nonzero) {
  const {ss, se, al, ah} = scan, components = jpeg.components, bands = jpeg.rows?.();
  requireJPEG(progressive ? !bands && (ss === 0 ? se === 0 : scan.components.length === 1) : ss === 0 && se === 63 && !al && !ah);
  const preds = new Int32Array(components.length);
  const resets = Int32Array.from(scan.resets).sort(), writer = new ScanWriter(out, scan, scan.zeros.length ? new Map(scan.zeros.map(z => [z.block, z.count])) : null);
  const entries = scan.components.map(entry => ({index: entry.index, co: components[entry.index].coeffs, row0: 0, dc: huffman[entry.dc] || NO_CODE, ac: huffman[16 + entry.ac] || NO_CODE,
    nonzero: progressive && ss ? nonzero(entry.index) : null}));
  const hmax = Math.max(...components.map(c => c.h)), vmax = Math.max(...components.map(c => c.v)), single = scan.components.length === 1;
  const lead = components[scan.components[0].index], nx = Math.ceil(jpeg.width * (single ? lead.h : 1) / (8 * hmax)), ny = Math.ceil(jpeg.height * (single ? lead.v : 1) / (8 * vmax));
  const shapes = entries.map(entry => { const c = components[entry.index]; return {stride: c.stride, h: single ? 1 : c.h, v: single ? 1 : c.v}; });
  if (!progressive && !bands) {
    const written = kernelHooks.entropy?.()?.sequentialScan(out, entries.map((entry, e) => ({...entry, ...shapes[e]})), nx, ny, restart,
      writer.zeros || new Map(), pad, NATURAL);
    if (written === null) requireJPEG(false);
    if (written) {
      const blocks = nx * ny * shapes.reduce((n, {h, v}) => n + h * v, 0);
      requireJPEG(scan.resets.every(n => n < blocks) && scan.zeros.every(z => z.block < blocks)); out.align(pad);
      return;
    }
  }
  let nextReset = 0;
  const per = 32 * (single ? lead.v : 1) / vmax, banded = bands && jpeg.band && out.expected;
  const rows = (from, to) => {
  for (let m = from * nx, y = from; y < to; y++) {
    if (bands && !(y % per)) {
      if (banded) { jpeg.band(y / per); for (const e of entries) ({coeffs: e.co, row0: e.row0} = components[e.index]); }
      else { const band = bands.next().value?.components ?? requireJPEG(0); for (const e of entries) ({coeffs: e.co, row0: e.row0} = band[e.index]); }
    }
    for (let x = 0; x < nx; x++, m++) {
      if (restart && m && m % restart === 0) { writer.flush(); out.align(pad); out.marker(208 + ((m / restart - 1) & 7)); preds.fill(0); }
      for (let e = 0; e < entries.length; e++) {
        const entry = entries[e], {stride, h, v} = shapes[e];
        for (let dy = 0; dy < v; dy++) for (let dx = 0; dx < h; dx++) {
          if (resets[nextReset] === writer.blockIndex) { writer.flush(); while (resets[nextReset] === writer.blockIndex) nextReset++; }
          const at = ((y * v + dy - entry.row0) * stride + x * h + dx) * 64;
          if (progressive) writer.progressive(entry, at, preds); else writer.sequential(entry, at, preds);
        }
      }
    }
  }
  return null;
  };
  if (!banded) rows(0, ny);
  else for (let from = 0; from < ny; from += per) {
    const saved = yield* carried('scan-rows', () => rows(from, Math.min(ny, from + per)), () => {
      out.spill(0);
      return {done: out.done, same: out.same, acc: out.acc, pending: out.pending, block: writer.blockIndex, preds, nextReset, pad: pad?.at ?? 0};
    });
    if (saved === null || saved === PASSED) continue;
    Object.assign(out, {done: saved.done, same: saved.same, acc: saved.acc, pending: saved.pending, at: 0});
    writer.blockIndex = saved.block; preds.set(saved.preds); nextReset = saved.nextReset; if (pad) pad.at = saved.pad;
  }
  const blocks = writer.blockIndex;
  requireJPEG(scan.resets.every(n => n < blocks) && scan.zeros.every(z => z.block < blocks)); writer.flush(); out.align(pad);
}
const writeJPEG = (jpeg, data, expected, limit) => complete(writeJPEGSteps(jpeg, data, expected, limit));
function* writeJPEGSteps(jpeg, data, expected = null, limit = Infinity) {
  const out = new JPEGOutput(expected, limit), huffman = [], pad = data.padding ? {bits: data.padding, at: 0} : null;
  const coverage = jpeg.components.map(() => ({coverage: new Int8Array(64).fill(-1)}));
  const masks = [], nonzero = index => masks[index] ||= nonzeroMasks(jpeg.components[index]);
  let app = 0, comment = 0, inter = 0, quant = 0, table = 0, scan = 0, restart = 0, progressive = false;
  out.marker(216);
  for (const marker of data.markers) {
    if (marker >= 224 && marker <= 239 || marker === 254) {
      const part = marker === 254 ? data.comments[comment++] : data.apps[app++];
      requireJPEG(part[0] === marker && part[1] * 256 + part[2] === part.length - 1); out.byte(255); out.chunk(part);
    } else if (marker === 255) out.chunk(data.inter[inter++]);
    else if (marker === 219) {
      const body = [];
      for (;;) {
        const q = data.quant[quant++]; requireJPEG(q && q.values); body.push(q.precision * 16 + q.index);
        for (const k of ZIGZAG) { if (q.precision) body.push(q.values[k] >> 8); else requireJPEG(q.values[k] < 256); body.push(q.values[k] & 255); }
        if (q.last) break;
      }
      out.segment(marker, body);
    } else if (marker === 196) {
      const body = [];
      for (;;) {
        const h = data.huffman[table++]; requireJPEG(h);
        const counts = h.counts.slice(); let last = 16; while (!counts[last]) last--; counts[last]--;
        body.push(h.slot, ...counts.slice(1), ...h.symbols.slice(0, -1)); huffman[h.slot] = jpegCode(h);
        if (h.last) break;
      }
      out.segment(marker, body);
    } else if (marker === 192 || marker === 193 || marker === 194) {
      progressive = marker === 194;
      const body = [8, jpeg.height >> 8, jpeg.height & 255, jpeg.width >> 8, jpeg.width & 255, jpeg.components.length];
      for (const c of jpeg.components) body.push(c.id, c.h * 16 + c.v, c.tq);
      out.segment(marker, body);
    } else if (marker === 221) { restart = data.restart; out.segment(marker, [restart >> 8, restart & 255]); }
    else if (marker === 218) {
      const info = data.scans[scan++], body = [info.components.length];
      try { admitScan({progressive}, info.components.map(c => ({component: coverage[c.index]})), info.ss, info.se, info.ah, info.al); }
      catch (error) { if (error.code !== 'JXL_JPEG') throw error; requireJPEG(false); }
      for (const c of info.components) body.push(jpeg.components[c.index].id, c.dc * 16 + c.ac);
      body.push(info.ss, info.se, info.ah * 16 + info.al); out.segment(marker, body);
      yield* writeScan(out, jpeg, info, huffman, restart, progressive, pad, nonzero);
    } else if (marker === 217) { out.marker(marker); out.chunk(data.tail); }
    else if (marker >= 208 && marker <= 215) out.marker(marker);
    else requireJPEG(false);
  }
  requireJPEG(coverage.every(c => c.coverage.every(value => value === 0)) && (!pad || pad.at === pad.bits.length));
  return out.finish();
}

let dictionaryOf = null;
function openBrotli(input, maxOutputLength) {
  try { return decompressBrotli(input, {maxOutputLength}); }
  catch (error) {
    if (error.dictionary !== true) throw error;
    if (!dictionaryOf) throw fault('JXL_DICTIONARY', 'This file\'s JPEG data refers to the Brotli dictionary.');
    return decompressBrotli(input, {dictionary: dictionaryOf(), maxOutputLength});
  }
}
const openBox = part => {
  if (!part) return null;
  if (!part.compressed) return part;
  const maximum = Math.min(Math.max(part.length * 16, 1 << 20), RECONSTRUCTION_PAYLOAD_BYTES);
  try { return openBrotli(part, maximum); }
  catch (error) {
    if (error.code === 'JXL_SIZE' || error.code === 'JXL_DICTIONARY') throw error;
    requireJPEG(false);
  }
};
export function restoreJPEG(bytes, dictionary, {maxPixels, bands = true} = {}) {
  dictionaryOf = typeof dictionary === 'function' ? dictionary : null;
  try { return restore(bytes, maxPixels, bands); } finally { dictionaryOf = null; }
}
function restore(bytes, maxPixels, bands, depth = 0, budget = {left: TAIL_BYTES}) {
  return guard(() => {
    const boxed = jpegReconstruction(bytes);
    if (!boxed) return null;
    const stream = openBox(boxed.reconstruction); requireJPEG(stream);
    let jpeg = readJPEGCoefficients(boxed.codestream, {reconstruction: true, maxPixels, rows: true});
    const data = readData(stream, {icc: jpeg.icc ? unpredictICC(jpeg.icc) : null, exif: openBox(boxed.exif), xml: openBox(boxed.xml)});
    const banded = bands && data.scans.length === 1 && !data.markers.includes(194);
    if (!banded) jpeg = jpeg.whole();
    requireJPEG(data.components.length === jpeg.components.length);
    for (let i = 0; i < jpeg.components.length; i++) {
      const c = jpeg.components[i], descriptor = data.components[i], q = data.quant[descriptor.quant];
      requireJPEG(!q.values || equal(q.values, c.quant)); q.values = c.quant; c.id = descriptor.id; c.tq = q.index;
    }
    for (let i = 0; i < data.quant.length; i++) { data.quant[i].values ||= data.quant[i - 1]?.values; requireJPEG(data.quant[i].values); }
    const tail = tailOf(bytes);
    if (tail) { requireJPEG(!data.tail.length); data.tail = openTail(tail, maxPixels, bands, depth, bytes, budget); }
    return writeJPEG(jpeg, data, null, depth ? budget.left : Infinity);
  });
}
