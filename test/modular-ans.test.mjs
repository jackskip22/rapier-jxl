// SPDX-License-Identifier: MIT
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {BitWriter, complete} from '../src/bits.mjs';
import {writeImageHeader, writeModularFrameHeader, assembleCodestream} from '../src/frame.mjs';
import {ALPHABET, leaf, writeTree, writeModularHeader} from '../src/modular.mjs';
import {writeModularAnsHistograms} from '../src/ans.mjs';
import {sampledSteps, SAMPLE_RUNGS} from '../src/sampled.mjs';
import {inspectPixels} from '../src/lossless.mjs';
import {borderCase, pixelCase} from './fuzz-cases.mjs';
import {decoder} from './decoder.mjs';
import {rgbaOf} from './oracles.mjs';

const decode = await decoder(), skip = decode ? undefined : 'jxl-oxide-wasm is not installed';

test('Modular ANS retains exact pixels and the prefix floor across group boundaries', {skip}, () => {
  let wins = 0;
  for (const p of [borderCase(1, 1), borderCase(1025, 3), borderCase(3, 1025), pixelCase(20261008, 13)]) {
    const shape = inspectPixels(p.rgba, p.width, p.height);
    const encode = (ans, hybrid = false) => complete(sampledSteps(p.rgba, p.width, p.height, shape, undefined, {...SAMPLE_RUNGS.deep, ans, hybrid}, false));
    const prefix = encode(false), selected = encode(true), projected = encode(true, true);
    assert.ok(selected.length <= prefix.length, 'complete section selection preserves the prefix floor');
    assert.ok(projected.length <= selected.length, 'integer configuration search preserves the preceding stream');
    if (projected.length < prefix.length) wins++;
    assert.deepEqual(encode(true, true), projected, 'deterministic stream');
    for (const bytes of [selected, projected]) assert.deepEqual(rgbaOf(decode(bytes)), p.rgba, 'all RGBA samples, including hidden RGB');
  }
  assert.ok(wins > 0, 'ANS wins a complete stream');
});

test('Modular ANS decodes a maximum-group copy with symbol 255 and 19 raw bits', {skip}, () => {
  const width = 1024, height = 1024, header = new BitWriter(), global = new BitWriter(), tree = leaf(5);
  writeImageHeader(header, width, height, 1, false);
  writeModularFrameHeader(header, {alpha: false, shift: 3});
  global.write(1, 1); global.write(1, 1);
  const frequencies = new Uint32Array(ALPHABET); frequencies[0] = frequencies[255] = 1;
  const write = writeModularAnsHistograms(global, writeTree(global, tree), [frequencies]);
  writeModularHeader(global);
  write([{leaves: [tree], used: 2, token: new Uint16Array([0, 255]),
    bits: new Uint8Array([0, 19]), extra: new Uint32Array([0, width * height - 8 - (1 << 19)]), context: new Uint8Array(2)}]);
  const decoded = decode(assembleCodestream(header, [global.finish()]));
  assert.equal(decoded.width, width); assert.equal(decoded.height, height); assert.equal(decoded.channels, 1);
  assert.ok(decoded.data.every(value => value === 0));
});
