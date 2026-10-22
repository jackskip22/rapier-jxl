// SPDX-License-Identifier: MIT
import {BitWriter} from './bits.mjs';
import {ZIGZAG, jpegError, admitScan} from './jfif.mjs';
import {JxlBits, requireJPEG, readJPEGCoefficients} from './jpeg-coefficients.mjs';
import {jpegReconstruction, withJPEGReconstruction} from './container.mjs';
import {guard, admitOutputSize} from './admit.mjs';

const FOUR = [[0, 1], [0, 2], [0, 3], [0, 4]];
const COUNTS = [[0, 0], [0, 1], [3, 2], [8, 0]], SYMBOLS = [[2, 0], [2, 4], [4, 8], [8, 1]];
const EVENTS = [[0, 0], [2, 1], [4, 4], [16, 20]], BLOCK = [[0, 0], [3, 1], [5, 9], [28, 41]];
const HUFFMANS = [[0, 4], [3, 2], [4, 10], [6, 26]], TAIL = [[0, 0], [8, 1], [16, 257], [22, 65793]];
const equal = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
function concatenate(parts) {
  const size = parts.reduce((n, part) => n + part.length, 0); admitOutputSize(size);
  const bytes = new Uint8Array(size); let at = 0;
  for (const part of parts) { bytes.set(part, at); at += part.length; } return bytes;
}

