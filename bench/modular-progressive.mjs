#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Exact Modular resolution passes on the named Complete Corpus. Full encode calls only are timed.
// JXL_DJXL and JXL_OXIDE must point to the pinned independent decoders; source hashes are verified before use.
import assert from 'node:assert/strict';
import {readFile, writeFile, mkdir, mkdtemp, rm} from 'node:fs/promises';
import {join, dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import {cpus, tmpdir} from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {encodeChannels} from '../src/channels.mjs';
import {withProgressiveContainer, progressiveContainerPlan} from '../src/progressive-container.mjs';
import {channelOracles} from '../test/channel-oracles.mjs';
const here = dirname(fileURLToPath(import.meta.url));
const argument = (name, fallback) => process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : fallback;
const corpus = resolve(argument('--corpus', join(here, '../test/complete-corpus')));
const out = resolve(argument('--out', join(here, 'modular-progressive-results.json')));
const warmups = Number(argument('--warmups', 2)), repeats = Number(argument('--repeats', 5));
assert.ok(Number.isInteger(warmups) && warmups >= 0 && Number.isInteger(repeats) && repeats >= 1);
const hash = bytes => createHash('sha256').update(bytes).digest('hex'), execute = promisify(execFile);
const oracles = await channelOracles(); assert.ok(oracles, 'Set JXL_DJXL and JXL_OXIDE to the pinned independent decoders.');
const manifest = JSON.parse(await readFile(join(corpus, 'manifest.json'), 'utf8'));
const recipes = [
 ['default', {}],
 ['single-pass-squeeze', {squeeze: 'default', groupSize: 128}],
 ['quarter-half-full', {progressive: 'resolution', groupSize: 128}],
 ['half-full', {progressive: {passes: [2, 1]}, groupSize: 128}]
];
const sourceFiles = ['channels.mjs', 'channel-lossless.mjs', 'frame.mjs', 'modular-progressive.mjs', 'planar-squeeze.mjs', 'vardct-progressive.mjs', 'progressive-container.mjs', 'framing.mjs'];
const sourceSHA256 = Object.fromEntries(await Promise.all(sourceFiles.map(async file => [file, hash(await readFile(join(here, '../..', file)))])));
const receipt = {node: process.version, cpu: cpus()[0].model, affinity: (await readFile('/proc/self/status', 'utf8')).match(/^Cpus_allowed_list:\s*(.+)$/m)?.[1],
 capturedAt: new Date().toISOString(), corpus: 'Complete Corpus', inputs: manifest, sourceSHA256, warmups, repeats,
 protocol: 'One exclusively pinned CPU. The complete synchronous encodeChannels call is timed, including admission, transforms, grouping, headers and TOC. RGBA splitting, independent decoder proof and jxlp wrapping are outside timing. Quarter/half prefixes are detail milestones on a full-sized canvas. Default remains the existing automatic exact path; the paired single-pass Squeeze case uses the same group size and transform as progression.',
 rows: [], complete: false};
const directory = await mkdtemp(join(tmpdir(), 'jxl-modular-progressive-bench-'));
function numpy(bytes) {const start = 10 + bytes.readUInt16LE(8); assert.match(bytes.toString('utf8', 10, start), /'<f4'/); return new Float32Array(Uint8Array.from(bytes.subarray(start)).buffer);}
try {
 for (const input of manifest) {
  let raw; try {raw = await readFile(join(corpus, input.pixels));} catch {raw = gunzipSync(await readFile(join(corpus, input.pixels + '.gz')));}
  assert.equal(hash(raw), input.rgbaHash, input.id + ' pinned original RGBA');
  const planes = Array.from({length: 4}, (_, c) => Uint8Array.from({length: input.width * input.height}, (_, i) => raw[i * 4 + c]));
  const image = {width: input.width, height: input.height, color: planes.slice(0, 3), extraChannels: [{type: 'alpha', data: planes[3]}]};
  for (const [recipe, options] of recipes) {
   for (let i = 0; i < warmups; i++) encodeChannels(image, options);
   const samplesMs = []; let bytes;
   for (let i = 0; i < repeats; i++) {const start = performance.now(); bytes = encodeChannels(image, options); samplesMs.push(performance.now() - start);}
   const decoded = await oracles.decode(bytes); assert.equal(decoded.oxideError, undefined);
   for (const key of ['djxl', 'oxide']) {
    assert.equal(decoded[key].data.length, raw.length);
    for (let i = 0; i < raw.length; i++) assert.equal(Math.round(decoded[key].data[i] * 255), raw[i], input.id + '/' + recipe + '/' + key + ' source code ' + i);
   }
   const row = {id: input.id, recipe, options, bytes: bytes.length, sha256: hash(bytes), samplesMs,
    medianMs: samplesMs.slice().sort((a, b) => a - b)[Math.floor(samplesMs.length / 2)], originalRgbaCodesExactBothDecoders: true};
   if (options.progressive) {
    const layout = progressiveContainerPlan(bytes, {chunkSize: 65536}), wrapped = withProgressiveContainer(bytes, {chunkSize: 65536});
    row.jxlpBytes = wrapped.length; row.prefixes = [];
    for (const mark of layout.milestones.filter(mark => mark.kind === 'pass' && mark.downsample > 1)) {
     const path = join(directory, 'prefix.jxl'), a = join(directory, 'djxl.npy'), b = join(directory, 'oxide.npy');
     await writeFile(path, wrapped.subarray(0, mark.containerByteEnd)); await rm(a, {force: true}); await rm(b, {force: true});
     await execute(process.env.JXL_DJXL, [path, a, '--allow_partial_files', '--downsampling=' + mark.downsample, '--norender_spotcolors', '--output_extra_channels', '--quiet']);
     await execute(process.env.JXL_OXIDE, ['decode', path, '-o', b, '-f', 'npy', '-q']);
     const left = numpy(await readFile(a)), right = numpy(await readFile(b));
     assert.equal(left.length, raw.length); assert.equal(right.length, raw.length);
     let maxDifference = 0, differentFinal = 0;
     for (let i = 0; i < left.length; i++) {maxDifference = Math.max(maxDifference, Math.abs(left[i] - right[i])); if (left[i] !== decoded.djxl.data[i]) differentFinal++;}
     assert.ok(maxDifference <= 1 / 255 + 1e-6); assert.ok(differentFinal > 0); assert.ok(mark.containerByteEnd < wrapped.length);
     row.prefixes.push({pass: mark.pass, downsample: mark.downsample, rawBytes: mark.codestreamByteEnd, containerBytes: mark.containerByteEnd,
      fractionOfContainer: mark.containerByteEnd / wrapped.length, bothDecodersReturnedFullCanvas: true, differentFinalSamples: differentFinal, maxDecoderDifference: maxDifference,
      djxlSha256: hash(left), oxideSha256: hash(right), remainderWasAbsent: true});
    }
   }
   receipt.rows.push(row); console.log(input.id + '/' + recipe + ': ' + row.bytes + ' B, ' + row.medianMs.toFixed(3) + ' ms');
  }
 }
 receipt.complete = true;
} finally {
 await oracles.close(); await rm(directory, {recursive: true, force: true}); await mkdir(dirname(out), {recursive: true}); await writeFile(out, JSON.stringify(receipt, null, 2) + '\n');
}
console.log('Complete: ' + receipt.rows.length + ' independently exact complete files.');
