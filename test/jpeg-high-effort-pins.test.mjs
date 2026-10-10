// SPDX-License-Identifier: MIT
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {transcode} from '../src/jpeg.mjs';
import {transcode as transcodeAns} from '../src/jpeg-ans.mjs';
const cases = JSON.parse(readFileSync(new URL('jpeg-high-effort.json', import.meta.url)));
for (const pin of cases) test(pin.door + ' JPEG effort ' + pin.effort + ': ' + pin.file, () => {
  const input = new Uint8Array(readFileSync(new URL(pin.file, import.meta.url)));
  const bytes = (pin.door === 'ans' ? transcodeAns : transcode)(input, {effort: pin.effort}).bytes;
  assert.equal(bytes.length, pin.bytes);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), pin.sha256);
});
