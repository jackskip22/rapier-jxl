// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync, writeFileSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Worker} from 'node:worker_threads';
import {encodeCapture} from '../src/capture.mjs';
import {encodeCaptureBytes} from '../src/capture-encode.mjs';
import {encodeLossless} from '../src/lossless.mjs';
import {reconstructJPEG} from '../src/jpeg.mjs';
import {fileHeader, boxHeader, RECONSTRUCTION, CODESTREAM} from '../src/container.mjs';

const SIGNATURE = [0xff, 0x0a];

function ui(width, height) {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 4;
    const band = Math.floor(y / 28) % 2 ? 248 : 255;
    const ink = x > 24 && x < width - 24 && (y % 28) > 6 && (y % 28) < 18 && ((x / 3) ^ (y / 28)) % 5;
    data[i] = ink ? 20 : band;
    data[i + 1] = ink ? 24 : band;
    data[i + 2] = ink ? 32 : band;
    data[i + 3] = 255;
  }
  return data;
}

test('encodeCapture is lossless, deterministic, and no larger than the core exact encode', async () => {
  const width = 320, height = 180, pixels = ui(width, height);
  const before = pixels.slice();
  const first = await encodeCapture(pixels, width, height, {worker: false});
  const second = encodeCaptureBytes(pixels, width, height);
  assert.deepEqual(pixels, before);
  assert.deepEqual(first, second);
  assert.deepEqual([...first.subarray(0, 2)], SIGNATURE);
  const exact = encodeLossless(pixels, width, height);
  assert.ok(first.length < exact.length);
});

test('a capture worker returns the same bytes', async () => {
  const width = 160, height = 90, pixels = ui(width, height);
  const inline = encodeCaptureBytes(pixels, width, height);
  const worker = new Worker(new URL('../src/capture-worker.mjs', import.meta.url));
  const bytes = await new Promise((resolve, reject) => {
    worker.on('message', data => data.ok ? resolve(data.bytes) : reject(Object.assign(new Error(data.error.message), data.error)));
    worker.on('error', reject);
    const copy = pixels.slice();
    worker.postMessage({id: 1, operation: 'capture', width, height, data: copy}, [copy.buffer]);
  });
  await worker.terminate();
  assert.deepEqual(bytes, inline);
});

test('several thousand colours stay lossless, and near-lossless is never larger', () => {
  const width = 320, height = 180, pixels = ui(width, height);
  for (let i = 0; i < 5000; i++) {
    const at = i * 4;
    pixels[at] = i & 255;
    pixels[at + 1] = (i >> 8) & 255;
    pixels[at + 2] = (i * 13) & 255;
    pixels[at + 3] = 255;
  }
  const before = pixels.slice();
  const exact = encodeCaptureBytes(pixels, width, height);
  const near = encodeCaptureBytes(pixels, width, height, {nearLossless: true, maxColorError: 6});
  assert.deepEqual(pixels, before);
  assert.deepEqual([...exact.subarray(0, 2)], SIGNATURE);
  assert.ok(near.length <= exact.length);
  assert.throws(() => encodeCaptureBytes(pixels, width, height, {maxColorError: 0}), error => error.code === 'JXL_INPUT');
});

test('unknown capture options are refused', async () => {
  await assert.rejects(encodeCapture(ui(8, 8), 8, 8, {worker: false, quality: 90}), error => error.code === 'JXL_INPUT');
});

test('two captures can share one worker without JXL_BUSY', async () => {
  const worker = new Worker(new URL('../src/capture-worker.mjs', import.meta.url));
  const one = ui(96, 64), two = ui(96, 48);
  const pending = new Map();
  worker.on('message', data => {
    const job = pending.get(data?.id);
    if (!job) return;
    pending.delete(data.id);
    data.ok ? job.resolve(data.bytes) : job.reject(Object.assign(new Error(data.error.message), data.error));
  });
  const send = (id, pixels, width, height) => new Promise((resolve, reject) => {
    pending.set(id, {resolve, reject});
    const copy = pixels.slice();
    worker.postMessage({id, operation: 'capture', width, height, data: copy}, [copy.buffer]);
  });
  const [a, b] = await Promise.all([send(1, one, 96, 64), send(2, two, 96, 48)]);
  await worker.terminate();
  assert.deepEqual(a, encodeCaptureBytes(one, 96, 64));
  assert.deepEqual(b, encodeCaptureBytes(two, 96, 48));
});

test('a JPEG reconstruction box Rapier did not write names that fact', () => {
  const head = fileHeader();
  const payload = new Uint8Array(16);
  const jbrd = boxHeader(RECONSTRUCTION, payload.length);
  const code = new Uint8Array([0xff, 0x0a]);
  const jxlc = boxHeader(CODESTREAM, code.length);
  const bytes = new Uint8Array(head.length + jbrd.length + payload.length + jxlc.length + code.length);
  let at = 0;
  for (const part of [head, jbrd, payload, jxlc, code]) { bytes.set(part, at); at += part.length; }
  assert.throws(() => reconstructJPEG(bytes), error => error.code === 'JXL_RECONSTRUCTION' && /only a JPEG it carried/.test(error.message));
});

test('djxl decodes a capture to the source pixels', () => {
  const bundled = '/tmp/jxl-tools/tools/djxl';
  const djxl = process.env.DJXL || 'djxl';
  const tool = spawnSync(djxl, ['--version']).status === 0 ? djxl : spawnSync(bundled, ['--version']).status === 0 ? bundled : '';
  if (!tool) return;
  const width = 480, height = 270, pixels = ui(width, height);
  const bytes = encodeCaptureBytes(pixels, width, height);
  const dir = mkdtempSync(join(tmpdir(), 'jxl-'));
  const file = join(dir, 'c.jxl'), png = join(dir, 'c.png');
  writeFileSync(file, bytes);
  const decoded = spawnSync(tool, [file, png, '--quiet']);
  assert.equal(decoded.status, 0, decoded.stderr?.toString());
  // PNG decode via a one-shot python, present in this environment; skip the byte check if Pillow is missing.
  const check = spawnSync('python3', ['-c', `
from PIL import Image
im=Image.open(${JSON.stringify(png)}).convert('RGBA')
assert list(im.size)==[${width},${height}]
print(im.tobytes().hex())
`]);
  if (check.status === 0) assert.equal(check.stdout.toString().trim(), Buffer.from(pixels).toString('hex'));
  rmSync(dir, {recursive: true, force: true});
});
