// SPDX-License-Identifier: MIT
import {stage, unit, journalJoin, sliceBytes} from './step-journal.mjs';

export function* containerBoxes(bytes, maxBoxes, reconstruction, owner) {
  const {admitBoxes, boxCursor, boxWords, nextBox, endBoxes, reconstructionBox} = owner;
  admitBoxes(bytes, maxBoxes); const state = boxCursor(), all = [];
  while (state.at < bytes.length) {
    const batch = yield* unit('container-boxes', () => {
      const additions = new Map(), next = {...state, prefixes: {has: key => additions.has(key) || state.prefixes.has(key), set: (key, value) => additions.set(key, value)}};
      const words = boxWords(bytes), rows = [];
      for (let i = 0; i < 64 && next.at < bytes.length; i++) {
        const row = nextBox(bytes, maxBoxes, next, words);
        if (!row) break;
        if (reconstruction) reconstructionBox(row, next);
        rows.push(row);
      }
      const {prefixes, ...cursor} = next; return {rows, cursor, additions: [...additions]};
    });
    Object.assign(state, batch.cursor); for (const [key, value] of batch.additions) state.prefixes.set(key, value);
    all.push(...batch.rows);
  }
  yield* unit('container-end', () => { endBoxes(state); return null; });
  return all;
}

export function* jpegContainer(bytes, owner) {
  const {reconstructionStart, containerBoxesSteps, reconstructionPart, reconstructionEnd, maximum} = owner;
  return yield* stage('jpeg-container', function* () {
    const found = reconstructionStart(bytes); if (!found) return null;
    const take = (from, to) => sliceBytes(bytes, from, to);
    for (const row of yield* containerBoxesSteps(bytes, maximum, true)) reconstructionPart(found, row, take);
    return reconstructionEnd(found, journalJoin);
  });
}

export function* containerRead(bytes, options, owner) {
  const {limit, boxLimit, containerStart, containerNext, containerEnd, containerSignature, boxWords, fourcc, invalid, ignored} = owner;
  const maximum = limit(options), maxBoxes = boxLimit(options);
  return yield* stage('container-read', function* () {
    let state = yield* unit('container-start', () => containerStart(bytes, maximum));
    if (state.raw) return {codestream: bytes, level: 5, minorVersion: 0, auxiliary: []};
    const auxiliary = [], byIndex = new Map(), span = (from, to) => sliceBytes(bytes, from, to);
    while (state.at < bytes.length) {
      const batch = yield* unit('container-boxes', () => {
        const additions = new Map(), prefixes = new Map(), words = boxWords(bytes), rows = [];
        const next = {...state, prefixes: {has: key => prefixes.has(key) || state.prefixes.has(key), set: (key, value) => prefixes.set(key, value)}};
        const index = {set: (key, value) => additions.set(key, value)};
        for (let n = 0; n < 64 && next.at < bytes.length; n++) {
          const row = containerNext(bytes, maxBoxes, next, words, span, index);
          if (!row) break;
          if (!ignored.includes(row.entry.type)) rows.push({boxType: fourcc(row.entry.type),
            data: row.entry.data, extended: row.entry.headerLength === 16});
        }
        const {prefixes: pending, ...cursor} = next;
        return {state: cursor, prefixes: [...prefixes], auxiliary: rows, additions: [...additions]};
      });
      Object.assign(state, batch.state); for (const [key, value] of batch.prefixes) state.prefixes.set(key, value);
      auxiliary.push(...batch.auxiliary);
      for (const [key, value] of batch.additions) byIndex.set(key, value);
    }
    yield* unit('container-end', () => { containerEnd(state); return null; });
    let codestream = state.full;
    if (!codestream) {
      const parts = [];
      for (let first = 0; first < state.next; first += 64) parts.push(...yield* unit('container-fragments', () => {
        const rows = [];
        for (let i = first; i < Math.min(state.next, first + 64); i++) {
          if (!byIndex.has(i)) throw invalid('Missing JPEG XL codestream fragment.');
          rows.push(byIndex.get(i));
        }
        return rows;
      }));
      codestream = journalJoin(parts);
    }
    yield* unit('container-signature', () => { containerSignature(codestream); return null; });
    return {codestream, level: state.level, minorVersion: state.minorVersion, auxiliary};
  });
}

export function* boundedHeader(bytes, options, {readContainerSteps, header}) {
  return yield* stage('complete-image-header', function* () {
    const source = yield* readContainerSteps(bytes, {maxBytes: options.maxInputBytes ?? 1073741824, maxBoxes: options.maxBoxes ?? 65536});
    const info = yield* unit('image-header-prefix', () => header(source.codestream.subarray(0, Math.min(source.codestream.length, 65536)), options));
    let reconstruction = false;
    for (let first = 0; first < source.auxiliary.length && !reconstruction; first += 64)
      reconstruction = yield* unit('image-reconstruction-box', () => source.auxiliary.slice(first, first + 64).some(box => box.boxType === 'jbrd'));
    return {...info, reconstruction};
  });
}
