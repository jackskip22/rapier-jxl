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
import {inspectPixels} from '../src/lossless.mjs';
import {localSteps} from '../src/local.mjs';
import {spawnNode} from './pool-node.mjs';
import {decoder} from './decoder.mjs';
import {borderCase, pixelCase} from './fuzz-cases.mjs';
import {createJPEGXLEncoder} from '../src/rapier-encoder.mjs';

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
  let previous = 0;
  for await (const done of job) {
    assert.ok(Number.isFinite(done) && done >= previous && done > 0 && done <= 1, 'completed work never moves backward');
    previous = done;
    if (done > hurryPast) job.hurry = true;
  }
  assert.equal(previous, 1);
  return job.bytes;
};
const same = (a, b) => Buffer.compare(a, b) === 0;

// Repeated glyphs cross both 256- and 1024-pixel group edges. Hidden RGB differs from the background, so an atlas
// or body tile reused for the wrong frame cannot pass an exact decode merely because it is transparent.
function pooledScreen() {
  const width = 1031, height = 65, rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const ink = x % 19 >= 3 && x % 19 < 10 && y % 23 >= 5 && y % 23 < 16;
    rgba.set(ink ? [40, 60, 80, 0] : [240, 240, 240, 200], (y * width + x) * 4);
  }
  return {rgba, width, height};
}

test('screen and learned format groups keep exact pixels when pool tiles change frames and dimensions', async () => {
  const picture = pooledScreen(), before = picture.rgba.slice(), decode = await decoder();
  const alone = encode(picture.rgba, picture.width, picture.height, {effort: 6});
  for (const workers of [1, 2]) {
    const bytes = await run(picture, {effort: 6}, {spawn: spawnNode, workers});
    assert.deepEqual(bytes, alone);
    if (decode) { const image = decode(bytes); assert.equal(image.channels, 4); assert.deepEqual(image.data, before); }
  }
  // Reject a frame replacement after the initial tiles have been accepted. The local fallback must use the
  // requested frame's source and group geometry, not the original image's pixels and 256-pixel layout.
  let resets = 0, injected = false;
  const threads = [], spawn = () => {
    const worker = spawnNode(), post = worker.postMessage;
    threads.push(new Promise(ended => worker.thread.once('exit', ended)));
    worker.postMessage = (message, transfer) => {
      if (message.pool === 'reset' && ++resets === 2) { injected = true; throw new Error('frame replacement failed'); }
      return post(message, transfer);
    };
    return worker;
  };
  assert.deepEqual(await run(picture, {effort: 6}, {spawn, workers: 1}), alone);
  assert.ok(injected, 'the failure happens while replacing a live frame');
  await Promise.all(threads);
  assert.deepEqual(picture.rgba, before);
});

test('hurry and cancellation leave no partial pooled screen or retained workers', async () => {
  const picture = pooledScreen(), decode = await decoder();
  const floor = encode(picture.rgba, picture.width, picture.height);
  for (const hurryPast of [0.53, 0.62]) {
    const bytes = await run(picture, {effort: 6}, {spawn: spawnNode, workers: 2}, hurryPast);
    assert.ok(bytes.length <= floor.length);
    if (decode) { const image = decode(bytes); assert.equal(image.channels, 4); assert.deepEqual(image.data, picture.rgba); }
  }
  let reset = false, resets = 0;
  const threads = [], job = encodePool(picture.rgba, picture.width, picture.height, {effort: 6}, {
    workers: 1, spawn: () => {
      const worker = spawnNode(), post = worker.postMessage;
      threads.push(new Promise(ended => worker.thread.once('exit', ended)));
      worker.postMessage = (message, transfer) => {
        if (message.pool === 'reset' && ++resets > 1) reset = true;
        return post(message, transfer);
      };
      return worker;
    }
  });
  for await (const done of job) if (reset) break;
  assert.ok(reset);
  await Promise.all(threads);
  assert.equal(job.bytes, null);
});

