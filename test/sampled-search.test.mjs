// SPDX-License-Identifier: MIT
// Every sampled rung writes exactly the stream recorded in seeds/sampled-search.json. The recorded hashes come from the
// search that priced each cut from scratch; the incremental search must choose the same cuts, predictors and tree.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {complete} from '../src/bits.mjs';
import {inspectPixels} from '../src/lossless.mjs';
import {sampledSteps} from '../src/sampled.mjs';
import {searchPictures, searchRungs} from './sampled-search-cases.mjs';

const expected = JSON.parse(readFileSync(new URL('seeds/sampled-search.json', import.meta.url), 'utf8'));

for (const p of searchPictures()) test(`every sampled rung writes its recorded stream for the ${p.name} picture`, () => {
  const shape = inspectPixels(p.rgba, p.width, p.height);
  const actual = {};
  for (const [name, rung] of Object.entries(searchRungs(p.rgba, p.width, p.height))) {
    const bytes = complete(sampledSteps(p.rgba, p.width, p.height, shape, 'srgb', rung, false));
    actual[name] = bytes ? createHash('sha256').update(bytes).digest('hex') + ' ' + bytes.length : null;
  }
  assert.deepEqual(actual, expected[p.name]);
});
