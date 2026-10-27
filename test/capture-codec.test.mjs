// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {encodeCapture, encodeCaptureSteps, quantizeCapture} from '../src/capture-codec.mjs';
import {localScreenSteps} from '../src/screen-local.mjs';
import {inspectPixels} from '../src/lossless.mjs';
import {screenPlan} from '../src/screen.mjs';
import {complete} from '../src/bits.mjs';
import {readPng} from '../bench/image-io.mjs';

function fixture(width, height, kind = 'screen') {
  const rgba = new Uint8Array(width * height * 4);
  let state = 1297;
  const random = () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return state >>> 0; };
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 4;
    const text = x % 17 < 6 && y % 23 < 11;
    rgba.set(kind === 'noise' ? [random() & 255, random() & 255, random() & 255]
      : kind === 'gradient' ? [x & 255, y & 255, (x + y) & 255]
      : text ? [32, 54, 76] : [241, 245, 249], i);
    rgba[i + 3] = kind === 'screen' ? 255 : kind === 'gradient' ? (x + y) & 255 : random() % 4 ? 255 : 0;
  }
  return rgba;
}

test('near-lossless bounds every RGB sample; preserves alpha and hidden RGB', () => {
  const pixels = new Uint8Array(256 * 256 * 4);
  for (let alpha = 0; alpha < 256; alpha++) for (let value = 0; value < 256; value++) {
    const i = (alpha * 256 + value) * 4;
    pixels.set([value, 255 - value, (value * 17) & 255, alpha], i);
  }
  const original = pixels.slice();
  assert.equal(quantizeCapture(pixels, 0), pixels);
  for (let maxError = 1; maxError <= 8; maxError++) {
    const quantized = quantizeCapture(pixels, maxError);
    assert.notEqual(quantized.buffer, pixels.buffer);
    for (let i = 0; i < pixels.length; i += 4) {
      assert.equal(quantized[i + 3], pixels[i + 3]);
      for (let c = 0; c < 3; c++) assert.ok(Math.abs(quantized[i + c] - pixels[i + c]) <= (pixels[i + 3] ? maxError : 0));
    }
  }
  assert.deepEqual(pixels, original);
});

test('capture input admits RGBA8 and rejects ambiguous or unsupported sample declarations', () => {
  const data = fixture(3, 2);
  assert.ok(encodeCapture(new Uint8ClampedArray(data), 3, 2) instanceof Uint8Array);
  for (const maxError of [-1, 9, 1.5, NaN, '1', null])
    assert.throws(() => encodeCapture(data, 3, 2, {maxError}), {code: 'JXL_INPUT'});
  for (const options of [{quality: 100}, {sampleFormat: 'uint'}, {bitDepth: 8}, {alphaPremultiplied: true}])
    assert.throws(() => encodeCapture(data, 3, 2, options), {code: 'JXL_INPUT'});
  assert.throws(() => encodeCapture(new Uint16Array(24), 3, 2), {code: 'JXL_INPUT'});
  assert.throws(() => encodeCapture(data, 4, 2), {code: 'JXL_INPUT'});
});

test('incremental capture is deterministic, monotonic, and retains the completed bytes', () => {
  const width = 1027, height = 19, backing = new Uint8Array(width * height * 4 + 8);
  const pixels = backing.subarray(4, backing.length - 4);
  pixels.set(fixture(width, height));
  const steps = encodeCaptureSteps(pixels, width, height);
  let last = 0, step;
  while (!(step = steps.next()).done) {
    assert.equal(typeof step.value, 'number');
    assert.ok(step.value >= last && step.value <= 1);
    last = step.value;
  }
  assert.equal(last, 1);
  assert.equal(steps.bytes, step.value);
  assert.deepEqual(step.value, encodeCapture(pixels, width, height));
  assert.equal(backing[0], 0);
});

const djxl = process.env.DJXL || 'djxl';
const nativeAvailable = spawnSync(djxl, ['--version'], {encoding: 'utf8'}).status === 0;

test('djxl round-trips capture groups, alpha, hidden colour, and bounded near-lossless', {skip: !nativeAvailable}, () => {
  const dir = mkdtempSync(join(tmpdir(), 'rapier-capture-'));
  try {
    for (const [width, height, kind] of [[1, 1, 'screen'], [17, 9, 'noise'], [257, 261, 'screen'], [1025, 17, 'gradient'], [513, 129, 'gradient'], [65, 67, 'noise']]) {
      const data = fixture(width, height, kind), original = data.slice();
      for (const maxError of [0, 3]) {
        const jxl = join(dir, 'test.jxl'), png = join(dir, 'test.png');
        writeFileSync(jxl, encodeCapture(data, width, height, {maxError}));
        const result = spawnSync(djxl, [jxl, png, '--bits_per_sample=8'], {encoding: 'utf8'});
        assert.equal(result.status, 0, result.stderr);
        const decoded = readPng(readFileSync(png));
        assert.equal(decoded.width, width); assert.equal(decoded.height, height);
        assert.deepEqual(decoded.rgba, quantizeCapture(data, maxError));
        assert.deepEqual(data, original);
      }
    }
  } finally { rmSync(dir, {recursive: true, force: true}); }
});

// Baseline bytes from 3d36f51: extracting shared group framing must not change the
// existing effort encoder's deep palette/transform search.
test('the unified screen framing preserves the existing advanced encoder bytes', () => {
  const expected = [[32,29,"screen","14c71fa1e4840c8608d8c35faf80d822f1da994694b79d9fe34934c8051b74dc"],[29,27,"gradient","5a56a7b9b69e92f9b2e45a069aa0f0181847c176ca1c4d14247131426c3e982b"],[17,13,"noise","baf51f70959707a1bbdeed1c454cbe29044ad5baa15bdea9a128d67d584fd46f"],[513,7,"screen","a307aa4383565168efb53bc6539190284da8be47a767311494e5de930a1a5cea"]];
  for (const [width, height, kind, sha256] of expected) {
    const data = fixture(width, height, kind), shape = inspectPixels(data, width, height);
    const bytes = complete(localScreenSteps(data, width, height, shape, 'srgb', {dim: 512, depths: [4]}));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), sha256);
  }
});


test('scalar palette admission drops dense channels without losing sparse alpha', () => {
  const data = new Uint8Array(1024 * 4);
  for (let x = 0; x < 1024; x++) data.set([x & 255, (x + 13) & 255, (x + 64) & 255, x & 1 ? 199 : 17], x * 4);
  const shape = inspectPixels(data, 1024, 1, {palette: false});
  const plan = screenPlan(data, 1024, 1, shape, 'scalar');
  assert.deepEqual(plan.transforms, [{type: 'palette', beginC: 3, numC: 1, nbColors: 2}]);
  assert.deepEqual(plan.meta[0].plane, Int16Array.of(17, 199));
  const planes = Array.from({length: 4}, () => new Int16Array(1024));
  plan.fill(planes, 0, 0, 1024, 1);
  for (let x = 0; x < 1024; x++) {
    for (let c = 0; c < 3; c++) assert.equal(planes[c][x], data[x * 4 + c]);
    assert.equal(planes[3][x], x & 1);
  }
});
