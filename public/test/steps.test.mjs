// SPDX-License-Identifier: MIT
// The step twins: jobs run a step at a time, interleaved, write their doors' bytes; each fraction ends at exactly 1;
// the carrier's job knows the picture as shown after its first step; a hurried search answers with effort 1's stream.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {encode, encodeSteps} from '../../index.mjs';
import {transcode, transcodeSteps} from '../../jpeg.mjs';
import {encodePhoto, encodePhotoSteps} from '../../photo.mjs';
import {encode as encodeEffort, encodeSteps as effortSteps} from '../../effort.mjs';
import {pixelCase, borderCase} from './fuzz-cases.mjs';

test('interleaved jobs write their doors\' bytes, and every fraction ends at 1', async () => {
  const jpeg = new Uint8Array(await readFile(new URL('photo-corpus/grace-hopper.jpg', import.meta.url)));
  // Seeded cases and a picture of several groups, made by integer arithmetic.
  const pictures = [0, 5, 13, 44].map(i => pixelCase(20260930, i)), width = 600, height = 300, rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) rgba.set([(i * 7) & 255, (i >> 5) & 255, (i % width) & 255, i % 11 ? 255 : 128], i * 4);
  pictures.push({rgba, width, height, quality: 80});
  const jobs = [...pictures.map(p => encodeSteps(p.rgba, p.width, p.height, {quality: p.quality})), ...pictures.map(p => encodePhotoSteps(p.rgba, p.width, p.height)),
    ...pictures.map(p => effortSteps(p.rgba, p.width, p.height, {effort: 3})), transcodeSteps(jpeg)];
  const last = jobs.map(() => 0);
  for (let live = jobs.length; live;) {
    live = 0;
    jobs.forEach((job, i) => {
      const step = job.next();
      if (step.done) return;
      assert.ok(step.value >= last[i] && step.value > 0 && step.value <= 1, 'a fraction in (0, 1], never falling');
      last[i] = step.value; live++;
    });
  }
  assert.deepEqual(last, jobs.map(() => 1));
  pictures.forEach((p, i) => {
    assert.deepEqual(jobs[i].bytes, encode(p.rgba, p.width, p.height, {quality: p.quality}));
    assert.deepEqual(jobs[pictures.length + i].bytes, encodePhoto(p.rgba, p.width, p.height));
    assert.deepEqual(jobs[2 * pictures.length + i].bytes, encodeEffort(p.rgba, p.width, p.height, {effort: 3}));
  });
  const carried = transcode(jpeg), job = jobs.at(-1);
  assert.deepEqual({bytes: job.bytes, width: job.width, height: job.height, orientation: job.orientation}, carried);
});

test('a hurried search answers with effort 1\'s stream, whenever it is asked', () => {
  const {rgba, width, height} = borderCase(600, 300), first = encode(rgba, width, height);
  assert.notDeepEqual(encodeEffort(rgba, width, height, {effort: 3}), first, 'unhurried, the search writes another stream');
  for (const from of [0, 0.75]) {
    const job = effortSteps(rgba, width, height, {effort: 3});
    for (const done of job) if (done > from) job.hurry = true;
    assert.deepEqual(job.bytes, first, 'hurried past ' + from);
  }
});
