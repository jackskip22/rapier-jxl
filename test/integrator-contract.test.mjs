// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import * as contract from '../src/image.mjs';
import {encode} from '../src/capture.mjs';
import {encodeCapture} from '../src/capture-codec.mjs';
import {readImage} from '../src/image-source.mjs';
import {installEncoderWorker} from '../src/encode-worker.mjs';

const turn = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return {promise, resolve, reject}; };
const pixels = (width = 17, height = 9) => ({width, height, data: Uint8Array.from({length: width * height * 4}, (_, i) => i % 4 === 3 ? 255 : (i * 17) & 255)});
const failure = code => reason => reason?.code === code;

class TestWorker extends EventTarget {
  constructor({hello = contract.CONTRACT_VERSION, handler, clone = true, postError} = {}) {
    super(); this.requests = []; this.terminated = 0; this.clone = clone; this.postError = postError;
    if (handler) {
      this.scope = new EventTarget();
      this.scope.postMessage = (message, transfer = []) => {
        const copied = structuredClone(message, {transfer});
        queueMicrotask(() => this.message(copied));
      };
      installEncoderWorker(handler, this.scope);
    } else if (hello !== false) queueMicrotask(() => this.message({protocol: 'rapier-jxl', version: hello}));
  }
  postMessage(message, transfer = []) {
    if (this.postError) throw this.postError;
    const copied = this.clone ? structuredClone(message, {transfer}) : message;
    this.requests.push(copied);
    if (this.scope) queueMicrotask(() => this.scope.dispatchEvent(new MessageEvent('message', {data: copied})));
  }
  message(data) { this.dispatchEvent(new MessageEvent('message', {data})); }
  crash(type = 'error') { this.dispatchEvent(Object.assign(new Event(type), {message: 'Worker crashed.'})); }
  complete(bytes = Uint8Array.of(255, 10, 1)) { this.message({id: this.requests.at(-1).id, ok: true, bytes}); }
  terminate() { this.terminated++; }
}
function workers(options) {
  const made = [];
  return {made, worker() { const next = new TestWorker(typeof options === 'function' ? options(made.length) : options); made.push(next); return next; }};
}
class Bitmap {
  constructor(width = 2, height = 2) { this.width = width; this.height = height; this.closed = 0; }
  close() { this.closed++; }
}
async function globals(values, run) {
  const saved = Object.fromEntries(Object.keys(values).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, {configurable: true, writable: true, value});
  try { return await run(); }
  finally { for (const key of Object.keys(values)) saved[key] ? Object.defineProperty(globalThis, key, saved[key]) : delete globalThis[key]; }
}

test('integrator v1 exports only createEncoder and CONTRACT_VERSION; clients are frozen and lazy', async () => {
  assert.deepEqual(Object.keys(contract).sort(), ['CONTRACT_VERSION', 'createEncoder']);
  assert.equal(contract.CONTRACT_VERSION, 1);
  const pool = workers(), client = contract.createEncoder(pool);
  assert.deepEqual(Object.keys(client).sort(), ['close', 'encode']);
  assert.ok(Object.isFrozen(client)); assert.equal(pool.made.length, 0);
  client.close(); client.close();
  await assert.rejects(client.encode(pixels()), failure('JXL_CLOSED'));
  assert.equal(pool.made.length, 0);
});

test('direct capture and the actual worker transport produce identical bytes without transferring caller views', async () => {
  const image = pixels(), backing = new Uint8Array(image.data.length + 13);
  backing.set(image.data, 5); image.data = backing.subarray(5, backing.length - 8);
  const original = backing.slice(), expected = encodeCapture(image.data, image.width, image.height);
  const progress = [], pool = workers({handler: encode}), client = contract.createEncoder(pool);
  try {
    assert.deepEqual(await encode(image, {gpu: 'cpu'}), expected);
    const result = await client.encode(image, {gpu: 'cpu', onProgress: value => progress.push(value)});
    assert.deepEqual(result, expected); assert.deepEqual(backing, original);
    assert.equal(image.data.byteLength, image.width * image.height * 4);
    assert.equal(pool.made[0].requests[0].source.data.byteOffset, 0);
    assert.equal(pool.made[0].requests[0].source.data.byteLength, image.data.byteLength);
    assert.equal(progress.at(-1), 1);
    assert.ok(progress.every((value, i) => value >= 0 && value <= 1 && (!i || value >= progress[i - 1])));
  } finally { client.close(); }
});

