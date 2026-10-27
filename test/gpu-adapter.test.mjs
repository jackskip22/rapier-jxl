// SPDX-License-Identifier: MIT
// A software (fallback) WebGPU adapter, such as SwiftShader, is slower than the CPU path.
// Without an explicit device the encoder must not choose it.
import test from 'node:test';
import assert from 'node:assert/strict';

let requested = 0;
const fallback = {info: {isFallbackAdapter: true}, limits: {maxStorageBufferBindingSize: 1 << 27, maxBufferSize: 1 << 28},
  requestDevice: async () => { requested++; throw new Error('a fallback adapter must not be opened'); }};
Object.defineProperty(globalThis, 'navigator', {value: {gpu: {requestAdapter: async () => fallback}}, configurable: true});

const {gpuCoreDevice} = await import('../src/gpu-core.mjs');
const {encode, encodeAsync} = await import('../src/index.mjs');

test('the WebGPU device helper skips a fallback adapter', async () => {
  assert.equal(await gpuCoreDevice(), null);
  assert.equal(requested, 0);
});

test('encodeAsync on a GPU-sized picture with only a fallback adapter takes the CPU path and writes encode\'s bytes', async () => {
  const width = 1024, height = 1024, rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < rgba.length; i += 4) { const p = i >> 2, x = p % width, y = p / width | 0; rgba.set([x & 255, y & 255, (x ^ y) & 255, 255], i); }
  const bytes = await encodeAsync(rgba, width, height, {quality: 90});
  assert.deepEqual(bytes, encode(rgba, width, height, {quality: 90}));
  assert.equal(requested, 0);
});
