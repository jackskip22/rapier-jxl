// SPDX-License-Identifier: MIT
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {jpegEffortSteps} from '../src/jpeg-effort.mjs';
import {parseJPEG} from '../src/jfif.mjs';
import {complete} from '../src/bits.mjs';

test('a late hurry retains the newly completed smaller JPEG stream', () => {
  const input = new Uint8Array(readFileSync(new URL('photo-corpus/grace-hopper.jpg', import.meta.url))), jpeg = parseJPEG(input);
  for (const effort of [8, 9]) {
    const full = complete(jpegEffortSteps(jpeg, effort)), it = jpegEffortSteps(jpeg, effort);
    let step, hurry = false;
    while (!(step = it.next(hurry)).done) hurry = step.value === 1;
    assert.deepEqual(step.value, full);
  }
});
