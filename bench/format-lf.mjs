// SPDX-License-Identifier: MIT
// Full-call sizes and timings, independent decoder agreement and incomplete LF-prefix proof.
import assert from 'node:assert/strict';
import {readFile, writeFile, mkdtemp, rm} from 'node:fs/promises';
import {gunzipSync} from 'node:zlib';
import {execFileSync} from 'node:child_process';
import {tmpdir, cpus} from 'node:os';
import {join, dirname} from 'node:path';
import {createHash} from 'node:crypto';
import {encodePhoto} from '../src/photo-advanced.mjs';
import {complete} from '../src/bits.mjs';
import {photoXYBSteps} from '../src/photo-xyb.mjs';
import {encodeVarDCT} from '../src/vardct.mjs';
import {readFrames} from '../src/framing.mjs';
import {decoder} from '../test/decoder.mjs';
import {djxlDecoder} from '../test/djxl-decoder.mjs';
import {formatPattern, rgbaOf, nativeRgba} from '../test/photo-advanced-cases.mjs';
import {writePng, readPng} from './image-io.mjs';

const out = process.argv[2];
if (!out || !process.env.JXL_DJXL) throw new Error('Supply output.json and JXL_DJXL=libjxl0.12.0/tools/djxl');
const tools = process.env.JXL_FORMAT_TOOLS || dirname(process.env.JXL_DJXL), hash = bytes => createHash('sha256').update(bytes).digest('hex');
const oxide = await decoder(), native = await djxlDecoder(); assert.ok(oxide && native);
const temporary = await mkdtemp(join(tmpdir(), 'jxl-format-lf-'));
const corpus = new URL('../test/complete-corpus/', import.meta.url), manifest = JSON.parse(await readFile(new URL('manifest.json', corpus), 'utf8'));
const inputs = [];
for (const id of ['grace-hopper', 'ui-light', 'drawing-labels']) {
  const source = manifest.find(row => row.id === id), data = new Uint8Array(gunzipSync(await readFile(new URL(source.pixels + '.gz', corpus))));
  assert.equal(hash(data), source.rgbaHash); inputs.push({...source, data});
}
const pattern = formatPattern(512, 384); inputs.push({id: 'format-pattern-v1', kind: 'synthetic directional pattern', width: 512, height: 384, rgbaHash: hash(pattern), data: pattern});
const quality = 90, effort = 1, recipes = [{name: 'ordinary', options: {}},
  ...[1, 2, 3, 4].map(lfFrames => ({name: 'lf-' + lfFrames, options: {lfFrames}})),
  {name: 'lf-1-spectral', options: {lfFrames: 1, progressive: 'spectral'}}];
const receipt = {node: process.version, oxide: oxide.version, djxl: native.version, cpu: cpus()[0].model,
  protocol: 'Complete synchronous encodePhoto call; effort1, quality90. One warmup then three measured repeats per row on one CPU. LF frames use the opaque XYB route; ordinary uses the existing route selection. Fixed quality is not a perceptual-quality match. The exact final-pixel comparison uses the existing XYB producer as its control. Intermediate LF frames use fine quantization. Incomplete-prefix proof includes the LF pyramid and main DC sections, before its HF data. It is separate from jxlp container fragmentation.',
  corpus: inputs.map(({data, ...row}) => row), rows: []};