test('the waiting queue is bounded, sends one image, and queued abort immediately frees a slot', async () => {
  const pool = workers(), client = contract.createEncoder({...pool, maxQueue: 1}), cancel = new AbortController();
  const first = client.encode(pixels()), second = client.encode(pixels(), {signal: cancel.signal});
  const rejectedSecond = assert.rejects(second, reason => reason?.name === 'AbortError');
  await assert.rejects(client.encode(pixels()), failure('JXL_QUEUE_FULL'));
  await turn(); assert.equal(pool.made[0].requests.length, 1);
  cancel.abort(); await rejectedSecond;
  const third = client.encode(pixels());
  pool.made[0].complete(Uint8Array.of(1)); assert.deepEqual(await first, Uint8Array.of(1));
  await turn(); assert.equal(pool.made.length, 1); assert.equal(pool.made[0].requests.length, 2);
  pool.made[0].complete(Uint8Array.of(3)); assert.deepEqual(await third, Uint8Array.of(3));
  client.close();
});

test('active abort terminates its worker, starts the queued image, and ignores stale replies', async () => {
  const pool = workers(), client = contract.createEncoder(pool), controller = new AbortController();
  const first = client.encode(pixels(), {signal: controller.signal}), rejected = assert.rejects(first, reason => reason === 'cancelled');
  const next = client.encode(pixels());
  await turn(); const old = pool.made[0], oldId = old.requests[0].id;
  controller.abort('cancelled'); await rejected; await turn();
  assert.equal(old.terminated, 1); assert.equal(pool.made.length, 2);
  old.message({id: oldId, ok: true, bytes: Uint8Array.of(99)});
  pool.made[1].message({id: oldId, ok: true, bytes: Uint8Array.of(88)});
  pool.made[1].complete(Uint8Array.of(2)); assert.deepEqual(await next, Uint8Array.of(2));
  client.close();
});

test('falsy abort reasons and falsy progress exceptions reject instead of resolving undefined', async () => {
  for (const reason of [null, 0, false, '']) {
    const pool = workers(), client = contract.createEncoder(pool), controller = new AbortController();
    const pending = client.encode(pixels(), {signal: controller.signal}), rejected = assert.rejects(pending, error => error === reason);
    await turn(); controller.abort(reason); await rejected; client.close();
    const other = workers(), callbackClient = contract.createEncoder(other);
    const callback = callbackClient.encode(pixels(), {onProgress() { throw reason; }}), callbackRejected = assert.rejects(callback, error => error === reason);
    await turn(); other.made[0].message({id: other.made[0].requests[0].id, progress: 0.5});
    await callbackRejected; callbackClient.close();
  }
});

test('a progress callback which aborts then throws cannot kill its queued successor', async () => {
  const pool = workers(), client = contract.createEncoder(pool), controller = new AbortController();
  const first = client.encode(pixels(), {signal: controller.signal, onProgress() { controller.abort('done'); throw new Error('late callback exception'); }});
  const rejected = assert.rejects(first, reason => reason === 'done'), next = client.encode(pixels());
  await turn(); pool.made[0].message({id: pool.made[0].requests[0].id, progress: 0.5});
  await rejected; await turn();
  assert.equal(pool.made.length, 2); assert.equal(pool.made[1].terminated, 0);
  pool.made[1].complete(); await next; client.close();
});

test('an aborted pending bitmap conversion releases its late result and cannot post into the next worker', async () => {
  const pendingBitmap = deferred(), made = new Bitmap();
  await globals({createImageBitmap: () => pendingBitmap.promise}, async () => {
    const pool = workers({clone: false}), client = contract.createEncoder(pool), controller = new AbortController();
    const first = client.encode({width: 2, height: 2}, {signal: controller.signal}), rejected = assert.rejects(first, reason => reason?.name === 'AbortError');
    const next = client.encode(pixels()); await turn();
    controller.abort(); await rejected; await turn();
    assert.equal(pool.made[0].requests.length, 0); assert.equal(pool.made[1].requests.length, 1);
    pendingBitmap.resolve(made); await turn(); assert.equal(made.closed, 1);
    assert.equal(pool.made[1].requests.length, 1);
    pool.made[1].complete(); await next; client.close();
  });
});

