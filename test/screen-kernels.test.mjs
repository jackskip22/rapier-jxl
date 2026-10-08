// SPDX-License-Identifier: MIT
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {screenModel, writeScreenModel} from '../src/screen-lz77.mjs';
import {encodeScreen} from '../src/screen.mjs';
import {inspectPixels} from '../src/lossless.mjs';
import {BitWriter} from '../src/bits.mjs';
import {codeWeighted} from '../src/weighted.mjs';
import {configureKernels} from '../src/kernels.mjs';
import {kernelHooks} from '../src/kernel-hooks.mjs';
import {SIMD_PROBE} from '../src/kernels-bytes.mjs';
import {decoder} from './decoder.mjs';
import {rgbaOf} from './oracles.mjs';

const modes = ['off', 'scalar', 'simd'];
const supportsSIMD = typeof WebAssembly === 'object' && WebAssembly.validate(Uint8Array.from(atob(SIMD_PROBE), c => c.charCodeAt(0)));
const use = mode => assert.equal(configureKernels(mode), mode);
const decode = await decoder();

test('screen kernels preserve complete group histories, residual boundaries and exact model bits', {skip: !supportsSIMD}, () => {
  let state = 173;
  const random = () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return state >>> 0; };
  try {
    for (const [width, height, pattern] of [
      [1, 17, 'signed'], [17, 1, 'signed'], [31, 33, 'signed'], [257, 257, 'signed'],
      [1024, 1024, 'rows'], [64, 16384, 'rows'], [16384, 1, 'zeros'], [3, 5, 'signed'],
    ]) {
      const storage = new Int16Array(width * height + 8).fill(-32768), plane = storage.subarray(4, -4);
      for (let i = 0; i < plane.length; i++) plane[i] = pattern === 'signed' ? (random() & 65535) - 32768
        : pattern === 'zeros' ? 0 : (i % width * 31 + ((i / width | 0) % 17 === 0 ? i / width | 0 : 0)) & 255;
      const before = storage.slice(), results = [];
      for (const mode of modes) {
        use(mode);
        if (mode !== 'off') {
          const real = kernelHooks.screen;
          kernelHooks.screen = (...args) => { const took = real(...args); assert.equal(took, true); return took; };
        }
        const model = screenModel(plane, width, height), writer = new BitWriter(16);
        writeScreenModel(writer, [model])();
        results.push({model, bytes: writer.finish()});
      }
      assert.deepEqual(results[1], results[0], `${width}x${height}/${pattern}/scalar`);
      assert.deepEqual(results[2], results[0], `${width}x${height}/${pattern}/simd`);
      assert.deepEqual(storage, before, 'source samples and subarray borders');
    }
    // Growing the shared arena must refresh the views used by other kernels and
    // leave their low-memory division, error-bucket and weight tables intact.
    const plane = Int16Array.from({length: 31 * 33}, () => (random() & 65535) - 32768), results = [];
    for (const mode of modes) {
      use(mode);
      const histogram = new Uint32Array(257), residuals = new Uint32Array(plane.length), properties = new Int32Array(plane.length);
      codeWeighted(null, [histogram], plane, 31, 33, -3, undefined, residuals, properties);
      results.push({histogram, residuals, properties});
    }
    assert.deepEqual(results[1], results[0]); assert.deepEqual(results[2], results[0]);
  } finally { configureKernels('off'); }
});

test('screen copy ties keep the nearer distance and native planes fall back before emitting', {skip: !supportsSIMD}, () => {
  const plane = Int16Array.from([1,2,3,4,5,6,7,99,1,2,3,4,5,6,7,98,1,2,3,4,5,6,7,97]);
  const expected = [...[2,4,6,8,10,12,14,198].map(value => [value,0,0]), [0,7,8], [196,0,0], [0,7,8], [194,0,0]];
  try {
    for (const mode of modes.slice(1)) {
      use(mode);
      const pieces = [];
      assert.equal(kernelHooks.screen(plane, 8, 3, 0, 4, (...piece) => pieces.push(piece)), true);
      assert.deepEqual(pieces, expected);
      const emit = () => assert.fail('declined screen kernel emitted a token');
      assert.equal(kernelHooks.screen(new Int32Array(24), 8, 3, 0, 4, emit), false);
      assert.equal(kernelHooks.screen(plane, 8, 4, 0, 4, emit), false);
      assert.equal(kernelHooks.screen(new Int16Array(1048577), 1, 1048577, 0, 4, emit), false);
    }
  } finally { configureKernels('off'); }
});

test('screen kernel streams decode source RGB beneath zero alpha across full and partial groups', {skip: !decode || !supportsSIMD}, () => {
  const width = 1025, height = 1024, rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const ink = x % 19 >= 3 && x % 19 < 10 && y % 23 >= 5 && y % 23 < 16;
    rgba.set(ink ? [40, 60, 80, 0] : [240, 235, 230, 200], (y * width + x) * 4);
  }
  const before = rgba.slice(), shape = inspectPixels(rgba, width, height), outputs = [];
  try {
    for (const mode of modes) {
      use(mode);
      const bytes = encodeScreen(rgba, width, height, shape, undefined, {mode: 'direct', search: {}});
      outputs.push(bytes);
      assert.deepEqual(rgbaOf(decode(bytes)), rgba, mode + ': exact source RGBA');
    }
    assert.deepEqual(outputs[1], outputs[0]); assert.deepEqual(outputs[2], outputs[0]);
    assert.deepEqual(rgba, before);
  } finally { configureKernels('off'); }
});

test('screen arena allocation failure retains the exact JavaScript model', {skip: !supportsSIMD}, () => {
  const source = `import assert from 'node:assert/strict';
    import {screenModel} from ${JSON.stringify(new URL('../src/screen-lz77.mjs', import.meta.url).href)};
    import {configureKernels} from ${JSON.stringify(new URL('../src/kernels.mjs', import.meta.url).href)};
    import {kernelHooks} from ${JSON.stringify(new URL('../src/kernel-hooks.mjs', import.meta.url).href)};
    const plane = new Int16Array(512 * 512).fill(-7), expected = screenModel(plane, 512, 512);
    assert.equal(configureKernels('scalar'), 'scalar');
    const grow = WebAssembly.Memory.prototype.grow;
    try {
      WebAssembly.Memory.prototype.grow = function() { throw new RangeError('unavailable'); };
      assert.equal(kernelHooks.screen(plane, 512, 512, 0, 4, () => assert.fail('partial emit')), false);
      assert.deepEqual(screenModel(plane, 512, 512), expected);
    } finally { WebAssembly.Memory.prototype.grow = grow; configureKernels('off'); }`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', source], {encoding: 'utf8'});
  assert.equal(child.status, 0, child.stderr);
});
