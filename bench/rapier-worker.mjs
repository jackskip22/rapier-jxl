#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Measure the complete published worker. Input loading, transport and decoder work are outside encode timing.
import assert from 'node:assert/strict';
import {Worker} from 'node:worker_threads';
import {readFileSync, writeFileSync} from 'node:fs';
import {resolve, dirname} from 'node:path';
import {createHash} from 'node:crypto';
import {cpus, release} from 'node:os';
import {gunzipSync} from 'node:zlib';
const args = Object.fromEntries(process.argv.slice(2).reduce((rows, value, i, values) => i % 2 ? rows : [...rows, [value.slice(2), values[i + 1]]], []));
assert(args.inputs && args.out, 'Use --inputs corpus.json --out results.json [--entry dist/rapier-worker.js --efforts 1,3,6,9 --warmups 1 --repeats 3]');
const file = resolve(args.entry || 'dist/rapier-worker.js'), source = readFileSync(file, 'utf8');
const manifestFile = resolve(args.inputs), manifest = JSON.parse(readFileSync(manifestFile));
assert(Array.isArray(manifest) && manifest.length && new Set(manifest.map(row => row.id)).size === manifest.length, 'Use a nonempty manifest with unique IDs.');
const efforts = (args.efforts || '1,3,6,9').split(',').map(Number), warmups = Number(args.warmups ?? 1), repeats = Number(args.repeats ?? 3);
assert(efforts.every(n => Number.isInteger(n) && n >= 1 && n <= 9));
assert(Number.isInteger(warmups) && warmups >= 0 && Number.isInteger(repeats) && repeats > 0);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const harness = `const {parentPort} = require('node:worker_threads');
let answer, transfer;
globalThis.postMessage = (value, transfers) => { answer = value; transfer = transfers; };
${source}
parentPort.on('message', async request => {
  const cpu = process.cpuUsage(), start = performance.now();
  await globalThis.onmessage({data: request});
  const ms = performance.now() - start, used = process.cpuUsage(cpu);
  parentPort.postMessage({answer, ms, cpuMs: (used.user + used.system) / 1000}, transfer);
});
parentPort.postMessage({ready:true});`;
const started = performance.now(), worker = new Worker(harness, {eval: true});
const ready = await new Promise((yes, no) => { worker.once('error', no); worker.once('message', yes); });
assert(ready.ready);
const startupMs = performance.now() - started;
const report = {complete: false, worker: {path: file, sha256: hash(source), startupMs}, runtime: process.version,
  platform: process.platform, arch: process.arch, release: release(), machine: cpus()[0]?.model,
  harnessSha256: hash(readFileSync(new URL(import.meta.url))), affinity: readFileSync('/proc/self/status', 'utf8').match(/^Cpus_allowed_list:\s*(.+)$/m)?.[1],
  manifestSha256: hash(readFileSync(manifestFile)), effort: efforts, warmups, repeats, helperWorkers: 0,
  method: 'Exact published worker in one Node worker, optional WASM automatic. Encode time includes admission, factory/job and output production; excludes transport, input loading and decoding. Worker startup is recorded separately. No helper workers; no browser or phone extrapolation.', rows: []};
let serial = 0;
const ask = request => new Promise((yes, no) => {
  const fail = error => { worker.off('message', done); no(error); };
  const done = value => { worker.off('error', fail); yes(value); };
  worker.once('error', fail); worker.once('message', done); worker.postMessage({...request, id: ++serial});
});
try {
  for (const [index, item] of manifest.entries()) {
    const raw = readFileSync(resolve(dirname(manifestFile), item.pixels)), data = new Uint8Array(item.pixels.endsWith('.gz') ? gunzipSync(raw) : raw);
    assert.equal(data.length, item.width * item.height * 4); if (item.rgbaHash) assert.equal(hash(data), item.rgbaHash);
    const row = {id: item.id, kind: item.kind, width: item.width, height: item.height, rgbaHash: hash(data), measurements: []};
    for (const effort of efforts.map((_, k) => efforts[(k + index) % efforts.length])) {
      const samples = []; let bytes, expected;
      for (let i = 0; i < warmups + repeats; i++) {
        const result = await ask({operation: 'encode', data, width: item.width, height: item.height, options: {lossless: true, effort}});
        assert.equal(result.answer.ok, true, result.answer.error?.message);
        bytes = result.answer.bytes; const sha256 = hash(bytes); expected ??= sha256; assert.equal(sha256, expected);
        if (i >= warmups) samples.push({ms: result.ms, cpuMs: result.cpuMs});
      }
      const median = key => [...samples].sort((a, b) => a[key] - b[key])[samples.length >> 1][key];
      row.measurements.push({effort, bytes: bytes.length, bpp: bytes.length * 8 / (item.width * item.height), sha256: expected, ms: median('ms'), cpuMs: median('cpuMs'), samples});
      if (args.encoded) writeFileSync(resolve(args.encoded, item.id + '-e' + effort + '.jxl'), bytes);
    }
    row.measurements.sort((a, b) => a.effort - b.effort);
    assert.equal(hash(data), row.rgbaHash); report.rows.push(row); writeFileSync(args.out, JSON.stringify(report, null, 2) + '\n');
    console.log(item.id);
  }
  report.complete = true; writeFileSync(args.out, JSON.stringify(report, null, 2) + '\n');
} finally { await worker.terminate(); }