test('a pool writes the single thread\'s bytes for any number of workers', async () => {
  for (const picture of await pictures()) for (const effort of [1, 3, 4, 6]) {
    const alone = encode(picture.rgba, picture.width, picture.height, {effort});
    for (const workers of [1, 2, 4]) assert.ok(same(await run(picture, {effort}, {spawn: spawnNode, workers}), alone), `${picture.width}x${picture.height} effort ${effort}, ${workers} workers`);
  }
  // The two precise transforms of this small gradient tie at 141 bytes but encode different streams. Keep the
  // original winner even if the later model answers first; RGBA also keeps colour samples and alpha unchanged.
  for (const picture of [borderCase(32, 33), pixelCase(20260930, 0)]) {
    const before = picture.rgba.slice(), alone = encode(picture.rgba, picture.width, picture.height, {effort: 9});
    for (const workers of [1, 2, 3]) {
      let held = null, secondDone = false;
      const spawn = () => {
        const worker = spawnNode();
        let deliver;
        Object.defineProperty(worker, 'onmessage', {
          get: () => deliver && (message => {
            if (workers > 1 && message.data.pool === 'candidate-done') {
              if (message.data.k === 0 && !secondDone) { held = () => deliver(message); return; }
              if (message.data.k === 1) { secondDone = true; deliver(message); held?.(); held = null; return; }
            }
            deliver(message);
          }),
          set: callback => { deliver = callback; }
        });
        return worker;
      };
      assert.deepEqual(await run(picture, {effort: 9}, {spawn, workers, groupWorkers: false}), alone);
      assert.deepEqual(picture.rgba, before);
    }
  }
});

test('a pruned local model leaves later colour-transform candidates eligible', async () => {
  const width = 513, height = 259, rgba = new Uint8Array(width * height * 4);
  let state = 17;
  const next = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state >>> 24; };
  for (let i = 0; i < rgba.length; i += 4) { const r = next(), g = next(); rgba.set([r, g, g, 255], i); }
  const picture = {rgba, width, height}, source = rgba.slice();
  const floor = encode(rgba, width, height, {effort: 3}), transformed = encode(rgba, width, height, {effort: 4});
  assert.ok(transformed.length < floor.length);
  const candidate = localSteps(rgba, width, height, inspectPixels(rgba, width, height), undefined, 6, false, false, floor.length);
  let step;
  while (!(step = candidate.next()).done);
  assert.ok(step.value === null, 'a completed-section lower bound cannot return a losing or truncated stream');
  const full = encode(rgba, width, height, {effort: 9});
  assert.ok(full.length <= transformed.length, 'later learned models may improve the completed colour-transform stream');
  for (const workers of [1, 2, 4]) assert.deepEqual(await run(picture, {effort: 9}, {spawn: spawnNode, workers}), full);
  const decode = await decoder();
  if (decode) {
    const image = decode(full);
    assert.equal(image.width, width); assert.equal(image.height, height); assert.equal(image.channels, 3);
    for (let i = 0; i < width * height; i++) for (let c = 0; c < 3; c++) assert.equal(image.data[i * 3 + c], rgba[i * 4 + c]);
  }
  assert.deepEqual(rgba, source);
});

test('a worker that fails, or none that starts, leaves its groups to this thread', async () => {
  const [painting] = await pictures(), alone = encode(painting.rgba, 512, 384, {effort: 4});
  let spawned = 0, exited;
  const crashing = () => { const worker = spawnNode(spawned++ ? {} : {crashAt: 2}); if (spawned === 1) exited = new Promise(done => worker.thread.once('exit', done)); return worker; };
  assert.ok(same(await run(painting, {effort: 4}, {spawn: crashing, workers: 3}), alone), 'one worker exits at its second group');
  assert.equal(await exited, 3, 'and it did exit there');
  assert.ok(same(await run(painting, {effort: 4}, {spawn: () => { throw new Error('no workers here'); }, workers: 3}), alone), 'no worker starts');
  const picture = borderCase(32, 33), source = picture.rgba.slice(), precise = encode(picture.rgba, picture.width, picture.height, {effort: 9});
  for (const failure of ['start', 'send', 'exit']) {
    let injected = false;
    const threads = [], spawn = () => {
      if (failure === 'start') { injected = true; throw new Error('worker unavailable'); }
      const worker = spawnNode(), post = worker.postMessage;
      threads.push(new Promise(ended => worker.thread.once('exit', ended)));
      worker.postMessage = (message, transfer) => {
        if (message.pool === 'candidate' && !injected) {
          injected = true;
          if (failure === 'send') throw new Error('candidate transfer failed');
          post(message, transfer); worker.thread.terminate(); return;
        }
        return post(message, transfer);
      };
      return worker;
    };
    assert.deepEqual(await run(picture, {effort: 9}, {spawn, workers: 2, groupWorkers: false}), precise, failure);
    assert.ok(injected, failure + ' occurred during the helper candidate');
    await Promise.all(threads);
    assert.deepEqual(picture.rgba, source);
  }
});

