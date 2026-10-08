// SPDX-License-Identifier: MIT
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {encode} from '../src/index.mjs';
import {admitSampleFormat} from '../src/admit.mjs';
import {encodeLossless, inspectPixels} from '../src/lossless.mjs';
import {assembleCodestream} from '../src/frame.mjs';
import {BitWriter, LIMITS, float16Bits} from '../src/bits.mjs';
import {integerFixture, floatFixture} from './high-depth-fixtures.mjs';
import {djxlDecoder} from './djxl-decoder.mjs';

test('binary16 fields preserve signs and round halfway values to the even significand', () => {
  // Format goldens include underflow, subnormal/normal and exponent carries, and the finite ceiling.
  const cases = [
    [0, 0], [2 ** -25, 0], [2 ** -24, 1], [3 * 2 ** -25, 2],
    [(1022.5) * 2 ** -24, 0x03fe], [(1023.5) * 2 ** -24, 0x0400],
    [1 + 2 ** -11, 0x3c00], [1 + 3 * 2 ** -11, 0x3c02],
    [2 - 2 ** -11, 0x4000], [255.0625, 0x5bf8], [255.1875, 0x5bfa],
    [65504, 0x7bff], [65519, 0x7bff],
  ];
  for (const [value, word] of cases) {
    assert.equal(float16Bits(value), word, String(value));
    assert.equal(float16Bits(-value), word | 0x8000, String(-value));
  }
  for (const value of [65520, -65520, Infinity, -Infinity, NaN]) assert.throws(() => float16Bits(value));
});

function codestream(bytes, level) {
  if (level === 5) { assert.equal(bytes[0], 255); assert.equal(bytes[1], 10); return bytes; }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  assert.deepEqual(bytes.subarray(0, 12), Uint8Array.from([0,0,0,12,74,88,76,32,13,10,135,10]));
  assert.equal(view.getUint32(12), 20);
  assert.equal(Buffer.from(bytes.subarray(16, 32)).toString('hex'), '667479706a786c20000000006a786c20');
  assert.equal(view.getUint32(32), 9);
  assert.equal(Buffer.from(bytes.subarray(36, 41)).toString('hex'), '6a786c6c0a');
  assert.equal(view.getUint32(41), bytes.length - 41);
  assert.equal(Buffer.from(bytes.subarray(45, 49)).toString('ascii'), 'jxlc');
  assert.equal(bytes[49], 255); assert.equal(bytes[50], 10);
  return bytes.subarray(49);
}

test('native lossless payloads retain every coded byte and declare the required modular level', () => {
  const pictures = [
    [integerFixture(10), 5, 'c90e1365b92e3e113a3f052d8506a71d08060264c79fa6347dc26e9685a996fc'],
    [integerFixture(12), 5, '4e72dceb149b12855c6159f5da8a36bd0f74676b7e8bb0bbb9475e63f293b251'],
    [integerFixture(16), 10, '7f98c1cb4751f68ff966266f7b4ec003e4c9653d63cdca0177982780605638eb'],
    [floatFixture({half: true}), 10, 'c927fcda1b497774aeb4391191501a380272f5fcd854e3d703b9ac9df8481e6a'],
    [floatFixture(), 10, '171144555b65e4c5e66aeae9f84d3dd4db2e391fc41193e8334ae321154e4319'],
  ];
  for (const [picture, level, hash] of pictures) {
    const {data, width, height, options} = picture, bytes = encode(data, width, height, options);
    assert.equal(createHash('sha256').update(codestream(bytes, level)).digest('hex'), hash);
  }
});

test('the output limit includes level declaration and container boxes', () => {
  // A one-section TOC of this size occupies five bytes before the section.
  const sections = [new Uint8Array(LIMITS.bytes - 5)];
  assert.throws(() => assembleCodestream(new BitWriter(), sections, 10), {code: 'JXL_SIZE'});
});

function integerRGBA(image, bitDepth) {
  const maximum = 2 ** bitDepth - 1, out = new Uint16Array(image.width * image.height * 4), channels = image.channels;
  for (let p = 0; p < image.width * image.height; p++) for (let c = 0; c < 4; c++) {
    const source = c === 3 ? channels % 2 === 0 ? image.data[p * channels + channels - 1] : 1
      : image.data[p * channels + (channels < 3 ? 0 : c)];
    out[p * 4 + c] = Math.round(source * maximum);
  }
  return out;
}

