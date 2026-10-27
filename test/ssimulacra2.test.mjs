// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, writeFileSync, mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {readPng, writePng} from '../bench/image-io.mjs';
import {ssimulacra2, linearForSsimulacra2, linearFromRGBA, compositeForSsimulacra2} from '../src/ssimulacra2.mjs';
import {encodeToScore, encodeToScoreSteps} from '../src/score.mjs';
import {scoreSteps, prepareV6, candidateImage, writeImage, runSync} from '../src/photo-v6-search.mjs';
import {complete} from '../src/bits.mjs';

// Independent golden scores: official libjxl 0.12.0, build 4128790, AVX2.
// Input PNGs contain exactly these RGBA samples, no color/profile metadata.
// https://github.com/libjxl/libjxl/blob/v0.12.0/tools/ssimulacra2.cc
const cases = [
  ['flat', 128, 128, 1, 97.33234484],
  ['gradient', 127, 113, 1, 95.67297757],
  ['gradient', 127, 113, 3, 86.69678382],
  ['text', 256, 256, 1, 97.07286264],
  ['text', 256, 256, 3, 93.51585131],
  ['noise', 256, 256, 1, 96.50987150],
  ['noise', 256, 256, 3, 92.92501844],
  ['photo', 500, 500, 1, 89.22856725],
  ['photo', 500, 500, 3, 78.22427077],
];

function fixture(name, width, height) {
  if (name === 'photo') return readPng(readFileSync(new URL('../examples/snapdom/vendor/photo.png', import.meta.url))).rgba;
  const rgba = new Uint8Array(width * height * 4);
  let state = 0x12345;
  const random = () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return state >>> 0; };
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const v = name === 'flat' ? 127 : name === 'text' ? (x % 17 < 6 && y % 21 < 12 ? 32 : 241)
      : name === 'noise' ? random() & 255 : Math.round(255 * x / (width - 1));
    rgba.set([v, name === 'gradient' ? Math.round(255 * y / (height - 1)) : v, v, 255], (y * width + x) * 4);
  }
  return rgba;
}

function quantize(source, error) {
  const rgba = source.slice(), step = 2 * error + 1;
  for (let i = 0; i < rgba.length; i += 4) for (let c = 0; c < 3; c++) rgba[i + c] = Math.min(255, Math.round(rgba[i + c] / step) * step);
  return rgba;
}

function score(a, b, width, height, alpha = false) {
  return Math.min(...(alpha ? [0.1, 0.9] : [undefined]).map(bg => ssimulacra2(
    linearForSsimulacra2(a, width * height, bg), linearForSsimulacra2(b, width * height, bg), width, height).score));
}

test('SSIMULACRA2 matches independent native scores, including smooth fields and odd dimensions', () => {
  for (const [name, width, height, error, expected] of cases) {
    const source = fixture(name, width, height), actual = score(source, quantize(source, error), width, height);
    assert.ok(Math.abs(actual - expected) < 1e-6, `${name}/${error}: ${actual} != ${expected}`);
  }
});

test('identical pixels score 100 and have a zero error map', () => {
  const width = 31, height = 29, rgba = fixture('gradient', width, height), planes = linearForSsimulacra2(rgba, width * height);
  const result = ssimulacra2(planes, planes, width, height, {wantMap: true});
  assert.equal(result.score, 100);
  assert.equal(result.sum, 0);
  assert.ok(result.map.every(value => value === 0));
});

test('transparent RGB is excluded by both modeled backgrounds; alpha remains borrowed', () => {
  const width = 32, height = 24, rgba = fixture('gradient', width, height), changed = rgba.slice();
  for (let i = 0; i < rgba.length; i += 4) {
    rgba[i + 3] = changed[i + 3] = 0;
    changed[i] = 255 - rgba[i]; changed[i + 1] = 255 - rgba[i + 1];
  }
  assert.equal(score(rgba, changed, width, height, true), 100);
  for (const bg of [0.1, 0.9]) assert.deepEqual(
    compositeForSsimulacra2(linearFromRGBA(changed, width * height), rgba, width * height, bg),
    linearForSsimulacra2(rgba, width * height, bg));
});

test('score selection prices every passing completed stream and chooses the real byte minimum', () => {
  const width = 16, height = 16, source = fixture('gradient', width, height), prepared = prepareV6(source, width, height);
  const result = runSync(scoreSteps(prepared, {ssimulacra2: 80}, {candidates: ['plain', 'gaborish'], effort: 3}),
    () => ({ssimulacra2: 80.05, butteraugli: 1, butteraugli3: 1}));
  const candidates = result.tried.map(row => {
    const bytes = writeImage(candidateImage(prepared, row.candidate, row.quality), 3);
    assert.equal(row.size, bytes.length);
    return {row, bytes};
  });
  const best = candidates.reduce((a, b) => b.bytes.length < a.bytes.length ? b : a);
  assert.equal(result.candidate, best.row.candidate);
  assert.deepEqual(result.bytes, best.bytes);
});

test('an unattainable target rejects instead of returning an under-target file', async () => {
  const source = fixture('noise', 8, 8), options = {target: {butteraugli: 1e-12}, candidates: ['plain'], effort: 1};
  assert.throws(() => complete(encodeToScoreSteps(source, 8, 8, options)), {code: 'JXL_TARGET_UNMET'});
  await assert.rejects(encodeToScore(source, 8, 8, options), {code: 'JXL_TARGET_UNMET'});
});

const native = process.env.SSIMULACRA2;
test('optional native recheck of opaque and partially transparent pairs', {skip: !native && 'Set SSIMULACRA2 to the native reference tool.'}, () => {
  const dir = mkdtempSync(join(tmpdir(), 'rapier-ssim-'));
  try {
    for (const alpha of [false, true]) {
      const width = 127, height = 113, a = fixture('gradient', width, height), b = quantize(a, 3);
      if (alpha) for (let i = 0; i < a.length; i += 4) a[i + 3] = b[i + 3] = (i / 4 * 17) & 255;
      const ref = join(dir, 'reference.png'), dist = join(dir, 'distorted.png');
      writeFileSync(ref, writePng(width, height, a)); writeFileSync(dist, writePng(width, height, b));
      const result = spawnSync(native, [ref, dist], {encoding: 'utf8'});
      assert.equal(result.status, 0, result.stderr);
      const expected = Number(result.stdout.trim()), actual = score(a, b, width, height, alpha);
      assert.ok(Math.abs(actual - expected) < 1e-6, `alpha=${alpha}: ${actual} != ${expected}`);
    }
  } finally { rmSync(dir, {recursive: true, force: true}); }
});