function structure(bytes, jpeg) {
  const sharedSampling = Math.min(...jpeg.components.map(c => c.h)) > 1 || Math.min(...jpeg.components.map(c => c.v)) > 1;
  if (sharedSampling && jpeg.progressive) throw jpegError('progressive shared sampling factors cannot be reconstructed');
  const data = {markers: [], apps: [], comments: [], quant: [], huffman: [], scans: [], inter: [], tail: new Uint8Array(0), restart: 0, components: jpeg.components.map(c => ({id: c.id, quant: -1}))};
  const raw = part => {
    for (let at = 0; at < part.length; at += 65535) { data.markers.push(255); data.inter.push(part.subarray(at, at + 65535)); }
  };
  let at = 2, ended = false, hasRestart = false;
  while (at < bytes.length) {
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
      for (let p = body; p < end;) {
        const slot = bytes[p++], counts = [0, ...bytes.subarray(p, p + 16)]; p += 16;
        const n = counts.reduce((a, b) => a + b, 0), symbols = [...bytes.subarray(p, p + n), 256]; p += n;
        let last = 16; while (!counts[last]) last--; counts[last]++;
        data.huffman.push({slot, counts, symbols, last: p === end});
      }
    } else if (marker === 218) {
      const count = bytes[body], components = [];
      if (sharedSampling && count !== 1) throw jpegError('interleaved shared sampling factors cannot be reconstructed');
      for (let p = body + 1, i = 0; i < count; i++, p += 2) components.push({index: jpeg.components.findIndex(c => c.id === bytes[p]), dc: bytes[p + 1] >> 4, ac: bytes[p + 1] & 15});
      const p = body + 1 + count * 2, choices = jpeg.scanChoices[data.scans.length];
      requireJPEG(p + 3 === end);
      data.scans.push({components, ss: bytes[p], se: bytes[p + 1], al: bytes[p + 2] & 15, ah: bytes[p + 2] >> 4, ...choices});
      data.markers.push(marker); at = end;
      while (at < bytes.length) {
        if (bytes[at++] !== 255) continue;
        if (bytes[at] === 0) { at++; continue; }
        if (bytes[at] >= 208 && bytes[at] <= 215) { at++; continue; }
        at--; break;
      }
      if (choices.finalRestart !== undefined) raw(Uint8Array.of(255, choices.finalRestart));
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
function brotliLoad(bytes, size) {
  requireJPEG(size <= bytes.length);
  const r = new JxlBits(bytes), output = new Uint8Array(size); let at = 0;
  r.expect(1, 0);
  while (!r.read(1)) {
    r.expect(2, 0); const n = r.read(16) + 1; r.expect(1, 1); r.align();
    requireJPEG(at + n <= size && r.bit / 8 + n <= bytes.length);
    output.set(bytes.subarray(r.bit / 8, r.bit / 8 + n), at); at += n; r.bit += n * 8;
  }
  r.expect(1, 1); r.end(); requireJPEG(at === size); return output;
}
function writeData(data) {
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
  w.writeU32(TAIL, data.tail.length); w.write(1, 0); w.zeroPadToByte();
  return concatenate([w.finish(), brotliStore(concatenate([...data.apps, ...data.comments, ...data.inter, data.tail]))]);
}

function readData(bytes) {
  const r = new JxlBits(bytes), grey = r.read(1), data = {markers: [], apps: [], comments: [], quant: [], huffman: [], scans: [], inter: [], restart: 0};
  for (;;) { const marker = r.read(6) + 192; data.markers.push(marker); requireJPEG(data.markers.length <= 16384); if (marker === 217) break; }
  let total = 0;
  const size = n => { total += n; requireJPEG(total <= bytes.length); return n; };
  for (const marker of data.markers) if (marker >= 224 && marker <= 239) { r.expect(2, 0); data.apps.push(size(r.read(16) + 1)); }
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
    r.expect(2, 0); data.scans.push({components, ss, se, al, ah, resets: [], zeros: []});
  }
  if (data.markers.includes(221)) data.restart = r.read(16);
  for (const scan of data.scans) {
    let previous = -1;
    for (let n = r.u32(EVENTS); n; n--) { previous += 1 + r.u32(BLOCK); requireJPEG(previous < 201326592); scan.resets.push(previous); }
    previous = -1;
    for (let n = r.u32(EVENTS); n; n--) { const count = r.u32([[0, 1], [2, 2], [4, 5], [8, 20]]); previous += 1 + r.u32(BLOCK); requireJPEG(previous < 201326592 && count <= 4); scan.zeros.push({block: previous, count}); }
  }
  for (const marker of data.markers) if (marker === 255) data.inter.push(size(r.read(16)));
  data.tail = size(r.u32(TAIL)); r.expect(1, 0); r.align();
  const raw = brotliLoad(bytes.subarray(r.bit / 8), total); let at = 0;
  const take = n => raw.subarray(at, at += n);
  for (const key of ['apps', 'comments', 'inter']) data[key] = data[key].map(take);
  data.tail = take(data.tail); return data;
}

export function carryJPEG(bytes, jpeg, codestream) {
  try {
    const data = structure(bytes, jpeg);
    if (!equal(writeJPEG(jpeg, data), bytes)) throw jpegError('JPEG syntax cannot be reconstructed exactly');
    return withJPEGReconstruction(codestream, writeData(data));
  } catch (error) {
    if (error.code === 'JXL_RECONSTRUCTION') throw jpegError('JPEG syntax cannot be reconstructed exactly');
    throw error;
  }
}

class JPEGOutput {
  constructor() { this.bytes = new Uint8Array(4096); this.at = 0; this.acc = 0; this.pending = 0; }
  reserve(n) {
    const required = this.at + n; admitOutputSize(required);
    if (required <= this.bytes.length) return;
    const capacity = Math.max(required, this.bytes.length * 2);
    let next;
    try { next = new Uint8Array(capacity); }
    catch (error) {
      if (!(error instanceof RangeError) || capacity === required) throw error;
      next = new Uint8Array(required);
    }
    next.set(this.bytes.subarray(0, this.at)); this.bytes = next;
  }
  byte(v) { this.reserve(1); this.bytes[this.at++] = v; }
  chunk(bytes) { this.reserve(bytes.length); this.bytes.set(bytes, this.at); this.at += bytes.length; }
  marker(v) { requireJPEG(!this.pending); this.byte(255); this.byte(v); }
  segment(marker, data) { requireJPEG(data.length <= 65533); this.marker(marker); this.byte((data.length + 2) >> 8); this.byte((data.length + 2) & 255); this.chunk(data); }
  bits(n, value) {
    requireJPEG(n >= 0 && n <= 16 && value >= 0 && value < (1 << n));
    this.acc = this.acc * (1 << n) + value; this.pending += n;
    while (this.pending >= 8) {
      this.pending -= 8; const byte = Math.floor(this.acc / (1 << this.pending)); this.acc %= (1 << this.pending);
      this.byte(byte); if (byte === 255) this.byte(0);
    }
  }
  align() { const n = (-this.pending) & 7; this.bits(n, (1 << n) - 1); }
  finish() { requireJPEG(!this.pending); return this.bytes.slice(0, this.at); }
}
const category = value => value ? 32 - Math.clz32(Math.abs(value)) : 0;
function jpegCode(h) {
  const lengths = new Uint8Array(257), codes = new Uint16Array(257);
  let code = 0, at = 0;
  for (let n = 1; n <= 16; n++) {
    requireJPEG(code + h.counts[n] <= (1 << n));
    for (let j = 0; j < h.counts[n]; j++) { const s = h.symbols[at++]; lengths[s] = n; codes[s] = code++; }
    code *= 2;
  }
  return {lengths, codes};
}
function writeScan(out, jpeg, scan, huffman, restart, progressive) {
  const emit = (table, symbol) => { requireJPEG(table && table.lengths[symbol]); out.bits(table.lengths[symbol], table.codes[symbol]); };
  const value = (table, number, run = null) => {
    const n = category(number); requireJPEG(n <= (run === null ? 11 : 10)); emit(table, ((run ?? 0) << 4) | n);
    out.bits(n, number < 0 ? number + (1 << n) - 1 : number);
  };
  const {ss, se, al, ah} = scan, components = jpeg.components, unit = (1 << al);
  requireJPEG(progressive ? ss === 0 ? se === 0 : scan.components.length === 1 : ss === 0 && se === 63 && !al && !ah);
  const preds = new Int32Array(components.length), pending = [], resets = new Set(scan.resets), zeros = new Map(scan.zeros.map(z => [z.block, z.count]));
  let blockIndex = 0, eob = 0, eobTable = null;
  const flush = () => {
    if (eob) { const n = category(eob) - 1; emit(eobTable, n << 4); out.bits(n, eob - (1 << n)); eob = 0; }
    for (const bit of pending) out.bits(1, bit); pending.length = 0;
  };
  const endBand = (table, corrections = []) => {
    eobTable = table; eob++; for (const bit of corrections) pending.push(bit);
    if (!progressive || eob === 32767) flush();
  };
  const block = (entry, at) => {
    const c = components[entry.index], co = c.coeffs, dc = huffman[entry.dc], ac = huffman[16 + entry.ac];
    if (resets.has(blockIndex)) flush();
    if (!ss) {
      if (ah) out.bits(1, (co[at] >> al) & 1);
      else { const current = co[at] >> al; value(dc, current - preds[entry.index]); preds[entry.index] = current; }
      if (progressive) { blockIndex++; return; }
    }
    const first = ss || 1;
    if (!ah) {
      let run = 0;
      for (let k = first; k <= se; k++) {
        const v = Math.trunc(co[at + ZIGZAG[k]] / unit);
        if (!v) { run++; continue; }
        flush(); while (run >= 16) { emit(ac, 240); run -= 16; }
        value(ac, v, run); run = 0;
      }
      const extra = zeros.get(blockIndex) || 0;
      if (extra) { flush(); requireJPEG(run >= extra * 16); for (let i = 0; i < extra; i++) emit(ac, 240); run -= extra * 16; }
      if (run) endBand(ac);
    } else {
      requireJPEG(ah === al + 1);
      let lastNew = first - 1, run = 0, corrections = [];
      for (let k = first; k <= se; k++) if (Math.floor(Math.abs(co[at + ZIGZAG[k]]) / unit) === 1) lastNew = k;
      for (let k = first; k <= se; k++) {
        const original = co[at + ZIGZAG[k]], magnitude = Math.floor(Math.abs(original) / unit);
        if (!magnitude) { run++; continue; }
        while (run >= 16 && k <= lastNew) {
          flush(); emit(ac, 240); run -= 16; for (const bit of corrections) out.bits(1, bit); corrections = [];
        }
        if (magnitude > 1) corrections.push(magnitude & 1);
        else {
          flush(); emit(ac, (run << 4) | 1); out.bits(1, original > 0 ? 1 : 0);
          for (const bit of corrections) out.bits(1, bit); corrections = []; run = 0;
        }
      }
      if (run || corrections.length) endBand(ac, corrections);
    }
    blockIndex++;
  };
  const hmax = Math.max(...components.map(c => c.h)), vmax = Math.max(...components.map(c => c.v)), single = scan.components.length === 1;
  const first = components[scan.components[0].index], nx = Math.ceil(jpeg.width * (single ? first.h : 1) / (8 * hmax)), ny = Math.ceil(jpeg.height * (single ? first.v : 1) / (8 * vmax));
  for (let m = 0; m < nx * ny; m++) {
    if (restart && m && m % restart === 0) { flush(); out.align(); out.marker(208 + ((m / restart - 1) & 7)); preds.fill(0); }
    const x = m % nx, y = Math.floor(m / nx);
    for (const entry of scan.components) {
      const c = components[entry.index], h = single ? 1 : c.h, v = single ? 1 : c.v;
      for (let dy = 0; dy < v; dy++) for (let dx = 0; dx < h; dx++) block(entry, ((y * v + dy) * c.stride + x * h + dx) * 64);
    }
  }
  requireJPEG(scan.resets.every(n => n < blockIndex) && scan.zeros.every(z => z.block < blockIndex)); flush(); out.align();
}
function writeJPEG(jpeg, data) {
  const out = new JPEGOutput(), huffman = [];
  const coverage = jpeg.components.map(() => ({coverage: new Int8Array(64).fill(-1)}));
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
      writeScan(out, jpeg, info, huffman, restart, progressive);
    } else if (marker === 217) { out.marker(marker); out.chunk(data.tail); }
    else requireJPEG(false);
  }
  requireJPEG(coverage.every(c => c.coverage.every(value => value === 0)));
  return out.finish();
}

export function reconstructJPEG(bytes) {
  return guard(() => {
    const boxed = jpegReconstruction(bytes); if (!boxed) return null;
    const data = readData(boxed.reconstruction), jpeg = readJPEGCoefficients(boxed.codestream, {reconstruction: true});
    requireJPEG(data.components.length === jpeg.components.length);
    for (let i = 0; i < jpeg.components.length; i++) {
      const c = jpeg.components[i], descriptor = data.components[i], q = data.quant[descriptor.quant];
      requireJPEG(!q.values || equal(q.values, c.quant)); q.values = c.quant; c.id = descriptor.id; c.tq = q.index;
    }
    for (let i = 0; i < data.quant.length; i++) { data.quant[i].values ||= data.quant[i - 1]?.values; requireJPEG(data.quant[i].values); }
    return writeJPEG(jpeg, data);
  });
}
