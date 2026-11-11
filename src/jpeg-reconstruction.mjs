// SPDX-License-Identifier: MIT
import {BitWriter, complete} from './bits.mjs';
import {unit, stage, journaling, journalJoin, journalTool, sliceBytes, unread, readEach} from './step-journal.mjs';
import {kernelHooks} from './kernel-hooks.mjs';
import {ZIGZAG, jpegError, admitScan} from './jfif.mjs';
import {JxlBits, requireJPEG, readJPEGCoefficientsSteps} from './jpeg-coefficients.mjs';
import {jpegReconstructionSteps, withJPEGReconstruction, boxes, boxHeader, CODESTREAM} from './container.mjs';
import {guard, admitOutputSize} from './admit.mjs';
import {fault} from './fault.mjs';
import {compressBrotliSteps, decompressBrotliSteps} from './brotli.mjs';
import {iccInverse} from './icc-profile.mjs';

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

function structureStart(jpeg) {
  const sharedSampling = !jpeg.ycbcr && (Math.min(...jpeg.components.map(c => c.h)) > 1 || Math.min(...jpeg.components.map(c => c.v)) > 1);
  if (sharedSampling && jpeg.progressive) throw jpegError('progressive shared sampling factors cannot be reconstructed');
  return {at: 2, phase: 'marker', sharedSampling, quant: [], events: 0, markers: 0, huffman: 0, scans: 0, restart: 0, hasRestart: false, ended: false};
}
function structureWindow(bytes, jpeg, previous) {
  const state = {...previous, quant: previous.quant.slice()}, data = {markers: [], apps: [], comments: [], huffman: [], scans: [], inter: []};
  const marker = value => { requireJPEG(state.markers++ < 16384); data.markers.push(value); };
  const raw = part => {
    for (let at = 0; at < part.length; at += 65535) {
      marker(255); data.inter.push(sliceBytes(part, at, at + 65535));
    }
  };
  if (state.phase === 'scan-fill') {
    const n = Math.min(65535, state.fill - state.filled), fill = new Uint8Array(n);
    for (let i = state.filled & 1; i < n; i += 2) fill[i] = 255;
    raw(fill); state.filled += n;
    if (state.filled === state.fill) {
      if (state.finalRestart !== undefined) marker(state.finalRestart);
      state.phase = 'marker';
    }
    return {state, data};
  }
  let at = state.at;
  const start = at, stop = Math.min(bytes.length, at + 65536);
  const window = bytes.subarray(start, Math.min(bytes.length, stop + 65540)), byte = at => window[at - start];
  if (state.phase === 'entropy' || state.phase === 'entropy-code') {
    while (at < stop) {
      if (state.phase === 'entropy') {
        while (at < stop && byte(at) !== 255) at++;
        if (at === stop) break;
        at++; state.phase = 'entropy-code';
      }
      if (at === stop) break;
      if (byte(at) === 0 || byte(at) >= 208 && byte(at) <= 215) { at++; state.phase = 'entropy'; }
      else { at--; state.phase = 'scan-fill'; break; }
    }
    if (at === bytes.length) state.phase = 'scan-fill';
    state.at = at; return {state, data};
  }
  if (at >= bytes.length) throw jpegError('JPEG reconstruction requires an end marker');
  if (state.phase === 'marker') { state.start = at; state.phase = 'marker-code'; }
  while (at < stop && byte(at) === 255) {
    at++;
    if (at - state.start > 65535) { raw(sliceBytes(bytes, state.start, state.start + 65535)); state.start += 65535; }
  }
  if (at === stop) { state.at = at; return {state, data}; }
  {
    requireJPEG(state.markers < 16384);
    if (at - state.start > 1) raw(sliceBytes(bytes, state.start, at - 1));
    const code = byte(at++), markerStart = at - 2;
    state.phase = 'marker';
    if (code === 217) { marker(code); data.tail = sliceBytes(bytes, at); state.ended = true; state.at = at; return {state, data}; }
    if (code === 1) { raw(sliceBytes(bytes, markerStart, at)); state.at = at; return {state, data}; }
    if (at + 2 > bytes.length) throw jpegError('truncated');
    const size = byte(at) * 256 + byte(at + 1), body = at + 2, end = at + size;
    if (!(size >= 2) || end > bytes.length) throw jpegError('bad segment');
    let keep = true;
    if (code === 219) {
      const tables = [];
      for (let p = body; p < end;) {
        const precision = byte(p) >> 4, index = byte(p++) & 15, values = new Int32Array(64);
        for (const k of ZIGZAG) { values[k] = precision ? byte(p++) * 256 + byte(p++) : byte(p++); }
        tables.push({precision, index, last: p === end, values});
      }
      keep = state.quant.length + tables.length <= 3 && tables.every(q => jpeg.components.some(c => c.tq === q.index && equal(c.quant, q.values))) &&
        tables.every(q => !state.quant.some(old => old.index === q.index));
      if (keep) state.quant.push(...tables);
    } else if (code === 196) {
      if (body === end) keep = false;
      for (let p = body; p < end;) {
        requireJPEG(state.huffman++ < 89);
        const slot = byte(p++), counts = [0, ...window.subarray(p - start, p + 16 - start)]; p += 16;
        const n = counts.reduce((a, b) => a + b, 0), symbols = [...window.subarray(p - start, p + n - start), 256]; p += n;
        requireJPEG(n > 0);
        let last = 16; while (!counts[last]) last--; counts[last]++;
        requireJPEG(counts[last] <= 255);
        data.huffman.push({slot, counts, symbols, last: p === end});
      }
    } else if (code === 218) {
      const count = byte(body), components = [];
      if (state.sharedSampling && count !== 1) throw jpegError('interleaved shared sampling factors cannot be reconstructed');
      for (let p = body + 1, i = 0; i < count; i++, p += 2) components.push({index: jpeg.components.findIndex(c => c.id === byte(p)), dc: byte(p + 1) >> 4, ac: byte(p + 1) & 15});
      const p = body + 1 + count * 2, choices = jpeg.scanChoices[state.scans++];
      requireJPEG(p + 3 === end && choices.resets.length <= 65555 && choices.zeros.length <= 65555);
      state.events += choices.resets.length + choices.zeros.length;
      if (state.events > RECONSTRUCTION_SCAN_EVENTS) throw jpegError(`more than ${RECONSTRUCTION_SCAN_EVENTS} scan events cannot be reconstructed`);
      data.scans.push({components, ss: byte(p), se: byte(p + 1), al: byte(p + 2) & 15, ah: byte(p + 2) >> 4,
        index: state.scans - 1, resets: choices.resets.length, zeros: choices.zeros.length});
      state.phase = 'entropy'; state.fill = (choices.fill || 0) * 2; state.filled = 0; state.finalRestart = choices.finalRestart;
    } else if (code >= 224 && code <= 239) data.apps.push(sliceBytes(bytes, markerStart + 1, end));
    else if (code === 254) data.comments.push(sliceBytes(bytes, markerStart + 1, end));
    else if (code === 221) {
      const interval = byte(body) * 256 + byte(body + 1);
      if (state.hasRestart && interval !== state.restart) throw jpegError('changing restart intervals cannot be reconstructed');
      state.restart = interval; state.hasRestart = true;
    } else if (![192, 193, 194].includes(code) || state.sharedSampling) keep = false;
    if (keep) marker(code); else raw(sliceBytes(bytes, markerStart, end));
    state.at = end;
  }
  return {state, data};
}
function structureData(jpeg) {
  return {markers: [], apps: [], comments: [], huffman: [], scans: [], inter: [], tail: new Uint8Array(0), components: jpeg.components.map(c => ({id: c.id, quant: -1}))};
}
function structureChoices(jpeg, index, zero) {
  const values = jpeg.scanChoices[index][zero ? 'zeros' : 'resets'];
  if (!zero) return Uint32Array.from(values);
  const out = new Uint32Array(values.length * 2);
  for (let i = 0; i < values.length; i++) { out[2 * i] = values[i].block; out[2 * i + 1] = values[i].count; }
  return out;
}
const structureScan = ({index, resets, zeros, ...scan}, resetValues, zeroValues) => ({...scan, resets: resetValues, zeros: zeroValues});
function structureAppend(data, part, scans) {
  for (const key of ['markers', 'apps', 'comments', 'huffman', 'inter']) data[key].push(...part.data[key]);
  data.scans.push(...scans);
  if (part.data.tail) data.tail = part.data.tail;
}
function structureFinish(data, state, jpeg) {
  data.quant = state.quant; data.restart = state.restart;
  for (let i = 0; i < jpeg.components.length; i++) {
    const c = jpeg.components[i];
    let index = data.quant.findIndex(q => q.index === c.tq && equal(q.values, c.quant));
    if (index < 0) { index = data.quant.length; data.quant.push({precision: c.quant.some(v => v > 255) ? 1 : 0, index: c.tq, values: c.quant, last: true}); }
    data.components[i].quant = index;
  }
  if (jpeg.padding) { data.padding = sliceBytes(jpeg.padding); requireJPEG(data.padding.length < 16777216); }
  requireJPEG(data.markers.length <= 16384 && data.quant.length <= 3 && data.huffman.length <= 89 && data.tail.length <= 4260096);
  return data;
}
function* structure(bytes, jpeg) {
  if (journaling()) return yield* journalTool('jpegStructure')(bytes, jpeg, {start: structureStart, window: structureWindow,
    create: structureData, choices: structureChoices, scan: structureScan, append: structureAppend, finish: structureFinish});
  const data = structureData(jpeg); let state = structureStart(jpeg);
  while (!state.ended) {
    const part = structureWindow(bytes, jpeg, state); state = part.state;
    structureAppend(data, part, part.data.scans.map(row => structureScan(row,
      structureChoices(jpeg, row.index, false), structureChoices(jpeg, row.index, true))));
  }
  return structureFinish(data, state, jpeg);
}

