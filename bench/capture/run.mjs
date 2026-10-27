// SPDX-License-Identifier: MIT
// node bench/capture/run.mjs --tools ../bench-tools --baseline ../bench-baseline --out ../capture-results
import {readFileSync, writeFileSync, mkdirSync, existsSync} from 'node:fs';
import {resolve, dirname, basename} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {performance} from 'node:perf_hooks';
import os from 'node:os';
import {readPng, sha256} from '../image-io.mjs';

const here = dirname(fileURLToPath(import.meta.url)), args = process.argv.slice(2);
const arg = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
const root = resolve(here, '../..'), tools = resolve(arg('--tools', '../bench-tools')),
  baseline = resolve(arg('--baseline', '../bench-baseline')), out = resolve(arg('--out', '../capture-results'));
const fixtureDir = resolve(arg('--fixtures', here + '/fixtures')), only = new RegExp(arg('--only', '.*'));
mkdirSync(out, {recursive: true});
const manifest = JSON.parse(readFileSync(fixtureDir + '/manifest.json'));
const inputs = manifest.inputs.map(row => ({...row, path: resolve(fixtureDir, row.file)}));
if (existsSync(resolve(tools, 'photo-keong-rgba.png'))) inputs.push({name: 'photo-keong', path: resolve(tools, 'photo-keong-rgba.png'), width: 500, height: 500, photo: true});
const receiptPath = resolve(out, 'results.json');
const receipt = existsSync(receiptPath) && args.includes('--resume') ? JSON.parse(readFileSync(receiptPath)) : {
  schema: 1, date: new Date().toISOString(), baseline: '3d36f51c36843a7d2965af2f525504047aa2f8a3',
  machine: {label: 'Hosted Linux x86_64; not a mid-range laptop or phone', platform: os.platform(), release: os.release(), cpu: os.cpus()[0].model, logicalCpus: os.cpus().length,
    node: process.version, memoryBytes: os.totalmem(), cpuQuota: readFileSync('/sys/fs/cgroup/cpu.max', 'utf8').trim()},
  method: {quality: 'Lossless compares every decoded RGBA byte, including RGB under zero alpha. Lossy rows are measured with native SSIMULACRA2; matching is a separate sweep, never equal quality-slider values.',
    native: 'CLI process wall time includes process start, input PNG decode and output write. Each repetition starts a fresh process; these are repeated-process times, not warm in-process encode times.',
    peakMemory: 'Node uses process.resourceUsage().maxRSS. Native CLI uses resource.getrusage(RUSAGE_CHILDREN) in a fresh Python parent. All include process/runtime/input. Browser memory unavailable is null, never zero.',
    gpu: 'Node tests are CPU-only. No claim about hardware WebGPU or phone/laptop targets.'}, inputs: [], rows: []};
const save = () => writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + '\n');
const tool = name => resolve(tools, 'libjxl12/tools', name);
const checked = (command, argv, options = {}) => {
  const r = spawnSync(command, argv, {encoding: 'utf8', timeout: Number(arg('--timeout', '180000')), maxBuffer: 8 * 1024 * 1024, ...options});
  if (r.error || r.status !== 0) throw new Error(command + ': ' + (r.error?.message || r.stderr || r.stdout).slice(-1800));
  return r;
};
function native(command, argv, repeats = 3) {
  const times = [], peaks = [];
  for (let i = 0; i <= repeats; i++) {
    const r = JSON.parse(checked('python3', [resolve(here, 'native-one.py'), command, ...argv]).stdout);
    if (r.status) throw new Error(r.stderr.slice(-1800));
    times.push(r.ms); peaks.push(r.peakRSSKiB);
  }
  return {coldMs: times[0], firstEncodeMs: times[0], warmMs: times.slice(1), memory: {peakRSSKiB: Math.max(...peaks)},
    timing: 'CLI process wall time including startup, decode and write; warmMs are repeated fresh CLI runs (OS file cache warm).', command: [command, ...argv]};
}
function correctness(input, output, format, expectedError) {
  let decodedPath = output + '.png';
  if (format === 'jxl') checked(tool('djxl'), [output, decodedPath, '--bits_per_sample=8']);
  else if (format === 'webp') checked(resolve(tools, 'webp/bin/dwebp'), [output, '-o', decodedPath]);
  else decodedPath = output;
  const a = readPng(readFileSync(input.path)), b = readPng(readFileSync(decodedPath));
  if (a.width !== b.width || a.height !== b.height) throw new Error('Decoded dimensions differ');
  let different = 0, maxRgbError = 0, alphaDifferences = 0, hiddenRgbDifferences = 0;
  for (let i = 0; i < a.rgba.length; i++) if (a.rgba[i] !== b.rgba[i]) {
    different++;
    if ((i & 3) === 3) alphaDifferences++;
    else { maxRgbError = Math.max(maxRgbError, Math.abs(a.rgba[i] - b.rgba[i])); if (a.rgba[(i & ~3) + 3] === 0) hiddenRgbDifferences++; }
  }
  if (expectedError === 0 && different) throw new Error('Lossless RGBA mismatch: ' + different);
  if (Number.isFinite(expectedError) && (maxRgbError > expectedError || alphaDifferences || hiddenRgbDifferences))
    throw new Error('Bounded RGB error / alpha / hidden RGB contract violated');
  const score = different ? Number(checked(tool('ssimulacra2'), [input.path, decodedPath]).stdout.trim()) : 100;
  return {decoder: format === 'jxl' ? 'libjxl djxl 0.12.0' : format === 'webp' ? 'dwebp 1.5.0' : 'PNG sample reader', differentSamples: different,
    maxRgbError, alphaDifferences, hiddenRgbDifferences, ssimulacra2: score, decodedRGBAHash: sha256(b.rgba)};
}

