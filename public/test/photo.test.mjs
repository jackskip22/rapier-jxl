// SPDX-License-Identifier: MIT
// VarDCT round trips keep dimensions, colour channels and every alpha sample, including partial groups.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {encodePhotoRGBA} from '../../photo.mjs';
import {decoder} from './decoder.mjs';
import {jxlRsDecoder} from './jxl-rs-decoder.mjs';

const decode = await decoder(), needsOxide = decode ? undefined : 'jxl-oxide-wasm is not installed';
const rust = jxlRsDecoder();
let native = false;
try { native = /\blibjxl\b/.test(execFileSync('ffmpeg', ['-hide_banner', '-decoders'], {encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']})); } catch {}
function source(w, h) {
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4;
    data[i] = (x * 7 + y * 3) & 255; data[i + 1] = (x * 3 + y * 5) & 255; data[i + 2] = (x + y * 11) & 255;
    data[i + 3] = (x * 13 + y * 17) & 255;
  }
  return data;
}
function roundtrip(decoderFn) {
  for (const [w, h] of [[1, 1], [9, 17], [257, 259], [2057, 9]]) {
    const data = source(w, h), encoded = encodePhotoRGBA(data, w, h), back = decoderFn(encoded, w, h);
    assert.equal(back.length, data.length, `${w}x${h}: dimensions`);
    for (let i = 3; i < data.length; i += 4) assert.equal(back[i], data[i], `${w}x${h}: exact alpha at ${i >> 2}`);
    // This error bound detects plane transposition, a missing level shift and wrong colour conversion.
    let se = 0;
    for (let i = 0; i < data.length; i += 4) for (let c = 0; c < 3; c++) se += (data[i + c] - back[i + c]) ** 2;
    assert.ok(se / (w * h * 3) < 100, `${w}x${h}: colour planes corrupted`);
  }
  for (const colour of [[0, 0, 0], [255, 255, 255], [255, 0, 0], [0, 255, 0], [0, 0, 255]]) {
    const data = Uint8Array.from([...colour, 255]), bytes = encodePhotoRGBA(data, 1, 1, {quality: 99.9});
    const back = decoderFn(bytes, 1, 1);
    for (let c = 0; c < 4; c++) assert.ok(Math.abs(data[c] - back[c]) <= 1, 'the DC transform keeps the colour and level shift');
  }
}

test('photographic VarDCT: exact alpha, colour and partial groups through jxl-oxide', {skip: needsOxide}, () => {
  roundtrip(bytes => {
    const image = decode(bytes);
    if (image.channels === 4) return image.data;
    const rgba = new Uint8Array(image.width * image.height * 4);
    for (let i = 0; i < image.width * image.height; i++) { for (let c = 0; c < 3; c++) rgba[4 * i + c] = image.data[3 * i + c]; rgba[4 * i + 3] = 255; }
    return rgba;
  });
});
test('photographic quality 100 keeps all RGBA bytes exactly', {skip: needsOxide}, () => {
  const data = source(17, 19), back = decode(encodePhotoRGBA(data, 17, 19, {quality: 100}));
  assert.equal(back.channels, 4); assert.deepEqual(back.data, data);
});
test('photographic VarDCT: exact alpha, colour and partial groups through native libjxl', {skip: native ? undefined : 'ffmpeg with libjxl is not installed'}, () => {
  const directory = mkdtempSync(join(tmpdir(), 'rapier-photo-')), path = join(directory, 'picture.jxl');
  try { roundtrip(bytes => { writeFileSync(path, bytes); return execFileSync('ffmpeg', ['-v', 'error', '-i', path, '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'], {maxBuffer: 4 * 1024 * 1024}); }); }
  finally { rmSync(directory, {recursive: true, force: true}); }
});
test('photographic entry rejects malformed asks before allocating coefficient planes', () => {
  const data = new Uint8Array(4);
  for (const quality of [null, '90', NaN, Infinity, 0, 101]) assert.throws(() => encodePhotoRGBA(data, 1, 1, {quality}), {code: 'JXL_INPUT'});
  for (const options of [null, 4, '90']) assert.throws(() => encodePhotoRGBA(data, 1, 1, options), {code: 'JXL_INPUT'});
  for (const [w, h] of [[0, 1], [1, 0], [1.5, 1], [NaN, 1]]) assert.throws(() => encodePhotoRGBA(data, w, h), {code: 'JXL_INPUT'});
  assert.throws(() => encodePhotoRGBA(data, 16385, 1), {code: 'JXL_DIMENSIONS'});
  assert.throws(() => encodePhotoRGBA(data, 6000, 6000), {code: 'JXL_DIMENSIONS'});
  assert.throws(() => encodePhotoRGBA(new Uint8Array(3), 1, 1), {code: 'JXL_INPUT'});
  assert.throws(() => encodePhotoRGBA([0, 0, 0, 255], 1, 1), {code: 'JXL_INPUT'});
});
test('photographic VarDCT: exact alpha, colour and partial groups through jxl-rs', {skip: rust ? undefined : 'jxl-rs is unavailable (set JXL_FUZZ_JXL_RS)'}, () => {
  roundtrip((bytes, width, height) => rust.decode(bytes, width, height));
  const data = source(17, 19);
  assert.deepEqual(rust.decode(encodePhotoRGBA(data, 17, 19, {quality: 100}), 17, 19), data);
});
