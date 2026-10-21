// SPDX-License-Identifier: MIT
// Full-call warm timings and independent decoder evidence for authored format syntax cases.
import assert from 'node:assert/strict';
import {readFile, writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {cpus} from 'node:os';
import {encodePhoto} from '../src/photo-advanced.mjs';
import {decoder} from '../test/decoder.mjs';
import {djxlDecoder} from '../test/djxl-decoder.mjs';
import {rgbaOf, nativeRgba} from '../test/photo-advanced-cases.mjs';

const featureHash = bytes => createHash('sha256').update(bytes).digest('hex');
async function featureSources() {
  const found = new Map();
  async function visit(name) {
    if (found.has(name)) return;
    const source = await readFile(new URL('../src/' + name + '.mjs', import.meta.url));
    found.set(name, {path: name + '.mjs', sha256: featureHash(source)});
    for (const [, dependency] of source.toString().matchAll(/^import [^\n]* from '\.\/([\w-]+)\.mjs';$/gm)) await visit(dependency);
  }
  await visit('photo-advanced'); return Array.from(found.values()).sort((a, b) => a.path.localeCompare(b.path));
}
function featureTiming(data, width, height, options) {
  let start = performance.now(), bytes = encodePhoto(data, width, height, options), warmupMs = performance.now() - start;
  const expected = featureHash(bytes), samplesMs = [];
  for (let i = 0; i < 5; i++) {
    start = performance.now(); bytes = encodePhoto(data, width, height, options); samplesMs.push(performance.now() - start);
    assert.equal(featureHash(bytes), expected, 'every complete measured call returns identical bytes');
  }
  return {bytes, row: {bytes: bytes.length, sha256: expected, warmupMs, samplesMs, medianMs: samplesMs.slice().sort((a, b) => a - b)[2]}};
}
function featureDifference(a, b) { return a.reduce((max, value, i) => Math.max(max, Math.abs(value - b[i])), 0); }
function featureError(a, b) {
  let square = 0;
  for (let i = 0; i < a.length; i++) if (i % 4 !== 3) square += (a[i] - b[i]) ** 2;
  return {maxSourceDifference: featureDifference(a, b), rgbMeanSquareError: square / (a.length / 4 * 3)};
}
export async function measureFormatOptions({name, kind, cases, pixels, out}) {
  if (!out || !process.env.JXL_DJXL) throw new Error('Supply output.json and JXL_DJXL=libjxl0.12.0/tools/djxl');
  const oxide = await decoder(), native = await djxlDecoder(); assert.ok(oxide && native);
  const receipt = {name, node: process.version, cpu: cpus()[0].model, oxide: oxide.version, djxl: native.version,
    protocol: 'Complete synchronous encodePhoto call. Each case uses its actual transform dimensions and nonzero directional or saturated checker detail. One warmup then five measured calls per configuration on one CPU; every call must be byte-identical. The control keeps the same transform and quality; compact tables replace its raw shape and LF cases remove only LF frames. Quantization weights differ, so byte comparisons are not claims of matched perceptual quality. Explicit source hashes identify the measured implementation.',
    sources: await featureSources(), complete: false, rows: []};
  try {
    for (const entry of cases) {
      const data = pixels(entry), options = entry.options, controlOptions = kind === 'quantization' ?
        {quality: options.quality, effort: options.effort, transforms: options.transforms} : {...options, lfFrames: false};
      const control = featureTiming(data, entry.width, entry.height, controlOptions), result = featureTiming(data, entry.width, entry.height, options);
      const lib = nativeRgba(await native.decode(result.bytes, entry.width, entry.height)), ox = rgbaOf(oxide(result.bytes));
      const controlPixels = nativeRgba(await native.decode(control.bytes, entry.width, entry.height));
      const decoderDifference = featureDifference(lib, ox);
      if (!entry.oxideDifference) assert.ok(decoderDifference <= 1, entry.name + ': independent decoders agree');
      if (entry.alpha || kind === 'lf') for (let i = 3; i < data.length; i += 4) assert.equal(lib[i], data[i], 'final alpha is exact');
      receipt.rows.push({name: entry.name, width: entry.width, height: entry.height, inputSha256: featureHash(data), options,
        ...result.row, control: {...control.row, ...featureError(data, controlPixels)}, ...featureError(data, lib),
        decoderMaxDifference: decoderDifference, controlMaxDifference: featureDifference(lib, controlPixels),
        documentedOxideLimitation: !!entry.oxideDifference});
      await writeFile(out, JSON.stringify(receipt, null, 2) + '\n');
      console.log(entry.name, result.bytes.length, result.row.medianMs.toFixed(3), decoderDifference);
    }
    receipt.complete = true; await writeFile(out, JSON.stringify(receipt, null, 2) + '\n');
  } finally { await native.close(); }
}
