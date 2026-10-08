// SPDX-License-Identifier: MIT
// Cross-engine stream hashes for seeded pixels and retained fixtures.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import {encode} from '../src/index.mjs';
import {transcode} from '../src/jpeg.mjs';
import {encodePhoto} from '../src/photo.mjs';
import {encode as encodeEffort, encodeSteps as effortSteps} from '../src/effort.mjs';
import {pixelCase, borderCase} from './fuzz-cases.mjs';

const here = new URL('./', import.meta.url);
const {cases} = JSON.parse(await readFile(new URL('seeds/bytes.json', here), 'utf8'));
const file = async name => { const bytes = await readFile(new URL(name, here)); return new Uint8Array(name.endsWith('.gz') ? gunzipSync(bytes) : bytes); };
const pixels = async input => input.file ? {rgba: await file(input.file), width: input.width, height: input.height} : input.border ? borderCase(input.width, input.height) : pixelCase(input.seed, input.index);
const doors = {
  encode: async (input, options) => { const {rgba, width, height} = await pixels(input); return encode(rgba, width, height, options); },
  effort: async (input, options) => { const {rgba, width, height} = await pixels(input); return encodeEffort(rgba, width, height, options); },
  // Hurrying before the first step returns effort 1's stream.
  hurried: async (input, options) => { const {rgba, width, height} = await pixels(input), job = effortSteps(rgba, width, height, options); job.hurry = true; for (const _ of job); return job.bytes; },
  photo: async (input, options) => { const {rgba, width, height} = await pixels(input); return encodePhoto(rgba, width, height, options); },
  transcode: async (input, options) => transcode(await file(input.file), options).bytes,
};

test('each entry point writes the recorded bytes', async () => {
  for (const {door, input, options, sha256} of cases) {
    const bytes = await doors[door](input, options);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), sha256, `${door} ${JSON.stringify(input)} ${JSON.stringify(options)}`);
  }
});
