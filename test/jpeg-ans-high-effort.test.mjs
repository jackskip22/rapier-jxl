// SPDX-License-Identifier: MIT
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {jpegAnsEffortSteps} from '../src/jpeg-ans-effort.mjs';
import {parseJPEG} from '../src/jfif.mjs';
import {BitWriter, complete} from '../src/bits.mjs';
import {transcode, transcodeSteps} from '../src/jpeg-ans.mjs';
const input = new Uint8Array(readFileSync(new URL('seeds/colour-sequential.jpg', import.meta.url)));
const jpeg = parseJPEG(input), original = structuredClone(jpeg);
const smallest = streams => streams.reduce((a, b) => !a || b.length < a.length ? b : a, null);

test('optional JPEG high efforts retain complete incumbents at every hurry and cancel boundary', () => {
  for (const effort of [8, 9]) {
    const full = jpegAnsEffortSteps(jpeg, effort); let count = 0;
    while (!full.next().done) count++;
    for (let boundary = 0; boundary < count; boundary++) {
      const streams = [], it = jpegAnsEffortSteps(jpeg, effort, bytes => streams.push(bytes));
      let step, hurry = false, at = 0, progress = -1;
      while (!(step = it.next(hurry)).done) {
        assert.ok(step.value >= progress && step.value <= 1);
        progress = step.value; hurry = at++ === boundary;
      }
      assert.equal(step.value, smallest(streams));
      assert.ok(streams.length > 0 && streams.length <= (effort === 8 ? 8 : 18));
      let retained = 0;
      const cancelled = jpegAnsEffortSteps(jpeg, effort, () => retained++);
      for (let at = 0; at <= boundary; at++) assert.equal(cancelled.next().done, false);
      const before = retained;
      assert.equal(cancelled.return().done, true); assert.equal(cancelled.next().done, true);
      assert.equal(retained, before); assert.deepEqual(jpeg, original);
    }
  }
});

test('optional JPEG candidate failures retain the exact earlier complete buffer', () => {
  const write = BitWriter.prototype.write;
  for (let count = 1; count < 18; count++) for (const kind of ['allocation', 'ceiling', 'unexpected']) {
    const streams = [], error = kind === 'allocation' ? new RangeError('allocation test')
      : Object.assign(new Error('candidate test'), {code: kind === 'ceiling' ? 'JXL_SIZE' : 'JXL_UNEXPECTED'});
    let armed = false;
    try {
      BitWriter.prototype.write = function (...args) { if (armed) throw error; return write.apply(this, args); };
      const run = () => complete(jpegAnsEffortSteps(jpeg, 9, bytes => { streams.push(bytes); armed = streams.length === count; }));
      if (kind === 'unexpected') assert.throws(run, thrown => thrown === error);
      else assert.equal(run(), smallest(streams));
      assert.equal(streams.length, count); assert.deepEqual(jpeg, original);
    } finally { BitWriter.prototype.write = write; }
  }
});

test('optional JPEG late hurry completes assembly and public cancel publishes no bytes', () => {
  for (const effort of [8, 9]) {
    const answer = transcode(input, {effort}), late = transcodeSteps(input, {effort});
    let step;
    while (!(step = late.next()).done) if (step.value === 1) late.hurry = true;
    assert.deepEqual(late.bytes, answer.bytes);
    const cancelled = transcodeSteps(input, {effort});
    assert.equal(cancelled.next().done, false); cancelled.return();
    assert.equal(cancelled.bytes, null); assert.equal(cancelled.next().done, true);
  }
});

test('equal complete optional JPEG streams keep the first buffer', () => {
  const grey = parseJPEG(new Uint8Array(readFileSync(new URL('seeds/grey-sequential.jpg', import.meta.url))));
  const streams = [], answer = complete(jpegAnsEffortSteps(grey, 9, bytes => streams.push(bytes)));
  assert.ok(streams.filter(bytes => bytes.length === answer.length).length > 1);
  assert.equal(answer, smallest(streams));
});
