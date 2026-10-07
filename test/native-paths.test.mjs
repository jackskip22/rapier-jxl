// SPDX-License-Identifier: MIT
// Native samples have one checked coding path through scalar, progressive, photographic and worker entry points.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {encode, encodeSteps} from '../src/index.mjs';
import {encode as effortEncode, encodeSteps as effortSteps} from '../src/effort.mjs';
import {encodePhoto} from '../src/photo.mjs';
import {encodePhoto as photoAns} from '../src/photo-ans.mjs';
import {encodePool} from '../src/pool.mjs';
import {configureKernels} from '../src/kernels.mjs';
import {integerFixture, floatFixture} from './high-depth-fixtures.mjs';
import {nativeDecoder} from './native-decoder.mjs';
import {jxlRsDecoder} from './jxl-rs-decoder.mjs';
import {spawnNode} from './pool-node.mjs';
import {encodeLossless, encodeLossy} from '../src/writer.mjs';

const raw = data => new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
const same = (actual, expected, label) => assert.equal(Buffer.compare(raw(actual), raw(expected)), 0, label);
const finish = job => { for (const _ of job); return job.bytes; };

test('native sample declarations refuse a mismatched representation before encoding', () => {
  for (const [data, options] of [
    [new Uint8Array(4), {bitDepth: 10}], [new Uint16Array(4), {bitDepth: 8}],
    [new Float32Array(4), {bitDepth: 16}], [new Uint16Array(4), {sampleFormat: 'float32'}],
    [new Float32Array(4), {sampleFormat: 'uint'}], [new Uint8Array(4), {sampleFormat: 'float16'}],
    [new Uint16Array([0, 1024, 0, 1023]), {bitDepth: 10}], [new Uint16Array(4), {bitDepth: 11}],
    [new Uint16Array(4), {transferFunction: 'unknown'}], [new Uint16Array(4), {intensityTarget: Infinity}],
    [new Float32Array(4), {alphaPremultiplied: 1}],
  ]) for (const door of [encode, effortEncode, encodePhoto, photoAns]) assert.throws(() => door(data, 1, 1, options), {code: 'JXL_INPUT'});
});

test('all native-precision doors retain source views and use the same completed representation', async () => {
  const pictures = [integerFixture(12, 257, 3), floatFixture({width: 257, height: 3, special: true}), floatFixture({half: true, width: 257, height: 3})];
  for (const picture of pictures) {
    const {width, height, options} = picture, Sample = picture.data.constructor;
    const storage = new Sample(picture.data.length + 8); raw(storage).set(raw(picture.data), 4 * storage.BYTES_PER_ELEMENT);
    const data = storage.subarray(4, storage.length - 4), before = raw(storage).slice();
    for (const quality of [100, 50]) {
      const asked = {...options, quality}, expected = encode(data, width, height, asked);
      same(finish(encodeSteps(data, width, height, asked)), expected, 'core steps');
      same(effortEncode(data, width, height, asked), expected, 'effort 1');
      same(encodePhoto(data, width, height, asked), expected, 'photo');
      same(photoAns(data, width, height, asked), expected, 'photo ANS');
      same((quality === 100 ? encodeLossless : encodeLossy)(data, width, height, asked), expected, 'writer pixel primitives');
      for (const effort of [1, 2, 9]) {
        const options = {...asked, effort}, scalar = effortEncode(data, width, height, options);
        same(finish(effortSteps(data, width, height, options)), scalar, 'effort steps');
        configureKernels('auto');
        try { same(effortEncode(data, width, height, options), scalar, 'optional kernels'); } finally { configureKernels('off'); }
        for (const workers of [1, 2, 4]) {
          const job = encodePool(data, width, height, options, {spawn: spawnNode, workers});
          let previous = 0; for await (const done of job) { assert.ok(done >= previous && done <= 1); previous = done; }
          assert.equal(previous, 1); same(job.bytes, scalar, 'pool sample bits and deterministic groups');
        }
      }
    }
    same(raw(storage), before, 'the caller owns every input word and the view borders');
  }
});

test('native hurry returns the exact completed floor and a failed pool retains all sample words', async () => {
  const {data, width, height, options} = integerFixture(16, 257, 9), floor = encode(data, width, height, options);
  const hurried = effortSteps(data, width, height, {...options, effort: 9, quality: 50}); hurried.hurry = true;
  same(finish(hurried), floor, 'hurry during the first candidate');
  const asked = {...options, effort: 2}, expected = effortEncode(data, width, height, asked);
  const pool = encodePool(data, width, height, asked, {spawn: () => { throw Error('worker unavailable'); }, workers: 2});
  for await (const _ of pool); same(pool.bytes, expected, 'the caller completes a failed native pool');
});

test('quantised native RGB obeys source-domain error bounds and alpha remains bit-exact', async t => {
  if (!process.env.JXL_FUZZ_NATIVE) return t.skip('native libjxl is unavailable (set JXL_FUZZ_NATIVE)');
  const integer = integerFixture(16, 65, 33), floating = {...integer, data: new Float32Array(integer.data.length), options: {}};
  for (let i = 0; i < floating.data.length; i++) floating.data[i] = i % 4 === 3 ? integer.data[i] / 65535 : (integer.data[i] - 30000) / 1000;
  const rs = jxlRsDecoder();
  for (const picture of [integer, floating]) for (const quality of [90, 50, 1]) {
    const {data, width, height, options} = picture, float = data instanceof Float32Array;
    const bytes = encode(data, width, height, {...options, quality}), precision = float ? 23 : 15;
    const drop = Math.floor((100 - quality) * precision / 100), step = 1 << drop;
    for (const open of [nativeDecoder, ...(rs ? [options => rs.persistent(options)] : [])]) {
      const oracle = await open({format: float ? 'float32' : 'uint16', source: true});
      try {
        const actual = await oracle.decode(bytes, width, height);
        const sourceWords = float ? new Uint32Array(data.buffer) : data, actualWords = float ? new Uint32Array(actual.buffer) : actual;
        for (let i = 0; i < data.length; i++) {
          if (i % 4 === 3) assert.equal(actualWords[i], sourceWords[i], 'exact alpha');
          else {
            const bound = float ? Math.max(Math.abs(data[i]), 1.1754943508222875e-38) * step / 16777216 : step / 2;
            assert.ok(Math.abs(actual[i] - data[i]) <= bound, `quality ${quality}, sample ${i}: ${actual[i]} vs ${data[i]}, bound ${bound}`);
          }
        }
      } finally { await oracle.close(); }
    }
  }
});
