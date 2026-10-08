// SPDX-License-Identifier: MIT
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {BitWriter, complete} from '../src/bits.mjs';
import {encode} from '../src/effort.mjs';
import {minimumSearchDataBits, searchSteps} from '../src/effort-job.mjs';
import {groupLayout} from '../src/frame.mjs';
import {inspectPixels, losslessSteps} from '../src/lossless.mjs';
import {ALPHABET, LZ77, RESIDUAL_CONFIG} from '../src/modular.mjs';
import {buildCode, hybridToken, writeHybrid} from '../src/prefix.mjs';
import {decoder} from './decoder.mjs';
import {rgbaOf} from './oracles.mjs';

const decode = await decoder();

test('weighted data bounds use the written raw bits, including short copy lengths', () => {
  const scratch = [0, 0, 0];
  for (const [config, base, values] of [
    [RESIDUAL_CONFIG, 0, [0, 1, 2, 3, 255, 256, 511, 512, 1023]],
    [LZ77.lengthConfig, LZ77.minSymbol, [0, 1, 12, 13, 14, 15, 16, 31, 32, 255, 256, 65528]]
  ]) for (const value of values) {
    hybridToken(config, value, scratch);
    const symbol = base + scratch[0], freqs = new Uint32Array(ALPHABET), writer = new BitWriter(32);
    freqs[symbol] = 3;
    const code = buildCode(freqs);
    for (let i = 0; i < freqs[symbol]; i++) writeHybrid(writer, code, config, value, base);
    assert.equal(minimumSearchDataBits(freqs), writer.bitLength, `symbol ${symbol}: one-symbol data cost`);
    if (symbol >= 237 && symbol <= 239) assert.equal(writer.bitLength, 0, 'short copy symbols carry no raw bits');
  }
});

test('partial interval bounds remain below merged prefix data after later tokens', () => {
  const histories = [[0, 1, 3, 13, 14, 15], [0, 2, 13, 31], [1, 15, 16, 255]], scratch = [0, 0, 0];
  const histogram = values => {
    const freqs = new Uint32Array(ALPHABET);
    for (const value of values) { hybridToken(LZ77.lengthConfig, value, scratch); freqs[LZ77.minSymbol + scratch[0]]++; }
    return freqs;
  };
  const bound = histories.reduce((n, values) => n + minimumSearchDataBits(histogram(values)), 0);
  for (const groups of [[[0, 1, 2]], [[0], [1, 2]], [[0], [1], [2]]]) {
    const writer = new BitWriter(128);
    for (const group of groups) {
      const values = group.flatMap(i => [...histories[i], 0, 0, 16, 65528]), code = buildCode(histogram(values));
      for (const value of values) writeHybrid(writer, code, LZ77.lengthConfig, value, LZ77.minSymbol);
    }
    assert.ok(bound <= writer.bitLength, 'future tokens and interval merging cannot invalidate the data bound');
  }
});

test('a completed screen stream rejects weighted counting before all groups', () => {
  const width = 513, height = 300, rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const ink = x % 19 >= 3 && x % 19 < 10 && y % 23 >= 5 && y % 23 < 16;
    rgba.set(ink ? [40, 60, 80, 0] : [240, 240, 240, 200], (y * width + x) * 4);
  }
  const shape = inspectPixels(rgba, width, height), analysis = {};
  complete(losslessSteps(rgba, width, height, {shape, analysis}));
  const floor = encode(rgba, width, height, {effort: 3}), direct = {...shape, palette: null};
  const run = ceiling => {
    const steps = searchSteps(rgba, width, height, direct, 'srgb', 3, false, analysis, ceiling);
    let step, count = 0;
    while (!(step = steps.next()).done) count++;
    return {bytes: step.value, count};
  };
  const full = run(Infinity), pruned = run(floor.length);
  assert.equal(pruned.bytes, null);
  const layout = groupLayout(width, height);
  assert.ok(pruned.count < layout.groupsX * layout.groupsY, 'the complete incumbent rejects before every group is counted');
  assert.deepEqual(run(Infinity), full, 'rejection does not alter a later search');
  assert.deepEqual(encode(rgba, width, height, {effort: 3}), floor, 'the winning screen stream remains deterministic');
  assert.ok(encode(rgba, width, height, {effort: 4}).length <= floor.length, 'later search candidates remain eligible');
  if (decode) assert.deepEqual(rgbaOf(decode(floor)), rgba);
});