test('close rejects the active and waiting images and releases a pending owned bitmap', async () => {
  const pendingBitmap = deferred(), made = new Bitmap();
  await globals({createImageBitmap: () => pendingBitmap.promise}, async () => {
    const pool = workers({clone: false}), client = contract.createEncoder(pool);
    const first = client.encode({width: 2, height: 2}), next = client.encode(pixels());
    const rejected = Promise.all([assert.rejects(first, failure('JXL_CLOSED')), assert.rejects(next, failure('JXL_CLOSED'))]);
    await turn(); client.close(); client.close(); await rejected;
    pendingBitmap.resolve(made); await turn(); assert.equal(made.closed, 1);
    assert.equal(pool.made.length, 1); assert.equal(pool.made[0].terminated, 1);
  });
});

test('startup version mismatch, timeout and crashes reject one task and recover the queue', async () => {
  for (const kind of ['version', 'timeout', 'error', 'messageerror']) {
    const pool = workers(index => ({hello: index ? 1 : kind === 'version' ? 2 : false}));
    const client = contract.createEncoder({...pool, startupTimeout: 10});
    const first = client.encode(pixels()), rejected = assert.rejects(first, failure(kind === 'version' ? 'JXL_PROTOCOL' : 'JXL_WORKER'));
    const next = client.encode(pixels());
    if (kind === 'error' || kind === 'messageerror') pool.made[0].crash(kind);
    await rejected; await turn();
    assert.equal(pool.made[0].terminated, 1); assert.equal(pool.made[1].requests.length, 1);
    pool.made[1].complete(); await next; client.close();
  }
});

test('crashes after dispatch recover; stale progress and invalid bytes cannot satisfy another request', async () => {
  const pool = workers(), client = contract.createEncoder(pool), progress = [];
  const first = client.encode(pixels()), rejected = assert.rejects(first, failure('JXL_WORKER'));
  const next = client.encode(pixels(), {onProgress: value => progress.push(value)});
  await turn(); pool.made[0].crash(); await rejected; await turn();
  const worker = pool.made[1], id = worker.requests[0].id;
  for (const value of [NaN, Infinity, -1, 0.4, 0.2, 2, 0.8]) worker.message({id, progress: value});
  assert.deepEqual(progress, [0.4, 0.8]);
  const invalid = assert.rejects(next, failure('JXL_PROTOCOL'));
  worker.message({id, ok: true, bytes: new ArrayBuffer(4)}); await invalid;
  assert.equal(worker.terminated, 1); client.close();
});

test('only dispatched requests can receive replies and ordinary encode errors retain the worker', async () => {
  const pool = workers({hello: false}), client = contract.createEncoder(pool);
  const first = client.encode(pixels()), rejected = assert.rejects(first, failure('JXL_INPUT'));
  const next = client.encode(pixels());
  pool.made[0].message({id: 1, ok: true, bytes: Uint8Array.of(99)});
  pool.made[0].message({protocol: 'rapier-jxl', version: contract.CONTRACT_VERSION});
  await turn(); assert.equal(pool.made[0].requests.length, 1);
  pool.made[0].message({id: 1, ok: false, error: {name: 'Error', message: 'invalid source', code: 'JXL_INPUT'}});
  await rejected; await turn(); assert.equal(pool.made.length, 1);
  pool.made[0].complete(); await next; client.close();
});

test('malformed factories, input budgets and postMessage failures reject without leaking bitmaps', async () => {
  let terminated = 0;
  const bad = contract.createEncoder({worker: () => ({addEventListener() {}, terminate() { terminated++; }})});
  await assert.rejects(bad.encode(pixels()), TypeError); assert.equal(terminated, 1); bad.close();
  const pool = workers(), limited = contract.createEncoder({...pool, maxPixels: 4});
  await assert.rejects(limited.encode(pixels(3, 2)), failure('JXL_DIMENSIONS'));
  assert.equal(pool.made[0].requests.length, 0); limited.close();
  const made = new Bitmap();
  await globals({createImageBitmap: async () => made}, async () => {
    const fail = workers({clone: false, postError: new DOMException('Cannot clone.', 'DataCloneError')}), client = contract.createEncoder(fail);
    await assert.rejects(client.encode({width: 2, height: 2}), reason => reason?.name === 'DataCloneError');
    assert.equal(made.closed, 1); assert.equal(fail.made[0].terminated, 1); client.close();
  });
});