function* brotliStoreSteps(bytes) {
  const parts = [];
  for (let at = 0; at < bytes.length; at += 65536) {
    parts.push(yield* unit('brotli-stored', () => {
      const part = bytes.subarray(at, at + 65536), w = new BitWriter(part.length + 8);
      if (!at) w.write(1, 0);
      w.write(1, 0); w.write(2, 0); w.write(16, part.length - 1); w.write(1, 1); w.zeroPadToByte();
      w.append({bytes: part, at: part.length, pending: 0, acc: 0}); return w.finish();
    }));
  }
  parts.push(Uint8Array.of(bytes.length ? 3 : 6));
  return journaling() ? journalJoin(parts) : concatenate(parts);
}
const CONTEXT_BYTES = 196608;
function* payloadCuts(data, splitApps = true) {
  if (journaling()) return yield* journalTool('jpegPayload')(data, splitApps,
    {apps: payloadApps, tail: payloadTailWindow, offset: payloadOffset, finish: payloadEnd});
  const apps = payloadApps(data.apps, splitApps), cuts = apps.cuts, offset = payloadOffset(data, apps.state.curOff);
  let state = {at: 0, phase: 'search', done: false};
  while (!state.done) {
    const part = payloadTailWindow(data.tail, state); state = part.state;
    for (const at of part.cuts) cuts.push(offset + at);
  }
  return payloadEnd(cuts, offset + data.tail.length);
}
const payloadOffset = (data, apps) => data.comments.reduce((n, part) => n + part.length,
  data.inter.reduce((n, part) => n + part.length, apps));
