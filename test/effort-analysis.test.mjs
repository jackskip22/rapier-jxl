// SPDX-License-Identifier: MIT
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {gunzipSync} from 'node:zlib';
import {complete} from '../src/bits.mjs';
import {encode as coreEncode} from '../src/index.mjs';
import {encode, encodeSteps} from '../src/effort.mjs';
import {effortJob} from '../src/effort-job.mjs';
import {inspectPixels, losslessSteps, planeFill} from '../src/lossless.mjs';
import {groupLayout, groupRect, GROUP_DIM} from '../src/frame.mjs';
import {ALPHABET, leaf, codeChannel} from '../src/modular.mjs';
import {colourTransform} from '../src/rct-search.mjs';
import {SAMPLE_RUNGS, sampledSteps, sampleTransformRanking} from '../src/sampled.mjs';
import {borderCase} from './fuzz-cases.mjs';
import {integerFixture} from './high-depth-fixtures.mjs';
import {decoder} from './decoder.mjs';
import {rgbaOf} from './oracles.mjs';

const decode = await decoder();
const same = (a, b) => Buffer.compare(a, b) === 0;

test('reused direct analysis retains the original token projection across group and alpha boundaries', () => {
  const alpha = borderCase(263, 19);
  for (let i = 0; i < alpha.width * alpha.height; i++) alpha.rgba[i * 4 + 3] = i * 7 & 255;
  for (const p of [borderCase(1, 257), borderCase(257, 1), alpha]) {
    const analysis = {}, shape = inspectPixels(p.rgba, p.width, p.height);
    const bytes = complete(losslessSteps(p.rgba, p.width, p.height, {shape, analysis}));
    assert.ok(same(bytes, coreEncode(p.rgba, p.width, p.height)), 'collecting analysis preserves the core stream');
    const {first, freqs} = analysis.direct, planes = Array.from({length: shape.channels}, () => new Int16Array(GROUP_DIM * GROUP_DIM));
    const expected = planes.map(() => new Uint32Array(ALPHABET)), fill = planeFill({...shape, palette: null});
    const layout = groupLayout(p.width, p.height);
    for (let g = 0; g < layout.groupsX * layout.groupsY; g++) {
      const [x, y, width, height] = groupRect(layout, p.width, p.height, g);
      fill(planes, p.rgba, p.width, x, y, width, height);
      for (let c = 0; c < shape.channels; c++) codeChannel(null, expected[c], planes[c], width, height, leaf(first[c]));
    }
    assert.deepEqual(freqs, expected, 'the reused histogram uses split-zero residuals and the original zero runs');
  }
});

test('native samples and explicit colour transforms do not populate direct analysis', () => {
  const p = borderCase(17, 13), shape = {...inspectPixels(p.rgba, p.width, p.height), palette: null};
  for (const type of [0, 6, 41]) {
    const analysis = {};
    complete(losslessSteps(p.rgba, p.width, p.height, {shape, rct: colourTransform(type, shape.channels), analysis}));
    assert.equal(analysis.direct, undefined);
  }
  const native = integerFixture(12), analysis = {};
  complete(losslessSteps(native.data, native.width, native.height, {...native.options, analysis}));
  assert.equal(analysis.direct, undefined);
});

test('a pruned learned candidate leaves the later winning model eligible', async () => {
  const rgba = gunzipSync(await readFile(new URL('seeds/hurry-painting.rgba.gz', import.meta.url))), width = 512, height = 384;
  const shape = inspectPixels(rgba, width, height), previous = encode(rgba, width, height, {effort: 8});
  const run = (options, ceiling = Infinity) => complete(sampledSteps(rgba, width, height, shape, 'srgb', options, false, ceiling));
  assert.notEqual(sampleTransformRanking(rgba, width, height)[0], 6, 'this painting ranks another transform above YCoCg');
  assert.equal(run(SAMPLE_RUNGS.maximum, previous.length), null, 'the incumbent rejects the completed sections of a weaker model');
  const second = run({...SAMPLE_RUNGS.precise, rctType: sampleTransformRanking(rgba, width, height)[1]});
  const final = encode(rgba, width, height, {effort: 9}), smallest = second.length < previous.length ? second : previous;
  assert.ok(final.length <= smallest.length, 'pruning preserves all earlier and later complete models');
  if (decode) assert.ok(same(rgbaOf(decode(final)), rgba), 'the winning model retains every pixel');
  // Read the real helper request rather than duplicating effort-profile definitions.
  // Every listed buffer is a complete candidate, not a length-only allowance.
  const completed = [coreEncode(rgba, width, height), previous, final];
  for (const step of effortJob(rgba, width, height, {effort: 9}, false, true)) if (step?.kind === 'candidates') {
    completed.push(...step.rungs.map(rung => run(rung)));
    break;
  }
  // Interrupted output must be a complete candidate, independent of its progress fraction.
  for (const from of [0.85, 1]) {
    const job = encodeSteps(rgba, width, height, {effort: 9});
    for (const done of job) if (from === 1 ? done === 1 : done > from) job.hurry = true;
    assert.ok(from === 1 ? same(job.bytes, final) : completed.some(bytes => same(job.bytes, bytes)), 'hurry retains a complete candidate');
    if (decode) assert.ok(same(rgbaOf(decode(job.bytes)), rgba), 'hurried output retains every pixel');
  }
});

test('every effort retains the preceding complete stream and exact pixels', {skip: decode ? undefined : 'jxl-oxide-wasm is not installed'}, async () => {
  const pictures = [borderCase(1, 257), borderCase(257, 17),
    {rgba: new Uint8Array(await readFile(new URL('seeds/hurry-inner.rgba', import.meta.url))), width: 96, height: 64},
    {rgba: new Uint8Array(await readFile(new URL('seeds/local-palette.rgba', import.meta.url))), width: 600, height: 19}];
  for (const p of pictures) {
    const floor = coreEncode(p.rgba, p.width, p.height);
    let previous = floor;
    for (let effort = 1; effort <= 9; effort++) {
      const bytes = encode(p.rgba, p.width, p.height, {effort});
      assert.ok(bytes.length <= previous.length, `${p.width}x${p.height}, effort ${effort}: preceding stream remains eligible`);
      assert.ok(same(rgbaOf(decode(bytes)), p.rgba), `${p.width}x${p.height}, effort ${effort}: exact pixels`);
      if (effort === 1) assert.ok(same(bytes, floor));
      previous = bytes;
    }
    const hurried = encodeSteps(p.rgba, p.width, p.height, {effort: 9});
    hurried.hurry = true;
    for (const _ of hurried);
    assert.ok(same(hurried.bytes, floor), 'an immediate hurry retains the complete core floor');
  }
});
