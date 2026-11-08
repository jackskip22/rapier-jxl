// SPDX-License-Identifier: MIT
import {BitWriter} from './bits.mjs';
import {tocMaxBytes, varDCTSectionCount, writeTOCSizes} from './frame.mjs';
import {allocateTyped, prefetchTyped} from './typed-views.mjs';
import {admitOutputSize, fault} from './admit.mjs';
const COPY = 4096;
const bitData = writer => ({bytes: writer.bytes, at: writer.at, pending: writer.pending, acc: writer.acc});
const bitLength = data => data.at * 8 + data.pending;
const capacity = (stream, sections) => Math.ceil(stream.plan.bits / 8) + (stream.index < 0 ? tocMaxBytes(sections) + 24 : 16);
const bad = () => { throw fault('JXL_INPUT', 'Invalid VarDCT prefix assembly checkpoint.'); };
function validBits(data) {
  return data?.bytes instanceof Uint8Array && Number.isSafeInteger(data.at) && data.at >= 0 && data.at <= data.bytes.length &&
    Number.isInteger(data.pending) && data.pending >= 0 && data.pending < 8 && Number.isInteger(data.acc) && data.acc >= 0 && data.acc < (1 << data.pending);
}
export class VarDCTPrefixWriter extends BitWriter {
  constructor(capacity = 256) { super(capacity); this.parts = []; this.recordedBits = 0; }
  flushPart() {
    if (this.at || this.pending) {
      this.parts.push(bitData(this)); this.recordedBits += super.bitLength;
      this.bytes = new Uint8Array(256); this.at = 0; this.acc = 0; this.pending = 0;
    }
  }
  append(other) {
    if (!validBits(other)) bad();
    this.flushPart();
    if (other.at || other.pending) { this.parts.push(bitData(other)); this.recordedBits += bitLength(other); }
  }
  get bitLength() { return this.recordedBits + super.bitLength; }
  zeroPadToByte() { const n = (-this.bitLength) & 7; if (n) this.write(n, 0); }
  finish() { throw fault('JXL_INPUT', 'A recorded VarDCT prefix must be assembled before it is finished.'); }
  record() { this.flushPart(); return {bits: this.recordedBits, parts: this.parts}; }
}
export function varDCTPrefixLimits({numGroups, numDcGroups, numPasses}) {
  if (!Number.isSafeInteger(numGroups) || numGroups < 1 || !Number.isSafeInteger(numDcGroups) || numDcGroups < 1 || numDcGroups > numGroups ||
      !Number.isInteger(numPasses) || numPasses < 1 || numPasses > 11 || numGroups === 1 && numDcGroups !== 1) bad();
  const sections = varDCTSectionCount(numGroups, numDcGroups, numPasses);
  if (!Number.isSafeInteger(sections) || sections >= 2 ** 32) bad();
  const headerParts = 2 * 7 + 1;
  const dcParts = 2 * 4 + 1, acParts = 2 * (17 + 2 * numPasses) + 1;
  return {numGroups, numDcGroups, numPasses, sections, streams: sections === 1 ? 2 : 3 + numDcGroups,
    headerParts, dcParts, acParts, singleParts: dcParts + numDcGroups + acParts};
}
const partLimit = (limits, index) => index < 0 ? limits.headerParts : limits.sections === 1 ? limits.singleParts :
  index === 0 ? limits.dcParts : index === 1 + limits.numDcGroups ? limits.acParts : 1;
