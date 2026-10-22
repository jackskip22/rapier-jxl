// SPDX-License-Identifier: MIT
// Caller-authored order examples: full synchronous encode cost, exact reconstructed-pixel controls.
import assert from 'node:assert/strict';
import {readFile, writeFile} from 'node:fs/promises';
import {gunzipSync} from 'node:zlib';
import {cpus} from 'node:os';
import {createHash} from 'node:crypto';
import {encodePhoto, COEFFICIENT_ORDER_BUCKETS} from '../src/photo-advanced.mjs';
import {strategyCoefficientSteps, admitStrategyOptions} from '../src/vardct-strategies.mjs';
import {progressivePasses} from '../src/vardct-progressive.mjs';
import {complete} from '../src/bits.mjs';
import {decoder} from '../test/decoder.mjs';
import {djxlDecoder} from '../test/djxl-decoder.mjs';
import {rgbaOf} from '../test/photo-advanced-cases.mjs';

const output = process.argv[2];
if (!output) throw new Error('Supply a measurement receipt path.');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const oxide = await decoder(), djxl = await djxlDecoder(); assert.ok(oxide && djxl, 'both pinned independent decoders are required');
const corpus = new URL('../test/complete-corpus/', import.meta.url), manifest = JSON.parse(await readFile(new URL('manifest.json', corpus), 'utf8'));
const selected = ['grace-hopper', 'control-paint-0001-512x384', 'ui-light', 'drawing-labels', 'terminal-code'];
const inputs = await Promise.all(selected.map(async id => {
  const row = manifest.find(row => row.id === id); assert.ok(row, id);
  const data = new Uint8Array(gunzipSync(await readFile(new URL(row.pixels + '.gz', corpus)))); assert.equal(hash(data), row.rgbaHash);
  return {...row, data};
}));

// This measurement authors an order from nonzero occurrence buckets; it is not a public automatic policy.
function authorOrders(input, options) {
  const image = complete(strategyCoefficientSteps(input.data, input.width, input.height, options.quality, 'srgb', options, admitStrategyOptions(options)));
  const progression = progressivePasses(options.progressive), buckets = COEFFICIENT_ORDER_BUCKETS.filter(bucket => bucket.id === 0 || bucket.id === 2);
  const passes = Array.from({length: progression?.count || 1}, (_, pass) => Object.fromEntries(buckets.map(bucket => {
    const counts = [0, 1, 2].map(() => new Uint32Array(bucket.width * bucket.height));
    for (const block of image.strategyData.blocks) if (bucket.strategies.some(name => name === (block.id === 4 ? 'dct16' : 'dct8'))) {
      for (let c = 0; c < 3; c++) for (let rank = block.area; rank < block.size; rank++) {
        const position = block.order[rank], value = block.coeffs[[1, 0, 2][c]][position];
        if (progression ? progression.value(value, position, bucket.width, bucket.height, pass) : value) counts[c][rank]++;
      }
    }
    const skip = bucket.lowFrequencyCount, size = bucket.width * bucket.height;
    const channels = counts.map(count => Uint32Array.from([
      ...Array.from({length: skip}, (_, rank) => rank),
      ...Array.from({length: size - skip}, (_, rank) => rank + skip).sort((a, b) => Math.floor(count[b] / 8) - Math.floor(count[a] / 8) || a - b),
    ]));
    return [bucket.name, channels];
  })));
  return progression ? {passes} : passes[0];
}

const receipt = {capturedAt: new Date().toISOString(), node: process.version, cpu: cpus()[0].model,
  oxide: oxide.version, djxl: djxl.version,
  protocol: 'Complete synchronous encodePhoto, quality90/effort1, explicit DCT16 with DCT8 borders. One warmup and five measured calls per row on one reserved CPU. Each authored option is prepared before timed calls from nonzero counts in eight-block buckets; that one authoring observation is recorded separately and includes its own forward transform. Per-pass orders count the exact coefficient contribution of each spectral pass. No automatic route change or perceptual-quality claim. Both independent decoders compare exact reconstructed samples with the natural-order control.',
  corpus: inputs.map(({data, ...row}) => row), rows: []};
try {
  for (const input of inputs) for (const progressive of [false, 'spectral']) {
    const options = {quality: 90, effort: 1, transforms: 'dct16', progressive};
    const started = performance.now(), authored = authorOrders(input, options), authoringMs = performance.now() - started;
    let expectedOxide, expectedNative;
    for (const custom of [false, true]) {
      const settings = custom ? {...options, coefficientOrders: authored} : options;
      const warmStart = performance.now(); let bytes = encodePhoto(input.data, input.width, input.height, settings);
      const warmupMs = performance.now() - warmStart, sha256 = hash(bytes), samplesMs = [];
      for (let i = 0; i < 5; i++) {
        const start = performance.now(); bytes = encodePhoto(input.data, input.width, input.height, settings); samplesMs.push(performance.now() - start);
        assert.equal(hash(bytes), sha256);
      }
      const actual = rgbaOf(oxide(bytes)), native = await djxl.decode(bytes, input.width, input.height);
      if (custom) { assert.deepEqual(actual, expectedOxide); assert.deepEqual(native.data, expectedNative); }
      else { expectedOxide = actual; expectedNative = native.data; }
      const row = {id: input.id, mode: progressive ? 'spectral' : 'single', order: custom ? 'authored-occurrence' : 'natural',
        bytes: bytes.length, sha256, warmupMs, samplesMs, medianMs: samplesMs.slice().sort((a, b) => a - b)[2],
        authoringMs: custom ? authoringMs : 0, inputSha256: hash(input.data), oxideSamplesSha256: hash(actual),
        djxlSamplesSha256: hash(new Uint8Array(native.data.buffer)), exactDecodedEquality: true};
      receipt.rows.push(row); await writeFile(output, JSON.stringify(receipt, null, 2) + '\n');
      console.log(input.id, row.mode, row.order, row.bytes, row.medianMs.toFixed(3));
    }
  }
  receipt.complete = true; await writeFile(output, JSON.stringify(receipt, null, 2) + '\n');
} finally { await djxl.close(); }
