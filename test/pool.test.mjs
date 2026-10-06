// SPDX-License-Identifier: MIT
// Every core (pool.mjs): a pool of any size writes the single thread's bytes; a worker that fails or never starts leaves
// its groups to the caller's thread and the bytes stand; a hurry keeps the floor and a complete candidate; leaving the
// job ends its workers. Node's worker_threads stand in for a browser's Workers (pool-node.mjs).
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {gunzipSync} from 'node:zlib';
import {encode} from '../src/effort.mjs';
import {encodePool} from '../src/pool.mjs';
import {spawnNode} from './pool-node.mjs';

const seed = async name => new Uint8Array(await readFile(new URL('seeds/' + name, import.meta.url)));
const pictures = async () => {
  // A painting (six groups), a palette strip (three) and a picture with alpha and a colour transform to find (two).
  const width = 600, height = 300, rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) rgba.set([(i * 7) & 255, (i >> 5) & 255, (i % width) & 255, i % 11 ? 255 : 128], i * 4);
  return [{rgba: gunzipSync(await seed('hurry-painting.rgba.gz')), width: 512, height: 384},
    {rgba: await seed('local-palette.rgba'), width: 600, height: 19}, {rgba, width, height}];
};
const run = async (picture, options, pool, hurryPast = 2) => {
  const job = encodePool(picture.rgba, picture.width, picture.height, options, pool);
  for await (const done of job) if (done > hurryPast) job.hurry = true;
  return job.bytes;
};
const same = (a, b) => Buffer.compare(a, b) === 0;

test('a pool writes the single thread\'s bytes for any number of workers', async () => {
  for (const picture of await pictures()) for (const effort of [1, 3, 4, 6]) {
    const alone = encode(picture.rgba, picture.width, picture.height, {effort});
    for (const workers of [1, 2, 4]) assert.ok(same(await run(picture, {effort}, {spawn: spawnNode, workers}), alone), `${picture.width}x${picture.height} effort ${effort}, ${workers} workers`);
  }
});

test('a worker that fails, or none that starts, leaves its groups to this thread', async () => {
  const [painting] = await pictures(), alone = encode(painting.rgba, 512, 384, {effort: 4});
  let spawned = 0, exited;
  const crashing = () => { const worker = spawnNode(spawned++ ? {} : {crashAt: 2}); if (spawned === 1) exited = new Promise(done => worker.thread.once('exit', done)); return worker; };
  assert.ok(same(await run(painting, {effort: 4}, {spawn: crashing, workers: 3}), alone), 'one worker exits at its second group');
  assert.equal(await exited, 3, 'and it did exit there');
  assert.ok(same(await run(painting, {effort: 4}, {spawn: () => { throw new Error('no workers here'); }, workers: 3}), alone), 'no worker starts');
});

test('a hurried pool keeps effort 1\'s floor or a complete candidate', async () => {
  const [painting] = await pictures(), first = encode(painting.rgba, 512, 384), third = encode(painting.rgba, 512, 384, {effort: 3});
  assert.ok(third.length < first.length);
  assert.ok(same(await run(painting, {effort: 3}, {spawn: spawnNode, workers: 2}, 0), first), 'hurried at once');
  for (const from of [0.6, 0.8, 0.95]) {
    const bytes = await run(painting, {effort: 4}, {spawn: spawnNode, workers: 2}, from);
    assert.ok([first, third, encode(painting.rgba, 512, 384, {effort: 4})].some(candidate => same(candidate, bytes)), 'hurried past ' + from);
  }
});

test('leaving the job ends its workers', async () => {
  const [painting] = await pictures(), threads = [];
  const job = encodePool(painting.rgba, 512, 384, {effort: 3}, {spawn: () => { const worker = spawnNode(); threads.push(new Promise(ended => worker.thread.once('exit', ended))); return worker; }, workers: 3});
  for await (const done of job) if (done > 0.2) break;
  assert.equal(threads.length, 3);
  await Promise.all(threads);
  assert.equal(job.bytes, null);
});

test('a send that throws, at the start, a pass or a task, leaves the groups to this thread and ends the workers', async () => {
  const [painting] = await pictures(), alone = encode(painting.rgba, 512, 384, {effort: 4});
  const first = encode(painting.rgba, 512, 384), candidates = [first, encode(painting.rgba, 512, 384, {effort: 3}), alone];
  // A real worker whose nth send of a kind throws; `answered` waits for it to have answered, so that the throwing
  // send is one made from the completion callback rather than the first dispatch.
  const faulty = (kind, nth, answered, threads) => () => {
    const worker = spawnNode(), post = worker.postMessage;
    let sent = 0, answers = 0;
    threads.push(new Promise(ended => worker.thread.once('exit', ended)));
    worker.thread.on('message', () => answers++);
    worker.postMessage = (message, transfer) => {
      if (message.pool === kind && ++sent >= nth && (!answered || answers > 0)) throw new DataCloneError('injected ' + kind + ' send failure');
      return post(message, transfer);
    };
    return worker;
  };
  class DataCloneError extends Error {}
  for (const [kind, nth, answered] of [['tile', 1], ['tile', 2], ['pass', 1], ['pass', 2], ['task', 1], ['task', 1, true]]) {
    for (const hurryPast of [2, 0.6]) {
      const threads = [], bytes = await run(painting, {effort: 4}, {spawn: faulty(kind, nth, answered, threads), workers: 2}, hurryPast);
      const label = `${kind} send ${nth}${answered ? ' after an answer' : ''}, hurried past ${hurryPast}`;
      assert.ok(hurryPast > 1 ? same(bytes, alone) : candidates.some(candidate => same(candidate, bytes)), label);
      assert.equal(threads.length, 2, label);
      await Promise.all(threads);
    }
  }
});
