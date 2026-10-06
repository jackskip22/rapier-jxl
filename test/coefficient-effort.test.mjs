// SPDX-License-Identifier: MIT
// Entropy search changes bytes, never coefficients or their reconstruction in any independent decoder.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {transcode, transcodeSteps} from '../src/jpeg.mjs';
import {encodePhoto, encodePhotoSteps} from '../src/photo.mjs';
import {transcode as transcodeAns} from '../src/jpeg-ans.mjs';
import {encodePhoto as encodePhotoAns} from '../src/photo-ans.mjs';
import {decoder} from './decoder.mjs';
import {rgbaOf} from './oracles.mjs';
import {nativeDecoder} from './native-decoder.mjs';
import {jxlRsDecoder} from './jxl-rs-decoder.mjs';
import {pixelCase} from './fuzz-cases.mjs';
import {coefficientOrderSteps, coefficientOrders} from '../src/coefficient-effort.mjs';

const jpeg = new Uint8Array(await readFile(new URL('photo-corpus/grace-hopper.jpg', import.meta.url)));

test('coefficient counting can be abandoned before later planes are read', () => {
  const coeffs = new Int16Array(64 * 2048); coeffs[63] = 1;
  // Length admission may visit every component; counting must never touch later coefficient samples after hurry.
  const guarded = new Proxy(new Int16Array(64), {get(target, key) { if (key === 'length') return 64; throw new Error('later coefficient read'); }});
  const components = [{coeffs}, {coeffs: guarded}];
  const counting = coefficientOrderSteps(components), first = counting.next();
  assert.equal(first.done, false); assert.ok(first.value > 0 && first.value < 1);
  assert.equal(counting.next(true).value, null);
  assert.deepEqual(coefficientOrders([{coeffs}])[0], Array.from({length: 64}, (_, k) => k));
});

test('coefficient doors admit effort before work', () => {
  const {rgba, width, height} = pixelCase(20260930, 0);
  for (const options of [null, 4, {effort: 0}, {effort: 10}, {effort: 1.5}, {effort: NaN}, {effort: '4'}]) {
    assert.throws(() => transcodeSteps(jpeg, options), {code: 'JXL_INPUT'});
    assert.throws(() => encodePhotoSteps(rgba, width, height, options), {code: 'JXL_INPUT'});
  }
});

test('coefficient search keeps each decoder’s effort-1 pixels and the smaller stream', async t => {
  const oxide = await decoder(); assert.ok(oxide);
  let native;
  try {
    if (process.env.JXL_FUZZ_NATIVE) native = await nativeDecoder();
    else {
      const ffmpeg = process.env.JXL_FUZZ_FFMPEG || 'ffmpeg';
      const available = spawnSync(ffmpeg, ['-hide_banner', '-decoders'], {encoding: 'utf8'});
      if (available.status === 0 && /\blibjxl\b/.test(available.stdout)) native = {
        version: 'ffmpeg/libjxl',
        decode(bytes, width, height) {
          const result = spawnSync(ffmpeg, ['-v', 'error', '-threads', '1', '-f', 'image2pipe', '-c:v', 'libjxl', '-i', 'pipe:0', '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-threads', '1', 'pipe:1'], {
            input: bytes, maxBuffer: width * height * 4 + 65536, timeout: 30000, killSignal: 'SIGKILL',
          });
          assert.ifError(result.error);
          assert.equal(result.status, 0, 'libjxl refused output: ' + result.stderr.toString());
          assert.equal(result.stdout.length, width * height * 4, 'libjxl returned incomplete pixels');
          return new Uint8Array(result.stdout.buffer, result.stdout.byteOffset, result.stdout.byteLength);
        },
        close() {},
      };
    }
    if (process.env.JXL_FUZZ_REQUIRE_NATIVE === '1') assert.ok(native, 'The required native libjxl decoder is unavailable');
    const rust = jxlRsDecoder(), cases = [];
    for (const file of ['photo-corpus/grace-hopper.jpg', 'seeds/grey-sequential.jpg', 'seeds/colour-progressive-restarts.jpg']) {
      const input = new Uint8Array(await readFile(new URL(file, import.meta.url))), first = transcode(input), searched = transcode(input, {effort: 4});
      cases.push({...first, first: first.bytes, searched: searched.bytes});
      cases.push({...first, first: first.bytes, searched: transcodeAns(input, {effort: 2}).bytes});
    }
    for (const index of [0, 13, 44]) {
      const {rgba, width, height} = pixelCase(20260930, index);
      cases.push({width, height, first: encodePhoto(rgba, width, height), searched: encodePhoto(rgba, width, height, {effort: 4})});
      cases.push({width, height, first: encodePhoto(rgba, width, height), searched: encodePhotoAns(rgba, width, height, {effort: 2})});
    }
    for (const {width, height, first, searched} of cases) {
      assert.ok(searched.length <= first.length);
      assert.deepEqual(rgbaOf(oxide(searched)), rgbaOf(oxide(first)));
      if (native) assert.deepEqual(await native.decode(searched, width, height), await native.decode(first, width, height));
      if (rust) assert.deepEqual(rust.decode(searched, width, height), rust.decode(first, width, height));
    }
    t.diagnostic(JSON.stringify({cases: cases.length, decodesPerOracle: cases.length * 2,
      oracles: ['jxl-oxide ' + oxide.version, ...(native ? [native.version] : []), ...(rust ? [rust.version] : [])],
      nativeUnavailable: !native, jxlRsUnavailable: !rust}));
  } finally { await native?.close(); }
});

