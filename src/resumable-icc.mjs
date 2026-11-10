// SPDX-License-Identifier: MIT
import {unit, carried, stage, PASSED, journalJoin, sliceBytes} from './step-journal.mjs';

const VALUES = 8192, MATCH_WORK = 4096;
const bits = writer => ({bytes: writer.bytes.subarray(0, writer.at), at: writer.at, acc: writer.acc,
  pending: writer.pending, bitLength: writer.at * 8 + writer.pending});
const take = (saved, previous) => saved === PASSED ? previous : saved;

export function* inspectICC(profile, level, expectedColorSpace, owner) {
  return yield* stage('icc-admission', function* () {
    const head = yield* unit('icc-admission-header', () => owner.header(profile, level, expectedColorSpace));
    for (let first = 0; first < head.count; first += 4096)
      yield* unit('icc-admission-tags', () => { owner.tags(profile, head, first, Math.min(head.count, first + 4096)); return null; });
    return head.channels;
  });
}

function* matched(data, owner) {
  return yield* stage('icc-matches', function* () {
    const parts = []; let state = null, done = false;
    while (!done) {
      const part = yield* stage('icc-match-part', function* () {
        const pairs = [];
        state = owner.matches(data, (value, length, distance) => pairs.push(length || value, distance), 4, 7, state, MATCH_WORK);
        const bytes = new Uint8Array(pairs.length * 4), view = new DataView(bytes.buffer);
        pairs.forEach((value, i) => view.setUint32(i * 4, value, true));
        return {bytes, done: state.i === data.length};
      }, undefined, false, true);
      parts.push(part.bytes); done = part.done;
      const saved = yield* carried('icc-match-state', () => null, () => done ? null : state, true);
      if (saved !== null && saved !== PASSED) state = saved;
    }
    return journalJoin(parts);
  });
}

function tokenBand(data, tokens, owner, state, end, emit) {
  while (state.position < end) {
    const bytes = tokens.subarray(state.index, state.index + 8), view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const value = view.getUint32(0, true), distance = view.getUint32(4, true), length = distance ? value : 0, count = length || 1;
    const n = Math.min(count - state.within, data.length > 65536 ? VALUES : count);
    owner.match(data, emit, state.position, length ? 0 : value, length ? n : 0, distance);
    state.position += n; state.within += n;
    if (state.within === count) { state.index += 8; state.within = 0; }
  }
}

function* payload(data, tokens, owner) {
  const lz = !!tokens;
  return yield* stage(lz ? 'icc-lz' : 'icc-prefix', function* () {
    const frequencies = yield* stage('icc-frequencies', function* () {
      let state = {position: 0, within: 0, index: 0, frequencies: new Uint32Array(lz ? 320 : 256),
        ...(lz && {distances: new Uint32Array(64)})};
      for (let from = 0; from < data.length; from += VALUES) {
        const end = Math.min(data.length, from + VALUES);
        const saved = yield* carried('icc-count', () => {
          if (lz) tokenBand(data, tokens, owner, state, end, (value, length, distance) => owner.symbol(null, state, value, length, distance));
          else for (const value of data.subarray(from, end)) state.frequencies[value]++;
          return state;
        });
        state = take(saved, state);
      }
      return {frequencies: state.frequencies, distances: state.distances};
    });
    const model = yield* unit('icc-code', () => {
      const model = owner.model(data.length, frequencies.frequencies, frequencies.distances);
      return {...model, writer: bits(model.writer)};
    });
    const parts = []; let state = {position: 0, within: 0, index: 0}, acc = 0, pending = 0, at = 0;
    for (let from = 0; from < data.length; from += VALUES) {
      const end = Math.min(data.length, from + VALUES);
      const part = yield* stage('icc-write-part', function* () {
        const writer = new owner.BitWriter(65536);
        if (!from) writer.append(model.writer); else { writer.acc = acc; writer.pending = pending; }
        const emit = (value, length, distance) => owner.symbol(writer, model, value, length, distance);
        if (lz) tokenBand(data, tokens, owner, state, end, emit);
        else for (const value of data.subarray(from, end)) emit(value, 0, 0);
        return bits(writer);
      }, undefined, false, true);
      parts.push(part.bytes); at += part.at; acc = part.acc; pending = part.pending;
      if (lz) {
        const saved = yield* carried('icc-write-state', () => null, () => state, true);
        if (saved !== null && saved !== PASSED) state = saved;
      }
    }
    return {bytes: journalJoin(parts), at, acc, pending, bitLength: at * 8 + pending};
  });
}