function validPlan(plan, maximum) {
  if (!plan || !Number.isSafeInteger(plan.bits) || plan.bits < 0 || !Array.isArray(plan.parts) || plan.parts.length > maximum) bad();
  let bits = 0;
  for (const part of plan.parts) { if (!validBits(part) || !bitLength(part)) bad(); bits += bitLength(part); }
  if (bits !== plan.bits) bad();
  admitOutputSize(Math.ceil(bits / 8));
}
export function startVarDCTPrefixAssembly(prefix, layout) {
  const limits = varDCTPrefixLimits(layout);
  if (!prefix || !Array.isArray(prefix.writers) || prefix.writers.length !== limits.sections) bad();
  validPlan(prefix.header, limits.headerParts);
  return {version: 1, shape: {numGroups: limits.numGroups, numDcGroups: limits.numDcGroups, numPasses: limits.numPasses},
    phase: 'admit', prefixWriters: prefix.writers, admitted: 0, verified: 0,
    streams: [{index: -1, plan: prefix.header}], stream: 0, part: 0, offset: 0, writer: null, header: null, sections: []};
}
export function advanceVarDCTPrefixAssembly(state, budget, layout) {
  const limits = varDCTPrefixLimits(layout);
  if (!state?.shape || ['numGroups', 'numDcGroups', 'numPasses'].some(key => state.shape[key] !== limits[key])) bad();
  if (state.version !== 1 || !['admit', 'verify', 'stream', 'append', 'done'].includes(state.phase) ||
      !Number.isSafeInteger(budget) || budget <= 0 || !Number.isSafeInteger(state.admitted) || state.admitted < 0 || state.admitted > limits.sections ||
      !Number.isSafeInteger(state.verified) || state.verified < 0 || state.verified > limits.streams ||
      !Array.isArray(state.streams) || state.streams.length !== 1 + Math.min(state.admitted, limits.streams - 1) ||
      !Array.isArray(state.sections) || state.sections.length !== state.admitted ||
      !Number.isSafeInteger(state.stream) || state.stream < 0 || state.stream > limits.streams) bad();
  if (state.phase === 'admit') {
    if (!Array.isArray(state.prefixWriters) || state.prefixWriters.length !== limits.sections || state.verified || state.stream) bad();
  } else if (state.admitted !== limits.sections || state.prefixWriters !== undefined) bad();
  if (state.phase === 'verify' && (state.stream || state.verified >= limits.streams)) bad();
  if (['stream', 'append', 'done'].includes(state.phase) && state.verified !== limits.streams) bad();
  if (state.phase === 'done' ? state.stream !== limits.streams : state.stream === limits.streams) bad();
  if (state.phase !== 'append' && (state.writer !== null || state.part !== 0 || state.offset !== 0)) bad();
  if (state.stream === 0 ? state.header !== null : !validBits(state.header)) bad();
  if (state.stream > 1 && !validBits(state.sections[state.stream - 2])) bad();
  let work = 0;
  const finish = stream => {
    if (!validBits(state.writer) || bitLength(state.writer) !== stream.plan.bits) bad();
    if (stream.index < 0) state.header = state.writer; else state.sections[stream.index] = state.writer;
    state.writer = null; state.streams[state.stream++] = null; state.part = 0; state.offset = 0;
    state.phase = state.stream === limits.streams ? 'done' : 'stream';
  };
  while (work < budget && state.phase !== 'done') {
    if (state.phase === 'admit') {
      const end = Math.min(limits.sections, state.admitted + 128);
      for (let index = state.admitted; index < end; index++) {
        const plan = state.prefixWriters[index], required = index < limits.streams - 1;
        if (required ? !plan : plan !== null) bad();
        if (required) validPlan(plan, partLimit(limits, index));
      }
      for (let index = state.admitted; index < end; index++) {
        if (index < limits.streams - 1) state.streams.push({index, plan: state.prefixWriters[index]});
        state.sections.push(null);
      }
      state.admitted = end; work++;
      if (end === limits.sections) { delete state.prefixWriters; state.phase = 'verify'; }
      continue;
    }
    if (state.phase === 'verify') {
      const stream = state.streams[state.verified];
      if (!stream || stream.index !== state.verified - 1) bad();
      validPlan(stream.plan, partLimit(limits, stream.index));
      prefetchTyped(...stream.plan.parts.map(part => [part.bytes, []]));
      state.verified++; work++;
      if (state.verified === limits.streams) state.phase = 'stream';
      continue;
    }
    const stream = state.streams[state.stream];
    if (!stream || stream.index !== state.stream - 1 || stream.index >= 0 && state.sections[stream.index] !== null) bad();
    const plan = stream.plan; validPlan(plan, partLimit(limits, stream.index));
    if (state.phase === 'stream') {
      if (stream.index >= 0 && plan.parts.length === 1) { state.writer = bitData(plan.parts[0]); finish(stream); work++; continue; }
      const length = capacity(stream, limits.sections); admitOutputSize(length);
      state.writer = {bytes: allocateTyped(Uint8Array, length), at: 0, pending: 0, acc: 0}; state.phase = 'append'; work++;
      if (!plan.parts.length) finish(stream);
    } else {
      if (!validBits(state.writer) || state.writer.bytes.length !== capacity(stream, limits.sections) ||
          !Number.isSafeInteger(state.part) || state.part < 0 || state.part >= plan.parts.length ||
          !Number.isSafeInteger(state.offset) || state.offset < 0 || state.offset > plan.parts[state.part].at) bad();
      let completed = state.offset * 8;
      for (let part = 0; part < state.part; part++) completed += bitLength(plan.parts[part]);
      if (bitLength(state.writer) !== completed) bad();
      const source = plan.parts[state.part], count = Math.min(source.at - state.offset, COPY), last = state.offset + count === source.at;
      prefetchTyped([source.bytes, Array.from({length: count}, (_, i) => state.offset + i)],
        [state.writer.bytes, Array.from({length: count + 1}, (_, i) => state.writer.at + i)]);
      const writer = Object.assign(new BitWriter(0), state.writer);
      writer.append({bytes: source.bytes.subarray(state.offset, state.offset + count), at: count,
        pending: last ? source.pending : 0, acc: last ? source.acc : 0});
      state.writer = bitData(writer); state.offset += count; work++;
      if (last) { state.part++; state.offset = 0; if (state.part === plan.parts.length) finish(stream); }
    }
  }
  return {state, work, done: state.phase === 'done', ...(state.phase === 'done' && {header: state.header, sections: state.sections})};
}