const payloadEnd = (cuts, length) => cuts.filter((c, i) => c > 0 && c < length && (i === 0 || c > cuts[i - 1]));
function payloadApps(parts, splitApps, previous = {curStart: 0, curOff: 0, lastKind: -1}) {
  const state = {...previous}, cuts = [], appKind = seg => {
    if (seg[0] === 225 && seg.length > 9 && seg[3] === 69 && seg[4] === 120) return 1;
    if (seg[0] === 225 && seg.length > 32 && seg[3] === 104 && seg[4] === 116 && seg[25] === 97) return 2;
    if (seg[0] === 225 && seg.length > 35 && seg[3] === 104 && seg[4] === 116) return 3;
    return seg[0] === 235 ? 4 : 0;
  };
  const heads = !(typeof __RAPIER_JXL_UPLOAD__ !== 'undefined' && __RAPIER_JXL_UPLOAD__ === true) && splitApps ? readEach(parts.map(part => () => part.subarray(0, Math.min(36, part.length)))) : null;
  for (let i = 0; i < parts.length; i++) {
    const seg = parts[i];
    if (!(typeof __RAPIER_JXL_UPLOAD__ !== 'undefined' && __RAPIER_JXL_UPLOAD__ === true) && splitApps) {
      const k = appKind(heads[i]);
      if (state.lastKind !== -1 && k !== state.lastKind && state.curOff - state.curStart >= 1024 && seg.length >= 512) { cuts.push(state.curOff); state.curStart = state.curOff; }
      if (seg.length >= 1024) state.lastKind = k;
    }
    state.curOff += seg.length;
  }
  return {state, cuts};
}
function payloadTailWindow(tail, previous) {
  const state = {...previous}, cuts = [], start = state.at, stop = Math.min(tail.length, start + 65536);
  const window = tail.subarray(start, Math.min(tail.length, stop + 4)), byte = at => window[at - start];
  const entropyEnd = (at, code) => {
    const after = code === 217 ? at + 2 : at;
    if (at - state.sosEnd >= 1024) { cuts.push(state.sosEnd); if (after < tail.length) cuts.push(after); }
    state.at = after; state.phase = code === 217 ? 'search' : 'marker';
  };
  while (state.at < stop) {
    if (state.phase === 'search') {
      const at = state.at;
      if (at + 4 >= tail.length) { state.done = true; break; }
      if (byte(at) !== 255 || byte(at + 1) !== 216 || byte(at + 2) !== 255 || byte(at + 3) < 192 || byte(at + 3) > 254) { state.at++; continue; }
      state.at += 2; state.phase = 'marker';
    }
    if (state.phase === 'marker') {
      if (state.at + 4 > tail.length || byte(state.at) !== 255) { state.phase = 'search'; continue; }
      state.phase = 'code';
    }
    if (state.phase === 'code') {
      while (state.at < stop && byte(state.at) === 255) state.at++;
      if (state.at >= stop) break;
      const code = byte(state.at++);
      state.phase = 'marker';
      if (code === 217) { state.at++; state.phase = 'search'; continue; }
      if (code === 216 || code >= 208 && code <= 215 || code === 1) continue;
      const length = byte(state.at) * 256 + byte(state.at + 1);
      if (state.at + 2 > tail.length || !(length >= 2) || state.at + length > tail.length) { state.phase = 'search'; continue; }
      state.at += length;
      if (code === 218) { state.sosEnd = state.at; state.phase = 'entropy'; }
      continue;
    }
    if (state.phase === 'entropy') {
      while (state.at < stop && byte(state.at) !== 255) state.at++;
      if (state.at >= stop) break;
      state.at++; state.phase = 'entropy-code';
    }
    if (state.phase === 'entropy-code') {
      if (state.at >= stop) break;
      const code = byte(state.at);
      if (code === 0 || code >= 208 && code <= 215) { state.at++; state.phase = 'entropy'; continue; }
      entropyEnd(state.at - 1, code);
      if (state.at < start) break;
    }
  }
  if (state.at >= tail.length) {
    if (state.phase === 'entropy' || state.phase === 'entropy-code') entropyEnd(state.at);
    state.done = true;
  }
  return {state, cuts};
}
function* writeDataHeader(data) {
  if (journaling()) return yield* journalTool('jpegSyntax')(headerFields(data), BitWriter);
  const writer = new BitWriter();
  for (const [, count, , write] of headerFields(data)) if (count) write(writer, 0, count);
  return writer.finish();
}
function* headerFields(data) {
  const grey = data.components.length === 1;
  yield ['jpeg-syntax-start', 1, 1, w => w.write(1, grey ? 1 : 0)];
  yield ['jpeg-syntax-markers', data.markers.length, 1024, (w, from, to) => {
    for (let i = from; i < to; i++) w.write(6, data.markers[i] - 192);
  }];
  for (const key of ['apps', 'comments']) yield ['jpeg-syntax-lengths', data[key].length, 1024, (w, from, to) => {
    for (let i = from; i < to; i++) { if (key === 'apps') w.write(2, 0); w.write(16, data[key][i].length - 1); }
  }];
  yield ['jpeg-syntax-tables', 1, 1, w => {
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
  }];
  yield ['jpeg-syntax-scans', data.scans.length, 256, (w, from, to) => {
    for (let i = from; i < to; i++) {
      const scan = data.scans[i];
      w.writeU32(FOUR, scan.components.length); w.write(6, scan.ss); w.write(6, scan.se); w.write(4, scan.al); w.write(4, scan.ah);
      for (const c of scan.components) { w.write(2, c.index); w.write(2, c.ac); w.write(2, c.dc); }
      w.write(2, 0);
    }
  }];
  yield ['jpeg-syntax-restart', 1, 1, w => { if (data.markers.includes(221)) w.write(16, data.restart); }];
  for (const scan of data.scans) {
    for (const key of ['resets', 'zeros']) {
      const values = scan[key], stride = key === 'zeros' ? 2 : 1;
      yield ['jpeg-syntax-events', Math.max(1, values.length), 8192 * stride, (w, from, to) => {
        if (!from) w.writeU32(EVENTS, values.length / stride);
        let previous = from ? values[from - stride] : -1;
        for (let i = from; i < Math.min(values.length, to); i += stride) {
          const block = values[i];
          if (stride === 2) w.writeU32([[0, 1], [2, 2], [4, 5], [8, 20]], values[i + 1]);
          w.writeU32(BLOCK, block - previous - 1); previous = block;
        }
      }];
    }
  }
  yield ['jpeg-syntax-inter', data.inter.length, 1024, (w, from, to) => {
    for (let i = from; i < to; i++) w.write(16, data.inter[i].length);
  }];
  yield ['jpeg-syntax-tail', 1, 1, w => {
    w.writeU32(TAIL, data.tail.length); w.write(1, data.padding ? 1 : 0);
    if (data.padding) w.write(24, data.padding.length);
  }];
  if (data.padding) yield ['jpeg-syntax-padding', data.padding.length, 65536, (w, from, to) => {
    for (const bit of data.padding.subarray(from, to)) w.write(1, bit);
  }];
  yield ['jpeg-syntax-end', 1, 1, w => w.zeroPadToByte()];
}

