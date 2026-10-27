// SPDX-License-Identifier: MIT
// The README's Node-runnable claims, checked against the package's own entry points.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {encode, encodeAsync} from 'rapier-jxl';
import {encodeToScore} from 'rapier-jxl/score';
import {transcode, reconstructJPEG} from 'rapier-jxl/jpeg';

const picture = (width, height) => {
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < rgba.length; i += 4) { const p = i >> 2, x = p % width, y = p / width | 0; rgba.set([(x * 7 + y * 3) & 255, (x * y) & 255, (128 + x - y) & 255, 255], i); }
  return rgba;
};
const SIGNATURE = [0xff, 0x0a];

test('encode at quality 90 and 100 writes JPEG XL', () => {
  for (const quality of [90, 100]) assert.deepEqual([...encode(picture(64, 48), 64, 48, {quality}).subarray(0, 2)], SIGNATURE);
});

test('encodeAsync writes the same file as encode', async () => {
  const rgba = picture(96, 64);
  assert.deepEqual(await encodeAsync(rgba, 96, 64, {quality: 90}), encode(rgba, 96, 64, {quality: 90}));
});

test('encodeToScore returns bytes that meet the score it reports', async () => {
  const {bytes, ssimulacra2} = await encodeToScore(picture(64, 64), 64, 64, {target: {ssimulacra2: 80}});
  assert.ok(bytes.length > 0);
  assert.ok(ssimulacra2 >= 80);
});

test('a JPEG carried into JPEG XL reconstructs byte for byte', () => {
  const jpeg = new Uint8Array(readFileSync(new URL('./fixtures/small.jpg', import.meta.url)));
  const {bytes} = transcode(jpeg);
  assert.deepEqual(reconstructJPEG(bytes), jpeg);
});
