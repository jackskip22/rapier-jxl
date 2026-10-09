// SPDX-License-Identifier: MIT
// Cropped source artwork keeps wide palette indices, partial groups and hidden RGB in the returned streams.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {gunzipSync} from 'node:zlib';
import {complete} from '../src/bits.mjs';
import {inspectPixels} from '../src/lossless.mjs';
import {paletteSteps} from '../src/palette-search.mjs';
import {encode} from '../src/effort.mjs';
import {encodePool} from '../src/pool.mjs';
import {configureKernels, kernelMode} from '../src/kernels.mjs';
import {kernelHooks} from '../src/kernel-hooks.mjs';
import {SIMD_PROBE} from '../src/kernels-bytes.mjs';
import {decoder} from './decoder.mjs';
import {djxlDecoder} from './djxl-decoder.mjs';
import {rgbaOf} from './oracles.mjs';
import {spawnNode} from './pool-node.mjs';

const decode = await decoder();
const picture = name => ({width: 259, height: name === 'globe' ? 129 : 65,
  rgba: new Uint8Array(gunzipSync(readFileSync(new URL('seeds/palette-' + name + '.rgba.gz', import.meta.url))))});
const candidate = (p, options) => paletteSteps(p.rgba, p.width, p.height, inspectPixels(p.rgba, p.width, p.height), 'srgb', options);
const supportsSIMD = typeof WebAssembly === 'object' && WebAssembly.validate(Uint8Array.from(atob(SIMD_PROBE), c => c.charCodeAt(0)));
function exact(bytes, p) {
  const image = decode(bytes);
  assert.equal(image.width, p.width); assert.equal(image.height, p.height);
  assert.deepEqual(rgbaOf(image), p.rgba);
}

test('palette crops retain exact indices and pixels under JavaScript, scalar and SIMD predictors', {skip: !decode}, async t => {
  const previous = kernelMode(), native = await djxlDecoder();
  t.after(async () => { configureKernels(previous); await native?.close(); });
  for (const name of ['globe', 'gamepad']) {
    const p = picture(name), source = p.rgba.slice(), shape = inspectPixels(p.rgba, p.width, p.height);
    if (name === 'globe') assert.ok(shape.palette.colours.length > 768, 'the source crop exceeds the byte lookup domain');
    else assert.ok(p.rgba.some((value, i) => i % 4 < 3 && value && p.rgba[i - i % 4 + 3] === 0), 'source has nonzero hidden RGB');
    configureKernels('off');
    const first = complete(candidate(p)); exact(first, p);
    for (const mode of ['scalar', ...(supportsSIMD ? ['simd'] : [])]) {
      assert.equal(configureKernels(mode), mode, 'the accelerated backend actually runs');
      const weighted = kernelHooks.weighted; let wideCalls = 0;
      kernelHooks.weighted = (...args) => {
        const took = weighted(...args);
        if (took && args[2].some(value => value > 255)) wideCalls++;
        return took;
      };
      assert.deepEqual(complete(candidate(p)), first, mode + ' preserves the complete stream');
      if (name === 'globe') assert.ok(wideCalls, 'wide palette indices reach the weighted kernel');
    }
    if (native) {
      const image = await native.decode(first, p.width, p.height);
      const data = Uint8Array.from(image.data, value => Math.round(value * 255));
      assert.deepEqual(rgbaOf({...image, data}), p.rgba);
    }
    configureKernels('off');
    const interrupted = candidate(p); assert.equal(interrupted.next().done, false);
    assert.equal(interrupted.next(true).value, null, 'an unfinished group set cannot return a stream');
    const last = candidate(p); last.next(); last.next();
    assert.deepEqual(last.next(true).value, first, 'a hurry after the last group retains the complete candidate');
    assert.equal(complete(candidate(p, {ceiling: Math.floor(first.length / 2)})), null);
    assert.deepEqual(complete(candidate(p)), first, 'pruning and integer projection leave later encodes deterministic');
    assert.deepEqual(p.rgba, source);
  }
});

test('effort 9 palette groups keep the serial bytes through workers, fallback and hurry', {skip: !decode}, async () => {
  const p = picture('globe'), source = p.rgba.slice(), alone = encode(p.rgba, p.width, p.height, {effort: 9});
  const floor = encode(p.rgba, p.width, p.height, {effort: 1});
  exact(alone, p);
  for (const variant of [{workers: 1}, {workers: 2}, {workers: 1, fail: true}, {workers: 2, hurry: true}]) {
    let palette = false, injected = false, answers = 0;
    const threads = [], kinds = new Map();
    const spawn = () => {
      const worker = spawnNode(), post = worker.postMessage;
      threads.push(new Promise(ended => worker.thread.once('exit', ended)));
      worker.thread.on('message', message => { if (kinds.get(message.id) === 'palette') answers++; });
      worker.postMessage = (message, transfer) => {
        if (message.pool === 'pass') {
          kinds.set(message.id, message.kind);
          if (message.kind === 'palette') {
            palette = true;
            if (variant.fail) { injected = true; throw new Error('palette pass send failed'); }
          }
        }
        return post(message, transfer);
      };
      return worker;
    };
    const job = encodePool(p.rgba, p.width, p.height, {effort: 9}, {spawn, workers: variant.workers});
    let previous = 0;
    for await (const done of job) {
      assert.ok(done >= previous && done <= 1); previous = done;
      if (variant.hurry && palette) job.hurry = true;
    }
    await Promise.all(threads);
    assert.ok(palette, 'the actual effort 9 path reaches palette workers');
    if (variant.fail) assert.ok(injected);
    else assert.ok(answers, 'a real worker returns palette sections');
    if (!variant.hurry) assert.deepEqual(job.bytes, alone);
    else assert.ok(job.bytes.length <= floor.length);
    exact(job.bytes, p); assert.equal(previous, 1);
  }
  assert.deepEqual(p.rgba, source);
});
