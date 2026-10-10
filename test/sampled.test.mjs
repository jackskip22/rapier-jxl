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
import {groupLayout, groupRect} from '../src/frame.mjs';
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

test('sampled terminal hurry retains the floor after worker cleanup and local fallback', async () => {
  const p = await painting(), source = p.rgba.slice(), floor = coreEncode(p.rgba, p.width, p.height);
  for (const {workers, crashAt} of [{workers: 0}, {workers: 1}, {workers: 2, crashAt: 1}]) {
    let last = 0;
    const exits = [], job = encodePool(p.rgba, p.width, p.height, {...option, effort: 4}, {
      workers, spawn: () => {
        const worker = spawnNode({crashAt});
        exits.push(new Promise(ended => worker.thread.once('exit', ended)));
        return worker;
      }
    });
    for await (const done of job) {
      assert.ok(done > last && done <= 1, 'progress increases to one terminal boundary');
      last = done;
      assert.equal(job.bytes, null, 'bytes publish only after iteration completes');
      if (done === 1) {
        job.hurry = true;
      }
    }
    assert.equal(last, 1);
    assert.ok(same(job.bytes, floor), 'terminal hurry returns the original effort-1 stream');
    await Promise.all(exits);
    assert.deepEqual(p.rgba, source);
  }
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
  for (const p of pictures) for (const options of [SAMPLE_RUNGS.deep, SAMPLE_RUNGS.maximum, SAMPLE_RUNGS.broad, SAMPLE_RUNGS.precise, {...SAMPLE_RUNGS.precise, rctType: 13}]) {
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


test('each Modular predictor preserves signed transforms and edge rounding', {skip: decode ? undefined : 'jxl-oxide-wasm is not installed'}, () => {
  for (const [width, height] of [[1, 7], [2, 3], [3, 3], [7, 1]]) {
    const p = borderCase(width, height);
    for (let i = 0; i < width * height; i++) p.rgba[i * 4 + 3] = i * 43 & 255;
    for (const rctType of [6, 13]) for (let predictor = 0; predictor < 14; predictor++) {
      const options = {...SAMPLE_RUNGS.precise, trainConfig: undefined, samples: width * height, leaves: 1, properties: [], references: false, predictors: [predictor], rctType};
      const {bytes} = runModel(p, options);
      assert.ok(same(rgbaOf(decode(bytes)), p.rgba), `${width}x${height}, RCT ${rctType}, predictor ${predictor}`);
    }
  }
});

async function runModelHelpers(p, options) {
  const steps = sampledSteps(p.rgba, p.width, p.height, inspectPixels(p.rgba, p.width, p.height), 'srgb', options, true);
  const workers = [spawnNode(), spawnNode()];
  let step, reply, serial = 0, completed = 0;
  try {
    while (!(step = steps.next(reply)).done) {
      const request = step.value;
      if (typeof request === 'number') { reply = false; continue; }
      const frame = groupLayout(p.width, p.height, request.dim), count = frame.groupsX * frame.groupsY, id = ++serial;
      assert.equal(count, 2);
      const results = await Promise.all(Array.from({length: count}, (_, g) => new Promise((resolve, reject) => {
        const worker = workers[g], [x0, y0, w, h] = groupRect(frame, p.width, p.height, g, request.dim), rgba = new Uint8Array(w * h * 4);
        for (let y = 0; y < h; y++) rgba.set(p.rgba.subarray(((y0 + y) * p.width + x0) * 4, ((y0 + y) * p.width + x0 + w) * 4), y * w * 4);
        worker.onerror = reject;
        worker.onmessage = ({data}) => {
          if (data.id !== id || data.g !== g) return reject(new Error('Unexpected helper result'));
          if (data.error) return reject(new Error(data.error.message));
          completed++; resolve(data.result);
        };
        worker.postMessage({pool: 'reset'});
        worker.postMessage({pool: 'tile', g, w, h, rgba}, [rgba.buffer]);
        worker.postMessage({pool: 'pass', id, kind: request.kind, setup: request.setup});
        worker.postMessage({pool: 'task', g});
      })));
      reply = {results, hurried: false};
    }
    assert.equal(completed, 2, 'both format groups were encoded by real helpers');
    return step.value;
  } finally { await Promise.all(workers.map(worker => worker.terminate())); }
}

test('predictive signed models preserve exact pixels and helper bytes across 1024-pixel groups', {skip: decode ? undefined : 'jxl-oxide-wasm is not installed'}, async () => {
  for (const [width, height] of [[1031, 17], [17, 1031]]) {
    const p = borderCase(width, height);
    for (let i = 0; i < width * height; i++) p.rgba[i * 4 + 3] = i * 7 & 255;
    const options = {...SAMPLE_RUNGS.precise, rctType: 13};
    const {bytes} = runModel(p, options), pooled = await runModelHelpers(p, options);
    assert.ok(same(pooled, bytes), `${width}x${height}: actual helper output`);
    assert.ok(same(rgbaOf(decode(bytes)), p.rgba), `${width}x${height}: exact hidden RGB and alpha`);
  }
});
