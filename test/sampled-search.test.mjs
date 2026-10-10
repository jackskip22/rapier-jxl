// SPDX-License-Identifier: MIT
// Deterministic sampled streams and decoder conformance for retained edge cases.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {complete} from '../src/bits.mjs';
import {inspectPixels} from '../src/lossless.mjs';
import {sampledSteps, SAMPLE_RUNGS} from '../src/sampled.mjs';
import {configureKernels} from '../src/kernels.mjs';
import {kernelHooks} from '../src/kernel-hooks.mjs';
import {decoder} from './decoder.mjs';
import {djxlDecoder} from './djxl-decoder.mjs';
import {rgbaOf} from './oracles.mjs';
import {searchPictures, searchRungs} from './sampled-search-cases.mjs';

const expected = JSON.parse(readFileSync(new URL('seeds/sampled-search.json', import.meta.url), 'utf8'));

for (const p of searchPictures()) test(`every sampled rung writes its recorded stream for the ${p.name} picture`, () => {
  const shape = inspectPixels(p.rgba, p.width, p.height);
  const actual = {};
  for (const [name, rung] of Object.entries(searchRungs(p.rgba, p.width, p.height))) {
    const bytes = complete(sampledSteps(p.rgba, p.width, p.height, shape, 'srgb', rung, false));
    actual[name] = bytes ? createHash('sha256').update(bytes).digest('hex') + ' ' + bytes.length : null;
  }
  assert.deepEqual(actual, expected[p.name]);
});

// The maximum sample count crosses the u32 entropy-table boundary. Zero alpha
// retains authored RGB, and the odd edges exercise a full sample with tails.
test('available sampled kernels preserve maximum samples and hidden RGBA', async t => {
  const width = 257, height = 257, rgba = new Uint8Array(width * height * 4);
  let state = 20261009;
  for (let y = 0, at = 0; y < height; y++) for (let x = 0; x < width; x++, at += 4) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    rgba.set([(x * 3 + (state >>> 28)) & 255, (y * 5 + (state >>> 27)) & 255,
      ((x + y) * 2 + (state >>> 29)) & 255, x % 13 ? 255 - (y & 31) : 0], at);
  }
  const source = rgba.slice(), shape = inspectPixels(rgba, width, height), outputs = [];
  try {
    for (const mode of ['off', 'scalar', 'simd']) {
      if (configureKernels(mode) !== mode) { t.diagnostic(mode + ' unavailable; not verified'); continue; }
      let accepted = 0, maximum = 0;
      if (mode !== 'off') {
        const search = kernelHooks.sampled;
        kernelHooks.sampled = (...args) => { const result = search(...args); assert.notEqual(result, false); accepted++; maximum = Math.max(maximum, args[0].length); return result; };
      }
      outputs.push(complete(sampledSteps(rgba, width, height, shape, 'srgb', SAMPLE_RUNGS.precise, false)));
      if (mode !== 'off') { assert.ok(accepted > 0, 'the byte comparison exercised the sampled kernel'); assert.equal(maximum, 65536, 'maximum sample count crosses the u32 entropy boundary'); }
    }
    for (const bytes of outputs.slice(1)) assert.deepEqual(bytes, outputs[0]);
    const decode = await decoder();
    if (decode) assert.deepEqual(rgbaOf(decode(outputs[0])), rgba);
    assert.deepEqual(rgba, source);
  } finally { configureKernels('off'); }
});

// Flat black regions tie predictors; the ramp and alternating tail give spatial
// splits useful work. Repeated neighbour values reuse bins across those regions,
// while a partition leaves gaps in the original spatial-bin range. Single rows
// and columns keep the 23/24/25-pixel regions at exact sample-count boundaries.
test('available sampled kernels preserve bytes at tied regions and small split boundaries', async t => {
  const decode = await decoder();
  try {
    for (const boundary of [23, 24, 25]) for (const vertical of [false, true]) {
      const length = boundary + 192, width = vertical ? 1 : length, height = vertical ? length : 1;
      const rgba = new Uint8Array(length * 4), label = `${boundary}-pixel flat region/${vertical ? 'column' : 'row'}`;
      for (let i = 0; i < length; i++) {
        const value = i < boundary ? 0 : i < boundary + 96 ? 16 + 2 * (i - boundary) : ((i - boundary - 96) & 1) ? 208 : 16;
        rgba.set([value, value, value, 255], i * 4);
      }
      const source = rgba.slice(), shape = inspectPixels(rgba, width, height);
      let expectedBytes;
      for (const mode of ['off', 'scalar', 'simd']) {
        if (configureKernels(mode) !== mode) { t.diagnostic(mode + ' unavailable; not verified'); continue; }
        let accepted = 0;
        if (mode !== 'off') {
          const search = kernelHooks.sampled;
          kernelHooks.sampled = (...args) => { const result = search(...args); if (result !== false) accepted++; return result; };
        }
        const bytes = complete(sampledSteps(rgba, width, height, shape, 'srgb', SAMPLE_RUNGS.precise, false));
        assert.ok(bytes?.length, label + ': complete stream');
        if (mode === 'off') expectedBytes = bytes;
        else {
          assert.ok(accepted > 0, label + '/' + mode + ': sampled kernel used');
          assert.deepEqual(bytes, expectedBytes, label + '/' + mode + ': exact encoded bytes');
        }
        assert.deepEqual(rgba, source, label + '/' + mode + ': source unchanged');
      }
      if (decode) assert.deepEqual(rgbaOf(decode(expectedBytes)), source, label + ': exact decoded RGBA');
    }
  } finally { configureKernels('off'); }
});

// Reference boundaries must not leave impossible spatial branches in the interior tree.
test('reference-guard trees preserve hidden RGBA in both decoders', async t => {
  const native = await djxlDecoder();
  if (!native) { t.skip('JXL_DJXL is not configured'); return; }
  try {
    const decode = await decoder();
    if (!decode) { t.skip('jxl-oxide-wasm is not installed'); return; }
    const picture = searchPictures().find(p => p.name === 'screen'), {rgba, width, height} = picture;
    const options = searchRungs(rgba, width, height).ranked, shape = inspectPixels(rgba, width, height);
    const bytes = complete(sampledSteps(rgba, width, height, shape, 'srgb', options, false));
    assert.deepEqual(rgbaOf(decode(bytes)), rgba);
    const image = await native.decode(bytes, width, height);
    assert.deepEqual(rgbaOf({...image, data: Uint8Array.from(image.data, value => Math.round(value * 255))}), rgba);
  } finally { await native.close(); }
});
