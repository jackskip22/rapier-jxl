// SPDX-License-Identifier: MIT
// The sampled option preserves exact pixels, effort 1's bytes and deterministic worker results. A hurry always
// returns its original effort-1 stream, including after a completed sampled candidate.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {gunzipSync} from 'node:zlib';
import {encode as coreEncode} from '../src/index.mjs';
import {encode, encodeSteps} from '../src/effort.mjs';
import {inspectPixels} from '../src/lossless.mjs';
import {SAMPLE_RUNGS, sampledSteps} from '../src/sampled.mjs';
import {encodePool} from '../src/pool.mjs';
import {spawnNode} from './pool-node.mjs';
import {borderCase, pixelCase} from './fuzz-cases.mjs';
import {decoder} from './decoder.mjs';
import {rgbaOf} from './oracles.mjs';

const decode = await decoder(), option = {treeLearning: 'sampled'};
const same = (a, b) => Buffer.compare(a, b) === 0;
const painting = async () => ({rgba: gunzipSync(await readFile(new URL('seeds/hurry-painting.rgba.gz', import.meta.url))), width: 512, height: 384});
const runPool = async (p, options, pool = {spawn: spawnNode, workers: 2}, stop = Infinity) => {
  const job = encodePool(p.rgba, p.width, p.height, options, pool);
  for await (const done of job) if (done >= stop) job.hurry = true;
  return job.bytes;
};

test('sampled options are admitted immediately by synchronous and pooled doors', () => {
  const p = borderCase(9, 7);
  for (const treeLearning of [null, false, 0, '', 'random', {}, []]) {
    assert.throws(() => encodeSteps(p.rgba, p.width, p.height, {treeLearning}), {code: 'JXL_INPUT'});
    assert.throws(() => encodePool(p.rgba, p.width, p.height, {treeLearning}), {code: 'JXL_INPUT'});
  }
  assert.ok(same(encode(p.rgba, p.width, p.height, option), coreEncode(p.rgba, p.width, p.height)));
  for (const colorSpace of ['srgb', 'display-p3']) assert.ok(same(
    encode(p.rgba, p.width, p.height, {...option, colorSpace, effort: 1}), coreEncode(p.rgba, p.width, p.height, {colorSpace})));
  for (const p of [borderCase(41, 35), pixelCase(20260930, 13)]) assert.ok(same(
    encode(p.rgba, p.width, p.height, {...option, effort: 4, quality: 75}), encode(p.rgba, p.width, p.height, {effort: 4, quality: 75})));
});

test('sampled rungs retain exact border, alpha and painting pixels and the previous byte floor', {skip: decode ? undefined : 'jxl-oxide-wasm is not installed'}, async () => {
  const pictures = [borderCase(1, 257), borderCase(257, 1), borderCase(257, 33), ...[1, 13, 23].map(i => pixelCase(20260930, i)), await painting()];
  for (const p of pictures) {
    let previous = coreEncode(p.rgba, p.width, p.height);
    for (const effort of [2, 4]) {
      const bytes = encode(p.rgba, p.width, p.height, {...option, effort});
      assert.ok(bytes.length <= previous.length, `${p.width}x${p.height}, effort ${effort}: complete stream floor`);
      assert.ok(same(bytes, encode(p.rgba, p.width, p.height, {...option, effort})), 'repeated encoding is deterministic');
      assert.ok(same(rgbaOf(decode(bytes)), p.rgba), `${p.width}x${p.height}, effort ${effort}: exact pixels`);
      previous = bytes;
    }
  }
});

test('sampled work writes identical bytes alone, on real workers and after worker failure', async () => {
  const p = await painting();
  for (const effort of [2, 4]) {
    const options = {...option, effort}, bytes = encode(p.rgba, p.width, p.height, options);
    for (const workers of [1, 2, 4]) assert.ok(same(await runPool(p, options, {spawn: spawnNode, workers}), bytes), `${workers} workers, effort ${effort}`);
    assert.ok(same(await runPool(p, options, {spawn: () => spawnNode({crashAt: 1}), workers: 2}), bytes), 'failed workers retain the same stream');
  }
});

test('every sampled hurry boundary returns effort 1 exactly, also after a completed rung', async () => {
  const p = await painting(), first = coreEncode(p.rgba, p.width, p.height), options = {...option, effort: 4};
  const completed = encodeSteps(p.rgba, p.width, p.height, options), boundaries = [];
  for (const done of completed) boundaries.push(done);
  assert.ok(completed.bytes.length < first.length, 'an unhurried sampled result improves the floor');
  for (let stop = -1; stop < boundaries.length; stop++) {
    const job = encodeSteps(p.rgba, p.width, p.height, options);
    if (stop < 0) job.hurry = true;
    let i = 0; for (const _ of job) if (i++ === stop) job.hurry = true;
    assert.ok(same(job.bytes, first), 'hurry at boundary ' + stop);
  }
  for (const stop of [0, 0.5, 0.75, 1]) assert.ok(same(await runPool(p, options, undefined, stop), first), 'pooled hurry at ' + stop);
  const a = encodeSteps(p.rgba, p.width, p.height, {...option, effort: 2}), b = encodeSteps(p.rgba, p.width, p.height, options);
  for (let live = true; live;) { const x = a.next(), y = b.next(); live = !x.done || !y.done; }
  assert.ok(same(a.bytes, encode(p.rgba, p.width, p.height, {...option, effort: 2})));
  assert.ok(same(b.bytes, completed.bytes));
});


const runModel = (p, options, ceiling = Infinity, stop = -1) => {
  const steps = sampledSteps(p.rgba, p.width, p.height, inspectPixels(p.rgba, p.width, p.height), 'srgb', options, false, ceiling);
  let step, reply, count = 0;
  while (!(step = steps.next(reply)).done) reply = count++ === stop;
  return {bytes: step.value, count};
};

test('mixed predictor trees preserve pixels across large-group borders and hidden RGB', {skip: decode ? undefined : 'jxl-oxide-wasm is not installed'}, async () => {
  const alpha = borderCase(1031, 17);
  for (let i = 0; i < alpha.width * alpha.height; i++) alpha.rgba[i * 4 + 3] = i * 7 & 255;
  const pictures = [borderCase(1, 1025), borderCase(1025, 1), alpha, await painting()];
  for (const p of pictures) for (const options of [SAMPLE_RUNGS.deep, SAMPLE_RUNGS.thorough, SAMPLE_RUNGS.exhaustive, SAMPLE_RUNGS.expanded, SAMPLE_RUNGS.maximum]) {
    const {bytes} = runModel(p, options);
    assert.ok(same(rgbaOf(decode(bytes)), p.rgba), `${p.width}x${p.height}: exact pixels`);
    assert.ok(same(runModel(p, options).bytes, bytes), 'repeated model selection is deterministic');
  }
});

test('mixed model pruning and hurry preserve completed-candidate ownership', () => {
  for (const p of [borderCase(129, 31), borderCase(2057, 17)]) {
    const options = SAMPLE_RUNGS.deep, {bytes, count} = runModel(p, options);
    assert.ok(same(runModel(p, options, Infinity, count - 1).bytes, bytes), 'the final yield owns a complete candidate');
    for (let stop = 0; stop < count - 1; stop++) assert.equal(runModel(p, options, Infinity, stop).bytes, null, 'an earlier hurry ends the incomplete candidate');
    assert.equal(runModel(p, options, Math.floor(bytes.length / 2)).bytes, null, 'completed sections reject a losing candidate');
    assert.ok(same(runModel(p, options).bytes, bytes), 'pruning does not alter later model selection');
  }
});
