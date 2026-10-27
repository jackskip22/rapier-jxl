// SPDX-License-Identifier: MIT
// A common 500x500 CC0 photo shows representative costs across every pixel-codec entry.
// Wrappers/format tools without a natural pixel input are marked not applicable in the audit.
import {readFileSync, writeFileSync, mkdirSync, existsSync} from 'node:fs';
import {resolve, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {readPng, sha256} from '../image-io.mjs';

const args = process.argv.slice(2), option = (k, f) => args.includes(k) ? args[args.indexOf(k) + 1] : f;
const here = dirname(fileURLToPath(import.meta.url)), tools = resolve(option('--tools', '../bench-tools'));
const baseline = resolve(option('--baseline', '../bench-baseline')), out = resolve(option('--out', '../capture-module-probes'));
const only = new RegExp(option('--only', '.*')), input = resolve(tools, 'photo-keong-rgba.png'), jpeg = resolve(out, 'photo-keong-q90.jpg');
mkdirSync(out, {recursive: true});
const receiptPath = resolve(out, 'module-probes.json');
const report = existsSync(receiptPath) ? JSON.parse(readFileSync(receiptPath)) : {schema: 1, input: {name: 'photo-keong', width: 500, height: 500, sha256: sha256(readFileSync(input))},
  method: 'One source photo, each encoding API in a fresh Node process. Cold import+first encode; one warm repeat except expensive score search. Animations contain one 100ms frame; layers one replacement layer; patches one pixel copied onto itself; splines one zero-amplitude curve. These are footprint/mode smoke measurements, not representative animation/patch/spline compression claims.', rows: []};
const run = (exe, argv) => {const r = spawnSync(exe, argv, {encoding: 'utf8', timeout: 180000, maxBuffer: 8 * 1024 * 1024}); if (r.error || r.status) throw r.error || new Error(r.stderr); return r;};
const native = name => resolve(tools, 'libjxl12/tools', name);
const cases = [
  ['core', 100, 1], ['effort', 100, 9], ['wasm', 100, 9], ['photo', 90, 9], ['photo-advanced', 90, 7], ['photo-ans', 90, 7],
  ['photo-plan', 90, 7], ['noise', 90, 7], ['score', 85, 7], ['hybrid', 90, 7], ['graphics', 100, 1], ['icc', 100, 1],
  ['delta-palette', 100, 1], ['channels', 100, 1], ['layers', 100, 1], ['patches', 100, 1], ['splines', 90, 1],
  ['animation', 100, 1], ['animation-atlas', 100, 1], ['rapier', 90, 7], ['rapier-still', 90, 7], ['jpeg', 90, 7], ['jpeg-ans', 90, 7], ['writer', 100, 1]
];
for (const [codec, quality, effort] of cases) {
  if (!only.test(codec) || report.rows.some(r => r.codec === codec)) continue;
  const output = resolve(out, codec + '.jxl'), row = {codec, quality, effort, input: 'photo-keong', key: 'photo-keong/' + codec + '-module/main', execution: 'main'};
  try {
    if (codec.startsWith('jpeg') && !existsSync(jpeg)) run('python3', ['-c', 'from PIL import Image; import sys; Image.open(sys.argv[1]).convert("RGB").save(sys.argv[2],quality=90,subsampling=0,optimize=True)', input, jpeg]);
    const config = {codec, root: baseline, tools, quality, effort, maxError: 0, target: 85, execution: 'main', repeats: codec === 'score' ? 0 : 1, input, jpeg, output};
    Object.assign(row, JSON.parse(run(process.execPath, [resolve(here, 'encode-one.mjs'), JSON.stringify(config)]).stdout.trim().split('\n').at(-1)));
    const decoded = output + '.png'; run(native('djxl'), [output, decoded, '--bits_per_sample=8']);
    const src = readPng(readFileSync(input)), dst = readPng(readFileSync(decoded));
    let different = 0; for (let i = 0; i < src.rgba.length; i++) different += src.rgba[i] !== dst.rgba[i];
    if (quality === 100 && different) throw new Error('Lossless sample mismatch: ' + different);
    row.correctness = {decoder: 'libjxl djxl 0.12.0', differentSamples: different,
      ssimulacra2: different ? Number(run(native('ssimulacra2'), [input, decoded]).stdout.trim()) : 100};
    if (codec === 'score') {
      row.correctness.nativeStreamSsimulacra2 = Number(run(native('ssimulacra2'), [input, output]).stdout.trim());
      row.correctness.metricNote = 'ssimulacra2 uses the 8-bit decoded PNG, as in the common matrix. nativeStreamSsimulacra2 uses native float decoding of the JXL stream and avoids the extra PNG quantization step. Internal search metrics describe its reconstructed candidate.';
    }
    if (codec.startsWith('jpeg')) {
      const restored = output + '.jpg'; run(native('djxl'), [output, restored]);
      row.jpeg = {inputBytes: readFileSync(jpeg).length, inputSHA256: sha256(readFileSync(jpeg)), nativeReconstructionExact: sha256(readFileSync(jpeg)) === sha256(readFileSync(restored))};
      if (!row.jpeg.nativeReconstructionExact) throw new Error('Native JPEG byte reconstruction mismatch');
    }
    row.status = 'measured';
  } catch (error) {row.status = 'failed'; row.error = error.message.slice(-1800);}
  report.rows.push(row); writeFileSync(receiptPath, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({codec, status: row.status, bytes: row.bytes, coldMs: row.coldMs, score: row.correctness?.ssimulacra2, error: row.error}));
}
if (existsSync(jpeg) && !report.nativeJPEG) {
  report.nativeJPEG = [];
  for (const effort of [7, 9]) {
    const file = resolve(out, 'cjxl-jpeg-e' + effort + '.jxl'), decoded = file + '.jpg', start = performance.now();
    run(native('cjxl'), [jpeg, file, '-e', String(effort), '--lossless_jpeg=1', '--num_threads=1', '--quiet']);
    const ms = performance.now() - start;
    run(native('djxl'), [file, decoded]);
    report.nativeJPEG.push({effort, bytes: readFileSync(file).length, ms, jpegReconstructionExact: sha256(readFileSync(jpeg)) === sha256(readFileSync(decoded))});
  }
  writeFileSync(receiptPath, JSON.stringify(report, null, 2) + '\n');
}