const metrics = (source, output) => {
  const ssimulacra2 = Number(execFileSync(join(tools, 'ssimulacra2'), [source, output], {encoding: 'utf8'}).trim());
  const butteraugli = Number(execFileSync(join(tools, 'butteraugli_main'), [source, output], {encoding: 'utf8'}).trim().split(/\s+/)[0]);
  assert.ok(Number.isFinite(ssimulacra2) && Number.isFinite(butteraugli));
  return {ssimulacra2, butteraugli};
};
try {
  for (const input of inputs) {
    const sourcePath = join(temporary, 'source.png'); await writeFile(sourcePath, writePng(input.width, input.height, input.data));
    const xyb = rgbaOf(oxide(encodeVarDCT(complete(photoXYBSteps(input.data, input.width, input.height, quality)))));
    let levelOne;
    for (const recipe of recipes) {
      const options = {quality, effort, ...recipe.options}, start = performance.now();
      let bytes = encodePhoto(input.data, input.width, input.height, options), warmupMs = performance.now() - start;
      const sha256 = hash(bytes), samples = [];
      for (let repeat = 0; repeat < 3; repeat++) {
        const started = performance.now(); bytes = encodePhoto(input.data, input.width, input.height, options); samples.push(performance.now() - started);
        assert.equal(hash(bytes), sha256);
      }
      const back = rgbaOf(oxide(bytes)), dj = nativeRgba(await native.decode(bytes, input.width, input.height));
      let maxDecoderDifference = 0, maxDifferenceFromXYB = 0, rgbSse = 0;
      for (let i = 0; i < back.length; i++) {
        maxDecoderDifference = Math.max(maxDecoderDifference, Math.abs(back[i] - dj[i]));
        maxDifferenceFromXYB = Math.max(maxDifferenceFromXYB, Math.abs(back[i] - xyb[i]));
        if (i % 4 !== 3) rgbSse += (back[i] - input.data[i]) * (back[i] - input.data[i]);
        else assert.equal(back[i], input.data[i], 'alpha exact');
      }
      assert.ok(maxDecoderDifference <= 1);
      if (recipe.options.lfFrames) assert.ok(maxDifferenceFromXYB <= 2, 'fine LF reconstruction remains within two rounding units of the existing XYB route');
      if (recipe.name === 'lf-1') levelOne = back;
      if (recipe.name === 'lf-1-spectral') assert.deepEqual(back, levelOne, 'HF spectral passes preserve the final LF reconstruction');
      const decodedPath = join(temporary, 'decoded.png'); await writeFile(decodedPath, writePng(input.width, input.height, dj));
      const row = {id: input.id, feature: recipe.name, quality, effort, bytes: bytes.length, sha256, warmupMs, samplesMs: samples,
        medianMs: samples.slice().sort((a,b) => a-b)[1], maxDecoderDifference, maxDifferenceFromXYB,
        rgbPsnr: rgbSse ? 10 * Math.log10(255 * 255 * input.width * input.height * 3 / rgbSse) : null,
        ...metrics(sourcePath, decodedPath)};
      if (recipe.options.lfFrames) {
        const parsed = readFrames(bytes), main = parsed.frames.at(-1), dcGroups = Math.ceil(main.width / 2048) * Math.ceil(main.height / 2048);
        assert.ok(main.sizes.length > 1, 'this measured corpus has separate DC and HF sections');
        const end = bytes.length - parsed.codestream.length + main.sectionsAt + main.sizes.slice(0, dcGroups + 1).reduce((a,b) => a+b, 0);
        const partial = join(temporary, 'partial.jxl'), preview = join(temporary, 'preview.png');
        await writeFile(partial, bytes.subarray(0, end));
        execFileSync(process.env.JXL_DJXL, [partial, preview, '--allow_partial_files', '--downsampling=8', '--bits_per_sample=8', '--num_threads=0', '--quiet']);
        const early = readPng(await readFile(preview));
        assert.equal(early.width, input.width); assert.equal(early.height, input.height);
        assert.notDeepEqual(early.rgba, back, 'LF prefix is a genuinely earlier reconstruction');
        row.lowFrequency = {frames: parsed.frames.slice(0, -1).map(frame => ({level: frame.dcLevel, width: frame.width, height: frame.height,
          modular: frame.modular, useDCFrame: !!(frame.flags & 32), bytes: frame.end - frame.start})),
          previewBytes: end, previewFraction: end / bytes.length,
          decodedBy: 'djxl0.12.0 --allow_partial_files --downsampling=8', previewSha256: hash(early.rgba)};
      }
      receipt.rows.push(row); await writeFile(out, JSON.stringify(receipt, null, 2) + '\n');
      console.log(input.id, recipe.name, bytes.length, row.medianMs.toFixed(2), row.ssimulacra2, row.maxDifferenceFromXYB);
    }
  }
  receipt.complete = true; await writeFile(out, JSON.stringify(receipt, null, 2) + '\n');
} finally { await native.close(); await rm(temporary, {recursive: true, force: true}); }
