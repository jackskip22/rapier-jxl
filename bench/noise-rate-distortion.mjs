// SPDX-License-Identifier: MIT
// Reproduce the bounded source-grain gate. Prepare pixels with prepare-noise-corpus.py first.
// JXL_NOISE_CORPUS=/path/to/pixels JXL_TOOLS=/path/to/libjxl/tools node noise-rate-distortion.mjs
// Optional JXL_IDEAL_CORPUS adds all nine clean photographic, screenshot and alpha controls.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {readFile, writeFile, mkdir, readdir} from 'node:fs/promises';
import {resolve, dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
import {encodePhoto} from '../src/photo-noise.mjs';
import {prepareNoise} from '../src/noise-estimation.mjs';
import {writePng} from './image-io.mjs';

const run = promisify(execFile), sourceRoot = fileURLToPath(new URL('../..', import.meta.url));
const corpus = resolve(process.env.JXL_NOISE_CORPUS || 'noise-corpus');
const tools = resolve(process.env.JXL_TOOLS || 'libjxl/tools');
const output = resolve(process.env.JXL_NOISE_OUTPUT || 'noise-measurements');
const receiptPath = resolve(process.env.JXL_NOISE_RECEIPT || join(output, 'noise-results.json'));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const sources = JSON.parse(await readFile(new URL('./noise-corpus-sources.json', import.meta.url)));
await mkdir(output, {recursive: true}); await mkdir(dirname(receiptPath), {recursive: true});
const sourceSha256 = {};
for (const name of (await readdir(sourceRoot)).filter(name => name.endsWith('.mjs')).sort()) sourceSha256[name] = hash(await readFile(join(sourceRoot, name)));
const version = await run(join(tools, 'djxl'), ['--version']);
const receipt = {node: process.version, platform: process.platform, architecture: process.arch,
  decoder: (version.stdout + version.stderr).trim(), sourceSha256,
  method: {corpus: 'Two original grain-bearing camera/film examples; no resizing', effort: 1,
    matching: 'Ten binary-search probes over quality [1,99.9], retain the highest probed quality with bytes <= control',
    controlQualities: [25, 35, 45], autoQualityRange: [25, 52],
    timing: 'Ten warmups followed by seven complete synchronous encodes; median in milliseconds; includes analysis',
    quality: 'SSIMULACRA2 and Butteraugli from libjxl 0.12.0 tools against the original decoded JPEG pixels'}, rows: [], cleanControls: []};
const save = async () => writeFile(receiptPath, JSON.stringify(receipt, null, 2) + '\n');
const time = (pixels, entry, options) => {
  for (let i = 0; i < 10; i++) encodePhoto(pixels, entry.width, entry.height, options);
  const samples = []; let bytes;
  for (let i = 0; i < 7; i++) { const begin = performance.now(); bytes = encodePhoto(pixels, entry.width, entry.height, options); samples.push(performance.now() - begin); }
  return {bytes, medianMs: [...samples].sort((a, b) => a - b)[3], samplesMs: samples};
};
for (const entry of sources) {
  const pixels = new Uint8Array(await readFile(join(corpus, entry.id + '.rgba')));
  assert.equal(hash(pixels), entry.rgbaSha256, entry.id + ' pinned original pixels');
  const reference = join(output, entry.id + '-reference.png'); await writeFile(reference, writePng(entry.width, entry.height, pixels));
  const encode = (quality, noise) => encodePhoto(pixels, entry.width, entry.height, {quality, effort: 1, noise});
  const metrics = async (bytes, name) => {
    const path = join(output, name); await writeFile(path + '.jxl', bytes);
    await run(join(tools, 'djxl'), [path + '.jxl', path + '.png', '--bits_per_sample=8', '--num_threads=0', '--quiet']);
    const ss = await run(join(tools, 'ssimulacra2'), [reference, path + '.png']);
    const ba = await run(join(tools, 'butteraugli_main'), [reference, path + '.png']);
    return {ssimulacra2: Number(ss.stdout.trim()), butteraugli: Number(ba.stdout.trim().split(/\s+/)[0])};
  };
  const estimate = prepareNoise(pixels, entry.width, entry.height, .5);
  for (const quality of [25, 35, 45]) {
    const control = time(pixels, entry, {quality, effort: 1, noise: 'off'});
    const controlScores = await metrics(control.bytes, entry.id + '-' + quality + '-off');
    let low = 1, high = 99.9, chosenQuality = 1, chosen = encode(1, 'auto');
    for (let i = 0; i < 10; i++) {
      const current = (low + high) / 2, bytes = encode(current, 'auto');
      if (bytes.length <= control.bytes.length) { chosenQuality = current; low = current; chosen = bytes; } else high = current;
    }
    assert.ok(chosenQuality >= 25 && chosenQuality <= 52, 'the chosen grain replacement lies in its admitted range');
    const automatic = time(pixels, entry, {quality: chosenQuality, effort: 1, noise: 'auto'});
    assert.deepEqual(automatic.bytes, chosen); assert.ok(chosen.length <= control.bytes.length);
    const autoScores = await metrics(chosen, entry.id + '-' + quality + '-auto');
    const summarize = (result, q, scores) => ({quality: q, bytes: result.bytes.length, sha256: hash(result.bytes),
      medianMs: result.medianMs, samplesMs: result.samplesMs, ...scores});
    const row = {id: entry.id, width: entry.width, height: entry.height, inputSha256: entry.rgbaSha256,
      estimate: {sigma: estimate.sigma, patches: estimate.patches}, control: summarize(control, quality, controlScores),
      auto: summarize(automatic, chosenQuality, autoScores),
      ssimulacra2Gain: autoScores.ssimulacra2 - controlScores.ssimulacra2,
      butteraugliReduction: controlScores.butteraugli - autoScores.butteraugli};
    receipt.rows.push(row); await save(); console.log(JSON.stringify(row));
  }
}
if (process.env.JXL_IDEAL_CORPUS) {
  const root = resolve(process.env.JXL_IDEAL_CORPUS), manifest = JSON.parse(await readFile(join(root, 'manifest.json')));
  const selected = ['phone-flower', 'phone-flower-crop', 'photo-keong', 'photo-ria', 'photo-bliznaca', 'ui-gd-paint', 'ui-editor', 'alpha-globe', 'alpha-isotiles'];
  for (const id of selected) {
    const entry = manifest.find(row => row.id === id); assert.ok(entry, id);
    const pixels = new Uint8Array(await readFile(join(root, entry.pixels))); assert.equal(hash(pixels), entry.rgbaHash);
    const estimate = prepareNoise(pixels, entry.width, entry.height, .5); assert.equal(estimate.lut, null, id + ' has no admitted grain');
    const off = time(pixels, entry, {quality: 35, effort: 1, noise: 'off'}), auto = time(pixels, entry, {quality: 35, effort: 1, noise: 'auto'});
    assert.deepEqual(auto.bytes, off.bytes, id + ' remains byte identical');
    const row = {id, width: entry.width, height: entry.height, inputSha256: entry.rgbaHash, quality: 35,
      bytes: off.bytes.length, sha256: hash(off.bytes), byteIdentical: true, offMedianMs: off.medianMs, autoMedianMs: auto.medianMs,
      offSamplesMs: off.samplesMs, autoSamplesMs: auto.samplesMs, patches: estimate.patches};
    receipt.cleanControls.push(row); await save(); console.log(JSON.stringify(row));
  }
}
assert.ok(receipt.rows.every(row => row.ssimulacra2Gain >= 0 && row.butteraugliReduction >= 0), 'both metrics pass every bounded grain case');
await save();