function* writeData(data, effort, contextsFrom) {
  const payload = [...data.apps, ...data.comments, ...data.inter, data.tail].reduce((n, part) => n + part.length, 0);
  if (payload > RECONSTRUCTION_PAYLOAD_BYTES) throw jpegError('metadata past ' + RECONSTRUCTION_PAYLOAD_BYTES + ' bytes');
  const header = yield* stage('jpeg-syntax', () => writeDataHeader(data), undefined, false, true);
  const raw = journaling() ? journalJoin([...data.apps, ...data.comments, ...data.inter, data.tail])
    : concatenate([...data.apps, ...data.comments, ...data.inter, data.tail]);
  let packed = yield* brotliStoreSteps(raw);
  if (raw.length > 32) {
    const literalContexts = effort >= 7 || effort >= contextsFrom && raw.length <= CONTEXT_BYTES;
    try {
      const cuts = yield* stage('jpeg-payload-cuts', () => payloadCuts(data, !(typeof __RAPIER_JXL_UPLOAD__ !== 'undefined' && __RAPIER_JXL_UPLOAD__ === true) && effort >= 5));
      const compressed = yield* compressBrotliSteps(raw, {literalContexts, thorough: !(typeof __RAPIER_JXL_UPLOAD__ !== 'undefined' && __RAPIER_JXL_UPLOAD__ === true) && effort >= 5, cuts, kernels: kernelHooks.entropy?.()}, unit);
      if (compressed.length < packed.length) packed = compressed;
    }
    catch (error) { if (error.code !== 'JXL_SIZE' && error.code !== 'JXL_INPUT') throw error; }
  }
  const parts = [header, packed]; return journaling() ? journalJoin(parts) : concatenate(parts);
}

const sharedICC = /* @__PURE__ */ iccInverse(requireJPEG, (v, max) => requireJPEG(Number.isSafeInteger(v) && v >= 0 && v <= max));
export const unpredictICC = enc => sharedICC.decode(enc);
export function* unpredictICCSteps(enc) {
  if (!journaling()) return unpredictICC(enc);
  return yield* journalTool('jpegICC')(enc, undefined, sharedICC.owner);
}