test('coefficient jobs keep their floor when hurried and their bytes when completed', () => {
  const first = transcode(jpeg), searched = transcode(jpeg, {effort: 4});
  assert.ok(searched.bytes.length < first.bytes.length, 'the retained photograph exercises a selected coefficient order');
  for (const from of [0, 0.55, 0.9]) {
    const job = transcodeSteps(jpeg, {effort: 4}); let last = 0;
    for (const done of job) {
      assert.ok(done >= last && done > 0 && done <= 1); last = done;
      if (done >= from) job.hurry = true;
    }
    assert.equal(last, 1);
    assert.deepEqual(job.bytes, from < 0.8 ? first.bytes : transcode(jpeg, {effort: 3}).bytes);
  }
  const job = transcodeSteps(jpeg, {effort: 4}); for (const _ of job);
  assert.deepEqual(job.bytes, searched.bytes);
  const late = transcodeSteps(jpeg, {effort: 4});
  for (const done of late) if (done === 1) late.hurry = true;
  assert.ok(late.bytes.length === searched.bytes.length && late.bytes.every((byte, i) => byte === searched.bytes[i]),
    'hurry at the final group keeps the completed coefficient-order candidate');
  assert.deepEqual([job.width, job.height, job.orientation], [searched.width, searched.height, searched.orientation]);
});

test('photograph effort jobs keep the floor through counting and writing, with quality 100 unchanged', () => {
  const {rgba, width, height} = pixelCase(20260930, 13), first = encodePhoto(rgba, width, height), searched = encodePhoto(rgba, width, height, {effort: 4});
  assert.ok(searched.length < first.length, 'the retained RGBA photo exercises a selected coefficient order');
  for (const from of [0, 0.76, 0.85, 0.95]) {
    const job = encodePhotoSteps(rgba, width, height, {effort: 4}); let last = 0;
    for (const done of job) {
      assert.ok(done >= last && done > 0 && done <= 1); last = done;
      if (done >= from) job.hurry = true;
    }
    assert.equal(last, 1);
    assert.deepEqual(job.bytes, from < 0.8 ? first : encodePhoto(rgba, width, height, {effort: 3}));
  }
  const completed = encodePhotoSteps(rgba, width, height, {effort: 4}); for (const _ of completed);
  assert.deepEqual(completed.bytes, searched);
  const late = encodePhotoSteps(rgba, width, height, {effort: 4});
  for (const done of late) if (done === 1) late.hurry = true;
  assert.ok(late.bytes.length === searched.length && late.bytes.every((byte, i) => byte === searched[i]),
    'hurry at the final group keeps the completed photo candidate');
  const exact = encodePhoto(rgba, width, height, {quality: 100}), exactJob = encodePhotoSteps(rgba, width, height, {quality: 100, effort: 4});
  exactJob.hurry = true; for (const _ of exactJob);
  assert.deepEqual(exactJob.bytes, exact);
  assert.deepEqual(encodePhoto(rgba, width, height, {quality: 100, effort: 4}), exact);
});
