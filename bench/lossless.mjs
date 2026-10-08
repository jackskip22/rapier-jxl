#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Run one process per encoder on an otherwise idle machine. Input reads, hashes and JSON writes are not timed.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync, writeFileSync} from 'node:fs';
import {cpus, release, totalmem} from 'node:os';
import {dirname, resolve, relative} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {gunzipSync} from 'node:zlib';

const usage = `Usage: node bench/lossless.mjs --inputs corpus.json --out results.json
  --entry ./dist/effort.min.mjs   Encoder module path; default: readable effort module
  --efforts 1,3,6,9              Effort levels
  --warmups 2                   Untimed calls per image and effort
  --repeats 5                   Measured calls per image and effort

corpus.json is an array of {id, pixels, width, height, rgbaHash?}.
pixels names a raw RGBA8 file, optionally gzip-compressed (.gz), relative to the manifest.
rgbaHash is the optional SHA-256 of the uncompressed RGBA8 bytes.
Run this script from an installed package or staged repository. --entry selects another module.
Output checks cover input mutation and determinism; decode streams separately to verify losslessness.`;
if (process.argv.includes('--help')) { console.log(usage); process.exit(0); }
const args = Object.create(null), names = new Set(['inputs', 'out', 'entry', 'efforts', 'warmups', 'repeats']);
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i].slice(2), value = process.argv[i + 1];
  assert(process.argv[i].startsWith('--') && names.has(key) && value && !value.startsWith('--'), usage);
  assert(!(key in args), 'Duplicate option: ' + key);
  args[key] = value;
}
assert(args.inputs && args.out, usage);
const integer = (value, minimum, maximum = Number.MAX_SAFE_INTEGER) => {
  const n = Number(value);
  assert(Number.isSafeInteger(n) && n >= minimum && n <= maximum, 'Invalid integer: ' + value);
  return n;
};
const efforts = (args.efforts ?? '1,3,6,9').split(',').map(value => integer(value, 1, 9));
assert.equal(new Set(efforts).size, efforts.length, 'Effort levels must be unique');
const warmups = integer(args.warmups ?? 2, 0), repeats = integer(args.repeats ?? 5, 1);
const entry = args.entry ? pathToFileURL(resolve(args.entry)) : new URL('../src/effort.mjs', import.meta.url);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const sourceHashes = {}, entryDir = dirname(fileURLToPath(entry));
const visit = url => {
  const path = fileURLToPath(url), key = relative(entryDir, path);
  if (key in sourceHashes) return;
  const bytes = readFileSync(path); sourceHashes[key] = hash(bytes);
  for (const match of bytes.toString().matchAll(/\b(?:from\s*|import\s*)['"](\.[^'"]+)['"]/g)) visit(new URL(match[1], url));
};
visit(entry);
const api = await import(entry);
assert.equal(typeof api.encode, 'function', 'The entry point must export encode');
const manifestFile = resolve(args.inputs), manifestBytes = readFileSync(manifestFile), manifest = JSON.parse(manifestBytes);
assert(Array.isArray(manifest) && manifest.length, 'The manifest must be a nonempty array');
assert(manifest.every(item => typeof item.id === 'string' && item.id.length), 'Each input needs an ID');
assert.equal(new Set(manifest.map(item => item.id)).size, manifest.length, 'Input IDs must be unique');
const report = {
  complete: false, started: new Date().toISOString(), entry: fileURLToPath(entry), sourceHashes,
  harnessSha256: hash(readFileSync(new URL(import.meta.url))), manifestSha256: hash(manifestBytes),
  runtime: process.version, versions: process.versions, platform: process.platform, release: release(), arch: process.arch,
  machine: cpus()[0]?.model, logicalCPUs: cpus().length, totalMemoryBytes: totalmem(),
  kernelMode: api.kernelMode?.() ?? 'off', efforts, warmups, repeats, workers: 0,
  method: 'Synchronous quality-100 calls. Input loading, hashing and report writes are outside timing. CPU is aggregate process CPU, including runtime background work. Rows contain raw measured samples and medians. Warmups run before each image/effort combination.',
  rows: []
};
const save = () => writeFileSync(args.out, JSON.stringify(report, null, 2) + '\n');
const median = values => { values.sort((a, b) => a - b); const m = values.length >> 1; return values.length % 2 ? values[m] : (values[m - 1] + values[m]) / 2; };
save();
for (const item of manifest) {
  const width = integer(item.width, 1), height = integer(item.height, 1);
  assert(Number.isSafeInteger(width * height * 4), 'Invalid image size: ' + item.id);
  const file = readFileSync(resolve(dirname(manifestFile), item.pixels));
  const data = new Uint8Array(item.pixels.endsWith('.gz') ? gunzipSync(file) : file), rgbaHash = hash(data);
  assert.equal(data.length, width * height * 4, 'Expected raw RGBA8: ' + item.id);
  if (item.rgbaHash !== undefined) assert.equal(rgbaHash, item.rgbaHash, 'Input hash mismatch: ' + item.id);
  for (const effort of efforts) {
    let reference;
    const samples = [];
    for (let round = -warmups; round < repeats; round++) {
      const cpu = process.cpuUsage(), start = performance.now();
      const output = api.encode(data, width, height, {quality: 100, effort});
      const ms = performance.now() - start, used = process.cpuUsage(cpu);
      assert(output instanceof Uint8Array, 'encode must return a Uint8Array');
      const sha256 = hash(output);
      reference ??= {bytes: output.length, sha256};
      assert.equal(sha256, reference.sha256, `Nondeterministic output: ${item.id}, effort ${effort}`);
      assert.equal(hash(data), rgbaHash, 'Encoder mutated input: ' + item.id);
      if (round >= 0) samples.push({ms, cpuMs: (used.user + used.system) / 1000, userMs: used.user / 1000, systemMs: used.system / 1000});
    }
    report.rows.push({id: item.id, width, height, rgbaHash, effort, ...reference,
      ms: median(samples.map(s => s.ms)), cpuMs: median(samples.map(s => s.cpuMs)), samples});
    save();
    console.error(`${item.id} effort ${effort}: ${reference.bytes} bytes`);
  }
}
report.complete = true; report.finished = new Date().toISOString(); save();