export function* prepareICC(profile, options, owner) {
  profile = sliceBytes(profile);
  return yield* stage('icc-prepare', function* () {
    const compression = owner.options(options), channels = yield* owner.inspect(profile, options.level, options.colorSpace);
    const fields = yield* unit('icc-fields', () => {
      const fields = owner.fields(profile, options, channels); return {...fields, colorData: bits(fields.colorData)};
    });
    const head = yield* unit('icc-transform', () => owner.transform(profile, false));
    const data = journalJoin([head, sliceBytes(profile, 128)]);
    let iccData = null, capacityError;
    if (compression !== 'lz77') {
      try { iccData = yield* payload(data, null, owner); }
      catch (error) { if (compression !== 'auto' || error.code !== 'JXL_SIZE') throw error; capacityError = error; }
    }
    if (compression !== 'prefix') {
      try {
        const candidate = yield* payload(data, yield* matched(data, owner), owner);
        if (!iccData || candidate.bitLength < iccData.bitLength) iccData = candidate;
      } catch (error) { if (!iccData || error.code !== 'JXL_SIZE') throw error; }
    }
    if (!iccData) throw capacityError;
    return {...fields, iccData};
  });
}

export function* varDCTFile(writeHeader, writers, level, owner) {
  return yield* stage('codestream', function* () {
    const sections = [];
    for (const writer of writers) sections.push(yield* stage('codestream-section', function* () {
      return writer ? writer.finish() : new Uint8Array(0);
    }, undefined, false, true));
    const sizes = journalJoin(sections).sizes;
    const plan = yield* unit('codestream-header', () => {
      const writer = new owner.BitWriter(256), parts = [], flush = () => {
        if (writer.at || writer.pending) {
          parts.push({bytes: writer.bytes, at: writer.at, pending: writer.pending, acc: writer.acc});
          recorded += writer.at * 8 + writer.pending;
          writer.bytes = new Uint8Array(256); writer.at = writer.acc = writer.pending = 0;
        }
      };
      let recorded = 0;
      Object.defineProperties(writer, {
        bitLength: {get: () => recorded + writer.at * 8 + writer.pending},
        append: {value: other => {
          flush();
          if (other.at || other.pending) { parts.push({bytes: other.bytes, at: other.at, pending: other.pending, acc: other.acc}); recorded += other.at * 8 + other.pending; }
        }},
        zeroPadToByte: {value: () => { const n = (-writer.bitLength) & 7; if (n) writer.write(n, 0); }},
      });
      writeHeader(writer); owner.writeTOC(writer, sizes); flush();
      return {bits: recorded, parts};
    });
    const parts = []; let acc = 0, pending = 0;
    for (const span of plan.parts) for (let from = 0; from < span.at || !from && span.pending; from += 65535) {
      const to = Math.min(span.at, from + 65535), last = to === span.at;
      const part = yield* stage('codestream-header-part', function* () {
        const writer = new owner.BitWriter(to - from + 16); writer.acc = acc; writer.pending = pending;
        writer.append({bytes: span.bytes.subarray(from, to), at: to - from, acc: last ? span.acc : 0, pending: last ? span.pending : 0});
        return bits(writer);
      }, undefined, false, true);
      parts.push(part.bytes); acc = part.acc; pending = part.pending;
    }
    return owner.codestreamFromParts(journalJoin(parts), sections, level, journalJoin);
  });
}
