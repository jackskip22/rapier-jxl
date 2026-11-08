// SPDX-License-Identifier: MIT
import {SAVED, PASSED, tiledBytes, joinedBytes, readAll} from '../step-journal.mjs';
import {fault} from '../fault.mjs';
import {sampleView} from './verify-samples.mjs';

const refuse = message => { throw fault('JXL_INPUT', message); };
const invalid = () => refuse('The source contains an invalid deflate stream.');
const exceeds = () => refuse('Compressed source data exceeds its declared dimensions.');
const NATIVE_STREAM = 8 << 20, NATIVE_ROWS = 16 << 20, BAND_ROWS = 32, PIECE_COLS = 1024, WALK_BYTES = 2 << 20, WINDOW = 32768, FAST = 10, MASK = (1 << FAST) - 1;
const LENGTH_EXTRA = Array.from({length: 29}, (_, i) => i < 8 || i === 28 ? 0 : (i - 4) >> 2), DIST_EXTRA = Array.from({length: 30}, (_, i) => i < 4 ? 0 : (i - 2) >> 1);
const bases = (extra, first) => extra.map((_, i) => first += i && 1 << extra[i - 1]);
const LENGTH_BASE = bases(LENGTH_EXTRA, 3), DIST_BASE = bases(DIST_EXTRA, 1);
LENGTH_BASE[28] = 258;
const ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

function canonical(lengths, single) {
  const n = lengths.length, counts = new Uint16Array(16);
  for (let i = 0; i < n; i++) counts[lengths[i]]++;
  counts[0] = 0;
  let max = 15;
  while (max && !counts[max]) max--;
  for (let len = 1, left = 1; len <= 15; len++) { left = (left << 1) - counts[len]; if (left < 0) invalid(); if (len === 15 && left > 0 && max && (!single || max !== 1)) invalid(); }
  const offsets = new Uint16Array(17), symbols = new Uint16Array(n);
  for (let len = 1; len <= 15; len++) offsets[len + 1] = offsets[len] + counts[len];
  const next = offsets.slice();
  for (let i = 0; i < n; i++) if (lengths[i]) symbols[next[lengths[i]]++] = i;
  const table = new Uint32Array(1 << FAST);
  for (let len = 1, value = 0; len <= FAST; len++, value <<= 1) for (let k = 0; k < counts[len]; k++, value++) {
    let reversed = 0;
    for (let bit = 0; bit < len; bit++) reversed |= ((value >> bit) & 1) << (len - 1 - bit);
    const entry = (symbols[offsets[len] + k] << 4) | len;
    for (let j = reversed; j <= MASK; j += 1 << len) table[j] = entry;
  }
  return {table, counts, symbols};
}
let fixedCodes = null;
const fixed = () => fixedCodes ??= {lit: canonical(Uint8Array.from({length: 288}, (_, i) => i < 144 ? 8 : i < 256 ? 9 : i < 280 ? 7 : 8), true),
  dist: canonical(new Uint8Array(32).fill(5), true)};
const dynamic = (lengths, hlit) => ({lit: canonical(lengths.subarray(0, hlit), true), dist: canonical(lengths.subarray(hlit), true)});

