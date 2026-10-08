// SPDX-License-Identifier: MIT
// VarDCT round trips keep dimensions, colour channels and every alpha sample, including partial groups.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {encodePhoto} from '../src/photo.mjs';
import {complete, float16Bits} from '../src/bits.mjs';
import {dctBlocks, dct8Basis, photoCoefficientSteps} from '../src/photo-dct.mjs';
import {quantisationSteps} from '../src/photo-quant.mjs';
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
  for (const [w, h] of [[1, 1], [9, 17], [257, 259], [2057, 9]]) for (const effort of [1, 5]) {
    const data = source(w, h), encoded = encodePhoto(data, w, h, {effort}), back = decoderFn(encoded, w, h);
    assert.equal(back.length, data.length, `${w}x${h}: dimensions`);
    for (let i = 3; i < data.length; i += 4) assert.equal(back[i], data[i], `${w}x${h}: exact alpha at ${i >> 2}`);
    // This error bound detects plane transposition, a missing level shift and wrong colour conversion.
    let se = 0;
    for (let i = 0; i < data.length; i += 4) for (let c = 0; c < 3; c++) se += (data[i + c] - back[i + c]) ** 2;
    assert.ok(se / (w * h * 3) < 100, `${w}x${h}: colour planes corrupted`);
  }
  for (const colour of [[0, 0, 0], [255, 255, 255], [255, 0, 0], [0, 255, 0], [0, 0, 255]]) {
    const data = Uint8Array.from([...colour, 255]), bytes = encodePhoto(data, 1, 1, {quality: 99.9});
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
  const data = source(17, 19), back = decode(encodePhoto(data, 17, 19, {quality: 100, effort: 5}));
  assert.equal(back.channels, 4); assert.deepEqual(back.data, data);
});
test('photographic VarDCT: exact alpha, colour and partial groups through native libjxl', {skip: native ? undefined : 'ffmpeg with libjxl is not installed'}, () => {
  const directory = mkdtempSync(join(tmpdir(), 'rapier-photo-')), path = join(directory, 'picture.jxl');
  try { roundtrip(bytes => { writeFileSync(path, bytes); return execFileSync('ffmpeg', ['-v', 'error', '-i', path, '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'], {maxBuffer: 4 * 1024 * 1024}); }); }
  finally { rmSync(directory, {recursive: true, force: true}); }
});
test('photographic entry rejects malformed asks before allocating coefficient planes', () => {
  const data = new Uint8Array(4);
  for (const quality of [null, '90', NaN, Infinity, 0, 101]) assert.throws(() => encodePhoto(data, 1, 1, {quality}), {code: 'JXL_INPUT'});
  for (const options of [null, 4, '90']) assert.throws(() => encodePhoto(data, 1, 1, options), {code: 'JXL_INPUT'});
  for (const effort of [null, '5', NaN, Infinity, 0, 10, 1.5]) assert.throws(() => encodePhoto(data, 1, 1, {effort}), {code: 'JXL_INPUT'});
  for (const [w, h] of [[0, 1], [1, 0], [1.5, 1], [NaN, 1]]) assert.throws(() => encodePhoto(data, w, h), {code: 'JXL_INPUT'});
  assert.throws(() => encodePhoto(data, 16385, 1), {code: 'JXL_DIMENSIONS'});
  // Dimensions admit 40 million pixels; byte length independently validates the input buffer.
  assert.throws(() => encodePhoto(data, 8000, 5001), {code: 'JXL_DIMENSIONS'});
  assert.throws(() => encodePhoto(data, 8000, 5000), {code: 'JXL_INPUT'});
  assert.throws(() => encodePhoto(new Uint8Array(3), 1, 1), {code: 'JXL_INPUT'});
  assert.throws(() => encodePhoto([0, 0, 0, 255], 1, 1), {code: 'JXL_INPUT'});
});
test('photographic VarDCT: exact alpha, colour and partial groups through jxl-rs', {skip: rust ? undefined : 'jxl-rs is unavailable (set JXL_FUZZ_JXL_RS)'}, () => {
  roundtrip((bytes, width, height) => rust.decode(bytes, width, height));
  const data = source(17, 19);
  assert.deepEqual(rust.decode(encodePhoto(data, 17, 19, {quality: 100}), 17, 19), data);
});

// Independently invert the AC error into spatial RGB samples. The candidate's declared model covers the full
// edge-replicated blocks before clipping and integer rounding; DC is a constant shared with effort 1.
function spatialError(data, jpeg) {
  const {width, height, components, quantScale} = jpeg, {stride, rows} = components[0], transform = dctBlocks(data, width, height);
  const basis = dct8Basis, biases = [0.9299455010825141, 0.945349926692846, 0.9500648966626563];
  let base = jpeg.quantFieldBase || 1;
  while (base / (2040 * quantScale) < 1 / 16384) base *= 2;
  const bits = float16Bits(base / (2040 * quantScale)), scale = (1 + (bits & 1023) / 1024) * 2 ** ((bits >> 10) - 15) * 2040;
  const errors = new Float64Array(192);
  let error = 0;
  for (let by = 0; by < rows; by++) for (let bx = 0; bx < stride; bx++) {
    const block = by * stride + bx, source = transform(bx, by), field = jpeg.quantFields?.[block] || base;
    for (let c = 0; c < 3; c++) for (let k = 1; k < 64; k++) {
      const q = components[c].coeffs[block * 64 + k], adjusted = Math.abs(q) < 2 ? q * biases[c] : q - 0.145 / q;
      errors[c * 64 + k] = adjusted * components[c].quant[k] * scale / field - source[c * 64 + k];
    }
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
      const channels = [0, 0, 0];
      for (let c = 0; c < 3; c++) for (let v = 0; v < 8; v++) for (let u = 0; u < 8; u++) channels[c] += errors[c * 64 + v * 8 + u] * basis[u * 8 + x] * basis[v * 8 + y];
      const [dy, dcb, dcr] = channels, dr = dy + 1.402 * dcr, dg = dy - 0.344136286 * dcb - 0.714136286 * dcr, db = dy + 1.772 * dcb;
      error += dr * dr + dg * dg + db * db;
    }
  }
  return error;
}

test('per-block photo quantisation stays inside effort 1\'s reconstruction budget', () => {
  // This quality admits a cheaper candidate for both full and partial blocks, so the budget check runs.
  const quality = 85;
  for (const [width, height] of [[16, 16], [17, 19]]) {
    const data = source(width, height), jpeg = complete(photoCoefficientSteps(data, width, height, quality, 'srgb'));
    const dc = jpeg.components.map(c => c.coeffs.filter((_, i) => i % 64 === 0)), before = spatialError(data, jpeg);
    const candidate = complete(quantisationSteps(data, jpeg));
    assert.ok(candidate, 'the retained case enters the quantisation candidate');
    const after = spatialError(data, candidate);
    assert.ok(after <= before, 'the linear RGB reconstruction error cannot grow');
    assert.ok(Math.abs(before - candidate.reconstructionError.baseline) < before * 1e-12);
    assert.ok(Math.abs(after - candidate.reconstructionError.candidate) < before * 1e-12);
    candidate.components.forEach((c, i) => assert.deepEqual(c.coeffs.filter((_, k) => k % 64 === 0), dc[i]));
    assert.equal(candidate.alpha, data);
    assert.ok(encodePhoto(data, width, height, {quality, effort: 5}).length <= encodePhoto(data, width, height, {quality}).length);
  }
});
