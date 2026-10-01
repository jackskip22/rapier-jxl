// SPDX-License-Identifier: MIT
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {transcode, transcodeSteps} from '../../jpeg.mjs';
import {encodePhotoSteps} from '../../photo.mjs';
import {oracles} from './oracles.mjs';

test('the cluster rung retains the carrier pixels and the completed floor', async t => {
  const input = new Uint8Array(await readFile(new URL('photo-corpus/grace-hopper.jpg', import.meta.url)));
  const first = transcode(input), searched = transcode(input, {effort: 3}), oracle = await oracles();
  assert.ok(searched.bytes.length < first.bytes.length);
  assert.deepEqual(transcode(input, {effort: 2}).bytes, first.bytes);
  assert.deepEqual(oracle.decode(searched.bytes, searched.width, searched.height, 'cluster effort 3'), oracle.decode(first.bytes, first.width, first.height, 'cluster floor'));
  for (const from of [0, 0.55]) {
    const job = transcodeSteps(input, {effort: 3}); let last = 0;
    for (const done of job) { assert.ok(done >= last && done > 0 && done <= 1); last = done; if (done >= from) job.hurry = true; }
    assert.equal(last, 1); assert.deepEqual(job.bytes, first.bytes);
  }
  const job = transcodeSteps(input, {effort: 3}); for (const _ of job);
  assert.deepEqual(job.bytes, searched.bytes);
  for (const options of [null, 3, {effort: 0}, {effort: 10}, {effort: 1.5}, {effort: NaN}, {effort: '3'}]) {
    assert.throws(() => transcodeSteps(input, options), {code: 'JXL_INPUT'});
    assert.throws(() => encodePhotoSteps(new Uint8Array(4), 1, 1, options), {code: 'JXL_INPUT'});
  }
  t.diagnostic(JSON.stringify({oracles: oracle.names, nativeUnavailable: !oracle.native, jxlRsUnavailable: !oracle.jxlRs}));
});