const EXIF_TAG = /* @__PURE__ */ Uint8Array.of(69, 120, 105, 102, 0, 0), ICC_TAG = /* @__PURE__ */ Uint8Array.of(73, 67, 67, 95, 80, 82, 79, 70, 73, 76, 69, 0);
const XMP_TAG = /* @__PURE__ */ Uint8Array.from('http://ns.adobe.com/xap/1.0/\0', char => char.charCodeAt(0));
function materializeApp(app, raw, sources, previous, iccCount) {
  const state = {...previous}, {icc, exif, xml} = sources;
  const out = new Uint8Array(app.length); out[1] = (app.length - 1) >> 8; out[2] = (app.length - 1) & 255;
  if (!app.type) {
    out.set(raw.subarray(state.raw, state.raw += app.length)); requireJPEG(out[1] * 256 + out[2] + 1 === out.length);
  } else if (app.type === 1) {
    const n = app.length - 17; requireJPEG(n >= 0 && icc && state.icc + n <= icc.length);
    out[0] = 226; out.set(ICC_TAG, 3); out[15] = ++state.sequence; out[16] = iccCount; out.set(icc.subarray(state.icc, state.icc += n), 17);
  } else if (app.type === 2) {
    requireJPEG(!state.exif && exif && exif.length >= 4 && !(exif[0] | exif[1] | exif[2] | exif[3]) && app.length === exif.length + 5);
    out[0] = 225; out.set(EXIF_TAG, 3); out.set(exif.subarray(4), 9); state.exif = true;
  } else {
    requireJPEG(!state.xml && xml && app.length === xml.length + 32);
    out[0] = 225; out.set(XMP_TAG, 3); out.set(xml.subarray(0), 32); state.xml = true;
  }
  return {bytes: out, state};
}
function readDataHeader(bytes) {
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
  return {data, bit: r.bit};
}
function* scanEvents(bytes, bit, zero, remaining) {
  const head = yield* unit('jpeg-event-count', () => { const r = new JxlBits(bytes); r.bit = bit; return {count: r.u32(EVENTS), bit: r.bit}; });
  const parts = []; let previous = -1; bit = head.bit;
  for (let from = 0; from < head.count; from += 8192) {
    const part = yield* unit('jpeg-events', () => {
      const r = new JxlBits(bytes); r.bit = bit;
      const count = Math.min(8192, head.count - from), values = new Uint32Array(count * (zero ? 2 : 1)); let last = previous;
      for (let i = 0; i < count; i++) {
        if (from + i >= remaining) throw fault('JXL_RECONSTRUCTION', `JPEG reconstruction data has over ${RECONSTRUCTION_SCAN_EVENTS} scan events.`);
        const run = zero ? r.u32([[0, 1], [2, 2], [4, 5], [8, 20]]) : 0;
        last += 1 + r.u32(BLOCK); requireJPEG(last < 201326592 && run <= 4);
        values[i * (zero ? 2 : 1)] = last; if (zero) values[i * 2 + 1] = run;
      }
      return {values, last, bit: r.bit};
    });
    parts.push(part.values); previous = part.last; bit = part.bit;
  }
  const values = yield* unit('jpeg-event-list', () => {
    const out = new Uint32Array(head.count * (zero ? 2 : 1)); let at = 0;
    for (const part of parts) { out.set(part, at); at += part.length; } return out;
  });
  return {values, bit, count: head.count};
}
function* readDataSteps(bytes, sources = {}, dictionary, jpeg) {
  const head = yield* unit('jpeg-data-header', () => readDataHeader(bytes)), data = {...head.data, scans: head.data.scans.map(scan => ({...scan}))};
  let bit = head.bit, events = 0;
  for (const scan of data.scans) for (const key of ['resets', 'zeros']) {
    const list = yield* scanEvents(bytes, bit, key === 'zeros', RECONSTRUCTION_SCAN_EVENTS - events); bit = list.bit; events += list.count;
    scan[key] = list.values;
  }
  const lengths = yield* unit('jpeg-data-lengths', () => {
    const r = new JxlBits(bytes); r.bit = bit;
    const inter = []; for (const marker of data.markers) if (marker === 255) inter.push(r.read(16));
    const tail = r.u32(TAIL); requireJPEG(tail <= 4260096);
    const padding = r.read(1) ? r.read(24) : null; requireJPEG(padding === null || padding <= 16777216);
    return {inter, tail, padding, bit: r.bit};
  });
  if (lengths.padding !== null) requireJPEG(lengths.padding <= 7 * data.scans.length * (1 + (data.restart ? Math.floor(Math.ceil(jpeg.width / 8) * Math.ceil(jpeg.height / 8) / data.restart) : 0)));
  data.inter = lengths.inter; data.tail = lengths.tail; bit = lengths.bit; data.padding = null;
  if (lengths.padding !== null) {
    const parts = [];
    for (let from = 0; from < lengths.padding; from += 65536) {
      const part = yield* unit('jpeg-padding', () => {
        const r = new JxlBits(bytes); r.bit = bit;
        const values = Uint8Array.from({length: Math.min(65536, lengths.padding - from)}, () => r.read(1)); return {values, bit: r.bit};
      });
      parts.push(part.values); bit = part.bit;
    }
    data.padding = journaling() ? journalJoin(parts) : concatenate(parts);
  }
  const start = yield* unit('jpeg-data-start', () => { const r = new JxlBits(bytes); r.bit = bit; r.align(); return r.bit / 8; });
  const brotliBytes = data.tail + data.comments.reduce((n, v) => n + v, 0) + data.inter.reduce((n, v) => n + v, 0) + data.apps.reduce((n, app) => n + (app.type ? 0 : app.length), 0);
  requireJPEG(brotliBytes <= RECONSTRUCTION_PAYLOAD_BYTES);
  let raw;
  try { raw = yield* openBrotliSteps(sliceBytes(bytes, start), Math.max(brotliBytes, 1), dictionary); }
  catch (error) { if (unread(error) || error.code === 'JXL_SIZE' || error.code === 'JXL_DICTIONARY') throw error; requireJPEG(false); }
  requireJPEG(raw.length === brotliBytes);
  const apps = [], iccCount = data.apps.reduce((n, app) => n + (app.type === 1), 0);
  let state = {raw: 0, icc: 0, sequence: 0, exif: false, xml: false};
  for (const app of data.apps) {
    const part = yield* unit('jpeg-app', () => materializeApp(app, raw, sources, state, iccCount));
    apps.push(part.bytes); state = part.state;
  }
  requireJPEG(!iccCount || state.icc === sources.icc.length); data.apps = apps;
  let at = state.raw;
  const comments = [], inter = [];
  for (const count of data.comments) {
    comments.push(yield* unit('jpeg-comment', () => {
      const part = raw.subarray(at, at + count); requireJPEG(part.length === count && part[1] * 256 + part[2] + 1 === part.length); return part;
    })); at += count;
  }
  for (const count of data.inter) { inter.push(sliceBytes(raw, at, at + count)); at += count; }
  data.comments = comments; data.inter = inter; data.tail = sliceBytes(raw, at, at + data.tail); at += data.tail.length;
  requireJPEG(at === raw.length); return data;
}

export const JBRD_TAIL = 4260096, MAX_NESTING = 4, TAIL_BYTES = 256 << 20;
const GAIN_MAP = 0x6a68676d, ISO_GAIN_MAP = 'urn:iso:std:iso:ts:21496:-1\0';
const UUID = 0x75756964, RAPIER_TAIL = /* @__PURE__ */ Uint8Array.of(0xac, 0x02, 0x9a, 0x3b, 0x18, 0x88, 0x4a, 0x6d, 0x9b, 0x2c, 0xf7, 0x91, 0x12, 0x75, 0xbb, 0x1b);
export function admitTail(length) {
  if (length > RECONSTRUCTION_PAYLOAD_BYTES) throw jpegError('data after the JPEG past ' + RECONSTRUCTION_PAYLOAD_BYTES + ' bytes');
}
export function withTail(file, kind, length, parts, gainMap = null) {
  admitTail(length);
  const size = parts.reduce((n, part) => n + part.length, 0), header = new Uint8Array(22);
  header.set(RAPIER_TAIL); header[16] = 1; header[17] = kind; new DataView(header.buffer).setUint32(18, length);
  const pieces = gainMap ? [file, boxHeader(GAIN_MAP, gainMap.length), gainMap] : [file];
  pieces.push(boxHeader(UUID, 22 + size), header, ...parts);
  admitOutputSize(pieces.reduce((n, part) => n + part.length, 0));
  return journaling() ? journalJoin(pieces) : concatenate(pieces);
}
export const packTail = tail => complete(packTailSteps(tail));
export function* packTailSteps(tail) {
  try { const compressed = yield* compressBrotliSteps(tail, {literalContexts: false, kernels: kernelHooks.entropy?.()}, unit); if (compressed.length < tail.length) return compressed; }
  catch (error) { if (error.code !== 'JXL_SIZE' && error.code !== 'JXL_INPUT') throw error; }
  return yield* brotliStoreSteps(tail);
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
    if (box.type === CODESTREAM && !codestream) codestream = sliceBytes(file, box.body, box.end);
    else kept.push(sliceBytes(file, box.at, box.end));
  }
  const join = journaling() ? journalJoin : concatenate;
  const bundle = join([Uint8Array.of(0, metadata.length >> 8, metadata.length & 255), metadata, Uint8Array.of(0, 0, 0, 0, 0), codestream]);
  return {bundle, rest: join([sliceBytes(file, 0, 12), ...kept])};
}
function gainMapCodestream(bytes) {
  for (const box of boxes(bytes)) if (box.type === GAIN_MAP) {
    const body = sliceBytes(bytes, box.body, box.end);
    requireJPEG(body.length >= 3 && body[0] === 0);
    let at = 3 + (body[1] << 8 | body[2]);
    requireJPEG(at < body.length); at += 1 + body[at];
    requireJPEG(at + 4 <= body.length); const field = body.subarray(at, at + 4); at += 4 + new DataView(field.buffer, field.byteOffset, 4).getUint32(0);
    requireJPEG(at < body.length); return sliceBytes(body, at);
  }
  requireJPEG(false);
}

