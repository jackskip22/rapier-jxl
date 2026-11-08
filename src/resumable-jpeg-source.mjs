// SPDX-License-Identifier: MIT
import {stage, carried, PASSED, readAll} from './step-journal.mjs';

export function* jpegSummary(frame) {
  const summary = yield* stage('coefficient-summary', function* () {
    const totals = frame.components.map(c => ({dc: new Int16Array(c.stride * c.rows), natural: new Uint32Array(64)}));
    for (let row = 0; row < frame.mcusY; row++) {
      const parts = yield* stage('row-summary', function* () {
        readAll(frame.components.map(c => c.parts[row]));
        return frame.components.map(c => {
          const coefficients = c.parts[row], dc = new Int16Array(c.stride * c.v), natural = new Uint32Array(64);
          for (let at = 0; at < coefficients.length; at += 64) {
            dc[at / 64] = coefficients[at];
            for (let k = 0; k < 64; k++) if (coefficients[at + k]) natural[k]++;
          }
          return {dc, natural};
        });
      });
      for (let i = 0; i < totals.length; i++) {
        totals[i].dc.set(parts[i].dc, row * frame.components[i].stride * frame.components[i].v);
        for (let k = 0; k < 64; k++) totals[i].natural[k] += parts[i].natural[k];
      }
    }
    return totals;
  });
  frame.components.forEach((c, i) => { c.dc = summary[i].dc; c.natural = summary[i].natural; });
}

export function* jpegProgressive(bytes, start, frame, scan, ss, se, ah, al, restartInterval, choices, padding, owner) {
  const {ScanReader, readUnits, finishScan} = owner;
  const saved = yield* stage('scan-' + frame.scans, function* () {
    const single = scan.length === 1, first = scan[0].component;
    const total = single ? first.blocksW * first.blocksH : frame.mcusX * frame.mcusY;
    const per = single ? first.blocksW * first.v : frame.mcusX;
    const reader = new ScanReader(bytes, start, frame, scan, ss, se, ah, al, choices, padding);
    for (const s of scan) s.component.pred = 0;
    reader.load();
    const state = () => ({...reader.here(), preds: scan.map(s => s.component.pred), block: reader.blockIndex, eobrun: reader.eobrun,
      resets: choices?.resets ?? null, zeros: choices?.zeros ?? null, padding: padding && {bits: padding.bits, zero: padding.zero}});
    for (let unit = 0, row = 0; unit < total; unit += per, row++) {
      const coefficients = yield* stage('scan-coefficients', function* () {
        readAll(scan.map(s => s.component.parts[row]));
        for (const {component: c} of scan) {
          c.coeffs = c.parts[row] ? Int16Array.from(c.parts[row]) : new Int16Array(c.stride * c.v * 64);
          c.row0 = row * c.v;
        }
        readUnits(reader, frame, scan, unit, Math.min(total, unit + per), restartInterval);
        return scan.map(s => s.component.coeffs);
      }, undefined, false, true);
      scan.forEach((s, i) => { s.component.parts[row] = coefficients[i]; });
      const tail = yield* carried('scan-state', () => null, state, true);
      if (tail === null || tail === PASSED) continue;
      reader.pos = tail.pos; reader.load(); reader.bit = tail.bit; reader.blockIndex = tail.block; reader.eobrun = tail.eobrun;
      scan.forEach((s, i) => { s.component.pred = tail.preds[i]; });
      if (choices) { choices.resets = tail.resets; choices.zeros = tail.zeros; }
      if (padding) { padding.bits = tail.padding.bits; padding.zero = tail.padding.zero; }
    }
    reader.atMarker(true);
    const pos = finishScan(bytes, reader.pos, total, restartInterval, choices);
    for (const {component: c} of scan) { c.coeffs = null; c.row0 = -1; }
    return {pos, parts: scan.map(s => s.component.parts), choices, padding: padding && {bits: padding.bits, zero: padding.zero}};
  }, undefined, false, true);
  scan.forEach((s, i) => { s.component.parts = saved.parts[i]; });
  if (choices) Object.assign(choices, saved.choices);
  if (padding) Object.assign(padding, saved.padding);
  return saved.pos;
}