test('readImage closes only owned bitmaps on success, conversion failure, and dimension rejection', async () => {
  const owned = [], source = new Blob([Uint8Array.of(1, 2)]);
  let failRead = false, tooLarge = false;
  class Canvas {
    constructor(width, height) { this.width = width; this.height = height; }
    getContext() { return {drawImage() {}, getImageData: () => {
      if (failRead) throw new DOMException('Tainted.', 'SecurityError');
      return pixels(this.width, this.height);
    }}; }
  }
  await globals({ImageBitmap: Bitmap, OffscreenCanvas: Canvas, createImageBitmap: async () => {
    const bitmap = new Bitmap(tooLarge ? 7 : 2, 2); owned.push(bitmap); return bitmap;
  }}, async () => {
    assert.equal((await readImage(source)).data.length, 16); assert.equal(owned[0].closed, 1);
    const borrowed = new Bitmap(); await readImage(borrowed); assert.equal(borrowed.closed, 0);
    failRead = true;
    await assert.rejects(readImage(source), reason => reason?.name === 'SecurityError'); assert.equal(owned[1].closed, 1);
    await assert.rejects(readImage(borrowed), reason => reason?.name === 'SecurityError'); assert.equal(borrowed.closed, 0);
    failRead = false; tooLarge = true;
    await assert.rejects(readImage(source, false, {pixels: 4, edge: 16}), failure('JXL_DIMENSIONS')); assert.equal(owned[2].closed, 1);
  });
});

test('direct raw and canvas sources are borrowed and pre-aborted encodes do no decoding', async () => {
  const image = pixels(2, 2); let reads = 0, bitmaps = 0;
  await globals({createImageBitmap: async () => { bitmaps++; return new Bitmap(); }}, async () => {
    assert.equal((await readImage(image)).data, image.data);
    const canvas = {width: 2, height: 2, getContext() { return {getImageData() { reads++; return image; }}; }};
    assert.equal((await readImage(canvas)).data, image.data); assert.equal(reads, 1); assert.equal(bitmaps, 0);
    const controller = new AbortController(); controller.abort(0);
    await assert.rejects(encode(canvas, {signal: controller.signal}), reason => reason === 0);
    assert.equal(reads, 1); assert.equal(bitmaps, 0);
  });
});

function scope() {
  const target = new EventTarget(); target.sent = [];
  target.postMessage = message => target.sent.push(message);
  target.request = message => target.dispatchEvent(new MessageEvent('message', {data: message}));
  return target;
}

test('the worker pins protocol v1 and releases busy, malformed and unsupported transferred bitmap inputs', async () => {
  await globals({ImageBitmap: Bitmap}, async () => {
    const pending = deferred(), server = scope(); installEncoderWorker(() => pending.promise, server);
    assert.deepEqual(server.sent[0], {protocol: 'rapier-jxl', version: contract.CONTRACT_VERSION});
    const active = new Bitmap(), busy = new Bitmap(), malformed = new Bitmap(), unsupported = new Bitmap();
    server.request({id: 1, operation: 'image', source: active});
    server.request({id: 2, operation: 'image', source: busy});
    assert.equal(busy.closed, 1); assert.equal(server.sent.at(-1).error.code, 'JXL_BUSY');
    server.request({id: 'bad', source: malformed}); assert.equal(malformed.closed, 1);
    pending.resolve(Uint8Array.of(1)); await turn(); assert.equal(active.closed, 1);
    server.request({id: 3, operation: 'animation', source: unsupported});
    assert.equal(unsupported.closed, 1); assert.equal(server.sent.at(-1).error.code, 'JXL_OPERATION');
  });
});