function tailOf(bytes) {
  let found = null;
  for (const box of boxes(bytes)) if (box.type === UUID && box.end - box.body >= 16 && RAPIER_TAIL.every((v, i) => bytes[box.body + i] === v)) {
    requireJPEG(!found && box.end - box.body >= 22); found = sliceBytes(bytes, box.body + 16, box.end);
  }
  return found;
}
function* openTailSteps(box, dictionary, maxPixels, bands, depth, bytes, budget) {
  requireJPEG(box[0] === 1 && box[1] <= 2 && (!box[1] || depth + 2 <= MAX_NESTING));
  const prefix = box.subarray(0, Math.min(10, box.length)), view = new DataView(prefix.buffer, prefix.byteOffset, prefix.byteLength), length = view.getUint32(2);
  requireJPEG(length <= RECONSTRUCTION_PAYLOAD_BYTES && length <= budget.left && box.length >= (box[1] ? 10 : 6));
  budget.left -= length;
  const packed = box[1] ? view.getUint32(6) : box.length - 6, body = sliceBytes(box, box[1] ? 10 : 6);
  requireJPEG(packed <= body.length);
  const raw = yield* stage('tail-data', function* () {
    let result;
    try { result = yield* openBrotliSteps(sliceBytes(body, 0, packed), Math.max(length, 1), dictionary); }
    catch (error) { if (unread(error) || error.code === 'JXL_SIZE' || error.code === 'JXL_DICTIONARY') throw error; requireJPEG(false); }
    requireJPEG(result.length === length); return result;
  });
  if (!box[1]) return raw;
  let file = sliceBytes(body, packed);
  if (box[1] === 2) { const codestream = gainMapCodestream(bytes), parts = [file, boxHeader(CODESTREAM, codestream.length), codestream]; file = journaling() ? journalJoin(parts) : concatenate(parts); }
  const next = yield* restoreSteps(file, dictionary, maxPixels, bands, null, depth + 1, budget); requireJPEG(next && next.length <= budget.left);
  budget.left -= next.length;
  requireJPEG(raw.length + next.length <= budget.left); budget.left -= raw.length + next.length;
  return journaling() ? journalJoin([raw, next]) : concatenate([raw, next]);
}

export const carryJPEG = (bytes, jpeg, codestream, effort, contextsFrom) => complete(carryJPEGSteps(bytes, jpeg, codestream, effort, contextsFrom));
export function* carryJPEGSteps(bytes, jpeg, codestream, effort = 1, contextsFrom = 7) {
  try {
    const data = yield* stage('structure', () => structure(bytes, jpeg));
    if (!(yield* stage('check', () => writeJPEGSteps(jpeg, data, bytes)))) throw jpegError('JPEG syntax cannot be reconstructed exactly');
    return withJPEGReconstruction(codestream, yield* stage('data', () => writeData(data, effort, contextsFrom)));
  } catch (error) {
    if (error.code === 'JXL_RECONSTRUCTION') throw jpegError('JPEG syntax cannot be reconstructed exactly');
    throw error;
  }
}