export function inflateBand(state, need, last, stream) {
  let {pos, bits, count, final, type, left, lengths, hlit, copy, distance, a, b, produced} = state;
  let buf = stream.read(pos, Math.min(stream.length, pos + state.span)), at = 0;
  const fill = () => {
    const from = pos;
    if (from >= stream.length) return false;
    buf = stream.read(from, Math.min(stream.length, from + Math.max(65536, state.span))); at = 0;
    return buf.length > 0;
  };
  const want = n => { while (count < n) { if (at >= buf.length && !fill()) invalid(); bits |= buf[at++] << count; pos++; count += 8; } };
  const take = n => { want(n); const v = bits & ((1 << n) - 1); bits >>>= n; count -= n; return v; };
  const decode = c => {
    while (count < 15) { if (at >= buf.length && !fill()) break; bits |= buf[at++] << count; pos++; count += 8; }
    const entry = c.table[bits & MASK], len = entry & 15;
    if (entry && len <= count) { bits >>>= len; count -= len; return entry >> 4; }
    for (let len = 1, value = 0, first = 0, index = 0; len <= 15; len++) {
      value |= take(1);
      const n = c.counts[len];
      if (value - n < first) return c.symbols[index + value - first];
      index += n; first += n; first <<= 1; value <<= 1;
    }
    return invalid();
  };
  const lengthsOf = () => {
    const hl = take(5) + 257, hd = take(5) + 1, hc = take(4) + 4;
    if (hl > 286 || hd > 30) invalid();
    const cl = new Uint8Array(19);
    for (let j = 0; j < hc; j++) cl[ORDER[j]] = take(3);
    const lens = canonical(cl, false), all = new Uint8Array(hl + hd);
    for (let n = 0; n < all.length;) {
      const symbol = decode(lens);
      if (symbol < 16) { all[n++] = symbol; continue; }
      let repeat, value = 0;
      if (symbol === 16) { if (!n) invalid(); value = all[n - 1]; repeat = 3 + take(2); }
      else if (symbol === 17) repeat = 3 + take(3);
      else repeat = 11 + take(7);
      if (n + repeat > all.length) invalid();
      all.fill(value, n, n + repeat); n += repeat;
    }
    if (!all[256]) invalid();
    hlit = hl;
    return all;
  };
  const history = state.window, out = new Uint8Array(WINDOW + need), lowest = WINDOW - history.length, end = WINDOW + need;
  out.set(history, lowest);
  let o = WINDOW, codes = type === 1 ? fixed() : type === 2 ? dynamic(lengths, hlit) : null;
  for (;;) {
    for (; copy > 0 && o < end; copy--, o++) out[o] = out[o - distance];
    if (copy > 0) { if (last) exceeds(); break; }
    if (type === -1) {
      if (final) break;
      final = take(1); type = take(2);
      if (type === 0) {
        bits >>>= count & 7; count -= count & 7;
        const len = take(16), nlen = take(16);
        if (len !== (~nlen & 0xffff)) invalid();
        left = len;
      } else if (type === 1) codes = fixed();
      else if (type === 2) { lengths = lengthsOf(); codes = dynamic(lengths, hlit); }
      else invalid();
      continue;
    }
    if (type === 0) {
      if (!left) { type = -1; continue; }
      if (o >= end) { if (last) exceeds(); break; }
      out[o++] = take(8); left--;
      continue;
    }
    if (o >= end && !last) break;
    const symbol = decode(codes.lit);
    if (symbol < 256) { if (o >= end) exceeds(); out[o++] = symbol; continue; }
    if (symbol === 256) { type = -1; continue; }
    if (symbol > 285) invalid();
    const length = LENGTH_BASE[symbol - 257] + take(LENGTH_EXTRA[symbol - 257]), d = decode(codes.dist);
    if (d > 29) invalid();
    distance = DIST_BASE[d] + take(DIST_EXTRA[d]);
    if (distance > o - lowest || distance > (state.windowSize ?? WINDOW)) invalid();
    copy = length;
  }
  if (o < end) refuse('Compressed source data is incomplete.');
  const output = out.subarray(WINDOW, o);
  for (let i = 0; i < output.length;) {
    for (const stop = Math.min(output.length, i + 5552); i < stop; i++) { a += output[i]; b += a; }
    a %= 65521; b %= 65521;
  }
  if (last) {
    bits >>>= count & 7; count -= count & 7;
    const check = (take(8) * 16777216 + (take(8) << 16) + (take(8) << 8) + take(8)) >>> 0;
    if (check !== ((b * 65536 + a) >>> 0) || count || pos !== stream.length) invalid();
  }
  const total = produced + output.length, keep = Math.min(WINDOW, total);
  return {output, state: {pos, bits, count, final, type, left, lengths, hlit, copy, distance, a, b, produced: total, span: state.span,
    windowSize:state.windowSize,window: out.slice(o - keep, o)}};
}

async function unit(journal, name, run, carry = false, cold = false, alone = false, tail = false) {
  const saved = await journal({unit: name, ...(carry && {carry: true}), ...(cold && {cold: true}), ...(alone && {alone: true}), ...(tail && {tail: true})});
  if (saved && Object.hasOwn(saved, SAVED)) return {value: saved[SAVED]};
  let value;
  try { value = await run(); } catch (error) { await journal({unitFailed: name}); throw error; }
  await journal({unitDone: name, value});
  return {value};
}

