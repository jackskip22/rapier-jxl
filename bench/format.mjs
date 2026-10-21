// SPDX-License-Identifier: MIT
// Named-corpus size, full-call speed and decoder proof for optional format features.
// Run alone on one CPU: JXL_DJXL=/.../djxl JXL_FORMAT_TOOLS=/.../tools node bench/format.mjs out.json
import assert from 'node:assert/strict';
import {readFile, writeFile, mkdtemp, rm} from 'node:fs/promises';
import {gunzipSync} from 'node:zlib';
import {execFileSync} from 'node:child_process';
import {tmpdir, cpus} from 'node:os';
import {join, dirname} from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {encodePhoto} from '../src/photo-advanced.mjs';
import {decoder} from '../test/decoder.mjs';
import {djxlDecoder} from '../test/djxl-decoder.mjs';
import {formatPattern, rgbaOf, nativeRgba} from '../test/photo-advanced-cases.mjs';
import {progressiveLayout} from '../test/progressive-layout.mjs';
import {writePng, readPng} from './image-io.mjs';

const out = process.argv[2];
if (!out || !process.env.JXL_DJXL) throw new Error('Supply output.json and JXL_DJXL=libjxl0.12.0/tools/djxl');
const tools = process.env.JXL_FORMAT_TOOLS || dirname(process.env.JXL_DJXL), hash = bytes => createHash('sha256').update(bytes).digest('hex');
const oxide = await decoder(), native = await djxlDecoder(); assert.ok(oxide && native);
const temporary = await mkdtemp(join(tmpdir(), 'jxl-format-'));
const corpus = new URL('../test/complete-corpus/', import.meta.url), manifest = JSON.parse(await readFile(new URL('manifest.json', corpus), 'utf8'));
const inputs = [];
for (const id of ['grace-hopper', 'control-paint-0001-512x384', 'drawing-labels']) {
  const source = manifest.find(row => row.id === id), data = new Uint8Array(gunzipSync(await readFile(new URL(source.pixels + '.gz', corpus))));
  assert.equal(hash(data), source.rgbaHash); inputs.push({...source, data});
}
const pattern = formatPattern(512, 384); inputs.push({id: 'format-pattern-v1', kind: 'synthetic directional pattern', width: 512, height: 384, rgbaHash: hash(pattern), data: pattern});
const quality = 90, effort = 1, recipes = [
  {name: 'ordinary', options: {}}, {name: 'dct8', options: {transforms: 'dct8'}}, {name: 'mixed8-16', options: {transforms: 'auto'}},
  {name: 'dct32', options: {transforms: 'dct32'}}, {name: 'progressive-spectral', options: {progressive: 'spectral'}},
  {name: 'progressive-successive', options: {progressive: 'successive'}}, {name: 'noise-photon', options: {noise: 'photon'}},
  {name: 'custom-quantization', options: {transforms: 'dct8', quantization: {dc: [1, 2, 2],
    dct8: [0, 1, 2].map(c => Array.from({length: 64}, (_, k) => (c ? 8 : 5) * (1 + Math.floor(k / 8) / 8)))}}},
];
const receipt = {node: process.version, oxide: oxide.version, djxl: native.version, cpu: cpus()[0].model,
  protocol: 'Complete synchronous encodePhoto call; effort1, quality90. One warmup then three measured repeats per row, one CPU. Fixed quality is not a perceptual-quality match. Independent decoders checked after timing. Metrics are libjxl0.12 SSIMULACRA2 and Butteraugli on reconstructed opaque sRGB PNGs. Progressive prefix proof uses incomplete codestreams, not container fragmentation.',
  corpus: inputs.map(({data, ...row}) => row), rows: []};
const metrics = (source, output) => ({ssimulacra2: Number(execFileSync(join(tools, 'ssimulacra2'), [source, output], {encoding: 'utf8'}).trim()),
  butteraugli: Number(execFileSync(join(tools, 'butteraugli_main'), [source, output], {encoding: 'utf8'}).trim().split(/\s+/)[0])});
try {
  for (const input of inputs) {
    const sourcePath = join(temporary, 'source.png'); await writeFile(sourcePath, writePng(input.width, input.height, input.data));
    let ordinary;
    for (const recipe of recipes) {
      const options = {quality, effort, ...recipe.options}, warmStart = performance.now();
      let bytes = encodePhoto(input.data, input.width, input.height, options), warmupMs = performance.now() - warmStart;
      const expected = hash(bytes), samples = [];
      for (let repeat = 0; repeat < 3; repeat++) {
        const started = performance.now(); bytes = encodePhoto(input.data, input.width, input.height, options); samples.push(performance.now() - started);
        assert.equal(hash(bytes), expected);
      }
      const back = rgbaOf(oxide(bytes)), dj = nativeRgba(await native.decode(bytes, input.width, input.height));
      let maxDecoderDifference = 0, rgbSse = 0;
      for (let i = 0; i < back.length; i++) {
        maxDecoderDifference = Math.max(maxDecoderDifference, Math.abs(back[i] - dj[i]));
        if (i % 4 !== 3) rgbSse += (back[i] - input.data[i]) * (back[i] - input.data[i]);
        else assert.equal(back[i], input.data[i], 'alpha exact');
      }
      assert.ok(maxDecoderDifference <= 1);
      if (recipe.name === 'ordinary') ordinary = back;
      if (recipe.name.startsWith('progressive-')) assert.deepEqual(back, ordinary, 'progressive final pixel equality');
      const decodedPath = join(temporary, 'decoded.png'); await writeFile(decodedPath, writePng(input.width, input.height, dj));
      const row = {id: input.id, feature: recipe.name, quality, effort, bytes: bytes.length, sha256: expected,
        warmupMs, samplesMs: samples, medianMs: samples.slice().sort((a, b) => a - b)[1],
        rgbPsnr: rgbSse ? 10 * Math.log10(255 * 255 * input.width * input.height * 3 / rgbSse) : null,
        maxDecoderDifference, ...metrics(sourcePath, decodedPath)};
      if (recipe.name === 'progressive-spectral') {
        const layout = progressiveLayout(bytes), end = layout.passEnds[0], partial = join(temporary, 'partial.jxl'), preview = join(temporary, 'preview.png');
        await writeFile(partial, bytes.subarray(0, end));
        execFileSync(process.env.JXL_DJXL, [partial, preview, '--allow_partial_files', '--downsampling=4', '--bits_per_sample=8', '--num_threads=0', '--quiet']);
        const early = readPng(await readFile(preview));
        assert.equal(early.width, input.width); assert.equal(early.height, input.height);
        assert.notDeepEqual(early.rgba, back, 'first spectral pass is genuinely an earlier reconstruction');
        row.progressive = {passes: layout.passes, shifts: layout.shifts, hints: layout.hints, firstPassBytes: end, firstPassFraction: end / bytes.length,
          firstPassDecodedBy: 'djxl0.12.0 --allow_partial_files --downsampling=4', previewSha256: hash(early.rgba)};
      }
      receipt.rows.push(row); await writeFile(out, JSON.stringify(receipt, null, 2) + '\n');
      console.log(input.id, recipe.name, bytes.length, row.medianMs.toFixed(2), row.ssimulacra2, row.butteraugli);
    }
  }
  receipt.complete = true; await writeFile(out, JSON.stringify(receipt, null, 2) + '\n');
} finally { await native.close(); await rm(temporary, {recursive: true, force: true}); }
