// SPDX-License-Identifier: MIT
import {unit, carried, stage, PASSED, journalJoin} from './step-journal.mjs';
import {iccProfileSteps} from './resumable-metadata.mjs';

export function* jpegScanRows({out, jpeg, writer, preds, ny, per, pad}, owner) {
  const {rows} = owner;
  if (out.parts) for (let from = 0; from < ny; from += per) {
    out.parts.push(yield* unit('scan-part', () => { rows(from, Math.min(ny, from + per)); return out.take(); }));
    const saved = yield* carried('scan-state', () => null, () => ({done: out.done, acc: out.acc, pending: out.pending,
      block: writer.blockIndex, preds, nextReset: owner.nextReset(), pad: pad?.at ?? 0, eob: writer.eob, eobTable: writer.eobTable,
      corrections: writer.pending.subarray(0, writer.pendingBits), coefficients: jpeg.checkpoint()}), true);
    if (saved === null || saved === PASSED) continue;
    Object.assign(out, {done: saved.done, acc: saved.acc, pending: saved.pending, at: 0, chunks: []});
    writer.blockIndex = saved.block; preds.set(saved.preds); owner.restoreReset(saved.nextReset); if (pad) pad.at = saved.pad;
    writer.eob = saved.eob; writer.eobTable = saved.eobTable;
    writer.pending = saved.corrections.slice(); writer.pendingBits = writer.pending.length;
    jpeg.resume(saved.coefficients);
  }
  else for (let from = 0, step = per % 2 ? per : per / 2; from < ny; from += step) {
    const saved = yield* carried('scan-rows', () => rows(from, Math.min(ny, from + step)), () => {
      out.spill(0);
      return {done: out.done, same: out.same, acc: out.acc, pending: out.pending, block: writer.blockIndex, preds, nextReset: owner.nextReset(), pad: pad?.at ?? 0,
        eob: writer.eob, eobTable: writer.eobTable, corrections: writer.pending.subarray(0, writer.pendingBits)};
    });
    if (saved === null || saved === PASSED) continue;
    Object.assign(out, {done: saved.done, same: saved.same, acc: saved.acc, pending: saved.pending, at: 0});
    writer.blockIndex = saved.block; preds.set(saved.preds); owner.restoreReset(saved.nextReset); if (pad) pad.at = saved.pad;
    writer.eob = saved.eob; writer.eobTable = saved.eobTable;
    writer.pending = saved.corrections.slice(); writer.pendingBits = writer.pending.length;
  }
}

export function* jpegMarker(out, write) {
  const part = yield* unit('jpeg-marker', () => {
    write(); const bytes = out.expected ? (out.spill(0), null) : out.take();
    return {bytes, done: out.done, same: out.same};
  });
  if (out.parts) out.parts.push(part.bytes);
  Object.assign(out, {done: part.done, same: part.same, at: 0, chunks: []});
}

export function* jpegScan(out, pad, write) {
  if (out.expected) {
    const checked = yield* stage('jpeg-scan', function* () {
      yield* write(); out.spill(0);
      return {done: out.done, same: out.same, pad: pad?.at ?? 0};
    });
    Object.assign(out, {done: checked.done, same: checked.same, at: 0, acc: 0, pending: 0}); if (pad) pad.at = checked.pad;
  } else {
    const before = out.parts.length;
    const scan = yield* stage('jpeg-scan', function* () {
      yield* write();
      const last = yield* unit('scan-end', () => out.take());
      return {bytes: journalJoin([...out.parts.slice(before), last]), done: out.done, pad: pad?.at ?? 0};
    });
    out.parts.length = before; out.parts.push(scan.bytes);
    Object.assign(out, {done: scan.done, acc: 0, pending: 0, at: 0, chunks: []}); if (pad) pad.at = scan.pad;
  }
}

export function* jpegEnd(out, tail, requireJPEG) {
  requireJPEG(!out.pending && out.done + out.at + tail.length <= out.limit);
  const last = yield* unit('jpeg-end', () => out.take());
  return journalJoin([...out.parts, last, tail]);
}

export function* jpegStructure(bytes, jpeg, owner) {
  const data = owner.create(jpeg); let state = owner.start(jpeg);
  while (!state.ended) {
    const part = yield* unit('structure-window', () => owner.window(bytes, jpeg, state)); state = part.state;
    const scans = [];
    for (const row of part.data.scans) {
      const resets = row.resets ? yield* stage('structure-resets', function* () {
        return owner.choices(jpeg, row.index, false);
      }, undefined, false, true) : new Uint32Array(0);
      const zeros = row.zeros ? yield* stage('structure-zeros', function* () {
        return owner.choices(jpeg, row.index, true);
      }, undefined, false, true) : new Uint32Array(0);
      scans.push(owner.scan(row, resets, zeros));
    }
    owner.append(data, part, scans);
  }
  return owner.finish(data, state, jpeg);
}

export function* jpegSyntax(fields, BitWriter) {
  const pieces = []; let pending = 0, acc = 0;
  for (const [name, count, batch, write] of fields) for (let from = 0; from < count; from += batch) {
    const part = yield* stage(name, function* () {
      const w = new BitWriter(); w.pending = pending; w.acc = acc; write(w, from, Math.min(count, from + batch));
      return {bytes: w.bytes.subarray(0, w.at), pending: w.pending, acc: w.acc};
    }, undefined, false, true);
    pieces.push(part.bytes); pending = part.pending; acc = part.acc;
  }
  return journalJoin(pieces);
}

export function* jpegPayload(data, splitApps, owner) {
  const cuts = []; let state;
  for (let from = 0; from < data.apps.length; from += 64) {
    const part = yield* unit('jpeg-payload-apps', () => owner.apps(data.apps.slice(from, from + 64), splitApps, state));
    state = part.state; cuts.push(...part.cuts);
  }
  const offset = owner.offset(data, state?.curOff ?? 0);
  state = {at: 0, phase: 'search', done: false};
  while (!state.done) {
    const part = yield* unit('jpeg-payload-tail', () => owner.tail(data.tail, state));
    state = part.state; for (const at of part.cuts) cuts.push(offset + at);
  }
  return owner.finish(cuts, offset + data.tail.length);
}

export const jpegICC = iccProfileSteps('icc-profile');

export function* jpegICCEntropy(r, owner) {
  return yield* stage('icc-entropy', function* () {
    const header = yield* unit('icc-entropy-header', () => owner.header(r)); r.bit = header.bit;
    const code = owner.reader(header.model, r, header.size), parts = []; let previous = 0, older = 0;
    for (let from = 0; from < header.size; from += 65536) {
      const part = yield* unit('icc-entropy-part', () => owner.part(r, code, header, from, previous, older));
      parts.push(part.bytes); previous = part.previous; older = part.older; r.bit = part.bit;
      const saved = yield* carried('icc-entropy-state', () => null, () => code.checkpoint(), true);
      if (saved !== null && saved !== PASSED) code.resume(saved);
    }
    yield* unit('icc-entropy-end', () => { code.finish(); return null; });
    return {bytes: journalJoin(parts), bit: r.bit};
  });
}