const TOC_ENTRIES = 128, MAX_SECTION_BYTES = 4211712 + 2 ** 30 - 1;
export function startVarDCTTOC(header, sizes, layout) {
  const limits = varDCTPrefixLimits(layout);
  if (!validBits(header) || !Array.isArray(sizes) || sizes.length !== limits.sections) bad();
  const required = header.at + (header.pending ? 1 : 0) + tocMaxBytes(sizes.length) + 16;
  if (header.bytes.length < required) bad();
  return {version: 1, phase: 'admit', admitted: 0, index: 0, header, sizes, sections: sizes.length};
}
export function advanceVarDCTTOC(state, budget = 1) {
  if (state?.version !== 1 || !['admit', 'begin', 'sizes', 'end', 'done'].includes(state.phase) || !validBits(state.header) ||
      !Number.isSafeInteger(budget) || budget < 1 || !Array.isArray(state.sizes) || state.sections !== state.sizes.length ||
      !Number.isSafeInteger(state.index) || state.index < 0 || state.index > state.sections ||
      !Number.isSafeInteger(state.admitted) || state.admitted < 0 || state.admitted > state.sections ||
      state.phase !== 'admit' && state.admitted !== state.sections ||
      ['admit', 'begin'].includes(state.phase) && state.index !== 0 || ['end', 'done'].includes(state.phase) && state.index !== state.sections) bad();
  if (state.header.bytes.length < state.header.at + (state.header.pending ? 1 : 0) + tocMaxBytes(state.sections - state.index) + 16) bad();
  let work = 0;
  while (work < budget && state.phase !== 'done') {
    if (state.phase === 'admit') {
      const end = Math.min(state.sections, state.admitted + TOC_ENTRIES);
      for (let i = state.admitted; i < end; i++) if (!Number.isSafeInteger(state.sizes[i]) || state.sizes[i] < 0 || state.sizes[i] > MAX_SECTION_BYTES) bad();
      state.admitted = end; work++; if (end === state.sections) state.phase = 'begin'; continue;
    }
    const writer = Object.assign(new BitWriter(0), state.header);
    if (state.phase === 'begin') {
      prefetchTyped([writer.bytes, Array.from({length: 2}, (_, i) => writer.at + i)]);
      writer.write(1, 0); writer.zeroPadToByte(); state.phase = 'sizes';
    } else if (state.phase === 'sizes') {
      const end = Math.min(state.sections, state.index + TOC_ENTRIES);
      for (let i = state.index; i < end; i++) if (!Number.isSafeInteger(state.sizes[i]) || state.sizes[i] < 0 || state.sizes[i] > MAX_SECTION_BYTES) bad();
      prefetchTyped([writer.bytes, Array.from({length: 4 * (end - state.index) + 1}, (_, i) => writer.at + i)]);
      writeTOCSizes(writer, state.sizes, state.index, end); state.index = end;
      if (end === state.sections) state.phase = 'end';
    } else {
      prefetchTyped([writer.bytes, [writer.at]]); writer.zeroPadToByte(); state.phase = 'done';
    }
    state.header = bitData(writer); work++;
  }
  return {done: state.phase === 'done', work, header: state.header};
}