for (const input of inputs) {
  if (!receipt.inputs.some(i => i.name === input.name)) receipt.inputs.push({name: input.name, width: input.width, height: input.height,
    pngSHA256: sha256(readFileSync(input.path)), rgbaSHA256: sha256(readPng(readFileSync(input.path)).rgba), photo: !!input.photo});
  const cases = input.photo ? [
    {label: 'core-q90', codec: 'core', quality: 90, root: baseline},
    {label: 'photo-e7-q90', codec: 'photo', quality: 90, effort: 7, root: baseline},
    {label: 'photo-e9-q90', codec: 'photo', quality: 90, effort: 9, root: baseline},
    {label: 'jsquash-e7-q90', codec: 'jsquash', quality: 90, effort: 7},
    {label: 'vips-e7-q90', codec: 'vips', quality: 90, effort: 7},
    {label: 'cjxl-e7-q90', native: 'cjxl', quality: 90, effort: 7},
    {label: 'cjxl-e9-q90', native: 'cjxl', quality: 90, effort: 9},
    {label: 'cjxl-e7-lossless', native: 'cjxl', quality: 100, effort: 7},
    {label: 'cjxl-e9-lossless', native: 'cjxl', quality: 100, effort: 9},
  ] : [
    {label: 'core-lossless', codec: 'core', root: baseline},
    {label: 'effort3-lossless', codec: 'effort', effort: 3, root: baseline},
    {label: 'effort9-lossless', codec: 'effort', effort: 9, root: baseline, repeats: 1},
    {label: 'wasm3-lossless', codec: 'wasm', effort: 3, root: baseline},
    {label: 'capture-lossless', codec: 'capture', root},
    {label: 'capture-error2', codec: 'capture', maxError: 2, root},
    {label: 'jsquash-e7-lossless', codec: 'jsquash', effort: 7},
    {label: 'vips-e3-lossless', codec: 'vips', effort: 3},
    {label: 'vips-e7-lossless', codec: 'vips', effort: 7},
    {label: 'cjxl-e7-lossless', native: 'cjxl', effort: 7},
    {label: 'cjxl-e9-lossless', native: 'cjxl', effort: 9},
    {label: 'webp-lossless', native: 'webp', quality: 100},
    {label: 'webp-q90', native: 'webp', quality: 90},
    {label: 'png-oxipng4', native: 'png'},
  ];
  for (const c of cases) for (const execution of c.native ? ['cli'] : c.codec === 'capture' || c.codec === 'jsquash' || c.codec === 'vips' ? ['main', 'worker'] : ['main']) {
    const key = input.name + '/' + c.label + '/' + execution;
    if (!only.test(key) || receipt.rows.some(r => r.key === key)) continue;
    const quality = c.quality ?? 100, error = c.codec === 'capture' ? c.maxError || 0 : quality === 100 ? 0 : null;
    const format = c.native === 'webp' ? 'webp' : c.native === 'png' ? 'png' : 'jxl';
    const output = resolve(out, key.replaceAll('/', '--') + '.' + format);
    const row = {key, input: input.name, codec: c.label, execution, quality, effort: c.effort ?? null, maxError: c.maxError ?? null,
      width: input.width, height: input.height, gpu: false};
    try {
      if (c.native) {
        const repeats = Number(arg('--repeats', String(c.repeats ?? 3)));
        if (c.native === 'cjxl') Object.assign(row, {version: '0.12.0'}, native(tool('cjxl'), [input.path, output, '-q', String(quality), '-e', String(c.effort), '--num_threads=1', '--lossless_jpeg=0', '--quiet'], repeats));
        if (c.native === 'webp') Object.assign(row, native(resolve(tools, 'webp/bin/cwebp'), [input.path, '-o', output, ...(quality === 100 ? ['-lossless', '-exact', '-z', '6'] : ['-q', String(quality), '-m', '4']), '-quiet'], repeats));
        if (c.native === 'png') Object.assign(row, native(resolve(tools, 'oxipng/oxipng'), ['-o', '4', '--strip', 'safe', '--out', output, '--force', input.path], repeats));
        const bytes = readFileSync(output); Object.assign(row, {bytes: bytes.length, sha256: sha256(bytes)});
      } else {
        const repeatLimit = c.codec === 'vips' && c.effort === 7 && input.width * input.height > 8000000 ? 1 : c.repeats ?? 3;
        const config = {codec: c.codec, root: c.root || root, tools, quality, effort: c.effort ?? 7, maxError: c.maxError ?? 0, execution,
          repeats: Number(arg('--repeats', String(repeatLimit))), input: input.path, output};
        if (repeatLimit === 1 && c.codec === 'vips') row.repeatNote = 'One warm repeat; a separate diagnostic found the third effort-7 4K encode fails in wasm-vips0.0.19 even with Cache.max(0).';
        const result = checked(process.execPath, [resolve(here, 'encode-one.mjs'), JSON.stringify(config)]);
        Object.assign(row, JSON.parse(result.stdout.trim().split('\n').at(-1)), {key, codec: c.label});
      }
      row.correctness = correctness(input, output, format, error);
      row.status = 'measured';
    } catch (e) { row.status = 'failed'; row.error = e.message; }
    receipt.rows.push(row); save();
    console.log(JSON.stringify({key, status: row.status, bytes: row.bytes, coldMs: row.coldMs, warmMs: row.warmMs, ssimulacra2: row.correctness?.ssimulacra2, error: row.error}));
  }
}
save();