test('a hurried pool keeps effort 1\'s floor or a complete candidate', async () => {
  const [painting] = await pictures(), first = encode(painting.rgba, 512, 384), third = encode(painting.rgba, 512, 384, {effort: 3});
  assert.ok(third.length < first.length);
  assert.ok(same(await run(painting, {effort: 3}, {spawn: spawnNode, workers: 2}, 0), first), 'hurried at once');
  for (const from of [0.6, 0.8, 0.95]) {
    const bytes = await run(painting, {effort: 4}, {spawn: spawnNode, workers: 2}, from);
    assert.ok([first, third, encode(painting.rgba, 512, 384, {effort: 4})].some(candidate => same(candidate, bytes)), 'hurried past ' + from);
  }
  const picture = borderCase(32, 33), source = picture.rgba.slice();
  // The admitted screen model at effort 5 is complete before the helpers start, even when the later learned
  // model at effort 8 beats it. A dispatch hurry can retain that earlier stream.
  const candidates = [1, 3, 5, 8, 9].map(effort => encode(picture.rgba, picture.width, picture.height, {effort}));
  let dispatched = false;
  const threads = [], job = encodePool(picture.rgba, picture.width, picture.height, {effort: 9}, {
    workers: 2, groupWorkers: false, spawn: () => {
      const worker = spawnNode(), post = worker.postMessage;
      threads.push(new Promise(ended => worker.thread.once('exit', ended)));
      worker.postMessage = (message, transfer) => {
        if (message.pool === 'candidate') { dispatched = true; job.hurry = true; }
        return post(message, transfer);
      };
      return worker;
    }
  });
  for await (const _ of job);
  assert.ok(dispatched, 'hurry is requested while helper candidates are live');
  assert.ok(candidates.some(bytes => same(bytes, job.bytes)), 'a hurried helper keeps a complete candidate');
  assert.ok(job.bytes.length <= candidates[0].length);
  await Promise.all(threads);
  assert.deepEqual(picture.rgba, source);
});

test('leaving the job ends its workers', async () => {
  const [painting] = await pictures(), threads = [];
  const job = encodePool(painting.rgba, 512, 384, {effort: 3}, {spawn: () => { const worker = spawnNode(); threads.push(new Promise(ended => worker.thread.once('exit', ended))); return worker; }, workers: 3});
  for await (const done of job) if (done > 0.2) break;
  assert.equal(threads.length, 3);
  await Promise.all(threads);
  assert.equal(job.bytes, null);
  const picture = borderCase(32, 33), source = picture.rgba.slice();
  let dispatched = false;
  const helpers = [], precise = encodePool(picture.rgba, picture.width, picture.height, {effort: 9}, {
    workers: 2, groupWorkers: false, spawn: () => {
      const worker = spawnNode(), post = worker.postMessage;
      helpers.push(new Promise(ended => worker.thread.once('exit', ended)));
      worker.postMessage = (message, transfer) => { if (message.pool === 'candidate') dispatched = true; return post(message, transfer); };
      return worker;
    }
  });
  for await (const _ of precise) if (dispatched) break;
  assert.ok(dispatched, 'cancellation interrupts live helper candidates');
  await Promise.all(helpers);
  assert.equal(precise.bytes, null);
  assert.deepEqual(picture.rgba, source);
  const priorNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator'), callbackWorkers = [], callbackExits = [];
  let callbackLive = false, cleanupTimer;
  Object.defineProperty(globalThis, 'navigator', {configurable: true, value: {hardwareConcurrency: 3}});
  try {
    const encoder = createJPEGXLEncoder({spawn: () => {
      const worker = spawnNode(), post = worker.postMessage;
      callbackWorkers.push(worker); callbackExits.push(new Promise(ended => worker.thread.once('exit', ended)));
      worker.postMessage = (message, transfer) => { if (message.pool === 'candidate') callbackLive = true; return post(message, transfer); };
      return worker;
    }});
    const refusal = new Error('The progress consumer stopped');
    await assert.rejects(encoder.encode(picture.rgba, picture.width, picture.height, {
      quality: 100, effort: 9, progress: fraction => { if (callbackLive && fraction < 1) throw refusal; }
    }), error => error === refusal);
    assert.ok(callbackLive, 'the callback stops an encode with live helper work');
    await Promise.race([Promise.all(callbackExits), new Promise((_, reject) => {
      cleanupTimer = setTimeout(() => reject(new Error('The rejected encode retained helper workers')), 10000);
    })]);
    assert.deepEqual(picture.rgba, source);
  } finally {
    clearTimeout(cleanupTimer);
    await Promise.all(callbackWorkers.map(worker => worker.terminate()));
    if (priorNavigator) Object.defineProperty(globalThis, 'navigator', priorNavigator); else delete globalThis.navigator;
  }
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
