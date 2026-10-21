// SPDX-License-Identifier: MIT
// Named-corpus measurements of coefficient retention, repeated qualities and exact byte-budget search.
import assert from 'node:assert/strict';
import {readFile, writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {cpus} from 'node:os';
import {gunzipSync} from 'node:zlib';
import {createPhotoPlan} from '../src/photo-plan.mjs';
import {encodePhoto} from '../src/photo-advanced.mjs';
import {decoder} from '../test/decoder.mjs';
import {djxlDecoder} from '../test/djxl-decoder.mjs';
import {rgbaOf, nativeRgba} from '../test/photo-advanced-cases.mjs';

const output = process.argv[2];
if (!output || !process.env.JXL_DJXL) throw new Error('Supply output.json and JXL_DJXL=libjxl0.12.0/tools/djxl');
const hash = value => createHash('sha256').update(value).digest('hex');
const corpus = new URL('../test/complete-corpus/', import.meta.url);
const manifest = JSON.parse(await readFile(new URL('manifest.json', corpus)));
const sources = new Map();
async function fingerprint(name) {
  if (sources.has(name)) return;
  const source = await readFile(new URL('../src/' + name + '.mjs', import.meta.url)); sources.set(name, hash(source));
  for (const [, dependency] of source.toString().matchAll(/^import [^\n]* from '\.\/([\w-]+)\.mjs';$/gm)) await fingerprint(dependency);
}
await fingerprint('photo-plan'); await fingerprint('photo-advanced');
const oxide = await decoder(), native = await djxlDecoder(); assert.ok(oxide && native);
const receipt = {name: 'Retained Transforms: Complete Corpus v1', node: process.version, cpu: cpus()[0].model,
  oxide: oxide.version, djxl: native.version, sources: Object.fromEntries([...sources].sort()), complete: false,
  protocol: {planningQuality: 87, effort: 1, repeatedQualities: [35, 55, 75, 90], targetBudgetQuality: 55,
    targetOptions: {initialQuality: 55, maxProbes: 12}, warmups: 3, samples: 5,
    timing: 'Median full-call milliseconds on CPU0. Preparation includes forward transforms and retained-buffer admission. Repeated/target timings reuse that plan. Rebuilding uses ordinary encodePhoto with the same fixed transform selection and the exact same qualities; outputs must be byte-identical. Target rebuilding measures the same recorded probe sequence, without retaining coefficients. One-shot totals are separately timed and include planning. No resizing or partial-frame timing.',
    scope: 'Optional YCbCr transform path only; this is not a comparison against the default perceptual XYB photo route.'}, rows: []};
const save = () => writeFile(output, JSON.stringify(receipt, null, 2) + '\n');
function measure(work, inspect = () => {}) {
  for (let i = 0; i < 3; i++) inspect(work());
  const samplesMs = []; let value;
  for (let i = 0; i < 5; i++) { const begin = performance.now(); value = work(); samplesMs.push(performance.now() - begin); inspect(value); }
  return {value, samplesMs, medianMs: [...samplesMs].sort((a, b) => a - b)[2]};
}
const timing = measured => ({medianMs: measured.medianMs, samplesMs: measured.samplesMs});
// Warm the shared code before the first measured real input; each configuration still has its own warmups.
const seed = new Uint8Array(64 * 64 * 4); for (let i = 0; i < seed.length; i++) seed[i] = i % 4 === 3 ? 255 : (i * 53) & 255;
for (let i = 0; i < 10; i++) { const plan = createPhotoPlan(seed, 64, 64, {transforms: 'dct16', effort: 1}); plan.encode(55); plan.dispose(); }
try {
  for (const entry of manifest) {
    const data = new Uint8Array(gunzipSync(await readFile(new URL(entry.pixels + '.gz', corpus))));
    assert.equal(hash(data), entry.rgbaHash, entry.id + ' pinned original pixels');
    for (const transforms of ['dct8', 'dct16']) {
      const options = {transforms, quality: 87, effort: 1};
      const preparation = measure(() => createPhotoPlan(data, entry.width, entry.height, options), plan => plan.dispose());
      const plan = createPhotoPlan(data, entry.width, entry.height, options), qualities = [35, 55, 75, 90];
      const expected = qualities.map(quality => encodePhoto(data, entry.width, entry.height, {...options, quality}));
      const inspectSeries = values => values.forEach((bytes, i) => assert.deepEqual(bytes, expected[i]));
      const cached = measure(() => qualities.map(quality => plan.encode(quality)), inspectSeries);
      const rebuilt = measure(() => qualities.map(quality => encodePhoto(data, entry.width, entry.height, {...options, quality})), inspectSeries);
      const budget = expected[1].length, searchOptions = {initialQuality: 55, maxProbes: 12};
      const target = plan.encodeTarget(budget, searchOptions), targetHash = hash(target.bytes);
      const inspectTarget = result => { assert.ok(result.bytes.length <= budget); assert.equal(hash(result.bytes), targetHash); };
      const cachedTarget = measure(() => plan.encodeTarget(budget, searchOptions), inspectTarget);
      const rebuiltTarget = measure(() => {
        let bytes, selected = -1;
        for (const probe of target.probes) {
          const candidate = encodePhoto(data, entry.width, entry.height, {...options, quality: probe.quality});
          if (candidate.length <= budget && probe.quality > selected) { bytes = candidate; selected = probe.quality; }
        }
        return {bytes};
      }, inspectTarget);
      const oneShot = measure(() => {
        const fresh = createPhotoPlan(data, entry.width, entry.height, options);
        try { return fresh.encodeTarget(budget, searchOptions); } finally { fresh.dispose(); }
      }, inspectTarget);
      const lib = nativeRgba(await native.decode(target.bytes, entry.width, entry.height)), ox = rgbaOf(oxide(target.bytes));
      let difference = 0;
      for (let i = 0; i < lib.length; i++) {
        difference = Math.max(difference, Math.abs(lib[i] - ox[i]));
        if (i % 4 === 3) assert.equal(lib[i], data[i], entry.id + ' exact alpha');
      }
      assert.ok(difference <= 1, entry.id + ' independent decoder agreement');
      const row = {id: entry.id, kind: entry.kind, width: entry.width, height: entry.height, inputSha256: entry.rgbaHash, options,
        planning: {...timing(preparation), retainedBytes: plan.retainedBytes, blockCount: plan.blockCount, strategies: plan.strategies},
        repeated: {qualities, outputs: expected.map(bytes => ({bytes: bytes.length, sha256: hash(bytes)})),
          cached: timing(cached), rebuilt: timing(rebuilt), speedup: rebuilt.medianMs / cached.medianMs},
        target: {budget, bytes: target.bytes.length, sha256: targetHash, quality: target.quality, probes: target.probes,
          cached: timing(cachedTarget), rebuilt: timing(rebuiltTarget), oneShot: timing(oneShot),
          cachedSpeedup: rebuiltTarget.medianMs / cachedTarget.medianMs, oneShotSpeedup: rebuiltTarget.medianMs / oneShot.medianMs,
          decoderMaxDifference: difference}};
      receipt.rows.push(row); plan.dispose(); await save();
      console.log(entry.id, transforms, row.target.bytes, row.target.quality, 'repeat', row.repeated.speedup.toFixed(2),
        'target', row.target.cachedSpeedup.toFixed(2), 'one-shot', row.target.oneShotSpeedup.toFixed(2));
    }
  }
  receipt.complete = true; await save();
} finally { await native.close(); }