const CHUNK = 1 << 20;
class JPEGOutput {
  constructor(expected = null, limit = Infinity) {
    this.limit = limit;
    this.parts = journaling() && !expected ? [] : null;
    this.expected = expected; this.same = true; this.chunks = []; this.done = 0;
    this.bytes = new Uint8Array(expected ? Math.min(CHUNK, expected.length + 16) : 4096); this.at = 0; this.acc = 0; this.pending = 0;
  }
  spill(n) {
    const filled = this.bytes.subarray(0, this.at), total = this.done + this.at;
    admitOutputSize(total + n); requireJPEG(total + n <= this.limit);
    if (this.expected) {
      const expected = this.expected;
      const want = this.same ? expected.subarray(this.done, this.done + filled.length) : null;
      if (want) for (let i = 0; i < filled.length; i++) if (filled[i] !== want[i]) { this.same = false; break; }
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
    if (!pad.window || pad.at < pad.start || pad.at + n > pad.start + pad.window.length) {
      pad.start = pad.at; pad.window = pad.bits.subarray(pad.at, Math.min(pad.bits.length, pad.at + 65536));
    }
    for (let i = 0; i < n; i++) { const bit = pad.window[pad.at - pad.start]; requireJPEG(pad.at < pad.bits.length && bit <= 1); pattern = pattern * 2 + bit; pad.at++; }
    this.bits(n, pattern);
  }
  take() {
    this.spill(0);
    const bytes = concatenate(this.chunks); this.chunks = []; return bytes;
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
function scanGrid(jpeg, scan) {
  const components = jpeg.components, hmax = Math.max(...components.map(c => c.h)), vmax = Math.max(...components.map(c => c.v));
  const single = scan.components.length === 1, lead = components[scan.components[0].index];
  return {hmax, vmax, single, lead, nx: Math.ceil(jpeg.width * (single ? lead.h : 1) / (8 * hmax)), ny: Math.ceil(jpeg.height * (single ? lead.v : 1) / (8 * vmax))};
}
function* writeScan(out, jpeg, scan, huffman, restart, progressive, pad, nonzero) {
  const {ss, se, al, ah} = scan, components = jpeg.components, bands = jpeg.rows?.();
  requireJPEG(progressive ? ss === 0 ? se === 0 : scan.components.length === 1 : ss === 0 && se === 63 && !al && !ah);
  if (bands) jpeg.reset?.();
  const preds = new Int32Array(components.length);
  const events = yield* unit('scan-events', () => {
    const zeros = scan.zeros.length ? new Map() : null;
    for (let i = 0; i < scan.zeros.length; i += 2) zeros.set(scan.zeros[i], scan.zeros[i + 1]);
    return {resets: Int32Array.from(scan.resets).sort(), zeros};
  });
  const resets = events.resets, writer = new ScanWriter(out, scan, events.zeros);
  const entries = scan.components.map(entry => ({index: entry.index, co: components[entry.index].coeffs, row0: 0, dc: huffman[entry.dc] || NO_CODE, ac: huffman[16 + entry.ac] || NO_CODE,
    nonzero: progressive && ss && !bands ? nonzero(entry.index) : null}));
  const {hmax, vmax, single, lead, nx, ny} = scanGrid(jpeg, scan);
  const shapes = entries.map(entry => { const c = components[entry.index]; return {stride: c.stride, h: single ? 1 : c.h, v: single ? 1 : c.v}; });
  if (!progressive && !bands) {
    const written = kernelHooks.entropy?.()?.sequentialScan(out, entries.map((entry, e) => ({...entry, ...shapes[e]})), nx, ny, restart,
      writer.zeros || new Map(), pad, NATURAL);
    if (written === null) requireJPEG(false);
    if (written) {
      const blocks = nx * ny * shapes.reduce((n, {h, v}) => n + h * v, 0);
      requireJPEG(scan.resets.every(n => n < blocks) && scan.zeros.every((value, i) => i % 2 || value < blocks)); out.align(pad);
      return;
    }
  }
  let nextReset = 0;
  const per = 32 * (single ? lead.v : 1) / vmax, banded = bands && jpeg.band && (out.expected || out.parts);
  const rows = (from, to) => {
  for (let m = from * nx, y = from; y < to; y++) {
    if (bands && (!(y % per) || banded && y === from)) {
      if (banded) {
        jpeg.band(Math.floor(y / per));
        for (const e of entries) {
          ({coeffs: e.co, row0: e.row0} = components[e.index]);
          if (progressive && ss) e.nonzero = nonzeroMasks({coeffs: e.co});
        }
      }
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
  else if (!journaling()) for (let from = 0, step = per % 2 ? per : per / 2; from < ny; from += step) rows(from, Math.min(ny, from + step));
  else yield* journalTool('jpegScanRows')({out, jpeg, writer, preds, ny, per, pad}, {rows,
    nextReset: () => nextReset, restoreReset: value => { nextReset = value; }});
  const blocks = writer.blockIndex;
  requireJPEG(scan.resets.every(n => n < blocks) && scan.zeros.every((value, i) => i % 2 || value < blocks)); writer.flush(); out.align(pad);
}
const writeJPEG = (jpeg, data, expected, limit) => complete(writeJPEGSteps(jpeg, data, expected, limit));
function admitInter(run, scanFill, started, jpeg, data) {
  let sofs = 0;
  for (let p = 0; p < run.length;) {
    requireJPEG(run[p] === 255);
    if (scanFill && run[p + 1] === 0) { p += 2; continue; }
    scanFill = false;
    while (run[p + 1] === 255) p++;
    if (p + 1 === run.length) break;
    const code = run[p + 1];
    if (code === 1) { p += 2; continue; }
    const length = run[p + 2] * 256 + run[p + 3], end = p + 2 + length, body = p + 4;
    requireJPEG(p + 4 <= run.length && length >= 2 && end <= run.length);
    if (code === 219) {
      for (let q = body; q < end;) {
        const wide = run[q] >> 4, index = run[q++] & 15;
        requireJPEG(wide <= 1 && index <= 3 && q + 64 * (1 + wide) <= end);
        const values = new Int32Array(64);
        for (let k = 0; k < 64; k++, q += 1 + wide) values[ZIGZAG[k]] = wide ? run[q] * 256 + run[q + 1] : run[q];
        jpeg.components.forEach((c, i) => requireJPEG(c.tq !== index || equal(c.quant, values) || started.has(i)));
      }
    } else if (code === 196) requireJPEG(length === 2);
    else if (code === 192 || code === 193) {
      const count = jpeg.components.length, factors = run[body + 7];
      requireJPEG(!started.size && !jpeg.ycbcr && data.scans.every(scan => scan.components.length === 1) && length === 8 + 3 * count && run[body] === 8 &&
        run[body + 1] * 256 + run[body + 2] === jpeg.height && run[body + 3] * 256 + run[body + 4] === jpeg.width && run[body + 5] === count &&
        factors >> 4 >= 1 && factors >> 4 <= 4 && (factors & 15) >= 1 && (factors & 15) <= 4);
      jpeg.components.forEach((c, i) => { const at = body + 6 + 3 * i; requireJPEG(run[at] === c.id && run[at + 1] === factors && run[at + 2] === c.tq); });
      sofs++;
    } else requireJPEG(code === 200 || code === 204 || code === 220 || code === 222 || code === 223 || code >= 224 && code <= 254);
    p = end;
  }
  return sofs;
}
function admitSyntax(jpeg, data) {
  let chunk = 0, prev = 0, sofs = 0, scans = 0, restart = 0, scan = null;
  const started = new Set();
  for (let i = 0; i < data.markers.length; i++) {
    const marker = data.markers[i];
    if (marker === 255) {
      let n = 1; while (data.markers[i + n] === 255) n++;
      sofs += admitInter(concatenate(data.inter.slice(chunk, chunk += n)), prev === 218, started, jpeg, data); i += n - 1;
      continue;
    }
    if (marker >= 192 && marker <= 194) { requireJPEG(!started.size); sofs++; }
    if (marker === 218) { requireJPEG(sofs === 1); scan = data.scans[scans++]; for (const c of scan.components) started.add(c.index); }
    if (marker >= 208 && marker <= 215) {
      const {nx, ny} = scanGrid(jpeg, scan ?? requireJPEG(0));
      requireJPEG(prev === 218 && restart && nx * ny % restart === 0 && marker === 208 + ((nx * ny / restart - 1) & 7));
    }
    if (marker === 221) restart = data.restart;
    prev = marker;
  }
  requireJPEG(sofs === 1);
}
function* writeJPEGSteps(jpeg, data, expected = null, limit = Infinity) {
  const out = new JPEGOutput(expected, limit), huffman = [], pad = data.padding ? {bits: data.padding, at: 0} : null;
  const metadata = function* (write) {
    if (!journaling()) { write(); return; }
    yield* journalTool('jpegMarker')(out, write);
  };
  const coverage = jpeg.components.map(() => ({coverage: new Int8Array(64).fill(-1)}));
  const masks = [], nonzero = index => masks[index] ||= nonzeroMasks(jpeg.components[index]);
  let app = 0, comment = 0, inter = 0, quant = 0, table = 0, scan = 0, restart = 0, progressive = false;
  out.marker(216);
  for (const marker of data.markers) {
    if (marker >= 224 && marker <= 239 || marker === 254) {
      const part = marker === 254 ? data.comments[comment++] : data.apps[app++];
      yield* metadata(() => { requireJPEG(part[0] === marker && part[1] * 256 + part[2] === part.length - 1); out.byte(255); out.chunk(part); });
    } else if (marker === 255) { const part = data.inter[inter++]; yield* metadata(() => out.chunk(part)); }
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
      if (journaling() && (out.expected || out.parts))
        yield* journalTool('jpegScan')(out, pad, () => writeScan(out, jpeg, info, huffman, restart, progressive, pad, nonzero));
      else yield* writeScan(out, jpeg, info, huffman, restart, progressive, pad, nonzero);
    } else if (marker === 217) {
      out.marker(marker);
      if (out.expected && journaling()) for (let at = 0; at < data.tail.length; at += 65536)
        yield* metadata(() => out.chunk(data.tail.subarray(at, Math.min(data.tail.length, at + 65536))));
      else if (!out.parts) out.chunk(data.tail);
    }
    else if (marker >= 208 && marker <= 215) out.marker(marker);
    else requireJPEG(false);
  }
  requireJPEG(coverage.every(c => c.coverage.every(value => value === 0)) && (!pad || pad.at === pad.bits.length));
  if (!out.parts) return out.finish();
  return yield* journalTool('jpegEnd')(out, data.tail, requireJPEG);
}

function* openBrotliSteps(input, maxOutputLength, dictionary) {
  try { return yield* decompressBrotliSteps(input, {maxOutputLength, dictionary: typeof dictionary === 'function' ? dictionary : undefined}); }
  catch (error) {
    if (error.dictionary !== true) throw error;
    throw fault('JXL_DICTIONARY', 'This file\'s JPEG data refers to the Brotli dictionary.');
  }
}
function* openBoxSteps(part, compressed, dictionary) {
  if (!part) return null;
  if (!compressed) return part;
  const maximum = Math.min(Math.max(part.length * 16, 1 << 20), RECONSTRUCTION_PAYLOAD_BYTES);
  try { return yield* openBrotliSteps(part, maximum, dictionary); }
  catch (error) {
    if (unread(error) || error.code === 'JXL_SIZE' || error.code === 'JXL_DICTIONARY') throw error;
    requireJPEG(false);
  }
}
export const restoreJPEG = (bytes, dictionary, options) => complete(restoreJPEGSteps(bytes, dictionary, options));
export function* restoreJPEGSteps(bytes, dictionary, {maxPixels, bands = true} = {}, shown = null) {
  try { return yield* restoreSteps(bytes, dictionary, maxPixels, bands, shown); }
  catch (error) { guard(() => { throw error; }); }
}
function* restoreSteps(bytes, dictionary, maxPixels, bands, shown = null, depth = 0, budget = {left: TAIL_BYTES}) {
  const boxed = yield* jpegReconstructionSteps(bytes);
  if (!boxed) return null;
  let jpeg = yield* readJPEGCoefficientsSteps(boxed.codestream, {reconstruction: true, maxPixels, rows: true});
  const data = yield* stage('jpeg-data', function* () {
    const stream = boxed.reconstruction; requireJPEG(stream);
    const icc = jpeg.icc ? yield* unpredictICCSteps(jpeg.icc) : null;
    const exif = yield* openBoxSteps(boxed.exif, boxed.exifCompressed, dictionary), xml = yield* openBoxSteps(boxed.xml, boxed.xmlCompressed, dictionary);
    return yield* readDataSteps(stream, {icc, exif, xml}, dictionary, jpeg);
  });
  shown?.(jpeg, data.apps);
  const banded = bands && (journaling() || data.scans.length === 1 && !data.markers.includes(194));
  if (!banded) jpeg = jpeg.whole();
  requireJPEG(data.components.length === jpeg.components.length);
  for (let i = 0; i < jpeg.components.length; i++) {
    const c = jpeg.components[i], descriptor = data.components[i], q = data.quant[descriptor.quant];
    requireJPEG(!q.values || equal(q.values, c.quant)); q.values = c.quant; c.id = descriptor.id; c.tq = q.index;
  }
  for (let i = 0; i < data.quant.length; i++) { data.quant[i].values ||= data.quant[i - 1]?.values; requireJPEG(data.quant[i].values); }
  const tail = tailOf(bytes);
  if (tail) {
    requireJPEG(!data.tail.length);
    const kept = yield* stage('jpeg-tail', function* () {
      const restored = yield* openTailSteps(tail, dictionary, maxPixels, bands, depth, bytes, budget);
      return {bytes: restored, left: budget.left};
    });
    data.tail = kept.bytes; budget.left = kept.left;
  }
  admitSyntax(jpeg, data);
  return yield* writeJPEGSteps(jpeg, data, null, depth ? budget.left : Infinity);
}
