// SPDX-License-Identifier: MIT
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {jpegEffortSteps} from '../src/jpeg-effort.mjs';
import {coefficientEffortSteps} from '../src/coefficient-effort.mjs';
import {parseJPEG} from '../src/jfif.mjs';
import {BitWriter, complete} from '../src/bits.mjs';
import {transcode, transcodeSteps} from '../src/jpeg.mjs';
import {TokenCounts, buildTokenCoding} from '../src/entropy.mjs';
import {buildExactTokenCoding} from '../src/coefficient-coding.mjs';
import {writeHistograms} from '../src/prefix.mjs';
const input = new Uint8Array(readFileSync(new URL('seeds/colour-sequential.jpg', import.meta.url)));
const jpeg = parseJPEG(input);
const smaller = streams => streams.reduce((a, b) => !a || b.length < a.length ? b : a, null);

test('JPEG high efforts retain strict complete-stream floors at every hurry boundary', () => {
  for (const effort of [8, 9]) {
    const full = jpegEffortSteps(jpeg, effort); let steps = 0;
    while (!full.next().done) steps++;
    for (let stop = 0; stop < steps; stop++) {
      const streams = [], it = jpegEffortSteps(jpeg, effort, bytes => streams.push(bytes));
      let step, at = 0, hurry = false, progress = -1;
      while (!(step = it.next(hurry)).done) {
        assert.ok(step.value >= progress && step.value <= 1);
        progress = step.value; hurry = at++ === stop;
      }
      assert.deepEqual(step.value, smaller(streams));
      assert.ok(streams.length > 0);
      assert.ok(streams.length <= (effort === 8 ? 4 : 12));
    }
  }
});

test('JPEG cancellation ends each high-effort phase without mutating coefficients', () => {
  const before = structuredClone(jpeg);
  let count = 0, full = jpegEffortSteps(jpeg, 9);
  while (!full.next().done) count++;
  for (let stop = 0; stop < count; stop++) {
    let retained = 0; const it = jpegEffortSteps(jpeg, 9, () => retained++);
    for (let at = 0; at <= stop; at++) assert.equal(it.next().done, false);
    const prior = retained; assert.equal(it.return().done, true); assert.equal(it.next().done, true); assert.equal(retained, prior);
    assert.deepEqual(jpeg, before);
  }
});

test('JPEG candidate allocation and size failures keep earlier complete streams', () => {
  const write = BitWriter.prototype.write;
  for (const retainedCount of [3, 4, 5, 6, 7, 8, 9, 10, 11]) for (const kind of ['allocation', 'ceiling']) {
    const streams = []; let fail = false;
    try {
      BitWriter.prototype.write = function (...args) {
        if (fail) throw kind === 'allocation' ? new RangeError('allocation test') : Object.assign(new Error('ceiling test'), {code: 'JXL_SIZE'});
        return write.apply(this, args);
      };
      const answer = complete(jpegEffortSteps(jpeg, 9, bytes => { streams.push(bytes); fail = streams.length === retainedCount; }));
      assert.equal(streams.length, retainedCount); assert.deepEqual(answer, smaller(streams));
    } finally { BitWriter.prototype.write = write; }
  }
});

test('JPEG public incremental completion and hurry keep the matching complete bytes', () => {
  for (const effort of [8, 9]) {
    const expected = transcode(input, {effort}), job = transcodeSteps(input, {effort});
    complete(job); assert.deepEqual(job.bytes, expected.bytes);
    const hurried = transcodeSteps(input, {effort}); hurried.hurry = true; complete(hurried);
    assert.deepEqual(hurried.bytes, complete(coefficientEffortSteps(jpeg, 1)));
  }
});

test('exact prefix refinement keeps clusters and does not increase serialized token bits', () => {
  const counts = new TokenCounts(4), values = [0, 1, 2, 4, 8, 32, 63, 64, 255, 2048, 65535];
  for (let ctx = 0; ctx < 4; ctx++) for (let i = 0; i < values.length; i++) for (let n = 0; n <= i + ctx; n++) counts.add(ctx, values[i]);
  const old = buildTokenCoding(counts), exact = buildExactTokenCoding(counts);
  assert.deepEqual(exact.contextMap, old.contextMap);
  const bits = coding => {
    const w = new BitWriter(); writeHistograms(w, coding);
    for (let ctx = 0; ctx < 4; ctx++) for (let i = 0; i < values.length; i++) for (let n = 0; n <= i + ctx; n++) coding.write(w, ctx, values[i]);
    return w.bitLength;
  };
  assert.ok(bits(exact) <= bits(old));
});
