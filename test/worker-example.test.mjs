// SPDX-License-Identifier: MIT
// The supplied worker must preserve the same options and bytes as its synchronous entry points.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Worker} from 'node:worker_threads';
import {readFile} from 'node:fs/promises';
import {encode} from '../src/effort.mjs';
import {encodePhoto} from '../src/photo.mjs';
import {transcode} from '../src/jpeg.mjs';
import {pixelCase} from './fuzz-cases.mjs';
import {integerFixture, floatFixture} from './high-depth-fixtures.mjs';

test('the example worker preserves colour space and search options across the message boundary', async () => {
  const workerURL = new URL('../examples/worker.mjs', import.meta.url).href;
  const worker = new Worker(`const {parentPort} = require('node:worker_threads');
    globalThis.self = {postMessage: (value, transfer) => parentPort.postMessage(value, transfer)};
    import(${JSON.stringify(workerURL)}).then(() => {
      parentPort.on('message', data => self.onmessage({data}));
      parentPort.postMessage({ready: true});
    });`, {eval: true});
  const next = predicate => new Promise((resolve, reject) => {
    const message = value => { if (predicate(value)) { cleanup(); resolve(value); } };
    const error = failure => { cleanup(); reject(failure); };
    const cleanup = () => { worker.off('message', message); worker.off('error', error); };
    worker.on('message', message); worker.on('error', error);
  });
  try {
    await next(value => value.ready);
    const {rgba, width, height} = pixelCase(0x12345678, 3);
    const jpeg = new Uint8Array(await readFile(new URL('seeds/colour-sequential.jpg', import.meta.url)));
    const options = {quality: 90, effort: 4, colorSpace: 'display-p3'};
    const cases = [
      {op: 'encode', data: rgba, width, height, ...options, expected: encode(rgba, width, height, options)},
      {op: 'photo', data: rgba, width, height, ...options, expected: encodePhoto(rgba, width, height, options)},
      {op: 'transcode', jpeg, effort: 4, expected: transcode(jpeg, {effort: 4}).bytes},
    ];
    for (const fixture of [integerFixture(12), floatFixture({half: true}), floatFixture()]) {
      const {data, width, height} = fixture, options = {...fixture.options, quality: 50, effort: 2,
        colorSpace: 'rec2020', transferFunction: 'pq', intensityTarget: 10000, alphaPremultiplied: true};
      for (const op of ['encode', 'photo']) cases.push({op, data, width, height, ...options,
        expected: (op === 'encode' ? encode : encodePhoto)(data, width, height, options)});
    }
    for (const [id, {expected, ...ask}] of cases.entries()) {
      const reply = next(value => value.id === id && Object.hasOwn(value, 'ok'));
      worker.postMessage({id, ...ask});
      const answer = await reply;
      assert.equal(answer.ok, true, answer.message);
      assert.equal(Buffer.compare(answer.bytes, expected), 0, ask.op + ': encoded bytes');
    }
    const refused = next(value => value.id === 'invalid' && Object.hasOwn(value, 'ok'));
    worker.postMessage({id: 'invalid', op: {toString: 0, valueOf: 0}});
    assert.equal((await refused).code, 'JXL_INPUT');
  } finally { await worker.terminate(); }
});