test('the worker reports arbitrary thrown values and filters invalid progress without getting stuck busy', async () => {
  const server = scope(); let calls = 0;
  installEncoderWorker(async (_source, {onProgress}) => {
    if (!calls++) throw null;
    for (const value of [NaN, -1, Infinity, 2, 1, 1, 0.5]) onProgress(value);
    return Uint8Array.of(255, 10);
  }, server);
  server.request({id: 1, operation: 'image', source: pixels()}); await turn();
  assert.deepEqual(server.sent.at(-1).error, {name: 'Error', code: 'JXL_ENCODE', message: 'null'});
  server.request({id: 2, operation: 'image', source: pixels(), progress: true}); await turn();
  assert.deepEqual(server.sent.filter(message => 'progress' in message), [{id: 2, progress: 1}]);
  assert.equal(server.sent.at(-1).ok, true);
});

test('per-call pixel limits can lower but cannot exceed the encoder instance budget', async () => {
  const pool = workers(), client = contract.createEncoder({...pool, maxPixels: 16});
  for (const maxPixels of [null, 0, -1, 1.5, Infinity, '4', Number.MAX_SAFE_INTEGER + 1])
    await assert.rejects(client.encode(pixels(2, 2), {maxPixels}), failure('JXL_OPTIONS'));
  assert.equal(pool.made.length, 0);
  await assert.rejects(client.encode(pixels(3, 2), {maxPixels: 4}), failure('JXL_DIMENSIONS'));
  assert.equal(pool.made[0].requests.length, 0);
  const smaller = client.encode(pixels(2, 2), {maxPixels: 4});
  await turn(); const worker = pool.made.at(-1);
  assert.equal(worker.requests.at(-1).options.maxPixels, 4); worker.complete(); await smaller;
  const larger = client.encode(pixels(3, 2), {maxPixels: 99});
  await turn(); assert.equal(worker.requests.at(-1).options.maxPixels, 16); worker.complete(); await larger;
  client.close();
});

test('the client preserves each declared sample family and offset view bit pattern', async () => {
  for (const ArrayType of [Uint8Array, Uint8ClampedArray, Uint16Array, Float32Array]) {
    const backing = new ArrayBuffer(12 * ArrayType.BYTES_PER_ELEMENT);
    const data = new ArrayType(backing, 2 * ArrayType.BYTES_PER_ELEMENT, 8);
    data.set([1, 3, 5, 7, 9, 11, 13, 15]);
    if (ArrayType === Float32Array) new Uint32Array(backing)[2] = 0x7fc01234;
    const original = new Uint8Array(backing).slice(), pool = workers(), client = contract.createEncoder(pool);
    const result = client.encode({data, width: 2, height: 1}); await turn();
    const received = pool.made[0].requests[0].source.data;
    assert.ok(received instanceof ArrayType);
    assert.deepEqual(new Uint8Array(received.buffer), original.subarray(data.byteOffset, data.byteOffset + data.byteLength));
    assert.deepEqual(new Uint8Array(backing), original);
    pool.made[0].complete(); await result; client.close();
  }
});

test('URL and string worker setup always creates a private module worker', async () => {
  const made = [];
  class BrowserWorker extends TestWorker {
    constructor(url, options) { super(); made.push({worker: this, url, options}); }
  }
  await globals({Worker: BrowserWorker}, async () => {
    for (const url of ['./capture-worker.js', new URL('https://example.invalid/capture-worker.js')]) {
      const client = contract.createEncoder({worker: url, maxQueue: 0}), result = client.encode(pixels());
      await assert.rejects(client.encode(pixels()), failure('JXL_QUEUE_FULL'));
      await turn(); const current = made.at(-1);
      assert.equal(current.url, url); assert.deepEqual(current.options, {type: 'module'});
      current.worker.complete(); await result; client.close(); assert.equal(current.worker.terminated, 1);
    }
  });
});

test('a malformed matching response fails promptly and the next image gets a fresh worker', async () => {
  const pool = workers(), client = contract.createEncoder(pool);
  const first = client.encode(pixels()), rejected = assert.rejects(first, failure('JXL_PROTOCOL'));
  const next = client.encode(pixels()); await turn();
  pool.made[0].message({id: pool.made[0].requests[0].id, progress: 'half'});
  await rejected; await turn();
  assert.equal(pool.made[0].terminated, 1); assert.equal(pool.made.length, 2);
  pool.made[1].complete(); await next; client.close();
});
