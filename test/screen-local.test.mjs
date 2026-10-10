// SPDX-License-Identifier: MIT
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {complete} from '../src/bits.mjs';
import {inspectPixels} from '../src/lossless.mjs';
import {localScreenSteps} from '../src/screen-local.mjs';
import {screenSteps} from '../src/screen-search.mjs';
import {encode} from '../src/effort.mjs';
import {encodePool} from '../src/pool.mjs';
import {spawnNode} from './pool-node.mjs';
import {configureKernels, kernelMode} from '../src/kernels.mjs';
import {kernelHooks} from '../src/kernel-hooks.mjs';
import {SIMD_PROBE} from '../src/kernels-bytes.mjs';
import {decoder} from './decoder.mjs';
import {djxlDecoder} from './djxl-decoder.mjs';
import {rgbaOf} from './oracles.mjs';
const decode = await decoder();
const supportsSIMD = typeof WebAssembly === 'object' && WebAssembly.validate(Uint8Array.from(atob(SIMD_PROBE), c => c.charCodeAt(0)));
function picture(width, height, grey = false) {
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const value = ((x % 41) + (y % 7) * 41) % 257, r = value & 255;
    rgba.set([r, grey ? r : value * 3 & 255, grey ? r : value * 7 & 255, x % 3 ? 231 : 0], (y * width + x) * 4);
  }
  return {rgba, width, height};
}
const candidate = (p, options) => localScreenSteps(p.rgba, p.width, p.height,
  inspectPixels(p.rgba, p.width, p.height), 'srgb', options);

test('local transform groups preserve pixels and bytes across predictor backends', {skip: !decode}, async t => {
  const previous = kernelMode(), native = await djxlDecoder();
  t.after(async () => { configureKernels(previous); await native?.close(); });
  for (const p of [picture(1, 19, true), picture(39, 23), picture(1053, 11)]) {
    const source = p.rgba.slice();
    for (const dim of [256, 512, 1024]) {
      configureKernels('off');
      const options = {dim, depths: [64, 256]}, first = complete(candidate(p, options));
      assert.deepEqual(rgbaOf(decode(first)), p.rgba);
      assert.deepEqual(complete(candidate(p, options)), first);
      if (native) {
        const image = await native.decode(first, p.width, p.height);
        assert.deepEqual(rgbaOf({...image, data: Uint8Array.from(image.data, v => Math.round(v * 255))}), p.rgba);
      }
      for (const mode of ['scalar', ...(supportsSIMD ? ['simd'] : [])]) {
        assert.equal(configureKernels(mode), mode);
        const screen = kernelHooks.screen; let calls = 0;
        kernelHooks.screen = (...args) => { const used = screen(...args); calls += Number(used); return used; };
        assert.deepEqual(complete(candidate(p, options)), first);
        assert.ok(calls, 'copy search uses the accelerated backend');
      }
      configureKernels('off');
      const stopped = candidate(p, options);
      assert.equal(stopped.next().done, false);
      assert.equal(stopped.next(true).value, null);
      assert.equal(complete(candidate(p, {...options, ceiling: first.length})), null);
      assert.deepEqual(complete(candidate(p, {...options, ceiling: first.length + 1})), first);
    }
    assert.deepEqual(p.rgba, source);
  }
});

test('screen effort retains lower candidates through helpers and hurry', {skip: !decode}, async () => {
  const p = picture(1053, 11), source = p.rgba.slice(), shape = inspectPixels(p.rgba, p.width, p.height);
  let previous = Infinity;
  for (const effort of [7, 8, 9]) {
    const bytes = complete(screenSteps(p.rgba, p.width, p.height, shape, 'srgb', {effort}));
    assert.ok(bytes.length <= previous); previous = bytes.length;
    assert.deepEqual(rgbaOf(decode(bytes)), p.rgba);
  }
  const options = {effort: 9}, alone = encode(p.rgba, p.width, p.height, options);
  for (const variant of [{workers: 1}, {workers: 2, crashAt: 1}, {workers: 2, hurry: true}]) {
    const job = encodePool(p.rgba, p.width, p.height, options,
      {workers: variant.workers, spawn: () => spawnNode({crashAt: variant.crashAt})});
    for await (const progress of job) if (variant.hurry && progress > 0.5) job.hurry = true;
    assert.deepEqual(rgbaOf(decode(job.bytes)), p.rgba);
    if (!variant.hurry) assert.deepEqual(job.bytes, alone);
  }
  assert.deepEqual(p.rgba, source);
});

test('rich-palette efforts retain exact hidden colour and the lower returned byte floor', {skip: !decode}, async t => {
  const width = 64, height = 48, rgba = new Uint8Array(width * height * 4), native = await djxlDecoder();
  t.after(() => native?.close());
  for (let i = 0; i < width * height; i++) rgba.set([i & 255, i >> 8, i * 13 & 255, i & 1 ? 0 : 231], i * 4);
  const source = rgba.slice();
  let previous = Infinity;
  for (const effort of [7, 8, 9]) {
    const bytes = encode(rgba, width, height, {effort});
    assert.ok(bytes.length <= previous, 'higher effort retains the lower complete stream'); previous = bytes.length;
    assert.deepEqual(rgbaOf(decode(bytes)), rgba);
    if (native) {
      const image = await native.decode(bytes, width, height);
      assert.deepEqual(rgbaOf({...image, data: Uint8Array.from(image.data, v => Math.round(v * 255))}), rgba);
    }
  }
  assert.deepEqual(rgba, source);
});

test('local candidate allocation failure cannot replace the completed stream floor', () => {
  const p = picture(39, 23), source = p.rgba.slice(), hook = kernelHooks.screen;
  try {
    kernelHooks.screen = () => { throw new RangeError('allocation refused'); };
    assert.equal(complete(candidate(p)), null);
  } finally { kernelHooks.screen = hook; }
  assert.deepEqual(p.rgba, source);
});
