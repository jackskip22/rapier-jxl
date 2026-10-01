// SPDX-License-Identifier: MIT
// The same input writes the same bytes in every engine: Node runs this with the suite, Bun with `bun test`. Each case
// in seeds/bytes.json names a door, its input (a seeded pixel case, made by integer arithmetic alone, or a retained
// file) and its options, and the SHA-256 of the stream written. A changed hash is a changed encoder, made on purpose
// and recorded with its measurements.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {encode} from '../../index.mjs';
import {transcode} from '../../jpeg.mjs';
import {encodePhoto} from '../../photo.mjs';
import {encode as encodeEffort, encodeSteps as effortSteps} from '../../effort.mjs';
import {pixelCase, borderCase} from './fuzz-cases.mjs';

const here = new URL('./', import.meta.url);
const {cases} = JSON.parse(await readFile(new URL('seeds/bytes.json', here), 'utf8'));
const file = async name => new Uint8Array(await readFile(new URL(name, here)));
const pixels = async input => input.file ? {rgba: await file(input.file), width: input.width, height: input.height} : input.border ? borderCase(input.width, input.height) : pixelCase(input.seed, input.index);
const doors = {
  encode: async (input, options) => { const {rgba, width, height} = await pixels(input); return encode(rgba, width, height, options); },
  effort: async (input, options) => { const {rgba, width, height} = await pixels(input); return encodeEffort(rgba, width, height, options); },
  // The effort door's job hurried before its first step: the floor, effort 1's stream.
  hurried: async (input, options) => { const {rgba, width, height} = await pixels(input), job = effortSteps(rgba, width, height, options); job.hurry = true; for (const _ of job); return job.bytes; },
  photo: async (input, options) => { const {rgba, width, height} = await pixels(input); return encodePhoto(rgba, width, height, options); },
  transcode: async (input, options) => transcode(await file(input.file), options).bytes,
};

test('every door writes the recorded bytes', async () => {
  for (const {door, input, options, sha256} of cases) {
    const bytes = await doors[door](input, options);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), sha256, `${door} ${JSON.stringify(input)} ${JSON.stringify(options)}`);
  }
});