export async function pngPixels(journal, file, {readAs, deep = true, orient = false, metadata = false, reader: {pngWalk, pngLayout, pngRows, pngPassRows, pngOrientationLocation, unfilterRow, inflate, shapeScan, shapeScanPixels, flatSampleX, flatSampleY, rankingPositions, photoPreferenceDifference}} = {}) {
  if (readAs !== undefined && !metadata || !deep) return null;
  let walk = null;
  do {
    const {value} = await unit(journal, 'png-chunks', () => {
      const at = walk?.next ?? 0, to = Math.min(file.length, at + Math.max(WALK_BYTES, walk?.least ?? 0));
      return pngWalk(structuredClone(walk), file.subarray(at, to), at, file.length);
    }, true);
    if (value !== PASSED) walk = value;
  } while (!walk?.done);
  if (metadata) return (await unit(journal,'png-geometry',() => pngOrientationLocation(walk))).value;
  const {value: s} = await unit(journal, 'png-structure', async () => {
    const {width, height, depth, colourType, channels, interlace, expected, palette, paletteAlpha, transparent, colour, orientation, parts} = await pngLayout(walk, false);
    const stream = parts.reduce((n, [, length]) => n + length, 0), [cmf, flg] = parts.length ? file.subarray(parts[0][0], parts[0][0] + 2) : [];
    const taken = (!shapeScan || depth <= 8 && !interlace) && (orient || !(orientation > 1)) && parts[0]?.[1] >= 2 &&
      (shapeScan ? cmf === 0x78 : (cmf & 15) === 8 && cmf >>> 4 <= 7) && !((cmf * 256 + flg) % 31) && !(flg & 32);
    return {taken, width, height, depth, colourType, channels, interlace, expected, palette, paletteAlpha, transparent, colour, orientation,
      windowSize:1 << ((cmf >>> 4) + 8),parts, stream};
  });
  if (!s.taken) return null;
  const {width, height, depth, channels, parts, stream} = s, rowBytes = Math.ceil(width * channels * depth / 8), bpp = Math.max(1, (channels * depth) >> 3);
  const starts = [];
  for (let i = 0, n = 0; i < parts.length; n += parts[i][1], i++) starts.push(n);
  const zlib = {length: stream, read(from, to) {
    if (to <= from) return new Uint8Array(0);
    let i = 0;
    while (i + 1 < parts.length && starts[i + 1] <= from) i++;
    let j = i;
    while (j + 1 < parts.length && starts[j + 1] < to) j++;
    const fileFrom = parts[i][0] + (from - starts[i]), fileTo = parts[j][0] + (to - starts[j]), span = file.subarray(fileFrom, fileTo);
    if (i === j) return span;
    const out = new Uint8Array(to - from);
    for (let k = i, o = 0; k <= j; k++) {
      const start = Math.max(from, starts[k]), stop = Math.min(to, starts[k] + parts[k][1]);
      out.set(span.subarray(parts[k][0] + (start - starts[k]) - fileFrom, parts[k][0] + (stop - starts[k]) - fileFrom), o); o += stop - start;
    }
    return out;
  }};
  if (!shapeScan && (s.depth === 16 || s.interlace))
    return passPixels(journal,s,zlib,{pngRows,pngPassRows,unfilterRow});
  const bands = [], count = Math.ceil(height / BAND_ROWS), span = Math.ceil(stream / count * 1.25) + 4096;
  const opaque = (s.colourType === 0 || s.colourType === 2 || s.colourType === 3) && !s.transparent && !s.paletteAlpha;
  const rawBytes = height * (rowBytes + 1), native = !!inflate && typeof DecompressionStream === 'function' && stream <= NATIVE_STREAM && rawBytes <= NATIVE_ROWS;
  let whole = null;
  const inflated = () => whole ??= inflate(parts.map(([at, length]) => file.subarray(at, at + length)), rawBytes);
  let state = {native, pos: 2, bits: 0, count: 0, final: 0, type: -1, left: 0, lengths: null, hlit: 0, copy: 0, distance: 0, a: 1, b: 0, produced: 0, span,
    windowSize:s.windowSize,window: new Uint8Array(0), previous: new Uint8Array(rowBytes),
    scans: shapeScan ? [null, {colour: 3}].map(floor => shapeScan(width * height, {opacity: !opaque}, floor)) : [], flags: new Uint8Array(256), edge: [], xyb: 0, tail: null};
  const positions = rankingPositions?.(width * height) ?? [], taken = [], rowStep = Math.max(1, height / 32 | 0);
  for (let k = 0; k < count; k++) {
    const top = k * BAND_ROWS, rows = Math.min(BAND_ROWS, height - top);
    let next = null, picks = null, pieces = null;
    const band = async () => {
      if (!!state.native !== native) refuse('This PNG\'s rows were read by another inflater.');
      const length = rows * (rowBytes + 1);
      const {output, state: after} = native ? {output: (await inflated()).subarray(state.produced, state.produced + length), state: {...state, produced: state.produced + length}}
        : inflateBand(state, length, k === count - 1, zlib);
      const pixels = new Uint8Array(rows * width * 4), write = pngRows(s, pixels, top);
      let previous = state.previous.slice(), row = new Uint8Array(rowBytes);
      for (let y = 0, at = 0; y < rows; y++) {
        const filter = output[at++];
        if (filter > 4) refuse('The PNG contains an unknown row filter.');
        unfilterRow(filter, output, at, row, previous, rowBytes, bpp);
        at += rowBytes;
        write(row, width, 0, top + y, 1, 1, 0);
        [previous, row] = [row, previous];
      }
      const scans = structuredClone(state.scans);
      for (const scan of scans) shapeScanPixels(scan, pixels, top * width, rows * width);
      const words = new Uint32Array(pixels.buffer), flags = state.flags.slice(), edge = [];
      for (const [k, ok, colour] of state.edge) flags[k] = ok && colour === words[flatSampleX(width, k)] ? 1 : 0;
      for (let k = 0; flatSampleX && k < 256; k++) {
        const x = flatSampleX(width, k), y = flatSampleY(height, k) - top, p = y * width + x;
        if (y < 0 || y >= rows) continue;
        const ok = words[p] === words[p + 1];
        if (y + 1 < rows) flags[k] = ok && words[p] === words[p + width] ? 1 : 0; else edge.push([k, ok, words[p]]);
      }
      let xyb = state.xyb;
      if (state.tail) { const two = new Uint8Array(width * 8); two.set(state.tail); two.set(pixels.subarray(0, width * 4), width * 4); xyb += photoPreferenceDifference(two, width, height, top - 1, top, top - 1); }
      const last = k === count - 1, tail = photoPreferenceDifference && !last && (top + rows - 1) % rowStep === 0 ? pixels.slice((rows - 1) * width * 4) : null;
      xyb += photoPreferenceDifference?.(pixels, width, height, top, last ? top + rows : top + rows - 1, top) ?? 0;
      next = {...after, previous, scans, flags, edge, xyb, tail};
      const list = [], end = (top + rows) * width;
      let at = 0;
      for (let hi = positions.length; at < hi;) { const mid = (at + hi) >> 1; if (positions[mid] < top * width) at = mid + 1; else hi = mid; }
      for (; at < positions.length && positions[at] < end + width; at++) {
        const i = positions[at], y = (i / width) | 0, x = i - y * width, w = x ? i - 1 : y ? i - width : -1, n = y ? i - width : w;
        [i, w, n, x && y ? i - width - 1 : w].forEach((p, j) => { if (p >= top * width && p < end) list.push(at * 4 + j, words[p - top * width]); });
      }
      picks = Uint32Array.from(list);
      pieces = [];
      for (let x = 0; x < width; x += PIECE_COLS) {
        const w = Math.min(PIECE_COLS, width - x), piece = new Uint8Array(rows * w * 4);
        for (let y = 0; y < rows; y++) piece.set(pixels.subarray((y * width + x) * 4, (y * width + x + w) * 4), y * w * 4);
        pieces.push(piece);
      }
      return pieces;
    };
    const columns = [];
    for (let c = 0; c * PIECE_COLS < width; c++) columns.push((await unit(journal, 'png-rows', async () => (pieces ?? await band())[c], false, true, true, c > 0)).value);
    bands.push(columns);
    if (rankingPositions) taken.push((await unit(journal, 'png-picks', async () => picks ?? (await band(), picks), false, false, true, true)).value);
    const {value: saved} = await unit(journal, 'png-inflate', async () => next ?? (await band(), next), true, false, false, true);
    if (saved !== PASSED) state = saved;
  }
  const ranking = () => {
    const words = new Uint32Array(positions.length * 4);
    for (const list of readAll(taken)) for (let i = 0; i < list.length; i += 2) words[list[i]] = list[i + 1];
    return new Uint8Array(words.buffer);
  }, xyb = state.xyb, preference = () => xyb;
  const data = tiledBytes(bands, width, height, BAND_ROWS, PIECE_COLS, journal.touched, {opaque, scans: state.scans, flats: state.flags, ranking, preference});
  return {data, width, height, bitDepth: 8, sampleFormat: 'uint', ...s.colour, alphaPremultiplied: false,
    ...(s.orientation > 1 && {orientation:s.orientation})};
}

