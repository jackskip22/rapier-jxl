// SPDX-License-Identifier: MIT
// Complete-file sizes, time, independent samples and perceptual measurements for bounded graphics.
// Prepare inputs with prepare-graphics-corpus.py, then set JXL_GRAPHICS_CORPUS and JXL_TOOLS.
import assert from 'node:assert/strict';
import {readFile, writeFile, mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {cpus} from 'node:os';
import {resolve, join, dirname} from 'node:path';
import {encodeGraphics} from '../src/graphics.mjs';
import {encodeDeltaPalette} from '../src/delta-palette.mjs';
import {complete} from '../src/bits.mjs';
import {inspectPixels} from '../src/lossless.mjs';
import {screenSteps} from '../src/screen-search.mjs';
import {decoder} from '../test/decoder.mjs';
import {djxlDecoder} from '../test/djxl-decoder.mjs';
import {rgbaOf} from '../test/oracles.mjs';
import {graphicsWitness, graphicsProtectedEdges, graphicsNativeRgba} from '../test/graphics-cases.mjs';
import {loadGraphicsCorpus} from './graphics-corpus.mjs';
import {writePng} from './image-io.mjs';

const execute = promisify(execFile), hash = bytes => createHash('sha256').update(bytes).digest('hex');
const output = resolve(process.argv[2] || 'graphics-results.json'), artifacts = output.replace(/\.json$/, '') + '-files';
const tools = resolve(process.env.JXL_TOOLS || 'libjxl/tools');
const {cases, manifestSha256} = await loadGraphicsCorpus(process.env.JXL_GRAPHICS_CORPUS || 'graphics-corpus');
const warmups = Number(process.env.JXL_GRAPHICS_WARMUPS ?? 1), samples = Number(process.env.JXL_GRAPHICS_SAMPLES ?? 3);
assert.ok(Number.isInteger(warmups) && warmups >= 0 && Number.isInteger(samples) && samples >= 1);
const filter = process.env.JXL_GRAPHICS_FILTER && new RegExp(process.env.JXL_GRAPHICS_FILTER);
const variantFilter = process.env.JXL_GRAPHICS_VARIANTS && new Set(process.env.JXL_GRAPHICS_VARIANTS.split(','));
const sourceHashes = new Map();
async function fingerprint(name) {
  if (sourceHashes.has(name)) return;
  const source = await readFile(new URL('../src/' + name + '.mjs', import.meta.url)); sourceHashes.set(name, hash(source));
  for (const [, dependency] of source.toString().matchAll(/^import [^\n]* from '\.\/([\w-]+)\.mjs';$/gm)) await fingerprint(dependency);
}
await fingerprint('graphics');
const native = await djxlDecoder({executable: join(tools, 'djxl'), timeout: 60000}), oxide = await decoder();
assert.ok(native && oxide, 'Both independent decoders must be installed.');
await mkdir(artifacts, {recursive: true}); await mkdir(dirname(output), {recursive: true});
const receipt = {name: 'Bounded Graphics: Original Screenshots, Dithered Earth and Sharp Text v1',
  createdAt: new Date().toISOString(), complete: false, node: process.version, cpu: cpus()[0].model,
  oxide: oxide.version, djxl: native.version, manifestSha256, sourceSha256: Object.fromEntries([...sourceHashes].sort()),
  protocol: {warmups, samples, timing: 'Complete synchronous calls, median milliseconds on the assigned CPU; includes source inspection, exact floor, palette/undither preparation and every candidate search. Decoder proof and quality scores are outside the timings. Original dimensions; no resizing.',
    quality: 'libjxl0.12.0 SSIMULACRA2 and Butteraugli against original decoded RGBA8. These characterize explicit lossy output, not matched-quality or lossless improvements.',
    control: 'Complete screen search effort5 and exact delta-palette auto (core, screen5, implicit delta). All graphics modes retain this same exact floor and only select a smaller full file; equal sizes prefer less RGB squared error.',
    options: {paletteColors: 256, preserveEdges: true, screenEffort: 5, deltaPredictor: 'auto', groupSize: 1024, maxPaletteColors: 4096}}, rows: []};
const save = () => writeFile(output, JSON.stringify(receipt, null, 2) + '\n');
function measure(run) {
  for (let i = 0; i < warmups; i++) run();
  let bytes; const samplesMs = [];
  for (let i = 0; i < samples; i++) { const start = performance.now(); bytes = run(); samplesMs.push(performance.now() - start); }
  return {bytes, samplesMs, medianMs: [...samplesMs].sort((a, b) => a - b)[Math.floor(samples / 2)]};
}
try {
  for (const entry of cases) {
    if (filter && !filter.test(entry.id)) continue;
    const {id, width, height, rgba} = entry, edgeMask = graphicsProtectedEdges(rgba, width, height);
    const edgePixels = edgeMask.reduce((count, value) => count + value, 0);
    const reference = join(artifacts, id + '-original.png'); await writeFile(reference, writePng(width, height, rgba));
    const variants = [
      ['screen5', {}, () => complete(screenSteps(rgba, width, height, inspectPixels(rgba, width, height), 'srgb', {effort: 5}))],
      ['exact', {}, () => encodeDeltaPalette(rgba, width, height)],
      ['screen2', {preset: 'screen'}, () => encodeGraphics(rgba, width, height, {preset: 'screen'})],
      ['palette8', {maxColorError: 8}, () => encodeGraphics(rgba, width, height, {maxColorError: 8})],
      ['dither8', {preset: 'dither'}, () => encodeGraphics(rgba, width, height, {preset: 'dither'})],
      ['palette16', {maxColorError: 16}, () => encodeGraphics(rgba, width, height, {maxColorError: 16})],
    ];
    let exactSize;
    for (const [name, options, run] of variants) {
      if (variantFilter && !variantFilter.has(name)) continue;
      const measured = measure(run), bytes = measured.bytes, decoded = graphicsNativeRgba(await native.decode(bytes, width, height));
      const ox = rgbaOf(oxide(bytes)); assert.deepEqual(ox, decoded, id + '/' + name + ' exact independent Modular samples');
      const witness = graphicsWitness(rgba, decoded, width, height, options, edgeMask);
      const cap = options.maxColorError ?? (options.preset === 'screen' ? 2 : options.preset === 'dither' ? 8 : 0);
      assert.ok(witness.maxColorError <= cap, id + '/' + name + ' hard RGB error bound');
      for (const key of ['alphaErrors', 'hiddenErrors', 'maskErrors', 'edgeErrors']) assert.equal(witness[key], 0, id + '/' + name + ' ' + key);
      assert.equal(hash(rgba), entry.rgbaSha256, 'source samples stay unchanged');
      if (name === 'exact') exactSize = bytes.length;
      else if (exactSize !== undefined) assert.ok(bytes.length <= exactSize, id + '/' + name + ' complete exact floor');
      const path = join(artifacts, id + '-' + name); await writeFile(path + '.jxl', bytes);
      await writeFile(path + '.png', writePng(width, height, decoded));
      const ss = await execute(join(tools, 'ssimulacra2'), [reference, path + '.png']);
      const ba = await execute(join(tools, 'butteraugli_main'), [reference, path + '.png']);
      const row = {id, kind: entry.kind, width, height, rgbaSha256: entry.rgbaSha256, variant: name, options,
        bytes: bytes.length, sha256: hash(bytes), medianMs: measured.medianMs, samplesMs: measured.samplesMs,
        ssimulacra2: Number(ss.stdout.trim()), butteraugli: Number(ba.stdout.trim().split(/\s+/)[0]),
        rgbRmse: Math.sqrt(witness.squaredError / (width * height * 3)), changedFraction: witness.changedPixels / (width * height),
        protectedEdgePixels: edgePixels, independentDecoderDifference: 0, witness};
      assert.ok(Number.isFinite(row.ssimulacra2) && Number.isFinite(row.butteraugli));
      receipt.rows.push(row); await save();
      console.log(id, name, bytes.length, measured.medianMs.toFixed(2) + 'ms', 'SS2', row.ssimulacra2.toFixed(3), 'BA', row.butteraugli.toFixed(3));
    }
  }
  for (const [name, digest] of sourceHashes) assert.equal(hash(await readFile(new URL('../src/' + name + '.mjs', import.meta.url))), digest, 'source stayed fixed: ' + name);
  receipt.complete = true; receipt.finishedAt = new Date().toISOString(); await save();
} finally { await native.close(); }
