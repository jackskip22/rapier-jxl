// SPDX-License-Identifier: MIT
// toJXL against a stand-in worker that speaks the worker protocol and answers JXL_BUSY when a second picture
// arrives before the first is done. The client waits its turn.
import test from 'node:test';
import assert from 'node:assert/strict';
import {toJXL} from '../src/image.mjs';

class SingleFlightWorker extends EventTarget {
  active = null; order = []; terminated = false;
  postMessage({id, operation, source}) {
    assert.equal(operation, 'image');
    if (this.active) return this.answer({id, ok: false, error: {code: 'JXL_BUSY', message: 'The image worker is busy.'}});
    this.active = id; this.order.push(id);
    setTimeout(async () => {
      const bytes = new Uint8Array(await source.arrayBuffer());
      this.active = null;
      this.answer(bytes[0] === 0 ? {id, ok: false, error: {code: 'JXL_ENCODE', message: 'refused'}} : {id, ok: true, bytes});
    }, 5);
  }
  answer(data) { queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', {data}))); }
  terminate() { this.terminated = true; }
}

test('calls sharing one Worker run in turn instead of failing busy', async () => {
  const worker = new SingleFlightWorker();
  const blobs = await Promise.all([1, 2, 3].map(n => toJXL(new Blob([new Uint8Array([n])]), {worker})));
  assert.deepEqual(await Promise.all(blobs.map(async blob => [blob.type, [...new Uint8Array(await blob.arrayBuffer())]])),
    [['image/jxl', [1]], ['image/jxl', [2]], ['image/jxl', [3]]]);
  assert.equal(worker.order.length, 3);
  assert.equal(worker.terminated, false);
});

test('a failed call does not block the next one on the same Worker', async () => {
  const worker = new SingleFlightWorker();
  const [failed, made] = await Promise.allSettled([
    toJXL(new Blob([new Uint8Array([0])]), {worker}),
    toJXL(new Blob([new Uint8Array([7])]), {worker}),
  ]);
  assert.equal(failed.status, 'rejected');
  assert.equal(failed.reason.code, 'JXL_ENCODE');
  assert.deepEqual([...new Uint8Array(await made.value.arrayBuffer())], [7]);
});

test('a missing worker names both worker files', async () => {
  await assert.rejects(toJXL(new Blob([]), {}), error => error.code === 'JXL_OPTIONS' && /rapier-still-worker\.js/.test(error.message) && /rapier-worker\.js/.test(error.message));
});