async function passPixels(journal,s,zlib,{pngRows,pngPassRows,unfilterRow}) {
  const {width,height,depth,channels} = s, passes = pngPassRows(s), bpp = Math.max(1,channels * depth >> 3);
  const count = passes.reduce((n,p) => n + Math.ceil(p[5] / BAND_ROWS),0), span = Math.ceil(s.stream / count * 1.25) + 4096;
  let state = {pos:2,bits:0,count:0,final:0,type:-1,left:0,lengths:null,hlit:0,copy:0,distance:0,a:1,b:0,produced:0,span,
    windowSize:s.windowSize,window:new Uint8Array(0),previous:new Uint8Array(0)};
  const rawPasses = [];
  for (let p = 0; p < passes.length; p++) {
    const [, , , , , passHeight,rowBytes] = passes[p], pieces = [];
    for (let y = 0; y < passHeight; y += BAND_ROWS) {
      const rows = Math.min(BAND_ROWS,passHeight - y);
      let next;
      const decode = () => {
        const {output,state:after} = inflateBand(state,rows * (rowBytes + 1),p === passes.length - 1 && y + rows === passHeight,zlib);
        const raw = new Uint8Array(rows * rowBytes);
        let previous = y ? state.previous.slice() : new Uint8Array(rowBytes), row = new Uint8Array(rowBytes);
        for (let k = 0,at = 0; k < rows; k++) {
          const filter = output[at++];
          if (filter > 4) refuse('The PNG contains an unknown row filter.');
          unfilterRow(filter,output,at,row,previous,rowBytes,bpp); at += rowBytes;
          raw.set(row,k * rowBytes); [previous,row] = [row,previous];
        }
        next = {...after,previous}; return raw;
      };
      pieces.push((await unit(journal,'png-pass-rows',decode,false,true,true)).value);
      const {value} = await unit(journal,'png-pass-inflate',() => next ?? (decode(),next),true,false,false,true);
      if (value !== PASSED) state = value;
    }
    rawPasses.push(joinedBytes(pieces,journal.touched));
  }
  const Type = depth === 16 ? Uint16Array : Uint8Array, size = Type.BYTES_PER_ELEMENT, bands = [];
  for (let top = 0; top < height; top += BAND_ROWS) {
    const rows = Math.min(BAND_ROWS,height - top);
    let pieces;
    const render = () => {
      const pixels = new Type(rows * width * 4), write = pngRows(s,pixels,top);
      for (let p = 0; p < passes.length; p++) {
        const [x,y,dx,dy,w,h,rowBytes] = passes[p], first = Math.max(0,Math.ceil((top - y) / dy)), end = Math.min(h,Math.ceil((top + rows - y) / dy));
        if (end <= first) continue;
        const raw = rawPasses[p].subarray(first * rowBytes,end * rowBytes);
        for (let row = first; row < end; row++) write(raw.subarray((row - first) * rowBytes,(row - first + 1) * rowBytes),w,x,y,dx,dy,row);
      }
      pieces = [];
      for (let x = 0; x < width; x += PIECE_COLS) {
        const w = Math.min(PIECE_COLS,width - x), piece = new Type(rows * w * 4);
        for (let y = 0; y < rows; y++) piece.set(pixels.subarray((y * width + x) * 4,(y * width + x + w) * 4),y * w * 4);
        pieces.push(new Uint8Array(piece.buffer,piece.byteOffset,piece.byteLength));
      }
      return pieces;
    };
    const columns = [];
    for (let c = 0; c * PIECE_COLS < width; c++) columns.push((await unit(journal,'png-reference-rows',() => (pieces ?? render())[c],false,true,true,c > 0)).value);
    bands.push(columns);
  }
  return {data:sampleView(tiledBytes(bands,width * size,height,BAND_ROWS,PIECE_COLS * size,journal.touched),Type),width,height,
    bitDepth:depth === 16 ? 16 : 8,sampleFormat:'uint',...s.colour,alphaPremultiplied:false,...(s.orientation > 1 && {orientation:s.orientation})};
}