test('integer grid leaves preserve quantized RGB and source alpha through libjxl 0.12', {skip: !process.env.JXL_DJXL}, async () => {
  const oracle = await djxlDecoder();
  try {
    for (const bitDepth of [10, 12, 16]) for (const drop of [1, 2, bitDepth - 2]) for (const gray of [false, true]) {
      const picture = integerFixture(bitDepth, 257, 9), {data, width, height, options} = picture;
      if (gray) for (let i = 0; i < data.length; i += 4) data[i + 1] = data[i + 2] = data[i];
      const before = data.slice(), step = 2 ** drop, expected = Uint16Array.from(data, (value, i) => i % 4 === 3 ? value : Math.floor(value / step) * step + step / 2);
      const samples = {...admitSampleFormat(data, options), drop}, shape = inspectPixels(data, width, height, {samples, palette: false});
      for (const rct of [undefined, {type: 0}]) {
        const bytes = encodeLossless(data, width, height, {samples, shape, rct});
        const image = await oracle.decode(bytes, width, height);
        assert.deepEqual(integerRGBA(image, bitDepth), expected, `${bitDepth}-bit/drop${drop}/gray${gray}/rct${rct?.type ?? 6}`);
        assert.deepEqual(image.metadata.bits_per_sample, [bitDepth, bitDepth]);
        assert.deepEqual(image.metadata.exp_bits_per_sample, [0, 0]);
      }
      assert.deepEqual(data, before, 'the source remains owned by the caller');
    }
  } finally { await oracle.close(); }
});

test('native quality requests retain their source-domain error bounds and exact alpha', {skip: !process.env.JXL_DJXL}, async () => {
  const oracle = await djxlDecoder();
  try {
    for (const bitDepth of [10, 12, 16]) for (const quality of [1, 2, 50, 90, 99, 100]) {
      const {data, width, height, options} = integerFixture(bitDepth, 65, 33);
      const image = await oracle.decode(encode(data, width, height, {...options, quality}), width, height);
      const decoded = integerRGBA(image, bitDepth), drop = Math.floor((100 - quality) * (bitDepth - 1) / 100), bound = drop ? 2 ** (drop - 1) : 0;
      for (let i = 0; i < data.length; i++) {
        if (i % 4 === 3) assert.equal(decoded[i], data[i], 'exact source alpha');
        else assert.ok(Math.abs(decoded[i] - data[i]) <= bound, `${bitDepth}-bit/q${quality}/sample${i}`);
      }
    }
  } finally { await oracle.close(); }
});

test('level-10 floating files preserve source words and color metadata through libjxl 0.12', {skip: !process.env.JXL_DJXL}, async () => {
  const oracle = await djxlDecoder();
  const halfValue = word => {
    const sign = word & 0x8000 ? -1 : 1, exponent = word >> 10 & 31, fraction = word & 1023;
    return sign * (exponent ? (1 + fraction / 1024) * 2 ** (exponent - 15) : fraction * 2 ** -24);
  };
  try {
    for (const half of [false, true]) for (const [colorSpace, transferFunction, intensityTarget, primaries, transfer] of [
      ['srgb', 'srgb', 255, 1, 13], ['display-p3', 'linear', 400, 12, 8],
      ['rec2020', 'pq', 10000, 9, 16], ['rec2020', 'hlg', 1000, 9, 18],
    ]) {
      const {data, width, height, options} = floatFixture({half});
      const expected = half ? Float32Array.from(data, halfValue) : data;
      const bytes = encode(data, width, height, {...options, colorSpace, transferFunction, intensityTarget, alphaPremultiplied: true});
      codestream(bytes, 10);
      const image = await oracle.decode(bytes, width, height);
      assert.equal(image.channels, 4);
      assert.deepEqual(new Uint32Array(image.data.buffer), new Uint32Array(expected.buffer), 'finite floating source words');
      assert.deepEqual(image.metadata.bits_per_sample, half ? [16, 16] : [32, 32]);
      assert.deepEqual(image.metadata.exp_bits_per_sample, half ? [5, 5] : [8, 8]);
      assert.equal(image.metadata.intensity_target, intensityTarget);
      assert.deepEqual(image.cicp, {primaries, transferFunction: transfer, matrixCoefficients: 0, fullRange: 1});
    }
  } finally { await oracle.close(); }
});
